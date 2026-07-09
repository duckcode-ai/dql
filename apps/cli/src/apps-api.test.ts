import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultLocalAppsDbPath, LocalAppStorage } from '@duckcodeailabs/dql-project';
import {
  __test__,
  commitAppAiBuild,
  createAppAiBuildSession,
  createAppPackage,
  createDashboardForApp,
  createNotebookForApp,
  generateAppPackage,
  getAppAiBuildSession,
  promoteAppForStakeholders,
  previewNotebookForApp,
  proposeAppAiBuild,
  recommendBlocks,
  recommendDashboardTile,
  recommendVisualization,
} from './apps-api.js';

const tempDirs: string[] = [];

interface TestBlockSpec {
  name: string;
  domain: string;
  status: string;
  tags: string[];
  description: string;
  chart: string;
  query?: string;
  filterBindings?: Array<{ filter: string; binding: string }>;
  params?: Record<string, string | number | boolean | Array<string | number | boolean>>;
}

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

  it('falls back to certified blocks for generic AI app prompts and token-matches business prompts', () => {
    const root = createProject();
    writeBlock(root, 'nba/top-scorers.dql', {
      name: 'Top NBA Scorers',
      domain: 'nba',
      status: 'certified',
      tags: ['nba', 'scoring', 'player'],
      description: 'Top NBA player scoring output',
      chart: 'bar',
    });
    writeBlock(root, 'finance/revenue.dql', {
      name: 'Revenue Total',
      domain: 'finance',
      status: 'certified',
      tags: ['revenue'],
      description: 'Executive revenue KPI',
      chart: 'single_value',
    });

    const generic = recommendBlocks(root, {
      purpose: 'Build an analytics app from my certified DQL blocks and available warehouse tables.',
      certifiedOnly: true,
    });
    expect(generic.map((block) => block.name)).toEqual(expect.arrayContaining(['Top NBA Scorers', 'Revenue Total']));
    expect(generic.every((block) => block.status === 'certified')).toBe(true);

    const nba = recommendBlocks(root, {
      purpose: 'Build an NBA player performance app showing top scorers.',
      certifiedOnly: true,
    });
    expect(nba[0].name).toBe('Top NBA Scorers');
    expect(nba[0].reasons).toContain('context match');
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
    expect(dashboard.layout.items[0].display).toMatchObject({
      mode: 'block_hint',
      component: 'KpiMetric',
      trustState: 'certified',
    });
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
        expect.objectContaining({
          block: { blockId: 'Revenue by Month' },
        }),
      ]),
    );
  });

  it('blocks App generation instead of writing an empty stakeholder dashboard when no certified blocks match', async () => {
    const root = createProject();

    const result = await generateAppPackage(root, {
      prompt: 'Build a revenue app for leadership without any certified blocks.',
      domain: 'revenue',
      owner: 'owner@local',
      force: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('No certified DQL blocks matched strongly enough');
    expect(result.error).toContain('DQL did not write an empty dashboard');
    expect(existsSync(join(root, 'apps/revenue-app-for-leadership-without-any-certified-blocks'))).toBe(false);
  });

  it('stores AI build sessions with generated paths and review tasks', async () => {
    const root = createProject();
    writeBlock(root, 'revenue/total_revenue.dql', {
      name: 'Total Revenue',
      domain: 'revenue',
      status: 'certified',
      tags: ['revenue', 'kpi'],
      description: 'Executive revenue KPI',
      chart: 'single_value',
    });

    const session = await createAppAiBuildSession(root, {
      prompt: 'Build a revenue app for leadership.',
      domain: 'revenue',
      owner: 'owner@local',
      force: true,
    });

    expect(session.status).toBe('ready');
    expect(session.appId).toBeTruthy();
    expect(session.generatedPaths.some((path) => path.endsWith('/dql.app.json'))).toBe(true);
    expect(session.reviewTasks.length).toBeGreaterThan(0);
    const loaded = getAppAiBuildSession(root, session.id);
    expect(loaded?.id).toBe(session.id);
  });

  it('stores a blocked AI build session when no certified blocks can anchor the app', async () => {
    const root = createProject();

    const session = await createAppAiBuildSession(root, {
      prompt: 'Build a revenue app for leadership without any certified blocks.',
      domain: 'revenue',
      owner: 'owner@local',
      force: true,
    });

    expect(session.status).toBe('error');
    expect(session.generatedPaths).toEqual([]);
    expect(session.error).toContain('No certified DQL blocks matched strongly enough');
    expect(session.warnings.join(' ')).toContain('No certified DQL blocks matched strongly enough');
    const loaded = getAppAiBuildSession(root, session.id);
    expect(loaded?.status).toBe('error');
  });

  it('proposes an app build with a confirmable tile list and writes no app files', async () => {
    const root = createProject();
    writeBlock(root, 'revenue/total_revenue.dql', {
      name: 'Total Revenue',
      domain: 'revenue',
      status: 'certified',
      tags: ['revenue', 'kpi'],
      description: 'Executive revenue KPI',
      chart: 'single_value',
    });

    const session = await proposeAppAiBuild(root, {
      prompt: 'Build a revenue app for leadership.',
      domain: 'revenue',
      owner: 'owner@local',
    });

    expect(session.status).toBe('proposed');
    expect(session.generatedPaths).toEqual([]);
    expect(session.proposal).toBeTruthy();
    expect(session.proposal!.tiles.length).toBeGreaterThan(0);
    expect(session.proposal!.tiles.every((tile) => tile.certification === 'certified')).toBe(true);
    expect(session.proposal!.tiles.every((tile) => tile.selectedByDefault)).toBe(true);
    // Nothing on disk yet: the plan's app dir must not exist until commit.
    expect(existsSync(join(root, 'apps'))).toBe(false);
    const loaded = getAppAiBuildSession(root, session.id);
    expect(loaded?.status).toBe('proposed');
  });

  it('commits a confirmed proposal into app files and marks the session ready', async () => {
    const root = createProject();
    writeBlock(root, 'revenue/total_revenue.dql', {
      name: 'Total Revenue',
      domain: 'revenue',
      status: 'certified',
      tags: ['revenue', 'kpi'],
      description: 'Executive revenue KPI',
      chart: 'single_value',
    });

    const session = await proposeAppAiBuild(root, {
      prompt: 'Build a revenue app for leadership.',
      domain: 'revenue',
      owner: 'owner@local',
    });
    expect(session.status).toBe('proposed');
    const selected = session.proposal!.tiles.map((tile) => tile.id);

    const committed = await commitAppAiBuild(root, session.id, { selectedTileIds: selected });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.session.status).toBe('ready');
    expect(committed.session.committedTileIds).toEqual(selected);
    expect(committed.session.generatedPaths.some((path) => path.endsWith('dql.app.json'))).toBe(true);
    for (const path of committed.session.generatedPaths) {
      expect(existsSync(join(root, path))).toBe(true);
    }

    // Double-commit is refused — the app already exists.
    const again = await commitAppAiBuild(root, session.id, { selectedTileIds: selected });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.status).toBe(409);
  });

  it('fills coverage gaps with bounded review-required generated tiles and commits them as aiPins', async () => {
    const root = createProject();
    writeBlock(root, 'revenue/total_revenue.dql', {
      name: 'Total Revenue',
      domain: 'revenue',
      status: 'certified',
      tags: ['revenue', 'kpi'],
      description: 'Executive revenue KPI',
      chart: 'single_value',
    });

    const asked: string[] = [];
    const session = await proposeAppAiBuild(root, {
      // "why" guarantees a driver-analysis coverage gap from the deterministic planner.
      prompt: 'Build a revenue app for leadership and explain why revenue is changing.',
      domain: 'revenue',
      owner: 'owner@local',
    }, {
      generateGovernedAnswer: async (question) => {
        asked.push(question);
        // Governance: even when the governed loop reports a CERTIFIED match, a
        // gap-fill tile must NOT inherit the certified label — it is new AI output.
        return {
          kind: 'certified_metric',
          text: `Generated answer for: ${question}`,
          sql: 'SELECT region, revenue FROM analytics.revenue_by_region',
          suggestedViz: 'bar',
          certification: 'certified',
          block: { nodeId: 'block:some_certified', name: 'Some Certified Block' },
          result: {
            columns: ['region', 'revenue'],
            rows: [{ region: 'NA', revenue: 100 }, { region: 'EU', revenue: 80 }],
            rowCount: 2,
          },
        } as never;
      },
    });

    expect(session.status).toBe('proposed');
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.length).toBeLessThanOrEqual(3);
    const generatedTiles = session.proposal!.tiles.filter((tile) => tile.source === 'ai_generated');
    expect(generatedTiles.length).toBe(asked.length);
    // AI never auto-certifies: gap-fill tiles stay ai_generated regardless of match.
    expect(generatedTiles.every((tile) => tile.certification === 'ai_generated')).toBe(true);
    expect(generatedTiles.every((tile) => Boolean(tile.sql) && Boolean(tile.preview))).toBe(true);
    expect(session.proposal!.coverage.generatedTiles).toBe(generatedTiles.length);

    const selected = session.proposal!.tiles.filter((tile) => !tile.error).map((tile) => tile.id);
    const committed = await commitAppAiBuild(root, session.id, { selectedTileIds: selected });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;

    const dashboardPath = committed.session.generatedPaths.find((path) => path.endsWith('.dqld'));
    expect(dashboardPath).toBeTruthy();
    const doc = JSON.parse(readFileSync(join(root, dashboardPath!), 'utf-8')) as {
      sections?: Array<{ id: string; kind: string; narrative?: string }>;
      layout: { items: Array<{ aiPin?: { id: string }; text?: { markdown: string }; sectionId?: string; trustState?: string; reviewStatus?: string }> };
    };
    const aiPinItems = doc.layout.items.filter((item) => item.aiPin);
    expect(aiPinItems.length).toBe(generatedTiles.length);
    expect(aiPinItems.every((item) => item.trustState === 'review_required' && item.reviewStatus === 'review_required')).toBe(true);

    // Story layout: deterministic narration guarantees sections + a narrated
    // exec-summary tile even without an LLM; generated tiles land in the appendix.
    expect(doc.sections?.some((section) => section.kind === 'exec_summary')).toBe(true);
    expect(doc.sections?.some((section) => section.kind === 'appendix')).toBe(true);
    const execTile = doc.layout.items.find((item) => item.sectionId === 'exec_summary');
    expect(execTile?.text?.markdown).toBeTruthy();
    expect(aiPinItems.every((item) => item.sectionId === 'appendix')).toBe(true);

    const storage = new LocalAppStorage(defaultLocalAppsDbPath(root));
    try {
      const pin = storage.getAiPin(aiPinItems[0]!.aiPin!.id);
      expect(pin?.certification).toBe('ai_generated');
      expect(pin?.reviewStatus).toBe('needs_review');
      expect(pin?.sql).toContain('revenue_by_region');
    } finally {
      storage.close();
    }
  });

  it('keeps gaps as research questions when no provider is available and lists other failures transparently', async () => {
    const root = createProject();
    writeBlock(root, 'revenue/total_revenue.dql', {
      name: 'Total Revenue',
      domain: 'revenue',
      status: 'certified',
      tags: ['revenue', 'kpi'],
      description: 'Executive revenue KPI',
      chart: 'single_value',
    });

    // No provider configured → gaps stay research questions, no error-tile noise.
    const offline = await proposeAppAiBuild(root, {
      prompt: 'Build a revenue app for leadership and explain why revenue is changing.',
      domain: 'revenue',
      owner: 'owner@local',
    }, {
      generateGovernedAnswer: async () => {
        throw new Error('No AI provider is configured. Configure one in Settings.');
      },
    });
    expect(offline.status).toBe('proposed');
    expect(offline.proposal!.tiles.some((tile) => tile.error)).toBe(false);
    expect(offline.proposal!.gaps.length).toBeGreaterThan(0);

    // A genuine generation failure IS listed (not thrown), unselectable.
    const failed = await proposeAppAiBuild(root, {
      prompt: 'Build a revenue app for leadership and explain why revenue is changing.',
      domain: 'revenue',
      owner: 'owner@local',
    }, {
      generateGovernedAnswer: async () => {
        throw new Error('model timed out');
      },
    });
    expect(failed.status).toBe('proposed');
    const errorTiles = failed.proposal!.tiles.filter((tile) => tile.error);
    expect(errorTiles.length).toBeGreaterThan(0);
    expect(errorTiles.every((tile) => !tile.selectedByDefault)).toBe(true);
  });

  it('refuses to commit a proposal with no certified tiles (apps need a certified anchor)', async () => {
    const root = createProject();
    // No certified blocks in the project → the proposal has 0 certified tiles.
    const session = await proposeAppAiBuild(root, {
      prompt: 'Build a leadership app about revenue with no certified coverage.',
      domain: 'revenue',
      owner: 'owner@local',
    });
    // Propose still succeeds (it can surface gaps), but with zero certified tiles.
    if (session.status === 'proposed') {
      expect(session.proposal!.coverage.certifiedTiles).toBe(0);
      const certifiedIds = session.proposal!.tiles.filter((tile) => tile.certification === 'certified').map((tile) => tile.id);
      expect(certifiedIds).toEqual([]);
      const committed = await commitAppAiBuild(root, session.id, {
        selectedTileIds: session.proposal!.tiles.filter((tile) => !tile.error).map((tile) => tile.id),
      });
      // Rejected either way (no selectable tiles → 400, or the certified-coverage
      // guard → 409). What matters: no certified-less app is ever created.
      expect(committed.ok).toBe(false);
      if (!committed.ok) expect([400, 409]).toContain(committed.status);
    } else {
      // Or propose itself reports the coverage error — either way, no app is created.
      expect(session.status).toBe('error');
    }
    expect(existsSync(join(root, 'apps'))).toBe(false);
  });

  it('refuses to commit an empty selection', async () => {
    const root = createProject();
    writeBlock(root, 'revenue/total_revenue.dql', {
      name: 'Total Revenue',
      domain: 'revenue',
      status: 'certified',
      tags: ['revenue', 'kpi'],
      description: 'Executive revenue KPI',
      chart: 'single_value',
    });

    const session = await proposeAppAiBuild(root, {
      prompt: 'Build a revenue app for leadership.',
      domain: 'revenue',
      owner: 'owner@local',
    });
    const rejected = await commitAppAiBuild(root, session.id, { selectedTileIds: [] });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toContain('at least one tile');
  });

  it('returns a research proposal without creating an investigation when context is required', async () => {
    const root = createProject();
    writeBlock(root, 'nba/top-scorers.dql', {
      name: 'Top Scorers',
      domain: 'nba',
      status: 'certified',
      tags: ['nba', 'scoring'],
      description: 'Top NBA player scoring output',
      chart: 'bar',
    });
    const appResult = createAppPackage(root, {
      name: 'NBA Performance',
      domain: 'nba',
      dashboardTitle: 'NBA Overview',
      selectedBlockIds: ['Top Scorers'],
      owners: ['owner@local'],
    });
    expect(appResult.ok).toBe(true);
    if (!appResult.ok) return;

    const result = await __test__.askAppQuestion({
      projectRoot: root,
      req: {} as any,
      res: {} as any,
      url: new URL('http://local.test/api/apps/nba-performance/ask'),
      path: '/api/apps/nba-performance/ask',
    }, 'nba-performance', {
      question: 'Why did the top scorer change between seasons?',
      dashboardId: 'nba-overview',
      blockId: 'Top Scorers',
      runInvestigation: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route).toBe('investigation');
    expect(result.investigation).toBeUndefined();
    expect(result.answer).toContain('Add the comparison, filters, timeframe, and decision context');
    expect(result.followUps).toEqual(expect.arrayContaining(['Add analysis context', 'Create block draft']));
    expect(result.decision).toMatchObject({
      mode: 'analysis',
      requiresContext: true,
      usesCertifiedResult: true,
    });
    expect(result.decision.reason).toContain('changed');
    expect(result.proposal).toMatchObject({
      type: 'research_investigation',
      requiredContext: true,
      reviewRequired: true,
      blockId: 'Top Scorers',
    });
  });

  it('routes an OFF-tile question through the governed answer loop, not the focused tile', async () => {
    const root = createProject();
    writeBlock(root, 'nba/top-scorers.dql', {
      name: 'Top Scorers', domain: 'nba', status: 'certified', tags: ['nba'],
      description: 'Top NBA player scoring output', chart: 'bar',
      query: 'SELECT player_name, total_points FROM NBA_GAMES.RAW.fct_player_performance',
    });
    const appResult = createAppPackage(root, {
      name: 'NBA Performance', domain: 'nba', dashboardTitle: 'NBA Overview',
      selectedBlockIds: ['Top Scorers'], owners: ['owner@local'],
    });
    expect(appResult.ok).toBe(true);
    if (!appResult.ok) return;

    let governedCalls = 0;
    const ctx = {
      projectRoot: root, req: {} as any, res: {} as any,
      url: new URL('http://local.test/api/apps/nba-performance/ask'),
      path: '/api/apps/nba-performance/ask',
      // Governed loop returns a DIFFERENT answer than the focused-tile narration.
      generateGovernedAnswer: async (_q: string) => {
        governedCalls += 1;
        return {
          kind: 'uncertified', certification: 'ai_generated', reviewStatus: 'draft_ready',
          text: 'Assists leader: Chris Paul with 892 assists.',
          answer: 'Assists leader: Chris Paul with 892 assists.',
          citations: [{ kind: 'block', name: 'assists_by_player' }],
        } as any;
      },
    };

    // A tile is focused ("Top Scorers"), but the question is about a different metric.
    const result = await __test__.askAppQuestion(ctx, 'nba-performance', {
      question: 'who are the players with the most assists?',
      dashboardId: 'nba-overview',
      blockId: 'Top Scorers',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(governedCalls).toBe(1);
    expect(result.route).toBe('generated_answer');
    expect(result.answer).toContain('Chris Paul');
    expect(result.trustState).toBe('review_required');
  });

  it('narrates the focused tile ONLY for questions about it, without calling the governed loop', async () => {
    const root = createProject();
    writeBlock(root, 'nba/top-scorers.dql', {
      name: 'Top Scorers', domain: 'nba', status: 'certified', tags: ['nba'],
      description: 'Top NBA player scoring output', chart: 'bar',
      query: 'SELECT player_name, total_points FROM NBA_GAMES.RAW.fct_player_performance',
    });
    const appResult = createAppPackage(root, {
      name: 'NBA Performance', domain: 'nba', dashboardTitle: 'NBA Overview',
      selectedBlockIds: ['Top Scorers'], owners: ['owner@local'],
    });
    expect(appResult.ok).toBe(true);
    if (!appResult.ok) return;

    let governedCalls = 0;
    const ctx = {
      projectRoot: root, req: {} as any, res: {} as any,
      url: new URL('http://local.test/api/apps/nba-performance/ask'),
      path: '/api/apps/nba-performance/ask',
      generateGovernedAnswer: async (_q: string) => { governedCalls += 1; return { kind: 'no_answer', text: '' } as any; },
    };

    const result = await __test__.askAppQuestion(ctx, 'nba-performance', {
      question: 'explain this result',
      dashboardId: 'nba-overview',
      blockId: 'Top Scorers',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(governedCalls).toBe(0);
    expect(result.route).toBe('certified_answer');
  });

  it('reuses an existing App report for the same follow-up question and context', async () => {
    const root = createProject();
    writeBlock(root, 'nba/top-scorers.dql', {
      name: 'Top Scorers',
      domain: 'nba',
      status: 'certified',
      tags: ['nba', 'scoring'],
      description: 'Top NBA player scoring output',
      chart: 'bar',
      query: `SELECT player_name, total_points FROM NBA_GAMES.RAW.fct_player_performance`,
    });
    const appResult = createAppPackage(root, {
      name: 'NBA Performance',
      domain: 'nba',
      dashboardTitle: 'NBA Overview',
      selectedBlockIds: ['Top Scorers'],
      owners: ['owner@local'],
    });
    expect(appResult.ok).toBe(true);
    if (!appResult.ok) return;
    const ctx = {
      projectRoot: root,
      req: {} as any,
      res: {} as any,
      url: new URL('http://local.test/api/apps/nba-performance/ask'),
      path: '/api/apps/nba-performance/ask',
    };
    const selectedContext = {
      activeFilterSummary: 'Season Start: 2016, Season End: 2017, Top N: 5',
      selectedBlock: {
        blockId: 'Top Scorers',
        blockPath: 'blocks/nba/top-scorers.dql',
        certificationStatus: 'certified',
        columns: ['player_name', 'total_points'],
        resultSample: [
          { player_name: 'Grant Jerrett', total_points: 1179 },
          { player_name: 'Gary Harris', total_points: 418 },
        ],
      },
    };

    const first = await __test__.askAppQuestion(ctx, 'nba-performance', {
      question: 'Why is the scorer table concentrated?',
      dashboardId: 'nba-overview',
      blockId: 'Top Scorers',
      context: selectedContext,
    });
    const second = await __test__.askAppQuestion(ctx, 'nba-performance', {
      question: 'Why is the scorer table concentrated?',
      dashboardId: 'nba-overview',
      blockId: 'Top Scorers',
      context: {
        selectedBlock: selectedContext.selectedBlock,
        activeFilterSummary: 'Season Start: 2016, Season End: 2017, Top N: 5',
      },
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.investigation?.id).toBe(second.investigation?.id);
    expect(first.investigation?.evidence).toMatchObject({
      routeDecision: {
        mode: 'analysis',
        requiresContext: true,
        usesCertifiedResult: true,
      },
      planner: {
        routeDecision: {
          mode: 'analysis',
        },
      },
    });
    const storage = new LocalAppStorage(defaultLocalAppsDbPath(root));
    try {
      expect(storage.listAppInvestigations('nba-performance')).toHaveLength(1);
    } finally {
      storage.close();
    }
  });

  it('routes simple tile questions to certified answers with an explicit decision contract', async () => {
    const root = createProject();
    writeBlock(root, 'nba/top-scorers.dql', {
      name: 'Top Scorers',
      domain: 'nba',
      status: 'certified',
      tags: ['nba', 'scoring'],
      description: 'Top NBA player scoring output',
      chart: 'bar',
      query: `SELECT player_name, total_points FROM NBA_GAMES.RAW.fct_player_performance`,
    });
    const appResult = createAppPackage(root, {
      name: 'NBA Performance',
      domain: 'nba',
      dashboardTitle: 'NBA Overview',
      selectedBlockIds: ['Top Scorers'],
      owners: ['owner@local'],
    });
    expect(appResult.ok).toBe(true);
    if (!appResult.ok) return;

    const result = await __test__.askAppQuestion({
      projectRoot: root,
      req: {} as any,
      res: {} as any,
      url: new URL('http://local.test/api/apps/nba-performance/ask'),
      path: '/api/apps/nba-performance/ask',
    }, 'nba-performance', {
      question: 'Explain the visible scorer result for executives.',
      dashboardId: 'nba-overview',
      blockId: 'Top Scorers',
      context: {
        selectedBlock: {
          blockId: 'Top Scorers',
          title: 'Top Scorers',
          certificationStatus: 'certified',
          columns: ['player_name', 'total_points'],
          sampleRows: [
            { player_name: 'Grant Jerrett', total_points: 1179 },
            { player_name: 'Gary Harris', total_points: 418 },
          ],
        },
      },
      runInvestigation: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route).toBe('certified_answer');
    expect(result.decision).toMatchObject({
      mode: 'answer',
      requiresContext: false,
      usesCertifiedResult: true,
    });
    expect(result.decision.reason).toContain('selected certified result');
    expect(result.answer).toContain('Trusted source');
  });

  it('recommends governed visualization metadata from result shape and block hints', () => {
    const root = createProject();
    writeBlock(root, 'nba/top-scorers.dql', {
      name: 'Top Scorers',
      domain: 'nba',
      status: 'certified',
      tags: ['nba', 'scoring'],
      description: 'Top NBA player scoring output',
      chart: 'bar',
    });

    const result = recommendVisualization(root, {
      blockRef: 'Top Scorers',
      prompt: 'Show top NBA players by points',
      resultSchema: { columns: [{ name: 'player_name', type: 'string' }, { name: 'total_points', type: 'number' }] },
      rowSample: [{ player_name: 'Grant Jerrett', total_points: 357 }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.display).toMatchObject({
      mode: 'block_hint',
      component: 'RankingPanel',
      defaultVisualization: 'bar',
      trustState: 'certified',
      reviewStatus: 'certified',
      fieldHints: { label: 'player_name', value: 'total_points' },
    });
    expect(result.evidence.some((entry) => entry.source.endsWith('nba/top-scorers.dql'))).toBe(true);
  });

  it('replaces an incompatible model bar preference with a time-series visualization', () => {
    const root = createProject();
    const result = recommendVisualization(root, {
      prompt: 'How has revenue changed by month?',
      defaultVisualization: 'bar',
      resultSchema: { columns: [{ name: 'month', type: 'date' }, { name: 'revenue', type: 'number' }] },
      rowSample: [{ month: '2026-01-01', revenue: 100 }, { month: '2026-02-01', revenue: 120 }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.display.defaultVisualization).toBe('line');
    expect(result.warnings).toContain('Preferred visualization bar did not fit the returned result shape; using line instead.');
  });

  it('recommends dashboard tile metadata with filter bindings and source evidence', () => {
    const root = createProject();
    writeBlock(root, 'nba/top-scorers.dql', {
      name: 'Top Scorers',
      domain: 'nba',
      status: 'certified',
      tags: ['nba', 'scoring'],
      description: 'Top NBA player scoring output',
      chart: 'bar',
      filterBindings: [{ filter: 'season', binding: 'game_date_est' }],
    });
    const app = createAppPackage(root, {
      name: 'NBA App',
      domain: 'nba',
      owners: ['owner@local'],
      tags: [],
      selectedBlockIds: ['Top Scorers'],
    });
    expect(app.ok).toBe(true);
    if (!app.ok) return;

    const result = recommendDashboardTile(root, 'nba-app', 'overview', {
      blockRef: 'Top Scorers',
      prompt: 'Top scorers by season',
      resultSchema: { columns: [{ name: 'player_name', type: 'string' }, { name: 'total_points', type: 'number' }] },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.display.trustState).toBe('certified');
    expect(result.filterBindings).toEqual([{ filter: 'season', binding: 'game_date_est', mode: 'predicate' }]);
    expect(result.sourceEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'block:Top Scorers', trustState: 'certified' }),
    ]));
  });

  it('promotes app files to review-ready shared artifacts and strips local AI pin tiles', () => {
    const root = createProject();
    const app = createAppPackage(root, {
      name: 'NBA App',
      domain: 'nba',
      owners: ['owner@local'],
      tags: [],
      selectedBlockIds: [],
    });
    expect(app.ok).toBe(true);
    if (!app.ok) return;
    const dashboardPath = join(root, 'apps/nba-app/dashboards/overview.dqld');
    const dashboard = JSON.parse(readFileSync(dashboardPath, 'utf-8'));
    dashboard.layout.items.push({
      i: 'pin',
      x: 0, y: 0, w: 6, h: 3,
      aiPin: { id: 'pin_1' },
      viz: { type: 'text' },
      title: 'AI summary',
      display: {
        mode: 'ai_generated',
        component: 'NarrativePanel',
        defaultVisualization: 'text',
        allowedVisualizations: ['text'],
        layoutIntent: 'standard',
        rationale: 'local pin',
        trustState: 'review_required',
        reviewStatus: 'review_required',
      },
    });
    writeFileSync(dashboardPath, JSON.stringify(dashboard, null, 2));

    const result = promoteAppForStakeholders(root, 'nba-app');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.removedLocalTiles).toBe(1);
    const promotedApp = JSON.parse(readFileSync(join(root, 'apps/nba-app/dql.app.json'), 'utf-8'));
    const promotedDashboard = JSON.parse(readFileSync(dashboardPath, 'utf-8'));
    expect(promotedApp.visibility).toBe('shared');
    expect(promotedApp.lifecycle).toBe('review');
    expect(promotedDashboard.layout.items).toHaveLength(0);
    expect(promotedDashboard.metadata.lifecycle).toBe('review');
  });

  it('rejects unsupported governed visualization combinations', () => {
    const root = createProject();
    const result = recommendVisualization(root, {
      component: 'KpiMetric',
      defaultVisualization: 'scatter',
      resultSchema: { columns: ['x', 'y'] },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('KpiMetric cannot use scatter');
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

  it('renders block parameters from app filters and defaults before building investigation SQL', () => {
    const root = createProject();
    writeBlock(root, 'nba/top-scorers-parameterized.dql', {
      name: 'Top Scorers Parameterized',
      domain: 'nba',
      status: 'certified',
      tags: ['nba', 'scoring', 'parameterized'],
      description: 'Reusable top NBA scorer block with season and top-N parameters',
      chart: 'bar',
      params: {
        season_start: 2015,
        season_end: 2015,
        top_n: 5,
      },
      query: `SELECT
  player_name,
  season,
  total_points
FROM NBA_GAMES.RAW.fct_player_performance
WHERE season BETWEEN \${season_start} AND \${season_end}
  AND player_rank <= \${top_n}`,
    });

    const generated = __test__.buildDeterministicInvestigationSql(root, {
      question: 'Break this down by player driver.',
      intent: 'driver_breakdown',
      sourceBlockId: 'Top Scorers Parameterized',
      context: {
        activeFilters: {
          season_start: 2016,
          season_end: 2017,
        },
      },
      selected: {
        blockId: 'Top Scorers Parameterized',
        blockPath: 'blocks/nba/top-scorers-parameterized.dql',
        certificationStatus: 'certified',
        columns: ['player_name', 'season', 'total_points'],
        resultSample: [
          { player_name: 'Grant Jerrett', season: 2017, total_points: 1179 },
          { player_name: 'Gary Harris', season: 2017, total_points: 418 },
        ],
      },
    });

    expect(generated).toBeDefined();
    if (!generated) return;
    expect(generated.sql).not.toContain('${');
    expect(generated.sql).toContain('season BETWEEN 2016 AND 2017');
    expect(generated.sql).toContain('player_rank <= 5');
    expect(generated.sql).toContain('GROUP BY "player_name"');
  });

  it('rebuilds failed report SQL from certified block context without certifying the report', async () => {
    const root = createProject();
    writeBlock(root, 'nba/top-scorers.dql', {
      name: 'Top Scorers',
      domain: 'nba',
      status: 'certified',
      tags: ['nba', 'scoring'],
      description: 'Top NBA player scoring output',
      chart: 'bar',
      query: `SELECT
  player_name,
  season,
  total_points
FROM NBA_GAMES.RAW.fct_player_performance
ORDER BY total_points DESC
LIMIT 10`,
    });
    const storage = new LocalAppStorage(defaultLocalAppsDbPath(root));
    const executedSql: string[] = [];
    try {
      const investigation = storage.createAppInvestigation({
        appId: 'nba-app',
        dashboardId: 'overview',
        sourceBlockId: 'Top Scorers',
        question: 'Break this down by player driver.',
        intent: 'driver_breakdown',
        generatedSql: 'SELECT * FROM missing_table',
        context: {
          blockId: 'Top Scorers',
          blockPath: 'blocks/nba/top-scorers.dql',
          certificationStatus: 'certified',
          selectedBlock: {
            blockId: 'Top Scorers',
            blockPath: 'blocks/nba/top-scorers.dql',
            certificationStatus: 'certified',
            columns: ['player_name', 'season', 'total_points'],
            resultSample: [
              { player_name: 'Grant Jerrett', season: '2017', total_points: 1179 },
              { player_name: 'Gary Harris', season: '2017', total_points: 418 },
            ],
          },
        },
      });

      const rebuilt = await __test__.runAppInvestigation({
        projectRoot: root,
        req: {} as any,
        res: {} as any,
        url: new URL('http://local.test/api/apps/nba-app/investigations/run'),
        path: '/api/apps/nba-app/investigations/run',
        executeSql: async (sql: string) => {
          executedSql.push(sql);
          return {
            columns: ['player_name', 'total_points', 'row_count'],
            rows: [
              { player_name: 'Grant Jerrett', total_points: 1179, row_count: 1 },
              { player_name: 'Gary Harris', total_points: 418, row_count: 1 },
            ],
          };
        },
      }, storage, investigation, { repairMode: 'rebuild_from_certified' });

      expect(rebuilt.generatedSql).toContain('FROM NBA_GAMES.RAW.fct_player_performance');
      expect(rebuilt.generatedSql).not.toContain('missing_table');
      expect(rebuilt.status).toBe('ready');
      expect(rebuilt.reviewStatus).toBe('needs_review');
      expect(rebuilt.error).toBeUndefined();
      expect(executedSql[0]).toContain('dql_research_preview');
      expect((rebuilt.evidence as any).planner.repairMode).toBe('rebuild_from_certified');
      expect((rebuilt.evidence as any).planner.generationSource).toBe('selected_block_metadata');
    } finally {
      storage.close();
    }
  });

  it('uses provider memo generation after deterministic SQL preview evidence is available', async () => {
    const root = createProject();
    writeBlock(root, 'nba/top-scorers.dql', {
      name: 'Top Scorers',
      domain: 'nba',
      status: 'certified',
      tags: ['nba', 'scoring'],
      description: 'Top NBA player scoring output',
      chart: 'bar',
      query: `SELECT
  player_name,
  season,
  total_points
FROM NBA_GAMES.RAW.fct_player_performance
ORDER BY total_points DESC
LIMIT 10`,
    });
    const storage = new LocalAppStorage(defaultLocalAppsDbPath(root));
    const memoRequests: any[] = [];
    try {
      const investigation = storage.createAppInvestigation({
        appId: 'nba-app',
        dashboardId: 'overview',
        sourceBlockId: 'Top Scorers',
        question: 'Why did the top player change?',
        intent: 'driver_breakdown',
        context: {
          blockId: 'Top Scorers',
          blockPath: 'blocks/nba/top-scorers.dql',
          certificationStatus: 'certified',
          selectedBlock: {
            blockId: 'Top Scorers',
            blockPath: 'blocks/nba/top-scorers.dql',
            certificationStatus: 'certified',
            columns: ['player_name', 'season', 'total_points'],
            resultSample: [
              { player_name: 'Grant Jerrett', season: '2017', total_points: 1179 },
              { player_name: 'Gary Harris', season: '2017', total_points: 418 },
            ],
          },
        },
      });

      const updated = await __test__.runAppInvestigation({
        projectRoot: root,
        req: {} as any,
        res: {} as any,
        url: new URL('http://local.test/api/apps/nba-app/investigations/run'),
        path: '/api/apps/nba-app/investigations/run',
        executeSql: async () => ({
          columns: ['player_name', 'total_points', 'row_count'],
          rows: [
            { player_name: 'Grant Jerrett', total_points: 1179, row_count: 1 },
            { player_name: 'Gary Harris', total_points: 418, row_count: 1 },
          ],
        }),
        generateInvestigationSql: async (input) => {
          memoRequests.push(input);
          return {
            providerUsed: 'mock-provider',
            answer: `## Executive answer
Grant Jerrett leads the current scoring result with 1,179 points, ahead of Gary Harris at 418.

## Business readout
- Grant Jerrett: 1,179 points
- Gary Harris: 418 points

The stakeholder story should focus on scorer concentration while a reviewer confirms the season filter and player grain.

## Next action
Validate the scorer window, then pin this memo or draft a reusable DQL block.`,
            evidence: { source: 'mock memo provider' },
            citations: [{ kind: 'block', name: 'Top Scorers' }],
          };
        },
      }, storage, investigation);

      expect(memoRequests).toHaveLength(1);
      expect(memoRequests[0].mode).toBe('memo_only');
      expect(memoRequests[0].generatedSql).toContain('WITH dql_source AS');
      expect(memoRequests[0].metrics.currentValue).toBe(1597);
      expect(memoRequests[0].resultPreviews.length).toBeGreaterThan(0);
      expect(updated.summary).toContain('Grant Jerrett leads');
      expect(updated.reportSections?.map((section) => section.title)).toEqual(expect.arrayContaining([
        'Executive answer',
        'Business readout',
        'Next action',
      ]));
      expect((updated.evidence as any).planner.generationSource).toBe('selected_block_metadata');
      expect((updated.evidence as any).planner.memoSource).toBe('ai_provider');
      expect((updated.evidence as any).planner.memoProviderUsed).toBe('mock-provider');
      expect(updated.reviewStatus).toBe('needs_review');
    } finally {
      storage.close();
    }
  });

  it('reports unresolved generated SQL parameters before preview execution', () => {
    const rendered = __test__.renderSqlTemplateParams(
      'SELECT * FROM scores WHERE season = ${season} LIMIT ${top_n}',
      { season: 2017 },
    );

    expect(rendered.sql).toContain('season = 2017');
    expect(rendered.unresolved).toEqual(['top_n']);
    expect(__test__.unresolvedSqlTemplateParams(rendered.sql)).toEqual(['top_n']);
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

  it('summarizes selected ranked tile metrics as top value, next comparison, and gap', () => {
    const metric = __test__.buildMetricSnapshot({
      title: 'Top scorers',
      columns: ['PLAYER_NAME', 'TOTAL_POINTS', 'GAMES_PLAYED'],
      sampleRows: [
        { PLAYER_NAME: 'Grant Jerrett', TOTAL_POINTS: 1179, GAMES_PLAYED: 68 },
        { PLAYER_NAME: 'Gary Harris', TOTAL_POINTS: 418, GAMES_PLAYED: 58 },
        { PLAYER_NAME: 'Emmanuel Mudiay', TOTAL_POINTS: 348, GAMES_PLAYED: 56 },
      ],
    });

    expect(metric).toMatchObject({
      metric: 'TOTAL_POINTS',
      currentLabel: 'Top value',
      currentValue: 1179,
      currentDetail: 'Grant Jerrett / TOTAL_POINTS',
      baselineLabel: 'Next comparison',
      baselineValue: 418,
      baselineDetail: 'Gary Harris / TOTAL_POINTS',
      deltaLabel: 'Top gap',
      delta: 761,
      deltaDetail: 'difference between Grant Jerrett and Gary Harris',
      rowsReviewed: 3,
    });
  });

  it('writes app research summaries with concrete ranked values instead of generic process text', () => {
    const summary = __test__.buildInvestigationSummary(
      'driver_breakdown',
      'Why did the top scorer change?',
      { title: 'Top scorers' },
      {
        metric: 'TOTAL_POINTS',
        currentValue: 1179,
        baselineValue: 418,
        delta: 761,
        currentDetail: 'Grant Jerrett / TOTAL_POINTS',
        baselineDetail: 'Gary Harris / TOTAL_POINTS',
      },
      [{ title: 'Grant Jerrett' }],
    );

    expect(summary).toContain('Grant Jerrett leads on TOTAL_POINTS with 1,179');
    expect(summary).toContain('versus 418 for Gary Harris');
    expect(summary).toContain('gap of 761');
    expect(summary).toContain('review-required until SQL, grain, filters, and lineage are confirmed');
    expect(summary).not.toContain('this review-required analysis answers');
  });

  it('builds governed app report sections from ranked preview proof', () => {
    const sections = __test__.buildInvestigationReportSections({
      intent: 'driver_breakdown',
      question: 'Why is the scorer table concentrated?',
      context: { actionMode: 'research' },
      selected: {
        title: 'Top scorers',
        blockId: 'Top Scorers',
        tileId: 'top-scorers-tile',
      },
      metrics: {
        metric: 'TOTAL_POINTS',
        currentLabel: 'Top value',
        currentValue: 1179,
        currentDetail: 'Grant Jerrett / TOTAL_POINTS',
        baselineLabel: 'Next comparison',
        baselineValue: 418,
        baselineDetail: 'Gary Harris / TOTAL_POINTS',
        deltaLabel: 'Top gap',
        delta: 761,
        deltaDetail: 'difference between Grant Jerrett and Gary Harris',
      },
      drivers: [
        { title: 'Grant Jerrett', contribution: '+1,179' },
        { title: 'Gary Harris', contribution: '+418' },
      ],
      summary: 'Grant Jerrett leads on TOTAL_POINTS with 1,179 versus 418 for Gary Harris, a gap of 761.',
      recommendation: 'Review the driver proof before promotion.',
    });

    expect(sections.map((section) => section.kind)).toEqual([
      'executive_answer',
      'business_interpretation',
      'key_numbers',
      'recommended_next_step',
      'review_boundary',
    ]);
    expect(sections[0].body).toContain('Grant Jerrett leads');
    expect(sections[1]).toMatchObject({ id: 'driver-readout', title: 'Driver readout' });
    expect(sections[1].body).toContain('Grant Jerrett is the strongest visible driver');
    expect(sections[2].bullets).toEqual(expect.arrayContaining([
      'Top value: 1,179 (Grant Jerrett / TOTAL_POINTS)',
      'Top gap: 761 (difference between Grant Jerrett and Gary Harris)',
    ]));
    expect(sections[2].body).toContain('bounded preview');
    expect(sections[4].body).toContain('source proof');
    expect(sections.map((section) => section.body).join('\n')).not.toMatch(/current evidence|source evidence|AI-generated research/i);
    expect(sections[0].evidenceRefs).toEqual(expect.arrayContaining(['block:Top Scorers', 'tile:top-scorers-tile']));
  });

  it('shapes report sections to the analyst intent instead of one fixed template', () => {
    const sections = __test__.buildInvestigationReportSections({
      intent: 'segment_compare',
      question: 'Compare scoring by player segment',
      context: { actionMode: 'research', activeFilterSummary: 'Season Start: 2016, Season End: 2017, Top N: 3' },
      selected: { title: 'Top scorers', blockId: 'Top Scorers' },
      metrics: {
        metric: 'TOTAL_POINTS',
        currentLabel: 'Top value',
        currentValue: 1179,
        currentDetail: 'Grant Jerrett / TOTAL_POINTS',
      },
      drivers: [{ title: 'Grant Jerrett', contribution: '+1,179' }],
      summary: 'Grant Jerrett is the top segment row.',
      recommendation: 'Confirm segment grouping before promotion.',
    });

    expect(sections.map((section) => section.title)).toEqual(expect.arrayContaining([
      'Segment readout',
      'Segment numbers',
    ]));
    expect(sections.map((section) => section.title)).not.toContain('Analysis focus');
    expect(sections.find((section) => section.id === 'segment-readout')?.body).toContain('segment readout');
  });

  it('adds missing comparison and SQL repair sections only when needed', () => {
    const sections = __test__.buildInvestigationReportSections({
      intent: 'diagnose_change',
      question: 'Why did the top player change?',
      context: { actionMode: 'research' },
      selected: { title: 'Top scorers', blockId: 'Top Scorers' },
      metrics: {},
      drivers: [],
      summary: 'The selected result is current-state only.',
      recommendation: 'Add a prior-period block.',
      baselineGap: true,
      sqlError: 'invalid identifier PLAYER_ID',
      sqlErrorKind: 'sql_repair',
    });

    expect(sections.map((section) => section.id)).toEqual(expect.arrayContaining([
      'missing-comparison',
      'sql-repair-path',
    ]));
    expect(sections.find((section) => section.id === 'change-explanation')?.body).toContain('current-state answer');
    expect(sections.find((section) => section.id === 'sql-repair-path')?.body).toContain('edit the SQL');
  });

  it('classifies warehouse/runtime preview failures separately from SQL repair', () => {
    const sections = __test__.buildInvestigationReportSections({
      intent: 'segment_compare',
      question: 'Compare top scorers',
      context: { actionMode: 'research' },
      selected: { title: 'Top scorers', blockId: 'Top Scorers' },
      metrics: {},
      drivers: [],
      summary: 'The report is based on selected dashboard context.',
      recommendation: 'Resume the warehouse and refresh.',
      sqlError: "Snowflake query failed: Warehouse 'COMPUTE_WH' is suspended.",
      sqlErrorKind: 'runtime_unavailable',
    });

    expect(sections.map((section) => section.id)).toContain('preview-unavailable');
    expect(sections.map((section) => section.id)).not.toContain('sql-repair-path');
    expect(sections.find((section) => section.id === 'preview-unavailable')?.body).toContain('warehouse or execution runtime is unavailable');
  });

  it('classifies AI SQL generation timeout separately from SQL preview timeout', () => {
    expect(__test__.classifySqlPreviewError('AI SQL generation timed out after 12s.')).toBe('ai_generation_timeout');
    expect(__test__.classifySqlPreviewError('Generated SQL preview timed out after 12s.')).toBe('timeout');

    const sections = __test__.buildInvestigationReportSections({
      intent: 'trust_gap_review',
      question: 'Validate the scorer gap',
      context: { actionMode: 'evidence' },
      selected: { title: 'Top scorers', blockId: 'Top Scorers' },
      metrics: { metric: 'TOTAL_POINTS', currentValue: 1179, baselineValue: 418, delta: 761 },
      drivers: [{ title: 'Grant Jerrett', contribution: '+1,179' }],
      summary: 'Grant Jerrett leads the selected scorer result.',
      recommendation: 'Use certified evidence and retry SQL generation if deeper proof is needed.',
      hasReportEvidence: true,
      sqlError: 'AI SQL generation timed out after 12s. DQL continued with deterministic app evidence and kept the analysis review-required.',
      sqlErrorKind: 'ai_generation_timeout',
    });

    expect(sections.map((section) => section.id)).toContain('ai-generation-timeout');
    expect(sections.map((section) => section.id)).not.toContain('preview-timeout');
    expect(sections.find((section) => section.id === 'ai-generation-timeout')?.body).toContain('certified app evidence only');
    expect(sections.find((section) => section.id === 'ai-generation-timeout')?.body).toContain('provide reviewed SQL');
    expect(sections.find((section) => section.id === 'recommended-next-step')?.body).not.toContain('Simplify the generated SQL');
  });

  it('keeps runtime preview failures out of the main report when selected evidence exists', () => {
    const sections = __test__.buildInvestigationReportSections({
      intent: 'segment_compare',
      question: 'Compare top scorers',
      context: { actionMode: 'research' },
      selected: { title: 'Top scorers', blockId: 'Top Scorers' },
      metrics: { metric: 'total_points', currentValue: 1179, baselineValue: 418, delta: 761 },
      drivers: [{ title: 'Grant Jerrett', contribution: '1179 points' }],
      summary: 'Grant Jerrett leads the selected scorer result.',
      recommendation: 'Use selected evidence and refresh the trace later.',
      hasReportEvidence: true,
      sqlError: "Snowflake query failed: Warehouse 'COMPUTE_WH' is suspended.",
      sqlErrorKind: 'runtime_unavailable',
    });

    expect(sections.map((section) => section.id)).not.toContain('preview-unavailable');
    expect(sections.find((section) => section.id === 'executive-answer')?.body).toContain('Grant Jerrett leads');
    expect(sections.find((section) => section.id === 'key-numbers')?.bullets?.join(' ')).toContain('1,179');
  });

  it('preserves provider-written Markdown report sections while keeping trace out of the main memo', () => {
    const sections = __test__.buildInvestigationReportSections({
      intent: 'diagnose_change',
      question: 'Why did the top player change?',
      context: { actionMode: 'research', activeFilterSummary: 'Season Start: 2016, Season End: 2017, Top N: 5' },
      selected: { title: 'Top scorers', blockId: 'Top Scorers' },
      metrics: { metric: 'total_points', currentValue: 1179, baselineValue: 418, delta: 761 },
      drivers: [{ title: 'Grant Jerrett', contribution: '1179 points' }],
      summary: 'Fallback summary should not replace provider memo.',
      recommendation: 'Validate the scorer window before promotion.',
      agentAnswer: `## Executive answer
Grant Jerrett leads the selected scoring window because the current result is heavily concentrated in one player row.

## Driver story
- Grant Jerrett: 1,179 points
- Gary Harris: 418 points

The gap is large enough that stakeholders should review source grain before treating it as a player-performance conclusion.

## Caveats
The answer is review-required until SQL, filters, and lineage are validated.

## SQL
\`\`\`sql
SELECT * FROM hidden_trace
\`\`\``,
    });

    expect(sections.map((section) => section.title)).toEqual(expect.arrayContaining([
      'Executive answer',
      'Driver story',
      'Caveats',
      'Review boundary',
    ]));
    expect(sections.find((section) => section.title === 'Driver story')?.bullets).toEqual([
      'Grant Jerrett: 1,179 points',
      'Gary Harris: 418 points',
    ]);
    expect(sections.map((section) => section.title)).not.toContain('SQL');
    expect(JSON.stringify(sections)).not.toContain('hidden_trace');
    expect(sections.find((section) => section.title === 'Executive answer')?.body).not.toContain('Fallback summary');
  });

  it('uses stakeholder report sections when pinning an app insight', () => {
    const answer = __test__.investigationNarrativeAnswer({
      id: 'inv_top_scorers',
      appId: 'nba-app',
      title: 'Top scorer research',
      question: 'Why did the top player change?',
      intent: 'driver_breakdown',
      status: 'ready',
      reviewStatus: 'needs_review',
      createdAt: '2026-06-22T00:00:00.000Z',
      updatedAt: '2026-06-22T00:00:00.000Z',
      summary: 'Fallback summary should not be used.',
      recommendation: 'Fallback recommendation should not be used.',
      evidence: [],
      resultPreviews: [],
      driverCards: [],
      reportSections: [
        {
          id: 'executive-answer',
          kind: 'executive_answer',
          title: 'Executive answer',
          body: 'Grant Jerrett leads on total points in the selected period.',
          tone: 'answer',
          evidenceRefs: ['block:Top Scorers'],
        },
        {
          id: 'key-numbers',
          kind: 'key_numbers',
          title: 'Key numbers',
          body: 'The visible ranked result shows the following values.',
          tone: 'insight',
          bullets: ['Grant Jerrett: 1,179 points', 'Gary Harris: 418 points'],
        },
        {
          id: 'review-boundary',
          kind: 'review_boundary',
          title: 'Review boundary',
          body: 'This analysis is review-required until SQL and source proof are validated.',
          tone: 'review',
        },
      ],
    });

    expect(answer).toContain('## Executive answer');
    expect(answer).toContain('Grant Jerrett leads on total points');
    expect(answer).toContain('- Grant Jerrett: 1,179 points');
    expect(answer).not.toContain('Review boundary');
    expect(answer).not.toContain('_Evidence:');
    expect(answer).not.toContain('Fallback summary');
  });

  it('reuses matching pinned app insights instead of adding duplicate dashboard tiles', () => {
    const root = createProject();
    writeBlock(root, 'growth/revenue.dql', {
      name: 'Revenue Total',
      domain: 'growth',
      status: 'certified',
      tags: ['revenue'],
      description: 'Revenue KPI',
      chart: 'bar',
    });
    const app = createAppPackage(root, {
      name: 'Growth CXO',
      domain: 'growth',
      purpose: 'Executive growth scorecard',
      audience: 'executive',
      owners: ['owner@local'],
      selectedBlockIds: ['Revenue Total'],
    });
    expect(app.ok).toBe(true);
    if (!app.ok) return;

    const input = {
      dashboardId: 'overview',
      title: 'Analysis: Revenue concentration',
      answer: 'Revenue is concentrated in the top account.',
      question: 'Why is revenue concentrated?',
      sourceTier: 'metadata_research',
      certification: 'ai_generated' as const,
      reviewStatus: 'needs_review' as const,
      refreshCadence: 'none' as const,
      chartConfig: { chart: 'table' },
      result: {
        columns: ['account', 'revenue'],
        rows: [{ account: 'Acme', revenue: 1200 }],
        rowCount: 1,
      },
      analysisPlan: {
        sourceBlockId: 'Revenue Total',
        sourceTileId: 'revenue-total',
      },
    };

    const first = __test__.createAiPinTile(root, 'growth-cxo', input);
    const second = __test__.createAiPinTile(root, 'growth-cxo', input);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.deduped).toBe(true);
    expect((second.pin as { id: string }).id).toBe((first.pin as { id: string }).id);
    const dashboard = JSON.parse(readFileSync(join(root, 'apps/growth-cxo/dashboards/overview.dqld'), 'utf-8'));
    expect(dashboard.layout.items.filter((item: { aiPin?: unknown }) => Boolean(item.aiPin))).toHaveLength(1);
  });

  it('reports deduped local pinned insights in app summaries', () => {
    const root = createProject();
    writeBlock(root, 'growth/revenue.dql', {
      name: 'Revenue Total',
      domain: 'growth',
      status: 'certified',
      tags: ['revenue'],
      description: 'Revenue KPI',
      chart: 'bar',
    });
    const app = createAppPackage(root, {
      name: 'Growth CXO',
      domain: 'growth',
      purpose: 'Executive growth scorecard',
      audience: 'executive',
      owners: ['owner@local'],
      selectedBlockIds: ['Revenue Total'],
    });
    expect(app.ok).toBe(true);
    if (!app.ok) return;

    const first = __test__.createAiPinTile(root, 'growth-cxo', {
      dashboardId: 'overview',
      tileId: 'qa-pin-one',
      title: 'Analysis: Revenue concentration',
      answer: 'Revenue is concentrated in the top account.',
      question: 'Why is revenue concentrated?',
      result: { columns: ['account', 'revenue'], rows: [{ account: 'Acme', revenue: 1200 }] },
      analysisPlan: { sourceBlockId: 'Revenue Total', sourceTileId: 'revenue-total' },
    });
    const second = __test__.createAiPinTile(root, 'growth-cxo', {
      dashboardId: 'overview',
      tileId: 'qa-pin-two',
      title: 'Analysis: Revenue concentration',
      answer: 'Revenue is concentrated in the top account.',
      question: 'Why is revenue concentrated?',
      result: { columns: ['account', 'revenue'], rows: [{ account: 'Acme', revenue: 1200 }] },
      analysisPlan: { sourceBlockId: 'Revenue Total', sourceTileId: 'revenue-total' },
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const loaded = __test__.collectAppsList(root).find((entry) => entry.id === 'growth-cxo');
    expect(loaded?.aiPins).toBe(1);
    const details = __test__.loadAppById(root, 'growth-cxo');
    expect(details?.aiPins).toHaveLength(1);
  });

  it('bounds generated SQL preview so app research can finish with a review caveat', async () => {
    const previous = process.env.DQL_APP_RESEARCH_PREVIEW_TIMEOUT_MS;
    process.env.DQL_APP_RESEARCH_PREVIEW_TIMEOUT_MS = '500';
    try {
      const result = await __test__.runGeneratedSqlPreview({
        projectRoot: createProject(),
        req: {} as any,
        res: {} as any,
        url: new URL('http://local.test/api/apps/test/investigations/test/run'),
        path: '/api/apps/test/investigations/test/run',
        executeSql: () => new Promise(() => undefined),
      }, 'SELECT 1 AS x');

      expect(result.preview).toBeUndefined();
      expect(result.fatal).toBe(false);
      expect(result.error).toContain('preview timed out');
    } finally {
      if (previous === undefined) delete process.env.DQL_APP_RESEARCH_PREVIEW_TIMEOUT_MS;
      else process.env.DQL_APP_RESEARCH_PREVIEW_TIMEOUT_MS = previous;
    }
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
  block: TestBlockSpec,
): void {
  writeBlockFile(join(root, 'blocks', relPath), block);
}

function writeDomainBlock(
  root: string,
  domain: string,
  relPath: string,
  block: TestBlockSpec,
): void {
  writeBlockFile(join(root, 'domains', domain, 'blocks', relPath), block);
}

function writeBlockFile(
  abs: string,
  block: TestBlockSpec,
): void {
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, `block "${block.name}" {
  domain = "${block.domain}"
  status = "${block.status}"
  type = "custom"
  description = "${block.description}"
  owner = "analytics@local"
  tags = [${block.tags.map((tag) => `"${tag}"`).join(', ')}]
${formatTestFilterBindings(block)}
${formatTestParams(block)}

  query = """
${block.query ?? 'SELECT 1 AS value'}
"""

  visualization {
    chart = "${block.chart}"
  }
}
`);
}

function formatTestFilterBindings(block: TestBlockSpec): string {
  if (!block.filterBindings?.length) return '';
  const bindings = block.filterBindings
    .map((entry) => `    ${entry.filter} = "${entry.binding}"`)
    .join('\n');
  return `
  filterBindings {
${bindings}
  }
`;
}

function formatTestParams(block: TestBlockSpec): string {
  if (!block.params || Object.keys(block.params).length === 0) return '';
  const params = Object.entries(block.params)
    .map(([key, value]) => `    ${key} = ${formatTestParamValue(value)}`)
    .join('\n');
  return `
  params {
${params}
  }
`;
}

function formatTestParamValue(value: string | number | boolean | Array<string | number | boolean>): string {
  if (Array.isArray(value)) return `[${value.map(formatTestParamValue).join(', ')}]`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return `"${value.replace(/"/g, '\\"')}"`;
}
