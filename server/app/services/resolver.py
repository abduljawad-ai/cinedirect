"""Core link resolver – ported from hblinks-server.py to async httpx."""
from __future__ import annotations

import asyncio
import base64
import contextlib
import re
import urllib.parse
from typing import Any, TypedDict, cast

import httpx

from app.services import cache

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
HEADERS = {"User-Agent": UA}


class Resolved(TypedDict):
    direct: str | None
    size: int | None
    filename: str | None
    quality: str | None


EMPTY: Resolved = {"direct": None, "size": None, "filename": None, "quality": None}


def unwrap_dl(url: str | None) -> str | None:
    """hubcdn.sbs/dl/?link=<file> → bare <file> URL."""
    if not url:
        return url
    m = re.search(r"link=([^&]+)", url)
    return m.group(1) if m else url


def parse_quality(filename: str) -> str | None:
    m = re.search(
        r"(?<![a-zA-Z0-9])(480p|720p|1080p|2160p|4k)\b", filename, re.I
    ) or re.search(
        r"\[(480p|720p|1080p|2160p|4k)\]", filename, re.I
    )
    return m.group(1).upper() if m else None


def _to_resolved(direct: Any, filename: str, size: int | None) -> Resolved:
    return {
        "direct": direct,
        "size": size,
        "filename": filename,
        "quality": parse_quality(filename),
    }


async def _file_info(client: httpx.AsyncClient, r2_url: str) -> dict[str, Any]:
    """Return {size, filename} for an R2/GDrive direct URL via HEAD then 1-byte range GET."""

    def _parse(headers: httpx.Headers) -> dict[str, Any]:
        length = headers.get("Content-Length")
        cr = headers.get("Content-Range") or ""
        mmc = re.search(r"/(\d+)\s*$", cr)
        if mmc:
            length = mmc.group(1)
        cd = headers.get("Content-Disposition") or ""
        name = ""
        mm = re.search(r"filename\*=UTF-8''([^;]+)", cd)
        if mm:
            name = urllib.parse.unquote(mm.group(1))
        else:
            mm2 = re.search(r'filename="([^"]+)"', cd)
            if mm2:
                name = mm2.group(1)
        size = None
        try:
            size = int(length) if length else None
        except (ValueError, TypeError):
            size = None
        return {"size": size, "filename": name}

    try:
        r = await client.head(r2_url, headers=HEADERS, timeout=15, follow_redirects=True)
        return _parse(r.headers)
    except httpx.HTTPError:
        pass
    try:
        r = await client.get(
            r2_url,
            headers={**HEADERS, "Range": "bytes=0-0"},
            timeout=15,
            follow_redirects=True,
        )
        return _parse(r.headers)
    except httpx.HTTPError:
        return {"size": None, "filename": ""}


def _from_cache(file_url: str) -> Resolved | None:
    cached = cache.get(file_url)
    if cached is None:
        return None
    if isinstance(cached, dict):
        out = cast("Resolved", dict(cached))
        out["direct"] = unwrap_dl(out.get("direct"))
        return out
    # legacy: cache holds a bare dl wrapper string → unwrap it
    return {"direct": unwrap_dl(cached), "size": None, "filename": None, "quality": None}


async def resolve_hubdrive(client: httpx.AsyncClient, file_url: str) -> Resolved:
    """hubdrive.tips/file/<id> → AJAX POST → {direct, size, filename, quality}."""
    m = re.search(r"/file/(\d+)", file_url)
    if not m:
        return EMPTY
    fid = m.group(1)

    # warm up
    with contextlib.suppress(httpx.HTTPError):
        await client.get(file_url, headers=HEADERS, timeout=30)

    try:
        base = file_url[: file_url.index("/file/")]
        headers = {
            "User-Agent": UA,
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Referer": file_url,
            "Origin": base,
        }
        body = f"id={urllib.parse.quote(fid)}".encode()
        resp = await client.post(
            f"{base}/ajax.php?ajax=direct-download",
            content=body,
            headers=headers,
            timeout=30,
        )
        data = resp.json()
        if (
            isinstance(data, dict)
            and data.get("code") == "200"
            and isinstance(data.get("data"), dict)
        ):
            d = data["data"]
            if d.get("gd"):
                filename = d.get("n") or ""
                size = None
                try:
                    size = int(d["s"]) if str(d.get("s", "")).isdigit() else None
                except (ValueError, TypeError):
                    size = None
                return _to_resolved(d["gd"], filename, size)
    except (httpx.HTTPError, ValueError):
        pass
    return EMPTY


async def resolve_hubcloud(client: httpx.AsyncClient, file_url: str) -> Resolved:
    """hubcloud.cx/drive/<id> → multi-hop → pixeldrain direct URL."""
    cached = _from_cache(file_url)
    if cached is not None:
        return cached

    try:
        r = await client.get(file_url, headers=HEADERS, timeout=30, follow_redirects=True)
        html = r.text
        m = re.search(r'href="(https://gamerxyt\.com/hubcloud\.php[^"]+)"', html)
        if not m:
            return EMPTY
        r2 = await client.get(m.group(1), headers=HEADERS, timeout=30, follow_redirects=True)
        html2 = r2.text
        m2 = re.search(
            r'var\s+pxl\s*=\s*"(https://pixeldrain\.[a-z]+/u/[A-Za-z0-9]+)"', html2
        )
        if not m2:
            return EMPTY
        direct = re.sub(r"/u/", "/api/file/", m2.group(1), count=1)
        info = await _file_info(client, direct)
        result = _to_resolved(direct, info["filename"], info["size"])
        cache.put(file_url, result)
        return result
    except (httpx.HTTPError, ValueError):
        return EMPTY


async def resolve_hubcdn(client: httpx.AsyncClient, file_url: str) -> Resolved | None:
    """hubcdn.sbs base64 reurl decode → direct link → file_info."""
    cached = _from_cache(file_url)
    if cached is not None:
        return cached

    html = ""
    for attempt in range(2):
        try:
            r = await client.get(file_url, headers=HEADERS, timeout=40, follow_redirects=True)
            html = r.text
            if re.search(r'var\s+reurl\s*=\s*"', html, re.S):
                break
        except httpx.HTTPError:
            pass
        if attempt == 0:
            await asyncio.sleep(0.7)

    if not re.search(r'var\s+reurl\s*=\s*"', html, re.S):
        return None

    direct = None
    m = re.search(r'var\s+reurl\s*=\s*"([^"]+)"', html, re.S)
    if m:
        reurl = m.group(1).replace("\\/", "/")
        mm = re.search(r"[?&]r=([A-Za-z0-9+/=_\-]+)", reurl)
        if mm:
            b64 = mm.group(1)
            padded = b64 + "=" * (-len(b64) % 4)
            try:
                direct = base64.urlsafe_b64decode(padded).decode("utf-8", "replace")
            except Exception:
                direct = None
        elif "hubcdn.sbs/dl/" in reurl:
            direct = reurl

    if direct and "hubcdn.sbs/dl/" not in direct:
        direct = None

    result: Resolved = {
        "direct": None,
        "size": None,
        "filename": None,
        "quality": None,
    }
    if direct:
        bare = unwrap_dl(direct)
        info: dict[str, Any] = {"size": None, "filename": ""}
        if bare:
            info = await _file_info(client, bare)
        result["direct"] = bare
        result["size"] = info["size"]
        result["filename"] = info["filename"]
        result["quality"] = parse_quality(cast("str", info["filename"]))

    if direct:
        cache.put(file_url, result)
    return result


async def resolve_direct(file_url: str) -> Resolved | None:
    """Top-level resolver: dispatches to hubdrive/hubcloud/hubcdn as appropriate."""
    async with httpx.AsyncClient(follow_redirects=True) as client:
        if "hubdrive.tips" in file_url:
            return await resolve_hubdrive(client, file_url)
        if "hubcloud." in file_url:
            return await resolve_hubcloud(client, file_url)
        return await resolve_hubcdn(client, file_url)
