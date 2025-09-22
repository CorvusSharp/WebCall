import pytest, time
from webcall.app.infrastructure.services.summary_v2.orchestrator import get_summary_orchestrator

class DummyAIProvider:
    async def generate_summary(self, messages, system_prompt=None):  # type: ignore
        return " | ".join(m for m in messages)

@pytest.mark.asyncio
async def test_reuse_previous_voice_fast_restart():
    orch = get_summary_orchestrator()
    room_id = "reuse-room"
    user_id = "reuse-user"
    await orch.start_user_window(room_id, user_id)
    orch.add_voice_transcript(room_id, "Запоминание первой транскрипции для переиспользования", user_id=user_id)
    res1 = await orch.build_personal_summary(room_id=room_id, user_id=user_id, ai_provider=DummyAIProvider(), db_session=None)
    assert res1.message_count > 0
    # Быстрый рестарт (<7s) без новой речи
    orch.end_user_window(room_id, user_id)
    await orch.start_user_window(room_id, user_id)
    res2 = await orch.build_personal_summary(room_id=room_id, user_id=user_id, ai_provider=DummyAIProvider(), db_session=None)
    # Должен сработать reuse — summary не пустое
    assert res2.message_count > 0
    assert "переиспольз" in res2.summary_text.lower()
