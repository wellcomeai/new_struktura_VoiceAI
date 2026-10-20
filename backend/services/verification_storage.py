"""
Приватное хранилище документов верификации физлиц — Timeweb S3 (РФ).

Анкета (JSON) и сканы паспорта/селфи хранятся в отдельном приватном бакете:
ссылок на объекты наружу нет, админ открывает их по временной подписанной
ссылке (presigned URL на 10 минут) или получает байты через наш API.
Ключи: verifications/<user_id>/<attempt>/<kind>.<ext>.

Клиент boto3 синхронный — из async-кода вызывать через asyncio.to_thread.
"""

import json
from typing import Optional, Dict, Any

from backend.core.config import settings
from backend.core.logging import get_logger

logger = get_logger(__name__)

PRESIGNED_TTL_SECONDS = 600

_client = None


def is_configured() -> bool:
    return bool(
        settings.TIMEWEB_S3_ACCESS_KEY and settings.TIMEWEB_S3_SECRET_KEY
        and settings.TIMEWEB_S3_BUCKET and settings.TIMEWEB_S3_ENDPOINT
    )


def _s3():
    global _client
    if _client is None:
        import boto3
        from botocore.config import Config
        _client = boto3.client(
            "s3",
            endpoint_url=settings.TIMEWEB_S3_ENDPOINT,
            aws_access_key_id=settings.TIMEWEB_S3_ACCESS_KEY,
            aws_secret_access_key=settings.TIMEWEB_S3_SECRET_KEY,
            region_name=settings.TIMEWEB_S3_REGION or "ru-1",
            config=Config(signature_version="s3v4", s3={"addressing_style": "path"},
                          retries={"max_attempts": 3}),
        )
    return _client


def object_key(user_id, attempt: int, name: str) -> str:
    return f"verifications/{user_id}/{attempt}/{name}"


def put_bytes(key: str, data: bytes, content_type: str) -> None:
    _s3().put_object(
        Bucket=settings.TIMEWEB_S3_BUCKET, Key=key, Body=data,
        ContentType=content_type, ACL="private",
    )


def put_json(key: str, payload: Dict[str, Any]) -> None:
    put_bytes(key, json.dumps(payload, ensure_ascii=False).encode("utf-8"),
              "application/json; charset=utf-8")


def get_bytes(key: str) -> tuple[bytes, str]:
    obj = _s3().get_object(Bucket=settings.TIMEWEB_S3_BUCKET, Key=key)
    return obj["Body"].read(), obj.get("ContentType") or "application/octet-stream"


def get_json(key: str) -> Optional[Dict[str, Any]]:
    if not key:
        return None
    try:
        data, _ = get_bytes(key)
        return json.loads(data.decode("utf-8"))
    except Exception as e:
        logger.warning(f"[VERIFY-S3] read {key} failed: {e}")
        return None


def presigned_url(key: str, ttl: int = PRESIGNED_TTL_SECONDS) -> str:
    return _s3().generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.TIMEWEB_S3_BUCKET, "Key": key},
        ExpiresIn=ttl,
    )


def delete_prefix(prefix: str) -> int:
    """Удалить все объекты под префиксом. Возвращает число удалённых."""
    s3 = _s3()
    deleted = 0
    token = None
    while True:
        kwargs = {"Bucket": settings.TIMEWEB_S3_BUCKET, "Prefix": prefix}
        if token:
            kwargs["ContinuationToken"] = token
        page = s3.list_objects_v2(**kwargs)
        keys = [{"Key": o["Key"]} for o in page.get("Contents", [])]
        if keys:
            s3.delete_objects(Bucket=settings.TIMEWEB_S3_BUCKET, Delete={"Objects": keys})
            deleted += len(keys)
        if not page.get("IsTruncated"):
            return deleted
        token = page.get("NextContinuationToken")
