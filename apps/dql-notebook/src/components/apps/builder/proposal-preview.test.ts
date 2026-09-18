import { describe, expect, it } from 'vitest';
import type { AppStudioBuildDraft } from '../../../api/client';
import { projectProposal } from './proposal-preview';

type Page = AppStudioBuildDraft['pages'][number];
const tile = (i: string, y: number, extra: Record<string, unknown> = {}) => ({ i, x: 0, y, w: 6, h: 4, title: i, viz: { type: 'bar' }, ...extra });
const overview = {
  id: 'overview', version: 3, metadata: { title: 'Overview' },
  layout: { columns: 12, items: [tile('revenue', 0), tile('region', 4, { query: { measures: [{ measure: 'revenue' }], dimensions: [{ field: 'region' }] } })] },
} as unknown as Page;

describe('AI proposal projected onto the canvas', () => {
  it('marks added, changed, and removed tiles on the page they belong to', () => {
    const [page] = projectProposal([overview], [
      { type: 'add_tile', pageId: 'overview', tile: tile('top-customers', 8) as never },
      { type: 'update_tile', pageId: 'overview', tileId: 'revenue', patch: { title: 'Net revenue' } },
      { type: 'remove_tile', pageId: 'overview', tileId: 'region' },
    ]);
    expect(page!.items.map((item) => [item.tile.i, item.change])).toEqual([
      ['revenue', 'updated'], ['top-customers', 'added'], ['region', 'removed'],
    ]);
    expect(page!.items[0]!.before?.title).toBe('revenue');
    expect(page!.changeCount).toBe(3);
  });

  it('shows a new page and a new click link without touching the input draft', () => {
    const pages = projectProposal([overview], [
      { type: 'set_interactions', pageId: 'overview', interactions: { crossFilter: { mappings: [{ fromTileId: 'region', fromField: 'region', toDataset: 'ds', toField: 'region' }] } } },
      { type: 'upsert_page', page: { ...overview, id: 'detail', metadata: { title: 'Detail' }, layout: { columns: 12, items: [tile('lines', 0)] } } as never },
    ]);
    expect(pages.map((page) => [page.id, page.isNew])).toEqual([['overview', false], ['detail', true]]);
    expect([...pages[0]!.linkedTileIds]).toEqual(['region']);
    expect(pages[0]!.items.every((item) => item.change === 'unchanged')).toBe(true);
    expect(pages[1]!.items.map((item) => item.change)).toEqual(['added']);
    expect(overview.interactions).toBeUndefined();
    expect(overview.layout.items).toHaveLength(2);
  });
});
