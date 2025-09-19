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

# Backwards compatibility alias after refactor (DeleteRoom use case expects ForbiddenError)
class ForbiddenError(PermissionDenied):
    pass


class ConflictError(DomainError):
    pass


@dataclass(slots=True)
class ErrorResponse:
    detail: str
