import { describe, it, expect } from 'vitest';
import {
  parseTitle,
  parseEdition,
  parseSeasonal,
  parseSearchHints,
  parseFilenameTags,
  baseTitle,
  normKey,
  editionKeyOf,
  formatBytes,
  stripHtml,
  esc,
} from '../src/core/parsing';
import type { ReleaseItem, Post } from '@shared/types';

function makePost(title: string): Post {
  return {
    id: Math.floor(Math.random() * 1e6),
    title,
    link: `https://hblinks.co/${title}`,
    date: '2024-01-01T00:00:00',
    direct: [],
    allLinks: [],
  };
}

describe('parseTitle', () => {
  it('extracts name, year, and qualities', () => {
    const r = parseTitle('Inception.2010.1080p.BluRay.x264');
    expect(r.name).toContain('Inception');
    expect(r.year).toBe('2010');
    expect(r.qualities).toContain('1080P');
  });

  it('deduplicates qualities', () => {
    const r = parseTitle('Jeevan.2024.1080p.720p.HDRip');
    expect(r.qualities).toEqual(['1080P', '720P']);
  });

  it('returns empty quality list when absent', () => {
    const r = parseTitle('Some.Movie');
    expect(r.qualities).toEqual([]);
    expect(r.year).toBe('');
  });

  it('strips release-group and quality tags for a clean show name', () => {
    // hblinks.co titles carry "WEB-DL" and "HDHub4u" tags; hyphens are
    // normalised to dots mid-parse, so both dotted and dashed tokens must
    // be treated as noise when cleaning the name.
    const r = parseTitle('Silo S01E01 1080p WEB-DL HDHub4u');
    expect(r.name).toBe('Silo S01E01');
    expect(baseTitle(r.name)).toBe('Silo');
  });
});

describe('parseEdition', () => {
  it('detects dual audio', () => {
    expect(parseEdition('Zootopia 2024 Dual Audio 1080p').edition).toBe('dual audio');
  });

  it('detects explicit languages', () => {
    expect(parseEdition('Jeevan 2024 Hindi 1080p').edition).toBe('hindi');
    expect(parseEdition('Jeevan 2024 Tamil 720p').edition).toBe('tamil');
  });

  it('defaults to empty edition for English', () => {
    expect(parseEdition('Silo S03E01 1080p English').edition).toBe('');
  });

  it('detects subtitles', () => {
    const r = parseEdition('Silo S03E01 1080p Eng Subs');
    expect(r.subs).toBe('eng sub');
  });
});

describe('parseSeasonal', () => {
  it('parses a standalone episode', () => {
    expect(parseSeasonal('Silo S03E10 1080p')).toEqual({
      season: 3,
      episode: 10,
      isSeasonPack: false,
    });
  });

  it('parses a season pack', () => {
    expect(parseSeasonal('Silo S03 1080p')).toEqual({
      season: 3,
      episode: null,
      isSeasonPack: true,
    });
  });

  it('parses a multi-episode range as season pack', () => {
    const r = parseSeasonal('Silo S03E01-E05');
    expect(r.season).toBe(3);
    expect(r.episode).toBeNull();
    expect(r.isSeasonPack).toBe(true);
  });

  it('parses an orphan episode', () => {
    expect(parseSeasonal('Chapter E01')).toEqual({
      season: null,
      episode: 1,
      isSeasonPack: false,
    });
  });

  it('returns empty for a movie title', () => {
    expect(parseSeasonal('Inception 2010')).toEqual({
      season: null,
      episode: null,
      isSeasonPack: false,
    });
  });

  it('parses dash-separated episodes (S04-E07), not a season pack', () => {
    // hblinks.co posts use "Reacher S04-E07" style titles; this was the bug
    // that collapsed every episode of a season into one pack card.
    expect(parseSeasonal('Reacher S04-E07 1080p')).toEqual({
      season: 4,
      episode: 7,
      isSeasonPack: false,
    });
    expect(parseSeasonal('Reacher S4-E7')).toEqual({
      season: 4,
      episode: 7,
      isSeasonPack: false,
    });
    expect(parseSeasonal('Reacher S04-E07')).toEqual({
      season: 4,
      episode: 7,
      isSeasonPack: false,
    });
  });

  it('still parses compact, dotted, and spaced episode forms', () => {
    expect(parseSeasonal('Silo S03E10 1080p')).toEqual({
      season: 3,
      episode: 10,
      isSeasonPack: false,
    });
    expect(parseSeasonal('Silo S03.E10')).toEqual({
      season: 3,
      episode: 10,
      isSeasonPack: false,
    });
    expect(parseSeasonal('Silo S03 E10')).toEqual({
      season: 3,
      episode: 10,
      isSeasonPack: false,
    });
  });

  it('parses word-form season and episode markers', () => {
    expect(parseSeasonal('Reacher Season 4 Episode 7')).toEqual({
      season: 4,
      episode: 7,
      isSeasonPack: false,
    });
    expect(parseSeasonal('Reacher Season 4')).toEqual({
      season: 4,
      episode: null,
      isSeasonPack: true,
    });
  });

  it('parses dash-form multi-episode ranges as season packs', () => {
    expect(parseSeasonal('Silo S03E01-E05')).toEqual({
      season: 3,
      episode: null,
      isSeasonPack: true,
    });
    expect(parseSeasonal('Reacher S04-E01-05')).toEqual({
      season: 4,
      episode: null,
      isSeasonPack: true,
    });
  });

  it('does not match letters inside words', () => {
    expect(parseSeasonal('Mission S04')).toEqual({
      season: 4,
      episode: null,
      isSeasonPack: true,
    });
    // "Se7en" style words must not be mistaken for season markers.
    expect(parseSeasonal('Se7en 1995')).toEqual({
      season: null,
      episode: null,
      isSeasonPack: false,
    });
  });
});

describe('parseSearchHints', () => {
  it('extracts compact season+episode hints', () => {
    expect(parseSearchHints('reacher s04e07')).toEqual({
      title: 'reacher',
      season: 4,
      episode: 7,
    });
  });

  it('extracts dashed and spaced season+episode hints', () => {
    expect(parseSearchHints('reacher s04-e07')).toEqual({
      title: 'reacher',
      season: 4,
      episode: 7,
    });
    expect(parseSearchHints('reacher s04 e07')).toEqual({
      title: 'reacher',
      season: 4,
      episode: 7,
    });
  });

  it('extracts word-form hints', () => {
    expect(parseSearchHints('reacher season 4 episode 7')).toEqual({
      title: 'reacher',
      season: 4,
      episode: 7,
    });
    expect(parseSearchHints('reacher season 4')).toEqual({
      title: 'reacher',
      season: 4,
      episode: null,
    });
  });

  it('extracts a season-only hint', () => {
    expect(parseSearchHints('reacher s04')).toEqual({
      title: 'reacher',
      season: 4,
      episode: null,
    });
    expect(parseSearchHints('reacher s4')).toEqual({
      title: 'reacher',
      season: 4,
      episode: null,
    });
  });

  it('treats a partial "s04e" token as a season hint', () => {
    expect(parseSearchHints('reacher s04e')).toEqual({
      title: 'reacher',
      season: 4,
      episode: null,
    });
  });

  it('extracts a bare episode hint when there is no season', () => {
    expect(parseSearchHints('silo e10')).toEqual({
      title: 'silo',
      season: null,
      episode: 10,
    });
  });

  it('returns no hints for a plain show query', () => {
    expect(parseSearchHints('reacher')).toEqual({
      title: 'reacher',
      season: null,
      episode: null,
    });
    expect(parseSearchHints('reacher 2012')).toEqual({
      title: 'reacher 2012',
      season: null,
      episode: null,
    });
  });

  it('handles a query that is only a hint', () => {
    expect(parseSearchHints('s04')).toEqual({
      title: '',
      season: 4,
      episode: null,
    });
  });
});

describe('parseFilenameTags', () => {
  it('extracts format, episode, languages, and codec', () => {
    const tags = parseFilenameTags('Silo.S03E10.1080p.English.WEB-DL.5.1.ESub.x264.mkv');
    expect(tags).toContain('WEB-DL');
    expect(tags).toContain('S03E10');
    expect(tags).toContain('English 5.1');
    expect(tags).toContain('ESub');
    expect(tags).toContain('x264');
  });

  it('returns empty array for empty input', () => {
    expect(parseFilenameTags('')).toEqual([]);
  });
});

describe('baseTitle', () => {
  it('strips season/episode markers from a parsed name', () => {
    expect(baseTitle('Silo S03E10')).toBe('Silo');
    expect(baseTitle('Silo S03')).toBe('Silo');
  });

  it('strips container and series words', () => {
    const t = baseTitle('Dune Complete Season');
    expect(t).toBe('Dune');
  });

  it('works on names already cleaned by parseTitle', () => {
    // parseTitle removed qualities; baseTitle then strips the remaining
    // season/episode markers so the grouping key stays stable.
    const parsed = parseTitle('Silo.S03E10.1080p');
    expect(parsed.name).toBe('Silo S03E10');
    expect(baseTitle(parsed.name)).toBe('Silo');
  });
});

describe('normKey', () => {
  it('lowercases and strips non-alphanumeric', () => {
    expect(normKey('The Inception 2010')).toBe('inception 2010');
  });

  it('removes articles', () => {
    expect(normKey('the a an Inception')).toBe('inception');
  });
});

describe('editionKeyOf', () => {
  it('builds a canonical edition key', () => {
    const item: ReleaseItem = {
      post: makePost('Silo S03E01 1080p'),
      parsed: parseTitle('Silo S03E01 1080p'),
      seasonal: { season: 3, episode: 1, isSeasonPack: false },
      edition: { edition: '', subs: '' },
    };
    const key = editionKeyOf(item);
    expect(key).toContain('silo');
    expect(key).toContain('S3');
    expect(key).toContain('E1');
  });
});

describe('formatBytes', () => {
  it('formats GB', () => {
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.00 GB');
  });

  it('formats MB', () => {
    expect(formatBytes(500 * 1024 * 1024)).toBe('500 MB');
  });

  it('returns empty for null/0', () => {
    expect(formatBytes(null)).toBe('');
    expect(formatBytes(0)).toBe('');
  });
});

describe('stripHtml', () => {
  it('strips tags', () => {
    expect(stripHtml('<p>Hello <b>world</b></p>')).toBe('Hello world');
  });
});

describe('esc', () => {
  it('escapes HTML entities', () => {
    expect(esc('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'
    );
  });
});