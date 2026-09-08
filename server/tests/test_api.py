"""API integration tests using httpx.AsyncClient + ASGITransport."""
from __future__ import annotations

from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app

if TYPE_CHECKING:
    from collections.abc import AsyncIterator


@pytest.fixture
async def client() -> AsyncIterator[AsyncClient]:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        yield ac


# ── /api/health ──────────────────────────────────────────────────────────────
class TestHealth:
    async def test_health_returns_ok(self, client: AsyncClient) -> None:
        resp = await client.get("/api/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["ok"] is True
        assert "version" in body


# ── /api/resolve ─────────────────────────────────────────────────────────────
class TestResolve:
    async def test_missing_url_returns_empty(self, client: AsyncClient) -> None:
        resp = await client.post("/api/resolve", json={"url": ""})
        assert resp.status_code == 200
        body = resp.json()
        assert body["direct"] is None

    @patch("app.api.routes.resolve_direct", new_callable=AsyncMock)
    async def test_resolve_ok(self, mock_resolve: AsyncMock, client: AsyncClient) -> None:
        mock_resolve.return_value = {
            "direct": "https://r2.dev/file.mkv",
            "size": 1024,
            "filename": "Movie.1080p.mkv",
            "quality": "1080P",
        }
        resp = await client.post("/api/resolve", json={"url": "https://hubcdn.sbs/file/123"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["direct"] == "https://r2.dev/file.mkv"
        assert body["quality"] == "1080P"

    @patch("app.api.routes.resolve_direct", new_callable=AsyncMock)
    async def test_resolve_failed_returns_empty(
        self, mock_resolve: AsyncMock, client: AsyncClient
    ) -> None:
        mock_resolve.return_value = {
            "direct": None,
            "size": None,
            "filename": None,
            "quality": None,
        }
        resp = await client.post("/api/resolve", json={"url": "https://hubcdn.sbs/bad"})
        assert resp.status_code == 200
        assert resp.json()["direct"] is None


# ── /api/dl ──────────────────────────────────────────────────────────────────
class TestDl:
    async def test_bad_src_returns_400(self, client: AsyncClient) -> None:
        resp = await client.get("/api/dl", params={"src": "http://evil.com/x"})
        assert resp.status_code == 400

    async def test_missing_pixeldrain_returns_400(self, client: AsyncClient) -> None:
        resp = await client.get("/api/dl", params={"src": "https://example.com/file"})
        assert resp.status_code == 400


# ── /api/tmdb ────────────────────────────────────────────────────────────────
class TestTmdb:
    async def test_empty_query_returns_null(self, client: AsyncClient) -> None:
        resp = await client.get("/api/tmdb", params={"key": "", "q": ""})
        assert resp.status_code == 200
        assert resp.json()["poster"] is None
