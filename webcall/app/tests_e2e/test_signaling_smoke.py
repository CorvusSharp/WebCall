from __future__ import annotations

import asyncio
import json
import os
import uuid
import pytest
import websockets
import httpx

BASE = os.getenv("BASE_URL", "http://localhost:8000")
WS_BASE = BASE.replace("http", "ws")
REGISTER_SECRET = os.getenv("REG_SECRET", "devsecret")  # для локального запуска

pytestmark = pytest.mark.signaling

async def register(email: str, username: str, password: str) -> str:
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(f"{BASE}/api/v1/auth/register", json={
            "email": email,
            "username": username,
            "password": password,
            "secret": REGISTER_SECRET,
        })
        if r.status_code not in (200, 201):
            # Возможно уже существует — пробуем логин
            r = await client.post(f"{BASE}/api/v1/auth/login", json={
                "email": email,
                "password": password,
            })
        r.raise_for_status()
        data = r.json()
        return data["access_token"] if "access_token" in data else data.get("token")

async def ws_friends(token: str):
    url = f"{WS_BASE}/ws/friends?token={token}"
    return await websockets.connect(url, ping_interval=None)  # noqa: S113 (test code)

@pytest.mark.asyncio
async def test_invite_accept_flow():
    # Skip if server is not running (e.g. unit test run without external uvicorn)
    try:
        async with httpx.AsyncClient(timeout=2) as client:
            pong = await client.get(f"{BASE}/healthz")
            if pong.status_code != 200:
                pytest.skip("health endpoint not 200")
    except Exception:
        pytest.skip("signaling backend not available on BASE_URL")
    email_a = f"a_{uuid.uuid4().hex[:6]}@test.local"
    email_b = f"b_{uuid.uuid4().hex[:6]}@test.local"
    token_a, token_b = await asyncio.gather(
        register(email_a, "alice", "pass1234"),
        register(email_b, "bob", "pass1234"),
    )

    ws_a, ws_b = await asyncio.gather(ws_friends(token_a), ws_friends(token_b))

    room_id = f"call-{uuid.uuid4().hex[:8]}"

    # Отправляем notify-call (имитация исходящего приглашения)
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(
            f"{BASE}/api/v1/push/notify-call", json={"to_user_id": json.loads(await ws_b.recv()).get('userId', '') or ''}, headers={"Authorization": f"Bearer {token_a}"}
        )  # Эта строка может быть адаптирована — зависит от реальной схемы получения ID.

    # Упрощённо: слушаем несколько сообщений и ищем call_invite
    invite_msg = None
    for _ in range(10):
        raw = await asyncio.wait_for(ws_b.recv(), timeout=5)
        msg = json.loads(raw)
        if msg.get("type") == "call_invite":
            invite_msg = msg
            break
    assert invite_msg, "Did not receive call_invite"

    # Закрываем
    await ws_a.close()
    await ws_b.close()

# Нагрузочный простой тест (опционально можно отдельно запускать)
@pytest.mark.asyncio
async def test_room_presence_load():
    try:
        async with httpx.AsyncClient(timeout=2) as client:
            pong = await client.get(f"{BASE}/healthz")
            if pong.status_code != 200:
                pytest.skip("health endpoint not 200")
    except Exception:
        pytest.skip("signaling backend not available on BASE_URL")
    # Этот тест можно пометить как xfail/slow при необходимости.
    token = await register(f"load_{uuid.uuid4().hex[:6]}@test.local", "load", "pass1234")
    room = f"load-{uuid.uuid4().hex[:6]}"
    N = 5  # увеличить до 30-50 в реальной нагрузке
    url = f"{WS_BASE}/ws/rooms/{room}?token={token}"
    conns = []
    for _ in range(N):
        ws = await websockets.connect(url, ping_interval=None)  # noqa: S113
        conns.append(ws)
    # Ждём немного присутствий
    await asyncio.sleep(2)
    for ws in conns:
        await ws.close()
