import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest, parse } from '@duckcodeailabs/dql-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { propose } from './propose.js';

/**
 * Small synthetic dbt project: a staging model, a customer dimension, an orders
 * fact (with measures + time), and a daily-revenue aggregate referenced by an
 * exposure. catalog.json adds warehouse types; run_results.json adds run counts.
 */
function writeDbtArtifacts(targetDir: string): string {
  mkdirSync(targetDir, { recursive: true });

  const manifest = {
    metadata: { project_name: 'jaffle_shop' },
    nodes: {
      'model.jaffle_shop.stg_orders': {
        resource_type: 'model',
        name: 'stg_orders',
        schema: 'staging',
        database: 'analytics',
        description: '',
        original_file_path: 'models/staging/stg_orders.sql',
        config: { materialized: 'view' },
        tags: [],
        depends_on: { nodes: ['source.jaffle_shop.raw.orders'] },
        columns: { order_id: { name: 'order_id' } },
        meta: {},
      },
      'model.jaffle_shop.dim_customers': {
        resource_type: 'model',
        name: 'dim_customers',
        schema: 'marts',
        database: 'analytics',
        description: 'One row per customer with lifetime attributes.',
        original_file_path: 'models/marts/dim_customers.sql',
        config: { materialized: 'table' },
        tags: ['core'],
        depends_on: { nodes: ['model.jaffle_shop.stg_orders'] },
        columns: {
          customer_id: { name: 'customer_id', description: 'Customer surrogate key.' },
          customer_name: { name: 'customer_name' },
        },
        meta: {},
      },
      'model.jaffle_shop.fct_orders': {
        resource_type: 'model',
        name: 'fct_orders',
        schema: 'marts',
        database: 'analytics',
        description: 'Order-grain fact with amounts.',
        original_file_path: 'models/marts/fct_orders.sql',
        config: { materialized: 'table' },
        tags: ['core'],
        depends_on: {
          nodes: ['model.jaffle_shop.stg_orders', 'model.jaffle_shop.dim_customers'],
        },
        columns: {
          order_id: { name: 'order_id' },
          order_date: { name: 'order_date' },
          amount: { name: 'amount' },
        },
        meta: {},
      },
      'model.jaffle_shop.agg_daily_revenue': {
        resource_type: 'model',
        name: 'agg_daily_revenue',
        schema: 'marts',
        database: 'analytics',
        description: 'Daily revenue rollup.',
        original_file_path: 'models/marts/agg_daily_revenue.sql',
        config: { materialized: 'table' },
        tags: [],
        depends_on: { nodes: ['model.jaffle_shop.fct_orders'] },
        columns: {
          revenue_date: { name: 'revenue_date' },
          total_revenue: { name: 'total_revenue' },
        },
        meta: {},
      },
    },
    sources: {
      'source.jaffle_shop.raw.orders': {
        name: 'orders',
        identifier: 'orders',
        schema: 'raw',
        database: 'analytics',
        tags: [],
      },
    },
    exposures: {
      'exposure.jaffle_shop.exec_dashboard': {
        name: 'exec_dashboard',
        depends_on: { nodes: ['model.jaffle_shop.agg_daily_revenue'] },
      },
    },
  };
  writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');

  const catalog = {
    nodes: {
      'model.jaffle_shop.dim_customers': {
        columns: {
          customer_id: { name: 'customer_id', type: 'INTEGER' },
          customer_name: { name: 'customer_name', type: 'VARCHAR' },
        },
      },
      'model.jaffle_shop.fct_orders': {
        columns: {
          order_id: { name: 'order_id', type: 'INTEGER' },
          order_date: { name: 'order_date', type: 'DATE' },
          amount: { name: 'amount', type: 'DECIMAL' },
        },
      },
    },
  };
  writeFileSync(join(targetDir, 'catalog.json'), JSON.stringify(catalog), 'utf-8');

  const runResults = {
    results: [
      { unique_id: 'model.jaffle_shop.fct_orders' },
      { unique_id: 'model.jaffle_shop.fct_orders' },
      { unique_id: 'model.jaffle_shop.agg_daily_revenue' },
    ],
  };
  writeFileSync(join(targetDir, 'run_results.json'), JSON.stringify(runResults), 'utf-8');

  return join(targetDir, 'manifest.json');
}

describe('dql propose engine', () => {
  let projectRoot: string;
  let manifestPath: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-propose-'));
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'p' }), 'utf-8');
    manifestPath = writeDbtArtifacts(join(projectRoot, 'target'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('proposes a ranked queue of parseable DRAFT blocks from dbt evidence', () => {
    const summary = propose({ projectRoot, dbtManifestPath: manifestPath, owner: 'me@example.com' });

    expect(summary.projectName).toBe('jaffle_shop');
    expect(summary.modelsScanned).toBe(4);
    expect(summary.draftsWritten).toBe(4);

    // Every written draft is valid DQL and lands in a draft folder.
    for (const proposal of summary.proposals) {
      expect(proposal.path).toBeDefined();
      expect(proposal.path).toContain('_drafts/');
      const source = readFileSync(join(projectRoot, proposal.path!), 'utf-8');
      expect(() => parse(source)).not.toThrow();
    }

    // The whole project still parses with no parse diagnostics.
    const manifest = buildManifest({ projectRoot, dqlVersion: 'test' });
    expect(manifest.diagnostics?.filter((d) => d.kind === 'parse')).toEqual([]);

    // Ranking: exposure-linked + downstream models outrank staging.
    const order = summary.proposals.map((p) => p.model);
    expect(order.indexOf('fct_orders')).toBeLessThan(order.indexOf('stg_orders'));
    expect(order.indexOf('dim_customers')).toBeLessThan(order.indexOf('stg_orders'));
    const agg = summary.proposals.find((p) => p.model === 'agg_daily_revenue')!;
    expect(agg.ranking.exposureLinked).toBe(true);
    expect(agg.ranking.runCount).toBe(1);
  });

  it('infers conservative grain / pattern / outputs and stores certifier results', () => {
    const summary = propose({ projectRoot, dbtManifestPath: manifestPath });

    const dim = summary.proposals.find((p) => p.model === 'dim_customers')!;
    expect(dim.inference.grain).toBe('customer_id');
    expect(dim.inference.pattern).toBe('entity_profile');
    expect(dim.inference.declaredOutputs).toEqual(['customer_id', 'customer_name']);
    expect(dim.inference.invariants).toContain('row_count >= 0');

    const fct = summary.proposals.find((p) => p.model === 'fct_orders')!;
    expect(fct.inference.grain).toBe('order_id');
    expect(fct.inference.pattern).toBe('entity_rollup');
    // catalog.json supplies the typed column set.
    expect(fct.inference.declaredOutputs).toEqual(['order_id', 'order_date', 'amount']);

    const agg = summary.proposals.find((p) => p.model === 'agg_daily_revenue')!;
    // No single id column → no grain → trend (time + measure).
    expect(agg.inference.grain).toBeUndefined();
    expect(agg.inference.pattern).toBe('trend');

    // Every proposal carries a stored, NON-certified verdict with details.
    for (const proposal of summary.proposals) {
      expect(proposal.certification.certified).toBe(false);
    }
  });

  it('NEVER writes a certified block — all drafts are status="draft"', () => {
    propose({ projectRoot, dbtManifestPath: manifestPath });

    for (const model of ['dim_customers', 'fct_orders', 'agg_daily_revenue', 'stg_orders']) {
      const path = join(projectRoot, 'blocks', '_drafts', `${model}.dql`);
      const source = readFileSync(path, 'utf-8');
      expect(source).toContain('status = "draft"');
      expect(source).not.toContain('status = "certified"');
      expect(source).toContain('NOT certified');
    }
  });

  it('is idempotent — re-running writes nothing new and never duplicates', () => {
    const first = propose({ projectRoot, dbtManifestPath: manifestPath });
    expect(first.draftsWritten).toBe(4);

    const second = propose({ projectRoot, dbtManifestPath: manifestPath });
    expect(second.draftsWritten).toBe(0);
    expect(second.draftsSkipped).toBe(4);
    for (const proposal of second.proposals) {
      expect(proposal.skipped).toBeDefined();
    }
  });

  it('does not re-propose a model the human already promoted to a canonical path', () => {
    // Simulate a reviewer certifying dim_customers into blocks/dim_customers.dql.
    propose({ projectRoot, dbtManifestPath: manifestPath });
    rmSync(join(projectRoot, 'blocks', '_drafts', 'dim_customers.dql'));
    writeFileSync(join(projectRoot, 'blocks', 'dim_customers.dql'), '// promoted', 'utf-8');

    const rerun = propose({ projectRoot, dbtManifestPath: manifestPath });
    const dim = rerun.proposals.find((p) => p.model === 'dim_customers')!;
    expect(dim.skipped).toBeDefined();
    // The promoted file is untouched.
    expect(readFileSync(join(projectRoot, 'blocks', 'dim_customers.dql'), 'utf-8')).toBe('// promoted');
  });

  it('writes drafts under the domain-first folder when a matching domain dir exists', () => {
    // A model whose meta.domain is explicit and matches an existing domain dir
    // must land under domains/<domain>/blocks/_drafts/.
    const targetDir = join(projectRoot, 'target');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    manifest.nodes['model.jaffle_shop.dim_customers'].meta = { domain: 'finance' };
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8');
    void targetDir;
    mkdirSync(join(projectRoot, 'domains', 'finance'), { recursive: true });

    const summary = propose({ projectRoot, dbtManifestPath: manifestPath });
    const dim = summary.proposals.find((p) => p.model === 'dim_customers')!;
    expect(dim.domain).toBe('finance');
    expect(dim.path).toBe('domains/finance/blocks/_drafts/dim_customers.dql');
    expect(existsSync(join(projectRoot, dim.path!))).toBe(true);
  });

  it('honors --limit and dry-run', () => {
    const dry = propose({ projectRoot, dbtManifestPath: manifestPath, dryRun: true });
    expect(dry.draftsWritten).toBe(4); // "would write" count
    // Nothing actually on disk.
    expect(existsSync(join(projectRoot, 'blocks', '_drafts'))).toBe(false);

    const limited = propose({ projectRoot, dbtManifestPath: manifestPath, limit: 2 });
    expect(limited.draftsWritten).toBe(2);
    expect(limited.draftsSkipped).toBe(2);
  });
});
