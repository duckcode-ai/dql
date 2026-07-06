import { describe, expect, it } from 'vitest';
import { compactToolOutput } from './tool-output.js';

describe('compactToolOutput', () => {
  it('returns small objects verbatim as JSON', () => {
    const out = compactToolOutput({ ok: true, rows: 3 });
    expect(JSON.parse(out)).toEqual({ ok: true, rows: 3 });
  });

  it('passes through small strings unchanged', () => {
    expect(compactToolOutput('hello')).toBe('hello');
  });

  it('truncates oversized output to VALID JSON carrying a truncation marker', () => {
    const big = { rows: Array.from({ length: 5000 }, (_, i) => ({ i, name: `row-${i}` })) };
    const out = compactToolOutput(big, 500);
    // Must parse — the bug was slicing a serialized object mid-token.
    const parsed = JSON.parse(out) as { truncated?: boolean; preview?: string; originalLength?: number };
    expect(parsed.truncated).toBe(true);
    expect(typeof parsed.preview).toBe('string');
    expect(parsed.preview!.length).toBeLessThanOrEqual(500);
    expect(parsed.originalLength).toBeGreaterThan(500);
  });

  it('truncates oversized plain strings to valid JSON too', () => {
    const out = compactToolOutput('x'.repeat(2000), 100);
    const parsed = JSON.parse(out) as { truncated?: boolean; preview?: string };
    expect(parsed.truncated).toBe(true);
    expect(parsed.preview).toBe('x'.repeat(100));
  });
});
