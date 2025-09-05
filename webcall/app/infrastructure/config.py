from __future__ import annotations

from functools import lru_cache
from typing import List

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", case_sensitive=False)

    # App
    APP_NAME: str = "WebCall"
    APP_ENV: str = "dev"
    API_PREFIX: str = "/api/v1"
    HOST: str = "0.0.0.0"
    PORT: int = 8000

    # Security
    JWT_SECRET: str = "change_me"
    JWT_EXPIRES_MIN: int = 60

    # Databases
    DATABASE_URL: str
    REDIS_URL: str

    # CORS
    CORS_ORIGINS: List[str] = Field(default_factory=lambda: ["http://localhost:5173", "http://localhost:8000"])  # type: ignore[assignment]

    # WebRTC ICE
    STUN_SERVERS: List[str] = Field(default_factory=lambda: ["stun:stun.l.google.com:19302"])  # type: ignore[assignment]
    TURN_URL: str | None = None
    TURN_USERNAME: str | None = None
    TURN_PASSWORD: str | None = None


@lru_cache()
def get_settings() -> Settings:
    s = Settings()
    # allow comma-separated env for lists
    if isinstance(s.CORS_ORIGINS, str):  # type: ignore[unreachable]
        s.CORS_ORIGINS = [x.strip() for x in s.CORS_ORIGINS.split(",") if x.strip()]  # type: ignore[attr-defined]
    if isinstance(s.STUN_SERVERS, str):  # type: ignore[unreachable]
        s.STUN_SERVERS = [x.strip() for x in s.STUN_SERVERS.split(",") if x.strip()]  # type: ignore[attr-defined]
    return s
