import { resolveDirect } from './resolver';
import { createCacheStore, type CacheStore } from './cache';
import type { Env } from './types';
import {
  SECURITY_HEADERS,
  buildCorsHeaders,
  checkRateLimit,
  getClientIp,
  isPixeldrainUrl,
  validateUrl,
} from './security';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

function json(data: unknown, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': JSON_CONTENT_TYPE,
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
      ...corsHeaders,
    },
  });
}

function preflight(corsHeaders: Record<string, string>): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...SECURITY_HEADERS,
      ...corsHeaders,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Range, Content-Type, X-Requested-With',
      'Access-Control-Max-Age': '86400',
    },
  });
}

async function proxyDownload(
  src: string,
  request: Request,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  if (!isPixeldrainUrl(src)) {
    return new Response(JSON.stringify({ error: 'bad src' }), {
      status: 400,
      headers: { 'Content-Type': JSON_CONTENT_TYPE, ...SECURITY_HEADERS, ...corsHeaders },
    });
  }

  const headers: Record<string, string> = { 'User-Agent': UA };
  const rng = request.headers.get('Range');
  if (rng) headers['Range'] = rng;

  let up: Response;
  try {
    up = await fetch(src, { headers, redirect: 'follow' });
  } catch {
    return new Response(JSON.stringify({ error: 'upstream failed' }), {
      status: 502,
      headers: { 'Content-Type': JSON_CONTENT_TYPE, ...SECURITY_HEADERS, ...corsHeaders },
    });
  }

  const out = new Headers();
  out.set('Content-Type', up.headers.get('Content-Type') || 'application/octet-stream');
  let cd = up.headers.get('Content-Disposition') || '';
  if (!cd) {
    const name = decodeURIComponent(src.split('?')[0].split('/').pop() || '');
    cd = `attachment; filename="${name.replace(/"/g, "'")}"`;
  } else {
    cd = cd.replace(/^\s*inline/i, 'attachment');
  }
  out.set('Content-Disposition', cd);
  for (const h of ['Content-Length', 'Content-Range']) {
    const v = up.headers.get(h);
    if (v) out.set(h, v);
  }
  out.set('Accept-Ranges', 'bytes');
  out.set('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.set(k, v);
  for (const [k, v] of Object.entries(corsHeaders)) out.set(k, v);

  return new Response(up.body, { status: up.status, headers: out });
}

const DEFAULT_CACHE = createCacheStore();

export async function handleRequest(
  request: Request,
  env: Env,
  cache: CacheStore = DEFAULT_CACHE,
): Promise<Response> {
  const url = new URL(request.url);

  // Validate Host header to prevent host header injection
  const host = request.headers.get('Host');
  if (host && url.hostname !== host.split(':')[0]) {
    return json({ error: 'invalid host' }, 403, {});
  }

  const origin = request.headers.get('Origin');
  const corsHeaders = buildCorsHeaders(origin, env.ALLOWED_ORIGINS);

  if (request.method === 'OPTIONS') return preflight(corsHeaders);

  // Health check (no rate limit, no auth)
  if (url.pathname === '/api/health') {
    return json({ ok: true, ts: Date.now() }, 200, corsHeaders);
  }

  // Resolve endpoint (rate limited)
  if (url.pathname === '/api/resolve') {
    const ip = getClientIp(request);
    const rl = checkRateLimit(ip);
    if (!rl.allowed) {
      return json({ error: 'rate limit exceeded', retryAfterMs: rl.retryAfterMs }, 429, corsHeaders);
    }

    const target = url.searchParams.get('url') || '';
    if (!target) return json({ direct: null }, 400, corsHeaders);

    const parsed = validateUrl(target);
    if (!parsed) return json({ direct: null, error: 'invalid url scheme' }, 400, corsHeaders);

    const info = await resolveDirect(parsed.href, cache);
    return json(info || { direct: null }, 200, corsHeaders);
  }

  // Download proxy (rate limited, pixeldrain only)
  if (url.pathname === '/api/dl') {
    const ip = getClientIp(request);
    const rl = checkRateLimit(ip);
    if (!rl.allowed) {
      return json({ error: 'rate limit exceeded', retryAfterMs: rl.retryAfterMs }, 429, corsHeaders);
    }

    const src = url.searchParams.get('src') || '';
    return proxyDownload(src, request, corsHeaders);
  }

  // Root / fallback
  return new Response('CineDirect relay', {
    status: 200,
    headers: { ...SECURITY_HEADERS, ...corsHeaders },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (e: any) {
      const origin = request.headers.get('Origin');
      const corsHeaders = buildCorsHeaders(origin, env.ALLOWED_ORIGINS);
      return json(
        { direct: null, error: String(e?.message || e) },
        500,
        corsHeaders,
      );
    }
  },
};
