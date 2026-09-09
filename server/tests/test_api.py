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


# ── /api/resolve (batch) ─────────────────────────────────────────────────────
class TestResolveBatch:
    async def test_empty_urls_returns_400(self, client: AsyncClient) -> None:
        resp = await client.post("/api/resolve", json={"urls": []})
        assert resp.status_code == 400

    async def test_too_many_urls_returns_400(self, client: AsyncClient) -> None:
        resp = await client.post(
            "/api/resolve",
            json={"urls": ["https://hubcdn.sbs/file/x"] * 21},
        )
        assert resp.status_code == 400

    @patch("app.api.routes.resolve_direct", new_callable=AsyncMock)
    async def test_batch_preserves_order(
        self, mock_resolve: AsyncMock, client: AsyncClient
    ) -> None:
        mock_resolve.side_effect = [
            {
                "direct": "https://pub-1.r2.dev/a.mkv",
                "size": 1,
                "filename": "A.1080p.mkv",
                "quality": "1080P",
            },
            {
                "direct": "https://pub-1.r2.dev/b.mkv",
                "size": 2,
                "filename": "B.720p.mkv",
                "quality": "720P",
            },
        ]
        resp = await client.post(
            "/api/resolve",
            json={"urls": ["https://hubcdn.sbs/file/1", "https://hubcdn.sbs/file/2"]},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert [r["direct"] for r in body["results"]] == [
            "https://pub-1.r2.dev/a.mkv",
            "https://pub-1.r2.dev/b.mkv",
        ]

    @patch("app.api.routes.resolve_direct", new_callable=AsyncMock)
    async def test_batch_per_item_failures_are_null(
        self, mock_resolve: AsyncMock, client: AsyncClient
    ) -> None:
        mock_resolve.side_effect = [
            {"direct": None, "size": None, "filename": None, "quality": None},
            Exception("upstream boom"),
        ]
        resp = await client.post(
            "/api/resolve",
            json={"urls": ["https://hubcdn.sbs/bad", "https://hubcdn.sbs/dead"]},
        )
        assert resp.status_code == 200
        assert resp.json()["results"] == [None, None]

    async def test_batch_non_string_items_are_null(self, client: AsyncClient) -> None:
        resp = await client.post("/api/resolve", json={"urls": [123, None]})
        assert resp.status_code == 200
        assert resp.json()["results"] == [None, None]


# ── /api/dl ──────────────────────────────────────────────────────────────────
class TestDl:
    async def test_bad_src_returns_400(self, client: AsyncClient) -> None:
        resp = await client.get("/api/dl", params={"src": "http://evil.com/x"})
        assert resp.status_code == 400

    async def test_missing_pixeldrain_returns_400(self, client: AsyncClient) -> None:
        resp = await client.get("/api/dl", params={"src": "https://example.com/file"})
        assert resp.status_code == 400
