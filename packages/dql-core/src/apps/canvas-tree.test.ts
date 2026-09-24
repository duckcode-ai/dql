import { describe, expect, it } from 'vitest';
import {
  annotateCanvasHtml,
  canvasContainerPath,
  canvasNodeAt,
  canvasPieceKind,
  checkCanvasHtml,
  fillCanvasHtml,
  insertCanvasNodes,
  moveCanvasNode,
  parseCanvasHtml,
  removeCanvasNode,
  replaceCanvasNode,
  serializeCanvasNodes,
  type CanvasNode,
} from './canvas-page.js';

const page = checkCanvasHtml([
  '<style>.band{display:grid;gap:8px}</style>',
  '<article class="page">',
  '<h1>Commerce revenue</h1>',
  '<p>Revenue is <strong><dql-value bind="revenue.revenue"></dql-value></strong>.</p>',
  '<section class="band"><div class="figure"><small>Orders</small><strong><dql-value bind="orders.count"></dql-value></strong></div></section>',
  '<dql-tile tile="revenue"></dql-tile>',
  '</article>',
].join('')).html;

const el = (tag: string, children: CanvasNode[] = [], attrs: Array<[string, string]> = []): CanvasNode => ({ kind: 'element', tag, attrs, children });
const text = (value: string): CanvasNode => ({ kind: 'text', text: value });

describe('editing a Custom layout as a tree', () => {
  it('reads checked markup and writes it back unchanged', () => {
    const nodes = parseCanvasHtml(page);
    expect(serializeCanvasNodes(nodes)).toBe(page);
    expect(checkCanvasHtml(serializeCanvasNodes(nodes)).issues).toEqual([]);
    // Style text is kept as written, not escaped.
    expect(serializeCanvasNodes(nodes)).toContain('<style>.band{display:grid;gap:8px}</style>');
  });

  it('finds the page frame that new pieces go into', () => {
    const nodes = parseCanvasHtml(page);
    expect(canvasContainerPath(nodes)).toEqual([1]);
    expect(canvasContainerPath(parseCanvasHtml('<h1>A</h1><p>B</p>'))).toEqual([]);
    // A lone box of words is a piece, not a frame.
    expect(canvasContainerPath(parseCanvasHtml('<div>Only <strong>words</strong></div>'))).toEqual([]);
  });

  it('marks every element with its path so a click maps back to the source, and fill keeps the marks', () => {
    const annotated = annotateCanvasHtml(page);
    expect(annotated).toContain('<h1 data-dql-path="1.0">');
    expect(annotated).toContain('<dql-tile tile="revenue" data-dql-path="1.3">');
    expect(annotated).not.toContain('<style data-dql-path');
    const filled = fillCanvasHtml(annotated, { 'revenue.revenue': { key: 'revenue.revenue', tileId: 'revenue', label: 'Revenue', kind: 'number', value: 110, display: '$110' } }, () => '<svg></svg>');
    expect(filled).toContain('<span class="dql-value" data-bind="revenue.revenue" data-dql-path="1.1.1.0" title="Revenue">$110</span>');
    expect(filled).toContain('<div class="dql-tile" data-tile="revenue" data-dql-path="1.3">');
    // Annotated markup is for the editor only: the checker refuses it.
    expect(checkCanvasHtml(annotated).issues.some((issue) => issue.code === 'UNSAFE_ATTRIBUTE')).toBe(true);
  });

  it('moves a piece past its neighbours and stops at the edges', () => {
    const nodes = parseCanvasHtml(page);
    const up = moveCanvasNode(nodes, [1, 3], -1)!;
    expect(up.path).toEqual([1, 2]);
    expect((canvasNodeAt(up.nodes, [1, 2]) as Extract<CanvasNode, { kind: 'element' }>).tag).toBe('dql-tile');
    expect(moveCanvasNode(nodes, [1, 0], -1)).toBeNull();
    expect(moveCanvasNode(nodes, [1, 3], 1)).toBeNull();
    // Whitespace between pieces is skipped, not counted as a piece.
    const spaced = parseCanvasHtml('<h1>A</h1>\n<p>B</p>');
    expect(moveCanvasNode(spaced, [2], -1)!.path).toEqual([0]);
  });

  it('inserts after the selected piece or at the end of the frame, and removes pieces', () => {
    const nodes = parseCanvasHtml(page);
    const after = insertCanvasNodes(nodes, [el('h2', [text('Details')])], [1, 0]);
    expect(after.path).toEqual([1, 1]);
    expect(serializeCanvasNodes(after.nodes)).toContain('<h1>Commerce revenue</h1><h2>Details</h2><p>');
    const atEnd = insertCanvasNodes(nodes, [el('dql-tile', [], [['tile', 'orders']])]);
    expect(atEnd.path).toEqual([1, 4]);
    expect(serializeCanvasNodes(atEnd.nodes)).toContain('<dql-tile tile="revenue"></dql-tile><dql-tile tile="orders"></dql-tile></article>');
    expect(serializeCanvasNodes(removeCanvasNode(nodes, [1, 3]))).not.toContain('dql-tile');
    const retitled = replaceCanvasNode(nodes, [1, 0], el('h2', [text('Revenue this month')]));
    expect(serializeCanvasNodes(retitled)).toContain('<h2>Revenue this month</h2>');
  });

  it('names each piece for the editor, and knows which ones take typing', () => {
    const nodes = parseCanvasHtml(page);
    const kind = (path: number[]) => canvasPieceKind(canvasNodeAt(nodes, path)!);
    expect(kind([1, 0])).toBe('heading');
    expect(kind([1, 1])).toBe('text');
    expect(kind([1, 1, 1, 0])).toBe('value');
    expect(kind([1, 2])).toBe('group');
    expect(kind([1, 2, 0])).toBe('text');
    expect(kind([1, 3])).toBe('tile');
    expect(canvasPieceKind(el('hr'))).toBe('rule');
    expect(canvasPieceKind(el('ul', [el('li', [text('a')])]))).toBe('list');
  });
});
