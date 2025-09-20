from __future__ import annotations

from pydantic import BaseModel, EmailStr, Field, field_validator


class RegisterInput(BaseModel):
    email: EmailStr
    username: str = Field(min_length=3, max_length=50)
    password: str = Field(min_length=6, max_length=128)
    secret: str = Field(min_length=1, description="Registration secret")


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


class UpdateProfileInput(BaseModel):
    email: EmailStr | None = None
    username: str | None = Field(default=None, min_length=3, max_length=50)

    @field_validator('email', 'username')
    @classmethod
    def at_least_one(cls, v, values, field):  # type: ignore[override]
        # Pydantic v2 style: we can't check other fields easily here; will enforce in endpoint.
        return v


class ChangePasswordInput(BaseModel):
    old_password: str = Field(min_length=6, max_length=128)
    new_password: str = Field(min_length=6, max_length=128)

    @field_validator('new_password')
    @classmethod
    def passwords_different(cls, v, values):  # type: ignore[override]
        old = values.get('old_password')
        if old and old == v:
            raise ValueError('Новый пароль не должен совпадать со старым')
        return v
