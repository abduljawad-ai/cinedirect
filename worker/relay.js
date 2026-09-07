// CineDirect relay — Cloudflare Worker.
//
// Port of hblinks-server.py's resolver + pixeldrain streaming proxy.
// GitHub Pages can't run Python, and hubcdn/hubdrive/hubcloud refuse CORS
// to browsers, so this worker does the resolving from Cloudflare's edge
// (no CORS wall) and proxies pixeldrain downloads past hotlink checks.
//
// Deploy:  npx wrangler deploy   (then put the workers.dev URL in
// index.html as the RELAY constant).
export default {
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (request.method === "OPTIONS") return preflight();
      if (url.pathname === "/api/ping") return json({ ok: true });
      if (url.pathname === "/api/resolve") {
        const target = url.searchParams.get("url") || "";
        if (!target) return json({ direct: null }, 400);
        const info = await resolveDirect(target);
        return json(info || { direct: null });
      }
      if (url.pathname === "/api/dl") {
        return proxyDownload(url.searchParams.get("src") || "", request);
      }
    } catch (e) {
      return json({ direct: null, error: String((e && e.message) || e) }, 500);
    }
    return new Response("CineDirect relay", { status: 200, headers: CORS_HEADERS });
  },
};

const UA = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};
const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

// Public JSON API consumed cross-origin (github.io -> workers.dev).
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers":
    "Content-Disposition, Content-Length, Content-Range, Accept-Ranges",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...CORS_HEADERS },
  });
}

// Browser preflight: the /api/dl GET carries a Range header, which is not
// a CORS-safelisted header, so Chromium sends an OPTIONS first.
function preflight() {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Range, Content-Type, X-Requested-With",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- entry: pick the right resolver ----------
async function resolveDirect(fileUrl) {
  if (!/^https?:\/\//i.test(fileUrl)) return null;
  try {
    if (fileUrl.includes("hubdrive.tips")) return await resolveHubdrive(fileUrl);
    if (fileUrl.includes("hubcloud.")) return await resolveHubcloud(fileUrl);
    if (fileUrl.includes("hubcdn.sbs/file")) return await resolveHubcdn(fileUrl);
  } catch (e) {
    return null;
  }
  return null;
}

// ---------- hubcdn: base64 reurl -> dl wrapper -> bare URL ----------
async function resolveHubcdn(fileUrl) {
  let html = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(fileUrl, { headers: UA, redirect: "follow" });
      html = await r.text();
      if (/var\s+reurl\s*=\s*"/.test(html)) break;
    } catch (e) {
      /* retry below */
    }
    if (attempt === 0) await sleep(700);
  }

  const m = /var\s+reurl\s*=\s*"([^"]+)"/s.exec(html);
  if (!m) return { direct: null };
  const reurl = m[1].replace(/\\\//g, "/");

  let direct = null;
  const mm = /[?&]r=([A-Za-z0-9+/=_\-]+)/.exec(reurl);
  if (mm) {
    const b64 = mm[1];
    const pad = (4 - (b64.length % 4)) % 4;
    try {
      direct = bufToStr(atobB64(b64 + "=".repeat(pad)));
    } catch (e) {
      direct = null;
    }
  } else if (reurl.includes("hubcdn.sbs/dl/")) {
    direct = reurl;
  }
  if (direct && !direct.includes("hubcdn.sbs/dl/")) direct = null;
  if (!direct) return { direct: null };

  const bare = unwrapDl(direct);
  const info = await fileInfo(bare);
  return {
    direct: bare,
    size: info.size,
    filename: info.filename,
    quality: parseQuality(info.filename),
  };
}

function unwrapDl(url) {
  if (!url) return url;
  const m = /link=([^&]+)/.exec(url);
  if (!m) return url;
  let v = m[1];
  try {
    v = decodeURIComponent(v);
  } catch (e) {
    /* keep as-is */
  }
  return v;
}

function atobB64(s) {
  return atob(s.replace(/-/g, "+").replace(/_/g, "/"));
}

function bufToStr(bytes) {
  return new TextDecoder().decode(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes, (c) => c.charCodeAt(0)));
}

// ---------- hubdrive: ajax direct-download ----------
async function resolveHubdrive(fileUrl) {
  const m = /\/file\/(\d+)/.exec(fileUrl);
  if (!m) return { direct: null };
  const fid = m[1];
  const base = fileUrl.slice(0, fileUrl.indexOf("/file/"));
  try {
    await fetch(fileUrl, { headers: UA, redirect: "follow" }); // warm up like a browser
  } catch (e) {
    /* continue anyway */
  }
  try {
    const r = await fetch(base + "/ajax.php?ajax=direct-download", {
      method: "POST",
      headers: {
        "User-Agent": UA["User-Agent"],
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json, text/javascript, */*; q=0.01",
        Referer: fileUrl,
        Origin: base,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "id=" + encodeURIComponent(fid),
    });
    const data = await r.json();
    if (data && data.code === "200" && data.data && data.data.gd) {
      const d = data.data;
      const filename = d.n || "";
      let size = null;
      if (/^\d+$/.test(String(d.s || ""))) size = parseInt(d.s, 10);
      return { direct: d.gd, size, filename, quality: parseQuality(filename) };
    }
  } catch (e) {
    /* fall through */
  }
  return { direct: null };
}

// ---------- hubcloud: drive -> gamerxyt -> pixeldrain ----------
async function resolveHubcloud(fileUrl) {
  let html;
  try {
    const r1 = await fetch(fileUrl, { headers: UA, redirect: "follow" });
    html = await r1.text();
  } catch (e) {
    return { direct: null };
  }
  const m = /href="(https:\/\/gamerxyt\.com\/hubcloud\.php[^"]+)"/.exec(html);
  if (!m) return { direct: null };
  let html2;
  try {
    const r2 = await fetch(m[1], { headers: UA, redirect: "follow" });
    html2 = await r2.text();
  } catch (e) {
    return { direct: null };
  }
  const m2 = /var\s+pxl\s*=\s*"(https:\/\/pixeldrain\.[a-z]+\/u\/[A-Za-z0-9]+)"/.exec(html2);
  if (!m2) return { direct: null };
  const direct = m2[1].replace("/u/", "/api/file/");
  const info = await fileInfo(direct);
  return {
    direct,
    size: info.size,
    filename: info.filename,
    quality: parseQuality(info.filename),
  };
}

// ---------- file metadata via HEAD (or 1-byte range GET) ----------
async function fileInfo(directUrl) {
  const parse = (resp) => {
    let length = resp.headers.get("Content-Length");
    const cr = resp.headers.get("Content-Range") || "";
    const mmc = /\/(\d+)\s*$/.exec(cr);
    if (mmc) length = mmc[1];
    const cd = resp.headers.get("Content-Disposition") || "";
    let name = "";
    const m1 = /filename\*=UTF-8''([^;]+)/.exec(cd);
    if (m1) {
      try {
        name = decodeURIComponent(m1[1]);
      } catch (e) {
        name = m1[1];
      }
    } else {
      const m2 = /filename="([^"]+)"/.exec(cd);
      if (m2) name = m2[1];
    }
    let size = null;
    if (length != null && /^\d+$/.test(String(length))) size = parseInt(length, 10);
    return { size, filename: name };
  };
  try {
    const r = await fetch(directUrl, { method: "HEAD", headers: UA });
    if (r.ok) return parse(r);
  } catch (e) {
    /* fall through */
  }
  try {
    const r = await fetch(directUrl, { headers: { ...UA, Range: "bytes=0-0" } });
    if (r.ok) return parse(r);
  } catch (e) {
    /* fall through */
  }
  return { size: null, filename: "" };
}

function parseQuality(filename) {
  const lower = (filename || "").toLowerCase();
  const m =
    /\.(480p|720p|1080p|2160p|4k)\b/.exec(lower) ||
    /\[(480p|720p|1080p|2160p|4k)\]/.exec(lower);
  return m ? m[1].toUpperCase() : null;
}

// ---------- pixeldrain streaming proxy (hotlink bypass) ----------
async function proxyDownload(src, request) {
  if (!src.startsWith("https://") || !src.includes("pixeldrain.")) {
    return new Response("bad src", { status: 400 });
  }
  const headers = { "User-Agent": UA["User-Agent"] };
  const rng = request.headers.get("Range");
  if (rng) headers["Range"] = rng;
  let up;
  try {
    up = await fetch(src, { headers, redirect: "follow" });
  } catch (e) {
    return new Response("upstream failed", { status: 502 });
  }
  const out = new Headers();
  out.set("Content-Type", up.headers.get("Content-Type") || "application/octet-stream");
  let cd = up.headers.get("Content-Disposition") || "";
  if (!cd) {
    const name = decodeURIComponent(src.split("?")[0].split("/").pop() || "");
    cd = 'attachment; filename="' + name.replace(/"/g, "'") + '"';
  } else {
    cd = cd.replace(/^\s*inline/i, "attachment");
  }
  out.set("Content-Disposition", cd);
  for (const h of ["Content-Length", "Content-Range"]) {
    const v = up.headers.get(h);
    if (v) out.set(h, v);
  }
  out.set("Accept-Ranges", "bytes");
  out.set("Cache-Control", "no-store");
  for (const h of ["Access-Control-Allow-Origin", "Access-Control-Expose-Headers"]) {
    out.set(h, CORS_HEADERS[h]);
  }
  return new Response(up.body, { status: up.status, headers: out });
}