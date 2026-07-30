import type { NotebookFile } from '../../store/types';

export function filterNotebookFiles(files: NotebookFile[], search: string): NotebookFile[] {
  const needle = search.trim().toLowerCase();
  return Array.from(
    new Map(files.filter((file) => file.type === 'notebook').map((file) => [file.path, file])).values(),
  )
    .filter((file) => !needle
      || file.name.toLowerCase().includes(needle)
      || file.path.toLowerCase().includes(needle)
      || file.ownerDomain?.toLowerCase().includes(needle)
      || file.usesDomains?.some((domain) => domain.toLowerCase().includes(needle)))
    .sort((a, b) => a.name.localeCompare(b.name));
}
