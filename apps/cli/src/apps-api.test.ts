import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  __test__,
  createAppPackage,
  createDashboardForApp,
  createNotebookForApp,
  generateAppPackage,
  previewNotebookForApp,
  recommendBlocks,
} from './apps-api.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('Apps command center API helpers', () => {
  it('recommends certified domain and tag matches before unrelated blocks', () => {
    const root = createProject();
    writeBlock(root, 'growth/revenue.dql', {
      name: 'Revenue Total',
      domain: 'growth',
      status: 'certified',
      tags: ['cxo', 'revenue'],
      description: 'Executive revenue KPI',
      chart: 'single_value',
    });
    writeBlock(root, 'finance/cost.dql', {
      name: 'Cost Total',
      domain: 'finance',
      status: 'certified',
      tags: ['cost'],
      description: 'Finance cost KPI',
      chart: 'bar',
    });
    writeBlock(root, 'growth/draft.dql', {
      name: 'Draft Pipeline',
      domain: 'growth',
      status: 'draft',
      tags: ['cxo'],
      description: 'Draft pipeline',
      chart: 'line',
    });

    const blocks = recommendBlocks(root, {
      domain: 'growth',
      tags: ['cxo'],
      purpose: 'executive revenue',
      certifiedOnly: true,
    });

    expect(blocks.map((block) => block.name)).toEqual(['Revenue Total']);
    expect(blocks[0].reasons).toContain('domain match');
  });

  it('creates canonical App folders and dashboard references without duplicating blocks', () => {
    const root = createProject();
    writeBlock(root, 'growth/revenue.dql', {
      name: 'Revenue Total',
      domain: 'growth',
      status: 'certified',
      tags: ['cxo', 'revenue'],
      description: 'Executive revenue KPI',
      chart: 'single_value',
    });

    const result = createAppPackage(root, {
      name: 'Growth CXO',
      domain: 'growth',
      purpose: 'Executive growth scorecard',
      audience: 'executive',
      tags: ['weekly'],
      owners: ['owner@local'],
      selectedBlockIds: ['Revenue Total'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(existsSync(join(root, 'apps/growth-cxo/dql.app.json'))).toBe(true);
    expect(existsSync(join(root, 'apps/growth-cxo/README.md'))).toBe(true);
    expect(existsSync(join(root, 'apps/growth-cxo/dashboards/overview.dqld'))).toBe(true);
    expect(existsSync(join(root, 'apps/growth-cxo/notebooks'))).toBe(true);
    expect(existsSync(join(root, 'apps/growth-cxo/drafts'))).toBe(true);
    expect(existsSync(join(root, 'apps/growth-cxo/blocks'))).toBe(false);

    const app = JSON.parse(readFileSync(join(root, 'apps/growth-cxo/dql.app.json'), 'utf-8'));
    expect(app.visibility).toBe('shared');
    expect(app.lifecycle).toBe('draft');
    expect(app.audience).toBe('executive');

    const dashboard = JSON.parse(readFileSync(join(root, 'apps/growth-cxo/dashboards/overview.dqld'), 'utf-8'));
    expect(dashboard.metadata.visibility).toBe('shared');
    expect(dashboard.metadata.lifecycle).toBe('draft');
    expect(dashboard.layout.items[0].block).toEqual({ blockId: 'Revenue Total' });
    expect(result.app.dashboards).toEqual([{ id: 'overview', title: 'Overview' }]);
  });

  it('creates App packages under domains/<domain>/apps when the domain folder exists', () => {
    const root = createProject();
    mkdirSync(join(root, 'domains', 'growth'), { recursive: true });
    writeDomainBlock(root, 'growth', 'revenue.dql', {
      name: 'Revenue Total',
      domain: 'growth',
      status: 'certified',
      tags: ['cxo', 'revenue'],
      description: 'Executive revenue KPI',
      chart: 'single_value',
    });

    const result = createAppPackage(root, {
      name: 'Growth CXO',
      domain: 'growth',
      owners: ['owner@local'],
      selectedBlockIds: ['Revenue Total'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.paths).toContain('domains/growth/apps/growth-cxo/dql.app.json');
    expect(result.paths).toContain('domains/growth/apps/growth-cxo/dashboards/overview.dqld');
    expect(existsSync(join(root, 'domains/growth/apps/growth-cxo/dql.app.json'))).toBe(true);
    expect(existsSync(join(root, 'apps/growth-cxo/dql.app.json'))).toBe(false);
    expect(result.app.filePath).toBe('domains/growth/apps/growth-cxo');
    expect(result.app.dashboards).toEqual([{ id: 'overview', title: 'Overview' }]);

    const dashboard = JSON.parse(readFileSync(join(root, 'domains/growth/apps/growth-cxo/dashboards/overview.dqld'), 'utf-8'));
    expect(dashboard.layout.items[0].block).toEqual({ blockId: 'Revenue Total' });

    const newDashboard = createDashboardForApp(root, 'growth-cxo', { title: 'Forecast Review' });
    expect(newDashboard.ok).toBe(true);
    if (!newDashboard.ok) return;
    expect(newDashboard.path).toBe('domains/growth/apps/growth-cxo/dashboards/forecast-review.dqld');
    expect(existsSync(join(root, newDashboard.path))).toBe(true);

    const notebook = createNotebookForApp(root, 'growth-cxo', {
      name: 'Board Notes',
      role: 'analysis',
      visibility: 'shared',
    });
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    expect(notebook.path).toBe('domains/growth/apps/growth-cxo/notebooks/board-notes.dqlnb');
    expect(existsSync(join(root, notebook.path))).toBe(true);

    const updated = JSON.parse(readFileSync(join(root, 'domains/growth/apps/growth-cxo/dql.app.json'), 'utf-8'));
    expect(updated.notebooks[0]).toMatchObject({ path: notebook.path, role: 'analysis' });
  });

  it('generates an AppPlan-backed App package for the UI builder', async () => {
    const root = createProject();
    writeBlock(root, 'revenue/total_revenue.dql', {
      name: 'Total Revenue',
      domain: 'revenue',
      status: 'certified',
      tags: ['revenue', 'kpi'],
      description: 'Executive revenue KPI',
      chart: 'single_value',
    });
    writeBlock(root, 'revenue/revenue_by_month.dql', {
      name: 'Revenue by Month',
      domain: 'revenue',
      status: 'certified',
      tags: ['revenue', 'trend'],
      description: 'Monthly revenue trend',
      chart: 'line',
    });

    const result = await generateAppPackage(root, {
      prompt: 'Build a weekly revenue health app with revenue KPI and monthly trend.',
      domain: 'revenue',
      owner: 'owner@local',
      force: true,
      selectedBlockIds: ['Revenue by Month'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const plan = result.plan as { appId: string };
    const validation = result.validation as { certifiedTiles: number };
    expect(result.app?.id).toBe(plan.appId);
    expect(result.dashboardId).toBe('overview');
    expect(validation.certifiedTiles).toBeGreaterThan(0);
    expect(result.generated.paths).toContain(`apps/${plan.appId}/dql.app.json`);
    expect(result.generated.paths).toContain(`apps/${plan.appId}/dashboards/overview.dqld`);
    expect(existsSync(join(root, `apps/${plan.appId}/dql.app.json`))).toBe(true);
    expect(existsSync(join(root, `apps/${plan.appId}/dashboards/overview.dqld`))).toBe(true);
    const dashboard = JSON.parse(readFileSync(join(root, `apps/${plan.appId}/dashboards/overview.dqld`), 'utf-8'));
    expect(dashboard.layout.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ block: { blockId: 'Revenue by Month' } }),
      ]),
    );
  });

  it('builds selected-block SQL for review-required driver research', () => {
    const root = createProject();
    writeBlock(root, 'nba/top-scorers.dql', {
      name: 'Top Scorers',
      domain: 'nba',
      status: 'certified',
      tags: ['nba', 'scoring'],
      description: 'Top NBA player scoring output',
      chart: 'bar',
      query: `-- Imported analyst SQL with comments should still be eligible for read-only research.
SELECT
  player_name,
  season,
  total_points
FROM NBA_GAMES.RAW.fct_player_performance
ORDER BY total_points DESC
LIMIT 10`,
    });

    const generated = __test__.buildDeterministicInvestigationSql(root, {
      question: 'Break this down by player driver.',
      intent: 'driver_breakdown',
      sourceBlockId: 'Top Scorers',
      selected: {
        blockId: 'Top Scorers',
        blockPath: 'blocks/nba/top-scorers.dql',
        certificationStatus: 'certified',
        columns: ['player_name', 'season', 'total_points'],
        resultSample: [
          { player_name: 'Stephen Curry', season: '2025', total_points: 325 },
          { player_name: 'LeBron James', season: '2025', total_points: 302 },
        ],
      },
    });

    expect(generated).toBeDefined();
    if (!generated) return;
    expect(generated.sourceBlockPath).toBe('blocks/nba/top-scorers.dql');
    expect(generated.sourceBlockName).toBe('Top Scorers');
    expect(generated.sql).toContain('WITH dql_source AS');
    expect(generated.sql).toContain('FROM NBA_GAMES.RAW.fct_player_performance');
    expect(generated.sql).not.toContain('ORDER BY total_points DESC');
    expect(generated.sql).not.toContain('LIMIT 10');
    expect(generated.sql).toContain('GROUP BY "player_name"');
    expect(generated.sql).toContain('SUM("total_points") AS "total_points"');
    expect(generated.sql).toContain('LIMIT 20');
  });

  it('ranks research driver cards by business measures before row counts', () => {
    const preview = {
      result: {
        columns: ['PLAYER_NAME', 'TOTAL_POINTS', 'row_count'],
        rows: [
          { PLAYER_NAME: 'LeBron James', TOTAL_POINTS: 14473, row_count: 11 },
          { PLAYER_NAME: 'James Harden', TOTAL_POINTS: 14464, row_count: 11 },
        ],
      },
    };

    const cards = __test__.buildPreviewDriverCards(preview, 'driver_breakdown');
    const metric = __test__.buildPreviewMetricSnapshot(preview, 'Top 10 Goal Scorers');

    expect(cards[0]).toMatchObject({
      title: 'LeBron James',
      value: 14473,
      evidenceLabel: 'TOTAL_POINTS',
    });
    expect(metric).toMatchObject({
      metric: 'TOTAL_POINTS',
      currentValue: 28937,
    });
  });

  it('creates and previews App-owned notebooks', () => {
    const root = createProject();
    const appResult = createAppPackage(root, {
      name: 'Fraud Ops',
      domain: 'cards',
      dashboardTitle: 'Daily Review',
      owners: ['owner@local'],
      tags: [],
      selectedBlockIds: [],
    });
    expect(appResult.ok).toBe(true);
    if (!appResult.ok) return;
    expect(existsSync(join(root, 'apps/fraud-ops/dashboards/daily-review.dqld'))).toBe(true);

    const notebook = createNotebookForApp(root, 'fraud-ops', {
      name: 'Investigation Notes',
      role: 'analysis',
      visibility: 'shared',
    });
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    expect(notebook.path).toBe('apps/fraud-ops/notebooks/investigation-notes.dqlnb');
    expect(existsSync(join(root, notebook.path))).toBe(true);

    const app = JSON.parse(readFileSync(join(root, 'apps/fraud-ops/dql.app.json'), 'utf-8'));
    expect(app.notebooks[0]).toMatchObject({
      path: notebook.path,
      role: 'analysis',
      visibility: 'shared',
    });

    const preview = previewNotebookForApp(root, 'fraud-ops', notebook.path);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect((preview.preview as { title?: string; cells?: unknown[] }).title).toBe('Investigation Notes');
    expect((preview.preview as { cells: unknown[] }).cells.length).toBeGreaterThan(0);
  });
});

function createProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'dql-app-api-'));
  tempDirs.push(root);
  writeFileSync(join(root, 'dql.config.json'), '{}\n');
  mkdirSync(join(root, 'blocks'), { recursive: true });
  return root;
}

function writeBlock(
  root: string,
  relPath: string,
  block: { name: string; domain: string; status: string; tags: string[]; description: string; chart: string; query?: string },
): void {
  writeBlockFile(join(root, 'blocks', relPath), block);
}

function writeDomainBlock(
  root: string,
  domain: string,
  relPath: string,
  block: { name: string; domain: string; status: string; tags: string[]; description: string; chart: string; query?: string },
): void {
  writeBlockFile(join(root, 'domains', domain, 'blocks', relPath), block);
}

function writeBlockFile(
  abs: string,
  block: { name: string; domain: string; status: string; tags: string[]; description: string; chart: string; query?: string },
): void {
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, `block "${block.name}" {
  domain = "${block.domain}"
  status = "${block.status}"
  type = "custom"
  description = "${block.description}"
  owner = "analytics@local"
  tags = [${block.tags.map((tag) => `"${tag}"`).join(', ')}]

  query = """
${block.query ?? 'SELECT 1 AS value'}
"""

  visualization {
    chart = "${block.chart}"
  }
}
`);
}
