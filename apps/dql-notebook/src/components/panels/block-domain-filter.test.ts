import { describe, expect, it } from 'vitest';
import type { BlockEntry } from '../blocks/block-types';
import { blockDomains, filterBlocksForDomain } from './block-domain-filter';

const blocks: BlockEntry[] = [
  { name: 'Customer profile', domain: 'customer', status: 'draft', owner: null, tags: [], path: 'domains/customer/blocks/customer_profile.dql', lastModified: '', description: 'One row per customer.' },
  { name: 'Customer revenue', domain: 'customer', status: 'certified', owner: null, tags: [], path: 'domains/customer/blocks/customer_revenue.dql', lastModified: '', description: 'Revenue by customer.' },
  { name: 'Campaign performance', domain: 'growth', status: 'draft', owner: null, tags: [], path: 'domains/growth/blocks/campaign_performance.dql', lastModified: '', description: 'Campaign results.' },
];

describe('Block Studio domain scope', () => {
  it('offers stable domain choices', () => {
    expect(blockDomains(blocks)).toEqual(['customer', 'growth']);
  });

  it('shows only blocks owned by the selected domain', () => {
    expect(filterBlocksForDomain(blocks, 'customer').map((block) => block.name)).toEqual([
      'Customer profile',
      'Customer revenue',
    ]);
  });

  it('applies search inside the selected domain rather than across all blocks', () => {
    expect(filterBlocksForDomain(blocks, 'customer', 'campaign')).toEqual([]);
    expect(filterBlocksForDomain(blocks, 'growth', 'campaign')).toHaveLength(1);
  });
});
