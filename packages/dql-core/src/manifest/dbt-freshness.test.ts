import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest } from './builder.js';
import { loadDbtRunState, applyBlockDataState } from './dbt-freshness.js';
import type { ManifestBlock, ManifestSource } from './types.js';

/**
 * Freshness-aware trust: a certified block's effective `dataState` is the worst
 * health of its transitive dbt upstreams, read READ-ONLY from `run_results.json`.
 */
describe('dbt freshness — block dataState from run_results', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dql-freshness-'));
    writeFileSync(join(tmpDir, 'dql.config.json'), JSON.stringify({ project: 'demo' }));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * A block that reads dbt model `orders`, which depends on `orders_raw`.
   * Both live in the dbt manifest; run_results status is parameterized per test.
   */
  function writeProject(opts: {
    ordersStatus?: string;
    stgStatus?: string;
    /** When false, omit run_results.json entirely (degrade to unknown). */
    runResults?: boolean;
  }): string {
    mkdirSync(join(tmpDir, 'blocks'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'blocks', 'orders.dql'),
      `block "Orders" {
  domain = "sales"
  type = "custom"
  status = "certified"
  query = """
    SELECT * FROM orders
  """
}`,
    );

    const target = join(tmpDir, 'target');
    mkdirSync(target, { recursive: true });
    const manifest = {
      nodes: {
        'model.demo.orders': {
          resource_type: 'model',
          name: 'orders',
          alias: 'orders',
          schema: 'public',
          database: 'db',
          depends_on: { nodes: ['model.demo.orders_raw'] },
          tags: [],
          original_file_path: 'models/marts/orders.sql',
          config: { materialized: 'table' },
        },
        'model.demo.orders_raw': {
          resource_type: 'model',
          name: 'orders_raw',
          alias: 'orders_raw',
          schema: 'public',
          database: 'db',
          depends_on: { nodes: [] },
          tags: [],
          original_file_path: 'models/staging/orders_raw.sql',
        },
      },
      sources: {},
      metadata: { project_name: 'demo' },
    };
    const manifestPath = join(target, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8');

    if (opts.runResults !== false) {
      const runResults = {
        metadata: { generated_at: '2026-06-26T10:00:00Z' },
        results: [
          {
            unique_id: 'model.demo.orders',
            status: opts.ordersStatus ?? 'success',
            timing: [{ name: 'execute', completed_at: '2026-06-26T09:59:00Z' }],
          },
          {
            unique_id: 'model.demo.orders_raw',
            status: opts.stgStatus ?? 'success',
            timing: [{ name: 'execute', completed_at: '2026-06-26T09:58:00Z' }],
          },
        ],
      };
      writeFileSync(join(target, 'run_results.json'), JSON.stringify(runResults), 'utf-8');
    }

    return manifestPath;
  }

  it('fresh upstreams → block dataState "fresh" (unaffected, "Certified")', () => {
    const dbtManifestPath = writeProject({});
    const manifest = buildManifest({ projectRoot: tmpDir, dbtManifestPath });
    expect(manifest.blocks['Orders'].dataState).toBe('fresh');
  });

  it('a FAILED last run on a transitive upstream → block dataState "failed"', () => {
    // The block reads `orders`, which depends on `orders_raw`; failing the
    // staging model must roll up through the DAG to the block.
    const dbtManifestPath = writeProject({ stgStatus: 'error' });
    const manifest = buildManifest({ projectRoot: tmpDir, dbtManifestPath });
    expect(manifest.blocks['Orders'].dataState).toBe('failed');
    expect(manifest.blocks['Orders'].dataStateDetail).toMatch(/failed/i);
  });

  it('a directly-referenced model that failed → block dataState "failed"', () => {
    const dbtManifestPath = writeProject({ ordersStatus: 'error' });
    const manifest = buildManifest({ projectRoot: tmpDir, dbtManifestPath });
    expect(manifest.blocks['Orders'].dataState).toBe('failed');
  });

  it('no run_results.json → dataState undefined (degrades to "unknown")', () => {
    const dbtManifestPath = writeProject({ runResults: false });
    const manifest = buildManifest({ projectRoot: tmpDir, dbtManifestPath });
    expect(manifest.blocks['Orders'].dataState).toBeUndefined();
    expect(manifest.dbtImport?.runResultsPath).toBeUndefined();
  });

  it('attaches runState to imported dbt model sources', () => {
    const dbtManifestPath = writeProject({ ordersStatus: 'error' });
    const manifest = buildManifest({ projectRoot: tmpDir, dbtManifestPath });
    expect(manifest.sources['orders']?.dbtModel?.runState?.dataState).toBe('failed');
    expect(manifest.sources['orders']?.dbtModel?.runState?.lastRunStatus).toBe('error');
    expect(manifest.dbtImport?.runResultsPath).toContain('run_results.json');
  });

  it('disambiguates a mart from a colliding staging model (stg_orders → orders)', () => {
    // Standard dbt layout: a `stg_orders` staging model and an `orders` mart.
    // dbt role-prefix stripping makes both claim the lookup key `orders`; the
    // selective importer must still anchor a block referencing `orders` to the
    // mart (exact name) and import it — otherwise 0 models import and freshness
    // never surfaces (the real-world bug this guards against).
    mkdirSync(join(tmpDir, 'blocks'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'blocks', 'orders.dql'),
      `block "Orders" {
  domain = "sales"
  type = "custom"
  status = "certified"
  query = """
    SELECT * FROM orders
  """
}`,
    );
    const target = join(tmpDir, 'target');
    mkdirSync(target, { recursive: true });
    const manifest = {
      nodes: {
        'model.demo.orders': {
          resource_type: 'model', name: 'orders', alias: 'orders', schema: 'dev', database: 'db',
          depends_on: { nodes: ['model.demo.stg_orders'] }, tags: [],
        },
        'model.demo.stg_orders': {
          resource_type: 'model', name: 'stg_orders', alias: 'stg_orders', schema: 'dev', database: 'db',
          depends_on: { nodes: [] }, tags: [],
        },
      },
      sources: {},
      metadata: { project_name: 'demo' },
    };
    const manifestPath = join(target, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8');
    writeFileSync(
      join(target, 'run_results.json'),
      JSON.stringify({
        metadata: { generated_at: '2026-06-26T10:00:00Z' },
        results: [
          { unique_id: 'model.demo.orders', status: 'success', timing: [{ name: 'execute', completed_at: '2026-06-26T09:59:00Z' }] },
          { unique_id: 'model.demo.stg_orders', status: 'success', timing: [{ name: 'execute', completed_at: '2026-06-26T09:58:00Z' }] },
        ],
      }),
      'utf-8',
    );

    const result = buildManifest({ projectRoot: tmpDir, dbtManifestPath: manifestPath });
    expect(result.dbtImport?.modelsImported ?? 0).toBeGreaterThan(0);
    expect(result.blocks['Orders'].dataState).toBe('fresh');
  });
});

/** Source-freshness ("dbt source freshness" → sources.json) maps to "stale". */
describe('dbt freshness — source freshness → stale', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dql-srcfresh-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a source-freshness "warn" verdict marks the node stale', () => {
    const target = join(tmpDir, 'target');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'manifest.json'), '{}');
    writeFileSync(
      join(target, 'run_results.json'),
      JSON.stringify({
        metadata: { generated_at: '2026-06-26T10:00:00Z' },
        results: [{ unique_id: 'source.demo.raw.events', status: 'success' }],
      }),
    );
    writeFileSync(
      join(target, 'sources.json'),
      JSON.stringify({
        results: [
          {
            unique_id: 'source.demo.raw.events',
            status: 'warn',
            max_loaded_at: '2026-06-20T00:00:00Z',
          },
        ],
      }),
    );

    const index = loadDbtRunState(join(target, 'manifest.json'));
    const state = index.byUniqueId.get('source.demo.raw.events');
    expect(state?.dataState).toBe('stale');
    expect(state?.freshnessStatus).toBe('warn');
  });
});

/** Direct rollup unit test, decoupled from the dbt manifest parser. */
describe('applyBlockDataState — transitive rollup', () => {
  it('rolls the worst transitive upstream state onto the block', () => {
    const blocks: Record<string, ManifestBlock> = {
      Orders: {
        name: 'Orders',
        filePath: 'blocks/orders.dql',
        status: 'certified',
        sql: '',
        rawTableRefs: [],
        tableDependencies: ['orders'],
        refDependencies: [],
        allDependencies: ['orders'],
        tests: [],
      },
    };
    const sources: Record<string, ManifestSource> = {
      orders: {
        name: 'orders',
        origin: 'dbt',
        referencedBy: ['block:Orders'],
        dbtModel: { uniqueId: 'model.demo.orders' },
      },
      orders_raw: {
        name: 'orders_raw',
        origin: 'dbt',
        referencedBy: [],
        dbtModel: { uniqueId: 'model.demo.orders_raw' },
      },
    };
    const dbtDag = {
      models: [
        { uniqueId: 'model.demo.orders' },
        { uniqueId: 'model.demo.orders_raw' },
      ],
      edges: [{ source: 'model.demo.orders_raw', target: 'model.demo.orders' }],
    };
    const runState = {
      byUniqueId: new Map([
        ['model.demo.orders', { dataState: 'fresh' as const, lastRunStatus: 'success' }],
        ['model.demo.orders_raw', { dataState: 'failed' as const, lastRunStatus: 'error' }],
      ]),
      runResultsPath: '/tmp/run_results.json',
    };

    applyBlockDataState(blocks, sources, dbtDag, runState);
    expect(blocks['Orders'].dataState).toBe('failed');
  });

  it('does nothing when run_results were not read (empty index)', () => {
    const blocks: Record<string, ManifestBlock> = {
      Orders: {
        name: 'Orders',
        filePath: 'blocks/orders.dql',
        status: 'certified',
        sql: '',
        rawTableRefs: [],
        tableDependencies: ['orders'],
        refDependencies: [],
        allDependencies: ['orders'],
        tests: [],
      },
    };
    applyBlockDataState(blocks, {}, undefined, { byUniqueId: new Map() });
    expect(blocks['Orders'].dataState).toBeUndefined();
  });

  it('resolves a schema-qualified block ref (dev.orders) to a bare-named dbt model source', () => {
    // Real dbt projects: blocks reference `dev.orders` (schema-qualified) while
    // the imported dbt model source is named bare `orders`. The dbtModel schema
    // must be used to index the schema-qualified alias so the block resolves.
    const blocks: Record<string, ManifestBlock> = {
      Orders: {
        name: 'Orders', filePath: 'blocks/orders.dql', status: 'certified', sql: '',
        rawTableRefs: [], tableDependencies: ['dev.orders'], refDependencies: [],
        allDependencies: ['dev.orders'], tests: [],
      },
    };
    const sources: Record<string, ManifestSource> = {
      orders: {
        name: 'orders', origin: 'dbt', referencedBy: ['block:Orders'],
        dbtModel: { uniqueId: 'model.demo.orders', schema: 'dev', database: 'db' },
      },
    };
    const dbtDag = { models: [{ uniqueId: 'model.demo.orders' }], edges: [] };
    const runState = {
      byUniqueId: new Map([['model.demo.orders', { dataState: 'failed' as const, lastRunStatus: 'error' }]]),
      runResultsPath: '/tmp/run_results.json',
    };
    applyBlockDataState(blocks, sources, dbtDag, runState);
    expect(blocks['Orders'].dataState).toBe('failed');
  });

  it('upstream nodes with no run record are neutral (do not drag a fresh block to "unknown")', () => {
    // `orders` (fresh) depends on a raw source that has NO run_results entry —
    // sources never "run". The block must stay "fresh", not become "unknown".
    const blocks: Record<string, ManifestBlock> = {
      Orders: {
        name: 'Orders', filePath: 'blocks/orders.dql', status: 'certified', sql: '',
        rawTableRefs: [], tableDependencies: ['orders'], refDependencies: [],
        allDependencies: ['orders'], tests: [],
      },
    };
    const sources: Record<string, ManifestSource> = {
      orders: { name: 'orders', origin: 'dbt', referencedBy: ['block:Orders'], dbtModel: { uniqueId: 'model.demo.orders' } },
    };
    const dbtDag = {
      models: [{ uniqueId: 'model.demo.orders' }, { uniqueId: 'source.demo.raw.orders' }],
      edges: [{ source: 'source.demo.raw.orders', target: 'model.demo.orders' }],
    };
    const runState = {
      // Only the model has a run record; the raw source does not.
      byUniqueId: new Map([['model.demo.orders', { dataState: 'fresh' as const, lastRunStatus: 'success' }]]),
      runResultsPath: '/tmp/run_results.json',
    };
    applyBlockDataState(blocks, sources, dbtDag, runState);
    expect(blocks['Orders'].dataState).toBe('fresh');
  });
});
