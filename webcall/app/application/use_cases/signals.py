from __future__ import annotations

from uuid import UUID

from ...core.domain.models import Signal
from ...core.ports.services import SignalBus


class PublishSignal:
    def __init__(self, bus: SignalBus) -> None:
        self.bus = bus

    async def execute(
        self, *, room_id: UUID, sender_id: UUID, type: str, sdp: str | None = None, candidate: dict | None = None, target_id: UUID | None = None
    ) -> None:
        signal = Signal.create(type=type, sender_id=sender_id, room_id=room_id, sdp=sdp, candidate=candidate, target_id=target_id)
        await self.bus.publish(room_id, signal)
