/**
 * Query composition for the shared layer.
 *
 * The panel's search box takes what the user typed; the settings add two layers
 * the sites themselves understand:
 *
 *  - **Global tag suffix** - extra tags appended to booru searches.
 *  - **Tag blacklist** - tags excluded from booru searches, spelled the portable
 *    way (`-tag`) that e621, Danbooru and Gelbooru all accept.
 *
 * These rules are used across panel, popup and options booru searches; Pawchive
 * creator/title queries use a different syntax and are passed through unchanged.
 */

export interface SearchTagInput {
  /** What the user typed, in the site's own tag syntax. */
  tags: string;
  /** Space/comma separated tags to exclude. */
  blacklist?: string;
  /** Space/comma separated tags to append. */
  globalSuffix?: string;
}

export interface ComposedSearch {
  /** The query string handed to the adapter. */
  tags: string;
  /** Tags the user asked for. */
  requested: string[];
  /** Tags that came from the settings (suffix + blacklist halves kept apart). */
  appended: string[];
  excluded: string[];
  /** True when nothing at all was requested. */
  empty: boolean;
}

const SPLIT = /[\s,]+/;
const NEGATIVE = /^-/;

function tokenize(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(SPLIT)
    .map((token) => token.trim())
    .filter(Boolean);
}

/**
 * Merge user tags, the global suffix and the blacklist.
 *
 * A blacklisted tag is dropped from the positive side (typing `cat` while `cat`
 * is blacklisted leaves `-cat`) and never duplicated. Blacklist tokens that the
 * user already negated are kept once.
 */
export function composeSearchTags(input: SearchTagInput): ComposedSearch {
  const requested = tokenize(input.tags);
  const suffix = tokenize(input.globalSuffix).filter((token) => !NEGATIVE.test(token));
  const blacklist = tokenize(input.blacklist).map((token) => token.replace(/^-+/, '')).filter(Boolean);

  const lowered = (value: string) => value.toLowerCase();
  const blackSet = new Set(blacklist.map(lowered));

  const positives: string[] = [];
  const seen = new Set<string>();
  for (const token of [...requested, ...suffix]) {
    if (NEGATIVE.test(token)) continue;
    const key = lowered(token);
    if (blackSet.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    positives.push(token);
  }

  const negatives: string[] = [];
  const seenNegatives = new Set<string>();
  for (const token of [...requested.filter((entry) => NEGATIVE.test(entry)), ...blacklist.map((entry) => `-${entry}`)]) {
    const bare = token.replace(/^-+/, '');
    const key = lowered(bare);
    if (seenNegatives.has(key)) continue;
    seenNegatives.add(key);
    negatives.push(`-${bare}`);
  }

  const all = [...positives, ...negatives];
  return {
    tags: all.join(' ').trim(),
    requested,
    appended: suffix,
    excluded: negatives.map((token) => token.replace(/^-+/, '')),
    empty: all.length === 0,
  };
}

/** Token count helper used by the panel hint ("3 filters applied"). */
export function countFilters(composed: ComposedSearch): number {
  return composed.appended.length + composed.excluded.length;
}
