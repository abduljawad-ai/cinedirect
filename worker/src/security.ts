export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
};

const ALLOWED_SCHEMES = ['http:', 'https:'];
const HOSTNAME_ALLOWLIST = [
  /^hubcdn\.sbs$/i,
  /^hubdrive\.tips$/i,
  /^hubcloud\.[a-z]+$/i,
  /^pixeldrain\.[a-z]+$/i,
  /^gamerxyt\.com$/i,
];

export function validateUrl(urlStr: string): URL | null {
  try {
    const url = new URL(urlStr);
    if (!ALLOWED_SCHEMES.includes(url.protocol)) return null;
    return url;
  } catch {
    return null;
  }
}

export function isAllowedHost(hostname: string): boolean {
  return HOSTNAME_ALLOWLIST.some((re) => re.test(hostname));
}

export function isPixeldrainUrl(src: string): boolean {
  try {
    const url = new URL(src);
    return url.protocol === 'https:' && /^pixeldrain\.[a-z]+$/.test(url.hostname);
  } catch {
    return false;
  }
}

export function buildCorsHeaders(origin: string | null, allowedOrigins?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Expose-Headers':
      'Content-Disposition, Content-Length, Content-Range, Accept-Ranges',
  };

  if (!allowedOrigins || allowedOrigins === '*') {
    headers['Access-Control-Allow-Origin'] = '*';
    return headers;
  }

  const allowed = allowedOrigins.split(',').map((s) => s.trim());
  if (origin && allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  } else {
    headers['Access-Control-Allow-Origin'] = allowed[0] || '*';
  }

  return headers;
}

// In-memory token bucket rate limiter, keyed by arbitrary string (e.g. IP).
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; lastRefill: number }>();
  private maxTokens: number;
  private refillRate: number; // tokens per ms
  private windowMs: number;

  constructor(opts: { maxTokens?: number; windowMs?: number } = {}) {
    this.maxTokens = opts.maxTokens ?? 20;
    this.windowMs = opts.windowMs ?? 60_000;
    this.refillRate = this.maxTokens / this.windowMs;
  }

  private refill(key: string): void {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket) {
      this.buckets.set(key, { tokens: this.maxTokens - 1, lastRefill: now });
      return;
    }
    const elapsed = now - bucket.lastRefill;
    const refill = elapsed * this.refillRate;
    bucket.tokens = Math.min(this.maxTokens, bucket.tokens + refill);
    bucket.lastRefill = now;
  }

  consume(key: string): { allowed: boolean; retryAfterMs: number } {
    this.refill(key);
    const bucket = this.buckets.get(key)!;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterMs: 0 };
    }
    const waitMs = Math.ceil((1 - bucket.tokens) / this.refillRate);
    return { allowed: false, retryAfterMs: waitMs };
  }
}

const IP_RATE_LIMITER = new RateLimiter();

export function checkRateLimit(ip: string): { allowed: boolean; retryAfterMs: number } {
  return IP_RATE_LIMITER.consume(ip);
}

export function getClientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}
