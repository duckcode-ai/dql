import { describe, expect, it } from 'vitest';
import type { NotebookFile } from '../../store/types';
import { buildFileLibraryTree, fileLibraryFolder } from './file-library-tree';

function file(
  path: string,
  type: NotebookFile['type'],
  context: Pick<NotebookFile, 'ownerDomain' | 'usesDomains'> = {},
): NotebookFile {
  return {
    name: path.split('/').at(-1) ?? path,
    path,
    type,
    folder: path.split('/').slice(0, -1).join('/'),
    ...context,
  };
}

describe('domain-aware file library tree', () => {
  it('classifies artifacts by type instead of dropping domain-owned paths', () => {
    expect(fileLibraryFolder(file('domains/commerce/notebooks/research/churn.dqlnb', 'notebook'))).toBe('notebooks');
    expect(fileLibraryFolder(file('domains/commerce/blocks/customer/profile.dql', 'block'))).toBe('blocks');
  });

  it('groups global notebooks by ProductDomainContext without duplicating their Git path', () => {
    const tree = buildFileLibraryTree([
      file('notebooks/executive/overview.dqlnb', 'notebook'),
      file('notebooks/research/churn.dqlnb', 'notebook', {
        ownerDomain: 'commerce.customer',
        usesDomains: ['commerce.customer'],
      }),
    ], 'notebooks');

    expect(tree).toMatchObject([
      {
        kind: 'folder',
        name: 'Domains',
        children: [{
          kind: 'folder',
          name: 'commerce',
          children: [{
            kind: 'folder',
            name: 'customer',
            children: [{
              kind: 'folder',
              name: 'research',
              children: [{
                kind: 'file',
                file: {
                  path: 'notebooks/research/churn.dqlnb',
                  ownerDomain: 'commerce.customer',
                },
              }],
            }],
          }],
        }],
      },
      {
        kind: 'folder',
        name: 'Project',
        children: [{
          kind: 'folder',
          name: 'executive',
          children: [{ kind: 'file', file: { path: 'notebooks/executive/overview.dqlnb' } }],
        }],
      },
    ]);
  });
});
