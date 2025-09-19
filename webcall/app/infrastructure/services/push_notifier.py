from __future__ import annotations

from uuid import UUID
from typing import Iterable

from ...core.ports.services import PushNotifier
from ...infrastructure.config import get_settings
from ...infrastructure.services.webpush import WebPushSender, WebPushMessage
from ...core.ports.repositories import PushSubscriptionRepository, UserRepository


class SimplePushNotifier(PushNotifier):
    """Реализация PushNotifier с ретраями, вынесенными из роутера.

    SRP: только отправка уведомлений.
    DIP: роутер зависит от интерфейса.
    """

    def __init__(self, subs_repo: PushSubscriptionRepository, users: UserRepository) -> None:
        self._subs_repo = subs_repo
        self._users = users

    async def notify_incoming_call(self, to_user_id: UUID, from_user_id: UUID, from_username: str | None, room_id: str) -> None:
        target = await self._users.get_by_id(to_user_id)
        if not target:
            return
        subs = await self._subs_repo.list_by_user(target.id)
        if not subs:
            return
        settings = get_settings()
        if not (settings.VAPID_PUBLIC_KEY and settings.VAPID_PRIVATE_KEY and settings.VAPID_SUBJECT):
            return
        sender = WebPushSender(vapid_public=settings.VAPID_PUBLIC_KEY, vapid_private=settings.VAPID_PRIVATE_KEY, subject=settings.VAPID_SUBJECT)
        for s in subs:
            msg = WebPushMessage(
                title="Входящий звонок",
                body=f"{from_username or 'Пользователь'} хочет поговорить",
                icon=None,
                data={"room_id": room_id, "from": str(from_user_id), "from_name": from_username},
            )
            attempts = 0
            while attempts < 3:
                attempts += 1
                try:
                    await sender.send(s.endpoint, s.p256dh, s.auth, msg)
                    break
                except Exception as e:  # pragma: no cover - сеть
                    text = str(e)
                    if any(code in text for code in ("410", "404")):
                        await self._subs_repo.remove(target.id, s.endpoint)
                        break
                    if any(code in text for code in ("429", "500", "502", "503")) and attempts < 3:
                        continue
                    break
