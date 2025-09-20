import pytest
from httpx import AsyncClient

@pytest.mark.asyncio
async def test_update_profile_success(async_client: AsyncClient, registered_user_token):
    headers = { 'Authorization': f'Bearer {registered_user_token}' }
    r = await async_client.patch('/api/v1/auth/me', json={'username':'newname123'}, headers=headers)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data['username'] == 'newname123'

@pytest.mark.asyncio
async def test_update_profile_conflict(async_client: AsyncClient, registered_user_token, second_user):
    # Попытка установить username второго пользователя
    headers = { 'Authorization': f'Bearer {registered_user_token}' }
    r = await async_client.patch('/api/v1/auth/me', json={'username': second_user.username}, headers=headers)
    assert r.status_code == 409

@pytest.mark.asyncio
async def test_change_password_wrong_old(async_client: AsyncClient, registered_user_token):
    headers = { 'Authorization': f'Bearer {registered_user_token}' }
    r = await async_client.post('/api/v1/auth/me/password', json={'old_password':'WRONG','new_password':'newpass123'}, headers=headers)
    assert r.status_code == 400
