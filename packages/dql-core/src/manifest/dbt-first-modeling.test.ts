import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildManifest, collectInputFiles } from './builder.js';

describe('manifest v3 dbt-first modeling', () => {
  let projectRoot: string;
  let dbtManifestPath: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-dbt-first-'));
    dbtManifestPath = writeProject(projectRoot);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('emits sparse dbt provenance and certified safe relationship policy', () => {
    const manifest = buildManifest({ projectRoot, dbtManifestPath });
    const rebuilt = buildManifest({ projectRoot, dbtManifestPath });

    expect(manifest.manifestVersion).toBe(3);
    expect(manifest.dbtImport).toBeUndefined();
    expect(manifest.dbtProvenance?.nodes['model.commerce.fct_orders']).toMatchObject({
      uniqueId: 'model.commerce.fct_orders',
      sourcePath: 'models/marts/fct_orders.sql',
      available: { description: true, columns: true, tests: true, catalogTypes: true, dqlMeta: true },
    });
    expect(manifest.dbtProvenance?.metricFlow['metric.commerce.gross_revenue']).toMatchObject({
      name: 'gross_revenue',
      semanticModel: 'orders',
    });
    expect(manifest.modeling?.entities['commerce::entity::order']).toMatchObject({
      id: 'commerce::entity::order',
      localId: 'order',
      dbtUniqueId: 'model.commerce.fct_orders',
      grain: 'order_id',
      keys: ['customer_id'],
    });
    expect(manifest.modeling?.relationships['commerce::relationship::order_to_customer']).toMatchObject({
      id: 'commerce::relationship::order_to_customer',
      localId: 'order_to_customer',
      status: 'certified',
      cardinality: 'many_to_one',
      fanout: 'safe',
      staleCertification: false,
      automaticJoinAllowed: true,
    });
    expect(manifest.modeling?.relationships['growth::relationship::acquisition_to_customer']).toMatchObject({
      crossDomain: true,
      automaticJoinAllowed: true,
    });
    expect(manifest.modeling?.interfaces?.exports['commerce.customer_identity@1']).toMatchObject({
      entity: 'commerce::entity::customer',
      status: 'certified',
    });
    expect(manifest.modeling?.interfaces?.imports['growth::import::growth_customer_identity']).toMatchObject({
      exportRef: 'commerce.customer_identity@1',
      domain: 'growth',
    });

    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain('The authoritative order fact description');
    expect(serialized).not.toContain('SUM(order_total)');
    expect(serialized).not.toContain('Do not copy this dbt test description');
    expect(manifest.sources.fct_orders.dbtModel).toBeUndefined();
    expect(manifest).toEqual(rebuilt);
    expect(manifest.generatedAt).toBe('1970-01-01T00:00:00.000Z');

    const inputs = collectInputFiles({ projectRoot, dbtManifestPath });
    expect(inputs).toContain(join(projectRoot, 'target', 'catalog.json'));
    expect(inputs).toContain(join(projectRoot, 'target', 'semantic_manifest.json'));
    expect(inputs).toContain(join(projectRoot, 'domains', 'commerce', 'modeling', 'relationships.dql.yaml'));
  });

  it('marks certified relationship stale when the dbt grain changes', () => {
    const raw = JSON.parse(requireManifest(dbtManifestPath)) as Record<string, any>;
    raw.nodes['model.commerce.dim_customers'].meta.dql.grain = 'customer_sk';
    writeFileSync(dbtManifestPath, JSON.stringify(raw));

    const manifest = buildManifest({ projectRoot, dbtManifestPath });
    expect(manifest.modeling?.relationships['commerce::relationship::order_to_customer'].staleCertification).toBe(true);
    expect(manifest.modeling?.relationships['commerce::relationship::order_to_customer'].automaticJoinAllowed).toBe(false);
    expect(manifest.diagnostics?.some((diagnostic) => diagnostic.kind === 'modeling' && diagnostic.message.includes('stale'))).toBe(true);
  });

  it('qualifies duplicate local entity ids across domains without guessing', () => {
    const growthEntities = join(projectRoot, 'domains', 'growth', 'modeling', 'entities.dql.yaml');
    writeFileSync(growthEntities, `${readFileSync(growthEntities, 'utf8')}  - id: order\n    dbt_model: model.growth.fct_campaign_touches\n`);
    const growthRelationships = join(projectRoot, 'domains', 'growth', 'modeling', 'relationships.dql.yaml');
    writeFileSync(growthRelationships, readFileSync(growthRelationships, 'utf8').replace('    to: customer\n', '    to: commerce:customer\n'));

    const manifest = buildManifest({ projectRoot, dbtManifestPath });

    expect(manifest.modeling?.entities.order).toBeUndefined();
    expect(manifest.modeling?.entities['commerce::entity::order']).toMatchObject({ id: 'commerce::entity::order', localId: 'order', qualifiedId: 'commerce::entity::order', domain: 'commerce' });
    expect(manifest.modeling?.entities['growth::entity::order']).toMatchObject({ id: 'growth::entity::order', localId: 'order', qualifiedId: 'growth::entity::order', domain: 'growth' });
    expect(manifest.modeling?.relationships['growth::relationship::acquisition_to_customer'].to).toBe('commerce::entity::customer');
  });

  it('withdraws automatic joins when warehouse evidence is expired', () => {
    const relationshipPath = join(projectRoot, 'domains', 'commerce', 'modeling', 'relationships.dql.yaml');
    writeFileSync(relationshipPath, readFileSync(relationshipPath, 'utf8').replace('    validation:\n', "    evidence_expires_at: '2000-01-01'\n    validation:\n"));

    const manifest = buildManifest({ projectRoot, dbtManifestPath });

    expect(manifest.modeling?.relationships['commerce::relationship::order_to_customer'].automaticJoinAllowed).toBe(false);
    expect(manifest.diagnostics?.some((diagnostic) => diagnostic.message.includes('expired'))).toBe(true);
  });

  it.each([
    ['its validation query fingerprint changes', (source: string) => source.replace('query_fingerprint: order-customer-proof', 'query_fingerprint: changed-query')],
    ['legacy evidence has no bound proof fingerprint', (source: string) => source.replace(/^\s*proof_fingerprint:.*\n/m, '')],
  ])('withdraws automatic joins when %s', (_label, mutate) => {
    const relationshipPath = join(projectRoot, 'domains', 'commerce', 'modeling', 'relationships.dql.yaml');
    writeFileSync(relationshipPath, mutate(readFileSync(relationshipPath, 'utf8')));

    const manifest = buildManifest({ projectRoot, dbtManifestPath });

    expect(manifest.modeling?.relationships['commerce::relationship::order_to_customer'].automaticJoinAllowed).toBe(false);
    expect(manifest.diagnostics?.some((diagnostic) => diagnostic.message.includes('validation proof'))).toBe(true);
  });

  it('does not compile a cross-domain automatic join without a compatible certified export contract', () => {
    const interfacePath = join(projectRoot, 'domains', 'commerce', 'modeling', 'interfaces.dql.yaml');
    writeFileSync(interfacePath, readFileSync(interfacePath, 'utf8').replace('    contract: customer_identity_contract\n', ''));

    const manifest = buildManifest({ projectRoot, dbtManifestPath });

    expect(manifest.modeling?.relationships['growth::relationship::acquisition_to_customer'].automaticJoinAllowed).toBe(false);
    expect(manifest.diagnostics?.some((diagnostic) => diagnostic.message.includes('compatible certified contract'))).toBe(true);
  });

  it('keeps v2 projects on the compatibility path unless both v3 settings are present', () => {
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'commerce', manifestVersion: 3 }));
    const manifest = buildManifest({ projectRoot, dbtManifestPath });

    expect(manifest.manifestVersion).toBe(2);
    expect(manifest.modeling).toBeUndefined();
    expect(manifest.diagnostics?.some((diagnostic) => diagnostic.kind === 'config' && diagnostic.severity === 'error')).toBe(true);
  });
});

function writeProject(projectRoot: string): string {
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
    project: 'commerce',
    manifestVersion: 3,
    modeling: { mode: 'dbt-first' },
    dbt: { projectDir: '.', manifestPath: 'target/manifest.json' },
  }));
  const target = join(projectRoot, 'target');
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'manifest.json'), JSON.stringify({
    metadata: { project_name: 'commerce' },
    nodes: {
      'model.commerce.fct_orders': model('fct_orders', 'order_id', ['customer_id'], 'models/marts/fct_orders.sql', 'The authoritative order fact description'),
      'model.commerce.dim_customers': model('dim_customers', 'customer_id', ['customer_id'], 'models/marts/dim_customers.sql'),
      'model.growth.dim_customer_acquisition': model('dim_customer_acquisition', 'customer_id', ['customer_id'], 'models/marts/dim_customer_acquisition.sql'),
      'model.growth.fct_campaign_touches': model('fct_campaign_touches', 'touch_id', ['customer_id'], 'models/marts/fct_campaign_touches.sql'),
    },
    sources: {},
    metrics: {
      'metric.commerce.gross_revenue': {
        name: 'gross_revenue',
        original_file_path: 'models/marts/orders.yml',
        type_params: { semantic_model: 'orders', expression: 'SUM(order_total)' },
      },
    },
  }));
  writeFileSync(join(target, 'catalog.json'), JSON.stringify({
    nodes: Object.fromEntries([
      'model.commerce.fct_orders',
      'model.commerce.dim_customers',
      'model.growth.dim_customer_acquisition',
      'model.growth.fct_campaign_touches',
    ].map((id) => [id, { columns: { customer_id: { type: 'integer' } } }])),
    sources: {},
  }));
  writeFileSync(join(target, 'semantic_manifest.json'), JSON.stringify({
    metrics: { 'metric.commerce.gross_revenue': { name: 'gross_revenue', semantic_model: 'orders', expression: 'SUM(order_total)' } },
  }));

  writeYaml(projectRoot, 'domains/commerce/domain.dql', `domain "Commerce" {
  id = "commerce"
  owner = "commerce@company.test"
}
`);
  writeYaml(projectRoot, 'domains/commerce/modeling/entities.dql.yaml', `entities:
  - id: order
    dbt_model: model.commerce.fct_orders
  - id: customer
    dbt_model: model.commerce.dim_customers
`);
  writeYaml(projectRoot, 'domains/commerce/modeling/relationships.dql.yaml', `relationships:
  - id: order_to_customer
    from: order
    to: customer
    keys: [{ from: customer_id, to: customer_id }]
    cardinality: many_to_one
    fanout: safe
    status: certified
    certifiedAgainst:
      from: { grain: order_id, keys: [customer_id] }
      to: { grain: customer_id, keys: [customer_id] }
    validation:
      status: passed
      checked_at: '2026-07-11T00:00:00.000Z'
      query_fingerprint: order-customer-proof
      proof_fingerprint: abd9109395c4eea1588b28cfad8465923886163ab5d393216954613c861ae25a
      from_rows: 10
      to_rows: 5
      joined_rows: 10
      from_null_keys: 0
      to_null_keys: 0
      unmatched_from: 0
      max_from_per_key: 5
      max_to_per_key: 1
`);
  writeYaml(projectRoot, 'domains/commerce/modeling/interfaces.dql.yaml', `exports:
  - id: customer_identity
    version: 1
    entity: customer
    allowed_keys: [customer_id]
    purposes: [growth_attribution]
    consumer_domains: [growth]
    status: certified
    owner: commerce@company.test
    contract: customer_identity_contract
contracts:
  - id: customer_identity_contract
    entities: [customer]
    purpose: growth_attribution
    status: certified
    owner: commerce@company.test
    required_evaluation: false
`);
  writeYaml(projectRoot, 'domains/growth/domain.dql', `domain "Growth" {
  id = "growth"
  owner = "growth@company.test"
}
`);
  writeYaml(projectRoot, 'domains/growth/modeling/entities.dql.yaml', `entities:
  - id: acquisition
    dbt_model: model.growth.dim_customer_acquisition
  - id: campaign_touch
    dbt_model: model.growth.fct_campaign_touches
`);
  writeYaml(projectRoot, 'domains/growth/modeling/relationships.dql.yaml', `relationships:
  - id: acquisition_to_customer
    owner_domain: growth
    from: acquisition
    to: customer
    keys: [{ from: customer_id, to: customer_id }]
    cardinality: many_to_one
    fanout: safe
    crossDomain: true
    imports: [commerce.customer_identity@1]
    status: certified
    certifiedAgainst:
      from: { grain: customer_id, keys: [customer_id] }
      to: { grain: customer_id, keys: [customer_id] }
    validation:
      status: passed
      checked_at: '2026-07-11T00:00:00.000Z'
      query_fingerprint: acquisition-customer-proof
      proof_fingerprint: b4437e3b0773955d15e7c77d368031099650f16d17c297f65f86a1c549dc1720
      from_rows: 5
      to_rows: 5
      joined_rows: 5
      from_null_keys: 0
      to_null_keys: 0
      unmatched_from: 0
      max_from_per_key: 1
      max_to_per_key: 1
`);
  writeYaml(projectRoot, 'domains/growth/modeling/interfaces.dql.yaml', `imports:
  - id: growth_customer_identity
    export: commerce.customer_identity@1
    purpose: growth_attribution
    status: certified
    owner: growth@company.test
`);
  return join(target, 'manifest.json');
}

function model(name: string, grain: string, keys: string[], sourcePath: string, description?: string): Record<string, unknown> {
  return {
    resource_type: 'model',
    name,
    alias: name,
    database: 'analytics',
    schema: 'marts',
    original_file_path: sourcePath,
    description,
    meta: { dql: { grain, keys } },
    columns: {
      customer_id: {
        name: 'customer_id',
        description: 'Do not copy this dbt test description',
        tests: ['not_null'],
      },
      [grain]: { name: grain },
    },
  };
}

function writeYaml(projectRoot: string, relativePath: string, content: string): void {
  const path = join(projectRoot, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function requireManifest(path: string): string {
  return readFileSync(path, 'utf8');
}
