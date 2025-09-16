import pytest
from uuid import uuid4

from app.infrastructure.services.direct_crypto import encrypt_direct, decrypt_direct


def test_encrypt_decrypt_roundtrip():
    a = uuid4()
    b = uuid4()
    text = "Hello, secret"
    ct = encrypt_direct(a, b, text)
    assert ct != text
    pt = decrypt_direct(a, b, ct)
    assert pt == text


def test_decrypt_with_wrong_pair_fails():
    a = uuid4()
    b = uuid4()
    c = uuid4()
    text = "Another secret"
    ct = encrypt_direct(a, b, text)
    # decrypt with a different participant (c) should raise
    with pytest.raises(Exception):
        _ = decrypt_direct(a, c, ct)
