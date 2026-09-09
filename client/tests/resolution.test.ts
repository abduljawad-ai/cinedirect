import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  Resolver,
  hostTagOf,
  directHref,
  editionHubs,
} from '../src/core/resolution';
import type { EditionGroup, HubLink } from '@shared/types';

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

describe('editionHubs', () => {
  it('collects distinct hub links from every item in an edition', () => {
    const edition = {
      key: 'x',
      items: [
        {
          post: {
            direct: [
              { url: 'https://hubcdn.sbs/file/1', quality: '1080P', kind: 'hubcdn' },
              { url: 'https://hubcdn.sbs/file/2', quality: null, kind: 'hubcdn' },
            ],
          },
        },
        {
          post: {
            direct: [
              { url: 'https://hubcdn.sbs/file/1', quality: null, kind: 'hubcdn' },
              { url: 'https://pub-a.r2.dev/x.mkv', quality: null, kind: 'r2' },
            ],
          },
        },
      ],
    } as unknown as EditionGroup;

    expect(editionHubs(edition).map((h) => h.url)).toEqual([
      'https://hubcdn.sbs/file/1',
      'https://hubcdn.sbs/file/2',
      'https://pub-a.r2.dev/x.mkv',
    ]);
  });
});

describe('Resolver.resolveMany (relay mode)', () => {
  function batchResolver(overrides?: {
    fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  }): { resolver: Resolver; spy: ReturnType<typeof vi.fn> } {
    const resolver = new Resolver({
      mode: 'relay',
      relayUrl: '',
      apiFn: () => '/api/resolve',
    });
    const spy = vi.fn(
      overrides?.fetchImpl ??
        (async (_input: RequestInfo | URL, init?: RequestInit) => {
          if (init?.method === 'POST') {
            const body = JSON.parse(String(init.body)) as { urls: string[] };
            return new Response(
              JSON.stringify({
                results: body.urls.map((_u, i) => ({
                  direct: `https://pub-${i}.r2.dev/w.mkv`,
                  size: null,
                  filename: '',
                  quality: null,
                })),
              }),
              { status: 200 },
            );
          }
          return new Response('{}', { status: 404 });
        }),
    );
    vi.stubGlobal('fetch', spy);
    return { resolver, spy };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('batches multiple hub wrappers into a single POST, preserving order', async () => {
    const { resolver, spy } = batchResolver();
    const result = await resolver.resolveHubs(
      [
        { url: 'https://hubcdn.sbs/file/a', quality: '720P', kind: 'hubcdn' },
        { url: 'https://hubcdn.sbs/file/b', quality: '1080P', kind: 'hubcdn' },
      ],
      'arch',
    );
    expect(spy).toHaveBeenCalledTimes(1);
    const post = spy.mock.calls.find((c) => c[1]?.method === 'POST');
    expect(post).toBeDefined();
    expect(JSON.parse(String(post![1]!.body))).toEqual({
      urls: ['https://hubcdn.sbs/file/a', 'https://hubcdn.sbs/file/b'],
    });
    // rows carry the edition quality fallback and sort 1080P first
    expect(result.rows.map((r) => r.quality)).toEqual(['1080P', '720P']);
  });

  it('routes raw direct links client-side and batches wrappers in one POST', async () => {
    const { resolver, spy } = batchResolver();
    const rows = await resolver.resolveMany([
      'https://pub-a.r2.dev/raw.mkv',
      'https://hubcdn.sbs/file/x',
      'https://hubcdn.sbs/file/y',
      'https://pub-a.r2.dev/raw.mkv',
    ]);
    expect(rows).toHaveLength(4);
    expect(rows[0]?.direct).toBe('https://pub-a.r2.dev/raw.mkv');
    expect(rows[1]?.direct).toBe('https://pub-0.r2.dev/w.mkv');
    expect(rows[2]?.direct).toBe('https://pub-1.r2.dev/w.mkv');
    expect(rows[3]?.direct).toBe('https://pub-a.r2.dev/raw.mkv');
    expect(spy).toHaveBeenCalledTimes(1); // only the batch POST — raws need no fetch
    const post = spy.mock.calls.find((c) => c[1]?.method === 'POST');
    expect(JSON.parse(String(post![1]!.body))).toEqual({
      urls: ['https://hubcdn.sbs/file/x', 'https://hubcdn.sbs/file/y'],
    });
  });

  it('falls back to per-link resolution when the batch API fails', async () => {
    const { resolver } = batchResolver({
      fetchImpl: async (_input, init) => {
        if (init?.method === 'POST') {
          return new Response('boom', { status: 500 });
        }
        return new Response(
          JSON.stringify({
            direct: 'https://pub-1.r2.dev/x.mkv',
            size: null,
            filename: '',
            quality: null,
          }),
          { status: 200 },
        );
      },
    });
    const rows = await resolver.resolveMany([
      'https://hubcdn.sbs/file/a',
      'https://hubcdn.sbs/file/b',
    ]);
    expect(rows[0]?.direct).toBe('https://pub-1.r2.dev/x.mkv');
    expect(rows[1]?.direct).toBe('https://pub-1.r2.dev/x.mkv');
  });

  it('chunks batches larger than 20 URLs', async () => {
    const { resolver, spy } = batchResolver({
      fetchImpl: async (_input, init) => {
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as { urls: string[] };
          return new Response(
            JSON.stringify({
              results: body.urls.map((u) => ({
                direct: u,
                size: null,
                filename: '',
                quality: null,
              })),
            }),
            { status: 200 },
          );
        }
        return new Response('{}', { status: 404 });
      },
    });
    const urls = Array.from(
      { length: 21 },
      (_, i) => `https://hubcdn.sbs/file/${i}`,
    );
    const rows = await resolver.resolveMany(urls);
    const posts = spy.mock.calls.filter((c) => c[1]?.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(rows).toHaveLength(21);
    expect(rows.every((r) => !!r?.direct)).toBe(true);
    expect(JSON.parse(String(posts[1][1]!.body)).urls).toHaveLength(1);
  });

  it('does not call the batch API in static mode', async () => {
    const resolver = new Resolver({
      mode: 'static',
      relayUrl: '',
      apiFn: vi.fn(() => '/api/resolve'),
    });
    const apiFn = (resolver as unknown as { apiFn: ReturnType<typeof vi.fn> }).apiFn;
    const rows = await resolver.resolveMany([
      'https://pub-a.r2.dev/a.mkv',
      'https://pub-b.r2.dev/b.mkv',
    ]);
    expect(rows[0]?.direct).toBe('https://pub-a.r2.dev/a.mkv');
    expect(rows[1]?.direct).toBe('https://pub-b.r2.dev/b.mkv');
    expect(apiFn).not.toHaveBeenCalled();
  });
});

describe('Resolver.resolveEditionProgressive', () => {
  it('streams rows incrementally as each hub settles', async () => {
    const resolver = new Resolver({
      mode: 'static',
      relayUrl: '',
      apiFn: () => '',
    });
    const emissions: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ name: 'x.mkv', size: 1 }), {
          status: 200,
        }),
      ),
    );
    const hubs: HubLink[] = [
      { url: 'https://pixeldrain.dev/u/aaa', quality: '1080P', kind: 'pixeldrain' },
      { url: 'https://pixeldrain.dev/u/bbb', quality: '720P', kind: 'pixeldrain' },
    ];
    const rows = await resolver.resolveEditionProgressive(hubs, (partial) =>
      emissions.push(partial.length),
    );
    expect(emissions).toEqual([1, 2]);
    expect(rows.map((r) => r.quality)).toEqual(['1080P', '720P']);
    vi.unstubAllGlobals();
  });
});