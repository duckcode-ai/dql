import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { SemanticTreeNode } from '../../store/types';
import type * as CatalogTreeModule from './CatalogTree';

let dedupeSiblings: typeof CatalogTreeModule.dedupeSiblings;
let semanticNodeIdentity: typeof CatalogTreeModule.semanticNodeIdentity;
let semanticNodeRef: typeof CatalogTreeModule.semanticNodeRef;
let semanticNodeTechnicalLabel: typeof CatalogTreeModule.semanticNodeTechnicalLabel;

describe('dedupeSiblings', () => {
  beforeAll(async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
    const module = await import('./CatalogTree');
    dedupeSiblings = module.dedupeSiblings;
    semanticNodeIdentity = module.semanticNodeIdentity;
    semanticNodeRef = module.semanticNodeRef;
    semanticNodeTechnicalLabel = module.semanticNodeTechnicalLabel;
  });

  it('merges same-label groups and drops leaves that insert the same reference', () => {
    // Mirrors the backend cube bug: two "Measures" groups, one as `measure`
    // leaves, one as `metric` leaves — the same underlying object twice.
    const cube: SemanticTreeNode = {
      id: 'cube:orders', label: 'Orders', kind: 'cube',
      children: [
        { id: 'group:cube:orders:measure', label: 'Measures', kind: 'group', children: [
          { id: 'measure:revenue', label: 'revenue', kind: 'measure' },
        ] },
        { id: 'group:cube:orders:metric', label: 'Measures', kind: 'group', children: [
          { id: 'metric:revenue', label: 'revenue', kind: 'metric' },
        ] },
      ],
    };
    const [merged] = dedupeSiblings([cube]);
    // The two "Measures" groups collapse into one...
    expect(merged.children).toHaveLength(1);
    expect(merged.children![0].label).toBe('Measures');
    // ...and revenue (measure:revenue and metric:revenue both insert @metric(revenue)) appears once.
    expect(merged.children![0].children).toHaveLength(1);
    expect(merged.children![0].children![0].label).toBe('revenue');
  });

  it('keeps genuinely distinct leaves that share a name (metric vs dimension)', () => {
    const group: SemanticTreeNode = {
      id: 'g', label: 'Group', kind: 'group',
      children: [
        { id: 'metric:region', label: 'region', kind: 'metric' },      // @metric(region)
        { id: 'dimension:region', label: 'region', kind: 'dimension' }, // @dim(region)
      ],
    };
    const [out] = dedupeSiblings([group]);
    expect(out.children).toHaveLength(2);
  });

  it('keeps repeated local dimensions distinct and exposes the dbt technical identifier', () => {
    const group: SemanticTreeNode = {
      id: 'g', label: 'Dimensions', kind: 'group',
      children: [
        {
          id: 'dimension:orders.customer_name',
          label: 'Customer',
          kind: 'dimension',
          meta: {
            localName: 'customer_name',
            reference: 'orders.customer_name',
            qualifiedName: 'order__customer_name',
          },
        },
        {
          id: 'dimension:customers.customer_name',
          label: 'Customer',
          kind: 'dimension',
          meta: {
            localName: 'customer_name',
            reference: 'customers.customer_name',
            qualifiedName: 'customer__customer_name',
          },
        },
      ],
    };

    const [out] = dedupeSiblings([group]);
    expect(out.children).toHaveLength(2);
    expect(semanticNodeIdentity(out.children![0])).toBe('orders.customer_name');
    expect(semanticNodeRef(out.children![0])).toBe('@dim(orders.customer_name)');
    expect(semanticNodeTechnicalLabel(out.children![0])).toBe('order__customer_name');
  });
});
