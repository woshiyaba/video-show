from __future__ import annotations

from collections.abc import Generator
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

import app.api as api_module
from app.api import router
from app.database import Base, get_db
from app.models import Media


class FakeCosService:
    def __init__(self) -> None:
        self.completed: list[tuple[str, str, list[dict]]] = []
        self.aborted: list[tuple[str, str]] = []
        self.deleted: list[list[str]] = []
        self.fail_delete = False
        self.thumbnail_exists = True

    def create_multipart_upload(self, key: str, content_type: str) -> str:
        assert key.startswith("media/")
        assert content_type
        return "cos-upload-id"

    def sign_upload_part(
        self, key: str, upload_id: str, part_number: int
    ) -> str:
        return f"https://cos.example/{key}?uploadId={upload_id}&part={part_number}"

    def sign_put_object(self, key: str, content_type: str) -> str:
        return f"https://cos.example/{key}?put=1&type={content_type}"

    def complete_multipart_upload(
        self, key: str, upload_id: str, parts: list[dict]
    ) -> None:
        self.completed.append((key, upload_id, parts))

    def abort_multipart_upload(self, key: str, upload_id: str) -> None:
        self.aborted.append((key, upload_id))

    def object_exists(self, key: str) -> bool:
        return self.thumbnail_exists

    def delete_object(self, key: str) -> None:
        self.deleted.append([key])

    def delete_objects(self, keys: list[str]) -> None:
        if self.fail_delete:
            raise RuntimeError("COS unavailable")
        self.deleted.append(keys)

    def sign_download(self, key: str) -> str:
        return f"https://cos.example/{key}?signed=1"

    def check_bucket(self) -> None:
        return None

    def check_cors(self) -> str:
        return "ok"


@pytest.fixture
def api_client(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Generator[tuple[TestClient, sessionmaker[Session], FakeCosService], None, None]:
    database_path = tmp_path / "test.db"
    engine = create_engine(
        f"sqlite:///{database_path}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(engine)
    testing_session = sessionmaker(bind=engine, expire_on_commit=False)
    fake_cos = FakeCosService()

    def override_db() -> Generator[Session, None, None]:
        with testing_session() as session:
            yield session

    monkeypatch.setattr(api_module, "get_cos_service", lambda: fake_cos)
    application = FastAPI()
    application.include_router(router)
    application.dependency_overrides[get_db] = override_db
    with TestClient(application) as client:
        yield client, testing_session, fake_cos
    engine.dispose()


def initiate_video(client: TestClient) -> dict:
    response = client.post(
        "/video-show/api/uploads/initiate",
        json={
            "title": "  夏日海边  ",
            "media_type": "video",
            "original_filename": "beach.mp4",
            "mime_type": "video/mp4",
            "size_bytes": 1024,
            "duration_seconds": 32.5,
            "width": 1920,
            "height": 1080,
            "thumbnail_mime_type": "image/webp",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_full_upload_list_rename_and_delete(api_client) -> None:
    client, testing_session, fake_cos = api_client
    initiated = initiate_video(client)
    session_id = initiated["session_id"]
    assert initiated["total_parts"] == 1
    assert initiated["thumbnail_upload"]["headers"] == {
        "Content-Type": "image/webp"
    }

    signed = client.post(
        f"/video-show/api/uploads/{session_id}/parts/sign",
        json={"part_numbers": [1]},
    )
    assert signed.status_code == 200
    assert signed.json()["parts"][0]["part_number"] == 1

    completed = client.post(
        f"/video-show/api/uploads/{session_id}/complete",
        json={"parts": [{"part_number": 1, "etag": '"etag-1"'}]},
    )
    assert completed.status_code == 200, completed.text
    assert completed.json()["media"]["title"] == "夏日海边"
    assert len(fake_cos.completed) == 1

    listing = client.get("/video-show/api/media?type=video&q=海边")
    assert listing.status_code == 200
    assert listing.headers["cache-control"] == "private, no-store"
    assert listing.json()["total"] == 1
    assert listing.json()["items"][0]["thumbnail_url"].startswith(
        "https://cos.example/"
    )

    detail = client.get(f"/video-show/api/media/{session_id}")
    assert detail.status_code == 200
    assert detail.json()["content_url"].endswith("?signed=1")

    renamed = client.patch(
        f"/video-show/api/media/{session_id}",
        json={"title": "新的名字"},
    )
    assert renamed.status_code == 200
    assert renamed.json()["title"] == "新的名字"

    deleted = client.delete(f"/video-show/api/media/{session_id}")
    assert deleted.status_code == 204
    assert len(fake_cos.deleted[-1]) == 2
    with testing_session() as db:
        assert db.get(Media, session_id) is None


def test_complete_rejects_missing_parts(api_client) -> None:
    client, _, fake_cos = api_client
    initiated = initiate_video(client)
    response = client.post(
        f"/video-show/api/uploads/{initiated['session_id']}/complete",
        json={"parts": [{"part_number": 2, "etag": '"wrong"'}]},
    )
    assert response.status_code == 422
    assert not fake_cos.completed


def test_complete_requires_uploaded_thumbnail(api_client) -> None:
    client, _, fake_cos = api_client
    initiated = initiate_video(client)
    fake_cos.thumbnail_exists = False
    response = client.post(
        f"/video-show/api/uploads/{initiated['session_id']}/complete",
        json={"parts": [{"part_number": 1, "etag": '"etag"'}]},
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "缩略图尚未上传完成"


def test_delete_failure_preserves_database_record(api_client) -> None:
    client, testing_session, fake_cos = api_client
    initiated = initiate_video(client)
    media_id = initiated["session_id"]
    complete = client.post(
        f"/video-show/api/uploads/{media_id}/complete",
        json={"parts": [{"part_number": 1, "etag": '"etag"'}]},
    )
    assert complete.status_code == 200

    fake_cos.fail_delete = True
    response = client.delete(f"/video-show/api/media/{media_id}")
    assert response.status_code == 502
    with testing_session() as db:
        assert db.get(Media, media_id) is not None


def test_validation_and_abort(api_client) -> None:
    client, _, fake_cos = api_client
    invalid = client.post(
        "/video-show/api/uploads/initiate",
        json={
            "title": "压缩包",
            "media_type": "photo",
            "original_filename": "archive.zip",
            "mime_type": "application/zip",
            "size_bytes": 100,
            "width": 10,
            "height": 10,
        },
    )
    assert invalid.status_code == 422

    initiated = initiate_video(client)
    response = client.delete(
        f"/video-show/api/uploads/{initiated['session_id']}"
    )
    assert response.status_code == 204
    assert fake_cos.aborted


def test_old_unprefixed_api_is_not_exposed(api_client) -> None:
    client, _, _ = api_client
    assert client.get("/api/media").status_code == 404
