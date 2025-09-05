from __future__ import annotations

from datetime import datetime, timedelta, timezone

from jose import JWTError, jwt

from ...core.ports.services import TokenProvider
from ..config import get_settings


class JoseTokenProvider(TokenProvider):
    def __init__(self) -> None:
        self.settings = get_settings()
        self.algorithm = "HS256"

    def create_access_token(self, subject: str, expires_minutes: int | None = None) -> str:  # type: ignore[override]
        expires_minutes = expires_minutes or self.settings.JWT_EXPIRES_MIN
        now = datetime.now(tz=timezone.utc)
        payload = {"sub": subject, "iat": int(now.timestamp()), "exp": int((now + timedelta(minutes=expires_minutes)).timestamp())}
        return jwt.encode(payload, self.settings.JWT_SECRET, algorithm=self.algorithm)

    def decode_token(self, token: str) -> dict:  # type: ignore[override]
        try:
            return jwt.decode(token, self.settings.JWT_SECRET, algorithms=[self.algorithm])
        except JWTError as e:
            raise ValueError("Invalid token") from e
