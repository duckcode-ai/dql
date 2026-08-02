import type { Domain, NotebookFile } from '../../store/types';
import { authoredDomainIds, authoredDomainOptions } from '../domains/authored-domain-options';

export function notebookDomains(files: NotebookFile[], domains: readonly Domain[]): string[] {
  const ids = authoredDomainIds(domains);
  const hasUnassigned = files.some((file) => {
    if (file.type !== 'notebook') return false;
    const related = [file.ownerDomain, ...(file.usesDomains ?? [])]
      .map((domain) => domain?.trim())
      .filter((domain): domain is string => Boolean(domain));
    return !related.some((domain) => ids.has(domain));
  });
  return [
    ...authoredDomainOptions(domains).map((option) => option.value),
    ...(hasUnassigned ? ['uncategorized'] : []),
  ];
}

export function filterNotebookFiles(files: NotebookFile[], search: string, domain = '', domains: readonly Domain[] = []): NotebookFile[] {
  const needle = search.trim().toLowerCase();
  const authoredIds = authoredDomainIds(domains);
  return Array.from(
    new Map(files.filter((file) => file.type === 'notebook').map((file) => [file.path, file])).values(),
  )
    .filter((file) => {
      const relatedDomains = [file.ownerDomain, ...(file.usesDomains ?? [])]
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value));
      const domainMatches = !domain
        || (domain === 'uncategorized'
          ? !relatedDomains.some((relatedDomain) => authoredIds.has(relatedDomain))
          : authoredIds.has(domain) && relatedDomains.includes(domain));
      return domainMatches && (!needle
        || file.name.toLowerCase().includes(needle)
        || file.path.toLowerCase().includes(needle)
        || file.ownerDomain?.toLowerCase().includes(needle)
        || file.usesDomains?.some((value) => value.toLowerCase().includes(needle)));
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
