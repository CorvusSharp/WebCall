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
        if not sess:
            # ленивое создание (редкий случай): пользователь мог вызвать транскрипт раньше явного старта агента
            sess = UserAgentSession(room_id=room_id, user_id=user_id)
            self._sessions[key] = sess
            self._room_sessions.setdefault(room_id, []).append(sess)
        sess.add_voice_transcript(transcript)
        logger.info("summary_v2: add_voice_transcript room=%s user=%s chars=%s", room_id, user_id, len(transcript))

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
        # Сбросим старую транскрипцию (если осталась от прошлого разговора) чтобы не приклеить её к новому окну
        try:
            vc = get_voice_collector()
            with contextlib.suppress(Exception):
                popped = await vc.pop_transcript(f"{room_id}:{user_id}")  # type: ignore
                if popped:
                    logger.info("summary_v2: cleared old voice transcript on restart room=%s user=%s", room_id, user_id)
        except Exception:
            pass
        # Прелоад убран — будет лениво в build_personal_summary если появится новая валидная транскрипция.

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
            logger.debug(
                "summary_v2: pre-build state room=%s user=%s msgs=%s has_voice=%s", room_id, user_id, len(getattr(sess, '_messages', [])), bool(getattr(sess, '_voice_text', None))
            )
        except Exception:
            pass
        # Если в сессии нет voice, попробуем подтянуть (лениво) готовую транскрипцию, чтобы не было окна, когда агент стартовал чуть позже окончания речи
        if sess._voice_text is None:  # type: ignore[attr-defined]
            try:
                vc = get_voice_collector()
                voice_key = f"{room_id}:{user_id}"
                with contextlib.suppress(Exception):
                    vt = await vc.get_transcript(voice_key)
                    if vt and getattr(vt, 'text', None):
                        txt = vt.text.strip()
                        low = txt.lower()
                        # Отбрасываем плейсхолдеры и слишком старые транскрипты (до старта сессии)
                        if txt and not low.startswith('(no audio chunks') and not low.startswith('(asr failed') and not low.startswith('(asr exception') and not low.startswith('(asr disabled') and vt.generated_at >= sess.start_ts:
                            sess.add_voice_transcript(txt)
                            logger.info("summary_v2: lazy attach voice transcript room=%s user=%s len=%s gen_at=%s start_ts=%s", room_id, user_id, len(txt), vt.generated_at, sess.start_ts)
                        else:
                            if low.startswith('(no audio chunks'):
                                logger.debug("summary_v2: skip placeholder voice transcript room=%s user=%s", room_id, user_id)
                            elif vt.generated_at < sess.start_ts:
                                logger.debug("summary_v2: skip old voice transcript room=%s user=%s gen_at=%s start_ts=%s", room_id, user_id, vt.generated_at, sess.start_ts)
            except Exception:
                pass
        # Получаем персональный system prompt
        system_prompt: str | None = None
        if db_session is not None:
            with contextlib.suppress(Exception):
                system_prompt = await get_user_system_prompt(db_session, user_id)
        result = await sess.build_summary(ai_provider=ai_provider, system_prompt=system_prompt)
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
