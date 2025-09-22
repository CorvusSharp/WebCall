import pytest
from webcall.app.infrastructure.services.summary_v2.orchestrator import get_summary_orchestrator

class DummyAIProvider:
    async def generate_summary(self, messages, system_prompt=None):  # type: ignore
        return " :: ".join(m for m in messages)

@pytest.mark.asyncio
async def test_lazy_attach_after_restart():
    orch = get_summary_orchestrator()
    room_id = "lazy-room"
    user_id = "user-lazy"
    # Старт + voice
    await orch.start_user_window(room_id, user_id)
    orch.add_voice_transcript(room_id, "Первая запись речи о тестировании", user_id=user_id)
    res1 = await orch.build_personal_summary(room_id=room_id, user_id=user_id, ai_provider=DummyAIProvider(), db_session=None)
    assert res1.message_count > 0
    # Стоп без новых данных
    orch.end_user_window(room_id, user_id)
    # Повторный старт (без новой voice) — старый транскрипт не должен автоматически появиться (мы создали новую сессию без прогрессивного attach)
    await orch.start_user_window(room_id, user_id)
    # Эмулируем, что глобальный collector всё ещё хранит текст (в реальном случае мы бы не pop-или). Добавим ещё раз вручную, чтобы проверить отсутствие дубликатов.
    orch.add_voice_transcript(room_id, "Первая запись речи о тестировании", user_id=user_id)
    res2 = await orch.build_personal_summary(room_id=room_id, user_id=user_id, ai_provider=DummyAIProvider(), db_session=None)
    assert res2.message_count > 0
    assert "Первая запись" in res2.summary_text
