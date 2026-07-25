from __future__ import annotations

from collections.abc import Generator
from pathlib import Path

from sqlalchemy import Engine, create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings


class Base(DeclarativeBase):
    pass


def _ensure_sqlite_directory(database_url: str) -> None:
    prefix = "sqlite:///"
    if not database_url.startswith(prefix):
        return
    raw_path = database_url.removeprefix(prefix)
    if raw_path == ":memory:":
        return
    Path(raw_path).expanduser().parent.mkdir(parents=True, exist_ok=True)


settings = get_settings()
_ensure_sqlite_directory(settings.database_url)

connect_args = (
    {"check_same_thread": False}
    if settings.database_url.startswith("sqlite")
    else {}
)
engine = create_engine(settings.database_url, connect_args=connect_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


SQLITE_COLUMN_MIGRATIONS: dict[str, dict[str, str]] = {
    "media": {
        "hls_master_key": "TEXT",
        "processing_status": "VARCHAR(16) NOT NULL DEFAULT 'ready'",
        "processing_error": "TEXT",
        "playback_size_bytes": "INTEGER",
        "source_delete_pending": "BOOLEAN NOT NULL DEFAULT 0",
    },
    "upload_sessions": {
        "hls_master_key": "TEXT",
        "processing_status": "VARCHAR(16) NOT NULL DEFAULT 'ready'",
        "processing_error": "TEXT",
        "playback_size_bytes": "INTEGER",
        "source_delete_pending": "BOOLEAN NOT NULL DEFAULT 0",
    },
}


def ensure_schema(current_engine: Engine) -> None:
    """Add defaulted columns without disturbing existing SQLite media rows."""
    if current_engine.dialect.name != "sqlite":
        return

    schema = inspect(current_engine)
    with current_engine.begin() as connection:
        for table_name, additions in SQLITE_COLUMN_MIGRATIONS.items():
            if not schema.has_table(table_name):
                continue
            existing = {
                column["name"]
                for column in schema.get_columns(table_name)
            }
            for column_name, definition in additions.items():
                if column_name in existing:
                    continue
                connection.execute(
                    text(
                        f'ALTER TABLE "{table_name}" '
                        f'ADD COLUMN "{column_name}" {definition}'
                    )
                )


def get_db() -> Generator[Session, None, None]:
    with SessionLocal() as session:
        yield session
