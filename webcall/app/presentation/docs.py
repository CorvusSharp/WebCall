from __future__ import annotations

from typing import List


def get_openapi_tags() -> List[dict]:
    return [
        {"name": "auth", "description": "Аутентификация"},
        {"name": "rooms", "description": "Комнаты"},
        {"name": "participants", "description": "Участники"},
        {"name": "messages", "description": "Сообщения"},
        {"name": "webrtc", "description": "WebRTC вспомогательные"},
    {"name": "friends", "description": "Друзья"},
    {"name": "push", "description": "Web Push уведомления"},
    {"name": "users", "description": "Пользователи"},
        {"name": "health", "description": "Health checks"},
    ]
