import { describe, expect, it } from 'vitest';
import { sanitizeFtsQuery } from './fts-query.js';

describe('sanitizeFtsQuery (W3.5)', () => {
  it('drops stop words and quotes meaningful terms', () => {
    expect(sanitizeFtsQuery('show me the revenue by region')).toBe('"revenue" OR "region"');
  });

  it('adds a prefix wildcard when requested', () => {
    expect(sanitizeFtsQuery('revenue', { prefix: true })).toBe('"revenue"*');
  });

  it('returns empty for an all-stop-word question (content-free) by default', () => {
    // Natural-language search: an all-stop-word query should NOT noise-match every
    // artifact that mentions "what"/"current". Stays empty without the value fallback.
    expect(sanitizeFtsQuery('explain this current query')).toBe('');
  });

  it('falls back to raw tokens for VALUE lookups (fallbackToRawTokens)', () => {
    // A filter value that is itself a stop word (a category named "current") must
    // still bind rather than drop to an empty MATCH.
    const result = sanitizeFtsQuery('current', { prefix: true, fallbackToRawTokens: true });
    expect(result).toBe('"current"*');
  });

  it('returns empty for punctuation-only / single-character input', () => {
    expect(sanitizeFtsQuery('? . , !')).toBe('');
  });
});
