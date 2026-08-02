import type { BlockEntry } from '../blocks/block-types';
import type { Domain } from '../../store/types';
import { authoredDomainIds, authoredDomainOptions } from '../domains/authored-domain-options';

export function blockDomains(blocks: BlockEntry[], domains: readonly Domain[]): string[] {
  const ids = authoredDomainIds(domains);
  const hasUnassigned = blocks.some((block) => !ids.has(block.domain?.trim() ?? ''));
  return [
    ...authoredDomainOptions(domains).map((option) => option.value),
    ...(hasUnassigned ? ['uncategorized'] : []),
  ];
}

export function filterBlocksForDomain(blocks: BlockEntry[], domain: string, search = '', domains: readonly Domain[] = []): BlockEntry[] {
  const query = search.trim().toLowerCase();
  const authoredIds = authoredDomainIds(domains);
  return Array.from(new Map(blocks.map((block) => [block.path, block])).values()).filter((block) => {
    const assignedDomain = block.domain?.trim() ?? '';
    if (domain === 'uncategorized' && authoredIds.has(assignedDomain)) return false;
    if (domain && domain !== 'uncategorized' && (!authoredIds.has(domain) || assignedDomain !== domain)) return false;
    return !query
      || block.name.toLowerCase().includes(query)
      || (block.description ?? '').toLowerCase().includes(query);
  });
}
