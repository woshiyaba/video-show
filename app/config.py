from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    app_name: str = "映集"
    database_url: str = "sqlite:///./data/video_show.db"
    frontend_dir: Path = Path("frontend/dist")

    cos_secret_id: str = ""
    cos_secret_key: str = ""
    cos_region: str = ""
    cos_bucket: str = ""

    cors_origins: str = "http://localhost:5173,http://localhost:8000"
    max_upload_size_gb: int = Field(default=20, ge=1, le=500)
    upload_part_size_mb: int = Field(default=16, ge=1, le=5120)
    upload_url_expires_seconds: int = Field(default=3600, ge=300, le=86400)
    media_url_expires_seconds: int = Field(default=21600, ge=300, le=86400)
    upload_session_hours: int = Field(default=24, ge=1, le=168)

    @field_validator(
        "cos_secret_id",
        "cos_secret_key",
        "cos_region",
        "cos_bucket",
        mode="before",
    )
    @classmethod
    def strip_cos_values(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def max_upload_size_bytes(self) -> int:
        return self.max_upload_size_gb * 1024 * 1024 * 1024

    @property
    def upload_part_size_bytes(self) -> int:
        return self.upload_part_size_mb * 1024 * 1024

    @property
    def cos_is_configured(self) -> bool:
        return all(
            (self.cos_secret_id, self.cos_secret_key, self.cos_region, self.cos_bucket)
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()
