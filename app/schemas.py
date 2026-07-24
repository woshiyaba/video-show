from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class MediaType(StrEnum):
    VIDEO = "video"
    PHOTO = "photo"


SUPPORTED_MIME_TYPES: dict[MediaType, set[str]] = {
    MediaType.VIDEO: {"video/mp4", "video/webm", "video/ogg"},
    MediaType.PHOTO: {
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/gif",
        "image/avif",
    },
}


class MediaCard(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    media_type: MediaType
    title: str
    original_filename: str
    thumbnail_url: str | None
    mime_type: str
    size_bytes: int
    duration_seconds: float | None
    width: int | None
    height: int | None
    created_at: datetime
    updated_at: datetime


class MediaDetail(MediaCard):
    content_url: str


class MediaListResponse(BaseModel):
    items: list[MediaCard]
    total: int
    page: int
    page_size: int


class MediaUpdate(BaseModel):
    title: str = Field(min_length=1, max_length=120)

    @field_validator("title")
    @classmethod
    def normalize_title(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("名称不能为空")
        return normalized


class UploadInitiateRequest(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    media_type: MediaType
    original_filename: str = Field(min_length=1, max_length=255)
    mime_type: str = Field(min_length=1, max_length=100)
    size_bytes: int = Field(gt=0)
    duration_seconds: float | None = Field(default=None, ge=0)
    width: int | None = Field(default=None, ge=1)
    height: int | None = Field(default=None, ge=1)
    thumbnail_mime_type: str | None = None

    @field_validator("title", "original_filename")
    @classmethod
    def strip_text(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("字段不能为空")
        return normalized

    @model_validator(mode="after")
    def validate_media(self) -> "UploadInitiateRequest":
        if self.mime_type not in SUPPORTED_MIME_TYPES[self.media_type]:
            raise ValueError(f"不支持的文件类型：{self.mime_type}")
        if self.thumbnail_mime_type not in (None, "image/webp", "image/jpeg"):
            raise ValueError("缩略图必须是 WebP 或 JPEG")
        if self.media_type is MediaType.VIDEO and self.duration_seconds is None:
            raise ValueError("视频缺少时长信息")
        return self


class PresignedUpload(BaseModel):
    url: str
    headers: dict[str, str]


class UploadInitiateResponse(BaseModel):
    session_id: str
    part_size_bytes: int
    total_parts: int
    expires_at: datetime
    thumbnail_upload: PresignedUpload | None


class PartSignRequest(BaseModel):
    part_numbers: list[int] = Field(min_length=1, max_length=100)

    @field_validator("part_numbers")
    @classmethod
    def unique_parts(cls, value: list[int]) -> list[int]:
        if len(set(value)) != len(value):
            raise ValueError("分块编号不能重复")
        return value


class SignedPart(BaseModel):
    part_number: int
    url: str


class PartSignResponse(BaseModel):
    parts: list[SignedPart]


class CompletedPart(BaseModel):
    part_number: int = Field(ge=1, le=10000)
    etag: str = Field(min_length=1, max_length=256)


class UploadCompleteRequest(BaseModel):
    parts: list[CompletedPart] = Field(min_length=1, max_length=10000)


class UploadCompleteResponse(BaseModel):
    media: MediaCard


class HealthResponse(BaseModel):
    status: str
    database: str
    cos_configured: bool
    cos: str
    cos_cors: str
