/**
 * Shared FTS5 query sanitization for every local SQLite store (memory,
 * conversation, KG, hints, metadata catalog). Tokenizes free text, drops stop
 * words, and quotes each term so user input can never break the MATCH expression.
 * Pass `{ prefix: true }` for prefix-match stores (KG / metadata catalog).
 */

const STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
  'can', 'could', 'current', 'did', 'do', 'does', 'doing', 'down', 'during',
  'each', 'explain', 'few', 'find', 'for', 'from', 'further',
  'get', 'give',
  'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'how',
  'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself',
  'just',
  'me', 'more', 'most', 'my', 'myself',
  'no', 'nor', 'not', 'now',
  'of', 'off', 'on', 'once', 'only', 'or', 'other', 'our', 'ours', 'ourselves', 'out', 'over', 'own',
  'please',
  'query',
  'same', 'she', 'should', 'show', 'so', 'some', 'sql', 'such',
  'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too',
  'under', 'until', 'up', 'using',
  'very',
  'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'would',
  'you', 'your', 'yours', 'yourself', 'yourselves',
]);

export function sanitizeFtsQuery(
  raw: string,
  options: { prefix?: boolean; fallbackToRawTokens?: boolean } = {},
): string {
  const defanged = raw
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter((t) => t.length > 1);
  const meaningful = defanged.filter((t) => !STOP_WORDS.has(t.toLowerCase()));
  // `fallbackToRawTokens` is for VALUE lookups (filter literals), where a data
  // value that happens to be a stop word (e.g. a category literally named
  // "current") must still match rather than be dropped to an empty MATCH. It is
  // intentionally OFF for natural-language question search, where an all-stop-word
  // query (e.g. "explain this current query") is content-free and should return
  // nothing rather than noise-match every artifact that mentions those words.
  const source = meaningful.length > 0 || !options.fallbackToRawTokens ? meaningful : defanged;
  const tokens = source.slice(0, 48);
  const suffix = options.prefix ? '*' : '';
  return tokens.map((t) => `"${t}"${suffix}`).join(' OR ');
}
