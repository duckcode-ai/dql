import { describe, expect, it } from 'vitest';
import type { BlockEntry } from '../blocks/block-types';
import {
  blockFolderInsideDomain,
  blockPathInsideDomain,
  buildBlockLibraryTree,
} from './block-library-tree.js';

function block(name: string, path: string): BlockEntry {
  return {
    name,
    path,
    domain: 'finance',
    status: 'draft',
    owner: 'analytics',
    tags: [],
    description: '',
    lastModified: '2026-07-25T00:00:00.000Z',
  };
}

describe('Block Studio library folders', () => {
  it('derives a user-controlled folder below both supported block roots', () => {
    expect(blockPathInsideDomain('domains/finance/blocks/executive/monthly/revenue.dql', 'finance'))
      .toBe('executive/monthly/revenue.dql');
    expect(blockFolderInsideDomain('domains/finance/blocks/executive/monthly/revenue.dql', 'finance'))
      .toBe('executive/monthly');
    expect(blockFolderInsideDomain('blocks/finance/operations/margin.dql', 'finance'))
      .toBe('operations');
  });

  it('builds folders before files and preserves nested block paths', () => {
    const tree = buildBlockLibraryTree([
      block('Root', 'domains/finance/blocks/root.dql'),
      block('Revenue', 'domains/finance/blocks/executive/monthly/revenue.dql'),
      block('Margin', 'domains/finance/blocks/executive/margin.dql'),
    ], 'finance');

    expect(tree[0]).toMatchObject({
      kind: 'folder',
      name: 'executive',
      children: [
        {
          kind: 'folder',
          name: 'monthly',
          children: [{ kind: 'block', block: { name: 'Revenue' } }],
        },
        { kind: 'block', block: { name: 'Margin' } },
      ],
    });
    expect(tree[1]).toMatchObject({ kind: 'block', block: { name: 'Root' } });
  });
});
