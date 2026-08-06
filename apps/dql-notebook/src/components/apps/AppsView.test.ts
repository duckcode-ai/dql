import { describe, expect, it } from 'vitest';
import type { AppBuildProposal, AppBuildProposalTile, DashboardDocumentResponse } from '../../api/client';
import { unbuildableSelectedTiles } from './AppBuildProposalPanel';
import { deriveDashboardFilters } from './dashboard-filters';
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
