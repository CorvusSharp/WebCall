from __future__ import annotations

"""Упрощённый диспетчер отправки сообщений в Telegram с очередью,
ретраями и защитой от дублей.

Использование:
    from .telegram_dispatcher import get_dispatcher
    dispatcher = get_dispatcher()
    await dispatcher.queue_summary(user_id, text, reason="manual")

Дубликаты подавляются по ключу (user_id, summary_hash, reason) в течение TTL.

Не претендует на полноту брокера. В перспективе можно заменить
на Redis Stream / Celery.
"""

import asyncio, hashlib, time, contextlib, logging
from dataclasses import dataclass
from typing import Optional, Dict, Deque, Set
from collections import deque
from sqlalchemy.ext.asyncio import AsyncSession
from .telegram import send_message as low_level_send
from ..config import get_settings
from ..db.session import get_session
from ..db.models import TelegramLinks
from sqlalchemy import select

logger = logging.getLogger(__name__)

@dataclass
class PendingTask:
    user_id: str
    text: str
    reason: str
    attempts: int = 0
    created_at: float = time.time()

class TelegramDispatcher:
    def __init__(self) -> None:
        self._queue: Deque[PendingTask] = deque()
        self._seen: Dict[str, float] = {}  # dedupe key -> ts
        self._seen_ttl = 3600  # 1h
        self._lock = asyncio.Lock()
        self._worker_task: Optional[asyncio.Task] = None
        self._stop = False
        self._started = False

    def start(self) -> None:
        if self._started:
            return
        self._started = True
        self._worker_task = asyncio.create_task(self._worker())
        logger.info("telegram_dispatcher: started")

    async def shutdown(self) -> None:
        self._stop = True
        if self._worker_task:
            self._worker_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._worker_task
        logger.info("telegram_dispatcher: stopped")

    async def queue_summary(self, user_id: str, text: str, *, reason: str) -> bool:
        if not text or not text.strip():
            logger.debug("dispatcher: skip empty text user=%s", user_id)
            return False
        key = self._dedupe_key(user_id, text, reason)
        now = time.time()
        # Очистка старых ключей из _seen (ленивая)
        if len(self._seen) > 5000:
            drop = [k for k,v in self._seen.items() if now - v > self._seen_ttl]
            for k in drop:
                self._seen.pop(k, None)
        if key in self._seen:
            logger.debug("dispatcher: duplicate suppressed user=%s reason=%s", user_id, reason)
            return False
        self._seen[key] = now
        task = PendingTask(user_id=user_id, text=text, reason=reason)
        self._queue.append(task)
        if not self._started:
            self.start()
        logger.info("dispatcher: queued summary user=%s reason=%s len=%s", user_id, reason, len(text))
        return True

    def _dedupe_key(self, user_id: str, text: str, reason: str) -> str:
        h = hashlib.sha256(text.encode('utf-8')).hexdigest()[:16]
        return f"{user_id}:{reason}:{h}"

    async def _worker(self) -> None:
        settings = get_settings()
        BACKOFF_BASE = 0.75
        while not self._stop:
            try:
                if not self._queue:
                    await asyncio.sleep(0.2)
                    continue
                task = self._queue.popleft()
                sent = False
                chat_id: Optional[str] = None
                # Получаем chat_id напрямую быстрой выборкой
                try:
                    async with get_session() as session:
                        q = select(TelegramLinks.chat_id).where(TelegramLinks.user_id == task.user_id, TelegramLinks.status == 'confirmed', TelegramLinks.chat_id.is_not(None))
                        res = await session.execute(q)
                        chat_id = res.scalar_one_or_none()
                except Exception as e:
                    logger.warning("dispatcher: chat_id fetch error user=%s err=%s", task.user_id, e)
                if not settings.TELEGRAM_BOT_TOKEN:
                    logger.debug("dispatcher: skip (no bot token)")
                    continue
                if not chat_id:
                    logger.debug("dispatcher: skip (no confirmed chat_id) user=%s", task.user_id)
                    continue
                # Попытка отправки с ретраями
                try:
                    sent = await low_level_send(task.text, chat_ids=[chat_id])
                except Exception as e:
                    logger.error("dispatcher: low-level exception user=%s err=%s", task.user_id, e)
                    sent = False
                if sent:
                    logger.info("dispatcher: sent user=%s reason=%s attempts=%s", task.user_id, task.reason, task.attempts+1)
                    continue
                # Если не отправлено — ретрай при временной ошибке
                task.attempts += 1
                if task.attempts < 3:
                    delay = BACKOFF_BASE * (2 ** (task.attempts - 1))
                    logger.info("dispatcher: retry in %.2fs user=%s reason=%s", delay, task.user_id, task.reason)
                    await asyncio.sleep(delay)
                    self._queue.append(task)
                else:
                    logger.warning("dispatcher: drop after max attempts user=%s reason=%s", task.user_id, task.reason)
            except asyncio.CancelledError:  # pragma: no cover
                break
            except Exception as e:  # pragma: no cover
                logger.exception("dispatcher: worker loop error: %s", e)
                await asyncio.sleep(1)

_dispatcher_singleton: TelegramDispatcher | None = None

def get_dispatcher() -> TelegramDispatcher:
    global _dispatcher_singleton
    if _dispatcher_singleton is None:
        _dispatcher_singleton = TelegramDispatcher()
    return _dispatcher_singleton
