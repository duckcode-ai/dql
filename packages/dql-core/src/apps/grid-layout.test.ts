import { describe, expect, it } from 'vitest';
import {
  firstFreeGridCell,
  gridBoxesOverlap,
  moveGridItem,
  nudgeGridItem,
  placeGridCopy,
  resizeGridItem,
  settleGridLayout,
  type GridBox,
} from './grid-layout.js';

const box = (i: string, x: number, y: number, w: number, h: number): GridBox => ({ i, x, y, w, h });
const at = (items: GridBox[], id: string) => {
  const found = items.find((item) => item.i === id)!;
  return [found.x, found.y, found.w, found.h];
};
const noOverlaps = (items: GridBox[]) => items.every((a) => items.every((b) => !gridBoxesOverlap(a, b)));

describe('App page grid (RFC 0008 step 5)', () => {
  it('keeps a free placement: side by side stays side by side', () => {
    const items = [box('kpi', 0, 0, 3, 2), box('chart', 3, 0, 9, 4), box('table', 0, 2, 3, 2)];
    expect(settleGridLayout(items, 12)).toEqual(items);
  });

  it('moves only what overlaps, and closes empty rows', () => {
    const settled = settleGridLayout([box('a', 0, 0, 6, 4), box('b', 3, 2, 6, 4), box('c', 0, 20, 12, 2)], 12);
    expect(noOverlaps(settled)).toBe(true);
    expect(at(settled, 'a')).toEqual([0, 0, 6, 4]);
    expect(at(settled, 'b')).toEqual([3, 4, 6, 4]);
    expect(at(settled, 'c')).toEqual([0, 8, 12, 2]);
  });

  it('clamps boxes into the grid', () => {
    expect(at(settleGridLayout([box('wide', 9, -2, 20, 0)], 12), 'wide')).toEqual([0, 0, 12, 1]);
    expect(at(settleGridLayout([box('edge', 10, 0, 4, 2)], 12), 'edge')).toEqual([8, 0, 4, 2]);
  });

  it('lets a dragged tile take the cell it was dropped on', () => {
    const items = [box('a', 0, 0, 6, 4), box('b', 6, 0, 6, 4), box('c', 0, 4, 12, 3)];
    const moved = moveGridItem(items, 'c', 0, 0, 12);
    expect(at(moved, 'c')).toEqual([0, 0, 12, 3]);
    expect(at(moved, 'a')).toEqual([0, 3, 6, 4]);
    expect(at(moved, 'b')).toEqual([6, 3, 6, 4]);
    expect(noOverlaps(moved)).toBe(true);
  });

  it('resizes a tile and pushes the tile below out of the way', () => {
    const resized = resizeGridItem([box('a', 0, 0, 6, 2), box('b', 0, 2, 6, 2)], 'a', 8, 5, 12);
    expect(at(resized, 'a')).toEqual([0, 0, 8, 5]);
    expect(at(resized, 'b')).toEqual([0, 5, 6, 2]);
  });

  it('nudges down past the tile below instead of floating back up', () => {
    const items = [box('a', 0, 0, 6, 2), box('b', 0, 2, 6, 2)];
    const nudged = nudgeGridItem(items, 'a', 0, 1, 12);
    expect(at(nudged, 'b')).toEqual([0, 0, 6, 2]);
    expect(at(nudged, 'a')).toEqual([0, 2, 6, 2]);
    expect(at(nudgeGridItem(items, 'a', 1, 0, 12), 'a')).toEqual([1, 0, 6, 2]);
  });

  it('places a copy to the right when it fits, otherwise below', () => {
    const items = [box('a', 0, 0, 4, 2)];
    expect(at(placeGridCopy(items, items[0]!, box('copy', 0, 0, 4, 2), 12), 'copy')).toEqual([4, 0, 4, 2]);
    const full = [box('a', 0, 0, 12, 2)];
    expect(at(placeGridCopy(full, full[0]!, box('copy', 0, 0, 12, 2), 12), 'copy')).toEqual([0, 2, 12, 2]);
  });

  it('puts a new tile in the first gap that fits, otherwise under the page', () => {
    const items = [box('wide', 0, 0, 12, 2), box('left', 0, 2, 6, 4), box('right', 6, 2, 6, 4), box('table', 0, 6, 6, 4)];
    expect(firstFreeGridCell(items, 6, 4, 12)).toEqual({ x: 6, y: 6 });
    expect(firstFreeGridCell(items, 12, 3, 12)).toEqual({ x: 0, y: 10 });
    expect(firstFreeGridCell([], 4, 2, 12)).toEqual({ x: 0, y: 0 });
  });
});
