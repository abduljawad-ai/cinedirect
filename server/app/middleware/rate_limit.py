"""Token-bucket rate limiter middleware – per-IP, in-memory."""
from __future__ import annotations

import os
import time
from collections import defaultdict
from typing import TYPE_CHECKING

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse, Response

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from starlette.requests import Request

_LIMIT: int = int(os.environ.get("CINEDIRECT_RATE_LIMIT", "30"))
_WINDOW: float = 60.0  # seconds


class _Bucket:
    __slots__ = ("tokens", "last_refill")

    def __init__(self, capacity: float) -> None:
        self.tokens = capacity
        self.last_refill = time.monotonic()

    def consume(self, capacity: float, window: float) -> bool:
        now = time.monotonic()
        elapsed = now - self.last_refill
        self.tokens = min(capacity, self.tokens + elapsed * (capacity / window))
        self.last_refill = now
        if self.tokens >= 1:
            self.tokens -= 1
            return True
        return False


_buckets: dict[str, _Bucket] = defaultdict(lambda: _Bucket(_LIMIT))


class RateLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        if not request.url.path.startswith("/api/resolve"):
            return await call_next(request)

        ip = request.client.host if request.client else "unknown"
        bucket = _buckets[ip]
        if not bucket.consume(_LIMIT, _WINDOW):
            return JSONResponse(
                status_code=429,
                content={"error": "rate limit exceeded – try again shortly"},
            )
        return await call_next(request)
