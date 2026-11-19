"""Database engine for the soc_api role. DATABASE_URL comes from the environment only; it is never logged."""
import os

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine

_engine: Engine | None = None


class DatabaseNotConfigured(RuntimeError):
    pass


def get_engine() -> Engine:
    global _engine
    if _engine is None:
        url = os.environ.get("DATABASE_URL", "").strip()
        if not url:
            raise DatabaseNotConfigured("DATABASE_URL is not set.")
        _engine = create_engine(
            url,
            pool_size=int(os.environ.get("DB_POOL_SIZE", "5")),
            max_overflow=int(os.environ.get("DB_MAX_OVERFLOW", "5")),
            pool_timeout=float(os.environ.get("DB_POOL_TIMEOUT_SECONDS", "10")),
            pool_recycle=int(os.environ.get("DB_POOL_RECYCLE_SECONDS", "1800")),
            pool_pre_ping=True,
        )
    return _engine
