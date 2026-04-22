import { describe, expect, it } from 'vitest';
import {
  NOTEBOOK_FORMAT_VERSION,
  canonicalizeNotebook,
  isNotebookCanonical,
  readNotebookFormatVersion,
} from './notebook.js';

const LEGACY = JSON.stringify({
  // Insertion-order mirrors what serializeDqlNotebook produces today —
  // `version` first, `cells` before `metadata`. Canonical form should
  // promote `dqlnbVersion` to the top and sort the rest.
  version: 1,
  title: 'Revenue',
  cells: [
    {
      type: 'sql',
      id: 'c1',
      content: 'SELECT 1',
      chartConfig: { chart: 'bar', x: 'a', y: 'b' },
      blockBinding: { path: 'blocks/foo.dql', state: 'bound' },
    },
  ],
  metadata: { modifiedAt: '2026-04-20T00:00:00.000Z', author: 'ari' },
});

describe('canonical notebook format', () => {
  it('prepends dqlnbVersion as the first key', () => {
    const out = canonicalizeNotebook(LEGACY);
    const firstKey = Object.keys(JSON.parse(out))[0];
    expect(firstKey).toBe('dqlnbVersion');
    expect(JSON.parse(out).dqlnbVersion).toBe(NOTEBOOK_FORMAT_VERSION);
  });

  it('is idempotent', () => {
    const once = canonicalizeNotebook(LEGACY);
    const twice = canonicalizeNotebook(once);
    expect(twice).toBe(once);
    expect(isNotebookCanonical(once)).toBe(true);
  });

  it('ends with a single trailing newline', () => {
    const out = canonicalizeNotebook(LEGACY);
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });

  it('preserves cell array order', () => {
    const src = JSON.stringify({
      title: 't',
      cells: [
        { id: 'c3', type: 'sql', content: '' },
        { id: 'c1', type: 'sql', content: '' },
        { id: 'c2', type: 'sql', content: '' },
      ],
    });
    const out = canonicalizeNotebook(src);
    const ids = (JSON.parse(out) as { cells: { id: string }[] }).cells.map((c) => c.id);
    expect(ids).toEqual(['c3', 'c1', 'c2']);
  });

  it('sorts keys inside each cell for diff-clean writes', () => {
    const a = canonicalizeNotebook(
      JSON.stringify({
        title: 't',
        cells: [{ type: 'sql', content: 'X', id: 'c1', name: 'alpha' }],
      }),
    );
    const b = canonicalizeNotebook(
      JSON.stringify({
        title: 't',
        cells: [{ name: 'alpha', content: 'X', id: 'c1', type: 'sql' }],
      }),
    );
    expect(a).toBe(b);
  });

  it('treats missing version as v0', () => {
    expect(readNotebookFormatVersion(LEGACY)).toBe(0);
    const out = canonicalizeNotebook(LEGACY);
    expect(readNotebookFormatVersion(out)).toBe(NOTEBOOK_FORMAT_VERSION);
  });

  it('preserves a future version when set explicitly on the input', () => {
    const src = JSON.stringify({ dqlnbVersion: 99, title: 't', cells: [] });
    expect(readNotebookFormatVersion(src)).toBe(99);
  });
});
