import { describe, expect, it } from 'vitest';
import { parseDashboardDocument } from './dashboard-document.js';
import { readDashboardVizStyle } from './viz-style.js';

const page = (style: unknown) => JSON.stringify({
  version: 1,
  id: 'overview',
  metadata: { title: 'Overview' },
  layout: {
    kind: 'grid', cols: 12, rowHeight: 80,
    items: [{ i: 'trend', x: 0, y: 0, w: 8, h: 4, block: { blockId: 'revenue_trend' }, viz: { type: 'line', style } }],
  },
});

describe('viz style (RFC 0008 step 4)', () => {
  it('keeps a complete style through the page parser', () => {
    const style = {
      labels: 'last', stack: false, format: 'compact', palette: 'dql', legend: 'top', sort: 'desc',
      referenceLines: [{ value: 1.5, label: 'Target' }],
      bands: [{ from: 1.45, to: 1.55, label: 'Target range' }],
      annotations: [{ at: '2026-07-14', text: 'EU price change' }],
    };
    const { document, errors } = parseDashboardDocument(page(style));
    expect(errors).toEqual([]);
    expect(document!.layout.items[0]!.viz.style).toEqual(style);
  });

  it('leaves viz without a style exactly as before', () => {
    const { document, errors } = parseDashboardDocument(page(undefined));
    expect(errors).toEqual([]);
    expect(document!.layout.items[0]!.viz).toEqual({ type: 'line', options: undefined });
  });

  it('reports malformed fields and keeps only the good ones', () => {
    const errors: string[] = [];
    const style = readDashboardVizStyle({
      labels: 'sometimes',
      stack: 'yes',
      format: 'currency',
      referenceLines: [{ value: 'high' }, { value: 3 }],
      bands: [{ from: 5, to: 2 }],
      annotations: [{ at: 'Jul', text: '' }, { at: 202607, text: 'Launch' }],
    }, 'viz.style', (message) => errors.push(message));
    expect(style).toEqual({
      format: 'currency',
      referenceLines: [{ value: 3 }],
      annotations: [{ at: '202607', text: 'Launch' }],
    });
    expect(errors).toEqual([
      'viz.style.labels must be one of none|last|all',
      'viz.style.stack must be true or false',
      'viz.style.referenceLines[0].value must be a number',
      'viz.style.bands[0].from must not be greater than to',
      'viz.style.annotations[0] needs an x value (at) and text',
    ]);
  });

  it('caps marks per list and ignores an empty style', () => {
    const errors: string[] = [];
    const lines = Array.from({ length: 25 }, (_, index) => ({ value: index }));
    expect(readDashboardVizStyle({ referenceLines: lines }, 's', (m) => errors.push(m))?.referenceLines).toHaveLength(20);
    expect(errors).toEqual(['s.referenceLines has 25 entries; at most 20 are kept']);
    expect(readDashboardVizStyle({}, 's', () => undefined)).toBeUndefined();
  });
});
