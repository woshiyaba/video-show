from pathlib import Path

from sqlalchemy import create_engine, inspect, text

from app.database import ensure_schema


def test_legacy_sqlite_tables_receive_transcoding_columns(
    tmp_path: Path,
) -> None:
    engine = create_engine(f"sqlite:///{tmp_path / 'legacy.db'}")
    with engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE media ("
                "id VARCHAR(36) PRIMARY KEY, "
                "title VARCHAR(120) NOT NULL"
                ")"
            )
        )
        connection.execute(
            text(
                "CREATE TABLE upload_sessions ("
                "id VARCHAR(36) PRIMARY KEY, "
                "status VARCHAR(16) NOT NULL"
                ")"
            )
        )
        connection.execute(
            text(
                "INSERT INTO media (id, title) "
                "VALUES ('legacy', '旧视频')"
            )
        )

    ensure_schema(engine)
    ensure_schema(engine)

    schema = inspect(engine)
    media_columns = {
        column["name"] for column in schema.get_columns("media")
    }
    upload_columns = {
        column["name"]
        for column in schema.get_columns("upload_sessions")
    }
    expected = {
        "hls_master_key",
        "processing_status",
        "processing_error",
        "playback_size_bytes",
        "source_delete_pending",
    }
    assert expected.issubset(media_columns)
    assert expected.issubset(upload_columns)

    with engine.connect() as connection:
        row = connection.execute(
            text(
                "SELECT processing_status, source_delete_pending "
                "FROM media WHERE id = 'legacy'"
            )
        ).one()
    assert row == ("ready", 0)
    engine.dispose()
