#!/usr/bin/env python3
"""
hblinks-server.py — local server for the HBLinks search tool.

Serves the HTML files in this folder AND resolves hubcdn "file" links
to their true direct file URLs (the bare r2.dev / GDrive link hidden
inside hubcdn.sbs/dl/?link=... — computed server-side so the browser
never hits CORS).

Usage:
    python3 hblinks-server.py [port]
    # default port 8000, then open http://localhost:8000/
"""
import os
import re
import json
import time
import base64
import threading
import argparse
import urllib.request
import urllib.parse
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_FILE = os.path.join(DIR, "hubcdn_resolve_cache.json")

# In-memory + on-disk cache: { "<hubcdn file url>": {"direct", "size", "filename", "quality"} }
RESOLVE_CACHE = {}
CACHE_LOCK = threading.Lock()
try:
    with open(CACHE_FILE, "r", encoding="utf-8") as f:
        RESOLVE_CACHE = json.load(f)
except Exception:
    pass

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}


def save_cache():
    try:
        with CACHE_LOCK:
            with open(CACHE_FILE, "w", encoding="utf-8") as f:
                json.dump(RESOLVE_CACHE, f)
    except Exception:
        pass


def file_info(r2_url):
    """Learn the file's size + real filename (which carries the quality).
    Uses HEAD first; if the bucket blocks HEAD, falls back to a 1-byte range GET
    (headers still carry Content-Length + Content-Disposition)."""
    def parse(resp_headers):
        length = resp_headers.get("Content-Length")
        # For partial (Range) responses R2 reports the range length; the true
        # file size is in Content-Range: "bytes 0-0/210192070".
        cr = resp_headers.get("Content-Range") or ""
        mmc = re.search(r"/(\d+)\s*$", cr)
        if mmc:
            length = mmc.group(1)
        cd = resp_headers.get("Content-Disposition") or ""
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
        except Exception:
            size = None
        return {"size": size, "filename": name}

    try:
        req = urllib.request.Request(r2_url, method="HEAD", headers=UA)
        with urllib.request.urlopen(req, timeout=15) as r:
            return parse(r.headers)
    except Exception:
        pass
    try:
        req = urllib.request.Request(r2_url, headers={**UA, "Range": "bytes=0-0"})
        with urllib.request.urlopen(req, timeout=15) as r:
            return parse(r.headers)
    except Exception:
        return {"size": None, "filename": ""}


def parse_quality(filename):
    m = re.search(r"\.(480p|720p|1080p|2160p|4k)\b", filename, re.I) or \
        re.search(r"\[(480p|720p|1080p|2160p|4k)\]", filename, re.I)
    if m:
        return m.group(1).upper()
    return None


def unwrap_dl(url):
    """hubcdn.sbs/dl/?link=<file> is a tiny HTML wrapper page; the true
    direct file URL rides in the link= query param. Expose that bare URL
    so browsers download the file straight from its origin (r2.dev,
    GDrive, ...) instead of opening the wrapper."""
    if not url:
        return url
    m = re.search(r"link=([^&]+)", url)
    return m.group(1) if m else url


def resolve_hubdrive(file_url):
    """Old posts (2019-2023) use hubdrive.tips/file/<id> pages instead of
    hubcdn. The page answers a small AJAX POST with a fresh tokenized
    direct link in data.gd (a workers.dev proxy URL), plus filename and
    size. Tokenized links expire, so we deliberately do NOT cache them —
    the client re-resolves on each search."""
    m = re.search(r"/file/(\d+)", file_url)
    if not m:
        return {"direct": None}
    fid = m.group(1)
    try:
        # warm up like a browser: visit the page first
        req = urllib.request.Request(file_url, headers=UA)
        urllib.request.urlopen(req, timeout=30).read()
    except Exception:
        pass
    try:
        base = file_url[: file_url.index("/file/")]
        headers = {
            "User-Agent": UA["User-Agent"],
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Referer": file_url,
            "Origin": base,
        }
        body = ("id=" + urllib.parse.quote(fid)).encode("utf-8")
        req = urllib.request.Request(
            base + "/ajax.php?ajax=direct-download", data=body, headers=headers
        )
        raw = urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "replace")
        data = json.loads(raw)
        if isinstance(data, dict) and data.get("code") == "200" and isinstance(data.get("data"), dict):
            d = data["data"]
            if d.get("gd"):
                filename = d.get("n") or ""
                size = None
                try:
                    size = int(d["s"]) if str(d.get("s", "")).isdigit() else None
                except Exception:
                    size = None
                return {
                    "direct": d["gd"],
                    "size": size,
                    "filename": filename,
                    "quality": parse_quality(filename),
                }
    except Exception:
        pass
    return {"direct": None}


def resolve_hubcloud(file_url):
    """Rare host used on some older posts: hubcloud.cx/drive/<id>.
    The page hands off to a generator (gamerxyt.com) whose page echoes a
    pixeldrain file link (var pxl). Pixeldrain exposes a plain
    /api/file/<id> direct URL. Results are stable, so we cache them."""
    if file_url in RESOLVE_CACHE:
        cached = RESOLVE_CACHE[file_url]
        if isinstance(cached, dict):
            out = dict(cached)
            out["direct"] = unwrap_dl(out.get("direct"))
            return out
        return {"direct": unwrap_dl(cached)}
    try:
        req = urllib.request.Request(file_url, headers=UA)
        html = urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "replace")
        m = re.search(r'href="(https://gamerxyt\.com/hubcloud\.php[^"]+)"', html)
        if not m:
            return {"direct": None}
        req = urllib.request.Request(m.group(1), headers=UA)
        html2 = urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "replace")
        m2 = re.search(r'var\s+pxl\s*=\s*"(https://pixeldrain\.[a-z]+/u/[A-Za-z0-9]+)"', html2)
        if not m2:
            return {"direct": None}
        direct = re.sub(r"/u/", "/api/file/", m2.group(1), count=1)
        info = {"size": None, "filename": ""}
        try:
            info = file_info(direct)
        except Exception:
            pass
        result = {
            "direct": direct,
            "size": info["size"],
            "filename": info["filename"],
            "quality": parse_quality(info["filename"]),
        }
        RESOLVE_CACHE[file_url] = result
        save_cache()
        return result
    except Exception:
        return {"direct": None}


def resolve_direct(file_url):
    """Fetch a hubcdn/hubdrive/hubcloud file page and return the final
    bare direct file URL (plus file info). hubdrive and hubcloud use
    their own flows; hubcdn uses the base64 reurl decode below."""
    if "hubdrive.tips" in file_url:
        return resolve_hubdrive(file_url)
    if "hubcloud." in file_url:
        return resolve_hubcloud(file_url)
    if file_url in RESOLVE_CACHE:
        cached = RESOLVE_CACHE[file_url]
        if isinstance(cached, dict):
            out = dict(cached)
            out["direct"] = unwrap_dl(out.get("direct"))
            return out
        # legacy: cache holds a bare dl wrapper string → unwrap it
        return {"direct": unwrap_dl(cached)}

    # Fetch the hubcdn page (retry once — these pages transiently fail or
    # occasionally omit the reurl marker on a slow/hot page).
    html = ""
    for attempt in range(2):
        try:
            req = urllib.request.Request(file_url, headers=UA)
            html = urllib.request.urlopen(req, timeout=40).read().decode("utf-8", "replace")
            if re.search(r'var\s+reurl\s*=\s*"', html, re.S):
                break
        except Exception:
            pass
        if attempt == 0:
            time.sleep(0.7)

    if not re.search(r'var\s+reurl\s*=\s*"', html, re.S):
        # transient failure — do NOT cache, the next search retries
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

    # sanity: a valid direct link must point at hubcdn.sbs/dl/
    if direct and "hubcdn.sbs/dl/" not in direct:
        direct = None

    result: dict = {"direct": None}
    if direct:
        bare = unwrap_dl(direct)
        # read the real file metadata straight from the origin bucket
        try:
            info = file_info(bare)
        except Exception:
            info = {"size": None, "filename": ""}
        result["direct"] = bare
        result["size"] = info["size"]
        result["filename"] = info["filename"]
        result["quality"] = parse_quality(info["filename"])

    if direct:
        # Only cache SUCCESSES. A transient fetch failure must not permanently
        # poison a link — the next search retries it and heals itself.
        RESOLVE_CACHE[file_url] = result
        save_cache()
    return result


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        # Health probe: lets the page detect whether it is running from the
        # local server (full resolution + pixeldrain proxy) or from static
        # hosting such as GitHub Pages (client-side caveats only).
        if self.path == "/api/ping":
            body = b'{"ok":true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if self.path.startswith("/api/resolve?"):
            from urllib.parse import urlparse, parse_qs, unquote
            qs = parse_qs(urlparse(self.path).query)
            target = (qs.get("url") or [""])[0]
            if not target:
                self.send_error(400, "missing url")
                return
            info = resolve_direct(target)
            if info is None:
                info = {"direct": None}
            body = json.dumps(info).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if self.path.startswith("/api/dl?"):
            # Streaming proxy for hosts that block browser hotlinking
            # (pixeldrain free tier). The server's request carries no
            # Referer and looks like a plain download manager, so the
            # file streams; the browser then receives a real attachment
            # download instead of a JSON error page.
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(self.path).query)
            src = (qs.get("src") or [""])[0]
            if not src or not src.startswith("https://") or "pixeldrain." not in src:
                self.send_error(400, "bad src")
                return
            hdrs = dict(UA)
            rng = self.headers.get("Range")
            if rng:
                hdrs["Range"] = rng
            try:
                up = urllib.request.urlopen(urllib.request.Request(src, headers=hdrs), timeout=60)
            except Exception as e:
                self.send_error(502, "upstream failed: %s" % e)
                return
            try:
                self.send_response(up.status)
                self.send_header("Content-Type", up.headers.get("Content-Type") or "application/octet-stream")
                cd = up.headers.get("Content-Disposition") or ""
                if not cd:
                    name = urllib.parse.unquote(src.rsplit("/", 1)[-1].split("?")[0])
                    if name:
                        cd = 'attachment; filename="%s"' % name.replace('"', "'")
                else:
                    cd = re.sub(r"^\s*inline", "attachment", cd, flags=re.I)
                self.send_header("Content-Disposition", cd)
                cl = up.headers.get("Content-Length")
                if cl:
                    self.send_header("Content-Length", cl)
                cr = up.headers.get("Content-Range")
                if cr:
                    self.send_header("Content-Range", cr)
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                try:
                    while True:
                        chunk = up.read(65536)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                except Exception:
                    pass  # client went away mid-download
            finally:
                up.close()
            return

        # Everything else: serve static files from this folder (like http.server)
        return super().do_GET()

    def log_message(self, format, *args):
        print("[%s] %s" % (self.address_string(), format % args))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Local server + hubcdn link resolver")
    parser.add_argument("port", nargs="?", type=int, default=8000)
    args = parser.parse_args()

    os.chdir(DIR)  # serve files from the folder where this script lives
    server = ThreadingHTTPServer(("", args.port), Handler)
    print("Serving at http://localhost:%s  (folder: %s)" % (args.port, DIR))
    print("Open: http://localhost:%s/" % args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")