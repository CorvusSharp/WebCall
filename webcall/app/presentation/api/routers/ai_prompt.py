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
    prompt: str  # То, что вернём в textarea (если default => сам дефолт)
    is_default: bool
    default_prompt: str
    effective_prompt: str  # Итоговый prompt, который реально пойдёт в AI (равен prompt)

class PromptIn(BaseModel):
    # Разрешаем пустую строку (означает сброс). Минимальную длину убираем, чтобы пользователь мог хранить очень короткий prompt.
    prompt: str = Field(min_length=0, max_length=4000, description="Пользовательский системный prompt. Пустая строка -> сброс к стандартному.")

@router.get('/prompt', response_model=PromptOut)
async def get_prompt(session: AsyncSession = Depends(get_db_session), current_user=Depends(get_current_user)):
    q = select(Users.ai_system_prompt).where(Users.id == current_user.id)
    res = await session.execute(q)
    val = res.scalar_one_or_none()
    if val and val.strip():
        return PromptOut(prompt=val, is_default=False, default_prompt=DEFAULT_PROMPT, effective_prompt=val)
    return PromptOut(prompt=DEFAULT_PROMPT, is_default=True, default_prompt=DEFAULT_PROMPT, effective_prompt=DEFAULT_PROMPT)

@router.put('/prompt', response_model=PromptOut)
async def set_prompt(data: PromptIn, session: AsyncSession = Depends(get_db_session), current_user=Depends(get_current_user)):
    text = (data.prompt or '').strip()
    # Пустая строка или точное совпадение с дефолтом => сброс
    if not text or text == DEFAULT_PROMPT:
        stmt = update(Users).where(Users.id == current_user.id).values(ai_system_prompt=None)
        await session.execute(stmt)
        await session.commit()
        return PromptOut(prompt=DEFAULT_PROMPT, is_default=True, default_prompt=DEFAULT_PROMPT, effective_prompt=DEFAULT_PROMPT)

    # Иначе сохраняем кастом
    stmt = update(Users).where(Users.id == current_user.id).values(ai_system_prompt=text)
    await session.execute(stmt)
    await session.commit()
    return PromptOut(prompt=text, is_default=False, default_prompt=DEFAULT_PROMPT, effective_prompt=text)

@router.delete('/prompt', response_model=PromptOut)
async def reset_prompt(session: AsyncSession = Depends(get_db_session), current_user=Depends(get_current_user)):
    stmt = update(Users).where(Users.id == current_user.id).values(ai_system_prompt=None)
    await session.execute(stmt)
    await session.commit()
    return PromptOut(prompt=DEFAULT_PROMPT, is_default=True, default_prompt=DEFAULT_PROMPT, effective_prompt=DEFAULT_PROMPT)
