import { describe, expect, it } from 'vitest';
import { diffDQL, diffNotebook, renderDiffText } from './diff.js';

const BEFORE = `block "rev" {
  domain = "sales"
  type = "custom"
  params { region = "NA" }
  query = """
    SELECT SUM(revenue) as rev FROM orders
  """
  visualization { title = "Revenue" }
  tests { assert rev > 0 }
}`;

describe('diffDQL', () => {
  it('reports identical when sources match', () => {
    const r = diffDQL(BEFORE, BEFORE);
    expect(r.identical).toBe(true);
    expect(r.changes).toHaveLength(0);
  });

  it('detects added block', () => {
    const after = `${BEFORE}\n\nblock "cost" { domain = "ops" type = "custom" query = """SELECT 1""" }`;
    const r = diffDQL(BEFORE, after);
    expect(r.changes).toContainEqual({ kind: 'block-added', name: 'cost' });
  });

  it('detects removed block', () => {
    const r = diffDQL(BEFORE, '');
    expect(r.changes).toContainEqual({ kind: 'block-removed', name: 'rev' });
  });

  it('detects field-level changes inside a block', () => {
    const after = BEFORE
      .replace('"NA"', '"EU"')
      .replace('SUM(revenue)', 'SUM(revenue) + SUM(tax)');
    const r = diffDQL(BEFORE, after);
    expect(r.identical).toBe(false);
    const changed = r.changes.find((c) => c.kind === 'block-changed');
    expect(changed).toBeDefined();
    if (changed && changed.kind === 'block-changed') {
      const paths = changed.fields.map((f) => f.path);
      expect(paths).toContain('params.region');
      expect(paths).toContain('query');
    }
  });

  it('renders text with +/-/~ markers', () => {
    const after = BEFORE.replace('"NA"', '"EU"');
    const text = renderDiffText(diffDQL(BEFORE, after));
    expect(text).toContain('~ block "rev"');
    expect(text).toContain('params.region');
  });

  it('ignores SQL whitespace differences', () => {
    const after = BEFORE.replace(/SELECT SUM\(revenue\) as rev FROM orders/, 'SELECT  SUM(revenue)   as rev   FROM orders');
    const r = diffDQL(BEFORE, after);
    expect(r.identical).toBe(true);
  });
});

// ---- Notebook ----

const NB_BEFORE = JSON.stringify({
  title: 'Revenue',
  cells: [
    { id: 'c1', type: 'sql', content: 'SELECT 1', name: 'first' },
    { id: 'c2', type: 'markdown', content: '# hi' },
  ],
});

describe('diffNotebook', () => {
  it('reports identical when sources match', () => {
    const r = diffNotebook(NB_BEFORE, NB_BEFORE);
    expect(r.identical).toBe(true);
  });

  it('detects a changed cell content', () => {
    const after = JSON.stringify({
      title: 'Revenue',
      cells: [
        { id: 'c1', type: 'sql', content: 'SELECT 2', name: 'first' },
        { id: 'c2', type: 'markdown', content: '# hi' },
      ],
    });
    const r = diffNotebook(NB_BEFORE, after);
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0].kind).toBe('cell-changed');
    if (r.changes[0].kind === 'cell-changed') {
      expect(r.changes[0].id).toBe('c1');
      expect(r.changes[0].fields.map((f) => f.path)).toEqual(['content']);
    }
  });

  it('reports a renamed cell as one cell-changed, not add+remove', () => {
    const after = JSON.stringify({
      title: 'Revenue',
      cells: [
        { id: 'c1', type: 'sql', content: 'SELECT 1', name: 'renamed' },
        { id: 'c2', type: 'markdown', content: '# hi' },
      ],
    });
    const r = diffNotebook(NB_BEFORE, after);
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0].kind).toBe('cell-changed');
    if (r.changes[0].kind === 'cell-changed') {
      expect(r.changes[0].fields.map((f) => f.path)).toEqual(['name']);
    }
  });

  it('detects added and removed cells', () => {
    const after = JSON.stringify({
      title: 'Revenue',
      cells: [
        { id: 'c1', type: 'sql', content: 'SELECT 1', name: 'first' },
        { id: 'c3', type: 'chart', content: '' },
      ],
    });
    const r = diffNotebook(NB_BEFORE, after);
    const kinds = r.changes.map((c) => c.kind).sort();
    expect(kinds).toEqual(['cell-added', 'cell-removed']);
  });

  it('detects a title change on the notebook itself', () => {
    const after = JSON.stringify({ title: 'Revenue Q2', cells: JSON.parse(NB_BEFORE).cells });
    const r = diffNotebook(NB_BEFORE, after);
    const notebookChange = r.changes.find((c) => c.kind === 'notebook-changed');
    expect(notebookChange).toBeDefined();
  });

  it('treats null before as every cell added (new file)', () => {
    const r = diffNotebook(null, NB_BEFORE);
    const kinds = r.changes.map((c) => c.kind);
    expect(kinds.filter((k) => k === 'cell-added')).toHaveLength(2);
  });

  it('detects a blockBinding state transition', () => {
    const before = JSON.stringify({
      title: 't',
      cells: [{ id: 'c1', type: 'sql', content: 'SELECT 1', blockBinding: { path: 'blocks/foo.dql', state: 'bound' } }],
    });
    const after = JSON.stringify({
      title: 't',
      cells: [{ id: 'c1', type: 'sql', content: 'SELECT 1', blockBinding: { path: 'blocks/foo.dql', state: 'forked' } }],
    });
    const r = diffNotebook(before, after);
    expect(r.changes).toHaveLength(1);
    if (r.changes[0].kind === 'cell-changed') {
      expect(r.changes[0].fields.map((f) => f.path)).toEqual(['blockBinding']);
    }
  });
});
