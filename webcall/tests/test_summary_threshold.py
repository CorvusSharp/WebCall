from __future__ import annotations

import pytest
from app.infrastructure.services.summary import SummaryCollector
from app.infrastructure.services.ai_provider import HeuristicAIProvider
from app.infrastructure import config as cfg


@pytest.mark.asyncio
async def test_summary_min_chars_threshold(monkeypatch):
    collector = SummaryCollector()
    settings = cfg.get_settings()
    # Включаем AI и задаём высокий порог чтобы сработало отсечение
    monkeypatch.setattr(settings, 'AI_SUMMARY_ENABLED', True, raising=False)
    monkeypatch.setattr(settings, 'AI_SUMMARY_MIN_CHARS', 200, raising=False)

    # Добавляем короткие сообщения общим объёмом меньше 200 символов
    lines = ["Привет", "Как дела?", "Ок"]
    for i, line in enumerate(lines):
        await collector.add_message('room-t', f'u{i}', f'U{i}', line)

    res = await collector.summarize('room-t', HeuristicAIProvider())
    assert res is not None
    # Ожидаем что сработал текст маркера про слишком короткую сессию
    assert 'слишком короткая' in res.summary_text.lower()
    # Повторно должно вернуть None
    res2 = await collector.summarize('room-t', HeuristicAIProvider())
    assert res2 is None
