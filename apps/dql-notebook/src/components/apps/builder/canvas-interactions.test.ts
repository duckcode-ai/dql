import { describe, expect, it } from 'vitest';
import type { AppStudioBuildDraft, AppStudioDraftOperation } from '../../../api/client';
import {
  canvasRowHeight,
  canvasShortcut,
  cellsFromPixels,
  copyTileId,
  incrementalPreviewPlan,
  loadStudioHistory,
  saveStudioHistory,
  tileBodyHeight,
} from './canvas-interactions';

type Tile = AppStudioBuildDraft['pages'][number]['layout']['items'][number];
const tile = (i: string, extra: Partial<Tile> = {}) => ({ i, x: 0, y: 0, w: 4, h: 3, viz: { type: 'bar' }, ...extra }) as Tile;

class MemoryStore {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

describe('Studio canvas interactions (RFC 0008 step 5)', () => {
  it('reruns only the tiles an edit touches', () => {
    const operations: AppStudioDraftOperation[] = [
      { type: 'update_tile', pageId: 'p', tileId: 'a', patch: { query: {} as never } },
      { type: 'update_tile', pageId: 'p', tileId: 'b', patch: { title: 'Renamed', w: 6 } },
      { type: 'add_tile', pageId: 'p', tile: tile('c') },
      { type: 'set_layout', pageId: 'p', layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [] } as never },
    ];
    expect(incrementalPreviewPlan(operations, 'p')).toEqual({ rerunTileIds: ['a', 'c'], dropTileIds: ['a'] });
  });

  it('drops a removed tile and never reruns it', () => {
    expect(incrementalPreviewPlan([
      { type: 'add_tile', pageId: 'p', tile: tile('c') },
      { type: 'remove_tile', pageId: 'p', tileId: 'c' },
    ], 'p')).toEqual({ rerunTileIds: [], dropTileIds: ['c'] });
  });

  it('reruns the whole page for page-wide edits or edits on another page', () => {
    expect(incrementalPreviewPlan([{ type: 'remove_filter', pageId: 'p', filterId: 'region' } as never], 'p')).toBeUndefined();
    expect(incrementalPreviewPlan([{ type: 'remove_tile', pageId: 'other', tileId: 'a' }], 'p')).toBeUndefined();
  });

  it('names copies without colliding', () => {
    expect(copyTileId([tile('revenue')], 'revenue')).toBe('revenue-copy');
    expect(copyTileId([tile('revenue'), tile('revenue-copy')], 'revenue-copy')).toBe('revenue-copy-2');
  });

  it('maps keys to canvas actions and leaves typing alone', () => {
    const on = (key: string, extra: Record<string, unknown> = {}) => canvasShortcut({ key, target: { tagName: 'DIV' }, ...extra }, true);
    expect(on('ArrowRight')).toEqual({ kind: 'move', dx: 1, dy: 0 });
    expect(on('ArrowDown', { shiftKey: true })).toEqual({ kind: 'resize', dw: 0, dh: 1 });
    expect(on('d', { metaKey: true })).toEqual({ kind: 'duplicate' });
    expect(on('Delete')).toEqual({ kind: 'remove' });
    expect(on('z', { ctrlKey: true })).toEqual({ kind: 'undo' });
    expect(on('Z', { metaKey: true, shiftKey: true })).toEqual({ kind: 'redo' });
    expect(on('Escape')).toEqual({ kind: 'deselect' });
    expect(canvasShortcut({ key: 'Backspace', target: { tagName: 'INPUT' } }, true)).toBeUndefined();
    expect(canvasShortcut({ key: 'z', metaKey: true, target: { tagName: 'TEXTAREA' } }, true)).toBeUndefined();
    expect(canvasShortcut({ key: 'ArrowLeft', target: { tagName: 'DIV' } }, false)).toBeUndefined();
  });

  it('sizes a placed chart from its rows', () => {
    expect(canvasRowHeight(undefined)).toBe(80);
    expect(canvasRowHeight(500)).toBe(160);
    expect(tileBodyHeight(4, 80)).toBe(4 * 80 + 3 * 12 - 60);
    expect(tileBodyHeight(1, 40)).toBe(96);
    expect(cellsFromPixels(130, 60)).toBe(2);
    expect(cellsFromPixels(-20, 60)).toBe(0);
  });

  it('keeps undo across a reload, for a few drafts only', () => {
    const store = new MemoryStore();
    const draft = (id: string, revision: number) => ({ id, revision }) as unknown as AppStudioBuildDraft;
    saveStudioHistory('d1', { undo: [draft('d1', 1), draft('d1', 2)], redo: [draft('d1', 4)] }, store);
    expect(loadStudioHistory('d1', store).undo.map((entry) => entry.revision)).toEqual([1, 2]);
    expect(loadStudioHistory('d1', store).redo.map((entry) => entry.revision)).toEqual([4]);
    // Entries for another draft are ignored.
    store.setItem('dql.studio.history.d9', JSON.stringify({ undo: [draft('d1', 1)], redo: [] }));
    expect(loadStudioHistory('d9', store).undo).toEqual([]);
    for (const id of ['d2', 'd3', 'd4', 'd5', 'd6']) saveStudioHistory(id, { undo: [draft(id, 1)], redo: [] }, store);
    expect(store.getItem('dql.studio.history.d1')).toBeNull();
    expect(loadStudioHistory('d6', store).undo).toHaveLength(1);
    saveStudioHistory('d6', { undo: [], redo: [] }, store);
    expect(store.getItem('dql.studio.history.d6')).toBeNull();
    expect(loadStudioHistory('missing', undefined)).toEqual({ undo: [], redo: [] });
  });
});
