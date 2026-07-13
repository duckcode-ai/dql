import type { BlockEntry } from '../blocks/block-types';

export function blockDomains(blocks: BlockEntry[]): string[] {
  return [...new Set(blocks.map((block) => block.domain?.trim() || 'uncategorized'))]
    .sort((a, b) => a.localeCompare(b));
}

export function filterBlocksForDomain(blocks: BlockEntry[], domain: string, search = ''): BlockEntry[] {
  const query = search.trim().toLowerCase();
  return Array.from(new Map(blocks.map((block) => [block.path, block])).values()).filter((block) => {
    if (domain && (block.domain?.trim() || 'uncategorized') !== domain) return false;
    return !query
      || block.name.toLowerCase().includes(query)
      || (block.description ?? '').toLowerCase().includes(query);
  });
}
