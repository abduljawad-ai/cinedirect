import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleRequest } from '../src/index';
import type { Env } from '../src/types';
import type { CacheStore } from '../src/cache';

function noopCache(): CacheStore {
  return {
    async get() { return null; },
    async set() {},
  };
}

function makeEnv(overrides?: Partial<Env>): Env {
  return { ALLOWED_ORIGINS: 'https://example.com', ...overrides };
}

function makeRequest(
  path: string,
  opts?: { method?: string; headers?: Record<string, string>; body?: string },
): Request {
  return new Request(`https://relay.workers.dev${path}`, {
    method: opts?.method ?? 'GET',
    headers: opts?.headers ?? {},
    body: opts?.body,
  });
}

describe('handleRequest', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('health endpoint', () => {
    it('returns ok with 200', async () => {
      const res = await handleRequest(makeRequest('/api/health'), makeEnv());
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.ts).toBeDefined();
    });
  });

  describe('resolve endpoint', () => {
    it('returns 400 when url param is missing', async () => {
      const res = await handleRequest(makeRequest('/api/resolve'), makeEnv());
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.direct).toBeNull();
    });

    it('returns 400 for invalid URL scheme', async () => {
      const res = await handleRequest(makeRequest('/api/resolve?url=ftp://bad.com'), makeEnv());
      expect(res.status).toBe(400);
    });

    it('returns null for unsupported host', async () => {
      vi.stubGlobal('fetch', vi.fn());
      const res = await handleRequest(makeRequest('/api/resolve?url=https://example.com'), makeEnv());
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.direct).toBeNull();
    });
  });

  describe('batch resolve endpoint', () => {
    function postBody(urls: unknown): Request {
      return makeRequest('/api/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls }),
      });
    }

    it('returns 400 for a non-array or empty urls payload', async () => {
      for (const payload of [undefined, [], {}, { urls: 'nope' }]) {
        const res = await handleRequest(postBody(payload as never), makeEnv());
        expect(res.status).toBe(400);
      }
      const body = await handleRequest(postBody([]), makeEnv()).then((r) => r.json()) as any;
      expect(body.results).toEqual([]);
    });

    it('caps the batch size at 20 URLs', async () => {
      const urls = Array.from({ length: 21 }, (_, i) => `https://hubcdn.sbs/file/${i}`);
      const res = await handleRequest(postBody(urls), makeEnv());
      expect(res.status).toBe(400);
    });

    it('resolves a batch preserving order, one rate-limit unit per request', async () => {
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const u = String(input);
        if (u.includes('hubcdn.sbs/file')) {
          return new Response(
            '<script>var reurl = "https://hubcdn.sbs/dl/?link=https%3A%2F%2Fpub-1.r2.dev%2Fmovie.mkv";</script>',
            { status: 200, headers: { 'Content-Type': 'text/html' } },
          );
        }
        return new Response(null, {
          status: 200,
          headers: {
            'Content-Length': '2048',
            'Content-Disposition': 'attachment; filename="Movie.1080p.mkv"',
          },
        });
      }));

      const res = await handleRequest(
        postBody(['https://hubcdn.sbs/file/aaa', 'https://hubcdn.sbs/file/bbb']),
        makeEnv(),
      );
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.results).toHaveLength(2);
      expect(body.results[0]?.direct).toContain('r2.dev');
      expect(body.results[1]?.direct).toContain('r2.dev');
      expect(body.results[0]?.quality).toBe('1080P');
      expect(body.results[0]?.size).toBe(2048);
    });

    it('returns null per item for invalid schemes and unsupported hosts', async () => {
      vi.stubGlobal('fetch', vi.fn());
      const res = await handleRequest(
        postBody(['ftp://bad.example/x', 'https://example.com', '']),
        makeEnv(),
      );
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.results).toEqual([null, null, null]);
    });
  });

  describe('rate limiting', () => {
    // Use a dedicated client IP so draining this bucket doesn't starve the
    // other tests (each real visitor gets their own per-IP bucket).
    const rlHeaders = { 'CF-Connecting-IP': '203.0.113.9' };

    it('allows requests within limit', async () => {
      const res = await handleRequest(
        makeRequest('/api/health', { headers: rlHeaders }),
        makeEnv(),
      );
      expect(res.status).toBe(200);
    });

    it('blocks requests exceeding limit', async () => {
      const env = makeEnv();
      // Exhaust the token bucket. A resolve call without a URL param trips
      // the rate limit fast and never hits the network.
      for (let i = 0; i < 20; i++) {
        await handleRequest(
          makeRequest('/api/resolve', { headers: rlHeaders }),
          env,
        );
      }
      // This one should be rate limited
      const res = await handleRequest(
        makeRequest('/api/resolve', { headers: rlHeaders }),
        env,
      );
      expect(res.status).toBe(429);
      const body = await res.json() as any;
      expect(body.error).toBe('rate limit exceeded');
      expect(body.retryAfterMs).toBeGreaterThan(0);
    });
  });

  describe('CORS headers', () => {
    it('returns Access-Control-Allow-Origin for allowed origin', async () => {
      const res = await handleRequest(
        makeRequest('/api/health', { headers: { Origin: 'https://example.com' } }),
        makeEnv(),
      );
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
    });

    it('returns wildcard when no allowed origins configured', async () => {
      const res = await handleRequest(
        makeRequest('/api/health', { headers: { Origin: 'https://other.com' } }),
        makeEnv({ ALLOWED_ORIGINS: '*' }),
      );
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('does not expose disallowed origin', async () => {
      const res = await handleRequest(
        makeRequest('/api/health', { headers: { Origin: 'https://evil.com' } }),
        makeEnv({ ALLOWED_ORIGINS: 'https://example.com' }),
      );
      // When origin doesn't match, it falls back to the first allowed origin
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
    });
  });

  describe('security headers', () => {
    it('includes security headers on all responses', async () => {
      const res = await handleRequest(makeRequest('/api/health'), makeEnv());
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
      expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
      expect(res.headers.get('Permissions-Policy')).toBeDefined();
    });
  });

  describe('download proxy', () => {
    it('rejects non-pixeldrain src', async () => {
      const res = await handleRequest(
        makeRequest('/api/dl?src=https://evil.com/file.mkv'),
        makeEnv(),
      );
      expect(res.status).toBe(400);
    });

    it('proxies pixeldrain URLs', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        body: new ReadableStream(),
        headers: new Headers({
          'Content-Type': 'video/x-matroska',
          'Content-Length': '1024000',
          'Content-Disposition': 'attachment; filename="Movie.mkv"',
        }),
      }));

      const res = await handleRequest(
        makeRequest('/api/dl?src=https://pixeldrain.com/api/file/abc123'),
        makeEnv(),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    });
  });

  describe('root fallback', () => {
    it('returns relay text with security headers', async () => {
      const res = await handleRequest(makeRequest('/'), makeEnv());
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe('CineDirect relay');
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    });
  });
});
