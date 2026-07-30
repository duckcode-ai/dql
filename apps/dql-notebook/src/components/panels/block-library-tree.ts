import type { BlockEntry } from '../blocks/block-types';

export type BlockLibraryTreeNode =
  | { kind: 'folder'; name: string; path: string; children: BlockLibraryTreeNode[] }
  | { kind: 'block'; block: BlockEntry };

export function blockPathInsideDomain(blockPath: string, domain: string): string {
  const normalized = blockPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const domainFirst = normalized.match(/^domains\/[^/]+\/blocks\/(.+)$/);
  if (domainFirst) return domainFirst[1];
  const legacyPrefix = `blocks/${domain.replace(/^\/+|\/+$/g, '')}/`;
  if (normalized.startsWith(legacyPrefix)) return normalized.slice(legacyPrefix.length);
  if (normalized.startsWith('blocks/')) return normalized.slice('blocks/'.length);
  return normalized;
}

export function blockFolderInsideDomain(blockPath: string, domain: string): string {
  const relativePath = blockPathInsideDomain(blockPath, domain);
  const parts = relativePath.split('/').filter(Boolean);
  return parts.slice(0, -1).join('/');
}

export function buildBlockLibraryTree(blocks: BlockEntry[], domain: string): BlockLibraryTreeNode[] {
  type MutableFolder = { name: string; path: string; folders: Map<string, MutableFolder>; blocks: BlockEntry[] };
  const root: MutableFolder = { name: '', path: '', folders: new Map(), blocks: [] };

  for (const block of blocks) {
    const owningDomain = block.domain?.trim() || 'uncategorized';
    const relativePath = blockPathInsideDomain(block.path, domain || owningDomain);
    const parts = relativePath.split('/').filter(Boolean);
    // Selected-domain views omit the redundant domain folder. The all-domains
    // view keeps ownership visible as its top-level grouping.
    const folders = domain ? parts.slice(0, -1) : [owningDomain, ...parts.slice(0, -1)];
    let cursor = root;
    for (const folderName of folders) {
      const folderPath = [cursor.path, folderName].filter(Boolean).join('/');
      let folder = cursor.folders.get(folderName);
      if (!folder) {
        folder = { name: folderName, path: folderPath, folders: new Map(), blocks: [] };
        cursor.folders.set(folderName, folder);
      }
      cursor = folder;
    }
    cursor.blocks.push(block);
  }

  const materialize = (folder: MutableFolder): BlockLibraryTreeNode[] => [
    ...Array.from(folder.folders.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((child) => ({
        kind: 'folder' as const,
        name: child.name,
        path: child.path,
        children: materialize(child),
      })),
    ...folder.blocks
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((block) => ({ kind: 'block' as const, block })),
  ];

  return materialize(root);
}
