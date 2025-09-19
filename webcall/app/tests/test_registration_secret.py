import os
import pytest
from httpx import AsyncClient
from fastapi import status

from app.bootstrap.asgi import app  # use absolute import; asgi instantiates application


@pytest.mark.asyncio
@pytest.mark.skipif('DATABASE_URL' not in os.environ, reason='DATABASE_URL not configured')
async def test_register_forbidden_without_or_wrong_secret(monkeypatch):
    monkeypatch.setenv('REGISTRATION_SECRET', 'abc123')
    from app.infrastructure.config import get_settings
    get_settings.cache_clear()  # type: ignore[attr-defined]
    assert get_settings().REGISTRATION_SECRET == 'abc123'

    async with AsyncClient(app=app, base_url='http://test') as ac:
        # missing secret
        r1 = await ac.post('/api/v1/auth/register', json={
            'email': 'mw1@example.com', 'username': 'mw1', 'password': 'password'
        })
        assert r1.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY or r1.status_code == status.HTTP_403_FORBIDDEN
        # wrong secret
        r2 = await ac.post('/api/v1/auth/register', json={
            'email': 'mw2@example.com', 'username': 'mw2', 'password': 'password', 'secret': 'wrong'
        })
        assert r2.status_code == status.HTTP_403_FORBIDDEN
        assert 'secret' in r2.text.lower()


@pytest.mark.asyncio
@pytest.mark.skipif('DATABASE_URL' not in os.environ, reason='DATABASE_URL not configured')
async def test_register_success_with_secret(monkeypatch):
    monkeypatch.setenv('REGISTRATION_SECRET', 'abc123')
    from app.infrastructure.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]

    async with AsyncClient(app=app, base_url='http://test') as ac:
        r = await ac.post('/api/v1/auth/register', json={
            'email': 'user2@example.com', 'username': 'user2', 'password': 'password', 'secret': 'abc123'
        })
        assert r.status_code == status.HTTP_201_CREATED, r.text
        data = r.json()
    assert data['username'] == 'user2'
