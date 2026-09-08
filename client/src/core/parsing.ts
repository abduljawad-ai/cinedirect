/**
 * Title-parsing utilities for CineDirect.
 *
 * Pure functions that extract structured metadata (year, quality, edition,
 * season/episode, etc.) from raw release title strings.
 *
 * All functions are side-effect free and fully typed.
 */

import type {
  Edition,
  ParsedTitle,
  Quality,
  ReleaseItem,
  Seasonal,
} from "@shared/types";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Regex that matches quality tiers in a title. */
const QUALITY_RE = /\b(2160p|4k|1080p|720p|480p|360p)\b/gi;

/** Regex that matches a 4-digit year (1900-2099). */
const YEAR_RE = /\b(19|20)\d{2}\b/;

/** Full list of codec/format keywords stripped during name cleaning. */
const CODEC_FORMAT_RE =
  /\b(2160p|4k|1080p|720p|480p|360p|10\s*bit|bluray|blu-ray|web-?dl|webdl|webrip|hdtc|hd-?rip|hdcam|cam|hdr|x264|x265|hevc|aac|proper|repack|extended|muxed|multisub|dual\s*audio|hd|uhd)\b/gi;

/** Video container extensions stripped during name cleaning. */
const CONTAINER_RE = /\b(mkv|mp4|avi|mov|ts)\b/gi;

/* ------------------------------------------------------------------ */
/*  parseTitle                                                         */
/* ------------------------------------------------------------------ */

/**
 * Extract cleaned name, year, and quality tiers from a raw release title.
 *
 * Normalises separators (underscores, hyphens → dots), pulls out the year
 * and quality strings, then strips all metadata keywords to leave a clean
 * human-readable name.
 *
 * @example
 * ```ts
 * parseTitle("Silo.S03E10.1080p.WEB-DL.5.1.ESub.x264-HDHub4u.mkv")
 * // => { raw: "...", name: "Silo", year: "", qualities: ["1080P"] }
 * ```
 */
export function parseTitle(raw: string): ParsedTitle {
  const t = raw.trim().replace(/[_-]+/g, ".").replace(/\.+/g, ".");

  const yearMatch = YEAR_RE.exec(t);
  const year = yearMatch ? yearMatch[0] : "";

  // Collect all quality tiers present in the title.
  const quals: Quality[] = [];
  let qm: RegExpExecArray | null;
  while ((qm = QUALITY_RE.exec(t)) !== null) {
    quals.push(qm[0].toUpperCase() as Quality);
  }

  // Strip year, codec/format keywords, container extensions, and empty parens.
  const cleaned = t
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(CODEC_FORMAT_RE, " ")
    .replace(CONTAINER_RE, " ")
    .replace(/\(\s*\)/g, " ");

  const name = cleaned.replace(/\.+/g, " ").replace(/\s+/g, " ").trim();

  return {
    raw,
    name,
    year,
    qualities: [...new Set(quals)],
  };
}

/* ------------------------------------------------------------------ */
/*  parseEdition                                                       */
/* ------------------------------------------------------------------ */

/**
 * Detect the audio/language edition tag from a release title.
 *
 * Returns a canonical edition string (e.g. `"dual audio"`, `"hindi"`)
 * and a subtitle flag (`"eng sub"` or `""`).
 *
 * - Multi-audio indicators (`dual audio`, `dd+ 5.1`, `dts 5.1`) → `"dual audio"`
 * - Explicit language names → that language as the edition
 * - Subtitle markers → `subs = "eng sub"`
 *
 * @example
 * ```ts
 * parseEdition("Oppenheimer.2023.1080p.Hindi.DD+5.1.ESub.x264")
 * // => { edition: "dual audio", subs: "eng sub" }
 * ```
 */
export function parseEdition(title: string): Edition {
  const t = String(title || "").toLowerCase();

  let ed = "";
  let subs = "";

  // Multi-audio / surround-sound indicators imply dual audio.
  const multi = /\b(dual\s*audio|dual\b|multi\s*audio|multi\b|dd\+?\s*5\.1|dts\s*5\.1)\b/.exec(t);

  // Explicit language names (both Indian and international).
  const langBr = /\b(hindi|tamil|telugu|malayalam|kannada|punjabi|bengali|english|spanish|french|german|japanese|korean)\b/.exec(t);

  if (multi) {
    ed = "dual audio";
  } else if (langBr && /^(hindi|tamil|telugu|malayalam|kannada|punjabi|bengali)$/.test(langBr[1])) {
    ed = langBr[1];
  }

  // Subtitle detection.
  const subsM = /\b(eng[\s.-]*subs?|english[\s.-]*subs?|subtitles)\b/.exec(t);
  if (subsM) subs = "eng sub";

  return { edition: ed, subs };
}

/* ------------------------------------------------------------------ */
/*  parseSeasonal                                                      */
/* ------------------------------------------------------------------ */

/**
 * Extract season/episode markers from a release title.
 *
 * Patterns recognised (in priority order):
 * 1. Multi-episode range (`S03E01-E05`) → season pack
 * 2. Combined season+episode (`S03E10`) → single episode
 * 3. Solo season (`S03`) → season pack
 * 4. Solo episode (`E10`) → orphan episode
 *
 * @example
 * ```ts
 * parseSeasonal("Silo.S03E10.1080p")
 * // => { season: 3, episode: 10, isSeasonPack: false }
 *
 * parseSeasonal("Silo.S03.1080p")
 * // => { season: 3, episode: null, isSeasonPack: true }
 * ```
 */
export function parseSeasonal(title: string): Seasonal {
  const t = String(title || "").toUpperCase();

  // Multi-episode range = a season pack.
  const range = /\bS(\d{1,2})[.\s]*E\d{1,3}\s*[-–—]\s*E?\d{1,3}\b/.exec(t);
  if (range) {
    return { season: parseInt(range[1], 10), episode: null, isSeasonPack: true };
  }

  // Combined season+episode.
  const se = /\bS(\d{1,2})[.\s]*E(\d{1,3})\b/.exec(t);
  if (se) {
    return { season: parseInt(se[1], 10), episode: parseInt(se[2], 10), isSeasonPack: false };
  }

  // Solo season (whole-season pack).
  const s = /(^|\W)S(\d{1,2})(?=\D|$)/.exec(t);
  if (s) {
    return { season: parseInt(s[2], 10), episode: null, isSeasonPack: true };
  }

  // Solo episode with no season — an orphan.
  const e = /(^|\W)E(\d{1,3})(?=\D|$)/.exec(t);
  return {
    season: null,
    episode: e ? parseInt(e[2], 10) : null,
    isSeasonPack: false,
  };
}

/* ------------------------------------------------------------------ */
/*  parseFilenameTags                                                  */
/* ------------------------------------------------------------------ */

/**
 * Extract rich display tags from a resolved file's real filename.
 *
 * Pulls out release format (WEB-DL, BluRay…), episode code, languages
 * with channel info, subtitle flag, and codec/HDR metadata. Returns at
 * most 6 tags.
 *
 * @example
 * ```ts
 * parseFilenameTags("Silo.S03E10.1080p.English.WEB-DL.5.1.ESub.x264-HDHub4u.Ms.mkv")
 * // => ["WEB-DL", "S03E10", "English 5.1", "ESub", "x264"]
 * ```
 */
export function parseFilenameTags(name: string): string[] {
  const lower = (name || "").toLowerCase();
  const out: string[] = [];

  // Release format.
  const fmt = lower.match(/\b(blu-?ray|web-?dl|web-?rip|hdtc|hd-?rip|cam)\b/);
  if (fmt) {
    const raw = fmt[0];
    out.push(
      raw === "webdl" || raw === "web-dl"
        ? "WEB-DL"
        : raw === "webrip" || raw === "web-rip"
          ? "WebRip"
          : raw === "bluray" || raw === "blu-ray"
            ? "BluRay"
            : raw === "hdrip" || raw === "hd-rip"
              ? "HDRip"
              : raw.toUpperCase(),
    );
  }

  // Episode code (e.g. S03E10).
  const ep = (name || "").match(/\bS\d{1,2}\s?E\d{1,3}\b/i);
  if (ep) out.push(ep[0].toUpperCase());

  // Languages with optional channel layout.
  const langs: string[] = [];
  if (/\bdual\s*audio\b/.test(lower)) langs.push("Dual Audio");
  (["Hindi", "English", "Tamil", "Telugu", "Punjabi", "Malayalam"] as const).forEach((l) => {
    if (new RegExp(`\\b${l.toLowerCase()}\\b`).test(lower)) langs.push(l);
  });
  const ch = lower.match(/\b(7\.1|5\.1|2\.0)\b/);
  if (ch && langs.length) {
    langs[langs.length - 1] += ` ${ch[0]}`;
  } else if (ch) {
    langs.push(ch[0]);
  }
  out.push(...langs);

  // ESub flag.
  if (/\besub\b/.test(lower)) out.push("ESub");

  // Codec and HDR.
  let codec: string | null = null;
  if (/\bx265\b/.test(lower)) codec = "x265";
  else if (/\bhevc\b/.test(lower)) codec = "HEVC";
  else if (/\bx264\b/.test(lower)) codec = "x264";
  if (codec) {
    if (/\b10\s*bit\b/.test(lower)) codec += " 10-bit";
    out.push(codec);
    if (/\bhdr\b/.test(lower)) out.push("HDR");
  }

  return out.slice(0, 6);
}

/* ------------------------------------------------------------------ */
/*  baseTitle                                                          */
/* ------------------------------------------------------------------ */

/**
 * Strip season/episode markers and common quality keywords to get the
 * base show or movie name.
 *
 * @example
 * ```ts
 * baseTitle("Silo.S03E10.1080p.WEB-DL")
 * // => "Silo"
 * ```
 */
export function baseTitle(name: string): string {
  return name
    .replace(/\bs\d{1,3}\s*e\d{1,3}\b/gi, " ")
    .replace(/\bs\d{1,3}\b/gi, " ")
    .replace(/\b(e\d{1,4}|complete|season|pack|sdr|hindi|dual|audio)\b/gi, " ")
    .replace(/\(\s*\d{1,2}\s*\)/g, " ")
    .replace(/\(\s*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ */
/*  normKey                                                            */
/* ------------------------------------------------------------------ */

/**
 * Normalize a title for grouping / deduplication.
 *
 * Lowercases, strips all non-alphanumeric characters, and removes
 * leading articles (`the`, `a`, `an`).
 *
 * @example
 * ```ts
 * normKey("The Matrix Reloaded")  // => "matrix reloaded"
 * normKey("A Christmas Carol")    // => "christmas carol"
 * ```
 */
export function normKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|a|an)\b/g, "")
    .trim();
}

/* ------------------------------------------------------------------ */
/*  editionKeyOf                                                       */
/* ------------------------------------------------------------------ */

/**
 * Build the canonical edition key for a {@link ReleaseItem}.
 *
 * The key uniquely identifies one specific edition of a release:
 * `normKey(baseTitle) | year | edition | subs | season | episode | isSeasonPack`
 *
 * Empty parts are omitted so the key contains only meaningful separators.
 */
export function editionKeyOf(item: ReleaseItem): string {
  const se = item.seasonal;
  const parts = [
    normKey(baseTitle(item.parsed.name)),
    item.parsed.year || "",
    item.edition.edition,
    item.edition.subs,
    se.season != null ? `S${se.season}` : "",
    se.episode != null ? `E${se.episode}` : "",
    se.isSeasonPack ? "PACK" : "",
  ];
  return parts.filter(Boolean).join("|");
}

/* ------------------------------------------------------------------ */
/*  formatBytes                                                        */
/* ------------------------------------------------------------------ */

/**
 * Format a byte count into a human-readable string.
 *
 * Uses GB when the value is ≥ 1 GiB, otherwise rounds to the nearest MB.
 * Returns an empty string for `null`, `0`, or negative values.
 *
 * @example
 * ```ts
 * formatBytes(1_530_000_000)  // => "1.42 GB"
 * formatBytes(876_000_000)    // => "835 MB"
 * formatBytes(null)           // => ""
 * ```
 */
export function formatBytes(n: number | null): string {
  if (!n) return "";
  const gb = n / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${Math.round(n / 1024 / 1024)} MB`;
}

/* ------------------------------------------------------------------ */
/*  stripHtml                                                          */
/* ------------------------------------------------------------------ */

/**
 * Strip HTML tags from a string, returning plain text.
 *
 * Uses the browser's DOM parser when available; falls back to a regex
 * strip for non-browser environments (SSR, tests).
 *
 * @example
 * ```ts
 * stripHtml("<p>Hello <b>world</b></p>") // => "Hello world"
 * ```
 */
export function stripHtml(s: string): string {
  if (typeof document !== "undefined") {
    const d = document.createElement("div");
    d.innerHTML = s;
    return (d.textContent || "").trim();
  }
  // Fallback for non-browser environments (SSR, tests).
  return s.replace(/<[^>]*>/g, "").trim();
}

/* ------------------------------------------------------------------ */
/*  esc                                                                */
/* ------------------------------------------------------------------ */

/**
 * Escape the four critical HTML entities in a string.
 *
 * Converts `&` `<` `>` and `"` to their named character references.
 * Input is coerced to string first.
 *
 * @example
 * ```ts
 * esc('Tom & Jerry say "hi"')  // => 'Tom &amp; Jerry say &quot;hi&quot;'
 * ```
 */
export function esc(s: string | number): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
