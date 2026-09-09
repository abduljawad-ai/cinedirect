import { describe, it, expect } from 'vitest';
import { parseSearchHints, parseSeasonal } from '../src/core/parsing';
import { groupByMovie } from '../src/core/grouping';

// Opt-in live check: set LIVE=1 to verify the hint-aware search against the
// real hblinks.co API. Skipped by default so the offline suite stays
// deterministic (LIVE=1 npx vitest run tests/live-sanity.test.ts).
describe.skipIf(!process.env.LIVE)('LIVE hblinks.co sanity (reacher s04)', () => {
  it('shows all of season 4, not a single episode', async () => {
    const q = 'reacher s04';
    const hints = parseSearchHints(q);
    console.log('hints:', JSON.stringify(hints));

    const fetchPosts = async (search: string): Promise<unknown[]> => {
      const url = new URL('https://hblinks.co/wp-json/wp/v2/posts');
      url.searchParams.set('per_page', '100');
      url.searchParams.set('page', '1');
      url.searchParams.set('_fields', 'id,title,link,date');
      url.searchParams.set('search', search);
      const res = await fetch(url.toString());
      return res.ok ? res.json() : [];
    };

    // searchExpanded: direct query + base-title query, then filter.
    const direct = (await fetchPosts(q)) as Array<{ id: number; title: { rendered: string } }>;
    const base = (await fetchPosts(hints.title)) as Array<{ id: number; title: { rendered: string } }>;
    const seen = new Map<number, string>();
    for (const p of [...base, ...direct]) seen.set(p.id, p.title.rendered);

    const posts = Array.from(seen.entries()).map(([id, title]) => ({
      id,
      title,
      link: '',
      date: '',
      direct: [],
      allLinks: [],
    }));

    const filtered = posts.filter((p) => {
      const se = parseSeasonal(p.title);
      if (hints.season != null && se.season !== hints.season) return false;
      if (hints.episode != null && se.episode !== hints.episode) return false;
      return true;
    });

    console.log(`direct=${direct.length} base=${base.length} merged=${posts.length} filtered=${filtered.length}`);
    console.log('filtered titles:', filtered.map((p) => p.title));
    expect(filtered.length).toBeGreaterThanOrEqual(7);

    const groups = groupByMovie(filtered);
    console.log('edition keys:', Object.keys(groups[0]?.byEditionKey ?? {}));
    expect(groups).toHaveLength(1);
    expect(Object.keys(groups[0].byEditionKey)).toHaveLength(7);
    expect(filtered.map((p) => parseSeasonal(p.title).episode).sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  }, 30000);
});