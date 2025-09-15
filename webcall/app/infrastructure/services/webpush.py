from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Iterable

import anyio
try:
    from pywebpush import webpush, WebPushException  # type: ignore
except Exception:  # pragma: no cover
    webpush = None  # type: ignore
    WebPushException = Exception  # type: ignore


@dataclass
class WebPushMessage:
    title: str
    body: str
    icon: str | None = None
    data: dict | None = None

    def json(self) -> str:
        return json.dumps({
            "title": self.title,
            "body": self.body,
            "icon": self.icon,
            "data": self.data or {},
        })


class WebPushSender:
    """Lightweight placeholder for sending Web Push notifications.

    In a real deployment, you'd use a library like pywebpush to send HTTP requests to endpoints
    with VAPID keys. Here we leave the network IO to the outer layer to keep dependencies minimal.
    """

    def __init__(self, vapid_public: str | None = None, vapid_private: str | None = None, subject: str | None = None) -> None:
        self.vapid_public = vapid_public
        self.vapid_private = vapid_private
        self.subject = subject or "mailto:admin@example.com"

    async def send(self, endpoint: str, p256dh: str, auth: str, message: WebPushMessage) -> None:
        if not webpush or not self.vapid_private:
            return  # silently skip if not configured
        sub = {"endpoint": endpoint, "keys": {"p256dh": p256dh, "auth": auth}}
        payload = message.json()
        claims = {"sub": self.subject}
        def _do():
            return webpush(subscription_info=sub, data=payload, vapid_private_key=self.vapid_private, vapid_claims=claims)
        await anyio.to_thread.run_sync(_do)
