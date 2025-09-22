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
        technical = False
        low = transcript.lower()
        if low.startswith('(no audio') or low.startswith('(asr failed') or low.startswith('(asr exception') or low.startswith('(asr disabled'):
            technical = True
        sess.add_voice_transcript(transcript)
        logger.info("summary_v2: add_voice_transcript room=%s user=%s chars=%s technical=%s head=%r", room_id, user_id, len(transcript), technical, transcript[:60])

    async def start_user_window(self, room_id: str, user_id: str) -> None:
        """Старт (или перезапуск) персонального окна пользователя."""
        key = (room_id, user_id)
        # перезапуск должен сбросить старую сессию
        old = self._sessions.get(key)
        if old:
            # мягко помечаем остановку старой, но не удаляем мгновенно (на случай параллельного запроса summary)
            old.stop()
            # удалим из индекса комнаты
            with contextlib.suppress(ValueError):
                self._room_sessions.get(room_id, []).remove(old)
        sess = UserAgentSession(room_id=room_id, user_id=user_id)
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
                        else:
                            logger.debug("summary_v2: skip voice transcript placeholder/technical room=%s user=%s raw=%r", room_id, user_id, txt[:80] if txt else txt)
            except Exception:
                pass
        # Получаем персональный system prompt
        system_prompt: str | None = None
        if db_session is not None:
            with contextlib.suppress(Exception):
                system_prompt = await get_user_system_prompt(db_session, user_id)
        result = await sess.build_summary(ai_provider=ai_provider, system_prompt=system_prompt)
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
                            result = await sess.build_summary(ai_provider=ai_provider, system_prompt=system_prompt)
            except Exception:
                pass
        try:
            logger.debug(
                "summary_v2: post-build result room=%s user=%s msg_count=%s used_voice=%s", room_id, user_id, result.message_count, getattr(result, 'used_voice', False)
            )
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
