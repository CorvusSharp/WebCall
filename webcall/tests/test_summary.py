from __future__ import annotations

import pytest
from app.infrastructure.services.summary import SummaryCollector
from app.infrastructure.services.ai_provider import HeuristicAIProvider


@pytest.mark.asyncio
async def test_summary_collector_basic(monkeypatch):
    collector = SummaryCollector()
    # отключаем AI для предсказуемости
    from app.infrastructure import config as cfg
    s = cfg.get_settings()
    monkeypatch.setattr(s, 'AI_SUMMARY_ENABLED', False, raising=False)

    for i in range(5):
        await collector.add_message('room-x', f'user-{i%2}', f'U{i%2}', f'msg {i}')

    res = await collector.summarize('room-x', HeuristicAIProvider())
    assert res is not None
    assert res.message_count == 5
    assert 'msg 4' in res.summary_text  # последнее сообщение присутствует

    # повторная суммаризация той же комнаты должна вернуть None (очищено)
    res2 = await collector.summarize('room-x', HeuristicAIProvider())
    assert res2 is None
