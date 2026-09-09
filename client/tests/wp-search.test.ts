import { describe, it, expect } from 'vitest';
import { filterByHints, mergePosts } from '../src/api/wp';
import type { Post } from '@shared/types';

function post(id: number, title: string): Post {
  return {
    id,
    title,
    link: `https://hblinks.co/post-${id}`,
    date: '2026-01-01T00:00:00',
    direct: [],
    allLinks: [],
  };
}

describe('mergePosts', () => {
  it('merges lists, de-duplicating by id (first occurrence wins)', () => {
    const a = [post(1, 'A'), post(2, 'B')];
    const b = [post(2, 'B-new'), post(3, 'C')];
    const merged = mergePosts(a, b);
    expect(merged.map((p) => p.id)).toEqual([1, 2, 3]);
    expect(merged[1].title).toBe('B'); // first occurrence wins
  });

  it('keeps the first list at the front', () => {
    const merged = mergePosts([post(1, 'A')], [post(2, 'B')]);
    expect(merged.map((p) => p.id)).toEqual([1, 2]);
  });
});

describe('filterByHints', () => {
  const posts = [
    post(1, 'Reacher S04-E07 1080p'),
    post(2, 'Reacher S04-E03 1080p'),
    post(3, 'Reacher S02 E03 720p'),
    post(4, 'Reacher Season 3 1080p'), // season pack
    post(5, 'Jack Reacher 2012 720p'), // movie, no season
  ];

  it('keeps every post when no hints are present', () => {
    expect(filterByHints(posts, { title: 'reacher', season: null, episode: null })).toHaveLength(5);
  });

  it('filters by season (episodes and packs, dash + word forms)', () => {
    const out = filterByHints(posts, { title: 'reacher', season: 4, episode: null });
    expect(out.map((p) => p.id).sort()).toEqual([1, 2]);
  });

  it('filters by exact season + episode', () => {
    const out = filterByHints(posts, { title: 'reacher', season: 4, episode: 7 });
    expect(out.map((p) => p.id)).toEqual([1]);
  });

  it('filters by episode alone when season is unknown', () => {
    const out = filterByHints(posts, { title: 'anything', season: null, episode: 3 });
    expect(out.map((p) => p.id).sort()).toEqual([2, 3]);
  });

  it('returns empty when nothing matches the hints', () => {
    const out = filterByHints(posts, { title: 'reacher', season: 9, episode: null });
    expect(out).toHaveLength(0);
  });
});