import { describe, it, expect } from 'vitest';
import {
  pickArticle,
  pickRanked,
  isPortraitish,
  cleanImageUrl,
} from '../src/api/wikipedia';

describe('pickRanked', () => {
  it('ranks an exact match below zero-scoring hits and returns best first', () => {
    const ranked = pickRanked(
      [
        { title: 'Reacher (disambiguation)' },
        { title: 'Reacher (TV series)' },
        { title: 'Jack Reacher (film)' },
      ],
      'Reacher',
    );
    expect(ranked[0]).toBe('Reacher (TV series)');
    expect(ranked[1]).toBe('Jack Reacher (film)');
    expect(ranked).not.toContain('Reacher (disambiguation)');
  });

  it('returns an empty list when nothing scores above zero', () => {
    expect(pickRanked([{ title: 'List of Reacher episodes' }], 'Reacher')).toEqual([]);
  });
});

describe('pickArticle', () => {
  it('prefers an exact article title match', () => {
    const hits = [
      { title: 'Silo (TV series)' },
      { title: 'Silo (disambiguation)' },
    ];
    expect(pickArticle(hits, 'Silo').title).toBe('Silo (TV series)');
  });

  it('recovers the canonical name from the "Silo (TV series)" suffix', () => {
    const hits = [
      { title: 'Silo (TV series)' },
      { title: 'Silo (film)' },
    ];
    expect(pickArticle(hits, 'Silo').title).toBe('Silo (TV series)');
  });

  it('returns empty when no hit scores above zero', () => {
    const hits = [
      { title: 'List of Silo episodes' },
      { title: 'Category:Silo' },
      { title: 'Wikidata:Main Page' },
    ];
    expect(pickArticle(hits, 'Silo').title).toBe('');
  });

  it('matches by prefix when the exact name is absent', () => {
    const hits = [{ title: 'Jack Reacher (film)' }, { title: 'Reacher arrow' }];
    expect(pickArticle(hits, 'Jack Reacher 2012').title).toBe('Jack Reacher (film)');
  });

  it('prefers an exact title match over a suffixed variant', () => {
    const hits = [
      { title: 'The Office' },
      { title: 'The Office (American TV series)' },
    ];
    expect(pickArticle(hits, 'The Office').title).toBe('The Office');
  });
});

describe('isPortraitish', () => {
  it('accepts tall poster-like images', () => {
    expect(isPortraitish(600, 880)).toBe(true);
    expect(isPortraitish(300, 450)).toBe(true);
  });

  it('rejects landscape title cards, logos and cast photos', () => {
    expect(isPortraitish(330, 185)).toBe(false); // Reacher title card
    expect(isPortraitish(1200, 675)).toBe(false);
    expect(isPortraitish(50, 28)).toBe(false);
  });

  it('rejects square and missing dimensions', () => {
    expect(isPortraitish(500, 500)).toBe(false);
    expect(isPortraitish(undefined, 500)).toBe(false);
    expect(isPortraitish(500, undefined)).toBe(false);
  });
});

describe('cleanImageUrl', () => {
  it('strips tracking query params from thumb URLs', () => {
    const dirty =
      'https://upload.wikimedia.org/wikipedia/commons/thumb/2/25/Reacher_series_title_card.png/330px-Reacher_series_title_card.png?utm_source=en.wikipedia.org&utm_campaign=api';
    expect(cleanImageUrl(dirty)).toBe(
      'https://upload.wikimedia.org/wikipedia/commons/thumb/2/25/Reacher_series_title_card.png/330px-Reacher_series_title_card.png',
    );
  });

  it('leaves clean URLs untouched', () => {
    const url = 'https://upload.wikimedia.org/wikipedia/en/3/3a/Poster.jpg';
    expect(cleanImageUrl(url)).toBe(url);
  });

  it('keeps hash fragments intact', () => {
    expect(cleanImageUrl('https://example.org/a.jpg#frag?utm=1')).toBe(
      'https://example.org/a.jpg#frag?utm=1',
    );
  });
});