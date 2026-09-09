/* ──────────────────────────────────────────────────────────
   CineDirect Shared Types
   Used by client, server, and Cloudflare Worker
   ────────────────────────────────────────────────────────── */

/** Raw WordPress post from hblinks.co WP REST API */
export interface RawPost {
  id: number;
  title: { rendered: string };
  link: string;
  date: string;
  content: { rendered: string };
}

/** Parsed and enriched post after extraction from WP content */
export interface Post {
  id: number;
  title: string;
  link: string;
  date: string;
  direct: HubLink[];
  allLinks: string[];
}

/** A hub link extracted from post content */
export interface HubLink {
  url: string;
  quality: Quality | null;
  kind: HostKind;
}

/** Quality tiers */
export type Quality = '2160P' | '4K' | '1080P' | '720P' | '480P' | '360P';

/** Host families */
export type HostKind =
  | 'hubcdn'
  | 'hubdrive'
  | 'hubcloud'
  | 's3'
  | 'gdrive'
  | 'r2'
  | 'pixeldrain'
  | 'gofile'
  | 'unknown';

/** Resolution result for a single link */
export interface ResolvedLink {
  direct: string | null;
  size: number | null;
  filename: string | null;
  quality: Quality | null;
}

/** Quality row for rendering in the detail view */
export interface QualityRow {
  quality: Quality | null;
  direct: string;
  size: number | null;
  hostTag: string;
}

/** Parsed title components */
export interface ParsedTitle {
  raw: string;
  name: string;
  year: string;
  qualities: Quality[];
}

/** Edition info (audio/language) */
export interface Edition {
  edition: string; // e.g. 'dual audio', 'hindi', '' = default English
  subs: string;    // e.g. 'eng sub', '' = none
}

/** Season/episode markers */
export interface Seasonal {
  season: number | null;
  episode: number | null;
  isSeasonPack: boolean;
}

/** A single release item within a show group */
export interface ReleaseItem {
  post: Post;
  parsed: ParsedTitle;
  seasonal: Seasonal;
  edition: Edition;
}

/** Show group (one movie/TV show) */
export interface ShowGroup {
  key: string;
  name: string;
  year: string;
  items: ReleaseItem[];
  poster: string | null;
  editions: Map<string, EditionGroup>;
  byEditionKey: Record<string, EditionGroup>;
}

/** Edition group within a show (one audio/language version) */
export interface EditionGroup {
  key: string;
  items: ReleaseItem[];
}

/** Index entry for the detail view routing */
export interface EditionIndexEntry {
  group: ShowGroup;
  edition: EditionGroup;
}

/** TVMaze metadata for a show */
export interface TvMazeMeta {
  poster: string | null;
  summary: string;
  genres: string[];
  year: string;
  rating: number | null;
  network: string | null;
}

/** Application mode */
export type AppMode = 'local' | 'relay' | 'static';

/** Router route */
export interface Route {
  view: 'search' | 'detail';
  key: string | null;
}

/** Search result state */
export interface SearchState {
  groups: ShowGroup[];
  posts: Post[];
  query: string;
  editions: Record<string, EditionIndexEntry>;
  currentKey: string | null;
}

/** API response from /api/resolve */
export interface ResolveResponse {
  direct: string | null;
  size: number | null;
  filename: string | null;
  quality: Quality | null;
}

/** API response from a batched POST /api/resolve (order preserved) */
export interface ResolveBatchResponse {
  results: Array<ResolveResponse | null>;
}

/** Pinia-like store options */
export interface StoreOptions<T> {
  initialState: T;
}

/** Toast notification */
export interface Toast {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  message: string;
  duration?: number;
}

/** Quality rank map for sorting */
export const QUALITY_RANK: Record<string, number> = {
  '2160P': 4,
  '4K': 4,
  '1080P': 3,
  '720P': 2,
  '480P': 1,
  '360P': 0,
} as const;

/** All qualities in display order */
export const QUALITY_ORDER: Quality[] = ['2160P', '4K', '1080P', '720P', '480P', '360P'];

/** Host display tags */
export const HOST_TAGS: Record<HostKind, string> = {
  hubcdn: 'HubCDN',
  hubdrive: 'HubDrive',
  hubcloud: 'HubCloud',
  s3: 'S3',
  gdrive: 'GDrive',
  r2: 'R2',
  pixeldrain: 'Pixeldrain',
  gofile: 'Gofile',
  unknown: '',
};
