"""API routes – /api/health, /api/resolve, /api/dl."""
from __future__ import annotations

import asyncio
import os
import re
import urllib.parse
import uuid
from typing import TYPE_CHECKING, Any

import httpx
import structlog
from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from app.api.models import HealthResponse, ResolveResponse
from app.services.resolver import resolve_direct

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

_RELAY_URL: str | None = os.environ.get("CINEDIRECT_RELAY_URL") or None

log = structlog.get_logger()
router = APIRouter(prefix="/api", tags=["api"])

_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"


# ── health ──────────────────────────────────────────────────────────────────
@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(relay=_RELAY_URL)


# ── resolve ─────────────────────────────────────────────────────────────────
@router.post("/resolve")
async def api_resolve(req: Request) -> Any:
    req_id = uuid.uuid4().hex[:8]
    body = await req.json()
    urls = body.get("urls")

    if isinstance(urls, list):
        # Batch: one request resolves many hub links. Per-item failures become
        # null; input order is preserved. Bounded to 20 URLs per request.
        if not urls or len(urls) > 20:
            return JSONResponse(
                status_code=400,
                content={
                    "results": [],
                    "error": "urls must be a non-empty array of at most 20",
                },
            )
        sem = asyncio.Semaphore(8)

        async def _resolve_one(u: Any) -> ResolveResponse | None:
            if not isinstance(u, str) or not u:
                return None
            async with sem:
                try:
                    result = await resolve_direct(u)
                except Exception:  # noqa: BLE001 - per-item failure fails soft
                    return None
            if result is None or result.get("direct") is None:
                return None
            return ResolveResponse(**result)

        results = await asyncio.gather(*(_resolve_one(u) for u in urls))
        return {"results": [r.model_dump() if r else None for r in results]}

    url = body.get("url", "")
    if not url:
        log.warning("resolve.missing_url", req_id=req_id)
        return ResolveResponse()

    log.info("resolve.start", req_id=req_id, url=url[:120])
    result = await resolve_direct(url)
    if result is None or result.get("direct") is None:
        log.warning("resolve.failed", req_id=req_id, url=url[:120])
        return ResolveResponse()

    direct = result["direct"]
    log.info("resolve.ok", req_id=req_id, direct=direct or "")
    return ResolveResponse(**result)


# ── streaming download proxy ────────────────────────────────────────────────
@router.get("/dl")
async def api_dl(
    request: Request,
    src: str = Query(..., min_length=1),
) -> Response:
    if not src.startswith("https://") or "pixeldrain." not in src:
        return JSONResponse(
            status_code=400,
            content={"error": "bad src"},
        )

    headers: dict[str, str] = {"User-Agent": _UA}
    rng = request.headers.get("range")
    if rng:
        headers["Range"] = rng

    client = httpx.AsyncClient(follow_redirects=True, timeout=60)
    try:
        upstream = await client.get(src, headers=headers)
    except httpx.HTTPError as exc:
        await client.aclose()
        log.warning("dl.upstream_fail", src=src[:80], error=str(exc))
        return JSONResponse(
            status_code=502,
            content={"error": f"upstream failed: {exc}"},
        )

    ct = upstream.headers.get("Content-Type", "application/octet-stream")
    cd = upstream.headers.get("Content-Disposition", "")
    if not cd:
        name = src.rsplit("/", 1)[-1].split("?")[0]
        name = urllib.parse.unquote(name)
        cd = (
            f'attachment; filename="{name.replace(chr(34), chr(39))}"'
            if name
            else "attachment"
        )
    else:
        cd = re.sub(r"^\s*inline", "attachment", cd, flags=re.I)

    resp_headers: dict[str, str] = {
        "Content-Type": ct,
        "Content-Disposition": cd,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
    }
    cl = upstream.headers.get("Content-Length")
    if cl:
        resp_headers["Content-Length"] = cl
    cr = upstream.headers.get("Content-Range")
    if cr:
        resp_headers["Content-Range"] = cr

    async def stream() -> AsyncIterator[bytes]:
        try:
            async for chunk in upstream.aiter_bytes(65536):
                yield chunk
        finally:
            await client.aclose()

    return StreamingResponse(
        stream(),
        status_code=upstream.status_code,
        headers=resp_headers,
    )
