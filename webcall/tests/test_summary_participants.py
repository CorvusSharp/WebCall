import pytest
from app.infrastructure.services.summary_v2.orchestrator import get_summary_orchestrator
from app.infrastructure.services.summary_v2.models import SummaryResult
from app.infrastructure.services.ai_provider import HeuristicAIProvider
from app.infrastructure.config import get_settings

@pytest.mark.asyncio
async def test_summary_participant_breakdown(monkeypatch):
    # Включаем флаг breakdown
    settings = get_settings()
    monkeypatch.setattr(settings, 'AI_SUMMARY_ENABLED', False, raising=False)  # чтобы не обращаться к внешнему AI
    monkeypatch.setattr(settings, 'AI_SUMMARY_PARTICIPANT_BREAKDOWN', True, raising=False)
    orch = get_summary_orchestrator()
    room_id = 'r1'
    # Старт окна пользователя u1 и u2
    await orch.start_user_window(room_id, 'u1')
    await orch.start_user_window(room_id, 'u2')
    # Добавляем сообщения
    orch.add_chat(room_id, 'u1', 'User1', 'Привет')
    orch.add_chat(room_id, 'u2', 'User2', 'Здравствуйте')
    orch.add_chat(room_id, 'u1', 'User1', 'Как дела?')
    orch.add_chat(room_id, 'u2', 'User2', 'Отлично, обсуждаем проект')
    orch.add_chat(room_id, 'u1', 'User1', 'Нужно добавить разбивку по участникам')

    provider = HeuristicAIProvider()
    # Генерируем персональный summary для u1
    res1 = await orch.build_personal_summary(room_id=room_id, user_id='u1', ai_provider=provider, db_session=None)
    assert isinstance(res1, SummaryResult)
    assert res1.participants is not None
    # В персональном окне u1 должны быть сообщения u1 и u2 (оба автора после старта)
    authors = { (p.participant_id, p.participant_name) for p in res1.participants }
    assert ('u1', 'User1') in authors and ('u2', 'User2') in authors
    # Проверяем что sample_messages не пустые
    assert any(p.sample_messages for p in res1.participants)

    # Отключаем breakdown и убеждаемся что participants=None
    monkeypatch.setattr(settings, 'AI_SUMMARY_PARTICIPANT_BREAKDOWN', False, raising=False)
    res2 = await orch.build_personal_summary(room_id=room_id, user_id='u1', ai_provider=provider, db_session=None)
    # breakdown отключён
    assert res2.participants is None or res2.participants == []
