import pytest
from webcall.app.infrastructure.services.summary_v2.orchestrator import get_summary_orchestrator

class DummyAIProvider:
    async def generate_summary(self, messages, system_prompt=None):  # type: ignore
        return " || ".join(m for m in messages)

@pytest.mark.asyncio
async def test_auto_resume_session_after_stop():
    orch = get_summary_orchestrator()
    room_id = "auto-room"
    user_id = "u1"
    # Старт и первое сообщение
    await orch.start_user_window(room_id, user_id)
    orch.add_chat(room_id, user_id, "User", "Первое сообщение")
    res1 = await orch.build_personal_summary(room_id=room_id, user_id=user_id, ai_provider=DummyAIProvider(), db_session=None)
    assert res1.message_count == 1
    # Останавливаем окно
    orch.end_user_window(room_id, user_id)
    # Появляются новые сообщения без явного рестарта
    orch.add_chat(room_id, user_id, "User", "Второе сообщение после стопа")
    orch.add_chat(room_id, user_id, "User", "Третье сообщение после стопа")
    # Запрашиваем summary — должно авто создать новую сессию и учесть только новые сообщения
    res2 = await orch.build_personal_summary(room_id=room_id, user_id=user_id, ai_provider=DummyAIProvider(), db_session=None)
    assert res2.message_count >= 2, res2.summary_text
    assert "Первое сообщение" not in res2.summary_text
