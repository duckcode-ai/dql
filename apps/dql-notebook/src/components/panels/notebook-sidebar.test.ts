import { describe, expect, it } from 'vitest';
import type { NotebookFile } from '../../store/types';
import { filterNotebookFiles } from './notebook-sidebar';

const files: NotebookFile[] = [
  {
    name: 'retention.dqlnb',
    path: 'notebooks/retention.dqlnb',
    type: 'notebook',
    folder: 'notebooks',
    ownerDomain: 'commerce',
    usesDomains: ['commerce'],
  },
  {
    name: 'quality_review.dqlnb',
    path: 'notebooks/quality_review.dqlnb',
    type: 'notebook',
    folder: 'notebooks',
    ownerDomain: 'operations',
    usesDomains: ['operations'],
  },
  {
    name: 'revenue.dql',
    path: 'blocks/revenue.dql',
    type: 'block',
    folder: 'blocks',
  },
];

describe('notebook sidebar filtering', () => {
  it('keeps only notebooks and supports names and domain context', () => {
    expect(filterNotebookFiles(files, '').map((file) => file.name)).toEqual([
      'quality_review.dqlnb',
      'retention.dqlnb',
    ]);
    expect(filterNotebookFiles(files, 'commerce').map((file) => file.name)).toEqual([
      'retention.dqlnb',
    ]);
    expect(filterNotebookFiles(files, 'quality').map((file) => file.name)).toEqual([
      'quality_review.dqlnb',
    ]);
  });
});
