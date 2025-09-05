import asyncio
import os
import pytest
from httpx import AsyncClient, ASGITransport

from app.bootstrap.asgi import app


@pytest.fixture(scope="session")
def anyio_backend():
    return 'asyncio'


@pytest.fixture()
async def client():
    # httpx>=0.27: pass ASGITransport instead of deprecated app= argument
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
