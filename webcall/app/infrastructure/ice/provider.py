from __future__ import annotations

from ...core.ports.services import IceConfigProvider
from ..config import get_settings


class EnvIceConfigProvider(IceConfigProvider):
    async def get_servers(self) -> list[dict]:  # type: ignore[override]
        s = get_settings()
        servers: list[dict] = []
        if s.STUN_SERVERS:
            servers.append({"urls": s.STUN_SERVERS})
        if s.TURN_URL and s.TURN_USERNAME and s.TURN_PASSWORD:
            servers.append(
                {
                    "urls": [s.TURN_URL],
                    "username": s.TURN_USERNAME,
                    "credential": s.TURN_PASSWORD,
                }
            )
        return servers
