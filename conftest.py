import os, sys

def _early_path():
    ROOT = os.path.abspath(os.path.dirname(__file__))
    PKG_ROOT = os.path.join(ROOT, 'webcall')
    if PKG_ROOT not in sys.path:
        sys.path.insert(0, PKG_ROOT)
_early_path()

# Provide minimal required env vars so Settings() doesn't fail in tests
os.environ.setdefault('JWT_SECRET', 'test-jwt-secret')
os.environ.setdefault('REGISTRATION_SECRET', 'test-registration')
os.environ.setdefault('DATABASE_URL', 'sqlite+aiosqlite:///:memory:')
os.environ.setdefault('REDIS_URL', 'redis://localhost:6379/0')

def pytest_configure():  # noqa: D401
    # Re-assert path very early in pytest lifecycle
    _early_path()
