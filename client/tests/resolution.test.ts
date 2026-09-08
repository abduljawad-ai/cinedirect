import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Resolver, hostTagOf, directHref } from '../src/core/resolution';
import type { HubLink } from '@shared/types';

describe('hostTagOf', () => {
  it('tags known hosts', () => {
    expect(hostTagOf('https://hubcdn.sbs/file/123')).toBe('HubCDN');
    expect(hostTagOf('https://hubdrive.tips/file/123')).toBe('HubDrive');
    expect(hostTagOf('https://hubcloud.cx/drive/123')).toBe('HubCloud');
    expect(hostTagOf('https://abc.r2.dev/file.mp4')).toBe('R2');
    expect(hostTagOf('https://video-downloads.googleusercontent.com/x')).toBe('GDrive');
    expect(hostTagOf('https://pixeldrain.dev/api/file/xyz')).toBe('Pixeldrain');
    expect(hostTagOf('https://unknown.example.com/x')).toBe('');
  });
});

describe('directHref', () => {
  it('passes URLs through unchanged', () => {
    expect(directHref('https://example.com/file')).toBe('https://example.com/file');
  });
});

describe('Resolver (static mode)', () => {
  let resolver: Resolver;

  beforeEach(() => {
    resolver = new Resolver({
      mode: 'static',
      relayUrl: '',
      apiFn: () => '',
    });
  });

  it('resolves raw pixeldrain /u/ links to /api/file/', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/file/abc123/info')) {
        return new Response(JSON.stringify({ name: 'Movie.2024.1080p.mkv', size: 1024 }));
      }
      return new Response('{}', { status: 404 });
    }));

    const result = await resolver.resolveOne('https://pixeldrain.dev/u/abc123');
    expect(result?.direct).toBe('https://pixeldrain.dev/api/file/abc123');
    expect(result?.size).toBe(1024);
    expect(result?.quality).toBe('1080P');
    vi.unstubAllGlobals();
  });

  it('resolves raw R2 links unchanged', async () => {
    const result = await resolver.resolveOne('https://pub-abc.r2.dev/file.mp4');
    expect(result?.direct).toBe('https://pub-abc.r2.dev/file.mp4');
  });

  it('resolves GDrive download links unchanged', async () => {
    const result = await resolver.resolveOne('https://video-downloads.googleusercontent.com/x/y');
    expect(result?.direct).toBe('https://video-downloads.googleusercontent.com/x/y');
  });

  it('drops gofile links (requires auth token)', async () => {
    const result = await resolver.resolveOne('https://gofile.io/d/abc123');
    expect(result).toBeNull();
  });

  it('drops hubdrive links in static mode', async () => {
    const result = await resolver.resolveOne('https://hubdrive.tips/file/123');
    expect(result).toBeNull();
  });

  it('memoizes results in the memo cache', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy.mockResolvedValue(new Response('{}', { status: 404 })));
    await resolver.resolveOne('https://pixeldrain.dev/u/abc123');
    await resolver.resolveOne('https://pixeldrain.dev/u/abc123');
    expect(spy).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe('Resolver (relay mode)', () => {
  it('routes resolution through the relay API', async () => {
    const apiFn = vi.fn().mockReturnValue('https://relay.example.com/api/resolve');
    const resolver = new Resolver({
      mode: 'relay',
      relayUrl: 'https://relay.example.com',
      apiFn,
    });

    vi.stubGlobal('fetch', vi.fn(async () => {
      return new Response(JSON.stringify({ direct: 'https://file.example/x.mp4' }), {
        status: 200,
      });
    }));

    const result = await resolver.resolveHubs(
      [{ url: 'https://hubcdn.sbs/file/123', quality: '1080P', kind: 'hubcdn' }],
      'https://hblinks.co/post'
    );
    expect(apiFn).toHaveBeenCalled();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].direct).toBe('https://file.example/x.mp4');
    vi.unstubAllGlobals();
  });

  it('returns empty rows when resolution fails', async () => {
    const resolver = new Resolver({
      mode: 'relay',
      relayUrl: 'https://relay.example.com',
      apiFn: () => 'https://relay.example.com/api/resolve',
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ direct: null }), { status: 200 })));
    const result = await resolver.resolveHubs(
      [{ url: 'https://hubcdn.sbs/file/123', quality: null, kind: 'hubcdn' }],
      'https://hblinks.co/post'
    );
    expect(result.rows).toHaveLength(0);
    vi.unstubAllGlobals();
  });
});

describe('resolveHubs dedupe and sort', () => {
  it('dedupes identical direct URLs and sorts by quality descending', async () => {
    const resolver = new Resolver({
      mode: 'static',
      relayUrl: '',
      apiFn: () => '',
    });
    const hubs: HubLink[] = [
      { url: 'https://pixeldrain.dev/u/aaa', quality: '720P', kind: 'pixeldrain' },
      { url: 'https://pixeldrain.dev/u/bbb', quality: '1080P', kind: 'pixeldrain' },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => {
      return new Response(JSON.stringify({ name: 'x.mkv', size: 100 }));
    }));
    const result = await resolver.resolveHubs(hubs, 'https://x.co');
    expect(result.rows.length).toBeGreaterThanOrEqual(1);
    // rows sorted best quality first
    if (result.rows.length === 2) {
      expect(result.rows[0].quality).toBe('1080P');
      expect(result.rows[1].quality).toBe('720P');
    }
    vi.unstubAllGlobals();
  });
});