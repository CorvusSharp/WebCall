import pytest
import asyncio
from webcall.app.infrastructure.services.summary_v2.orchestrator import get_summary_orchestrator

class DummyAIProvider:
    async def generate_summary(self, messages, system_prompt=None):  # type: ignore
        # Простейшая агрегация для теста
        return " | ".join(m.split(':',1)[-1].strip() for m in messages)

@pytest.mark.asyncio
async def test_summary_v2_restart_two_voice_segments(monkeypatch):
    orch = get_summary_orchestrator()
    room_id = "test-room-restart"
    user_id = "user-1"

    # Старт сессии
    await orch.start_user_window(room_id, user_id)
    # Добавляем voice транскрипт (эмуляция)
    orch.add_voice_transcript(room_id, "Первый сеанс разговора о погоде и планах", user_id=user_id)

    res1 = await orch.build_personal_summary(room_id=room_id, user_id=user_id, ai_provider=DummyAIProvider(), db_session=None)
    assert res1.message_count > 0, "Первое summary должно содержать сообщение из voice"
    assert "Первый сеанс" in res1.summary_text

    # Завершение и перезапуск
    orch.end_user_window(room_id, user_id)
    await orch.start_user_window(room_id, user_id)

    # Вторая транскрипция
    orch.add_voice_transcript(room_id, "Второй сеанс обсуждаем технологии и код", user_id=user_id)

    res2 = await orch.build_personal_summary(room_id=room_id, user_id=user_id, ai_provider=DummyAIProvider(), db_session=None)
    assert res2.message_count > 0, "Второе summary должно быть непустым"
    assert "Второй сеанс" in res2.summary_text
    # Убедимся что текст первого сеанса не смешался во второй (простая эвристика)
    assert "Первый сеанс" not in res2.summary_text

@pytest.mark.asyncio
async def test_summary_v2_multiple_voice_segments_single_session(monkeypatch):
    orch = get_summary_orchestrator()
    room_id = "test-room-multi"
    user_id = "user-2"
    await orch.start_user_window(room_id, user_id)
    orch.add_voice_transcript(room_id, "Первая часть беседы про погоду", user_id=user_id)
    orch.add_voice_transcript(room_id, "Вторая часть беседы про технологии", user_id=user_id)

    res = await orch.build_personal_summary(room_id=room_id, user_id=user_id, ai_provider=DummyAIProvider(), db_session=None)
    assert res.message_count > 0
    # Оба сегмента должны присутствовать в источниках (через объединение strategy)
    assert "погоду" in res.summary_text or "погоду" in res.summary_text.lower()
    assert "технолог" in res.summary_text.lower()
