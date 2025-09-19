from __future__ import annotations

import time
from collections import deque
from typing import Deque

from fastapi import HTTPException, status


class _SlidingWindowLimiter:
    def __init__(self, max_events: int, window_seconds: float) -> None:
        self.max_events = max_events
        self.window = window_seconds
        self.events: Deque[float] = deque()

    def hit(self) -> None:
        now = time.monotonic()
        # очистка старых
        cutoff = now - self.window
        while self.events and self.events[0] < cutoff:
            self.events.popleft()
        if len(self.events) >= self.max_events:
            # превышено
            raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many requests, slow down")
        self.events.append(now)


_login_limiter = _SlidingWindowLimiter(max_events=8, window_seconds=60.0)
_register_limiter = _SlidingWindowLimiter(max_events=5, window_seconds=300.0)
_room_create_limiter = _SlidingWindowLimiter(max_events=30, window_seconds=300.0)


def limit_login():  # dependency
    _login_limiter.hit()


def limit_register():  # dependency
    _register_limiter.hit()


def limit_room_create():  # dependency
    _room_create_limiter.hit()
