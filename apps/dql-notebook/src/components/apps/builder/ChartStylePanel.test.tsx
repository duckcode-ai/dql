import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChartStylePanel, compactVizStyle, styleMarksFromRows } from './ChartStylePanel';

describe('ChartStylePanel (RFC 0008 step 4)', () => {
  it('keeps an untouched style out of the page file', () => {
    expect(compactVizStyle({ labels: undefined, referenceLines: [] })).toBeUndefined();
    expect(compactVizStyle({ format: 'compact', bands: [] })).toEqual({ format: 'compact' });
  });

  it('turns typed rows into style marks and skips incomplete ones', () => {
    expect(styleMarksFromRows(
      [{ value: '1.5', label: ' Target ' }, { value: '', label: 'no value' }, { value: 'abc', label: '' }],
      [{ from: '1.55', to: '1.45', label: 'Range' }, { from: '1', to: '', label: '' }],
      [{ at: '2026-07-14', text: 'EU price change' }, { at: '', text: 'no position' }],
    )).toEqual({
      referenceLines: [{ value: 1.5, label: 'Target' }],
      bands: [{ from: 1.45, to: 1.55, label: 'Range' }],
      annotations: [{ at: '2026-07-14', text: 'EU price change' }],
    });
  });

  it('shows reference lines, bands and notes only for charts with a value axis', () => {
    const line = renderToStaticMarkup(<ChartStylePanel vizType="line" style={{ referenceLines: [{ value: 2, label: 'Goal' }] }} disabled={false} onChange={() => undefined} />);
    expect(line).toContain('Add reference line');
    expect(line).toContain('Add note');
    expect(line).toContain('Stack series');
    const pie = renderToStaticMarkup(<ChartStylePanel vizType="pie" disabled={false} onChange={() => undefined} />);
    expect(pie).not.toContain('Add reference line');
    expect(pie).toContain('Legend');
  });

  it('starts from the number format a tile saved before styles existed', () => {
    const markup = renderToStaticMarkup(<ChartStylePanel vizType="bar" legacyFormat="currency" disabled={false} onChange={() => undefined} />);
    expect(markup).toMatch(/<option value="currency" selected="">/);
  });
});
