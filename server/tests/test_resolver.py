"""Unit tests for app.services.resolver."""
from __future__ import annotations

import base64

import pytest

from app.services.resolver import parse_quality, unwrap_dl


# ── unwrap_dl ────────────────────────────────────────────────────────────────
class TestUnwrapDl:
    def test_extracts_link_param(self) -> None:
        url = "https://hubcdn.sbs/dl/?link=https://example.com/file.mkv"
        assert unwrap_dl(url) == "https://example.com/file.mkv"

    def test_returns_plain_url(self) -> None:
        url = "https://example.com/file.mkv"
        assert unwrap_dl(url) == url

    def test_none_passthrough(self) -> None:
        assert unwrap_dl(None) is None

    def test_empty_string(self) -> None:
        assert unwrap_dl("") == ""

    def test_link_at_end_with_trailing_amp(self) -> None:
        url = "https://hubcdn.sbs/dl/?link=https://r2.dev/x&foo=bar"
        assert unwrap_dl(url) == "https://r2.dev/x"


# ── parse_quality ────────────────────────────────────────────────────────────
class TestParseQuality:
    @pytest.mark.parametrize(
        "filename, expected",
        [
            ("Movie.1080p.BluRay.mkv", "1080P"),
            ("Show.S01E05.720p.WEB-DL.mp4", "720P"),
            ("Film [4K].mkv", "4K"),
            ("2160p.UHD.mkv", "2160P"),
            ("no-quality-here.mp4", None),
            ("480p.rip.avi", "480P"),
        ],
    )
    def test_various(self, filename: str, expected: str | None) -> None:
        assert parse_quality(filename) == expected


# ── fixture: hubcdn reurl HTML ──────────────────────────────────────────────
@pytest.fixture
def hubcdn_html() -> str:
    bare_url = "https://file.example.com/video.mkv"
    b64 = base64.urlsafe_b64encode(bare_url.encode()).decode().rstrip("=")
    return f"""
    <html><body>
    <script>
    var reurl = "https://hubcdn.sbs/dl/?r={b64}";
    </script>
    </body></html>
    """


# ── fixture: hubdrive AJAX response ─────────────────────────────────────────
@pytest.fixture
def hubdrive_ajax_response() -> dict[str, str | dict[str, str]]:
    return {
        "code": "200",
        "data": {
            "gd": "https://workers.dev/file/abc123",
            "n": "Movie.1080p.mkv",
            "s": "1024000",
        },
    }
