import { describe, expect, it } from 'vitest';
import { MAX_TILE_DESCRIPTION, parseDashboardDocument } from './dashboard-document.js';

const page = (extra: Record<string, unknown>) => JSON.stringify({
  version: 1,
  id: 'overview',
  metadata: { title: 'Overview' },
  layout: {
    kind: 'grid', cols: 12, rowHeight: 80,
    items: [{ i: 'revenue', x: 0, y: 0, w: 4, h: 2, block: { blockId: 'revenue' }, viz: { type: 'kpi' }, ...extra }],
  },
});

describe('tile description and owner (RFC 0008 step 6)', () => {
  it('keeps a trimmed description and owner through the page parser', () => {
    const { document, errors } = parseDashboardDocument(page({ description: '  Net of refunds, **before** tax. ', owner: 'Finance analytics' }));
    expect(errors).toEqual([]);
    expect(document!.layout.items[0]).toMatchObject({ description: 'Net of refunds, **before** tax.', owner: 'Finance analytics' });
  });

  it('leaves both out of the page when they are empty or absent', () => {
    const { document } = parseDashboardDocument(page({ description: '   ' }));
    expect(document!.layout.items[0]).not.toHaveProperty('description');
    expect(document!.layout.items[0]).not.toHaveProperty('owner');
  });

  it('rejects non-text and over-long values', () => {
    const { errors } = parseDashboardDocument(page({ description: 'x'.repeat(MAX_TILE_DESCRIPTION + 1), owner: 7 }));
    expect(errors.map((error) => error.message)).toEqual(expect.arrayContaining([
      `layout.items[0].description must be at most ${MAX_TILE_DESCRIPTION} characters.`,
      'layout.items[0].owner must be a string.',
    ]));
  });
});
