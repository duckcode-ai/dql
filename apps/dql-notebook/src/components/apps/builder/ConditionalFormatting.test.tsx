import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { QueryResult } from '../../../store/types';
import { TableOutput } from '../../output/TableOutput';
import { staticTableHtml } from '../CanvasPageFrame';
import { ChartStylePanel, conditionalFromRows } from './ChartStylePanel';

const result = {
  columns: ['region', 'revenue', 'margin_rate'],
  rows: [
    { region: 'US', revenue: 85, margin_rate: 0.56 },
    { region: 'CA', revenue: 60, margin_rate: 0.41 },
    { region: 'EU', revenue: 20, margin_rate: 0.12 },
  ],
  columnsMeta: [
    { name: 'region', kind: 'text' },
    { name: 'revenue', kind: 'currency', unit: 'USD', label: 'Revenue' },
    { name: 'margin_rate', kind: 'percent', unit: 'fraction', label: 'Margin rate' },
  ],
} as unknown as QueryResult;
const formats = [
  { column: 'revenue', kind: 'bars' as const },
  { column: 'margin_rate', kind: 'rules' as const, rules: [{ op: 'gte' as const, value: 0.5, tone: 'good' as const }, { op: 'lt' as const, value: 0.2, tone: 'bad' as const }] },
];

describe('conditional formatting in tables (RFC 0009 step 4)', () => {
  it('draws data bars and rule marks with their names in the live table', () => {
    const markup = renderToStaticMarkup(<TableOutput result={result} themeMode="paper" conditionalFormats={formats} />);
    expect(markup).toContain('linear-gradient(90deg, color-mix(in srgb, var(--accent, #0b7a75) 28%, transparent) 100%');
    expect(markup).toContain('aria-label="On track"');
    expect(markup).toContain('aria-label="Off track"');
    expect(markup.match(/aria-label="On track"/g)).toHaveLength(1);
  });

  it('draws the same formats, and formatted values, in static tables for layouts and exports', () => {
    const html = staticTableHtml(result, formats);
    expect(html).toContain('<th>Revenue</th>');
    expect(html).toContain('$85.00');
    expect(html).toContain('56%');
    expect(html).toContain('title="On track"');
    expect(html).toContain('background-image:linear-gradient');
  });

  it('turns panel rows into formats, leaving out rules without a number', () => {
    expect(conditionalFromRows([
      { column: 'revenue', kind: 'scale', rules: [] },
      { column: 'margin_rate', kind: 'rules', rules: [{ op: 'gte', value: '0.5', to: '', tone: 'good' }, { op: 'lt', value: '', to: '', tone: 'bad' }, { op: 'between', value: '0.4', to: '0.2', tone: 'warning' }] },
      { column: '', kind: 'bars', rules: [] },
    ])).toEqual([
      { column: 'revenue', kind: 'scale' },
      { column: 'margin_rate', kind: 'rules', rules: [{ op: 'gte', value: 0.5, tone: 'good' }, { op: 'between', value: 0.2, to: 0.4, tone: 'warning' }] },
    ]);
  });

  it('offers conditional formatting for tables only', () => {
    const table = renderToStaticMarkup(<ChartStylePanel vizType="table" style={{ conditional: formats }} disabled={false} onChange={() => undefined} measureColumns={[{ name: 'revenue', label: 'Revenue' }, { name: 'margin_rate', label: 'Margin rate' }]} />);
    expect(table).toContain('Conditional formatting');
    expect(table).toContain('Data bars');
    expect(table).toContain('On track');
    const line = renderToStaticMarkup(<ChartStylePanel vizType="line" disabled={false} onChange={() => undefined} />);
    expect(line).not.toContain('Conditional formatting');
  });
});
