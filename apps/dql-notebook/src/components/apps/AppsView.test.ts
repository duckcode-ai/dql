import { describe, expect, it } from 'vitest';
import type { DashboardDocumentResponse } from '../../api/client';
import { deriveDashboardFilters } from './dashboard-filters';

type RuntimeFilter = NonNullable<DashboardDocumentResponse['dashboard']['filters']>[number] & {
  sourceBlockId?: string;
};

function dashboardWithItem(item: DashboardDocumentResponse['dashboard']['layout']['items'][number]): DashboardDocumentResponse['dashboard'] {
  return {
    version: 1,
    id: 'overview',
    metadata: { title: 'Overview' },
    filters: [{ id: 'category', type: 'string', default: 'Beverage' }],
    layout: { kind: 'grid', cols: 12, rowHeight: 32, items: [item] },
  };
}

describe('App dashboard filter wiring (UI-001, E2E-001)', () => {
  it('keeps a block parameter as an input instead of probing it as an output column', () => {
    const [filter] = deriveDashboardFilters(dashboardWithItem({
      i: 'parameter-tile', x: 0, y: 0, w: 6, h: 4,
      block: { blockId: 'Runtime Parameter Acceptance' },
      viz: { type: 'table' },
      parameterBindings: [{
        param: 'category',
        source: 'dashboard_filter',
        filter: 'category',
        parameterType: 'string',
        default: 'Beverage',
      }],
    }));

    expect((filter as RuntimeFilter).sourceBlockId).toBeUndefined();
    expect(filter.bindsTo).toBeUndefined();
  });

  it('uses only a predicate binding as the source for categorical output options', () => {
    const [filter] = deriveDashboardFilters(dashboardWithItem({
      i: 'predicate-tile', x: 0, y: 0, w: 6, h: 4,
      block: { blockId: 'Revenue by Category' },
      viz: { type: 'table' },
      filterBindings: [{ filter: 'category', binding: 'category_name', mode: 'predicate' }],
    }));

    expect((filter as RuntimeFilter).sourceBlockId).toBe('Revenue by Category');
    expect(filter.bindsTo).toBe('category_name');
  });
});
