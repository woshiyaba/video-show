from __future__ import annotations

import logging
import math
from datetime import UTC, datetime, timedelta
from pathlib import PurePath
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
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

    thumbnail_url = cos.sign_download(media.thumbnail_key) if media.thumbnail_key else None
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
        created_at=as_utc(media.created_at),
        updated_at=as_utc(media.updated_at),
    )


def _detail(media: Media, cos: CosService) -> MediaDetail:
    return MediaDetail(
        **_card(media, cos).model_dump(),
        content_url=cos.sign_download(media.object_key),
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
    response.headers["Cache-Control"] = "private, no-store"
    return _safe_cos_call("生成媒体播放地址失败", lambda: _detail(media, cos))


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
    keys = [media.object_key]
    if media.thumbnail_key:
        keys.append(media.thumbnail_key)
    _safe_cos_call("删除 COS 文件失败，请稍后重试", lambda: cos.delete_objects(keys))
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
        except Exception:
            logger.warning("COS health check failed", exc_info=True)
            cos_status = "error"
            cos_cors_status = "error"

    overall = (
        "ok"
        if database_status == "ok"
        and cos_status not in {"not_configured", "error"}
        and cos_cors_status not in {"missing", "incomplete", "error"}
        else "degraded"
    )
    return HealthResponse(
        status=overall,
        database=database_status,
        cos_configured=settings.cos_is_configured,
        cos=cos_status,
        cos_cors=cos_cors_status,
    )
