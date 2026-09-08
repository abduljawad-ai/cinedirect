"""CORS middleware configured via environment variable."""
from __future__ import annotations

import os
from typing import TYPE_CHECKING

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from starlette.requests import Request

_ORIGINS: list[str] = [
    o.strip()
    for o in os.environ.get("CINEDIRECT_CORS_ORIGINS", "*").split(",")
    if o.strip()
]


class CorsMiddleware(BaseHTTPMiddleware):
    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        origin = request.headers.get("origin", "")

        if request.method == "OPTIONS":
            resp = Response(status_code=204)
        else:
            resp = await call_next(request)

        if _ORIGINS == ["*"] or origin in _ORIGINS:
            resp.headers["Access-Control-Allow-Origin"] = origin or "*"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Range, Content-Type"
        resp.headers["Access-Control-Expose-Headers"] = "Content-Range, Content-Length"
        resp.headers["Access-Control-Max-Age"] = "86400"
        return resp
