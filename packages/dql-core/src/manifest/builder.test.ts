import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest, collectInputFiles, resolveDataLexManifestPath } from './builder.js';

describe('collectInputFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dql-inputs-'));
    writeFileSync(join(tmpDir, 'dql.config.json'), '{"project":"demo"}');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns config + blocks + notebooks + semantic YAML + dbt manifest, sorted', () => {
    mkdirSync(join(tmpDir, 'blocks'), { recursive: true });
    mkdirSync(join(tmpDir, 'business-views'), { recursive: true });
    mkdirSync(join(tmpDir, 'domains', 'customer'), { recursive: true });
    mkdirSync(join(tmpDir, 'domains', 'customer', 'apps', 'customer-360', 'dashboards'), { recursive: true });
    mkdirSync(join(tmpDir, 'notebooks'), { recursive: true });
    mkdirSync(join(tmpDir, 'semantic-layer', 'metrics'), { recursive: true });
    mkdirSync(join(tmpDir, 'target'), { recursive: true });

    writeFileSync(join(tmpDir, 'blocks', 'a.dql'), 'block a {}');
    writeFileSync(join(tmpDir, 'business-views', 'customer_360.dql'), 'business_view "Customer 360" { includes { block "Customer" } }');
    writeFileSync(join(tmpDir, 'domains', 'customer', 'domain.dql'), 'domain "Customer" { owner = "analytics" }');
    writeFileSync(join(tmpDir, 'domains', 'customer', 'apps', 'customer-360', 'dql.app.json'), '{}');
    writeFileSync(join(tmpDir, 'domains', 'customer', 'apps', 'customer-360', 'dashboards', 'overview.dqld'), '{}');
    writeFileSync(join(tmpDir, 'notebooks', 'x.dqlnb'), '{"version":1,"cells":[]}');
    writeFileSync(join(tmpDir, 'semantic-layer', 'metrics', 'revenue.yaml'), 'name: revenue');
    writeFileSync(join(tmpDir, 'target', 'manifest.json'), '{}');

    const files = collectInputFiles({
      projectRoot: tmpDir,
      dbtManifestPath: join(tmpDir, 'target', 'manifest.json'),
    });

    // All expected files appear
    expect(files).toContain(join(tmpDir, 'dql.config.json'));
    expect(files).toContain(join(tmpDir, 'blocks', 'a.dql'));
    expect(files).toContain(join(tmpDir, 'business-views', 'customer_360.dql'));
    expect(files).toContain(join(tmpDir, 'domains', 'customer', 'domain.dql'));
    expect(files).toContain(join(tmpDir, 'domains', 'customer', 'apps', 'customer-360', 'dql.app.json'));
    expect(files).toContain(join(tmpDir, 'domains', 'customer', 'apps', 'customer-360', 'dashboards', 'overview.dqld'));
    expect(files).toContain(join(tmpDir, 'notebooks', 'x.dqlnb'));
    expect(files).toContain(join(tmpDir, 'semantic-layer', 'metrics', 'revenue.yaml'));
    expect(files).toContain(join(tmpDir, 'target', 'manifest.json'));

    // Sorted
    expect(files).toEqual([...files].sort());
  });

  it('tracks configured DataLex manifest files', () => {
    const manifestPath = join(tmpDir, 'datalex-manifest.json');
    writeFileSync(manifestPath, JSON.stringify({
      manifestSpecVersion: '1.0.0',
      datalexVersion: '1.10.0',
      generatedAt: '2026-06-01T00:00:00Z',
      project: { name: 'demo' },
      domains: [],
    }));
    writeFileSync(join(tmpDir, 'dql.config.json'), JSON.stringify({
      project: 'demo',
      datalex: { manifestPath: 'datalex-manifest.json' },
    }));

    expect(resolveDataLexManifestPath(tmpDir)).toBe(manifestPath);
    expect(collectInputFiles({ projectRoot: tmpDir })).toContain(manifestPath);
  });

  it('omits missing paths without erroring', () => {
    const files = collectInputFiles({ projectRoot: tmpDir });
    // Only the config was created; no blocks/notebooks dirs
    expect(files).toEqual([join(tmpDir, 'dql.config.json')]);
  });
});

describe('buildManifest DataLex contract validation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dql-datalex-'));
    mkdirSync(join(tmpDir, 'blocks'), { recursive: true });
    writeFileSync(join(tmpDir, 'dql.config.json'), JSON.stringify({
      project: 'demo',
      datalex: { manifestPath: 'datalex-manifest.json' },
    }));
    writeFileSync(join(tmpDir, 'datalex-manifest.json'), JSON.stringify({
      manifestSpecVersion: '1.0.0',
      datalexVersion: '1.10.0',
      generatedAt: '2026-06-01T00:00:00Z',
      project: { name: 'demo' },
      domains: [{
        name: 'commerce',
        entities: [{
          name: 'Customer',
          contracts: [{
            id: 'commerce.Customer.monthly_active_customers',
            name: 'monthly_active_customers',
            version: 1,
          }],
        }],
      }],
    }));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes certified blocks with known DataLex contracts', () => {
    writeFileSync(join(tmpDir, 'blocks', 'mac.dql'), `
      block "Monthly Active Customers" {
        domain = "commerce"
        type = "custom"
        status = "certified"
        datalex_contract = "commerce.Customer.monthly_active_customers@1"
        query = """SELECT 1"""
      }
    `);

    const manifest = buildManifest({ projectRoot: tmpDir });
    expect((manifest.diagnostics ?? []).filter((d) => d.message.includes('datalex_contract'))).toEqual([]);
  });

  it('emits an error for certified blocks with missing DataLex contracts', () => {
    writeFileSync(join(tmpDir, 'blocks', 'bad.dql'), `
      block "Bad Contract" {
        domain = "commerce"
        type = "custom"
        status = "certified"
        datalex_contract = "commerce.Customer.does_not_exist@1"
        query = """SELECT 1"""
      }
    `);

    const manifest = buildManifest({ projectRoot: tmpDir });
    expect((manifest.diagnostics ?? []).some((d) =>
      d.severity === 'error' && d.message.includes('not found'),
    )).toBe(true);
  });
});

describe('buildManifest dbt import filters', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dql-filters-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Build a dbt manifest with models a→b→c plus unrelated d. */
  function writeDbtFixture(): string {
    const target = join(tmpDir, 'target');
    mkdirSync(target, { recursive: true });
    const manifest = {
      nodes: {
        'model.demo.a': {
          resource_type: 'model',
          name: 'a',
          alias: 'a',
          schema: 'public',
          database: 'db',
          depends_on: { nodes: ['model.demo.b'] },
          tags: ['core'],
          original_file_path: 'models/marts/a.sql',
          config: { materialized: 'table' },
        },
        'model.demo.b': {
          resource_type: 'model',
          name: 'b',
          alias: 'b',
          schema: 'public',
          database: 'db',
          depends_on: { nodes: ['model.demo.c'] },
          tags: ['staging'],
          original_file_path: 'models/staging/b.sql',
        },
        'model.demo.c': {
          resource_type: 'model',
          name: 'c',
          alias: 'c',
          schema: 'raw',
          database: 'db',
          depends_on: { nodes: [] },
          tags: [],
          original_file_path: 'models/staging/c.sql',
        },
        'model.demo.d': {
          resource_type: 'model',
          name: 'd',
          alias: 'd',
          schema: 'public',
          database: 'db',
          depends_on: { nodes: [] },
          tags: ['unrelated'],
          original_file_path: 'models/misc/d.sql',
        },
        'model.demo.src_sales': {
          resource_type: 'model',
          name: 'src_sales',
          alias: 'src_sales',
          schema: 'raw',
          database: 'warehouse',
          depends_on: { nodes: [] },
          tags: [],
          original_file_path: 'models/sources/src_sales.sql',
        },
      },
      sources: {},
      metadata: { project_name: 'demo' },
    };
    const path = join(target, 'manifest.json');
    writeFileSync(path, JSON.stringify(manifest), 'utf-8');
    return path;
  }

  function writeProject(): void {
    writeFileSync(join(tmpDir, 'dql.config.json'), JSON.stringify({ project: 'demo' }));
  }

  it('anchors drive an upstream BFS when DQL references none of the models', () => {
    writeProject();
    const dbtManifestPath = writeDbtFixture();

    const manifest = buildManifest({
      projectRoot: tmpDir,
      dbtManifestPath,
      dbtImportFilters: { anchors: ['a'] },
    });

    const names = (manifest.dbtImport?.dbtDag?.models ?? []).map((m) => m.name).sort();
    // Anchor a + its upstream b, c. d is unrelated and excluded.
    expect(names).toEqual(['a', 'b', 'c']);
  });

  it('tag: anchors expand to all models carrying that tag', () => {
    writeProject();
    const dbtManifestPath = writeDbtFixture();

    const manifest = buildManifest({
      projectRoot: tmpDir,
      dbtManifestPath,
      dbtImportFilters: { anchors: ['tag:core'] },
    });

    const names = (manifest.dbtImport?.dbtDag?.models ?? []).map((m) => m.name).sort();
    // "core"-tagged a anchors the BFS; b and c come along upstream.
    expect(names).toEqual(['a', 'b', 'c']);
  });

  it('exclude removes matching non-anchor nodes from the selection', () => {
    writeProject();
    const dbtManifestPath = writeDbtFixture();

    const manifest = buildManifest({
      projectRoot: tmpDir,
      dbtManifestPath,
      dbtImportFilters: {
        anchors: ['a'],
        exclude: ['path:models/staging/'],
      },
    });

    const names = (manifest.dbtImport?.dbtDag?.models ?? []).map((m) => m.name).sort();
    // Anchor a preserved; b and c in staging/ are removed.
    expect(names).toEqual(['a']);
  });

  it('include narrows to matching nodes, keeping anchors', () => {
    writeProject();
    const dbtManifestPath = writeDbtFixture();

    const manifest = buildManifest({
      projectRoot: tmpDir,
      dbtManifestPath,
      dbtImportFilters: {
        anchors: ['a'],
        include: ['tag:core'],
      },
    });

    const names = (manifest.dbtImport?.dbtDag?.models ?? []).map((m) => m.name).sort();
    // Only 'a' carries tag:core. BFS brought in b,c but include filter drops them.
    expect(names).toEqual(['a']);
  });

  it('reads dbtImport filters from dql.config.json when options omit them', () => {
    writeFileSync(
      join(tmpDir, 'dql.config.json'),
      JSON.stringify({
        project: 'demo',
        dbtImport: { anchors: ['a'], exclude: ['path:models/staging/'] },
      }),
    );
    const dbtManifestPath = writeDbtFixture();

    const manifest = buildManifest({ projectRoot: tmpDir, dbtManifestPath });
    const names = (manifest.dbtImport?.dbtDag?.models ?? []).map((m) => m.name).sort();
    expect(names).toEqual(['a']);
  });

  it('anchors dbt models from fully qualified warehouse refs and dbt role-prefix aliases', () => {
    writeProject();
    mkdirSync(join(tmpDir, 'blocks'), { recursive: true });
    writeFileSync(join(tmpDir, 'blocks', 'sales.dql'), `block "Sales" {
  domain = "sales"
  type = "custom"
  query = """
    SELECT *
    FROM WAREHOUSE.RAW.sales
  """
}`);
    const dbtManifestPath = writeDbtFixture();

    const manifest = buildManifest({ projectRoot: tmpDir, dbtManifestPath });
    const names = (manifest.dbtImport?.dbtDag?.models ?? []).map((m) => m.name).sort();

    expect(names).toEqual(['src_sales']);
  });
});

describe('buildManifest block extraction', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dql-manifest-blocks-'));
    writeFileSync(join(tmpDir, 'dql.config.json'), JSON.stringify({ project: 'demo' }));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('compiles domain-first folders with domain declarations and block contract metadata', () => {
    mkdirSync(join(tmpDir, 'domains', 'customer', 'blocks'), { recursive: true });
    mkdirSync(join(tmpDir, 'domains', 'customer', 'terms'), { recursive: true });
    mkdirSync(join(tmpDir, 'domains', 'customer', 'views'), { recursive: true });
    writeFileSync(join(tmpDir, 'domains', 'customer', 'domain.dql'), `domain "Customer" {
  owner = "customer-analytics"
  businessOwner = "Customer Success"
  boundedContext = "Customer identity and lifecycle"
  sourceSystems = ["crm", "orders"]
  primaryTerms = ["Customer"]
  reviewCadence = "monthly"
  tags = ["customer"]
}`);
    writeFileSync(join(tmpDir, 'domains', 'customer', 'terms', 'customer.dql'), `term "Customer" {
  domain = "Customer"
  type = "entity"
  owner = "customer-analytics"
  identifiers = ["customer_id"]
}`);
    writeFileSync(join(tmpDir, 'domains', 'customer', 'blocks', 'orders_rollup.dql'), `block "Customer Orders Rollup" {
  domain = "Customer"
  type = "custom"
  status = "draft"
  owner = "customer-analytics"
  pattern = "entity_rollup"
  grain = "customer_id"
  entities = ["Customer"]
  terms = ["Customer"]
  outputs = ["customer_id", "total_orders"]
  dimensions = ["segment"]
  allowedFilters = ["order_date", "segment"]
  parameterPolicy {
    start_date = "dynamic"
    active_status = "static"
  }
  filterBindings {
    date_range = "order_date"
    segment = "segment"
  }
  sourceSystems = ["orders"]
  replacementFor = []
  query = """
    SELECT customer_id, COUNT(*) AS total_orders
    FROM fct_orders
    GROUP BY customer_id
  """
}`);
    writeFileSync(join(tmpDir, 'domains', 'customer', 'views', 'customer_360.dql'), `business_view "Customer 360" {
  domain = "Customer"
  owner = "customer-analytics"
  terms = ["Customer"]
  includes {
    block "Customer Orders Rollup"
  }
}`);

    const manifest = buildManifest({ projectRoot: tmpDir, dqlVersion: 'test' });
    const block = manifest.blocks['Customer Orders Rollup'];

    expect(manifest.domains?.Customer).toMatchObject({
      owner: 'customer-analytics',
      businessOwner: 'Customer Success',
      sourceSystems: ['crm', 'orders'],
      primaryTerms: ['Customer'],
    });
    expect(block).toMatchObject({
      domain: 'Customer',
      pattern: 'entity_rollup',
      grain: 'customer_id',
      entities: ['Customer'],
      declaredOutputs: ['customer_id', 'total_orders'],
      dimensions: ['segment'],
      allowedFilters: ['order_date', 'segment'],
      parameterPolicy: [
        { name: 'start_date', policy: 'dynamic' },
        { name: 'active_status', policy: 'static' },
      ],
      filterBindings: [
        { filter: 'date_range', binding: 'order_date' },
        { filter: 'segment', binding: 'segment' },
      ],
      sourceSystems: ['orders'],
    });
    expect(block.dimensionsRef).toBeUndefined();
    expect(block.allDependencies).not.toContain('@dim(segment)');
    expect(manifest.businessViews['Customer 360'].blockRefs).toEqual(['Customer Orders Rollup']);
    expect(manifest.lineage.nodes.some((node) => node.id === 'domain:Customer')).toBe(true);
    expect(manifest.lineage.edges.some((edge) =>
      edge.source === 'domain:Customer'
      && edge.target === 'block:Customer Orders Rollup'
      && edge.type === 'contains',
    )).toBe(true);
    expect(manifest.diagnostics?.filter((diag) => diag.severity === 'error')).toEqual([]);
  });

  it('keeps certified canonical blocks ahead of draft duplicates', () => {
    mkdirSync(join(tmpDir, 'blocks', 'nba'), { recursive: true });
    mkdirSync(join(tmpDir, 'blocks', '_drafts', 'nba'), { recursive: true });
    writeFileSync(join(tmpDir, 'blocks', 'nba', 'top_players.dql'), `block "Top Players" {
  domain = "nba"
  status = "certified"
  owner = "sports-analytics"
  description = "Certified reusable top players block."
  allowedFilters = ["season_start", "season_end", "top_n"]
  parameterPolicy {
    season_start = "dynamic"
    season_end = "dynamic"
    top_n = "dynamic"
  }
  query = """SELECT player_name, SUM(points) AS total_points FROM fct_player_performance GROUP BY player_name"""
}`);
    writeFileSync(join(tmpDir, 'blocks', '_drafts', 'nba', 'top_players.dql'), `block "Top Players" {
  domain = "nba"
  status = "draft"
  owner = "sports-analytics"
  description = "Draft duplicate should not hide the certified block."
  query = """SELECT player_name, points FROM raw_player_points"""
}`);

    const manifest = buildManifest({ projectRoot: tmpDir, dqlVersion: 'test' });

    expect(manifest.blocks['Top Players']).toMatchObject({
      status: 'certified',
      filePath: 'blocks/nba/top_players.dql',
      allowedFilters: ['season_start', 'season_end', 'top_n'],
    });
    expect(manifest.diagnostics.some((diagnostic) =>
      diagnostic.message.includes('duplicate block "Top Players"'),
    )).toBe(true);
  });

  it('resolves domain display names, folder slugs, and lowercase references as one domain', () => {
    mkdirSync(join(tmpDir, 'domains', 'nba', 'blocks'), { recursive: true });
    writeFileSync(join(tmpDir, 'domains', 'nba', 'domain.dql'), `domain "NBA" {
  owner = "sports-analytics"
  reviewCadence = "monthly"
}`);
    writeFileSync(join(tmpDir, 'domains', 'nba', 'blocks', 'top_players.dql'), `block "Top Players" {
  domain = "nba"
  type = "custom"
  owner = "sports-analytics"
  query = """
    SELECT player_name FROM int_player_stats
  """
}`);

    const manifest = buildManifest({ projectRoot: tmpDir, dqlVersion: 'test' });
    const messages = manifest.diagnostics?.map((diag) => diag.message) ?? [];
    const blockNode = manifest.lineage.nodes.find((node) => node.id === 'block:Top Players');

    expect(messages.some((message) => message.includes('domain "nba" is used'))).toBe(false);
    expect(messages.some((message) => message.includes('domain "NBA" has no terms, blocks, or business views yet'))).toBe(false);
    expect(manifest.lineage.domains).toEqual(['NBA']);
    expect(blockNode?.domain).toBe('NBA');
    expect(manifest.lineage.edges.some((edge) => edge.source === 'domain:NBA' && edge.target === 'block:Top Players')).toBe(true);
    expect(manifest.lineage.domainTrust.NBA).toMatchObject({ total: 1, certified: 0 });
  });

  it('extracts notebook DQL block SQL and metadata from the parsed block', () => {
    mkdirSync(join(tmpDir, 'notebooks'), { recursive: true });
    writeFileSync(join(tmpDir, 'notebooks', 'analysis.dqlnb'), JSON.stringify({
      version: 1,
      cells: [
        {
          id: 'cell-1',
          type: 'dql',
          source: `term "Notebook Revenue Term" {
  domain = "finance"
  type = "metric"
  status = "certified"
  description = "Revenue used by the notebook inline block."
  owner = "analytics@example.com"
}

block "Notebook Revenue" {
  domain = "finance"
  type = "custom"
  status = "certified"
  owner = "analytics@example.com"
  tags = ["finance", "notebook"]
  terms = ["Notebook Revenue Term"]
  query = """
    SELECT segment, SUM(revenue) AS revenue
    FROM orders
    GROUP BY 1
  """
  visualization {
    chart = "bar"
    x = segment
    y = revenue
  }
  tests {
    assert row_count > 0
  }
}`,
        },
      ],
    }));

    const manifest = buildManifest({ projectRoot: tmpDir, dqlVersion: 'test' });
    const block = manifest.blocks['Notebook Revenue'];

    expect(manifest.terms['Notebook Revenue Term']?.filePath).toBe('notebooks/analysis.dqlnb#cell-1');
    expect(block.sql).toContain('SELECT segment');
    expect(block.sql).not.toContain('block "Notebook Revenue"');
    expect(block.domain).toBe('finance');
    expect(block.status).toBe('certified');
    expect(block.owner).toBe('analytics@example.com');
    expect(block.tags).toEqual(['finance', 'notebook']);
    expect(block.chartType).toBe('bar');
    expect(block.displayHints).toMatchObject({
      defaultVisualization: 'bar',
      allowedVisualizations: expect.arrayContaining(['bar', 'table']),
      fieldHints: { x: 'segment', y: 'revenue' },
      source: 'block_visualization',
    });
    expect(block.tests).toEqual(['row_count > 0']);
    expect(block.tableDependencies).toEqual(['orders']);
  });

  it('recovers from legacy nested proposal metadata in draft blocks', () => {
    mkdirSync(join(tmpDir, 'blocks', '_drafts'), { recursive: true });
    writeFileSync(join(tmpDir, 'blocks', '_drafts', 'legacy.dql'), `block "legacy" {
  domain = "misc"
  type = "custom"
  status = "draft"
  _proposed {
    asked_times = 2
    proposed_contract_id = "misc.Unknown.legacy"
  }
  query = """SELECT 1"""
}`);

    const manifest = buildManifest({ projectRoot: tmpDir, dqlVersion: 'test' });

    expect(manifest.blocks).not.toHaveProperty('legacy');
    expect(manifest.diagnostics?.some((diagnostic) =>
      diagnostic.kind === 'parse'
      && diagnostic.filePath === 'blocks/_drafts/legacy.dql'
      && diagnostic.message.includes('Failed to parse block file'),
    )).toBe(true);
  });

  it('validates datalex_contract references when configured with a DataLex manifest', () => {
    mkdirSync(join(tmpDir, 'blocks'), { recursive: true });
    writeFileSync(join(tmpDir, 'dql.config.json'), JSON.stringify({
      project: 'demo',
      datalex: { manifestPath: 'datalex-manifest.json' },
    }));
    writeFileSync(join(tmpDir, 'datalex-manifest.json'), JSON.stringify({
      manifestSpecVersion: '1.0.0',
      datalexVersion: '1.0.0',
      generatedAt: '2026-01-01T00:00:00Z',
      project: { name: 'demo' },
      domains: [
        {
          name: 'commerce',
          entities: [
            {
              name: 'Customer',
              contracts: [
                { id: 'commerce.Customer.monthly_active_customers', name: 'monthly_active_customers', version: 1 },
              ],
            },
          ],
        },
      ],
    }));
    writeFileSync(join(tmpDir, 'blocks', 'bad.dql'), `block "Bad Contract" {
  domain = "commerce"
  type = "custom"
  status = "certified"
  datalex_contract = "commerce.Customer.unknown_contract@1"
  query = """SELECT 1"""
}`);

    const manifest = buildManifest({ projectRoot: tmpDir, dqlVersion: 'test' });

    expect(manifest.diagnostics?.some((d) =>
      d.severity === 'error' && d.message.includes('not found in the loaded DataLex manifest'),
    )).toBe(true);
  });

  it('compiles business views and validates included refs', () => {
    mkdirSync(join(tmpDir, 'blocks'), { recursive: true });
    mkdirSync(join(tmpDir, 'terms'), { recursive: true });
    mkdirSync(join(tmpDir, 'business-views'), { recursive: true });
    writeFileSync(join(tmpDir, 'terms', 'customer.dql'), `term "Customer" {
  domain = "Customer"
  type = "entity"
  status = "draft"
  description = "A person or account."
  owner = "Customer Analytics"
  identifiers = ["customer_id"]
}`);
    writeFileSync(join(tmpDir, 'terms', 'customer_health.dql'), `term "Customer Health" {
  domain = "Customer"
  type = "concept"
  status = "draft"
  description = "Retention and service risk summary."
  owner = "Customer Analytics"
}`);
    writeFileSync(join(tmpDir, 'blocks', 'customer_identity.dql'), `block "Customer Identity" {
  domain = "Customer"
  type = "custom"
  terms = ["Customer"]
  query = """
    SELECT customer_id, customer_name FROM dim_customer
  """
}`);
    writeFileSync(join(tmpDir, 'blocks', 'customer_orders.dql'), `block "Customer Orders Rollup" {
  domain = "Customer"
  type = "custom"
  terms = ["Customer"]
  query = """
    SELECT customer_id, COUNT(*) AS total_orders FROM fct_orders GROUP BY 1
  """
}`);
    writeFileSync(join(tmpDir, 'business-views', 'customer_360.dql'), `business_view "Customer 360" {
  domain = "Customer"
  status = "draft"
  description = "Complete customer view"
  owner = "Customer Analytics"
  terms = ["Customer Health"]
  businessOutcome = "Improve retention decisions"
  decisionUse = "Account review"
  reviewCadence = "weekly"
  tags = ["customer", "360"]

  includes {
    block "Customer Identity"
    block "Customer Orders Rollup"
  }
}`);

    const manifest = buildManifest({ projectRoot: tmpDir, dqlVersion: 'test' });
    const view = manifest.businessViews['Customer 360'];

    expect(manifest.terms['Customer']).toMatchObject({
      domain: 'Customer',
      termType: 'entity',
      identifiers: ['customer_id'],
    });
    expect(view).toBeDefined();
    expect(view.domain).toBe('Customer');
    expect(view.owner).toBe('Customer Analytics');
    expect(view.blockRefs).toEqual(['Customer Identity', 'Customer Orders Rollup']);
    expect(view.declaredTermRefs).toEqual(['Customer Health']);
    expect(view.inheritedTermRefs).toEqual(['Customer']);
    expect(view.termRefs).toEqual(['Customer Health', 'Customer']);
    expect(view.unresolvedBlockRefs).toEqual([]);
    expect(manifest.diagnostics?.filter((diag) => diag.severity === 'error')).toEqual([]);
  });

  it('reports duplicate terms and unresolved term refs', () => {
    mkdirSync(join(tmpDir, 'blocks'), { recursive: true });
    mkdirSync(join(tmpDir, 'terms'), { recursive: true });
    mkdirSync(join(tmpDir, 'business-views'), { recursive: true });
    writeFileSync(join(tmpDir, 'terms', 'customer.dql'), `term "Customer" {
  domain = "Customer"
  type = "entity"
}`);
    writeFileSync(join(tmpDir, 'terms', 'customer_duplicate.dql'), `term "Customer" {
  domain = "Customer"
  type = "entity"
}`);
    writeFileSync(join(tmpDir, 'blocks', 'customer_identity.dql'), `block "Customer Identity" {
  domain = "Customer"
  type = "custom"
  terms = ["Customer", "Missing Term"]
  query = """
    SELECT customer_id FROM dim_customer
  """
}`);
    writeFileSync(join(tmpDir, 'business-views', 'customer_360.dql'), `business_view "Customer 360" {
  domain = "Customer"
  terms = ["Missing View Term"]
  includes {
    block "Customer Identity"
  }
}`);

    const manifest = buildManifest({ projectRoot: tmpDir, dqlVersion: 'test' });
    const messages = manifest.diagnostics?.map((diag) => diag.message) ?? [];

    expect(manifest.blocks['Customer Identity'].termRefs).toEqual(['Customer']);
    expect(manifest.blocks['Customer Identity'].unresolvedTermRefs).toEqual(['Missing Term']);
    expect(manifest.businessViews['Customer 360'].unresolvedTermRefs).toEqual(['Missing View Term']);
    expect(messages.some((message) => message.includes('duplicate term "Customer"'))).toBe(true);
    expect(messages.some((message) => message.includes('block "Customer Identity" has unresolved term refs: Missing Term'))).toBe(true);
    expect(messages.some((message) => message.includes('business_view "Customer 360" has unresolved term refs: Missing View Term'))).toBe(true);
  });

  it('reports unresolved business view refs and cycles', () => {
    mkdirSync(join(tmpDir, 'blocks'), { recursive: true });
    mkdirSync(join(tmpDir, 'business-views'), { recursive: true });
    writeFileSync(join(tmpDir, 'blocks', 'customer_identity.dql'), `block "Customer Identity" {
  domain = "Customer"
  type = "custom"
  query = """
    SELECT customer_id FROM dim_customer
  """
}`);
    writeFileSync(join(tmpDir, 'business-views', 'customer_360.dql'), `business_view "Customer 360" {
  domain = "Customer"
  includes {
    block "Missing Block"
    business_view "Customer Health"
    business_view "Missing View"
  }
}`);
    writeFileSync(join(tmpDir, 'business-views', 'customer_health.dql'), `business_view "Customer Health" {
  domain = "Customer"
  includes {
    block "Customer Identity"
    business_view "Customer 360"
  }
}`);

    const manifest = buildManifest({ projectRoot: tmpDir, dqlVersion: 'test' });
    const messages = manifest.diagnostics?.map((diag) => diag.message) ?? [];

    expect(manifest.businessViews['Customer 360'].unresolvedBlockRefs).toEqual(['Missing Block']);
    expect(manifest.businessViews['Customer 360'].unresolvedBusinessViewRefs).toEqual(['Missing View']);
    expect(messages.some((message) => message.includes('unresolved block refs: Missing Block'))).toBe(true);
    expect(messages.some((message) => message.includes('unresolved business_view refs: Missing View'))).toBe(true);
    expect(messages.some((message) => message.includes('business_view cycle detected'))).toBe(true);
  });

  it('warns on cross-domain dependencies and stale domain review cadence', () => {
    mkdirSync(join(tmpDir, 'domains', 'customer', 'blocks'), { recursive: true });
    mkdirSync(join(tmpDir, 'domains', 'revenue', 'blocks'), { recursive: true });
    mkdirSync(join(tmpDir, 'domains', 'customer', 'views'), { recursive: true });
    writeFileSync(join(tmpDir, 'domains', 'customer', 'domain.dql'), `domain "Customer" {
  owner = "customer-analytics"
  reviewCadence = "annual"
}`);
    writeFileSync(join(tmpDir, 'domains', 'revenue', 'domain.dql'), `domain "Revenue" {
  owner = "revenue-analytics"
  reviewCadence = "quarterly"
}`);
    writeFileSync(join(tmpDir, 'domains', 'revenue', 'blocks', 'revenue_total.dql'), `block "Revenue Total" {
  domain = "Revenue"
  type = "custom"
  query = """
    SELECT customer_id, SUM(revenue) AS revenue FROM fct_revenue GROUP BY 1
  """
}`);
    writeFileSync(join(tmpDir, 'domains', 'customer', 'blocks', 'customer_revenue.dql'), `block "Customer Revenue" {
  domain = "Customer"
  type = "custom"
  query = """
    SELECT * FROM ref("Revenue Total")
  """
}`);
    writeFileSync(join(tmpDir, 'domains', 'customer', 'views', 'customer_360.dql'), `business_view "Customer 360" {
  domain = "Customer"
  includes {
    block "Revenue Total"
  }
}`);

    const manifest = buildManifest({ projectRoot: tmpDir, dqlVersion: 'test' });
    const messages = manifest.diagnostics?.map((diag) => diag.message) ?? [];

    expect(messages.some((message) => message.includes('reviewCadence "annual" is stale'))).toBe(true);
    expect(messages.some((message) => message.includes('block "Customer Revenue" in domain "Customer" depends on block "Revenue Total" in domain "Revenue"'))).toBe(true);
    expect(messages.some((message) => message.includes('business_view "Customer 360" in domain "Customer" includes block "Revenue Total" from domain "Revenue"'))).toBe(true);
  });
});

describe('buildManifest — output-contract drift detection', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dql-drift-'));
    writeFileSync(join(tmpDir, 'dql.config.json'), '{"project":"drift-demo"}');
    mkdirSync(join(tmpDir, 'blocks'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const driftDiagnostics = (manifest: ReturnType<typeof buildManifest>) =>
    (manifest.diagnostics ?? []).filter((d) => d.kind === 'drift');

  it('populates an additive outputContract without touching outputs', () => {
    writeFileSync(join(tmpDir, 'blocks', 'child.dql'), `block "child_metrics" {
  domain = "ops"
  type = "custom"
  query = """
    SELECT region, SUM(amount) AS total_amount FROM fct_sales GROUP BY region
  """
}`);

    const manifest = buildManifest({ projectRoot: tmpDir, dqlVersion: 'test' });
    const child = manifest.blocks['child_metrics'];

    // outputContract is additive + derived from resolved column lineage.
    expect(child.outputContract).toEqual([
      { name: 'region', role: undefined },
      { name: 'total_amount', role: 'metric' },
    ]);
    // The existing `outputs` (column-lineage shaped) is untouched and distinct.
    expect(child.outputs?.map((o) => o.name)).toEqual(['region', 'total_amount']);
    expect(child.outputs?.[1]).toMatchObject({ name: 'total_amount', isAggregate: true, aggregateFn: 'SUM' });
  });

  it('prefers declaredOutputs for the contract when present, enriching role from lineage', () => {
    writeFileSync(join(tmpDir, 'blocks', 'declared.dql'), `block "declared_child" {
  domain = "ops"
  type = "custom"
  outputs = ["region", "total_amount"]
  query = """
    SELECT region, SUM(amount) AS total_amount FROM fct_tx GROUP BY region
  """
}`);

    const manifest = buildManifest({ projectRoot: tmpDir, dqlVersion: 'test' });
    const child = manifest.blocks['declared_child'];

    expect(child.declaredOutputs).toEqual(['region', 'total_amount']);
    // Names come from declaredOutputs (author-committed contract); role is
    // enriched from column lineage (the aggregate output is a 'metric').
    expect(child.outputContract).toEqual([
      { name: 'region', role: undefined },
      { name: 'total_amount', role: 'metric' },
    ]);
  });

  it('warns (not errors) when a parent references a column the child renamed away', () => {
    writeFileSync(join(tmpDir, 'blocks', 'child.dql'), `block "child_metrics" {
  domain = "ops"
  type = "custom"
  outputs = ["region", "approval_rate_pct"]
  query = """
    SELECT region, ROUND(100.0 * AVG(flag), 2) AS approval_rate_pct FROM fct_tx GROUP BY region
  """
}`);
    // Parent still references the OLD name "approval_pct" (drift).
    writeFileSync(join(tmpDir, 'blocks', 'parent.dql'), `block "parent_summary" {
  domain = "ops"
  type = "custom"
  query = """
    SELECT c.region, c.approval_pct FROM ref("child_metrics") c
  """
}`);

    const manifest = buildManifest({ projectRoot: tmpDir, dqlVersion: 'test' });
    const drift = driftDiagnostics(manifest);

    // Exactly one drift warning; build still succeeds (no error severity).
    expect(drift).toHaveLength(1);
    const d = drift[0];
    expect(d.severity).toBe('warning');
    expect(d.kind).toBe('drift');
    // Names both blocks + the drifted column.
    expect(d.message).toContain('parent_summary');
    expect(d.message).toContain('child_metrics');
    expect(d.message).toContain('approval_pct');
    expect(d.drift).toMatchObject({
      parentBlock: 'parent_summary',
      childBlock: 'child_metrics',
      column: 'approval_pct',
      availableColumns: ['region', 'approval_rate_pct'],
    });
    // The build did NOT fail: no error-severity diagnostics introduced by drift.
    expect((manifest.diagnostics ?? []).some((x) => x.kind === 'drift' && x.severity === 'error')).toBe(false);
    // And the manifest is fully populated (blocks present).
    expect(Object.keys(manifest.blocks)).toContain('parent_summary');
  });

  it('does not warn when the child adds NEW columns (additive change)', () => {
    // Child gains "new_col" but keeps the two columns the parent references.
    writeFileSync(join(tmpDir, 'blocks', 'child.dql'), `block "child_metrics" {
  domain = "ops"
  type = "custom"
  outputs = ["region", "approval_rate_pct", "new_col"]
  query = """
    SELECT region, approval_rate_pct, new_col FROM fct_tx
  """
}`);
    writeFileSync(join(tmpDir, 'blocks', 'parent.dql'), `block "parent_summary" {
  domain = "ops"
  type = "custom"
  query = """
    SELECT c.region, c.approval_rate_pct FROM ref("child_metrics") c
  """
}`);

    const manifest = buildManifest({ projectRoot: tmpDir, dqlVersion: 'test' });
    expect(driftDiagnostics(manifest)).toHaveLength(0);
  });

  it('stays silent when the child output schema is open (SELECT *)', () => {
    // Child projects a star → unknown schema → no contract → no false drift.
    writeFileSync(join(tmpDir, 'blocks', 'child.dql'), `block "child_star" {
  domain = "ops"
  type = "custom"
  query = """
    SELECT * FROM fct_tx
  """
}`);
    writeFileSync(join(tmpDir, 'blocks', 'parent.dql'), `block "parent_star" {
  domain = "ops"
  type = "custom"
  query = """
    SELECT c.anything_goes FROM ref("child_star") c
  """
}`);

    const manifest = buildManifest({ projectRoot: tmpDir, dqlVersion: 'test' });
    expect(manifest.blocks['child_star'].outputContract).toBeUndefined();
    expect(driftDiagnostics(manifest)).toHaveLength(0);
  });
});
