import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { QueryResult } from '../../store/types';
import { PivotTable, pivotHtml } from './PivotTable';
import { ChartStylePanel } from './builder/ChartStylePanel';

const row = (region: string | null, month: string | null, customers: number, flags: [number, number]) => ({ region, month, customers, __total_region: flags[0], __total_month: flags[1] });
const result = {
  columns: ['region', 'month', 'customers', '__total_region', '__total_month'],
  rows: [
    row('US', '2026-01', 2, [0, 0]), row('US', '2026-02', 1, [0, 0]), row('EU', '2026-01', 1, [0, 0]), row('EU', '2026-02', 2, [0, 0]),
    row('US', null, 2, [0, 1]), row('EU', null, 3, [0, 1]),
    row(null, '2026-01', 2, [1, 0]), row(null, '2026-02', 3, [1, 0]),
    row(null, null, 3, [1, 1]),
  ],
  columnsMeta: [{ name: 'region', kind: 'text', label: 'Region' }, { name: 'month', kind: 'text', label: 'Month' }, { name: 'customers', kind: 'count', label: 'Customers' }],
} as unknown as QueryResult;
const layout = { rows: ['region'], columns: ['month'], values: ['customers'] };

describe('pivot tiles (RFC 0009 step 4)', () => {
  it('lays out rows, columns, a total column and a total row from the warehouse totals', () => {
    const markup = renderToStaticMarkup(<PivotTable result={result} layout={layout} themeMode="paper" />);
    const text = markup.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');
    expect(text).toContain('|Region|2026-01|2026-02|Total|');
    expect(text).toContain('|EU|1|2|3|');
    expect(text).toContain('|US|2|1|2|');
    // The grand total is the warehouse's 3 customers, not 2 + 3.
    expect(text).toContain('|Total|2|3|3|');
  });

  it('draws the same pivot as static markup for layouts and exports', () => {
    const html = pivotHtml(result, layout, [{ column: 'customers', kind: 'rules', rules: [{ op: 'gte', value: 2, tone: 'good' }] }]);
    expect(html).toContain('<table class="dql-pivot">');
    expect(html).toContain('<tr class="total"><th colspan="1">Total</th>');
    expect(html.match(/title="On track"/g)).toHaveLength(2);
  });

  it('offers totals for a pivot tile', () => {
    const markup = renderToStaticMarkup(<ChartStylePanel vizType="pivot" style={{ totals: { subtotals: false } }} disabled={false} onChange={() => undefined} onTotals={() => undefined} />);
    expect(markup).toContain('Total row');
    expect(markup).toMatch(/id="pivot-subtotals" type="checkbox"(?![^>]*checked)/);
    expect(markup).toContain('Conditional formatting');
  });
});
