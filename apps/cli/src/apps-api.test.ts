import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAppPackage, createNotebookForApp, generateAppPackage, previewNotebookForApp, recommendBlocks } from './apps-api.js';

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
      template: 'revenue_health',
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
  block: { name: string; domain: string; status: string; tags: string[]; description: string; chart: string },
): void {
  const abs = join(root, 'blocks', relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, `block "${block.name}" {
  domain = "${block.domain}"
  status = "${block.status}"
  type = "custom"
  description = "${block.description}"
  owner = "analytics@local"
  tags = [${block.tags.map((tag) => `"${tag}"`).join(', ')}]

  query = """
SELECT 1 AS value
"""

  visualization {
    chart = "${block.chart}"
  }
}
`);
}
