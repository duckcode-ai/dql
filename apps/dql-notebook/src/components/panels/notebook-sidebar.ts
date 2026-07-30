import type { NotebookFile } from '../../store/types';

export function notebookDomains(files: NotebookFile[]): string[] {
  const domains = files
    .filter((file) => file.type === 'notebook')
    .flatMap((file) => {
      const related = [file.ownerDomain, ...(file.usesDomains ?? [])]
        .map((domain) => domain?.trim())
        .filter((domain): domain is string => Boolean(domain));
      return related.length > 0 ? related : ['uncategorized'];
    });
  return [...new Set(domains)].sort((a, b) => a.localeCompare(b));
}

export function filterNotebookFiles(files: NotebookFile[], search: string, domain = ''): NotebookFile[] {
  const needle = search.trim().toLowerCase();
  return Array.from(
    new Map(files.filter((file) => file.type === 'notebook').map((file) => [file.path, file])).values(),
  )
    .filter((file) => {
      const relatedDomains = [file.ownerDomain, ...(file.usesDomains ?? [])]
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value));
      const domainMatches = !domain
        || (domain === 'uncategorized' ? relatedDomains.length === 0 : relatedDomains.includes(domain));
      return domainMatches && (!needle
        || file.name.toLowerCase().includes(needle)
        || file.path.toLowerCase().includes(needle)
        || file.ownerDomain?.toLowerCase().includes(needle)
        || file.usesDomains?.some((value) => value.toLowerCase().includes(needle)));
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
