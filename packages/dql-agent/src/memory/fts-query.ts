/**
 * Shared FTS5 query sanitization for the local SQLite stores (memory,
 * conversation). Tokenizes free text, drops stop words, and quotes each term
 * so user input can never break the MATCH expression.
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

export function sanitizeFtsQuery(raw: string): string {
  return raw
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t.toLowerCase()))
    .slice(0, 48)
    .map((t) => `"${t}"`)
    .join(' OR ');
}
