from __future__ import annotations

import pytest
from httpx import AsyncClient
from app.infrastructure.config import get_settings

DEFAULT_PROMPT = (
    "Ты ассистент, делающий краткую структурированную выжимку группового чата:"\
    " 1) Основные темы 2) Принятые решения 3) Открытые вопросы."\
    " Пиши лаконично на русском, без лишних вступлений."
)

@pytest.mark.asyncio
async def test_ai_prompt_set_and_reset(async_client: AsyncClient, auth_headers):
    # GET initial (should be default)
    r = await async_client.get('/api/v1/ai/prompt', headers=auth_headers)
    assert r.status_code == 200
    data = r.json()
    assert data['is_default'] is True
    assert 'Основные темы' in data['prompt']

    custom = 'Кастомный prompt: выдели 1) решения 2) риски.'
    r2 = await async_client.put('/api/v1/ai/prompt', headers=auth_headers, json={'prompt': custom})
    assert r2.status_code == 200
    d2 = r2.json()
    assert d2['is_default'] is False
    assert d2['prompt'].startswith('Кастомный prompt')

    # Повторный GET возвращает кастомный
    r3 = await async_client.get('/api/v1/ai/prompt', headers=auth_headers)
    assert r3.status_code == 200
    d3 = r3.json()
    assert d3['is_default'] is False
    assert d3['prompt'].startswith('Кастомный prompt')

    # DELETE сбрасывает
    r4 = await async_client.delete('/api/v1/ai/prompt', headers=auth_headers)
    assert r4.status_code == 200
    d4 = r4.json()
    assert d4['is_default'] is True
    assert 'Основные темы' in d4['prompt']

    # Сохранение дефолта явно приводит к очистке кастомного поля
    r5 = await async_client.put('/api/v1/ai/prompt', headers=auth_headers, json={'prompt': DEFAULT_PROMPT})
    assert r5.status_code == 200
    d5 = r5.json()
    assert d5['is_default'] is True
