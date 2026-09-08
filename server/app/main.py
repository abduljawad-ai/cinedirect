"""FastAPI application factory for CineDirect."""
from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from typing import TYPE_CHECKING

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware as BuiltinCORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api.routes import router as api_router
from app.middleware.cors import CorsMiddleware
from app.middleware.rate_limit import RateLimitMiddleware

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

client_dir = Path(__file__).resolve().parents[2] / "client" / "dist"

structlog.configure(
    processors=[
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.add_log_level,
        structlog.processors.StackInfoRenderer(),
        structlog.dev.ConsoleRenderer(),
    ],
)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    structlog.get_logger().info("cinedirect.started", version="2.0.0")
    yield


def create_app() -> FastAPI:
    application = FastAPI(
        title="CineDirect API",
        version="2.0.0",
        docs_url="/api/docs",
        redoc_url="/api/redoc",
        lifespan=lifespan,
    )

    # ── CORS (both built-in starlette and custom env-driven) ──
    application.add_middleware(
        BuiltinCORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    application.add_middleware(CorsMiddleware)

    # ── rate limiting ──
    application.add_middleware(RateLimitMiddleware)

    # ── routes ──
    application.include_router(api_router)

    # ── static client (optional – serves the built frontend if present) ──
    if client_dir.is_dir():
        assets_dir = client_dir / "assets"
        if assets_dir.is_dir():
            application.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

        @application.get("/")
        async def _index() -> FileResponse:
            return FileResponse(client_dir / "index.html")

        @application.get("/{path:path}")
        async def _spa(path: str) -> FileResponse:
            candidate = client_dir / path
            if candidate.is_file():
                return FileResponse(candidate)
            return FileResponse(client_dir / "index.html")

    return application


app = create_app()
