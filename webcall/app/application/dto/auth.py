from __future__ import annotations

from pydantic import BaseModel, EmailStr, Field, model_validator


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


class ChangePasswordInput(BaseModel):
    # Старый пароль может быть короче (исторические учётки могли иметь 5 символов)
    old_password: str = Field(min_length=3, max_length=128)
    new_password: str = Field(min_length=6, max_length=128)

    @model_validator(mode='after')
    def passwords_different(self):  # type: ignore[override]
        if self.old_password == self.new_password:
            raise ValueError('Новый пароль не должен совпадать со старым')
        return self
