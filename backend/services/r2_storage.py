# backend/services/r2_storage.py
"""
Cloudflare R2 Storage Service для сохранения записей звонков.
✅ v1.0: Загрузка аудиофайлов от Voximplant в R2

Использование:
    from backend.services.r2_storage import R2StorageService
    
    # Проверка настроек
    if R2StorageService.is_configured():
        url = await R2StorageService.upload_recording(record_url, call_id, assistant_id)
"""

import boto3
import httpx
from datetime import datetime
from typing import Optional

from backend.core.logging import get_logger
from backend.core.config import settings

logger = get_logger(__name__)


class R2StorageService:
    """Сервис для работы с Cloudflare R2"""
    
    _client = None
    
    @classmethod
    def _get_client(cls):
        """Получить или создать S3 клиент для R2"""
        if cls._client is None:
            if not settings.R2_ACCESS_KEY or not settings.R2_SECRET_KEY:
                logger.warning("[R2] Credentials not configured")
                return None
            
            try:
                cls._client = boto3.client(
                    's3',
                    endpoint_url=settings.R2_ENDPOINT,
                    aws_access_key_id=settings.R2_ACCESS_KEY,
                    aws_secret_access_key=settings.R2_SECRET_KEY,
                    region_name='auto'
                )
                logger.info("[R2] S3 client initialized successfully")
            except Exception as e:
                logger.error(f"[R2] Failed to initialize S3 client: {e}")
                return None
        
        return cls._client
    
    @classmethod
    async def upload_recording(
        cls,
        record_url: str,
        call_id: str,
        assistant_id: str
    ) -> Optional[str]:
        """
        Скачивает запись от Voximplant и загружает в R2.
        
        Args:
            record_url: Временный URL записи от Voximplant
            call_id: ID звонка
            assistant_id: ID ассистента
            
        Returns:
            Публичный URL записи в R2 или None при ошибке
        """
        try:
            client = cls._get_client()
            if not client:
                logger.error("[R2] Client not available - check R2 credentials")
                return None
            
            logger.info(f"[R2] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
            logger.info(f"[R2] 📥 Downloading recording from Voximplant...")
            logger.info(f"[R2]    Source URL: {record_url[:60]}...")
            
            # Скачиваем файл от Voximplant с увеличенным таймаутом
            async with httpx.AsyncClient(timeout=120.0) as http_client:
                response = await http_client.get(record_url)
                response.raise_for_status()
                audio_data = response.content
            
            file_size_kb = len(audio_data) / 1024
            file_size_mb = file_size_kb / 1024
            
            if file_size_mb >= 1:
                logger.info(f"[R2] ✅ Downloaded: {file_size_mb:.2f} MB")
            else:
                logger.info(f"[R2] ✅ Downloaded: {file_size_kb:.2f} KB")
            
            # Формируем путь: recordings/{assistant_id}/2025/01/18/{call_id}.mp3
            now = datetime.utcnow()
            
            # Очищаем call_id от потенциально проблемных символов
            safe_call_id = "".join(c for c in call_id if c.isalnum() or c in "-_")
            if not safe_call_id:
                safe_call_id = f"call_{int(now.timestamp())}"
            
            key = f"recordings/{assistant_id}/{now.year}/{now.month:02d}/{now.day:02d}/{safe_call_id}.mp3"
            
            logger.info(f"[R2] 📤 Uploading to R2...")
            logger.info(f"[R2]    Bucket: {settings.R2_BUCKET}")
            logger.info(f"[R2]    Key: {key}")
            
            # Загружаем в R2
            client.put_object(
                Bucket=settings.R2_BUCKET,
                Key=key,
                Body=audio_data,
                ContentType='audio/mpeg'
            )
            
            # Формируем публичный URL
            public_url = f"{settings.R2_PUBLIC_URL}/{key}"
            
            logger.info(f"[R2] ✅ Upload successful!")
            logger.info(f"[R2]    Public URL: {public_url}")
            logger.info(f"[R2] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
            
            return public_url
            
        except httpx.HTTPStatusError as e:
            logger.error(f"[R2] ❌ Failed to download from Voximplant: HTTP {e.response.status_code}")
            logger.error(f"[R2]    URL was: {record_url[:60]}...")
            return None
            
        except httpx.TimeoutException:
            logger.error(f"[R2] ❌ Timeout downloading from Voximplant")
            return None
            
        except Exception as e:
            logger.error(f"[R2] ❌ Error uploading recording: {e}")
            import traceback
            logger.error(f"[R2] Traceback: {traceback.format_exc()}")
            return None
    
    @classmethod
    def is_configured(cls) -> bool:
        """Проверяет, настроен ли R2"""
        configured = bool(
            getattr(settings, 'R2_ACCESS_KEY', None) and 
            getattr(settings, 'R2_SECRET_KEY', None) and 
            getattr(settings, 'R2_ENDPOINT', None) and 
            getattr(settings, 'R2_BUCKET', None) and
            getattr(settings, 'R2_PUBLIC_URL', None)
        )
        
        if not configured:
            logger.debug("[R2] Not configured - missing one or more settings")
        
        return configured
    
    @classmethod
    async def delete_recording(cls, key: str) -> bool:
        """
        Удаляет запись из R2.
        
        Args:
            key: Путь к файлу в R2 (например: recordings/xxx/2025/01/18/call123.mp3)
            
        Returns:
            True если удаление успешно
        """
        try:
            client = cls._get_client()
            if not client:
                return False
            
            client.delete_object(
                Bucket=settings.R2_BUCKET,
                Key=key
            )
            
            logger.info(f"[R2] ✅ Deleted: {key}")
            return True
            
        except Exception as e:
            logger.error(f"[R2] ❌ Error deleting {key}: {e}")
            return False
    
    @classmethod
    async def list_recordings(cls, assistant_id: str, limit: int = 100) -> list:
        """
        Получает список записей для ассистента.
        
        Args:
            assistant_id: ID ассистента
            limit: Максимальное количество записей
            
        Returns:
            Список объектов с информацией о записях
        """
        try:
            client = cls._get_client()
            if not client:
                return []
            
            prefix = f"recordings/{assistant_id}/"
            
            response = client.list_objects_v2(
                Bucket=settings.R2_BUCKET,
                Prefix=prefix,
                MaxKeys=limit
            )
            
            recordings = []
            for obj in response.get('Contents', []):
                recordings.append({
                    'key': obj['Key'],
                    'size': obj['Size'],
                    'last_modified': obj['LastModified'].isoformat(),
                    'url': f"{settings.R2_PUBLIC_URL}/{obj['Key']}"
                })
            
            logger.info(f"[R2] Found {len(recordings)} recordings for assistant {assistant_id}")
            return recordings
            
        except Exception as e:
            logger.error(f"[R2] ❌ Error listing recordings: {e}")
            return []
