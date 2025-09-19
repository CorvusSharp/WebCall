import os, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

# Дублируем переменные окружения для Settings, если не заданы
os.environ.setdefault('JWT_SECRET', 'test-jwt-secret')
os.environ.setdefault('REGISTRATION_SECRET', 'test-registration')
os.environ.setdefault('DATABASE_URL', 'sqlite+aiosqlite:///:memory:')
os.environ.setdefault('REDIS_URL', 'redis://localhost:6379/0')
