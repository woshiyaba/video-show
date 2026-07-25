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
from app.config import Settings, get_settings
from app.database import Base, get_db
from app.models import Media


class FakeCosService:
    def __init__(self) -> None:
        self.completed: list[tuple[str, str, list[dict]]] = []
        self.aborted: list[tuple[str, str]] = []
        self.deleted: list[list[str]] = []
        self.fail_delete = False
        self.thumbnail_exists = True
        self.objects: dict[str, bytes] = {}
        self.settings = Settings(_env_file=None)

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
        self.objects[key] = b"source-video"

    def abort_multipart_upload(self, key: str, upload_id: str) -> None:
        self.aborted.append((key, upload_id))

    def object_exists(self, key: str) -> bool:
        if key.startswith("thumbnails/"):
            return self.thumbnail_exists
        return key in self.objects

    def delete_object(self, key: str) -> None:
        self.deleted.append([key])
        self.objects.pop(key, None)

    def delete_objects(self, keys: list[str]) -> None:
        if self.fail_delete:
            raise RuntimeError("COS unavailable")
        self.deleted.append(keys)
        for key in keys:
            self.objects.pop(key, None)

    def sign_download(
        self,
        key: str,
        params: dict[str, str] | None = None,
    ) -> str:
        return f"https://cos.example/{key}?signed=1"

    def read_object(self, key: str) -> bytes:
        return self.objects[key]

    def list_objects(self, prefix: str) -> list[tuple[str, int]]:
        return [
            (key, len(body))
            for key, body in self.objects.items()
            if key.startswith(prefix)
        ]

    def delete_prefix(self, prefix: str) -> None:
        keys = [
            key for key in self.objects
            if key.startswith(prefix)
        ]
        self.delete_objects(keys)

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
    application.dependency_overrides[get_settings] = lambda: fake_cos.settings
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


def test_incomplete_transcoding_config_rejects_video_upload(
    api_client,
) -> None:
    client, _, fake_cos = api_client
    fake_cos.settings.video_transcoding_enabled = True
    fake_cos.settings.cos_workflow_id = "workflow-123"
    fake_cos.settings.transcode_callback_token = (
        "replace-with-a-long-random-secret"
    )

    response = client.post(
        "/video-show/api/uploads/initiate",
        json={
            "title": "待压缩视频",
            "media_type": "video",
            "original_filename": "clip.mp4",
            "mime_type": "video/mp4",
            "size_bytes": 1024,
            "duration_seconds": 20,
            "width": 1920,
            "height": 1080,
        },
    )

    assert response.status_code == 503
    assert "工作流配置不完整" in response.json()["detail"]


def test_transcode_callback_promotes_private_hls_and_deletes_source(
    api_client,
) -> None:
    client, _, fake_cos = api_client
    fake_cos.settings.video_transcoding_enabled = True
    fake_cos.settings.cos_workflow_id = "workflow-123"
    fake_cos.settings.transcode_callback_token = "t" * 40
    fake_cos.settings.cos_bucket = "media-bucket-1250000000"

    initiated = initiate_video(client)
    media_id = initiated["session_id"]
    completed = client.post(
        f"/video-show/api/uploads/{media_id}/complete",
        json={"parts": [{"part_number": 1, "etag": '"etag"'}]},
    )
    assert completed.status_code == 200
    assert completed.json()["media"]["processing_status"] == "processing"
    assert completed.json()["media"]["playback_type"] == "unavailable"

    source_key = fake_cos.completed[0][0]
    prefix = f"media/hls/{media_id}/"
    fake_cos.objects.update(
        {
            f"{prefix}master.m3u8": (
                b"#EXTM3U\n"
                b"#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=0,"
                b"RESOLUTION=1280x720\n"
                b"720/index.m3u8\n"
                b"#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=0,"
                b"RESOLUTION=1920x1080\n"
                b"1080/index.m3u8\n"
            ),
            f"{prefix}720/index.m3u8": b"#EXTM3U\nsegment-0.ts\n",
            f"{prefix}720/segment-0.ts": b"720-segment",
            f"{prefix}1080/index.m3u8": b"#EXTM3U\nsegment-0.ts\n",
            f"{prefix}1080/segment-0.ts": b"1080-segment",
        }
    )
    callback = client.post(
        f"/video-show/api/transcode/callback/{'t' * 40}",
        json={
            "EventName": "WorkflowFinish",
            "WorkflowExecution": {
                "WorkflowId": "workflow-123",
                "BucketId": "media-bucket-1250000000",
                "Object": source_key,
                "State": "Success",
            },
        },
    )
    assert callback.status_code == 200, callback.text
    assert source_key not in fake_cos.objects

    detail = client.get(f"/video-show/api/media/{media_id}")
    assert detail.status_code == 200
    assert detail.json()["processing_status"] == "ready"
    assert detail.json()["playback_type"] == "hls"
    assert detail.json()["content_url"] == (
        f"/video-show/api/media/{media_id}/stream/master.m3u8"
    )
    assert detail.json()["playback_size_bytes"] > 0

    playlist = client.get(
        f"/video-show/api/media/{media_id}/stream/master.m3u8"
    )
    assert playlist.status_code == 200
    assert playlist.headers["content-type"].startswith(
        "application/vnd.apple.mpegurl"
    )
    assert "BANDWIDTH=2628000,RESOLUTION=1280x720" in playlist.text
    assert "BANDWIDTH=5128000,RESOLUTION=1920x1080" in playlist.text
    assert "BANDWIDTH=0" not in playlist.text
    playlist_head = client.head(
        f"/video-show/api/media/{media_id}/stream/master.m3u8"
    )
    assert playlist_head.status_code == 200
    assert playlist_head.content == b""
    assert playlist_head.headers["content-length"] == str(
        len(playlist.content)
    )
    segment = client.get(
        f"/video-show/api/media/{media_id}/stream/720/segment-0.ts",
        follow_redirects=False,
    )
    assert segment.status_code == 307
    assert segment.headers["location"].endswith("?signed=1")
    traversal = client.get(
        f"/video-show/api/media/{media_id}/stream/%2E%2E/secret.ts",
        follow_redirects=False,
    )
    assert traversal.status_code == 404

    apple_headers = {
        "User-Agent": (
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) "
            "AppleWebKit/605.1.15 Mobile/15E148 Version/18.5 Safari/604.1"
        )
    }
    apple_segment = client.get(
        f"/video-show/api/media/{media_id}/stream/720/segment-0.ts",
        headers=apple_headers,
        follow_redirects=False,
    )
    assert apple_segment.status_code == 200
    assert apple_segment.content == b"720-segment"
    assert apple_segment.headers["content-type"].startswith("video/mp2t")
    assert apple_segment.headers["content-disposition"] == "inline"

    apple_range = client.get(
        f"/video-show/api/media/{media_id}/stream/720/segment-0.ts",
        headers={**apple_headers, "Range": "bytes=4-10"},
        follow_redirects=False,
    )
    assert apple_range.status_code == 206
    assert apple_range.content == b"segment"
    assert apple_range.headers["content-range"] == "bytes 4-10/11"

    apple_head = client.head(
        f"/video-show/api/media/{media_id}/stream/720/segment-0.ts",
        headers=apple_headers,
        follow_redirects=False,
    )
    assert apple_head.status_code == 200
    assert apple_head.content == b""
    assert apple_head.headers["content-length"] == "11"

    deleted = client.delete(f"/video-show/api/media/{media_id}")
    assert deleted.status_code == 204
    assert not any(key.startswith(prefix) for key in fake_cos.objects)


def test_transcode_callback_accepts_tencent_generated_master_path(
    api_client,
) -> None:
    client, _, fake_cos = api_client
    fake_cos.settings.video_transcoding_enabled = True
    fake_cos.settings.cos_workflow_id = "workflow-123"
    fake_cos.settings.transcode_callback_token = "u" * 40
    fake_cos.settings.cos_bucket = "media-bucket-1250000000"

    initiated = initiate_video(client)
    media_id = initiated["session_id"]
    completed = client.post(
        f"/video-show/api/uploads/{media_id}/complete",
        json={"parts": [{"part_number": 1, "etag": '"etag"'}]},
    )
    assert completed.status_code == 200

    source_key = fake_cos.completed[0][0]
    source_path = Path(source_key)
    source_prefix = source_key.rsplit("/", 1)[0] + "/"
    run_id = "i1234567890"
    generated_master = (
        f"{source_prefix}{source_path.stem}_{run_id}.m3u8"
    )
    generated_variant = (
        f"{source_prefix}media/hls/{media_id}.m3u8"
    )
    generated_segment = (
        f"{source_prefix}media/hls/{media_id}-00000.ts"
    )
    unrelated = f"{source_prefix}unrelated-video.mp4"
    fake_cos.objects.update(
        {
            generated_master: (
                "#EXTM3U\n"
                "#EXT-X-STREAM-INF:BANDWIDTH=2500000\n"
                f"media/hls/{media_id}.m3u8\n"
            ).encode(),
            generated_variant: (
                "#EXTM3U\n"
                "#EXTINF:4,\n"
                f"{media_id}-00000.ts\n"
                "#EXT-X-ENDLIST\n"
            ).encode(),
            generated_segment: b"segment",
            unrelated: b"must-not-be-deleted",
        }
    )

    callback = client.post(
        f"/video-show/api/transcode/callback/{'u' * 40}",
        json={
            "EventName": "WorkflowFinish",
            "WorkflowExecution": {
                "RunId": run_id,
                "WorkflowId": "workflow-123",
                "BucketId": "media-bucket-1250000000",
                "Object": source_key,
                "State": "Success",
            },
        },
    )
    assert callback.status_code == 200, callback.text
    assert source_key not in fake_cos.objects
    assert unrelated in fake_cos.objects

    detail = client.get(f"/video-show/api/media/{media_id}")
    assert detail.status_code == 200
    assert detail.json()["processing_status"] == "ready"
    assert detail.json()["playback_type"] == "hls"

    master = client.get(
        f"/video-show/api/media/{media_id}/stream/master.m3u8"
    )
    assert master.status_code == 200
    assert f"media/hls/{media_id}.m3u8" in master.text
    variant = client.get(
        f"/video-show/api/media/{media_id}/stream/"
        f"media/hls/{media_id}.m3u8"
    )
    assert variant.status_code == 200
    segment = client.get(
        f"/video-show/api/media/{media_id}/stream/"
        f"media/hls/{media_id}-00000.ts",
        follow_redirects=False,
    )
    assert segment.status_code == 307

    deleted = client.delete(f"/video-show/api/media/{media_id}")
    assert deleted.status_code == 204
    assert generated_master not in fake_cos.objects
    assert generated_variant not in fake_cos.objects
    assert generated_segment not in fake_cos.objects
    assert unrelated in fake_cos.objects


def test_failed_transcode_keeps_source_and_rejects_bad_callback(
    api_client,
) -> None:
    client, _, fake_cos = api_client
    fake_cos.settings.video_transcoding_enabled = True
    fake_cos.settings.cos_workflow_id = "workflow-123"
    fake_cos.settings.transcode_callback_token = "s" * 40
    fake_cos.settings.cos_bucket = "media-bucket-1250000000"

    initiated = initiate_video(client)
    media_id = initiated["session_id"]
    client.post(
        f"/video-show/api/uploads/{media_id}/complete",
        json={"parts": [{"part_number": 1, "etag": '"etag"'}]},
    )
    source_key = fake_cos.completed[0][0]
    payload = {
        "EventName": "WorkflowFinish",
        "WorkflowExecution": {
            "WorkflowId": "workflow-123",
            "BucketId": "media-bucket-1250000000",
            "Object": source_key,
            "State": "Failed",
            "Tasks": [
                {
                    "State": "Failed",
                    "Message": "unsupported codec",
                }
            ],
        },
    }
    assert client.post(
        "/video-show/api/transcode/callback/wrong-token",
        json=payload,
    ).status_code == 404
    callback = client.post(
        f"/video-show/api/transcode/callback/{'s' * 40}",
        json=payload,
    )
    assert callback.status_code == 200
    assert source_key in fake_cos.objects

    detail = client.get(f"/video-show/api/media/{media_id}").json()
    assert detail["processing_status"] == "failed"
    assert detail["content_url"] is None
    assert detail["processing_error"] == "unsupported codec"
