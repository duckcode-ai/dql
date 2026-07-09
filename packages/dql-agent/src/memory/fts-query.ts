/**
 * Shared FTS5 query sanitization for every local SQLite store (memory,
 * conversation, KG, hints, metadata catalog). Tokenizes free text, drops stop
 * words, and quotes each term so user input can never break the MATCH expression.
 * Pass `{ prefix: true }` for prefix-match stores (KG / metadata catalog).
 *
 * Two matching strategies are exposed:
 *   - `sanitizeFtsQuery` builds an OR-of-terms MATCH (high recall). Kept as the
 *     default for the memory/hints/conversation stores.
 *   - `buildFtsMatch` returns BOTH an AND expression (all terms must co-occur —
 *     high precision) and the OR fallback, so ranked stores (KG, catalog) can run
 *     AND-first and fall back to OR only when the precise query returns nothing.
 */

// Grammatical function words + generic request verbs (chatter that never
// disambiguates a search: "show", "explain", "find", "get", "give", "using").
// Deliberately does NOT strip analytical/schema NOUNS a user might genuinely be
// searching for — `query`, `sql`, `current` are retained, so "explain this current
// query" sanitizes to `current OR query` instead of the empty MATCH it used to
// (which matched nothing). Schema/data words survive; request chatter does not.
const STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'doing', 'down', 'during',
  'each', 'explain', 'few', 'find', 'for', 'from', 'further',
  'get', 'give',
  'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'how',
  'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself',
  'just',
  'me', 'more', 'most', 'my', 'myself',
  'no', 'nor', 'not', 'now',
  'of', 'off', 'on', 'once', 'only', 'or', 'other', 'our', 'ours', 'ourselves', 'out', 'over', 'own',
  'please',
  'same', 'she', 'should', 'show', 'so', 'some', 'such',
  'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too',
  'under', 'until', 'up', 'using',
  'very',
  'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'would',
  'you', 'your', 'yours', 'yourself', 'yourselves',
]);

/** Extract the quoted, MATCH-safe tokens from free text (shared by both builders). */
export function ftsTokens(
  raw: string,
  options: { fallbackToRawTokens?: boolean } = {},
): string[] {
  const defanged = raw
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter((t) => t.length > 1);
  const meaningful = defanged.filter((t) => !STOP_WORDS.has(t.toLowerCase()));
  // `fallbackToRawTokens` is for VALUE lookups (filter literals), where a data
  // value that happens to be a stop word (e.g. a category literally named
  // "current") must still match rather than be dropped to an empty MATCH. It is
  // intentionally OFF for natural-language question search, where an all-stop-word
  // query (e.g. "the of and") is content-free and should return nothing.
  const source = meaningful.length > 0 || !options.fallbackToRawTokens ? meaningful : defanged;
  return source.slice(0, 48);
}

export function sanitizeFtsQuery(
  raw: string,
  options: { prefix?: boolean; fallbackToRawTokens?: boolean } = {},
): string {
  const tokens = ftsTokens(raw, options);
  const suffix = options.prefix ? '*' : '';
  return tokens.map((t) => `"${t}"${suffix}`).join(' OR ');
}

export interface FtsMatchExpressions {
  /** All terms required (space = implicit AND in FTS5). Empty when < 2 tokens. */
  and: string;
  /** Any term matches (OR). The recall fallback. */
  or: string;
  /** The extracted tokens (post stop-word removal). */
  tokens: string[];
}

/**
 * Build both AND (precision) and OR (recall) MATCH expressions for a ranked
 * store. Callers should try `and` first and fall back to `or` when it returns no
 * rows — a single co-occurrence query is far more precise than OR-of-terms, but
 * OR still catches partial matches when no document contains every term.
 */
export function buildFtsMatch(
  raw: string,
  options: { prefix?: boolean; fallbackToRawTokens?: boolean } = {},
): FtsMatchExpressions {
  const tokens = ftsTokens(raw, options);
  const suffix = options.prefix ? '*' : '';
  const quoted = tokens.map((t) => `"${t}"${suffix}`);
  return {
    // AND is only distinct from OR with 2+ tokens; a single token is the same query.
    and: quoted.length >= 2 ? quoted.join(' ') : '',
    or: quoted.join(' OR '),
    tokens,
  };
}
