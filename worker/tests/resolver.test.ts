import { describe, it, expect, vi, beforeEach } from 'vitest';
import { unwrapDl, parseQuality, resolveHubcdn, resolveHubdrive, resolveHubcloud, resolveDirect } from '../src/resolver';
import type { CacheStore } from '../src/cache';

function noopCache(): CacheStore {
  return {
    async get() { return null; },
    async set() {},
  };
}

describe('unwrapDl', () => {
  it('extracts link= param value', () => {
    expect(unwrapDl('https://hubcdn.sbs/dl/foo?link=https%3A%2F%2Fexample.com%2Ffile.mkv')).toBe('https://example.com/file.mkv');
  });

  it('returns raw URL when no link= param', () => {
    expect(unwrapDl('https://example.com/file.mkv')).toBe('https://example.com/file.mkv');
  });

  it('returns empty string for empty input', () => {
    expect(unwrapDl('')).toBe('');
  });

  it('handles malformed URI in link= gracefully', () => {
    expect(unwrapDl('https://hubcdn.sbs/dl?link=%ZZ')).toBe('%ZZ');
  });
});

describe('parseQuality', () => {
  it('detects quality from dot notation', () => {
    expect(parseQuality('Movie.1080p.BluRay.mkv')).toBe('1080P');
  });

  it('detects quality from bracket notation', () => {
    expect(parseQuality('Movie [4K] HDR.mkv').toUpperCase()).toBe('4K');
  });

  it('returns null for unknown quality', () => {
    expect(parseQuality('Movie.HDCAM.mkv')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(parseQuality(null)).toBeNull();
  });

  it('detects 2160p', () => {
    expect(parseQuality('Movie.2160p.WEB-DL.mkv')).toBe('2160P');
  });
});

describe('resolveHubcdn', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves hubcdn URL with base64 reurl', async () => {
    // The base64 `r=` param decodes to a hubcdn dl wrapper, which is then
    // unwrapped to the bare file URL via its `link=` param.
    const html =
      '<html><script>var reurl = "https://hubcdn.sbs/dl/abc?r=aHR0cHM6Ly9odWJjZG4uc2JzL2RsL3h5ej9saW5rPWh0dHBzJTNBJTJGJTJGZXhhbXBsZS5jb20lMkZmaWxlLm1rdg==";</script></html>';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(html),
      headers: new Headers({ 'Content-Type': 'text/html' }),
    }));

    const result = await resolveHubcdn('https://hubcdn.sbs/file/123', noopCache());
    expect(result.direct).toBe('https://example.com/file.mkv');
    expect(result.quality).toBeNull();
  });

  it('returns null direct when no reurl match', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('<html></html>'),
      headers: new Headers(),
    }));

    const result = await resolveHubcdn('https://hubcdn.sbs/file/123', noopCache());
    expect(result.direct).toBeNull();
  });
});

describe('resolveHubdrive', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves hubdrive URL via ajax', async () => {
    const mockJson = { code: '200', data: { gd: 'https://cdn.example.com/file.mkv', n: 'Movie.mkv', s: '1024000' } };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(''), headers: new Headers() })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockJson),
        headers: new Headers(),
      }),
    );

    const result = await resolveHubdrive('https://hubdrive.tips/file/12345', noopCache());
    expect(result.direct).toBe('https://cdn.example.com/file.mkv');
    expect(result.size).toBe(1024000);
    expect(result.filename).toBe('Movie.mkv');
  });

  it('returns null direct when ajax fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));

    const result = await resolveHubdrive('https://hubdrive.tips/file/12345', noopCache());
    expect(result.direct).toBeNull();
  });

  it('returns null direct when URL has no file ID', async () => {
    const result = await resolveHubdrive('https://hubdrive.tips/no-id', noopCache());
    expect(result.direct).toBeNull();
  });
});

describe('resolveHubcloud', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves hubcloud chain to pixeldrain', async () => {
    const html1 = '<html><a href="https://gamerxyt.com/hubcloud.php?token=abc"></a></html>';
    const html2 = '<html><script>var pxl = "https://pixeldrain.com/u/abc123";</script></html>';
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(html1), headers: new Headers() })
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(html2), headers: new Headers() })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Length': '5000', 'Content-Disposition': 'attachment; filename="Movie.mkv"' }),
      }),
    );

    const result = await resolveHubcloud('https://hubcloud.com/file/xyz', noopCache());
    expect(result.direct).toBe('https://pixeldrain.com/api/file/abc123');
    expect(result.size).toBe(5000);
    expect(result.filename).toBe('Movie.mkv');
  });

  it('returns null when gamerxyt link not found', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('<html></html>'),
      headers: new Headers(),
    }));

    const result = await resolveHubcloud('https://hubcloud.com/file/xyz', noopCache());
    expect(result.direct).toBeNull();
  });

  it('returns null when pixeldrain var not found', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('<html><a href="https://gamerxyt.com/hubcloud.php?t=1"></a></html>'), headers: new Headers() })
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('<html></html>'), headers: new Headers() }),
    );

    const result = await resolveHubcloud('https://hubcloud.com/file/xyz', noopCache());
    expect(result.direct).toBeNull();
  });
});

describe('resolveDirect', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('routes hubcdn URLs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('<html></html>'),
      headers: new Headers(),
    }));

    const result = await resolveDirect('https://hubcdn.sbs/file/1', noopCache());
    expect(result).not.toBeNull();
  });

  it('returns null for unsupported URLs', async () => {
    const result = await resolveDirect('https://example.com/file', noopCache());
    expect(result).toBeNull();
  });
});
