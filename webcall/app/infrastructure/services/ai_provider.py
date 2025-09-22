from __future__ import annotations

"""Простой mock AI провайдера.

Реализация AISummaryProvider, использующая эвристику: считает количество
сообщений, авторов и возвращает несколько последних реплик.
Заменяется на реальный API (OpenAI, etc.) при наличии ключей.
"""

from collections import Counter
from typing import List, Optional
import httpx
import asyncio
from .summary import AISummaryProvider
from ..config import get_settings
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from ..db.models import Users


class HeuristicAIProvider(AISummaryProvider):
    async def generate_summary(self, plain_messages: List[str]) -> str:  # type: ignore[override]
        if not plain_messages:
            return "Нет данных для анализа."
        # Автор = часть строки после ']: ' до ':' следующего? Упростим: ищем шаблон '] name:'
        authors = []
        for line in plain_messages:
            try:
                # [ts] name: content
                after = line.split('] ', 1)[1]
                name = after.split(':', 1)[0].strip()
                authors.append(name)
            except Exception:
                continue
        top_authors = ", ".join([f"{a}({c})" for a, c in Counter(authors).most_common(5)]) if authors else "—"
        last_lines = "\n".join(plain_messages[-5:])
        return (
            "AI эвристическая выжимка:\n"
            f"Всего сообщений: {len(plain_messages)}\n"
            f"Активные участники: {top_authors}\n"
            "Последние реплики:\n" + last_lines
        )


class OpenAIAIProvider(AISummaryProvider):
    """Провайдер, использующий OpenAI Chat Completions/Responses API.

    Используем минимальный вызов с моделью из AI_MODEL_PROVIDER (после префикса 'openai:').
    Формат plain_messages: список строк. Мы склеиваем в одну подсказку, обрезая при необходимости.
    """

    def __init__(self, api_key: str, model: str, fallback: str | None = None) -> None:
        self.api_key = api_key
        self.model = model
        self.fallback = fallback

    async def generate_summary(self, plain_messages: List[str], system_prompt: str | None = None) -> str:  # type: ignore[override]
        if not plain_messages:
            return "Нет данных для анализа."
        prompt_messages = plain_messages[-500:]  # safety bound
        joined = "\n".join(prompt_messages)
        system = system_prompt or (
            "Ты ассистент, делающий краткую структурированную выжимку группового чата:"
            " 1) Основные темы 2) Принятые решения 3) Открытые вопросы."
            " Пиши лаконично на русском, без лишних вступлений."
        )
        url = "https://api.openai.com/v1/chat/completions"
        headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
        body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": f"Сообщения чата:\n{joined}\n---\nСформируй выжимку."},
            ],
            "temperature": 0.3,
            "max_tokens": 600,
        }
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                r = await client.post(url, json=body, headers=headers)
                if r.status_code == 200:
                    data = r.json()
                    # OpenAI Chat Completion формат
                    content = data['choices'][0]['message']['content']  # type: ignore[index]
                    return content.strip()
                # fallback попытка другой модели если указана
                if self.fallback and r.status_code in {400, 404}:  # модель не найдена / неверна
                    body["model"] = self.fallback
                    async with httpx.AsyncClient(timeout=30.0) as client2:
                        r2 = await client2.post(url, json=body, headers=headers)
                        if r2.status_code == 200:
                            data2 = r2.json()
                            return data2['choices'][0]['message']['content'].strip()  # type: ignore[index]
                return _error_fallback(joined, f"OpenAI HTTP {r.status_code}")
        except Exception as e:  # pragma: no cover
            return _error_fallback(joined, f"exc:{e.__class__.__name__}")


def _error_fallback(joined: str, reason: str) -> str:
    tail = "\n".join(joined.splitlines()[-10:])
    return (
        "Эвристическая выжимка (OpenAI недоступен: " + reason + ")\n" + tail
    )


# Фабрика выбора провайдера
_provider_singleton: AISummaryProvider | None = None


def get_ai_provider() -> AISummaryProvider:
    global _provider_singleton
    if _provider_singleton is not None:
        return _provider_singleton
    settings = get_settings()
    api_key = settings.OPENAI_API_KEY
    model_field = settings.AI_MODEL_PROVIDER or ""
    if api_key and model_field.startswith("openai:"):
        model = model_field.split(":", 1)[1] or "gpt-4o-mini"
        _provider_singleton = OpenAIAIProvider(api_key=api_key, model=model, fallback=settings.AI_MODEL_FALLBACK)
    else:
        _provider_singleton = HeuristicAIProvider()
    return _provider_singleton


async def get_user_system_prompt(session: AsyncSession, user_id) -> str | None:
    """Возвращает сохранённый кастомный prompt пользователя или None."""
    q = select(Users.ai_system_prompt).where(Users.id == user_id)
    res = await session.execute(q)
    return res.scalar_one_or_none()
