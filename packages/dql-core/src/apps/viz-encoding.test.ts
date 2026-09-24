import { describe, expect, it } from 'vitest';
import {
  addFieldByClick,
  chartFromEncoding,
  encodingFromQuery,
  encodingQueryIssues,
  placeOnShelf,
  queryFromEncoding,
  readDashboardVizEncoding,
  removeField,
  removeFromShelf,
  type DashboardVizEncoding,
} from './viz-encoding.js';
import { parseDashboardDocument } from './dashboard-document.js';
import type { TileQuery } from './tile-query-types.js';

const empty: DashboardVizEncoding = { version: 1, columns: [], rows: [] };
const isTime = (field: string) => field === 'order_date';

describe('shelves for a Dataset tile (RFC 0009 step 1)', () => {
  it('builds a chart the way a Tableau author clicks fields', () => {
    // A measure alone is a number.
    let encoding = addFieldByClick(empty, { measure: 'revenue' }, false);
    expect(encoding).toEqual({ version: 1, columns: [], rows: [{ measure: 'revenue' }] });
    expect(chartFromEncoding(encoding, isTime)).toEqual({ kind: 'kpi' });
    // A date runs along Columns and the measure moves to Rows: a line.
    encoding = addFieldByClick(encoding, { dimension: 'order_date' }, true);
    expect(encoding).toMatchObject({ columns: [{ dimension: 'order_date' }], rows: [{ measure: 'revenue' }] });
    expect(chartFromEncoding(encoding, isTime)).toEqual({ kind: 'cartesian', orientation: 'vertical', category: 'order_date', measures: ['revenue'], line: true });
    // A category on a date chart splits it by Colour; the next goes to Detail.
    encoding = addFieldByClick(encoding, { dimension: 'region' }, false);
    expect(encoding.color).toEqual({ dimension: 'region' });
    encoding = addFieldByClick(encoding, { dimension: 'channel' }, false);
    expect(encoding.detail).toEqual([{ dimension: 'channel' }]);
  });

  it('lists a category down Rows with the measures across Columns (horizontal bars)', () => {
    let encoding = addFieldByClick(empty, { measure: 'revenue' }, false);
    encoding = addFieldByClick(encoding, { dimension: 'region' }, false);
    expect(encoding).toEqual({ version: 1, columns: [{ measure: 'revenue' }], rows: [{ dimension: 'region' }] });
    encoding = addFieldByClick(encoding, { measure: 'margin' }, false);
    expect(chartFromEncoding(encoding, isTime)).toEqual({ kind: 'cartesian', orientation: 'horizontal', category: 'region', measures: ['revenue', 'margin'], line: false });
  });

  it('reads two measures as a scatter and a dimension grid with a colour measure as a heatmap', () => {
    const scatter = { version: 1, columns: [{ measure: 'revenue' }], rows: [{ measure: 'margin' }], size: { measure: 'orders' }, detail: [{ dimension: 'customer' }] } as DashboardVizEncoding;
    expect(chartFromEncoding(scatter, isTime)).toEqual({ kind: 'scatter', x: 'revenue', y: 'margin' });
    const heat = { version: 1, columns: [{ dimension: 'order_date' }], rows: [{ dimension: 'region' }], color: { measure: 'revenue' } } as DashboardVizEncoding;
    expect(chartFromEncoding(heat, isTime)).toEqual({ kind: 'heatmap', x: 'order_date', y: 'region', value: 'revenue' });
    const crossed = { version: 1, columns: [{ dimension: 'region' }, { measure: 'revenue' }], rows: [{ dimension: 'channel' }] } as DashboardVizEncoding;
    expect(chartFromEncoding(crossed, isTime).kind).toBe('table');
  });

  it('moves a field between shelves, keeps shelf rules, and repeats measures on Label and Tooltip', () => {
    const start = { version: 1, columns: [{ dimension: 'order_date' }], rows: [{ measure: 'revenue' }] } as DashboardVizEncoding;
    const moved = placeOnShelf(start, 'rows', { dimension: 'order_date' }, 0);
    expect(moved.columns).toEqual([]);
    expect(moved.rows).toEqual([{ dimension: 'order_date' }, { measure: 'revenue' }]);
    // Size takes a measure only; Detail a dimension only.
    expect(placeOnShelf(start, 'size', { dimension: 'region' })).toBe(start);
    expect(placeOnShelf(start, 'detail', { measure: 'revenue' })).toBe(start);
    const labelled = placeOnShelf(start, 'label', { measure: 'revenue' });
    expect(labelled.rows).toEqual([{ measure: 'revenue' }]);
    expect(labelled.label).toEqual([{ measure: 'revenue' }]);
    // Removing from one shelf keeps the field elsewhere, with its settings.
    const named = { ...labelled, fields: { 'measure:revenue': { label: 'Net revenue' } } };
    expect(removeFromShelf(named, 'label', { measure: 'revenue' }).fields).toEqual({ 'measure:revenue': { label: 'Net revenue' } });
    const gone = removeField(named, { measure: 'revenue' });
    expect(gone.rows).toEqual([]);
    expect(gone.fields).toBeUndefined();
  });

  it('derives the checked query from the shelves, keeping grains, filters and valid sorts', () => {
    const previous: TileQuery = {
      dimensions: [{ field: 'order_date', timeGrain: 'month' }],
      measures: [{ measure: 'revenue' }],
      filters: [{ field: 'region', op: 'in', values: ['US'] }],
      orderBy: [{ alias: 'revenue', direction: 'desc' }, { alias: 'channel', direction: 'asc' }],
      limit: 10,
    };
    const encoding = { version: 1, columns: [{ dimension: 'order_date' }], rows: [{ measure: 'revenue' }], color: { dimension: 'region' }, tooltip: [{ measure: 'orders' }] } as DashboardVizEncoding;
    const query = queryFromEncoding(encoding, previous, (field) => (field === 'ship_date' ? 'week' : undefined));
    expect(query).toEqual({
      dimensions: [{ field: 'order_date', timeGrain: 'month' }, { field: 'region' }],
      measures: [{ measure: 'revenue' }, { measure: 'orders' }],
      filters: [{ field: 'region', op: 'in', values: ['US'] }],
      orderBy: [{ alias: 'revenue', direction: 'desc' }],
      limit: 10,
    });
    expect(queryFromEncoding({ version: 1, columns: [{ dimension: 'ship_date' }], rows: [] }, previous, (field) => (field === 'ship_date' ? 'week' : undefined)).dimensions)
      .toEqual([{ field: 'ship_date', timeGrain: 'week' }]);
    expect(encodingQueryIssues(encoding, query)).toEqual([]);
    expect(encodingQueryIssues(encoding, previous)).toEqual(['Colour names region, which the tile\'s query does not select.', 'Tooltip names orders, which the tile\'s query does not select.']);
  });

  it('gives tiles saved before shelves the shelves they already draw as', () => {
    const q = (dimensions: TileQuery['dimensions'], measures: string[]): TileQuery => ({ dimensions, measures: measures.map((measure) => ({ measure })) });
    expect(encodingFromQuery(q([], ['revenue']), 'single_value')).toEqual({ version: 1, columns: [], rows: [{ measure: 'revenue' }] });
    expect(encodingFromQuery(q([{ field: 'region' }], ['revenue']), 'bar')).toEqual({ version: 1, columns: [{ measure: 'revenue' }], rows: [{ dimension: 'region' }] });
    expect(encodingFromQuery(q([{ field: 'region' }, { field: 'order_date', timeGrain: 'month' }], ['revenue']), 'line'))
      .toEqual({ version: 1, columns: [{ dimension: 'order_date' }], rows: [{ measure: 'revenue' }], color: { dimension: 'region' } });
    expect(encodingFromQuery(q([{ field: 'customer' }], ['revenue', 'margin']), 'scatter'))
      .toEqual({ version: 1, columns: [{ measure: 'revenue' }], rows: [{ measure: 'margin' }], detail: [{ dimension: 'customer' }] });
  });

  it('refuses malformed encodings and a page whose shelves name fields the query lacks', () => {
    const errors: string[] = [];
    const parsed = readDashboardVizEncoding({
      version: 1,
      columns: [{ dimension: 'a' }, { measure: 'b', dimension: 'c' }],
      size: { dimension: 'region' },
      fields: { 'measure:b': { label: 'B', format: { kind: 'currency', decimals: 9 } }, bad: {} },
    }, 'viz.encoding', (message) => errors.push(message));
    expect(parsed?.columns).toEqual([{ dimension: 'a' }]);
    expect(parsed?.size).toBeUndefined();
    expect(parsed?.fields).toEqual({ 'measure:b': { label: 'B' } });
    expect(errors).toHaveLength(4);

    const page = (encoding: unknown) => JSON.stringify({
      version: 3, id: 'overview', metadata: { title: 'Overview' },
      datasets: [{ id: 'dataset_1', sourceId: 'app:block:orders', sourceRevision: 'r1', snapshotId: 's1', contractFingerprint: 'c1' }],
      layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [{
        i: 'trend', x: 0, y: 0, w: 6, h: 4, sourceId: 'app:block:orders', sourceRevision: 'r1',
        query: { dimensions: [{ field: 'order_date', timeGrain: 'month' }], measures: [{ measure: 'revenue' }] },
        viz: { type: 'line', encoding },
      }] },
    });
    const ok = parseDashboardDocument(page({ version: 1, columns: [{ dimension: 'order_date' }], rows: [{ measure: 'revenue' }] }), 'overview.dqld');
    expect(ok.errors).toEqual([]);
    expect(ok.document?.layout.items[0]?.viz.encoding?.rows).toEqual([{ measure: 'revenue' }]);
    const stale = parseDashboardDocument(page({ version: 1, columns: [{ dimension: 'order_date' }], rows: [{ measure: 'margin' }] }), 'overview.dqld');
    expect(stale.errors.map((error) => error.message).join(' ')).toContain('Rows names margin');
  });
});
