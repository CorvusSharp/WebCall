from __future__ import annotations

"""Шифрование личных сообщений.

Используется симметричный ключ, производный от JWT_SECRET и отсортированной пары user ids.
Алгоритм derivation (простая, но достаточная для прикладного уровня):
  base_key = sha256( JWT_SECRET + '::dm::' + min(user_a,user_b) + '::' + max(user_a,user_b) )
  fernet_key = base_key[:32] -> urlsafe_b64encode

Fernet обеспечивает аутентифицированное шифрование (AES128 + HMAC). Размер шифртекста возрастает.
"""

import hashlib
import base64
from uuid import UUID
from cryptography.fernet import Fernet
from ..config import get_settings


def _derive_key(a: UUID, b: UUID) -> bytes:
    s = get_settings().JWT_SECRET
    a_s, b_s = str(a), str(b)
    if a_s <= b_s:
        ua, ub = a_s, b_s
    else:
        ua, ub = b_s, a_s
    raw = hashlib.sha256((s + '::dm::' + ua + '::' + ub).encode('utf-8')).digest()
    # Берём первые 32 байта (весь digest) и кодируем в base64 для Fernet
    return base64.urlsafe_b64encode(raw)


def encrypt_direct(a: UUID, b: UUID, plaintext: str) -> str:
    key = _derive_key(a, b)
    f = Fernet(key)
    return f.encrypt(plaintext.encode('utf-8')).decode('utf-8')


def decrypt_direct(a: UUID, b: UUID, ciphertext: str) -> str:
    key = _derive_key(a, b)
    f = Fernet(key)
    return f.decrypt(ciphertext.encode('utf-8')).decode('utf-8')
