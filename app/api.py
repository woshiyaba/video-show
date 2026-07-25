from __future__ import annotations

import hmac
import logging
import math
from datetime import UTC, datetime, timedelta
from pathlib import PurePath, PurePosixPath
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from fastapi.responses import RedirectResponse
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.config import APP_PREFIX, Settings, get_settings
from app.cos_service import CosNotConfiguredError, CosService, get_cos_service
from app.database import get_db
from app.models import Media, UploadSession, utc_now
from app.schemas import (
    HealthResponse,
    MediaCard,
    MediaDetail,
    MediaListResponse,
    MediaType,
    MediaUpdate,
    PartSignRequest,
    PartSignResponse,
    PresignedUpload,
    SignedPart,
    UploadCompleteRequest,
    UploadCompleteResponse,
    UploadInitiateRequest,
    UploadInitiateResponse,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix=f"{APP_PREFIX}/api")

MIME_EXTENSIONS = {
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/ogg": ".ogv",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/avif": ".avif",
}
HLS_CONTENT_TYPES = {
    ".m3u8": "application/vnd.apple.mpegurl",
    ".ts": "video/mp2t",
}


def _cos_or_503() -> CosService:
    try:
        return get_cos_service()
    except CosNotConfiguredError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


def _safe_cos_call(message: str, callback):
    try:
        return callback()
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("%s", message)
        raise HTTPException(status_code=502, detail=message) from exc


def _card(media: Media, cos: CosService) -> MediaCard:
    def as_utc(value: datetime) -> datetime:
        return value.replace(tzinfo=UTC) if value.tzinfo is None else value

    thumbnail_url = (
        cos.sign_download(media.thumbnail_key)
        if media.thumbnail_key
        else None
    )
    if media.processing_status == "ready":
        playback_type = "hls" if media.hls_master_key else "direct"
    else:
        playback_type = "unavailable"
    return MediaCard(
        id=media.id,
        media_type=media.media_type,
        title=media.title,
        original_filename=media.original_filename,
        thumbnail_url=thumbnail_url,
        mime_type=media.mime_type,
        size_bytes=media.size_bytes,
        duration_seconds=media.duration_seconds,
        width=media.width,
        height=media.height,
        processing_status=media.processing_status,
        playback_type=playback_type,
        processing_error=media.processing_error,
        playback_size_bytes=media.playback_size_bytes,
        created_at=as_utc(media.created_at),
        updated_at=as_utc(media.updated_at),
    )


def _detail(media: Media, cos: CosService) -> MediaDetail:
    content_url: str | None = None
    if media.processing_status == "ready":
        content_url = (
            f"{APP_PREFIX}/api/media/{media.id}/stream/master.m3u8"
            if media.hls_master_key
            else cos.sign_download(media.object_key)
        )
    return MediaDetail(
        **_card(media, cos).model_dump(),
        content_url=content_url,
    )


def _hls_master_key(media_id: str) -> str:
    return f"media/hls/{media_id}/master.m3u8"


def _hls_prefix(master_key: str) -> str:
    return master_key.rsplit("/", 1)[0] + "/"


def _valid_hls_output(
    master_key: str,
    objects: list[tuple[str, int]],
) -> bool:
    keys = {key for key, _ in objects}
    return master_key in keys and any(key.endswith(".ts") for key in keys)


def _apply_processing_result(
    target: Media | UploadSession,
    *,
    processing_status: str,
    processing_error: str | None,
    playback_size_bytes: int | None = None,
    source_delete_pending: bool | None = None,
) -> None:
    target.processing_status = processing_status
    target.processing_error = processing_error
    target.playback_size_bytes = playback_size_bytes
    if source_delete_pending is not None:
        target.source_delete_pending = source_delete_pending


def _delete_source_after_commit(
    db: Session,
    cos: CosService,
    source_key: str,
    targets: list[Media | UploadSession],
) -> None:
    try:
        cos.delete_object(source_key)
    except Exception:
        logger.warning(
            "Unable to remove transcoded source object %s",
            source_key,
            exc_info=True,
        )
        return

    for target in targets:
        target.source_delete_pending = False
    db.commit()


def _promote_hls_output(
    db: Session,
    cos: CosService,
    source_key: str,
    targets: list[Media | UploadSession],
    master_key: str,
) -> bool:
    objects = cos.list_objects(_hls_prefix(master_key))
    if not _valid_hls_output(master_key, objects):
        return False

    playback_size = sum(size for _, size in objects)
    for target in targets:
        target.hls_master_key = master_key
        _apply_processing_result(
            target,
            processing_status="ready",
            processing_error=None,
            playback_size_bytes=playback_size,
            source_delete_pending=True,
        )
    db.commit()
    _delete_source_after_commit(db, cos, source_key, targets)
    return True


def _reconcile_media(
    db: Session,
    cos: CosService,
    media: Media,
) -> None:
    if media.processing_status != "processing" or not media.hls_master_key:
        return
    try:
        if not cos.object_exists(media.hls_master_key):
            return
        upload = db.get(UploadSession, media.id)
        targets: list[Media | UploadSession] = [media]
        if upload is not None:
            targets.append(upload)
        _promote_hls_output(
            db,
            cos,
            media.object_key,
            targets,
            media.hls_master_key,
        )
    except Exception:
        logger.warning(
            "Unable to reconcile HLS output for media %s",
            media.id,
            exc_info=True,
        )


def _cleanup_pending_sources(db: Session, cos: CosService) -> None:
    pending_media = db.scalars(
        select(Media).where(Media.source_delete_pending.is_(True))
    ).all()
    for media in pending_media:
        upload = db.get(UploadSession, media.id)
        targets: list[Media | UploadSession] = [media]
        if upload is not None:
            targets.append(upload)
        _delete_source_after_commit(
            db,
            cos,
            media.object_key,
            targets,
        )


def _get_media_or_404(db: Session, media_id: str) -> Media:
    media = db.get(Media, media_id)
    if media is None:
        raise HTTPException(status_code=404, detail="媒体不存在")
    return media


def _get_session_or_404(db: Session, session_id: str) -> UploadSession:
    upload = db.get(UploadSession, session_id)
    if upload is None:
        raise HTTPException(status_code=404, detail="上传任务不存在")
    return upload


def _cleanup_expired_uploads(db: Session, cos: CosService) -> None:
    expired = db.scalars(
        select(UploadSession).where(
            UploadSession.status == "pending",
            UploadSession.expires_at < utc_now(),
        )
    ).all()
    changed = False
    for upload in expired:
        try:
            cos.abort_multipart_upload(upload.object_key, upload.upload_id)
            if upload.thumbnail_key:
                cos.delete_object(upload.thumbnail_key)
            upload.status = "expired"
            changed = True
        except Exception:
            logger.warning(
                "Unable to clean expired upload session %s",
                upload.id,
                exc_info=True,
            )
    if changed:
        db.commit()


def _callback_execution(payload: dict[str, Any]) -> dict[str, Any]:
    root = payload.get("Response", payload)
    execution = root.get("WorkflowExecution")
    return execution if isinstance(execution, dict) else {}


def _callback_error(execution: dict[str, Any]) -> str:
    tasks = execution.get("Tasks", [])
    if isinstance(tasks, dict):
        tasks = [tasks]
    if isinstance(tasks, list):
        for task in tasks:
            if not isinstance(task, dict):
                continue
            if str(task.get("State", "")).lower() not in {
                "failed",
                "fail",
            }:
                continue
            for key in ("Message", "ErrorMessage", "Code"):
                value = task.get(key)
                if value:
                    return str(value)[:1000]
    return "腾讯云视频压缩任务失败，请在数据万象控制台查看详情。"


@router.post(
    "/transcode/callback/{callback_token}",
    include_in_schema=False,
)
def transcode_callback(
    callback_token: str,
    payload: dict[str, Any],
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, bool]:
    expected_token = settings.transcode_callback_token
    if (
        not settings.video_transcoding_is_configured
        or not hmac.compare_digest(callback_token, expected_token)
    ):
        raise HTTPException(status_code=404, detail="接口不存在")

    root = payload.get("Response", payload)
    event_name = str(root.get("EventName", ""))
    if event_name and event_name != "WorkflowFinish":
        return {"ok": True}

    execution = _callback_execution(payload)
    if not execution:
        raise HTTPException(status_code=422, detail="工作流回调内容无效")
    if str(execution.get("WorkflowId", "")) != settings.cos_workflow_id:
        raise HTTPException(status_code=403, detail="工作流不匹配")
    if str(execution.get("BucketId", "")) != settings.cos_bucket:
        raise HTTPException(status_code=403, detail="存储桶不匹配")

    source_key = str(execution.get("Object", "")).lstrip("/")
    upload = db.scalar(
        select(UploadSession).where(UploadSession.object_key == source_key)
    )
    media = db.scalar(select(Media).where(Media.object_key == source_key))
    if upload is None and media is None:
        raise HTTPException(status_code=404, detail="上传记录不存在")

    record_id = media.id if media is not None else upload.id
    master_key = _hls_master_key(record_id)
    cos = _cos_or_503()

    if upload is not None and upload.status in {"deleting", "deleted"}:
        _safe_cos_call(
            "清理已删除媒体的转码输出失败",
            lambda: cos.delete_prefix(_hls_prefix(master_key)),
        )
        return {"ok": True}

    targets: list[Media | UploadSession] = []
    if media is not None:
        targets.append(media)
    if upload is not None:
        targets.append(upload)

    workflow_state = str(execution.get("State", "")).lower()
    if workflow_state != "success":
        error = _callback_error(execution)
        for target in targets:
            _apply_processing_result(
                target,
                processing_status="failed",
                processing_error=error,
            )
        db.commit()
        return {"ok": True}

    if not _safe_cos_call(
        "检查 HLS 主播放列表失败",
        lambda: cos.object_exists(master_key),
    ):
        raise HTTPException(status_code=409, detail="HLS 输出尚未就绪")
    promoted = _safe_cos_call(
        "验证 HLS 转码输出失败",
        lambda: _promote_hls_output(
            db,
            cos,
            source_key,
            targets,
            master_key,
        ),
    )
    if not promoted:
        raise HTTPException(status_code=409, detail="HLS 输出不完整")
    return {"ok": True}


@router.get("/media", response_model=MediaListResponse)
def list_media(
    response: Response,
    media_type: MediaType | None = Query(default=None, alias="type"),
    q: str | None = Query(default=None, max_length=100),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=24, ge=1, le=100),
    db: Session = Depends(get_db),
) -> MediaListResponse:
    cos = _cos_or_503()
    filters = []
    if media_type is not None:
        filters.append(Media.media_type == media_type.value)
    if q and q.strip():
        filters.append(func.lower(Media.title).contains(q.strip().lower()))

    total = db.scalar(select(func.count(Media.id)).where(*filters)) or 0
    items = db.scalars(
        select(Media)
        .where(*filters)
        .order_by(Media.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    response.headers["Cache-Control"] = "private, no-store"
    cards = _safe_cos_call(
        "生成媒体缩略图地址失败",
        lambda: [_card(item, cos) for item in items],
    )
    return MediaListResponse(
        items=cards,
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/media/{media_id}", response_model=MediaDetail)
def get_media(
    media_id: str,
    response: Response,
    db: Session = Depends(get_db),
) -> MediaDetail:
    media = _get_media_or_404(db, media_id)
    cos = _cos_or_503()
    _reconcile_media(db, cos, media)
    response.headers["Cache-Control"] = "private, no-store"
    return _safe_cos_call("生成媒体播放地址失败", lambda: _detail(media, cos))


@router.get("/media/{media_id}/stream/{asset_path:path}")
def stream_hls_asset(
    media_id: str,
    asset_path: str,
    db: Session = Depends(get_db),
) -> Response:
    media = _get_media_or_404(db, media_id)
    if media.processing_status != "ready" or not media.hls_master_key:
        raise HTTPException(status_code=409, detail="视频尚未完成压缩")

    path = PurePosixPath(asset_path)
    if (
        not asset_path
        or asset_path.startswith("/")
        or "\\" in asset_path
        or ".." in path.parts
        or path.suffix.lower() not in HLS_CONTENT_TYPES
    ):
        raise HTTPException(status_code=404, detail="播放资源不存在")

    prefix = _hls_prefix(media.hls_master_key)
    object_key = prefix + path.as_posix()
    cos = _cos_or_503()
    if path.suffix.lower() == ".m3u8":
        content = _safe_cos_call(
            "读取 HLS 播放列表失败",
            lambda: cos.read_object(object_key),
        )
        return Response(
            content=content,
            media_type=HLS_CONTENT_TYPES[".m3u8"],
            headers={"Cache-Control": "private, no-store"},
        )

    url = _safe_cos_call(
        "生成 HLS 分片地址失败",
        lambda: cos.sign_download(object_key),
    )
    return RedirectResponse(
        url=url,
        status_code=status.HTTP_307_TEMPORARY_REDIRECT,
        headers={"Cache-Control": "private, no-store"},
    )


@router.patch("/media/{media_id}", response_model=MediaCard)
def update_media(
    media_id: str,
    payload: MediaUpdate,
    db: Session = Depends(get_db),
) -> MediaCard:
    media = _get_media_or_404(db, media_id)
    media.title = payload.title
    media.updated_at = utc_now()
    db.commit()
    db.refresh(media)
    cos = _cos_or_503()
    return _safe_cos_call("生成媒体缩略图地址失败", lambda: _card(media, cos))


@router.delete("/media/{media_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_media(media_id: str, db: Session = Depends(get_db)) -> Response:
    media = _get_media_or_404(db, media_id)
    cos = _cos_or_503()
    upload = db.get(UploadSession, media.id)
    previous_upload_status = upload.status if upload is not None else None
    if upload is not None:
        upload.status = "deleting"
        db.commit()

    keys = [media.object_key]
    if media.thumbnail_key:
        keys.append(media.thumbnail_key)
    try:
        _safe_cos_call(
            "删除 COS 文件失败，请稍后重试",
            lambda: cos.delete_objects(list(dict.fromkeys(keys))),
        )
        if media.hls_master_key:
            _safe_cos_call(
                "删除 HLS 播放文件失败，请稍后重试",
                lambda: cos.delete_prefix(
                    _hls_prefix(media.hls_master_key)
                ),
            )
    except HTTPException:
        if upload is not None and previous_upload_status is not None:
            upload.status = previous_upload_status
            db.commit()
        raise

    if upload is not None:
        upload.status = "deleted"
    db.delete(media)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/uploads/initiate",
    response_model=UploadInitiateResponse,
    status_code=status.HTTP_201_CREATED,
)
def initiate_upload(
    payload: UploadInitiateRequest,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> UploadInitiateResponse:
    if payload.size_bytes > settings.max_upload_size_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"文件不能超过 {settings.max_upload_size_gb} GiB",
        )
    if (
        payload.media_type is MediaType.VIDEO
        and settings.video_transcoding_enabled
        and not settings.video_transcoding_is_configured
    ):
        raise HTTPException(
            status_code=503,
            detail=(
                "视频压缩已开启但工作流配置不完整，请检查 "
                "COS_WORKFLOW_ID 和 TRANSCODE_CALLBACK_TOKEN"
            ),
        )

    cos = _cos_or_503()
    _cleanup_expired_uploads(db, cos)

    session_id = str(uuid4())
    extension = MIME_EXTENSIONS[payload.mime_type]
    now = utc_now()
    folder = "videos" if payload.media_type is MediaType.VIDEO else "photos"
    object_key = f"media/{folder}/{now:%Y/%m}/{session_id}{extension}"
    thumbnail_key = (
        f"thumbnails/{now:%Y/%m}/{session_id}.webp"
        if payload.thumbnail_mime_type
        else None
    )
    if payload.thumbnail_mime_type == "image/jpeg":
        thumbnail_key = f"thumbnails/{now:%Y/%m}/{session_id}.jpg"

    part_size = settings.upload_part_size_bytes
    total_parts = math.ceil(payload.size_bytes / part_size)
    if total_parts > 10000:
        raise HTTPException(
            status_code=413,
            detail="文件分块数量超过 COS 上限，请增大 UPLOAD_PART_SIZE_MB",
        )

    upload_id = _safe_cos_call(
        "创建 COS 分块上传失败",
        lambda: cos.create_multipart_upload(object_key, payload.mime_type),
    )
    expires_at = now + timedelta(hours=settings.upload_session_hours)
    upload = UploadSession(
        id=session_id,
        upload_id=upload_id,
        object_key=object_key,
        thumbnail_key=thumbnail_key,
        thumbnail_mime_type=payload.thumbnail_mime_type,
        media_type=payload.media_type.value,
        title=payload.title,
        original_filename=PurePath(payload.original_filename).name[:255],
        mime_type=payload.mime_type,
        size_bytes=payload.size_bytes,
        duration_seconds=payload.duration_seconds,
        width=payload.width,
        height=payload.height,
        hls_master_key=(
            _hls_master_key(session_id)
            if payload.media_type is MediaType.VIDEO
            and settings.video_transcoding_is_configured
            else None
        ),
        processing_status=(
            "processing"
            if payload.media_type is MediaType.VIDEO
            and settings.video_transcoding_is_configured
            else "ready"
        ),
        part_size_bytes=part_size,
        total_parts=total_parts,
        expires_at=expires_at,
    )
    try:
        db.add(upload)
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        try:
            cos.abort_multipart_upload(object_key, upload_id)
        except Exception:
            logger.warning("Failed to roll back COS upload", exc_info=True)
        raise HTTPException(status_code=500, detail="保存上传任务失败") from exc

    thumbnail_upload = None
    if thumbnail_key and payload.thumbnail_mime_type:
        thumbnail_url = _safe_cos_call(
            "生成缩略图上传地址失败",
            lambda: cos.sign_put_object(thumbnail_key, payload.thumbnail_mime_type),
        )
        thumbnail_upload = PresignedUpload(
            url=thumbnail_url,
            headers={"Content-Type": payload.thumbnail_mime_type},
        )

    return UploadInitiateResponse(
        session_id=session_id,
        part_size_bytes=part_size,
        total_parts=total_parts,
        expires_at=expires_at,
        thumbnail_upload=thumbnail_upload,
    )


@router.post(
    "/uploads/{session_id}/parts/sign",
    response_model=PartSignResponse,
)
def sign_upload_parts(
    session_id: str,
    payload: PartSignRequest,
    db: Session = Depends(get_db),
) -> PartSignResponse:
    upload = _get_session_or_404(db, session_id)
    if upload.status != "pending":
        raise HTTPException(status_code=409, detail="上传任务已经结束")
    if upload.expires_at < utc_now():
        raise HTTPException(status_code=410, detail="上传任务已过期")
    if any(number < 1 or number > upload.total_parts for number in payload.part_numbers):
        raise HTTPException(status_code=422, detail="分块编号超出范围")

    cos = _cos_or_503()
    parts = _safe_cos_call(
        "生成分块上传地址失败",
        lambda: [
            SignedPart(
                part_number=number,
                url=cos.sign_upload_part(
                    upload.object_key,
                    upload.upload_id,
                    number,
                ),
            )
            for number in payload.part_numbers
        ],
    )
    return PartSignResponse(parts=parts)


@router.post(
    "/uploads/{session_id}/complete",
    response_model=UploadCompleteResponse,
)
def complete_upload(
    session_id: str,
    payload: UploadCompleteRequest,
    db: Session = Depends(get_db),
) -> UploadCompleteResponse:
    upload = _get_session_or_404(db, session_id)
    cos = _cos_or_503()

    if upload.status == "completed" and upload.media_id:
        media = _get_media_or_404(db, upload.media_id)
        return UploadCompleteResponse(media=_card(media, cos))
    if upload.status != "pending":
        raise HTTPException(status_code=409, detail="上传任务已经结束")

    ordered_parts = sorted(payload.parts, key=lambda part: part.part_number)
    expected_numbers = list(range(1, upload.total_parts + 1))
    if [part.part_number for part in ordered_parts] != expected_numbers:
        raise HTTPException(status_code=422, detail="上传分块不完整或编号重复")

    if upload.thumbnail_key and not _safe_cos_call(
        "检查缩略图失败",
        lambda: cos.object_exists(upload.thumbnail_key),
    ):
        raise HTTPException(status_code=422, detail="缩略图尚未上传完成")

    cos_parts = [
        {"PartNumber": part.part_number, "ETag": part.etag}
        for part in ordered_parts
    ]
    _safe_cos_call(
        "COS 合并分块失败",
        lambda: cos.complete_multipart_upload(
            upload.object_key,
            upload.upload_id,
            cos_parts,
        ),
    )

    media = Media(
        id=upload.id,
        media_type=upload.media_type,
        title=upload.title,
        original_filename=upload.original_filename,
        object_key=upload.object_key,
        thumbnail_key=upload.thumbnail_key,
        mime_type=upload.mime_type,
        size_bytes=upload.size_bytes,
        duration_seconds=upload.duration_seconds,
        width=upload.width,
        height=upload.height,
        hls_master_key=upload.hls_master_key,
        processing_status=upload.processing_status,
        processing_error=upload.processing_error,
        playback_size_bytes=upload.playback_size_bytes,
        source_delete_pending=upload.source_delete_pending,
    )
    upload.status = "completed"
    upload.media_id = media.id
    try:
        db.add(media)
        db.commit()
        db.refresh(media)
    except SQLAlchemyError as exc:
        db.rollback()
        try:
            keys = [upload.object_key]
            if upload.thumbnail_key:
                keys.append(upload.thumbnail_key)
            cos.delete_objects(keys)
        except Exception:
            logger.error("Failed to remove orphaned COS objects", exc_info=True)
        raise HTTPException(status_code=500, detail="保存媒体记录失败") from exc

    return UploadCompleteResponse(media=_card(media, cos))


@router.delete(
    "/uploads/{session_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def abort_upload(session_id: str, db: Session = Depends(get_db)) -> Response:
    upload = _get_session_or_404(db, session_id)
    if upload.status == "completed":
        raise HTTPException(status_code=409, detail="已完成的上传不能取消")
    if upload.status in {"aborted", "expired"}:
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    cos = _cos_or_503()
    _safe_cos_call(
        "取消 COS 分块上传失败",
        lambda: cos.abort_multipart_upload(upload.object_key, upload.upload_id),
    )
    if upload.thumbnail_key:
        _safe_cos_call(
            "清理缩略图失败",
            lambda: cos.delete_object(upload.thumbnail_key),
        )
    upload.status = "aborted"
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/health", response_model=HealthResponse)
def health(
    deep: bool = False,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> HealthResponse:
    database_status = "ok"
    try:
        db.execute(select(1))
    except Exception:
        database_status = "error"

    cos_status = "not_checked"
    cos_cors_status = "not_checked"
    if not settings.cos_is_configured:
        cos_status = "not_configured"
        cos_cors_status = "not_configured"
    elif deep:
        try:
            cos_service = get_cos_service()
            cos_service.check_bucket()
            cos_status = "ok"
            cos_cors_status = cos_service.check_cors()
            _cleanup_pending_sources(db, cos_service)
        except Exception:
            logger.warning("COS health check failed", exc_info=True)
            cos_status = "error"
            cos_cors_status = "error"

    if not settings.video_transcoding_enabled:
        video_transcoding = "disabled"
    elif settings.video_transcoding_is_configured:
        video_transcoding = "ok"
    else:
        video_transcoding = "incomplete"

    overall = (
        "ok"
        if database_status == "ok"
        and cos_status not in {"not_configured", "error"}
        and cos_cors_status not in {"missing", "incomplete", "error"}
        and video_transcoding != "incomplete"
        else "degraded"
    )
    return HealthResponse(
        status=overall,
        database=database_status,
        cos_configured=settings.cos_is_configured,
        cos=cos_status,
        cos_cors=cos_cors_status,
        video_transcoding_enabled=settings.video_transcoding_enabled,
        video_transcoding=video_transcoding,
    )
