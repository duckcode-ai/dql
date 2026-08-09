import { describe, expect, it } from 'vitest';
import type { AppBuildProposal, AppBuildProposalTile, DashboardDocumentResponse } from '../../api/client';
import { unbuildableSelectedTiles } from './AppBuildProposalPanel';
import {
  addDashboardFilterToDocument,
  dashboardFilterCandidates,
  dashboardFilterCoverage,
  deriveDashboardFilters,
  removeDashboardFilterFromDocument,
} from './dashboard-filters';
import { semanticApprovalState } from './app-semantic-approval';

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

  it('keeps an option-less select when a governed predicate binding can resolve its options', () => {
    const dashboard = dashboardWithItem({
      i: 'customer-tile', x: 0, y: 0, w: 6, h: 4,
      block: { blockId: 'Customer profile' },
      viz: { type: 'table' },
      filterBindings: [{ filter: 'customer_name', binding: 'customer_name', mode: 'predicate' }],
    });
    dashboard.filters = [{ id: 'customer_name', label: 'Customer Name', type: 'select', bindsTo: 'customer_name' }];

    const [filter] = deriveDashboardFilters(dashboard);

    expect(filter).toMatchObject({ id: 'customer_name', sourceBlockId: 'Customer profile' });
  });

  it('adds and removes a manual page filter together with its proven tile binding', () => {
    const dashboard = dashboardWithItem({
      i: 'customer-tile', x: 0, y: 0, w: 6, h: 4,
      block: { blockId: 'Customer profile' },
      viz: { type: 'table' },
    });
    dashboard.filters = [];
    const added = addDashboardFilterToDocument(dashboard, 'customer_type', {
      tiles: [{
        tileId: 'customer-tile',
        filterableColumns: [{ column: 'customer_type', predicateTarget: 'customer_type' }],
      }],
    });

    expect(added.filters).toContainEqual({ id: 'customer_type', type: 'select', bindsTo: 'customer_type' });
    expect(added.layout.items[0].filterBindings).toContainEqual({
      filter: 'customer_type',
      binding: 'customer_type',
      mode: 'predicate',
    });
    expect(dashboardFilterCoverage(added, 'customer_type').applied).toEqual(['customer-tile']);

    const removed = removeDashboardFilterFromDocument(added, 'customer_type');
    expect(removed.filters).toEqual([]);
    expect(removed.layout.items[0].filterBindings).toEqual([]);
  });
});

describe('App semantic repair approval (AGT-023, UI-018)', () => {
  it('does not treat an AI-repaired semantic preview as governed approval evidence', () => {
    const run = {
      tiles: [{
        tileId: 'semantic-revenue',
        status: 'ok',
        tileType: 'semantic',
        repair: {
          version: 1,
          status: 'repaired',
          source: 'semantic_query',
          mode: 'ai',
          attemptedAt: '2026-08-02T00:00:00.000Z',
          originalFailure: 'Column not found.',
          approvalEligible: false,
          message: 'AI repair completed; review required.',
        },
      }],
    } as never;

    expect(semanticApprovalState(['semantic-revenue'], run)).toEqual({
      ready: false,
      repairedTileIds: ['semantic-revenue'],
    });
    const unrepairedRun = {
      tiles: [{ tileId: 'semantic-revenue', status: 'ok', tileType: 'semantic' }],
    } as never;
    expect(semanticApprovalState(['semantic-revenue'], unrepairedRun)).toEqual({ ready: true, repairedTileIds: [] });
  });
});

describe('Build Brief: tiles the commit will not build', () => {
  const proposal = (target: 'personal' | 'shared_project', tiles: Array<Partial<AppBuildProposalTile>>) => ({
    intent: { target, initialVisibility: 'private' as const },
    tiles: tiles.map((tile, index) => ({
      id: `t${index}`, source: 'ai_generated', title: `Tile ${index}`, viz: 'table',
      certification: 'ai_generated', sourceClass: 'exploratory_analysis', reviewStatus: 'required',
      preflight: { status: 'passed' }, selectedByDefault: true, ...tile,
    })),
    gaps: [], followUps: [],
    coverage: { certifiedTiles: 0, semanticTiles: 0, generatedTiles: tiles.length, gaps: 0 },
  } as unknown as AppBuildProposal);
  const all = (p: AppBuildProposal) => new Set(p.tiles.map((tile) => tile.id));

  it('flags an AI tile with no query, which becomes an appendix question rather than a tile', () => {
    const p = proposal('personal', [{ title: 'What is the decision story behind this?' }]);
    const [first, ...rest] = unbuildableSelectedTiles(p, all(p));
    expect(rest).toEqual([]);
    expect(first?.title).toBe('What is the decision story behind this?');
    expect(first?.reason).toMatch(/nothing to show/i);
  });

  it('flags exploratory SQL in a Shared Project and names the way out', () => {
    const p = proposal('shared_project', [{ title: 'Revenue by region', sql: 'select 1' }]);
    expect(unbuildableSelectedTiles(p, all(p))[0]?.reason).toMatch(/Personal Draft/);
  });

  it('accepts the same exploratory tile in a Personal Draft', () => {
    const p = proposal('personal', [{ title: 'Revenue by region', sql: 'select 1' }]);
    expect(unbuildableSelectedTiles(p, all(p))).toEqual([]);
  });

  it('never flags a certified block, and never flags a tile the author deselected', () => {
    const certified = proposal('shared_project', [{ source: 'certified_block', blockId: 'revenue', title: 'Revenue' }]);
    expect(unbuildableSelectedTiles(certified, all(certified))).toEqual([]);

    const dropped = proposal('shared_project', [{ title: 'Revenue by region', sql: 'select 1' }]);
    expect(unbuildableSelectedTiles(dropped, new Set())).toEqual([]);
  });
});

describe('Global filters: coverage and candidates', () => {
  const dash = (items: Array<Record<string, unknown>>, filters: Array<Record<string, unknown>> = []) => ({
    id: 'overview', metadata: { title: 'Overview' },
    filters, layout: { items },
  } as unknown as DashboardDocumentResponse['dashboard']);

  it('reports the tiles a filter actually reaches, not the tiles that mention it', () => {
    // A tile can declare a binding and still be unable to apply it. Counting
    // those as covered is how a filter that narrows half a page looked total.
    const dashboard = dash([
      { i: 'a', title: 'Bound', viz: { type: 'bar' }, filterBindings: [{ filter: 'customer_name', binding: 'customer_name', mode: 'predicate' }] },
      { i: 'b', title: 'Declared but unusable', viz: { type: 'line' }, filterBindings: [{ filter: 'customer_name', unsupportedReason: 'No matching column' }] },
      { i: 'c', title: 'Unaware', viz: { type: 'table' } },
    ], [{ id: 'customer_name', type: 'select', bindsTo: 'customer_name' }]);

    const coverage = dashboardFilterCoverage(dashboard, 'customer_name');
    expect(coverage.applied).toEqual(['a']);
    expect(coverage.filterable).toBe(3);
    expect(coverage.unaffected.map((tile) => tile.tileId)).toEqual(['b', 'c']);
    expect(coverage.unaffected[0]?.reason).toBe('No matching column');
  });

  it('does not count narrative tiles as missing a filter', () => {
    const dashboard = dash([
      { i: 'a', title: 'Chart', viz: { type: 'bar' }, filterBindings: [{ filter: 'region', binding: 'region', mode: 'predicate' }] },
      { i: 'note', title: 'Intro', viz: { type: 'text' }, text: { markdown: 'Hello' } },
      { i: 'head', title: 'Heading', viz: { type: 'heading' } },
    ], [{ id: 'region', type: 'select' }]);
    const coverage = dashboardFilterCoverage(dashboard, 'region');
    expect(coverage.filterable).toBe(1);
    expect(coverage.unaffected).toEqual([]);
  });

  it('offers only the columns the server proved filterable, ranked by reach', () => {
    // The candidate list must come from the server's SQL parse. Guessing from
    // result column names would offer an aggregate output, and filtering that
    // in WHERE changes the measure instead of narrowing it.
    const run = { tiles: [
      { filterableColumns: [{ column: 'customer_name', predicateTarget: 'c.customer_name' }, { column: 'region', predicateTarget: 'c.region' }],
        result: { columns: ['customer_name', 'region', 'revenue'], rows: [{ customer_name: 'Acme', region: 'EMEA', revenue: 10 }] } },
      { filterableColumns: [{ column: 'region', predicateTarget: 'o.region' }],
        result: { columns: ['region', 'revenue'], rows: [{ region: 'AMER' }] } },
      // No filterableColumns: an aggregate-only tile the server refused to offer.
      { result: { columns: ['total_revenue'], rows: [{ total_revenue: 99 }] } },
    ] };
    const candidates = dashboardFilterCandidates(dash([]), run);
    expect(candidates.map((candidate) => candidate.column)).toEqual(['region', 'customer_name']);
    expect(candidates[0]?.tiles).toBe(2);
    expect(candidates.some((candidate) => candidate.column === 'revenue')).toBe(false);
    expect(candidates.some((candidate) => candidate.column === 'total_revenue')).toBe(false);
    expect(candidates[1]?.sampleValues).toContain('Acme');
  });

  it('never re-offers a column that is already a page filter', () => {
    const run = { tiles: [
      { filterableColumns: [{ column: 'region', predicateTarget: 'region' }], result: { columns: ['region'], rows: [] } },
    ] };
    expect(dashboardFilterCandidates(dash([], [{ id: 'region', type: 'select' }]), run)).toEqual([]);
  });
});

describe('Coverage for a filter the author never declared', () => {
  const dash = (items: Array<Record<string, unknown>>, filters: Array<Record<string, unknown>> = []) => ({
    id: 'overview', metadata: { title: 'Overview' }, filters, layout: { items },
  } as unknown as DashboardDocumentResponse['dashboard']);

  it('derives reach from the tiles that offered the column', () => {
    // A viewer-chosen column has no filterBindings anywhere, so reading only the
    // document reported "reaches no tile" right before the page filtered fine.
    const dashboard = dash([
      { i: 'a', title: 'Profiles', viz: { type: 'table' } },
      { i: 'b', title: 'Revenue', viz: { type: 'line' } },
    ]);
    const run = { tiles: [
      { tileId: 'a', filterableColumns: [{ column: 'customer_type', predicateTarget: 'c.customer_type' }] },
      { tileId: 'b', filterableColumns: [] },
    ] };
    const coverage = dashboardFilterCoverage(dashboard, 'customer_type', run);
    expect(coverage.applied).toEqual(['a']);
    expect(coverage.unaffected.map((tile) => tile.tileId)).toEqual(['b']);
  });

  it('still uses the declared bindings when the filter is on the document', () => {
    const dashboard = dash(
      [{ i: 'a', title: 'Profiles', viz: { type: 'table' }, filterBindings: [{ filter: 'region', binding: 'region', mode: 'predicate' }] }],
      [{ id: 'region', type: 'select' }],
    );
    // The run disagrees; the author's declaration wins for a declared filter.
    const coverage = dashboardFilterCoverage(dashboard, 'region', { tiles: [{ tileId: 'a', filterableColumns: [] }] });
    expect(coverage.applied).toEqual(['a']);
  });
});
