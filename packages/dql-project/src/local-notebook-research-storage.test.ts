import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalNotebookResearchStorage } from './local-notebook-research-storage.js';

let dir: string;
let store: LocalNotebookResearchStorage;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dql-notebook-research-'));
  store = new LocalNotebookResearchStorage(join(dir, '.dql', 'local', 'notebook-research.sqlite'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('LocalNotebookResearchStorage', () => {
  it('creates source-cell lookup indexes for large notebook coverage', () => {
    const db = (store as unknown as { db: { prepare: (sql: string) => { all: (...args: unknown[]) => Array<Record<string, unknown>> } } }).db;
    const indexes = db.prepare("PRAGMA index_list('notebook_research_runs')").all();
    expect(indexes.map((row) => row.name)).toContain('idx_notebook_research_source_cell');

	    const columns = db.prepare("PRAGMA index_info('idx_notebook_research_source_cell')").all();
	    expect(columns.map((row) => row.name)).toEqual(['notebook_path', 'source_cell_id', 'updated_at']);

	    const fingerprintColumns = db.prepare("PRAGMA index_info('idx_notebook_research_source_fingerprint')").all();
	    expect(fingerprintColumns.map((row) => row.name)).toEqual(['notebook_path', 'source_cell_fingerprint', 'updated_at']);

	    const tables = db.prepare("SELECT name FROM sqlite_master WHERE name = 'notebook_research_runs_fts'").all();
	    expect(tables.map((row) => row.name)).toEqual(['notebook_research_runs_fts']);
  });

  it('reports research diagnostics for enterprise queue health', () => {
    const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).db;
    const activeScoring = store.createRun({
      notebookPath: 'notebooks/nba_research.dqlnb',
      domain: 'nba',
      owner: 'basketball-analytics',
      sourceCellId: 'cell_points',
      sourceCellName: 'top_players_sql',
      question: 'Which NBA players led scoring?',
      generatedSql: 'select player_name, sum(points) as total_points from player_stats group by 1',
    });
    const activeRevenue = store.createRun({
      notebookPath: 'notebooks/revenue_research.dqlnb',
      domain: 'revenue',
      owner: 'finance-analytics',
      question: 'Which accounts changed ARR?',
      generatedSql: 'select account_id, sum(arr) as arr from mart_account_revenue group by 1',
    });
    const closedScoring = store.createRun({
      notebookPath: 'notebooks/nba_research.dqlnb',
      domain: 'nba',
      owner: 'basketball-analytics',
      sourceCellId: 'cell_assists',
      sourceCellName: 'top_assists_sql',
      question: 'Which NBA players led assists?',
      generatedSql: 'select player_name, sum(assists) as total_assists from player_stats group by 1',
    });
    store.updateRun(closedScoring.id, { reviewStatus: 'completed' });
    db.prepare('UPDATE notebook_research_runs SET updated_at = ? WHERE id = ?').run(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(), activeScoring.id);
    db.prepare('UPDATE notebook_research_runs SET updated_at = ? WHERE id = ?').run(new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(), activeRevenue.id);
    db.prepare('UPDATE notebook_research_runs SET updated_at = ? WHERE id = ?').run(new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(), closedScoring.id);

    const diagnostics = store.getDiagnostics();

    expect(diagnostics.counts).toMatchObject({
      totalRuns: 3,
      activeRuns: 2,
      closedRuns: 1,
      notebooks: 2,
      domains: 2,
      owners: 2,
      sourceLinkedRuns: 2,
    });
    expect(diagnostics.health).toMatchObject({
      staleOpenRuns: 2,
      expiredOpenRuns: 1,
      staleThresholdDays: 7,
      expiredThresholdDays: 30,
    });
    expect(diagnostics.health.oldestOpenUpdatedAt).toBeTruthy();
    expect(diagnostics.health.newestOpenUpdatedAt).toBeTruthy();
    expect(diagnostics.search).toMatchObject({
      indexed: true,
      indexRows: 3,
      indexVersion: '4',
      stale: false,
    });
    expect(diagnostics.limits).toEqual({
      pageSize: 25,
      maxPageSize: 500,
      sourceCoverageLimit: 10_000,
      seedCellLimit: 1_000,
    });
    expect(diagnostics.updatedAt.oldest).toBeTruthy();
    expect(diagnostics.updatedAt.newest).toBeTruthy();
    expect(diagnostics.warnings.join('\n')).toContain('1 open research run(s) have not changed in 30+ days');
    expect(store.listRunsPage({ age: 'stale_open' }).runs.map((run) => run.id).sort()).toEqual([activeRevenue.id, activeScoring.id].sort());
    expect(store.listRunsPage({ age: 'expired_open' }).runs.map((run) => run.id)).toEqual([activeRevenue.id]);
    expect(store.listRunsPage({ notebookPath: 'notebooks/nba_research.dqlnb' }).counts).toMatchObject({
      staleOpen: 1,
      expiredOpen: 0,
    });
    expect(store.listRunsPage({ domain: 'revenue' }).counts).toMatchObject({
      staleOpen: 1,
      expiredOpen: 1,
    });
    const portfolio = store.listRunsPage({ sort: 'priority' });
    expect(portfolio.domains.find((item) => item.domain === 'nba')).toMatchObject({
      staleOpen: 1,
      expiredOpen: 0,
    });
    expect(portfolio.domains.find((item) => item.domain === 'revenue')).toMatchObject({
      staleOpen: 1,
      expiredOpen: 1,
    });
    expect(portfolio.owners.find((item) => item.owner === 'basketball-analytics')).toMatchObject({
      total: 2,
      staleOpen: 1,
      expiredOpen: 0,
    });
    expect(portfolio.owners.find((item) => item.owner === 'finance-analytics')).toMatchObject({
      total: 1,
      staleOpen: 1,
      expiredOpen: 1,
    });
    expect(portfolio.notebooks.find((item) => item.path === 'notebooks/revenue_research.dqlnb')).toMatchObject({
      staleOpen: 1,
      expiredOpen: 1,
    });
    expect(store.getRun(activeScoring.id)?.reviewStatus).toBe('needs_review');
    expect(store.getRun(activeRevenue.id)?.reviewStatus).toBe('needs_review');
  });

  it('reports review latency and certification conversion metrics for the research queue', () => {
    const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).db;
    const base = Date.parse('2026-07-05T12:00:00.000Z');
    const created = new Date(base).toISOString();
    const open = store.createRun({
      notebookPath: 'notebooks/review_metrics.dqlnb',
      question: 'open review',
      generatedSql: 'select 1',
    });
    const draft = store.createRun({
      notebookPath: 'notebooks/review_metrics.dqlnb',
      question: 'draft created',
      generatedSql: 'select 2',
    });
    const certified = store.createRun({
      notebookPath: 'notebooks/review_metrics.dqlnb',
      question: 'certified',
      generatedSql: 'select 3',
    });
    const rejected = store.createRun({
      notebookPath: 'notebooks/review_metrics.dqlnb',
      question: 'rejected',
      generatedSql: 'select 4',
    });

    db.prepare('UPDATE notebook_research_runs SET created_at = ?, updated_at = ? WHERE id = ?').run(created, created, open.id);
    db.prepare('UPDATE notebook_research_runs SET review_status = ?, created_at = ?, updated_at = ? WHERE id = ?')
      .run('draft_created', created, new Date(base + 30_000).toISOString(), draft.id);
    db.prepare('UPDATE notebook_research_runs SET review_status = ?, created_at = ?, updated_at = ? WHERE id = ?')
      .run('certified', created, new Date(base + 90_000).toISOString(), certified.id);
    db.prepare('UPDATE notebook_research_runs SET review_status = ?, created_at = ?, updated_at = ? WHERE id = ?')
      .run('rejected', created, new Date(base + 120_000).toISOString(), rejected.id);

    const metrics = store.listRunsPage().reviewMetrics;
    expect(metrics).toMatchObject({
      totalReviewCount: 4,
      openReviewCount: 2,
      terminalReviewCount: 2,
      draftCreatedCount: 1,
      certifiedCount: 1,
      rejectedCount: 1,
      draftCreationRate: 0.25,
      certifyConversionRate: 0.5,
      medianTimeToDraftMs: 30_000,
      medianTimeToCertificationMs: 90_000,
      medianTimeToTerminalMs: 105_000,
    });
    expect(metrics.medianOpenReviewAgeMs).toBeGreaterThan(0);
  });

	  it('stores notebook research runs independently from Apps', () => {
	    const created = store.createRun({
	      notebookPath: 'notebooks/nba_research.dqlnb',
      domain: 'nba',
      sourceCellId: 'cell_1',
      sourceCellName: 'top_players_sql',
      question: 'Which NBA players led scoring in 2017?',
      generatedSql: 'select player_name, sum(points) as total_points from player_stats group by 1',
      context: { selectedTables: ['player_stats'] },
    });

    expect(created.status).toBe('draft');
    expect(created.domain).toBe('nba');
    expect(created.reviewStatus).toBe('needs_review');
    expect(created.intent).toBe('ad_hoc_analysis');
    expect(store.listRuns('notebooks/nba_research.dqlnb')).toHaveLength(1);

    const updated = store.updateRun(created.id, {
      status: 'ready',
      summary: 'The preview ranks players by total points.',
      recommendation: 'Promote this as a ranking block after reviewing season filters.',
      resultPreview: {
        columns: ['player_name', 'total_points'],
        rows: [{ player_name: 'Grant Jerrett', total_points: 357 }],
        rowCount: 1,
      },
      evidence: { contextPackId: 'ctx_123', validation: { status: 'passed' } },
      researchPlan: {
        sqlState: 'reviewed',
        grain: 'player_name',
        parameterPolicy: [{ name: 'season_year', policy: 'dynamic' }],
        allowedFilters: ['season_year'],
        evidence: {
          trustLabel: 'Reviewed notebook SQL',
          contextPackId: 'ctx_123',
          evidenceCount: 2,
          relationCount: 1,
          missingContextCount: 0,
        },
        preview: { status: 'ready', rowCount: 1 },
        promotion: { path: 'create_dql_draft' },
        reviewFocus: ['parameterization', 'lineage evidence'],
        generatedAt: '2026-06-20T00:00:00.000Z',
      },
      contextPackId: 'ctx_123',
      routeDecision: { route: 'generated_sql' },
      reviewedSql: 'select player_name, sum(points) as total_points from player_stats group by 1',
      warnings: ['Review tie breaker.'],
      lastRunAt: '2026-06-20T00:00:00.000Z',
    });

    expect(updated?.status).toBe('ready');
    expect(updated?.resultPreview).toMatchObject({ rowCount: 1 });
    expect(updated?.warnings).toEqual(['Review tie breaker.']);
    expect(updated?.routeDecision).toMatchObject({ route: 'generated_sql' });
    expect(updated?.researchPlan).toMatchObject({
      sqlState: 'reviewed',
      grain: 'player_name',
      preview: { status: 'ready', rowCount: 1 },
      promotion: { path: 'create_dql_draft' },
    });
    expect(store.getRun(created.id)?.researchPlan?.parameterPolicy).toEqual([{ name: 'season_year', policy: 'dynamic' }]);
    expect(store.listRunsPage({ readiness: 'draft_ready' }).runs.map((run) => run.id)).toEqual([created.id]);

    const promoted = store.markPromoted(created.id, {
      draftBlockPath: 'domains/nba/blocks/_drafts/top-players.dql',
      dqlImportId: 'imp_123',
      dqlCandidateIds: ['cand_123'],
      dqlPromotion: {
        importId: 'imp_123',
        candidateIds: ['cand_123'],
        draftBlockPath: 'domains/nba/blocks/_drafts/top-players.dql',
        recommendedAction: 'reuse_existing',
        similarityMatches: [{
          kind: 'parameterized_duplicate',
          name: 'Certified Top Players',
          status: 'certified',
          score: 0.94,
          reason: 'SQL shape matches after replacing literal values with parameters.',
          recommendedAction: 'reuse_existing',
        }],
        candidates: [{
          id: 'cand_123',
          name: 'Top Players',
          domain: 'nba',
          draftPath: 'domains/nba/blocks/_drafts/top-players.dql',
          reviewStatus: 'draft',
          recommendedAction: 'reuse_existing',
          similarityMatches: [],
          parameterPolicy: [{ name: 'season_year', policy: 'dynamic' }],
          allowedFilters: ['season_year'],
          warnings: ['Review duplicate recommendation.'],
        }],
        createdAt: '2026-06-20T00:00:01.000Z',
      },
    });
    expect(promoted?.reviewStatus).toBe('draft_created');
    expect(promoted?.draftBlockPath).toBe('domains/nba/blocks/_drafts/top-players.dql');
    expect(promoted?.dqlCandidateIds).toEqual(['cand_123']);
    expect(promoted?.dqlPromotionAction).toBe('reuse_existing');
    expect(promoted?.dqlPromotion?.recommendedAction).toBe('reuse_existing');
    expect(promoted?.dqlPromotion?.similarityMatches[0]).toMatchObject({
      kind: 'parameterized_duplicate',
      name: 'Certified Top Players',
    });
	    expect(promoted?.dqlPromotion?.candidates[0].parameterPolicy).toEqual([{ name: 'season_year', policy: 'dynamic' }]);
	    const certReady = store.listRunsPage({ readiness: 'certification_ready' });
	    expect(certReady.runs.map((run) => run.id)).toEqual([]);
	    expect(certReady.counts).toMatchObject({ draftReady: 1, certificationReady: 0, blocked: 0 });
	  });

	  it('links agent-created runs from nested sourceCell payloads', () => {
	    const created = store.createRun({
	      notebookPath: 'notebooks/nba_research.dqlnb',
	      domain: 'nba',
	      sourceCell: {
	        id: 'cell_points',
	        name: 'Top Players SQL',
	        fingerprint: 'fnv1a:source123',
	        type: 'sql',
	        sql: 'select player_name, sum(points) as total_points from player_stats group by 1',
	      },
	      question: 'Which NBA players should become a reusable scoring block?',
	      generatedSql: 'select player_name, sum(points) as total_points from player_stats group by 1',
	    });

	    expect(created.sourceCellId).toBe('cell_points');
	    expect(created.sourceCellName).toBe('Top Players SQL');
	    expect(created.sourceCellFingerprint).toBe('fnv1a:source123');
	    expect(store.listRunsPage({ notebookPath: 'notebooks/nba_research.dqlnb', sourceCellId: 'cell_points' }).runs.map((run) => run.id)).toEqual([created.id]);

	    const seeded = store.seedRunsFromCells({
	      notebookPath: 'notebooks/nba_research.dqlnb',
	      domain: 'nba',
	      cells: [{
	        sourceCell: {
	          id: 'cell_assists',
	          name: 'Top Assists SQL',
	          type: 'sql',
	          sql: 'select player_name, sum(assists) as total_assists from player_stats group by 1',
	        },
	      }],
	    });

	    expect(seeded.createdCount).toBe(1);
	    expect(seeded.created[0].sourceCellId).toBe('cell_assists');
	    expect(seeded.created[0].sourceCellName).toBe('Top Assists SQL');
	    expect(seeded.created[0].sourceCellFingerprint).toMatch(/^fnv1a:/);
	  });

  it('persists DQL artifacts as promotable notebook research context', () => {
    const dqlArtifact = {
      kind: 'semantic_block' as const,
      name: 'product_supply_top_value',
      sourcePath: 'blocks/_drafts/product_supply_top_value.dql',
      source: `block "product_supply_top_value" {
  type = "semantic"
  status = "draft"
  metric = "supply_value"
  dimensions = ["product_name", "supply_name"]
}`,
      metrics: ['supply_value'],
      dimensions: ['product_name', 'supply_name'],
      filters: [{ dimension: 'is_perishable', operator: '=', values: ['true'] }],
      orderBy: [{ name: 'supply_value', direction: 'desc' as const }],
      limit: 10,
    };
    const created = store.createRun({
      notebookPath: 'notebooks/supply_chain.dqlnb',
      domain: 'supply_chain',
      question: 'Can you give me the complete supply chain with product and order details with top 10 value?',
      dqlArtifact,
    });

    expect(created.dqlArtifact).toMatchObject({
      kind: 'semantic_block',
      name: 'product_supply_top_value',
      metrics: ['supply_value'],
      dimensions: ['product_name', 'supply_name'],
      limit: 10,
    });

    const updated = store.updateRun(created.id, {
      status: 'ready',
      evidence: {
        contextPackId: 'ctx_supply',
        selectedEvidence: [{ name: 'semantic model supply_chain', reason: 'metric and dimensions matched' }],
      },
      resultPreview: {
        columns: ['product_name', 'supply_name', 'supply_value'],
        rows: [{ product_name: 'JAF-003', supply_name: 'mustard', supply_value: 42 }],
        rowCount: 1,
      },
    });

    expect(updated?.dqlArtifact?.filters).toEqual([{ dimension: 'is_perishable', operator: '=', values: ['true'] }]);
    expect(store.getRun(created.id)?.dqlArtifact?.orderBy).toEqual([{ name: 'supply_value', direction: 'desc' }]);
    expect(store.listRunsPage({ search: 'product_supply_top_value supply_value' }).runs.map((run) => run.id)).toEqual([created.id]);
    expect(store.listRunsPage({ readiness: 'draft_ready' }).runs.map((run) => run.id)).toEqual([created.id]);
    expect(store.listRunsPage({ nextAction: 'create_dql_draft' }).runs.map((run) => run.id)).toEqual([created.id]);
    expect(store.listRunsPage({ nextAction: 'review_sql' }).runs).toEqual([]);
  });

	  it('matches unlinked historical runs to source coverage by fingerprint', () => {
	    const created = store.createRun({
	      notebookPath: 'notebooks/nba_research.dqlnb',
	      domain: 'nba',
	      sourceCellFingerprint: 'fnv1a:legacy123',
	      sourceCellName: 'Legacy top players SQL',
	      question: 'Which NBA players led scoring?',
	      reviewedSql: 'select player_name, sum(points) as total_points from player_stats group by 1',
	    });

	    expect(created.sourceCellId).toBeUndefined();

	    const coverage = store.listLatestRunsBySourceCell({
	      notebookPath: 'notebooks/nba_research.dqlnb',
	      sourceCellIds: ['cell_points'],
	      sourceCells: [{
	        id: 'cell_points',
	        name: 'Top Players SQL',
	        fingerprint: 'fnv1a:legacy123',
	      }],
	    });

	    expect(coverage).toHaveLength(1);
	    expect(coverage[0].id).toBe(created.id);
	    expect(coverage[0].sourceCellId).toBe('cell_points');
	    expect(coverage[0].sourceCellName).toBe('Legacy top players SQL');
	    expect(coverage[0].sourceCellFingerprint).toBe('fnv1a:legacy123');
	    expect(store.getRun(created.id)?.sourceCellId).toBeUndefined();
	  });

	  it('does not seed duplicate research when a source fingerprint is already covered', () => {
	    const existing = store.createRun({
	      notebookPath: 'notebooks/nba_research.dqlnb',
	      domain: 'nba',
	      sourceCellFingerprint: 'fnv1a:covered123',
	      question: 'Which NBA players led scoring?',
	      reviewedSql: 'select player_name, sum(points) as total_points from player_stats group by 1',
	    });

	    const seeded = store.seedRunsFromCells({
	      notebookPath: 'notebooks/nba_research.dqlnb',
	      domain: 'nba',
	      cells: [{
	        id: 'cell_points',
	        name: 'Top Players SQL',
	        sql: 'select player_name, sum(points) as total_points from player_stats group by 1',
	        sourceCellFingerprint: 'fnv1a:covered123',
	      }],
	    });

	    expect(seeded.createdCount).toBe(0);
	    expect(seeded.skippedCount).toBe(1);
	    expect(store.listRunsPage({ notebookPath: 'notebooks/nba_research.dqlnb' }).runs.map((run) => run.id)).toEqual([existing.id]);
	    expect(store.getRun(existing.id)?.sourceCellId).toBeUndefined();
	  });

	  it('infers research intents from questions', () => {
    const run = store.createRun({
      notebookPath: 'notebooks/research.dqlnb',
      question: 'Why did revenue drop in February?',
    });

    expect(run.intent).toBe('diagnose_change');
    expect(store.listRunsPage({ intent: 'diagnose_change' }).runs.map((item) => item.id)).toEqual([run.id]);
  });

	  it('filters and pages research runs for enterprise-sized notebooks', () => {
    const scoring = store.createRun({
      notebookPath: 'notebooks/nba_research.dqlnb',
      domain: 'nba',
      owner: 'basketball-analytics',
      sourceCellName: 'scoring_sql',
      question: 'Which NBA players led total points in 2017?',
    });
    const assists = store.createRun({
      notebookPath: 'notebooks/nba_research.dqlnb',
      domain: 'nba',
      owner: 'basketball-analytics',
      sourceCellName: 'assists_sql',
      question: 'Which NBA players led assists in 2017?',
    });
    const revenue = store.createRun({
      notebookPath: 'notebooks/revenue_research.dqlnb',
      domain: 'revenue',
      owner: 'finance-analytics',
      sourceCellName: 'arr_sql',
      question: 'Why did ARR drop in February?',
      generatedSql: 'select account_id, sum(arr) as arr from revenue group by 1',
    });

    store.updateRun(scoring.id, {
      status: 'ready',
      summary: 'Top points preview',
      generatedSql: 'select player_name, sum(points) as total_points from player_stats group by 1',
      reviewedSql: 'select player_name, sum(points) as total_points from player_stats group by 1',
    });
    store.updateRun(assists.id, { status: 'error', error: 'Missing assists column' });
    store.markPromoted(revenue.id, {
      draftBlockPath: 'domains/revenue/blocks/_drafts/arr-drop.dql',
      dqlImportId: 'imp_revenue',
      dqlCandidateIds: ['cand_revenue'],
      dqlPromotion: {
        importId: 'imp_revenue',
        candidateIds: ['cand_revenue'],
        draftBlockPath: 'domains/revenue/blocks/_drafts/arr-drop.dql',
        recommendedAction: 'create_new',
        similarityMatches: [],
        candidates: [],
        createdAt: '2026-06-20T00:00:01.000Z',
      },
    });

    const nbaPage = store.listRunsPage({
      notebookPath: 'notebooks/nba_research.dqlnb',
      search: 'players',
      limit: 1,
      offset: 0,
    });
    expect(nbaPage.total).toBe(2);
    expect(nbaPage.runs).toHaveLength(1);
    expect(nbaPage.limit).toBe(1);
    expect(nbaPage.counts).toMatchObject({ total: 2, ready: 1, needsReview: 2, errors: 1 });
    expect(nbaPage.notebooks).toEqual([{
      path: 'notebooks/nba_research.dqlnb',
      title: 'nba research',
      total: 2,
      draftReady: 0,
      certificationReady: 0,
      blocked: 1,
      staleOpen: 0,
      expiredOpen: 0,
      nextAction: 'fix_blockers',
      nextActionCount: 1,
    }]);

    const ready = store.listRunsPage({ status: 'ready' });
    expect(ready.runs.map((run) => run.id)).toEqual([scoring.id]);
    expect(ready.total).toBe(1);
    expect(ready.counts.total).toBe(3);
    expect(ready.notebooks.map((item) => item.path)).toEqual([
      'notebooks/nba_research.dqlnb',
      'notebooks/revenue_research.dqlnb',
    ]);

    const promoted = store.listRunsPage({ reviewStatus: 'draft_created', search: 'revenue' });
    expect(promoted.total).toBe(1);
    expect(promoted.counts).toMatchObject({ total: 1, dqlDrafts: 1, createNew: 1 });
    expect(promoted.runs[0].draftBlockPath).toBe('domains/revenue/blocks/_drafts/arr-drop.dql');
    expect(promoted.notebooks).toEqual([{
      path: 'notebooks/revenue_research.dqlnb',
      title: 'revenue research',
      total: 1,
      draftReady: 0,
      certificationReady: 0,
      blocked: 0,
      staleOpen: 0,
      expiredOpen: 0,
      nextAction: 'review_sql',
      nextActionCount: 1,
    }]);

    const newBlockWork = store.listRunsPage({ promotionAction: 'create_new' });
    expect(newBlockWork.total).toBe(1);
    expect(newBlockWork.runs[0].id).toBe(revenue.id);
    expect(newBlockWork.counts).toMatchObject({ total: 3, createNew: 1, draftReady: 0, blocked: 1 });
    expect(newBlockWork.counts.nextActions).toMatchObject({ review_sql: 1, review_context: 1, fix_blockers: 1 });

    const reviewSqlWork = store.listRunsPage({ nextAction: 'review_sql' });
    expect(reviewSqlWork.total).toBe(1);
    expect(reviewSqlWork.runs.map((run) => run.id)).toEqual([revenue.id]);

    const reviewContextWork = store.listRunsPage({ nextAction: 'review_context' });
    expect(reviewContextWork.total).toBe(1);
    expect(reviewContextWork.runs.map((run) => run.id)).toEqual([scoring.id]);

    const blockerWork = store.listRunsPage({ nextAction: 'fix_blockers' });
    expect(blockerWork.total).toBe(1);
    expect(blockerWork.runs[0].id).toBe(assists.id);

    const draftReady = store.listRunsPage({ readiness: 'draft_ready' });
    expect(draftReady.runs).toEqual([]);

    const blocked = store.listRunsPage({ readiness: 'blocked' });
    expect(blocked.runs.map((run) => run.id)).toEqual([assists.id]);

    const nbaDomain = store.listRunsPage({ domain: 'nba' });
    expect(nbaDomain.total).toBe(2);
    expect(nbaDomain.runs.map((run) => run.domain)).toEqual(['nba', 'nba']);
    expect(nbaDomain.counts).toMatchObject({ total: 2, ready: 1, errors: 1, blocked: 1 });

    const basketballOwner = store.listRunsPage({ owner: 'basketball-analytics' });
    expect(basketballOwner.total).toBe(2);
    expect(basketballOwner.runs.map((run) => run.owner)).toEqual(['basketball-analytics', 'basketball-analytics']);

    const financeOwnerSearch = store.listRunsPage({ search: 'finance-analytics' });
    expect(financeOwnerSearch.total).toBe(1);
    expect(financeOwnerSearch.runs[0].id).toBe(revenue.id);

    const projectDomains = store.listRunsPage({ sort: 'priority' });
    expect(projectDomains.domains.map((item) => item.domain).sort()).toEqual(['nba', 'revenue']);
    expect(projectDomains.owners.map((item) => item.owner).sort()).toEqual(['basketball-analytics', 'finance-analytics']);
    expect(projectDomains.domains.find((item) => item.domain === 'nba')).toMatchObject({ total: 2, blocked: 1, nextAction: 'fix_blockers', nextActionCount: 1 });
    expect(projectDomains.domains.find((item) => item.domain === 'revenue')).toMatchObject({ total: 1, nextAction: 'review_sql', nextActionCount: 1 });
    expect(projectDomains.owners.find((item) => item.owner === 'basketball-analytics')).toMatchObject({ total: 2, blocked: 1, nextAction: 'fix_blockers', nextActionCount: 1 });
    expect(projectDomains.owners.find((item) => item.owner === 'finance-analytics')).toMatchObject({ total: 1, nextAction: 'review_sql', nextActionCount: 1 });
    expect(projectDomains.intents.find((item) => item.intent === 'ad_hoc_analysis')).toMatchObject({ total: 2, nextAction: 'fix_blockers', nextActionCount: 1 });
    expect(projectDomains.intents.find((item) => item.intent === 'diagnose_change')).toMatchObject({ total: 1, draftReady: 0, nextAction: 'review_sql', nextActionCount: 1 });

    const diagnoseWork = store.listRunsPage({ intent: 'diagnose_change' });
    expect(diagnoseWork.total).toBe(1);
    expect(diagnoseWork.runs[0].id).toBe(revenue.id);

    const secondNba = store.listRunsPage({
      notebookPath: 'notebooks/nba_research.dqlnb',
      limit: 1,
      offset: 1,
    });
	    expect(secondNba.total).toBe(2);
	    expect(secondNba.runs).toHaveLength(1);
	  });

  it('keeps urgent notebook and domain groups visible before bounded group limits', () => {
    for (let index = 0; index < 105; index += 1) {
      const run = store.createRun({
        notebookPath: `notebooks/bulk_${String(index).padStart(3, '0')}.dqlnb`,
        domain: `bulk_${String(index).padStart(3, '0')}`,
        question: `Completed historical research ${index}`,
        generatedSql: 'select 1 as value',
      });
      store.updateRun(run.id, { reviewStatus: 'completed' });
    }
    const urgent = store.createRun({
      notebookPath: 'notebooks/zz_urgent_research.dqlnb',
      domain: 'zz_urgent',
      question: 'This urgent group has no SQL and needs reviewer attention.',
    });

	    const page = store.listRunsPage({ sort: 'priority' });

	    expect(page.domains).toHaveLength(100);
	    expect(page.notebooks).toHaveLength(100);
    expect(page.groupCounts).toMatchObject({
      domains: 106,
      intents: 1,
      notebooks: 106,
    });
	    expect(page.domains[0]).toMatchObject({
	      domain: 'zz_urgent',
      blocked: 1,
      nextAction: 'fix_blockers',
      nextActionCount: 1,
    });
    expect(page.notebooks[0]).toMatchObject({
      path: 'notebooks/zz_urgent_research.dqlnb',
      blocked: 1,
      nextAction: 'fix_blockers',
      nextActionCount: 1,
    });
    expect(page.runs[0].id).toBe(urgent.id);
  });

  it('uses the local search index for SQL, evidence, and duplicate metadata', () => {
    const scoring = store.createRun({
      notebookPath: 'notebooks/nba_research.dqlnb',
      domain: 'nba',
      sourceCellId: 'cell_points',
      sourceCellName: 'scoring_sql',
      sourceCellFingerprint: 'fnv1a:source123',
      question: 'Which players are scoring leaders?',
      generatedSql: 'select player_name, sum(points) as total_points from transformed.int_player_stats group by 1',
    });
    const revenue = store.createRun({
      notebookPath: 'notebooks/revenue_research.dqlnb',
      domain: 'revenue',
      sourceCellName: 'arr_sql',
      question: 'Which accounts changed ARR?',
      generatedSql: 'select account_id, sum(arr) as arr from mart_account_revenue group by 1',
    });

    expect(store.listRunsPage({ search: 'int player stats' }).runs.map((run) => run.id)).toEqual([scoring.id]);

    store.updateRun(scoring.id, {
      reviewedSql: 'select team_id, player_name from transformed.fct_box_score where season = 2017',
      evidence: {
        selectedEvidence: [{
          name: 'MetricFlow total_points',
          reason: 'Semantic metric evidence for NBA player scoring.',
        }],
      },
      dqlPromotion: {
        importId: 'imp_scoring',
        candidateIds: ['cand_scoring'],
        recommendedAction: 'reuse_existing',
        similarityMatches: [{
          kind: 'parameterized_duplicate',
          name: 'Certified NBA scoring leaders',
          score: 0.91,
          reason: 'Same grain and dynamic season filter.',
          recommendedAction: 'reuse_existing',
        }],
        candidates: [],
        createdAt: '2026-06-20T00:00:00.000Z',
      },
    });

    expect(store.listRunsPage({ search: 'box score' }).runs.map((run) => run.id)).toEqual([scoring.id]);
    expect(store.listRunsPage({ search: 'MetricFlow total points' }).runs.map((run) => run.id)).toEqual([scoring.id]);
    expect(store.listRunsPage({ search: 'certified scoring leaders' }).runs.map((run) => run.id)).toEqual([scoring.id]);
    expect(store.listRunsPage({ search: 'source123 leaders' }).runs.map((run) => run.id)).toEqual([scoring.id]);
    expect(store.listRunsPage({ search: 'account revenue' }).runs.map((run) => run.id)).toEqual([revenue.id]);
    expect(store.listRunsPage({ domain: 'nba', search: 'account revenue' }).runs).toEqual([]);

    (store as unknown as { searchIndexAvailable: boolean }).searchIndexAvailable = false;
    expect(store.listRunsPage({ search: 'source123 leaders' }).runs.map((run) => run.id)).toEqual([scoring.id]);
    expect(store.listRunsPage({ search: 'source123 revenue' }).runs).toEqual([]);
  });

  it('finds an existing research run by notebook path and source cell id even when it is not on the first page', () => {
    store.createRun({
      notebookPath: 'notebooks/nba_research.dqlnb',
      sourceCellId: 'cell_first',
      sourceCellName: 'first_sql',
      question: 'What should the first query become?',
    });
    const target = store.createRun({
      notebookPath: 'notebooks/nba_research.dqlnb',
      sourceCellId: 'cell_target',
      sourceCellName: 'target_sql',
      question: 'What should the target query become?',
    });
    store.createRun({
      notebookPath: 'notebooks/other_research.dqlnb',
      sourceCellId: 'cell_target',
      sourceCellName: 'target_sql_other',
      question: 'This matching cell id belongs to another notebook.',
    });

    const firstPage = store.listRunsPage({
      notebookPath: 'notebooks/nba_research.dqlnb',
      limit: 1,
      offset: 0,
    });
    expect(firstPage.total).toBe(2);
    expect(firstPage.runs).toHaveLength(1);

    const sourceLookup = store.listRunsPage({
      notebookPath: 'notebooks/nba_research.dqlnb',
      sourceCellId: 'cell_target',
      limit: 1,
    });
    expect(sourceLookup.total).toBe(1);
    expect(sourceLookup.runs[0].id).toBe(target.id);
  });

  it('returns latest source-cell coverage without loading unrelated research runs', () => {
    const stale = store.createRun({
      notebookPath: 'notebooks/nba_research.dqlnb',
      sourceCellId: 'cell_points',
      sourceCellName: 'points_stale',
      sourceCellFingerprint: 'fnv1a:stale',
      question: 'Old scoring research',
    });
    const current = store.createRun({
      notebookPath: 'notebooks/nba_research.dqlnb',
      sourceCellId: 'cell_points',
      sourceCellName: 'points_current',
      sourceCellFingerprint: 'fnv1a:current',
      question: 'Current scoring research',
    });
    const assists = store.createRun({
      notebookPath: 'notebooks/nba_research.dqlnb',
      sourceCellId: 'cell_assists',
      sourceCellName: 'assists',
      sourceCellFingerprint: 'fnv1a:assists',
      question: 'Assists research',
    });
    store.createRun({
      notebookPath: 'notebooks/other_research.dqlnb',
      sourceCellId: 'cell_points',
      sourceCellName: 'other_points',
      sourceCellFingerprint: 'fnv1a:other',
      question: 'Other notebook scoring research',
    });

    store.updateRun(stale.id, { question: 'Old scoring research kept for history.' });
    store.updateRun(current.id, { question: 'Current scoring research with latest update.' });

    const coverage = store.listLatestRunsBySourceCell({
      notebookPath: 'notebooks/nba_research.dqlnb',
      sourceCellIds: ['cell_assists', 'cell_missing', 'cell_points', 'cell_points'],
    });

    expect(coverage.map((run) => run.id)).toEqual([assists.id, current.id]);
    expect(coverage.map((run) => run.sourceCellId)).toEqual(['cell_assists', 'cell_points']);
    expect(coverage.find((run) => run.sourceCellId === 'cell_points')?.sourceCellFingerprint).toBe('fnv1a:current');
  });

  it('returns latest research runs whose source cells are missing from the notebook', () => {
    const staleMissing = store.createRun({
      notebookPath: 'notebooks/nba_research.dqlnb',
      sourceCellId: 'cell_removed',
      sourceCellName: 'removed_old',
      sourceCellFingerprint: 'fnv1a:removed_old',
      question: 'Old removed source research',
    });
    const currentMissing = store.createRun({
      notebookPath: 'notebooks/nba_research.dqlnb',
      sourceCellId: 'cell_removed',
      sourceCellName: 'removed_current',
      sourceCellFingerprint: 'fnv1a:removed_current',
      question: 'Current removed source research',
    });
    const currentSource = store.createRun({
      notebookPath: 'notebooks/nba_research.dqlnb',
      sourceCellId: 'cell_current',
      sourceCellName: 'current_cell',
      sourceCellFingerprint: 'fnv1a:current',
      question: 'Current source research',
    });
    store.createRun({
      notebookPath: 'notebooks/other_research.dqlnb',
      sourceCellId: 'cell_removed',
      sourceCellName: 'other_removed',
      sourceCellFingerprint: 'fnv1a:other',
      question: 'Other notebook removed research',
    });

    store.updateRun(staleMissing.id, { question: 'Old removed source research kept for history.' });
    store.updateRun(currentMissing.id, { question: 'Current removed source research with latest update.' });

    const missing = store.listLatestRunsForMissingSourceCells({
      notebookPath: 'notebooks/nba_research.dqlnb',
      sourceCellIds: ['cell_current'],
    });

    expect(missing.map((run) => run.id)).toEqual([currentMissing.id]);
    expect(missing[0].sourceCellId).toBe('cell_removed');
    expect(missing[0].sourceCellFingerprint).toBe('fnv1a:removed_current');

    const allMissingWhenNotebookHasNoSourceCells = store.listLatestRunsForMissingSourceCells({
      notebookPath: 'notebooks/nba_research.dqlnb',
      sourceCellIds: [],
    });
    expect(allMissingWhenNotebookHasNoSourceCells.map((run) => run.id).sort()).toEqual([currentMissing.id, currentSource.id].sort());
  });

  it('applies missing-source coverage limits after excluding all current source cells', () => {
    store.createRun({
      notebookPath: 'notebooks/large_research.dqlnb',
      sourceCellId: 'cell_001_current',
      sourceCellName: 'current_one',
      question: 'Current source one',
    });
    store.createRun({
      notebookPath: 'notebooks/large_research.dqlnb',
      sourceCellId: 'cell_002_current',
      sourceCellName: 'current_two',
      question: 'Current source two',
    });
    const missing = store.createRun({
      notebookPath: 'notebooks/large_research.dqlnb',
      sourceCellId: 'cell_003_deleted',
      sourceCellName: 'deleted_source',
      question: 'Deleted source research',
    });

    const result = store.listLatestRunsForMissingSourceCells({
      notebookPath: 'notebooks/large_research.dqlnb',
      sourceCellIds: ['cell_001_current', 'cell_002_current'],
      limit: 1,
    });

    expect(result.map((run) => run.id)).toEqual([missing.id]);
  });

  it('keeps completed and rejected research runs out of the active work queues', () => {
    const completed = store.createRun({
      notebookPath: 'notebooks/nba_research.dqlnb',
      sourceCellId: 'cell_completed',
      question: 'Completed research should not stay in the review queue.',
      generatedSql: 'select 1 as value',
    });
    const rejected = store.createRun({
      notebookPath: 'notebooks/nba_research.dqlnb',
      sourceCellId: 'cell_rejected',
      question: 'Rejected research should not stay in the review queue.',
      generatedSql: 'select 2 as value',
    });
    const certified = store.createRun({
      notebookPath: 'notebooks/nba_research.dqlnb',
      sourceCellId: 'cell_certified',
      question: 'Certified research should be history, not open work.',
      generatedSql: 'select 3 as value',
    });
    const open = store.createRun({
      notebookPath: 'notebooks/nba_research.dqlnb',
      sourceCellId: 'cell_open',
      question: 'Open research should stay in the notebook work queue.',
      generatedSql: 'select 4 as value',
    });

    store.updateRun(completed.id, { reviewStatus: 'completed' });
    store.updateRun(rejected.id, { reviewStatus: 'rejected' });
    store.updateRun(certified.id, { reviewStatus: 'certified' });

    const activeReview = store.listRunsPage({ nextAction: 'review_sql' });
    expect(activeReview.total).toBe(1);
    expect(activeReview.runs.map((run) => run.id)).toEqual([open.id]);
    const activeOnly = store.listRunsPage({ activeOnly: true });
    expect(activeOnly.runs.map((run) => run.id)).toEqual([open.id]);
    expect(activeOnly.counts.nextActions).toMatchObject({
      review_sql: 1,
      continue_review: 0,
    });
    expect(activeOnly.notebooks).toEqual([expect.objectContaining({
      path: 'notebooks/nba_research.dqlnb',
      total: 1,
      nextAction: 'review_sql',
      nextActionCount: 1,
    })]);
    const passive = store.listRunsPage({ nextAction: 'continue_review' });
    expect(passive.total).toBe(3);
    expect(passive.runs.map((run) => run.id).sort()).toEqual([completed.id, rejected.id, certified.id].sort());
    expect(store.listRunsPage({ reviewStatus: 'completed' }).runs.map((run) => run.id)).toEqual([completed.id]);
    expect(store.listRunsPage({ reviewStatus: 'rejected' }).runs.map((run) => run.id)).toEqual([rejected.id]);
    expect(store.listRunsPage({ reviewStatus: 'certified' }).runs.map((run) => run.id)).toEqual([certified.id]);
  });

  it('orders research runs by queue priority before recency when requested', () => {
    const certReady = store.createRun({
      notebookPath: 'notebooks/nba_research.dqlnb',
      context: { selectedDomain: 'nba' },
      question: 'Which player scoring block is ready to certify?',
      reviewedSql: 'select player_name, sum(points) as total_points from player_stats group by 1',
    });
    expect(certReady.domain).toBe('nba');
    store.updateRun(certReady.id, {
      status: 'ready',
      resultPreview: {
        columns: ['player_name', 'total_points'],
        rows: [{ player_name: 'Grant Jerrett', total_points: 357 }],
        rowCount: 1,
      },
      draftBlockPath: 'domains/nba/blocks/_drafts/top-scorers.dql',
      dqlPromotionAction: 'create_new',
      evidence: { selectedEvidence: [{ name: 'player_stats', reason: 'Source table for scoring.' }] },
      contextPackId: 'ctx_cert_ready',
    });

    const draftReady = store.createRun({
      notebookPath: 'notebooks/nba_research.dqlnb',
      question: 'Which player assists block can become a draft?',
      reviewedSql: 'select player_name, sum(assists) as total_assists from player_stats group by 1',
    });

    const blocked = store.createRun({
      notebookPath: 'notebooks/nba_research.dqlnb',
      question: 'Which query still needs SQL?',
    });

    const priorityQueue = store.listRunsPage({ sort: 'priority' });
    expect(priorityQueue.runs.slice(0, 3).map((run) => run.id)).toEqual([blocked.id, draftReady.id, certReady.id]);
    expect(priorityQueue.counts.nextActions).toMatchObject({
      open_certification: 1,
      review_context: 1,
      fix_blockers: 1,
    });
    expect(store.listRunsPage({ nextAction: 'open_certification' }).runs.map((run) => run.id)).toEqual([certReady.id]);
    expect(store.listRunsPage({ nextAction: 'review_context' }).runs.map((run) => run.id)).toEqual([draftReady.id]);
  });

  it('keeps review-required promotion decisions out of certification-ready work', () => {
    const reviewRequired = store.createRun({
      notebookPath: 'notebooks/nba_research.dqlnb',
      question: 'Which player scoring block needs manual duplicate review?',
      reviewedSql: 'select player_name, sum(points) as total_points from player_stats group by 1',
    });
    store.updateRun(reviewRequired.id, {
      status: 'ready',
      resultPreview: {
        columns: ['player_name', 'total_points'],
        rows: [{ player_name: 'Grant Jerrett', total_points: 357 }],
        rowCount: 1,
      },
      draftBlockPath: 'domains/nba/blocks/_drafts/review-required.dql',
      dqlPromotionAction: 'review_required',
      evidence: { selectedEvidence: [{ name: 'player_stats', reason: 'Source table for scoring.' }] },
      contextPackId: 'ctx_review_required',
    });

    expect(store.listRunsPage({ readiness: 'certification_ready' }).runs).toEqual([]);
    expect(store.listRunsPage({ nextAction: 'open_certification' }).runs).toEqual([]);
    expect(store.listRunsPage({ nextAction: 'complete_review' }).runs.map((run) => run.id)).toEqual([reviewRequired.id]);
    expect(store.listRunsPage({ sort: 'priority' }).counts).toMatchObject({
      certificationReady: 0,
      blocked: 0,
    });
  });

  it('seeds draft research runs from notebook cells without duplicating source cells', () => {
    const seeded = store.seedRunsFromCells({
      notebookPath: 'notebooks/nba_research.dqlnb',
      domain: 'nba',
      notebookTitle: 'NBA Research',
      cells: [
        {
          id: 'cell_points',
          name: 'top_players_sql',
          type: 'sql',
          sql: 'select player_name, sum(points) as total_points from player_stats group by 1',
        },
        {
          id: 'cell_assists',
          name: 'top_assists_dql',
          type: 'dql',
          sql: 'select player_name, sum(assists) as total_assists from player_stats group by 1',
          intent: 'driver_breakdown',
        },
        {
          id: 'cell_empty',
          name: 'empty_sql',
          type: 'sql',
          sql: '',
        },
      ],
    });

    expect(seeded.createdCount).toBe(2);
    expect(seeded.skippedCount).toBe(1);
    expect(seeded.limitApplied).toBe(false);
    expect(seeded.created.map((run) => run.sourceCellId)).toEqual(['cell_points', 'cell_assists']);
    expect(seeded.created.map((run) => run.domain)).toEqual(['nba', 'nba']);
    expect(seeded.created[0].sourceCellFingerprint).toMatch(/^fnv1a:[0-9a-f]{8}$/);
    expect(seeded.created[0].question).toContain('top players sql');
    expect(seeded.created[1].intent).toBe('driver_breakdown');
    expect(seeded.created[0].context).toMatchObject({
      notebookTitle: 'NBA Research',
      sourceCell: { id: 'cell_points', name: 'top_players_sql', type: 'sql' },
      selectedDomain: 'nba',
      seededFromNotebook: true,
    });
    expect(store.listRunsPage({ notebookPath: 'notebooks/nba_research.dqlnb' }).counts.sourceLinked).toBe(2);

	    const duplicateSeed = store.seedRunsFromCells({
	      notebookPath: 'notebooks/nba_research.dqlnb',
	      domain: 'nba',
	      cells: [
	        {
	          id: 'cell_points',
	          name: 'top_players_sql',
	          sql: 'select 1',
	        },
	        {
	          id: 'cell_new',
	          name: 'new_query',
	          sql: 'select 2',
	        },
	        {
	          id: 'cell_same_sql',
	          name: 'same_sql_as_new_query',
	          sql: 'select 2',
	        },
	      ],
	    });

	    expect(duplicateSeed.createdCount).toBe(1);
	    expect(duplicateSeed.skippedCount).toBe(2);
	    expect(duplicateSeed.created[0].sourceCellId).toBe('cell_new');
    expect(store.listRunsPage({ notebookPath: 'notebooks/nba_research.dqlnb' }).total).toBe(3);
    expect(store.listRunsPage({ notebookPath: 'notebooks/nba_research.dqlnb' }).counts.sourceLinked).toBe(3);

    const synced = store.updateRun(seeded.created[0].id, {
      reviewedSql: 'select player_name from player_stats',
      sourceCellFingerprint: 'fnv1a:manual123',
    });
    expect(synced?.sourceCellFingerprint).toBe('fnv1a:manual123');

    const standalone = store.updateRun(seeded.created[0].id, {
      sourceCellId: null,
      sourceCellName: null,
      sourceCellFingerprint: null,
      reviewedSql: 'select player_name, sum(points) as total_points from player_stats group by 1',
      warnings: ['Reviewed SQL was kept as standalone evidence.'],
    });
    expect(standalone?.sourceCellId).toBeUndefined();
    expect(standalone?.sourceCellName).toBeUndefined();
    expect(standalone?.sourceCellFingerprint).toBeUndefined();
    expect(standalone?.warnings).toEqual(['Reviewed SQL was kept as standalone evidence.']);
    expect(store.listRunsPage({ notebookPath: 'notebooks/nba_research.dqlnb' }).counts.sourceLinked).toBe(2);
  });

  it('applies a seed cell limit and reports skipped overflow', () => {
    const seeded = store.seedRunsFromCells({
      notebookPath: 'notebooks/large_research.dqlnb',
      cells: [
        { id: 'cell_1', sql: 'select 1', sourceCellFingerprint: 'fnv1a:provided1' },
        { id: 'cell_2', sql: 'select 2' },
        { id: 'cell_3', sql: 'select 3' },
      ],
      limit: 2,
    });

    expect(seeded.createdCount).toBe(2);
    expect(seeded.skippedCount).toBe(1);
    expect(seeded.limitApplied).toBe(true);
    expect(seeded.created[0].sourceCellFingerprint).toBe('fnv1a:provided1');
    expect(store.listRunsPage({ notebookPath: 'notebooks/large_research.dqlnb' }).total).toBe(2);
  });
});
