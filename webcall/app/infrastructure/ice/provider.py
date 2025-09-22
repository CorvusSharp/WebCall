# app/presentation/infrastructure/ice/provider.py
from __future__ import annotations

import json
import os
from typing import Any, Protocol


class IceConfigProvider(Protocol):
    async def get_servers(self) -> dict[str, Any]: ...


def _get_env(name: str, default: str | None = None) -> str | None:
    val = os.getenv(name)
    return val if val is not None else default


class EnvIceConfigProvider:
    """
    Читает STUN/TURN из env и отдаёт структуру WebRTC ICE.
    Поддерживает:
      - STUN_SERVERS: JSON-массив или строка с запятыми
      - TURN_URLS: JSON-массив или строка с запятыми
      - TURN_URL: одиночная строка (legacy)
    """

    async def get_servers(self) -> dict[str, Any]:
        # --- STUN ---
        stun_raw = _get_env("STUN_SERVERS", '["stun:stun.l.google.com:19302"]')
        stun_servers: list[str] = []
        if stun_raw:
            try:
                if stun_raw.strip().startswith("["):
                    stun_servers = json.loads(stun_raw)
                else:
                    stun_servers = [s.strip() for s in stun_raw.split(",") if s.strip()]
            except Exception:
                stun_servers = []

        # --- TURN ---
        # Новое: поддержка списка URL (UDP/TCP и т.д.)
        turn_urls_raw = _get_env("TURN_URLS") or _get_env("TURN_URL")
        turn_username = _get_env("TURN_USERNAME")
        turn_password = _get_env("TURN_PASSWORD")

        turn_urls: list[str] = []
        if turn_urls_raw:
            try:
                if turn_urls_raw.strip().startswith("["):
                    turn_urls = json.loads(turn_urls_raw)
                else:
                    turn_urls = [u.strip() for u in turn_urls_raw.split(",") if u.strip()]
            except Exception:
                turn_urls = [turn_urls_raw]

        ice: list[dict[str, Any]] = []
        if stun_servers:
            ice.append({"urls": stun_servers})
        if turn_urls and turn_username and turn_password:
            ice.append(
                {
                    "urls": turn_urls,
                    "username": turn_username,
                    "credential": turn_password,
                }
            )

        has_turn = any(
            any(
                isinstance(url, str) and url.startswith("turn")
                for url in (srv.get("urls") if isinstance(srv.get("urls"), list) else [srv.get("urls")])
            )
            for srv in ice
        )
        if not has_turn:
            ice.append(
                {
                    "urls": [
                        "turn:openrelay.metered.ca:80",
                        "turn:openrelay.metered.ca:443",
                        "turns:openrelay.metered.ca:443",
                    ],
                    "username": "openrelayproject",
                    "credential": "openrelayproject",
                }
            )

        config: dict[str, Any] = {"iceServers": ice}
        policy = _get_env("ICE_TRANSPORT_POLICY")
        if policy:
            config["iceTransportPolicy"] = policy
        pool = _get_env("ICE_CANDIDATE_POOL_SIZE")
        if pool:
            try:
                config["iceCandidatePoolSize"] = int(pool)
            except (TypeError, ValueError):
                pass

        return config
