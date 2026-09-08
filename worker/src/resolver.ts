import type { CacheStore } from './cache';
import { createCacheStore } from './cache';
import type { ResolveResult, FileInfo, Quality } from './types';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function atobB64(s: string): string {
  return atob(s.replace(/-/g, '+').replace(/_/g, '/'));
}

function bufToStr(input: string): string {
  return new TextDecoder().decode(
    Uint8Array.from(input, (c) => c.charCodeAt(0)),
  );
}

export function unwrapDl(url: string): string {
  if (!url) return url;
  const m = /link=([^&]+)/.exec(url);
  if (!m) return url;
  let v = m[1];
  try {
    v = decodeURIComponent(v);
  } catch {
    /* keep as-is */
  }
  return v;
}

const QUALITY_RE = /\.(480p|720p|1080p|2160p|4k)\b|\[(480p|720p|1080p|2160p|4k)\]/i;

export function parseQuality(filename: string | null): Quality | null {
  const m = QUALITY_RE.exec(filename || '');
  if (!m) return null;
  return m[1]?.toUpperCase() as Quality ?? m[2]?.toUpperCase() as Quality ?? null;
}

export async function fileInfo(
  directUrl: string,
  cache?: CacheStore,
): Promise<FileInfo> {
  const cacheKey = `fi:${directUrl}`;
  if (cache) {
    const cached = await cache.get(cacheKey);
    if (cached) return JSON.parse(cached);
  }

  const parse = (resp: Response): FileInfo => {
    let length = resp.headers.get('Content-Length');
    const cr = resp.headers.get('Content-Range') || '';
    const mmc = /\/(\d+)\s*$/.exec(cr);
    if (mmc) length = mmc[1];
    const cd = resp.headers.get('Content-Disposition') || '';
    let name = '';
    const m1 = /filename\*=UTF-8''([^;]+)/.exec(cd);
    if (m1) {
      try { name = decodeURIComponent(m1[1]); } catch { name = m1[1]; }
    } else {
      const m2 = /filename="([^"]+)"/.exec(cd);
      if (m2) name = m2[1];
    }
    let size: number | null = null;
    if (length != null && /^\d+$/.test(length)) size = parseInt(length, 10);
    return { size, filename: name };
  };

  const headers = { 'User-Agent': UA };

  try {
    const r = await fetch(directUrl, { method: 'HEAD', headers });
    if (r.ok) {
      const info = parse(r);
      if (cache) await cache.set(cacheKey, JSON.stringify(info), 60_000);
      return info;
    }
  } catch { /* fall through */ }

  try {
    const r = await fetch(directUrl, { headers: { ...headers, Range: 'bytes=0-0' } });
    if (r.ok) {
      const info = parse(r);
      if (cache) await cache.set(cacheKey, JSON.stringify(info), 60_000);
      return info;
    }
  } catch { /* fall through */ }

  return { size: null, filename: '' };
}

// ---------- hubcdn: base64 reurl -> dl wrapper -> bare URL ----------
export async function resolveHubcdn(
  fileUrl: string,
  cache?: CacheStore,
): Promise<ResolveResult> {
  const cacheKey = `hcdn:${fileUrl}`;
  if (cache) {
    const cached = await cache.get(cacheKey);
    if (cached) return JSON.parse(cached);
  }

  let html = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(fileUrl, { headers: { 'User-Agent': UA }, redirect: 'follow' });
      html = await r.text();
      if (/var\s+reurl\s*=\s*"/.test(html)) break;
    } catch { /* retry */ }
    if (attempt === 0) await sleep(700);
  }

  const m = /var\s+reurl\s*=\s*"([^"]+)"/s.exec(html);
  if (!m) return { direct: null, size: null, filename: null, quality: null };
  const reurl = m[1].replace(/\\\//g, '/');

  let direct: string | null = null;
  const mm = /[?&]r=([A-Za-z0-9+/=_-]+)/.exec(reurl);
  if (mm) {
    const b64 = mm[1];
    const pad = (4 - (b64.length % 4)) % 4;
    try {
      direct = bufToStr(atobB64(b64 + '='.repeat(pad)));
    } catch {
      direct = null;
    }
  } else if (reurl.includes('hubcdn.sbs/dl/')) {
    direct = reurl;
  }
  if (direct && !direct.includes('hubcdn.sbs/dl/')) direct = null;
  if (!direct) return { direct: null, size: null, filename: null, quality: null };

  const bare = unwrapDl(direct);
  const info = await fileInfo(bare, cache);
  const result: ResolveResult = {
    direct: bare,
    size: info.size,
    filename: info.filename,
    quality: parseQuality(info.filename),
  };
  if (cache) await cache.set(cacheKey, JSON.stringify(result), 5 * 60_000);
  return result;
}

// ---------- hubdrive: ajax direct-download ----------
export async function resolveHubdrive(
  fileUrl: string,
  cache?: CacheStore,
): Promise<ResolveResult> {
  const cacheKey = `hdrive:${fileUrl}`;
  if (cache) {
    const cached = await cache.get(cacheKey);
    if (cached) return JSON.parse(cached);
  }

  const m = /\/file\/(\d+)/.exec(fileUrl);
  if (!m) return { direct: null, size: null, filename: null, quality: null };
  const fid = m[1];
  const base = fileUrl.slice(0, fileUrl.indexOf('/file/'));

  try {
    await fetch(fileUrl, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  } catch { /* continue anyway */ }

  try {
    const r = await fetch(`${base}/ajax.php?ajax=direct-download`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        Referer: fileUrl,
        Origin: base,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `id=${encodeURIComponent(fid)}`,
    });
    const data: any = await r.json();
    if (data && data.code === '200' && data.data?.gd) {
      const d = data.data;
      const filename: string = d.n || '';
      let size: number | null = null;
      if (/^\d+$/.test(String(d.s || ''))) size = parseInt(d.s, 10);
      const result: ResolveResult = {
        direct: d.gd,
        size,
        filename,
        quality: parseQuality(filename),
      };
      if (cache) await cache.set(cacheKey, JSON.stringify(result), 5 * 60_000);
      return result;
    }
  } catch { /* fall through */ }

  return { direct: null, size: null, filename: null, quality: null };
}

// ---------- hubcloud: drive -> gamerxyt -> pixeldrain ----------
export async function resolveHubcloud(
  fileUrl: string,
  cache?: CacheStore,
): Promise<ResolveResult> {
  const cacheKey = `hcloud:${fileUrl}`;
  if (cache) {
    const cached = await cache.get(cacheKey);
    if (cached) return JSON.parse(cached);
  }

  let html: string;
  try {
    const r1 = await fetch(fileUrl, { headers: { 'User-Agent': UA }, redirect: 'follow' });
    html = await r1.text();
  } catch {
    return { direct: null, size: null, filename: null, quality: null };
  }

  const m = /href="(https:\/\/gamerxyt\.com\/hubcloud\.php[^"]+)"/.exec(html);
  if (!m) return { direct: null, size: null, filename: null, quality: null };

  let html2: string;
  try {
    const r2 = await fetch(m[1], { headers: { 'User-Agent': UA }, redirect: 'follow' });
    html2 = await r2.text();
  } catch {
    return { direct: null, size: null, filename: null, quality: null };
  }

  const m2 = /var\s+pxl\s*=\s*"(https:\/\/pixeldrain\.[a-z]+\/u\/[A-Za-z0-9]+)"/.exec(html2);
  if (!m2) return { direct: null, size: null, filename: null, quality: null };

  const direct = m2[1].replace('/u/', '/api/file/');
  const info = await fileInfo(direct, cache);
  const result: ResolveResult = {
    direct,
    size: info.size,
    filename: info.filename,
    quality: parseQuality(info.filename),
  };
  if (cache) await cache.set(cacheKey, JSON.stringify(result), 5 * 60_000);
  return result;
}

// ---------- entry: pick the right resolver ----------
export async function resolveDirect(
  fileUrl: string,
  cache?: CacheStore,
): Promise<ResolveResult | null> {
  const c = cache ?? createCacheStore();
  try {
    if (fileUrl.includes('hubdrive.tips')) return await resolveHubdrive(fileUrl, c);
    if (fileUrl.includes('hubcloud.')) return await resolveHubcloud(fileUrl, c);
    if (fileUrl.includes('hubcdn.sbs/file')) return await resolveHubcdn(fileUrl, c);
  } catch {
    return null;
  }
  return null;
}
