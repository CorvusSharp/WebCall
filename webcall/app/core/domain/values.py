from __future__ import annotations

import re
from dataclasses import dataclass

from ..errors import ValidationError


EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


@dataclass(frozen=True, slots=True)
class Email:
    value: str

    def __post_init__(self) -> None:
        v = self.value.strip().lower()
        if not EMAIL_RE.match(v):
            raise ValidationError("Invalid email format")
        object.__setattr__(self, "value", v)

    def __str__(self) -> str:  # for convenience
        return self.value


@dataclass(frozen=True, slots=True)
class RoomName:
    value: str

    def __post_init__(self) -> None:
        v = self.value.strip()
        if not (1 <= len(v) <= 100):
            raise ValidationError("Room name must be 1..100 chars")
        object.__setattr__(self, "value", v)

    def __str__(self) -> str:
        return self.value


@dataclass(frozen=True, slots=True)
class PasswordHash:
    value: str

    def __post_init__(self) -> None:
        if not self.value or len(self.value) < 10:
            # bcrypt hashes are long; minimal sanity check
            raise ValidationError("Password hash looks invalid")

    def __str__(self) -> str:
        return self.value
