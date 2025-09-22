from __future__ import annotations
from dataclasses import dataclass
from typing import List, Optional
import time


@dataclass(slots=True)
class ChatMessage:
    room_id: str
    author_id: str | None
    author_name: str | None
    content: str
    ts: int  # epoch ms
    def to_plain(self) -> str:
        who = self.author_name or self.author_id or "anon"
        return f"[{self.ts}] {who}: {self.content}".strip()


@dataclass(slots=True)
class SummaryResult:
    room_id: str
    message_count: int
    generated_at: int
    summary_text: str
    sources: List[ChatMessage]
    used_voice: bool = False
    truncated: bool = False

    @classmethod
    def empty(cls, room_id: str) -> 'SummaryResult':
        return cls(room_id=room_id, message_count=0, generated_at=int(time.time()*1000), summary_text="Нет сообщений для суммаризации.", sources=[], used_voice=False)


TECHNICAL_PATTERNS = [
    '(asr failed http 400)',
    '(asr failed',
    'error asr',
]

def is_technical(msg: ChatMessage) -> bool:
    low = msg.content.lower().strip()
    if not low:
        return True
    for p in TECHNICAL_PATTERNS:
        if p in low:
            return True
    return False
