import { describe, expect, it } from 'vitest';
import { diffDQL, renderDiffText } from './diff.js';

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
