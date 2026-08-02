import { describe, expect, it } from 'vitest';
import type { NotebookFile } from '../../store/types';
import { filterNotebookFiles, notebookDomains } from './notebook-sidebar';

const domains = [
  { id: 'commerce', name: 'Commerce' },
  { id: 'operations', name: 'Operations' },
];

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
    name: 'shared_growth.dqlnb',
    path: 'notebooks/shared_growth.dqlnb',
    type: 'notebook',
    folder: 'notebooks',
    ownerDomain: 'analytics',
    usesDomains: ['commerce'],
  },
  {
    name: 'scratchpad.dqlnb',
    path: 'notebooks/scratchpad.dqlnb',
    type: 'notebook',
    folder: 'notebooks',
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
      'scratchpad.dqlnb',
      'shared_growth.dqlnb',
    ]);
    expect(filterNotebookFiles(files, 'commerce').map((file) => file.name)).toEqual([
      'retention.dqlnb',
      'shared_growth.dqlnb',
    ]);
    expect(filterNotebookFiles(files, 'quality').map((file) => file.name)).toEqual([
      'quality_review.dqlnb',
    ]);
  });

  it('offers only authored domains plus one unassigned recovery scope', () => {
    expect(notebookDomains(files, domains)).toEqual(['commerce', 'operations', 'uncategorized']);
  });

  it('filters backlinks by domain while keeping all notebooks in the global view', () => {
    expect(filterNotebookFiles(files, '', 'commerce', domains).map((file) => file.name)).toEqual([
      'retention.dqlnb',
      'shared_growth.dqlnb',
    ]);
    expect(filterNotebookFiles(files, '', 'analytics', domains)).toEqual([]);
    expect(filterNotebookFiles(files, '', 'uncategorized', domains).map((file) => file.name)).toEqual([
      'scratchpad.dqlnb',
    ]);
  });
});
