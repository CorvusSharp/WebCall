from dataclasses import dataclass


class DomainError(Exception):
    """Базовая доменная ошибка."""


class ValidationError(DomainError):
    pass


class AuthError(DomainError):
    pass


class NotFoundError(DomainError):
    pass


class PermissionDenied(DomainError):
    pass


class ConflictError(DomainError):
    pass


@dataclass(slots=True)
class ErrorResponse:
    detail: str
