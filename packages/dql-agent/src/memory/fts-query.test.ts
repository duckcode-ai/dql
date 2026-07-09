import { describe, expect, it } from 'vitest';
import { sanitizeFtsQuery } from './fts-query.js';

describe('sanitizeFtsQuery (W3.5)', () => {
  it('drops stop words and quotes meaningful terms', () => {
    expect(sanitizeFtsQuery('show me the revenue by region')).toBe('"revenue" OR "region"');
  });

  it('adds a prefix wildcard when requested', () => {
    expect(sanitizeFtsQuery('revenue', { prefix: true })).toBe('"revenue"*');
  });

  it('retains analytical/schema nouns, dropping only request chatter', () => {
    // Request verbs ("explain") and fillers ("this") are chatter, but schema/data
    // nouns ("current", "query") carry retrieval signal and must survive — the old
    // list dropped all four, sanitizing this to an empty MATCH that found nothing.
    expect(sanitizeFtsQuery('explain this current query')).toBe('"current" OR "query"');
  });

  it('returns empty for a truly content-free (all-function-word) question', () => {
    expect(sanitizeFtsQuery('what is this for')).toBe('');
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
