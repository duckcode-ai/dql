import { describe, expect, it } from 'vitest';
import {
  FORMAT_VERSION,
  canonicalize,
  hasCanonicalHeader,
  isCanonical,
  readFormatVersion,
} from './index.js';

const SAMPLE = `dashboard "Daily" {
  chart.line(
    SELECT 1,
    x = a,
    y = b
  )
}`;

describe('canonical format', () => {
  it('prepends the version header on first canonicalize', () => {
    const out = canonicalize(SAMPLE);
    expect(out.startsWith(`// dql-format: ${FORMAT_VERSION}`)).toBe(true);
    expect(readFormatVersion(out)).toBe(FORMAT_VERSION);
  });

  it('is idempotent', () => {
    const once = canonicalize(SAMPLE);
    const twice = canonicalize(once);
    expect(twice).toBe(once);
    expect(isCanonical(once)).toBe(true);
  });

  it('preserves existing header without duplicating it', () => {
    const withHeader = `// dql-format: 1\n\n${SAMPLE}`;
    const out = canonicalize(withHeader);
    const headerCount = (out.match(/dql-format:/g) ?? []).length;
    expect(headerCount).toBe(1);
  });

  it('reports missing header as null', () => {
    expect(readFormatVersion(SAMPLE)).toBeNull();
    expect(hasCanonicalHeader(SAMPLE)).toBe(false);
  });

  it('tolerates future versions in readFormatVersion', () => {
    expect(readFormatVersion('// dql-format: 99\n\ndashboard "x" {}')).toBe(99);
  });
});
