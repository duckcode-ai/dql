import type { NotebookFile } from '../../store/types';

export type FileLibraryTreeNode =
  | { kind: 'folder'; name: string; path: string; children: FileLibraryTreeNode[] }
  | { kind: 'file'; file: NotebookFile };

export type FileLibraryFolderKey = 'notebooks' | 'blocks' | 'terms' | 'business-views' | 'dashboards';

export function fileLibraryFolder(file: NotebookFile): FileLibraryFolderKey | null {
  if (file.type === 'notebook' || file.type === 'workbook') return 'notebooks';
  if (file.type === 'block') return 'blocks';
  if (file.type === 'term') return 'terms';
  if (file.type === 'business_view') return 'business-views';
  if (file.type === 'dashboard') return 'dashboards';
  return null;
}

export function buildFileLibraryTree(
  files: NotebookFile[],
  folderKey: FileLibraryFolderKey,
): FileLibraryTreeNode[] {
  type MutableFolder = {
    name: string;
    path: string;
    folders: Map<string, MutableFolder>;
    files: NotebookFile[];
  };
  const root: MutableFolder = { name: '', path: '', folders: new Map(), files: [] };

  for (const file of files) {
    const folders = displayFolders(file, folderKey);
    let cursor = root;
    for (const name of folders) {
      const path = [cursor.path, name].filter(Boolean).join('/');
      let child = cursor.folders.get(name);
      if (!child) {
        child = { name, path, folders: new Map(), files: [] };
        cursor.folders.set(name, child);
      }
      cursor = child;
    }
    cursor.files.push(file);
  }

  const materialize = (folder: MutableFolder): FileLibraryTreeNode[] => [
    ...Array.from(folder.folders.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((child) => ({
        kind: 'folder' as const,
        name: child.name,
        path: child.path,
        children: materialize(child),
      })),
    ...folder.files
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((file) => ({ kind: 'file' as const, file })),
  ];

  return materialize(root);
}

function displayFolders(file: NotebookFile, folderKey: FileLibraryFolderKey): string[] {
  const parts = file.path.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts[0] === 'domains') {
    const featureNames = folderKey === 'business-views'
      ? ['views', 'business-views']
      : folderKey === 'notebooks'
        ? ['notebooks', 'workbooks']
        : [folderKey];
    const featureIndex = parts.findIndex((part, index) => index > 0 && featureNames.includes(part));
    if (featureIndex > 0) {
      return ['Domains', ...parts.slice(1, featureIndex), ...parts.slice(featureIndex + 1, -1)];
    }
  }

  const featureIndex = parts.findIndex((part) => (
    part === folderKey
    || (folderKey === 'notebooks' && part === 'workbooks')
    || (folderKey === 'business-views' && part === 'views')
  ));
  const nested = featureIndex >= 0 ? parts.slice(featureIndex + 1, -1) : parts.slice(0, -1);
  return ['Project', ...nested];
}
