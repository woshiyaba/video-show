from __future__ import annotations

from functools import lru_cache
from typing import Any

from qcloud_cos import CosConfig, CosS3Client

from app.config import Settings, get_settings


class CosNotConfiguredError(RuntimeError):
    pass


class CosService:
    def __init__(self, settings: Settings):
        if not settings.cos_is_configured:
            raise CosNotConfiguredError(
                "腾讯云 COS 尚未配置，请检查 COS_SECRET_ID、COS_SECRET_KEY、"
                "COS_REGION 和 COS_BUCKET"
            )
        self.bucket = settings.cos_bucket
        self.upload_url_expires = settings.upload_url_expires_seconds
        self.media_url_expires = settings.media_url_expires_seconds
        config = CosConfig(
            Region=settings.cos_region,
            SecretId=settings.cos_secret_id,
            SecretKey=settings.cos_secret_key,
            Scheme="https",
        )
        self.client = CosS3Client(config)

    def create_multipart_upload(
        self, key: str, content_type: str
    ) -> str:
        response = self.client.create_multipart_upload(
            Bucket=self.bucket,
            Key=key,
            ContentType=content_type,
        )
        return str(response["UploadId"])

    def sign_upload_part(
        self, key: str, upload_id: str, part_number: int
    ) -> str:
        return self.client.get_presigned_url(
            Method="PUT",
            Bucket=self.bucket,
            Key=key,
            Expired=self.upload_url_expires,
            Params={
                "uploadId": upload_id,
                "partNumber": str(part_number),
            },
        )

    def sign_put_object(self, key: str, content_type: str) -> str:
        return self.client.get_presigned_url(
            Method="PUT",
            Bucket=self.bucket,
            Key=key,
            Expired=self.upload_url_expires,
            Headers={"Content-Type": content_type},
        )

    def complete_multipart_upload(
        self, key: str, upload_id: str, parts: list[dict[str, Any]]
    ) -> None:
        self.client.complete_multipart_upload(
            Bucket=self.bucket,
            Key=key,
            UploadId=upload_id,
            MultipartUpload={"Part": parts},
        )

    def abort_multipart_upload(self, key: str, upload_id: str) -> None:
        self.client.abort_multipart_upload(
            Bucket=self.bucket,
            Key=key,
            UploadId=upload_id,
        )

    def object_exists(self, key: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=key)
            return True
        except Exception as exc:
            status_code = getattr(exc, "get_status_code", lambda: None)()
            if status_code == 404:
                return False
            raise

    def delete_object(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=key)

    def delete_objects(self, keys: list[str]) -> None:
        if not keys:
            return
        response = self.client.delete_objects(
            Bucket=self.bucket,
            Delete={
                "Object": [{"Key": key} for key in keys],
                "Quiet": "false",
            },
        )
        errors = response.get("Error", [])
        if errors:
            failed = ", ".join(str(item.get("Key", "unknown")) for item in errors)
            raise RuntimeError(f"COS 删除部分对象失败：{failed}")

    def sign_download(self, key: str) -> str:
        return self.client.get_presigned_url(
            Method="GET",
            Bucket=self.bucket,
            Key=key,
            Expired=self.media_url_expires,
        )

    def check_bucket(self) -> None:
        self.client.head_bucket(Bucket=self.bucket)

    def check_cors(self) -> str:
        try:
            response = self.client.get_bucket_cors(Bucket=self.bucket)
        except Exception as exc:
            error_code = getattr(exc, "get_error_code", lambda: "")()
            if error_code == "NoSuchCORSConfiguration":
                return "missing"
            raise

        raw_rules = response.get("CORSRule", [])
        rules = [raw_rules] if isinstance(raw_rules, dict) else raw_rules
        for rule in rules:
            methods = {
                str(value).upper()
                for value in _as_list(rule.get("AllowedMethod", []))
            }
            allowed_headers = {
                str(value).lower()
                for value in _as_list(rule.get("AllowedHeader", []))
            }
            exposed_headers = {
                str(value).lower()
                for value in _as_list(rule.get("ExposeHeader", []))
            }
            if (
                {"GET", "HEAD", "PUT"}.issubset(methods)
                and (
                    "*" in allowed_headers
                    or {"range", "content-type"}.issubset(allowed_headers)
                )
                and "etag" in exposed_headers
            ):
                return "ok"
        return "incomplete"


def _as_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if value in (None, ""):
        return []
    return [value]


@lru_cache
def get_cos_service() -> CosService:
    return CosService(get_settings())
