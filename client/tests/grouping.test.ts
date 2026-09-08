import { describe, it, expect } from 'vitest';
import { groupByMovie, layOutGroup, indexEditions, qualRankOf } from '../src/core/grouping';
import type { Post } from '@shared/types';

function post(id: number, title: string, date = '2024-01-01T00:00:00'): Post {
  return {
    id,
    title,
    link: `https://hblinks.co/post-${id}`,
    date,
    direct: [],
    allLinks: [],
  };
}

describe('groupByMovie', () => {
  it('groups posts by base title', () => {
    const posts = [post(1, 'Silo S03E01 1080p'), post(2, 'Silo S03E02 1080p')];
    const groups = groupByMovie(posts);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('Silo');
    expect(groups[0].items).toHaveLength(2);
  });

  it('keeps edition variants in one show group across separate edition keys', () => {
    const posts = [
      post(1, 'Zootopia 2024 1080p'),
      post(2, 'Zootopia 2024 720p'),
      post(3, 'Zootopia 2024 1080p Dual Audio'),
    ];
    const groups = groupByMovie(posts);
    expect(groups).toHaveLength(1);
    const group = groups[0];
    // 2 edition groups: default (English) + dual audio
    const keys = Object.keys(group.byEditionKey);
    expect(keys).toHaveLength(2);
    expect(keys.some((k) => k.includes('dual audio'))).toBe(true);
    expect(keys.some((k) => !k.includes('dual audio'))).toBe(true);
  });

  it('sorts groups by newest first', () => {
    const posts = [
      post(1, 'Older Movie 2000', '2000-01-01T00:00:00'),
      post(2, 'Newer Movie 2024', '2024-06-15T00:00:00'),
    ];
    const groups = groupByMovie(posts);
    expect(groups[0].name).toBe('Newer Movie');
  });

  it('skips posts with empty normalized keys', () => {
    const posts = [post(1, '!!! .,,'), post(2, 'Valid Movie 2024')];
    const groups = groupByMovie(posts);
    expect(groups).toHaveLength(1);
  });
});

describe('layOutGroup', () => {
  function buildGroup() {
    const posts = [
      post(1, 'Silo S03E01 1080p'),
      post(2, 'Silo S03E02 1080p'),
      post(3, 'Silo S03 720p'),
      post(4, 'Silo S02 COMPLETE 1080p'),
      post(5, 'Silo 2021 1080p'), // standalone film, same show group
    ];
    return groupByMovie(posts)[0];
  }

  it('separates episodes, packs, and movies', () => {
    const group = buildGroup();
    const layout = layOutGroup(group);
    expect(layout.seasonList).toHaveLength(2);
    const s3 = layout.seasonList.find((s) => s.season === 3)!;
    expect(s3.episodeItems).toHaveLength(2);
    expect(s3.packItems).toHaveLength(1);
    expect(layout.movies).toHaveLength(1);
  });

  it('sorts episodes ascending', () => {
    const group = buildGroup();
    const layout = layOutGroup(group);
    const s3 = layout.seasonList.find((s) => s.season === 3)!;
    expect(s3.episodeItems[0].seasonal.episode).toBe(1);
    expect(s3.episodeItems[1].seasonal.episode).toBe(2);
  });
});

describe('indexEditions', () => {
  it('builds a flat edition lookup', () => {
    const groups = groupByMovie([post(1, 'Silo S03E01 1080p'), post(2, 'Silo S03E01 720p')]);
    const idx = indexEditions(groups);
    const keys = Object.keys(idx);
    expect(keys.length).toBeGreaterThan(0);
    expect(idx[keys[0]]).toHaveProperty('group');
    expect(idx[keys[0]]).toHaveProperty('edition');
  });
});

describe('qualRankOf', () => {
  it('returns the best quality rank for an item', () => {
    const groups = groupByMovie([post(1, 'Silo S03E01 1080p.720p')]);
    const item = groups[0].items[0];
    expect(qualRankOf(item)).toBe(3); // 1080P
  });
});