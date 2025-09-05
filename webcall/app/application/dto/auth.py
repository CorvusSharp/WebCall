from __future__ import annotations

from pydantic import BaseModel, EmailStr, Field


class RegisterInput(BaseModel):
    email: EmailStr
    username: str = Field(min_length=3, max_length=50)
    password: str = Field(min_length=6, max_length=128)
    secret: str | None = Field(default=None, description="Registration secret if required")


class RegisterOutput(BaseModel):
    id: str
    email: EmailStr
    username: str


class LoginInput(BaseModel):
    email: EmailStr
    password: str


class TokenOutput(BaseModel):
    access_token: str
    token_type: str = "bearer"
