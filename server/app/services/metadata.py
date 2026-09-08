"""TMDB poster lookup and Wikipedia poster fallback."""
from __future__ import annotations

import os
import re
from typing import Any

import httpx

_TMDB_KEY: str = os.environ.get("CINEDIRECT_TMDB_KEY", "")
_TMDB_BASE = "https://api.themoviedb.org/3"
_TMDB_IMG = "https://image.tmdb.org/t/p/w500"
_UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}


async def tmdb_poster(query: str, key: str = "") -> dict[str, str | None]:
    """Search TMDB for *query* and return the best-matching poster URL."""
    api_key = key or _TMDB_KEY
    if not api_key or not query:
        return {"poster": None, "name": None}

    async with httpx.AsyncClient(timeout=20) as client:
        try:
            resp = await client.get(
                f"{_TMDB_BASE}/search/multi",
                params={
                    "api_key": api_key,
                    "query": query,
                    "include_adult": "false",
                    "language": "en-US",
                },
            )
            resp.raise_for_status()
            data = resp.json()
        except (httpx.HTTPError, ValueError):
            return {"poster": None, "name": None}

    results = data.get("results") or []

    year_match = re.search(r"(\b19\d{2}\b|\b20\d{2}\b)", query)
    want_year = year_match.group(1) if year_match else None
    q_tokens = [t for t in re.split(r"\W+", query.lower()) if len(t) > 2]

    best: dict[str, Any] | None = None
    best_score = -1

    for item in results:
        if not item.get("poster_path"):
            continue
        name = (item.get("title") or item.get("name") or "").lower()
        score = 0
        if item.get("media_type") in ("movie", "tv"):
            score += 10
        if q_tokens:
            if all(t in name for t in q_tokens):
                score += 8
            elif any(t in name for t in q_tokens):
                score += 3
        rel = item.get("release_date") or item.get("first_air_date") or ""
        if want_year and rel.startswith(want_year):
            score += 20
        if score > best_score:
            best_score = score
            best = item

    if best:
        return {
            "poster": _TMDB_IMG + best["poster_path"],
            "name": best.get("title") or best.get("name"),
        }
    return {"poster": None, "name": None}


async def wikipedia_poster(query: str) -> dict[str, str | None]:
    """Fallback: fetch the page-image thumbnail for *query* from Wikipedia."""
    if not query:
        return {"poster": None, "name": None}

    async with httpx.AsyncClient(timeout=20) as client:
        try:
            resp = await client.get(
                "https://en.wikipedia.org/w/api.php",
                params={
                    "action": "query",
                    "titles": query,
                    "prop": "pageimages",
                    "format": "json",
                    "pithumbsize": "500",
                    "redirects": "1",
                },
                headers=_UA,
            )
            resp.raise_for_status()
            data = resp.json()
        except (httpx.HTTPError, ValueError):
            return {"poster": None, "name": None}

    pages = data.get("query", {}).get("pages", {})
    for page in pages.values():
        if not isinstance(page, dict):
            continue
        thumb = page.get("thumbnail", {})
        if isinstance(thumb, dict) and thumb.get("source"):
            return {
                "poster": thumb["source"],
                "name": page.get("title"),
            }
    return {"poster": None, "name": None}


async def lookup_poster(query: str, key: str = "") -> dict[str, str | None]:
    """Best-effort poster lookup: TMDB first, Wikipedia as fallback."""
    result = await tmdb_poster(query, key)
    if result.get("poster"):
        return result
    return await wikipedia_poster(query)
