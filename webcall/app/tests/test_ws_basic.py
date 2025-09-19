import pytest
from starlette.testclient import TestClient
from app.bootstrap.asgi import app
import os


@pytest.mark.asyncio
async def test_ws_basic(monkeypatch):
    # Гарантируем режим test чтобы ws endpoint разрешал соединение без токена
    monkeypatch.setenv("APP_ENV", "test")
    from app.infrastructure.config import get_settings
    get_settings.cache_clear()  # type: ignore[attr-defined]
    client = TestClient(app)
    with client.websocket_connect("/ws/rooms/00000000-0000-0000-0000-000000000001") as ws:
        ws.send_json({"type": "chat", "content": "hi"})
        msg = ws.receive_json()
        assert msg["type"] == "chat"
