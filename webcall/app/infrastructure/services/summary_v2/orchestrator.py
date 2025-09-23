from __future__ import annotations
from typing import Dict, Tuple, List
import time, contextlib
from .message_log import MessageLog
from .models import SummaryResult, ChatMessage, TECHNICAL_PATTERNS
from .strategies import ChatStrategy, CombinedVoiceChatStrategy
from .user_agent import UserAgentSession
from ...config import get_settings
from ..ai_provider import get_user_system_prompt
from ..voice_transcript import get_voice_collector
import logging

logger = logging.getLogger(__name__)


class SummaryOrchestrator:
    """Оркестратор новой архитектуры персональных агентов.

    КЛЮЧЕВЫЕ ИЗМЕНЕНИЯ:
    1. Для каждого (room_id, user_id) создаётся независимая `UserAgentSession`.
    2. В сессии хранится собственный список сообщений и голосовая транскрипция.
    3. Добавление сообщений в общий лог продолжается (для будущих сценариев), но построение персонального summary
       опирается только на сообщения внутри конкретной сессии, что предотвращает утечку данных между пользователями.
    4. Завершение одной сессии (stop) не влияет на продолжающиеся сессии других пользователей.
    5. Pending voice wait: при запросе summary, если окно пустое и возможно идёт финализация ASR, выполняется короткое
       ожидание появления транскрипта (poll voice collector) чтобы уменьшить число "пустых" ответов.
    """
    def __init__(self) -> None:
        self._log = MessageLog()
        # активные/завершенные (до очистки) сессии: (room_id,user_id) -> UserAgentSession
        self._sessions: Dict[Tuple[str, str], UserAgentSession] = {}
        # Быстрый индекс по комнате для доставки новых сообщений в активные сессии
        self._room_sessions: Dict[str, List[UserAgentSession]] = {}
        # Стратегии (для fallback путей — вероятно не нужны, но оставим)
        self._chat_strategy = ChatStrategy()
        self._combined_strategy = CombinedVoiceChatStrategy()
        # Unified counters (in-memory) — не критично к перезапуску
        self._counters: Dict[str, int] = {
            'voice_add_total': 0,
            'voice_reject_stale': 0,
            'voice_reject_no_meta': 0,
            'voice_fallback_attached': 0,
            'voice_fallback_stale': 0,
            'voice_lazy_attached': 0,
            'voice_lazy_skipped_placeholder': 0,
            'voice_pending_attached': 0,
            'voice_second_chance_attached': 0,
            'session_auto_created_on_voice': 0,
            'session_recovered_from_voice': 0,
            'session_auto_resumed': 0,
        }

    # Публичное read-only получение счётчиков (для диагностики / последующей экспозиции)
    def get_counters(self) -> Dict[str, int]:
        return dict(self._counters)

    def _bump(self, key: str) -> None:
        try:
            self._counters[key] = self._counters.get(key, 0) + 1
        except Exception:
            pass

    def add_chat(self, room_id: str, author_id: str | None, author_name: str | None, content: str) -> None:
        """Регистрация нового чат сообщения.

        1. Кладём в общий MessageLog (исторический хвост по комнате).
        2. Рассылаем во все активные сессии данной комнаты чтобы они зафиксировали сообщение (если попадает в окно).
        """
        msg = self._log.add(room_id, author_id, author_name, content)
        # Доставка в активные сессии комнаты
        sessions = self._room_sessions.get(room_id)
        if sessions:
            for sess in sessions:
                # активная если не stop или msg.ts <= end
                sess.add_chat(msg)

    def add_voice_transcript(self, room_id: str, transcript: str, user_id: str | None = None) -> None:
        """Сохраняет голосовую транскрипцию в персональную сессию пользователя.

        Если сессия ещё не создана (агент стартовал после транскрипта) — создаём её со start_ts=сейчас
        чтобы пользователь всё равно получил свою расшифровку.
        """
        if not transcript or not user_id:
            return
        transcript = transcript.strip()
        if not transcript:
            return
        key = (room_id, user_id)
        sess = self._sessions.get(key)
        if not sess or (sess and sess.end_ts is not None):
            # Нет активной сессии или предыдущая завершена — создаём новую для новой записи
            if sess and sess.end_ts is not None:
                with contextlib.suppress(ValueError):
                    self._room_sessions.get(room_id, []).remove(sess)
            sess = UserAgentSession(room_id=room_id, user_id=user_id)
            self._sessions[key] = sess
            self._room_sessions.setdefault(room_id, []).append(sess)
            logger.debug("summary_v2: auto-created session on voice transcript room=%s user=%s", room_id, user_id)
            self._bump('session_auto_created_on_voice')
        technical = False
        low = transcript.lower()
        if low.startswith('(no audio') or low.startswith('(asr failed') or low.startswith('(asr exception') or low.startswith('(asr disabled'):
            technical = True
        # Парсинг мета-префикса (если мы его добавили в voice_capture)
        meta_capture_ts = None
        has_meta = False
        try:
            if transcript.startswith('[meta '):
                end = transcript.find(']')
                if end != -1:
                    meta_block = transcript[6:end].strip()
                    body = transcript[end+1:].lstrip()
                    parts = meta_block.split()
                    for p in parts:
                        if p.startswith('captureTs='):
                            try:
                                meta_capture_ts = int(p.split('=',1)[1])
                            except Exception:
                                pass
                    has_meta = True
                    # Проверка на устаревание относительно старта текущей сессии
                    if meta_capture_ts is not None and meta_capture_ts < (sess.start_ts - 150):
                        logger.debug("summary_v2: ignore stale voice transcript by captureTs room=%s user=%s captureTs=%s start_ts=%s", room_id, user_id, meta_capture_ts, sess.start_ts)
                        self._bump('voice_reject_stale')
                        return
                    transcript = body
        except Exception:
            pass
        # Если меты нет – применяем строгий фильтр: окно <=10s от старта и отсутствие предыдущих voice сегментов
        if not has_meta:
            now_ms = int(time.time()*1000)
            voice_already = bool(getattr(sess, '_voice_segments', None))  # type: ignore[attr-defined]
            age = now_ms - sess.start_ts
            if age > 10_000 or voice_already:
                logger.debug("summary_v2: reject voice(no-meta) room=%s user=%s age_ms=%s has_voice=%s", room_id, user_id, age, voice_already)
                self._bump('voice_reject_no_meta')
                return
        sess.add_voice_transcript(transcript)
        self._bump('voice_add_total')
        logger.info(
            "summary_v2: add_voice_transcript room=%s user=%s chars=%s technical=%s meta=%s captureTs=%s head=%r",
            room_id, user_id, len(transcript), technical, has_meta, meta_capture_ts, transcript[:60]
        )

    async def start_user_window(self, room_id: str, user_id: str) -> None:
        """Старт (или перезапуск) персонального окна пользователя."""
        key = (room_id, user_id)
        # перезапуск должен сбросить старую сессию
        old = self._sessions.get(key)
        preserved_voice: list[str] | None = None
        if old:
            try:
                # Если в старой сессии уже есть voice сегменты и нет чат сообщений – НЕ теряем их
                if getattr(old, '_voice_segments', None) and not getattr(old, '_messages', None):  # type: ignore[attr-defined]
                    preserved_voice = []
                    import re as _re
                    for _seg in list(getattr(old, '_voice_segments')):  # type: ignore[attr-defined]
                        # На всякий случай удалим meta, если вдруг просочилась
                        cleaned = _re.sub(r'^\[meta [^]]*\]\s*', '', _seg.strip()) if isinstance(_seg, str) else _seg
                        preserved_voice.append(cleaned)
            except Exception:
                preserved_voice = None
            # мягко помечаем остановку старой
            old.stop()
            with contextlib.suppress(ValueError):
                self._room_sessions.get(room_id, []).remove(old)
        sess = UserAgentSession(room_id=room_id, user_id=user_id)
        # Восстановим voice если оно было и мы иначе бы его потеряли
        if preserved_voice:
            for vseg in preserved_voice:
                try:
                    sess.add_voice_transcript(vseg)
                except Exception:
                    pass
            logger.debug("summary_v2: restored voice segments on restart room=%s user=%s count=%s", room_id, user_id, len(preserved_voice))
        self._sessions[key] = sess
        self._room_sessions.setdefault(room_id, []).append(sess)
        # Не удаляем транскрипт из коллектора при рестарте: если запись ещё финализируется, она прикрепится лениво.
        logger.debug("summary_v2: started new user window room=%s user=%s start_ts=%s", room_id, user_id, sess.start_ts)

    def end_user_window(self, room_id: str, user_id: str) -> None:
        key = (room_id, user_id)
        sess = self._sessions.get(key)
        if sess:
            sess.stop()

    async def build_personal_summary(self, *, room_id: str, user_id: str, ai_provider, db_session, cutoff_ms: int | None = None) -> SummaryResult:
        """Формирует персональное summary для пользователя в комнате.

        Если сессия отсутствует — возвращает пустой результат (пользователь ещё не запустил агента).
        cutoff_ms сейчас не используется напрямую (сессия уже ограничена end_ts), но параметр
        оставлен для обратной совместимости вызовов.
        """
        key = (room_id, user_id)
        sess = self._sessions.get(key)
        if not sess:
            # Попытка аварийного восстановления: только если voice свежий (после предполагаемого старта — у нас его нет, поэтому принимаем любой, но фильтруем плейсхолдеры)
            try:
                vc = get_voice_collector()
                voice_key = f"{room_id}:{user_id}"
                with contextlib.suppress(Exception):
                    vt = await vc.get_transcript(voice_key)
                    if vt and getattr(vt, 'text', None):
                        txt = vt.text.strip()
                        low = txt.lower()
                        if txt and not low.startswith('(no audio chunks') and not low.startswith('(asr failed') and not low.startswith('(asr exception') and not low.startswith('(asr disabled'):
                            sess = UserAgentSession(room_id=room_id, user_id=user_id)
                            sess.add_voice_transcript(txt)
                            self._sessions[key] = sess
                            self._room_sessions.setdefault(room_id, []).append(sess)
                            logger.warning("summary_v2: recovered session from voice transcript room=%s user=%s len=%s", room_id, user_id, len(txt))
                            self._bump('session_recovered_from_voice')
            except Exception:
                pass
            if not sess:
                logger.info("summary_v2: build_personal_summary empty (no session) room=%s user=%s", room_id, user_id)
                return SummaryResult.empty(room_id)
        # Диагностика текущего состояния сессии ДО ленивого voice attach
        try:
            voice_segments = getattr(sess, '_voice_segments', [])  # type: ignore[attr-defined]
            logger.debug(
                "summary_v2: pre-build state room=%s user=%s msgs=%s voice_segments=%s ended=%s", room_id, user_id, len(getattr(sess, '_messages', [])), len(voice_segments), getattr(sess, 'end_ts', None)
            )
        except Exception:
            pass

        # ФОЛБЭК: если окно абсолютно пустое (ни сообщений, ни voice), пробуем единожды подтянуть персональный записанный транскрипт из коллектора.
        try:
            msgs_now = getattr(sess, '_messages', [])
            voice_now = getattr(sess, '_voice_segments', [])  # type: ignore[attr-defined]
            if not msgs_now and not voice_now:
                vc_fb = get_voice_collector()
                vt_fb = await vc_fb.get_transcript(f"{room_id}:{user_id}")
                if vt_fb and getattr(vt_fb, 'text', None):
                    raw_fb = vt_fb.text.strip()
                    if raw_fb and not raw_fb.lower().startswith('(no audio'):
                        # Парсим мету чтобы достать captureTs (может отсутствовать — тогда считаем свежим)
                        capture_ts_fb = None
                        if raw_fb.startswith('[meta ') and 'captureTs=' in raw_fb:
                            end_br = raw_fb.find(']')
                            if end_br != -1:
                                meta_block = raw_fb[6:end_br].strip()
                                for part in meta_block.split():
                                    if part.startswith('captureTs='):
                                        with contextlib.suppress(Exception):
                                            capture_ts_fb = int(part.split('=',1)[1])
                        fresh_ok = True
                        if capture_ts_fb is not None and capture_ts_fb < (sess.start_ts - 150):
                            fresh_ok = False
                        if fresh_ok:
                            # Удаляем мета префикс при добавлении во внутренние сегменты, оставляем чистый текст
                            if raw_fb.startswith('[meta ') and ']' in raw_fb:
                                body_pos = raw_fb.find(']')
                                if body_pos != -1:
                                    raw_clean = raw_fb[body_pos+1:].lstrip()
                                else:
                                    raw_clean = raw_fb
                            else:
                                raw_clean = raw_fb
                            sess.add_voice_transcript(raw_clean)
                            logger.info("summary_v2: fallback attached stored transcript room=%s user=%s len=%s captureTs=%s start_ts=%s", room_id, user_id, len(raw_clean), capture_ts_fb, sess.start_ts)
                            self._bump('voice_fallback_attached')
                            # Попробуем удалить чтобы не переиспользовать
                            with contextlib.suppress(Exception):
                                await vc_fb.pop_transcript(f"{room_id}:{user_id}")
                        else:
                            logger.debug("summary_v2: fallback transcript stale room=%s user=%s captureTs=%s start_ts=%s", room_id, user_id, capture_ts_fb, sess.start_ts)
                            self._bump('voice_fallback_stale')
        except Exception:
            pass

        # Авто-восстановление: если сессия завершена, но после end_ts появились новые чат сообщения или свежая voice транскрипция — создаём новую сессию.
        if sess.end_ts is not None:
            try:
                # Проверим новые чат сообщения после end_ts
                new_chat = False
                tail = self._log.slice_since(room_id, sess.end_ts + 1)
                if tail:
                    new_chat = True
                # Проверим новую voice (generated_at > end_ts)
                fresh_voice = False
                with contextlib.suppress(Exception):
                    vc = get_voice_collector()
                    vt2 = await vc.get_transcript(f"{room_id}:{user_id}")
                    if vt2 and vt2.generated_at > sess.end_ts:
                        txt2 = (vt2.text or '').strip()
                        if txt2 and not txt2.lower().startswith('(no audio'):
                            fresh_voice = True
                if new_chat or fresh_voice:
                    # Создаём новую сессию с началом = макс(end_ts+1, first_new_ts)
                    with contextlib.suppress(ValueError):
                        self._room_sessions.get(room_id, []).remove(sess)
                    new_sess = UserAgentSession(room_id=room_id, user_id=user_id)
                    # Если есть новое чат сообщение — подгоним start_ts чтобы исключить старые
                    if tail:
                        first_ts = tail[0].ts
                        new_sess.start_ts = min(first_ts, int(time.time()*1000))
                    self._sessions[key] = new_sess
                    self._room_sessions.setdefault(room_id, []).append(new_sess)
                    sess = new_sess
                    # Доставим новые чат сообщения в новую сессию
                    for m in tail:
                        sess.add_chat(m)
                    if fresh_voice:
                        with contextlib.suppress(Exception):
                            if vt2 and vt2.text:
                                sess.add_voice_transcript(vt2.text.strip())
                            logger.info("summary_v2: auto-resumed session room=%s user=%s new_chat=%s fresh_voice=%s", room_id, user_id, new_chat, fresh_voice)
                            self._bump('session_auto_resumed')
            except Exception:
                pass
        # Если в сессии нет voice, попробуем подтянуть (лениво) готовую транскрипцию, чтобы не было окна, когда агент стартовал чуть позже окончания речи
        # Ленивая подгрузка: если пока нет ни одного voice сегмента, попробуем взять существующий транскрипт.
        if not getattr(sess, '_voice_segments', None):  # type: ignore[attr-defined]
            try:
                vc = get_voice_collector()
                voice_key = f"{room_id}:{user_id}"
                with contextlib.suppress(Exception):
                    vt = await vc.get_transcript(voice_key)
                    if vt and getattr(vt, 'text', None):
                        txt = vt.text.strip()
                        low = txt.lower()
                        # Фильтрация: текст нетехнический и сгенерирован не раньше старта (разрешаем небольшой дрейф -100мс)
                        if txt and not (low.startswith('(no audio chunks') or low.startswith('(asr failed') or low.startswith('(asr exception') or low.startswith('(asr disabled')) and vt.generated_at >= (sess.start_ts - 100):
                            sess.add_voice_transcript(txt)
                            logger.info("summary_v2: lazy attach voice transcript room=%s user=%s len=%s gen_at=%s start_ts=%s", room_id, user_id, len(txt), vt.generated_at, sess.start_ts)
                            self._bump('voice_lazy_attached')
                        else:
                            logger.debug("summary_v2: skip voice transcript placeholder/technical room=%s user=%s raw=%r", room_id, user_id, txt[:80] if txt else txt)
                            self._bump('voice_lazy_skipped_placeholder')
            except Exception:
                pass
        # Получаем персональный system prompt
        system_prompt: str | None = None
        if db_session is not None:
            with contextlib.suppress(Exception):
                system_prompt = await get_user_system_prompt(db_session, user_id)
        result = await sess.build_summary(ai_provider=ai_provider, system_prompt=system_prompt)
        # Диагностика: если результат пуст, но в сессии есть voice сегменты — логируем их длину
        try:
            if result.message_count == 0:
                vseg = getattr(sess, '_voice_segments', [])  # type: ignore[attr-defined]
                if vseg:
                    lens = [len(x) for x in vseg]
                    logger.warning("summary_v2: empty result but voice_segments present room=%s user=%s segments=%s lens=%s", room_id, user_id, len(vseg), lens)
        except Exception:
            pass
        # Pending ожидание голоса: если окно пустое, нет voice сегментов и нет сообщений — подождём немного появление транскрипта
        if result.message_count == 0 and not getattr(result, 'used_voice', False):
            try:
                voice_segments_now = getattr(sess, '_voice_segments', [])  # type: ignore[attr-defined]
                msgs_now = getattr(sess, '_messages', [])
                if not voice_segments_now and not msgs_now:
                    wait_total = 0
                    MAX_WAIT_MS = 2500
                    STEP_MS = 350
                    while wait_total < MAX_WAIT_MS:
                        import asyncio
                        await asyncio.sleep(STEP_MS / 1000)
                        wait_total += STEP_MS
                        # Проверяем появился ли транскрипт
                        with contextlib.suppress(Exception):
                            vc = get_voice_collector()
                            vt_wait = await vc.get_transcript(f"{room_id}:{user_id}")
                            if vt_wait and getattr(vt_wait, 'text', None):
                                txtw = vt_wait.text.strip()
                                loww = txtw.lower()
                                if txtw and not (loww.startswith('(no audio') or loww.startswith('(asr failed') or loww.startswith('(asr exception') or loww.startswith('(asr disabled')):
                                    sess.add_voice_transcript(txtw)
                                    logger.info("summary_v2: pending wait attached voice room=%s user=%s len=%s waited_ms=%s", room_id, user_id, len(txtw), wait_total)
                                    self._bump('voice_pending_attached')
                                    result = await sess.build_summary(ai_provider=ai_provider, system_prompt=system_prompt)
                                    break
                    else:
                        logger.debug("summary_v2: pending wait timeout room=%s user=%s waited_ms=%s", room_id, user_id, wait_total)
            except Exception:
                pass
        # Если пусто, но теперь (во время генерации) появился voice транскрипт — пробуем ещё раз один раз.
        if result.message_count == 0 and not getattr(result, 'used_voice', False):
            try:
                if not getattr(sess, '_voice_segments', None):  # всё ещё нет
                    vc = get_voice_collector()
                    vt_retry = await vc.get_transcript(f"{room_id}:{user_id}")
                    if vt_retry and getattr(vt_retry, 'text', None):
                        txt2 = vt_retry.text.strip()
                        low2 = txt2.lower()
                        if txt2 and not (low2.startswith('(no audio') or low2.startswith('(asr failed') or low2.startswith('(asr exception') or low2.startswith('(asr disabled')) and vt_retry.generated_at >= (sess.start_ts - 100):
                            sess.add_voice_transcript(txt2)
                            logger.info("summary_v2: second-chance attach voice transcript room=%s user=%s len=%s", room_id, user_id, len(txt2))
                            self._bump('voice_second_chance_attached')
                            result = await sess.build_summary(ai_provider=ai_provider, system_prompt=system_prompt)
            except Exception:
                pass
        try:
            logger.debug(
                "summary_v2: post-build result room=%s user=%s msg_count=%s used_voice=%s", room_id, user_id, result.message_count, getattr(result, 'used_voice', False)
            )
        except Exception:
            pass
        # Fallback: если всё равно пусто, но есть voice сегменты — синтезируем минимальное summary без AI
        if result.message_count == 0 and not getattr(result, 'used_voice', False):
            try:
                vseg2 = getattr(sess, '_voice_segments', [])  # type: ignore[attr-defined]
                meaningful = [s for s in vseg2 if s and len(s.strip()) > 10]
                if meaningful:
                    logger.debug("summary_v2: entering voice fallback path room=%s user=%s segments=%s ai_provider=%s", room_id, user_id, len(meaningful), bool(ai_provider))
                    import re as _re
                    # Удаляем meta префиксы из сегментов (если есть)
                    meaningful = [_re.sub(r'^\[meta [^]]*\]\s*', '', s.strip()) for s in meaningful]
                    # Если вдруг после чистки остались пустые — отфильтровать
                    meaningful = [s for s in meaningful if s]
                    import re, time as _t
                    merged_voice = " ".join(meaningful)
                    norm = re.sub(r"\s+", " ", merged_voice.strip())
                    parts = re.split(r'(?<=[.!?])\s+', norm)
                    parts = [p.strip() for p in parts if p.strip()]
                    head_parts = parts[:5] if parts else [norm]
                    # Формируем псевдо‑сообщения для попытки AI суммаризации
                    now_ms = int(_t.time()*1000)
                    from .models import ChatMessage, SummaryResult as _SR
                    pseudo = [ChatMessage(room_id=room_id, author_id=None, author_name='voice', content=p, ts=now_ms) for p in head_parts]
                    # Прямая попытка AI генерации (без стратегии) чтобы исключить повторные NameError внутри strategy
                    ai_used = False
                    if ai_provider is not None:
                        try:
                            from ...config import get_settings as _gs
                            _settings = _gs()
                            # Учитываем те же эвристики: всегда пробуем, т.к. это уже последний шанс
                            plain = [m.to_plain() for m in pseudo]
                            sp = system_prompt if 'system_prompt' in locals() else None
                            summary_text = await ai_provider.generate_summary(plain, sp)  # type: ignore
                            if summary_text and summary_text.strip():
                                # Добавим источники как в стратегиях
                                summary_text = summary_text.rstrip() + "\n\nИсточники (голос):\n" + "\n".join(m.content for m in pseudo)
                                result = _SR(room_id=room_id, message_count=len(pseudo), generated_at=now_ms, summary_text=summary_text, sources=pseudo, used_voice=True, participants=[])
                                ai_used = True
                                logger.warning("summary_v2: synthesized voice fallback upgraded via direct AI room=%s user=%s parts=%s", room_id, user_id, len(pseudo))
                            else:
                                logger.debug("summary_v2: direct AI returned empty content in voice fallback room=%s user=%s", room_id, user_id)
                        except Exception as e_ai:
                            logger.warning("summary_v2: direct AI attempt failed in voice fallback room=%s user=%s err=%s", room_id, user_id, e_ai)
                    if not ai_used:
                        text = "Краткая выжимка по голосу (fallback):\n" + "\n".join(head_parts)
                        result = _SR(room_id=room_id, message_count=len(pseudo), generated_at=now_ms, summary_text=text, sources=pseudo, used_voice=True, participants=[])
                        logger.warning("summary_v2: synthesized fallback voice summary room=%s user=%s parts=%s", room_id, user_id, len(pseudo))
                    # Диагностика: если в исходных сегментах был meta, отметим это
                    try:
                        if any(seg.strip().startswith('[meta ') for seg in vseg2):
                            logger.debug("summary_v2: meta prefixes were present in voice_segments and stripped room=%s user=%s", room_id, user_id)
                    except Exception:
                        pass
            except Exception:
                pass
        return result

# singleton accessor
_orchestrator_singleton: SummaryOrchestrator | None = None

def get_summary_orchestrator() -> SummaryOrchestrator:
    global _orchestrator_singleton
    if _orchestrator_singleton is None:
        _orchestrator_singleton = SummaryOrchestrator()
    return _orchestrator_singleton
