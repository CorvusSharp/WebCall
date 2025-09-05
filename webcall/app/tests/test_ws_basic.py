import asyncio
import json

import pytest
from starlette.testclient import TestClient

from app.bootstrap.asgi import app


@pytest.mark.asyncio
async def test_ws_basic():
    client = TestClient(app)
    with client.websocket_connect("/ws/rooms/00000000-0000-0000-0000-000000000001") as ws:
        ws.send_json({"type": "chat", "content": "hi"})
        msg = ws.receive_json()
        assert msg["type"] == "chat"
