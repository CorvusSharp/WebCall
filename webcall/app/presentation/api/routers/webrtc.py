from __future__ import annotations

from fastapi import APIRouter, Depends

from ....core.ports.services import IceConfigProvider
from ..deps.containers import get_ice_provider

router = APIRouter(prefix="/api/v1/webrtc", tags=["webrtc"])


@router.get("/ice-servers")
async def ice_servers(provider: IceConfigProvider = Depends(get_ice_provider)) -> dict:  # type: ignore[override]
    servers = await provider.get_servers()
    return {"iceServers": servers}
