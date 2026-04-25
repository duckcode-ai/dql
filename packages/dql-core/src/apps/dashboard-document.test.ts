import { describe, it, expect } from 'vitest';
import {
  parseDashboardDocument,
  extractDashboardBlockRefs,
  isBlockIdRef,
  type DashboardDocument,
} from './dashboard-document.js';

const minimal: DashboardDocument = {
  version: 1,
  id: 'weekly-overview',
  metadata: { title: 'Weekly Overview' },
  layout: {
    kind: 'grid',
    cols: 12,
    rowHeight: 80,
    items: [
      {
        i: 'kpi',
        x: 0, y: 0, w: 3, h: 2,
        block: { blockId: 'revenue_total' },
        viz: { type: 'single_value' },
      },
      {
        i: 'trend',
        x: 3, y: 0, w: 9, h: 4,
        block: { ref: 'blocks/revenue_trend.dql' },
        viz: { type: 'line' },
      },
    ],
  },
};

describe('parseDashboardDocument', () => {
  it('parses both blockId and ref forms', () => {
    const { document, errors } = parseDashboardDocument(JSON.stringify(minimal));
    expect(errors).toEqual([]);
    expect(document?.layout.items).toHaveLength(2);
  });

  it('errors on unknown viz type', () => {
    const bad = {
      ...minimal,
      layout: {
        ...minimal.layout,
        items: [{
          i: 'x', x: 0, y: 0, w: 1, h: 1,
          block: { blockId: 'z' },
          viz: { type: 'spaghetti' },
        }],
      },
    };
    const { document, errors } = parseDashboardDocument(JSON.stringify(bad));
    expect(document).toBeNull();
    expect(errors[0].message).toMatch(/viz\.type must be in/);
  });

  it('errors when block ref is missing', () => {
    const bad = {
      ...minimal,
      layout: {
        ...minimal.layout,
        items: [{
          i: 'x', x: 0, y: 0, w: 1, h: 1,
          block: {},
          viz: { type: 'line' },
        }],
      },
    };
    const { document, errors } = parseDashboardDocument(JSON.stringify(bad));
    expect(document).toBeNull();
    expect(errors[0].message).toMatch(/block must be \{ blockId \} or \{ ref \}/);
  });

  it('rejects non-grid layouts (single supported kind today)', () => {
    const bad = {
      ...minimal,
      layout: { ...minimal.layout, kind: 'flex' },
    };
    const { document, errors } = parseDashboardDocument(JSON.stringify(bad));
    expect(document).toBeNull();
    expect(errors[0].message).toMatch(/layout\.kind must be "grid"/);
  });
});

describe('extractDashboardBlockRefs', () => {
  it('separates id refs from path refs', () => {
    const refs = extractDashboardBlockRefs(minimal);
    expect(refs.byId).toEqual(['revenue_total']);
    expect(refs.byPath).toEqual(['blocks/revenue_trend.dql']);
  });
});

describe('isBlockIdRef', () => {
  it('recognises by-id refs', () => {
    expect(isBlockIdRef({ blockId: 'foo' })).toBe(true);
    expect(isBlockIdRef({ ref: 'blocks/foo.dql' })).toBe(false);
  });
});
