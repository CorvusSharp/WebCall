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
    JWT_SECRET: str  # must be provided via .env
    JWT_EXPIRES_MIN: int = 60
    # Registration secret (mandatory gate for /auth/register)
    REGISTRATION_SECRET: str  # must be provided via .env

    # Databases
    DATABASE_URL: str
    REDIS_URL: str

    # CORS
    CORS_ORIGINS: List[str] = Field(default_factory=lambda: ["http://localhost:5173", "http://localhost:8000"])  # type: ignore[assignment]

    # WebRTC ICE
    STUN_SERVERS: List[str] = Field(default_factory=lambda: ["stun:stun.l.google.com:19302"])  # type: ignore[assignment]
    # Поддерживаем как одиночный TURN_URL, так и список TURN_URLS для UDP/TCP
    TURN_URLS: List[str] | None = None  # type: ignore[assignment]
    TURN_URL: str | None = None
    TURN_USERNAME: str | None = None
    TURN_PASSWORD: str | None = None
    # TURN доп переменные
    TURN_PUBLIC_IP: str | None = None
    TURN_REALM: str | None = None

    # Доп: пароль Postgres (может понадобиться для генерации URL или вспомогательных задач)
    POSTGRES_PASSWORD: str | None = None

    # Web Push (VAPID)
    VAPID_PUBLIC_KEY: str | None = None
    VAPID_PRIVATE_KEY: str | None = None
    VAPID_SUBJECT: str | None = None

    # Rate limiting (формат: "<limit>/<window_sec>") например 100/60
    RATE_LIMIT: str | None = None
    # Backend приглашений звонков: memory | redis
    CALL_INVITES_BACKEND: str = "memory"

    # AI Summaries / Telegram
    AI_SUMMARY_ENABLED: bool = False  # включение функционала AI выжимок
    AI_MODEL_PROVIDER: str | None = None  # имя провайдера/модели (например 'openai:gpt-4o-mini'), пока не используется напрямую
    AI_SUMMARY_MAX_MESSAGES: int = 200  # лимит сообщений для одного резюме (хвост обрезается)
    TELEGRAM_BOT_TOKEN: str | None = None  # токен бота для отправки итоговых выжимок
    TELEGRAM_CHAT_ID: str | None = None  # целевой chat/channel id для получения выжимок
    OPENAI_API_KEY: str | None = None  # ключ OpenAI (НЕ хранить в репо)
    AI_MODEL_FALLBACK: str | None = None  # запасная модель если основная недоступна
    # Voice capture / ASR
    VOICE_CAPTURE_ENABLED: bool = False
    VOICE_CHUNK_MAX_MS: int = 5000  # длительность сегмента MediaRecorder
    VOICE_ASR_MODEL: str = "whisper-1"  # модель для распознавания (OpenAI)
    VOICE_MAX_TOTAL_MB: int = 30  # ограничение на суммарный объём аудиоданных


@lru_cache()
def get_settings() -> Settings:
    s = Settings()
    # allow comma-separated env for lists
    if isinstance(s.CORS_ORIGINS, str):  # type: ignore[unreachable]
        s.CORS_ORIGINS = [x.strip() for x in s.CORS_ORIGINS.split(",") if x.strip()]  # type: ignore[attr-defined]
    if isinstance(s.STUN_SERVERS, str):  # type: ignore[unreachable]
        s.STUN_SERVERS = [x.strip() for x in s.STUN_SERVERS.split(",") if x.strip()]  # type: ignore[attr-defined]
    # Нормализуем TURN_URLS / TURN_URL
    if isinstance(s.TURN_URLS, str):  # type: ignore[unreachable]
        s.TURN_URLS = [x.strip() for x in s.TURN_URLS.split(",") if x.strip()]  # type: ignore[attr-defined]
    if not s.TURN_URLS and s.TURN_URL:
        s.TURN_URLS = [s.TURN_URL]
    return s
