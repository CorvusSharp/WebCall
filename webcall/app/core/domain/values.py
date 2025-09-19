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


USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,32}$")


@dataclass(frozen=True, slots=True)
class Username:
    value: str

    def __post_init__(self) -> None:
        v = self.value.strip()
        if not USERNAME_RE.match(v):
            raise ValidationError("Username must be 3-32 chars [A-Za-z0-9_.-]")
        object.__setattr__(self, "value", v)

    def __str__(self) -> str:  # convenience
        return self.value
