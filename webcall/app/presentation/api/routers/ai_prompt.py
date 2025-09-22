from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update

from ....infrastructure.db.session import get_db_session
from ....infrastructure.config import get_settings
from ..deps.auth import get_current_user
from ....infrastructure.db.models import Users

settings = get_settings()
api_prefix = settings.API_PREFIX.rstrip('/')
router = APIRouter(prefix=f"{api_prefix}/ai", tags=["ai"])

DEFAULT_PROMPT = (
    "Ты ассистент, делающий краткую структурированную выжимку группового чата:"\
    " 1) Основные темы 2) Принятые решения 3) Открытые вопросы."\
    " Пиши лаконично на русском, без лишних вступлений."
)

class PromptOut(BaseModel):
    prompt: str
    is_default: bool

class PromptIn(BaseModel):
    prompt: str = Field(min_length=10, max_length=4000)

@router.get('/prompt', response_model=PromptOut)
async def get_prompt(session: AsyncSession = Depends(get_db_session), current_user=Depends(get_current_user)):
    q = select(Users.ai_system_prompt).where(Users.id == current_user.id)
    res = await session.execute(q)
    val = res.scalar_one_or_none()
    if val and val.strip():
        return PromptOut(prompt=val, is_default=False)
    return PromptOut(prompt=DEFAULT_PROMPT, is_default=True)

@router.put('/prompt', response_model=PromptOut)
async def set_prompt(data: PromptIn, session: AsyncSession = Depends(get_db_session), current_user=Depends(get_current_user)):
    text = data.prompt.strip()
    if not text:
        raise HTTPException(400, detail='Prompt is empty')
    if text == DEFAULT_PROMPT:
        # Сохранять дубликат дефолта не обязательно — чистим поле
        stmt = update(Users).where(Users.id == current_user.id).values(ai_system_prompt=None)
    else:
        stmt = update(Users).where(Users.id == current_user.id).values(ai_system_prompt=text)
    await session.execute(stmt)
    await session.commit()
    return PromptOut(prompt=text if text != DEFAULT_PROMPT else DEFAULT_PROMPT, is_default=(text == DEFAULT_PROMPT))

@router.delete('/prompt', response_model=PromptOut)
async def reset_prompt(session: AsyncSession = Depends(get_db_session), current_user=Depends(get_current_user)):
    stmt = update(Users).where(Users.id == current_user.id).values(ai_system_prompt=None)
    await session.execute(stmt)
    await session.commit()
    return PromptOut(prompt=DEFAULT_PROMPT, is_default=True)
