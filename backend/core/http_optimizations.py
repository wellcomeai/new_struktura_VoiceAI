"""
HTTP-оптимизации на уровне ASGI: сжатие ответов и заголовки кэширования статики.

Подключаются в app.py. Логику приложения не трогают: работают только с
заголовками и телом уже сформированного ответа.
"""

from typing import Iterable, Tuple

from starlette.datastructures import Headers, MutableHeaders
from starlette.middleware.gzip import GZipResponder
from starlette.types import ASGIApp, Message, Receive, Scope, Send

# Типы, которые имеет смысл сжимать. Картинки, аудио и архивы уже сжаты.
COMPRESSIBLE_PREFIXES = (
    "text/",
    "application/json",
    "application/javascript",
    "application/x-javascript",
    "application/xml",
    "application/manifest+json",
    "image/svg+xml",
)

# Потоковые ответы: gzip буферизует чанки, и события SSE/стрим LLM доходили бы с задержкой.
NO_COMPRESS_CONTENT_TYPES = ("text/event-stream",)


class _SelectiveGZipResponder(GZipResponder):
    """GZipResponder, который пропускает несжимаемые и потоковые ответы как есть."""

    def __init__(self, app: ASGIApp, minimum_size: int, compresslevel: int) -> None:
        super().__init__(app, minimum_size, compresslevel)
        self.passthrough = False

    async def send_with_gzip(self, message: Message) -> None:
        if message["type"] == "http.response.start":
            headers = Headers(raw=message["headers"])
            ctype = headers.get("content-type", "").lower()
            self.passthrough = (
                ctype.startswith(NO_COMPRESS_CONTENT_TYPES)
                or not ctype.startswith(COMPRESSIBLE_PREFIXES)
                or "content-encoding" in headers
            )
            if self.passthrough:
                await self.send(message)
                return
        elif self.passthrough:
            await self.send(message)
            return
        await super().send_with_gzip(message)


class SelectiveGZipMiddleware:
    """
    Как starlette GZipMiddleware, но:
    - сжимает только текстовые/JSON ответы;
    - не трогает text/event-stream и пути из exclude_paths (стримы LLM);
    - WebSocket и не-HTTP scope пропускает.
    """

    def __init__(
        self,
        app: ASGIApp,
        minimum_size: int = 1024,
        compresslevel: int = 6,
        exclude_paths: Iterable[str] = (),
    ) -> None:
        self.app = app
        self.minimum_size = minimum_size
        self.compresslevel = compresslevel
        self.exclude_paths: Tuple[str, ...] = tuple(exclude_paths)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            path = scope.get("path", "")
            headers = Headers(scope=scope)
            if "gzip" in headers.get("Accept-Encoding", "") and not path.startswith(self.exclude_paths):
                responder = _SelectiveGZipResponder(self.app, self.minimum_size, self.compresslevel)
                await responder(scope, receive, send)
                return
        await self.app(scope, receive, send)


# Правила Cache-Control для статики. Проверяются по порядку, первое совпадение.
# HTML всегда перепроверяется (no-cache + ETag от StaticFiles → 304), чтобы деплой
# применялся сразу. Бандл лендинга с хешем в имени можно кэшировать навсегда.
_IMMUTABLE_PREFIXES = ("/static/landing/assets/",)
_SHORT_EXT = (".js", ".css", ".svg", ".json", ".map")
_LONG_EXT = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".mp3", ".wav", ".mp4")

CACHE_HTML = "no-cache"
CACHE_IMMUTABLE = "public, max-age=31536000, immutable"
CACHE_SHORT = "public, max-age=600, stale-while-revalidate=3600"
CACHE_LONG = "public, max-age=86400"


def cache_control_for(path: str) -> str:
    """Возвращает значение Cache-Control для пути статики или '' если правил нет."""
    lower = path.lower()
    if lower == "/" or lower.endswith(".html") or lower.endswith("/"):
        return CACHE_HTML
    if lower.startswith(_IMMUTABLE_PREFIXES):
        return CACHE_IMMUTABLE
    if lower.endswith(_SHORT_EXT):
        return CACHE_SHORT
    if lower.endswith(_LONG_EXT):
        return CACHE_LONG
    return ""


class StaticCacheHeadersMiddleware:
    """
    Проставляет Cache-Control для GET/HEAD ответов статики (/static/*, /js/*, /),
    если приложение само его не задало. Без этого браузер перепроверял ui.js,
    css и иконки при каждом переходе между страницами кабинета.
    """

    def __init__(self, app: ASGIApp, prefixes: Iterable[str] = ("/static/", "/js/")) -> None:
        self.app = app
        self.prefixes: Tuple[str, ...] = tuple(prefixes)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope.get("method") not in ("GET", "HEAD"):
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        if path != "/" and not path.startswith(self.prefixes):
            await self.app(scope, receive, send)
            return

        value = cache_control_for(path)
        if not value:
            await self.app(scope, receive, send)
            return

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start" and message.get("status") in (200, 304):
                headers = MutableHeaders(raw=message["headers"])
                if "cache-control" not in headers:
                    headers["Cache-Control"] = value
            await send(message)

        await self.app(scope, receive, send_wrapper)


class TrailingSlashRewriteMiddleware:
    """
    Подменяет путь запроса вместо 307-редиректа Starlette при несовпадении
    завершающего слэша (``/api/contacts?…`` при маршруте ``/api/contacts/``).

    Зачем: редирект строит абсолютный ``Location`` из заголовка ``Host``, а за
    прокси Render приложение видит внутренний хост ``*.onrender.com``. Браузер
    уходит на другой origin, теряет заголовок ``Authorization`` и получает 403.
    Так падала CRM (``crm.js`` → ``/api/contacts?limit=100``).

    Список известных путей собирается лениво на первом запросе из ``app.routes``
    (роутеры подключаются позже middleware). Пути с параметрами (``{id}``) не
    трогаем — там проблемы нет, а подмена могла бы задеть чужие маршруты.
    """

    def __init__(self, app: ASGIApp, get_routes) -> None:
        self.app = app
        self._get_routes = get_routes
        self._paths = None

    def _build_paths(self) -> set:
        paths = set()
        for route in self._get_routes():
            path = getattr(route, "path", None)
            if isinstance(path, str) and "{" not in path:
                paths.add(path)
        return paths

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            if self._paths is None:
                self._paths = self._build_paths()
            path = scope.get("path", "")
            if path not in self._paths:
                alt = path[:-1] if (path.endswith("/") and len(path) > 1) else path + "/"
                if alt in self._paths:
                    scope["path"] = alt
                    if scope.get("raw_path"):
                        scope["raw_path"] = alt.encode("utf-8")
        await self.app(scope, receive, send)
