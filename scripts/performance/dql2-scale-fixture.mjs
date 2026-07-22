import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export const PERF_001_SEED = 'dql2-domain-context-v1';
export const PERF_001_COUNTS = Object.freeze({
  dbtModels: 10_000,
  columnsPerModel: 30,
  semanticMetrics: 7_000,
  domains: 100,
  entities: 1_000,
  relationships: 2_000,
  skills: 1_000,
  blocks: 1_000,
  businessViews: 1_000,
  apps: 250,
  notebooks: 250,
});

export const PERF_001_TARGET_SEMANTIC_METRICS = Object.freeze({
  24: Object.freeze({
    name: 'rollover_risk_amount',
    label: 'Rollover Risk Amount',
    description: 'Forecast balance at risk of expiring before it can roll over.',
    domain: 'consumption',
    entity: 'account',
    aggregation: 'sum',
    conceptId: 'semantic:consumption:rollover_risk_amount',
  }),
  60: Object.freeze({
    name: 'remaining_pool_balance',
    label: 'Remaining Pool Balance',
    description: 'Current unused pool balance before rollover eligibility is applied.',
    domain: 'consumption',
    entity: 'account',
    aggregation: 'sum',
    conceptId: 'semantic:consumption:remaining_pool_balance',
  }),
  200: Object.freeze({
    name: 'billing_rollover_balance_amount',
    label: 'Rollover Balance Amount',
    description: 'Posted general-ledger liability for rollover balances after billing close.',
    domain: 'billing',
    entity: 'billing_account',
    aggregation: 'sum',
    conceptId: 'semantic:billing:rollover_balance_amount',
  }),
  500: Object.freeze({
    name: 'rollover_allowance',
    label: 'Rollover Allowance',
    description: 'Contractual maximum balance that an account is permitted to roll over.',
    domain: 'contracts',
    entity: 'contract',
    aggregation: 'max',
    conceptId: 'semantic:contracts:rollover_allowance',
  }),
  6789: Object.freeze({
    name: 'rollover_balance_amount',
    label: 'Rollover Balance Amount',
    description: 'Remaining eligible balance carried into the next billing month.',
    domain: 'consumption',
    entity: 'account',
    aggregation: 'sum',
    conceptId: 'semantic:consumption:rollover_balance_amount',
  }),
  6999: Object.freeze({
    name: 'monthly_rollover_amount',
    label: 'Monthly Rollover Amount',
    description: 'Amount newly transferred from the current month into the next month.',
    domain: 'consumption',
    entity: 'account',
    aggregation: 'sum',
    conceptId: 'semantic:consumption:monthly_rollover_amount',
  }),
});

const SEMANTIC_METRICS_PER_MODEL = 70;

function padded(value, width = 5) {
  return String(value).padStart(width, '0');
}

function scaleBlockName(index) {
  if (index === 0) return 'customer_rollover_report';
  if (index === 1) return 'rollover_policy_summary';
  return `block_${padded(index, 4)}`;
}

function scaleDomainId(index) {
  if (index === 0) return 'consumption';
  if (index === 1) return 'billing';
  if (index === 2) return 'contracts';
  return `domain_${padded(index, 3)}`;
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function normalizedScaleCounts(overrides = {}) {
  const counts = { ...PERF_001_COUNTS, ...overrides };
  for (const [key, value] of Object.entries(counts)) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${key} must be a non-negative integer`);
  }
  if (counts.columnsPerModel < 1) throw new Error('columnsPerModel must be at least 1');
  if (counts.domains < 1) throw new Error('domains must be at least 1');
  if (counts.entities > counts.dbtModels) throw new Error('entities cannot exceed dbtModels');
  if (counts.semanticMetrics > 0 && counts.dbtModels < 1) {
    throw new Error('semanticMetrics require at least one dbtModel');
  }
  return counts;
}

/** Generate the deterministic, ignored PERF-001 project. */
export function generateScaleFixture(projectRoot, options = {}) {
  const seed = options.seed ?? PERF_001_SEED;
  const counts = normalizedScaleCounts(options.counts);
  rmSync(projectRoot, { recursive: true, force: true });
  mkdirSync(projectRoot, { recursive: true });

  write(join(projectRoot, 'dql.config.json'), JSON.stringify({
    project: `dql2-scale-${seed}`,
    manifestVersion: 3,
    modeling: { mode: 'dbt-first' },
    dbt: { projectDir: '.', manifestPath: 'target/manifest.json' },
  }, null, 2) + '\n');

  const nodes = {};
  for (let modelIndex = 0; modelIndex < counts.dbtModels; modelIndex += 1) {
    const modelId = padded(modelIndex);
    const columns = {};
    for (let columnIndex = 0; columnIndex < counts.columnsPerModel; columnIndex += 1) {
      const name = `col_${String(columnIndex).padStart(2, '0')}`;
      columns[name] = { name, description: `Deterministic column ${columnIndex}` };
    }
    nodes[`model.scale.model_${modelId}`] = {
      unique_id: `model.scale.model_${modelId}`,
      resource_type: 'model',
      package_name: 'scale',
      name: `model_${modelId}`,
      alias: `model_${modelId}`,
      database: 'analytics',
      schema: scaleDomainId(modelIndex % counts.domains),
      original_file_path: `models/${scaleDomainId(modelIndex % counts.domains)}/model_${modelId}.sql`,
      description: `Deterministic model ${modelIndex}`,
      meta: { dql: { grain: 'col_00', keys: ['col_00'] } },
      columns,
      depends_on: { nodes: modelIndex > 0 ? [`model.scale.model_${padded(modelIndex - 1)}`] : [] },
    };
  }
  write(join(projectRoot, 'target', 'manifest.json'), JSON.stringify({
    metadata: { project_name: 'dql2_scale', generated_at: '1970-01-01T00:00:00.000Z' },
    nodes,
    sources: {},
    metrics: {},
    child_map: {},
    parent_map: {},
  }));

  const semanticModels = {};
  const semanticMetrics = {};
  const semanticModelCount = Math.min(
    counts.dbtModels,
    Math.ceil(counts.semanticMetrics / SEMANTIC_METRICS_PER_MODEL),
  );
  for (let semanticModelIndex = 0; semanticModelIndex < semanticModelCount; semanticModelIndex += 1) {
    const modelId = padded(semanticModelIndex);
    const firstMetricIndex = semanticModelIndex * SEMANTIC_METRICS_PER_MODEL;
    const lastMetricIndex = Math.min(
      counts.semanticMetrics,
      firstMetricIndex + SEMANTIC_METRICS_PER_MODEL,
    );
    const measures = [];
    for (let metricIndex = firstMetricIndex; metricIndex < lastMetricIndex; metricIndex += 1) {
      const target = PERF_001_TARGET_SEMANTIC_METRICS[metricIndex];
      const metricId = padded(metricIndex);
      const measureName = `measure_${metricId}`;
      const metricName = target?.name ?? `metric_${metricId}`;
      const domain = target?.domain ?? scaleDomainId(metricIndex % counts.domains);
      const aggregation = target?.aggregation ?? 'sum';
      measures.push({
        name: measureName,
        label: target?.label ?? `Metric ${metricIndex}`,
        description: target?.description ?? `Deterministic semantic measure ${metricIndex}.`,
        agg: aggregation,
        expr: 'col_01',
        agg_time_dimension: 'metric_date',
      });
      semanticMetrics[`metric.scale.${metricName}`] = {
        unique_id: `metric.scale.${metricName}`,
        package_name: 'scale',
        name: metricName,
        label: target?.label ?? `Metric ${metricIndex}`,
        description: target?.description ?? `Deterministic semantic metric ${metricIndex}.`,
        type: 'simple',
        type_params: { measure: measureName },
        meta: {
          domain,
          entity: target?.entity ?? `entity_${padded(metricIndex % Math.max(1, counts.entities), 4)}`,
          concept_id: target?.conceptId ?? `semantic:${domain}:${metricName}`,
          fixture_position: metricIndex,
        },
      };
    }
    const targetDomains = new Set();
    for (let metricIndex = firstMetricIndex; metricIndex < lastMetricIndex; metricIndex += 1) {
      const target = PERF_001_TARGET_SEMANTIC_METRICS[metricIndex];
      if (target) targetDomains.add(target.domain);
    }
    const modelDomain = targetDomains.size === 1
      ? Array.from(targetDomains)[0]
      : scaleDomainId(semanticModelIndex % counts.domains);
    const semanticModelName = `semantic_model_${modelId}`;
    semanticModels[`semantic_model.scale.${semanticModelName}`] = {
      unique_id: `semantic_model.scale.${semanticModelName}`,
      package_name: 'scale',
      name: semanticModelName,
      description: `Deterministic semantic model ${semanticModelIndex}.`,
      model: `ref('model_${modelId}')`,
      defaults: { agg_time_dimension: 'metric_date' },
      meta: { domain: modelDomain },
      entities: [
        { name: `entity_${modelId}`, type: 'primary', expr: 'col_00' },
      ],
      measures,
      dimensions: [
        { name: 'customer', type: 'categorical', expr: 'col_00' },
        { name: 'account', type: 'categorical', expr: 'col_00' },
        { name: 'region', type: 'categorical', expr: 'col_01' },
        { name: 'risk_category', type: 'categorical', expr: 'col_01' },
        { name: 'contract', type: 'categorical', expr: 'col_00' },
        { name: 'billing_account', type: 'categorical', expr: 'col_00' },
        {
          name: 'metric_date',
          type: 'time',
          expr: `col_${String(Math.min(2, counts.columnsPerModel - 1)).padStart(2, '0')}`,
          type_params: { time_granularity: 'day' },
        },
      ],
    };
  }
  write(join(projectRoot, 'target', 'semantic_manifest.json'), JSON.stringify({
    metadata: { project_name: 'dql2_scale', generated_at: '1970-01-01T00:00:00.000Z' },
    semantic_models: semanticModels,
    metrics: semanticMetrics,
    saved_queries: {},
  }));

  for (let domainIndex = 0; domainIndex < counts.domains; domainIndex += 1) {
    const domainId = scaleDomainId(domainIndex);
    const domainRoot = join(projectRoot, 'domains', domainId);
    write(join(domainRoot, 'domain.dql'), `// dql-format: 1\n\ndomain "Domain ${padded(domainIndex, 3)}" {\n  id = "${domainId}"\n  owner = "${domainId}@example.test"\n}\n`);

    const entityStart = Math.floor((domainIndex * counts.entities) / counts.domains);
    const entityEnd = Math.floor(((domainIndex + 1) * counts.entities) / counts.domains);
    const localEntities = [];
    const modelLines = ['entities:'];
    for (let entityIndex = entityStart; entityIndex < entityEnd; entityIndex += 1) {
      const entityId = `entity_${padded(entityIndex, 4)}`;
      localEntities.push(entityId);
      modelLines.push(`  - id: ${entityId}`, `    dbt_model: model.scale.model_${padded(entityIndex)}`);
    }
    modelLines.push('relationships:');
    const relationshipStart = Math.floor((domainIndex * counts.relationships) / counts.domains);
    const relationshipEnd = Math.floor(((domainIndex + 1) * counts.relationships) / counts.domains);
    for (let relationshipIndex = relationshipStart; relationshipIndex < relationshipEnd; relationshipIndex += 1) {
      if (localEntities.length === 0) break;
      const local = relationshipIndex - relationshipStart;
      const from = localEntities[local % localEntities.length];
      const to = localEntities[(local + 1 + Math.floor(local / Math.max(1, localEntities.length))) % localEntities.length];
      modelLines.push(
        `  - id: relationship_${padded(relationshipIndex, 4)}`,
        `    from: ${from}`,
        `    to: ${to}`,
        '    keys: [{ from: col_00, to: col_00 }]',
        '    cardinality: many_to_one',
        '    fanout: safe',
        '    status: draft',
      );
    }
    write(join(domainRoot, 'modeling', 'model.dql.yaml'), modelLines.join('\n') + '\n');
  }

  for (let blockIndex = 0; blockIndex < counts.blocks; blockIndex += 1) {
    const domainIndex = blockIndex % counts.domains;
    const domainId = blockIndex === 1 ? 'consumption' : scaleDomainId(domainIndex);
    const blockId = `block_${padded(blockIndex, 4)}`;
    if (blockIndex === 0) {
      write(join(projectRoot, 'domains', domainId, 'blocks', 'customer_rollover_report.dql'), `// dql-format: 1\n\nblock "customer_rollover_report" {\n  domain = "consumption"\n  type = "custom"\n  status = "certified"\n  description = "Certified monthly report of actual rollover balances by customer."\n  owner = "consumption@example.test"\n  pattern = "ranking"\n  grain = "customer"\n  entities = ["account", "customer"]\n  outputs = ["customer_id", "month", "rollover_balance_amount"]\n  dimensions = ["customer", "month"]\n  allowedFilters = ["month"]\n  parameterPolicy {\n    start_month = "dynamic"\n    end_month = "dynamic"\n  }\n  query = """\n    SELECT col_00 AS customer_id, col_02 AS month, SUM(col_01) AS rollover_balance_amount\n    FROM model_00000\n    GROUP BY 1, 2\n    ORDER BY rollover_balance_amount DESC\n  """\n}\n`);
    } else if (blockIndex === 1) {
      write(join(projectRoot, 'domains', domainId, 'blocks', 'rollover_policy_summary.dql'), `// dql-format: 1\n\nblock "rollover_policy_summary" {\n  domain = "consumption"\n  type = "custom"\n  status = "certified"\n  description = "Certified prose summary of contractual rollover rules, with no balance output."\n  owner = "consumption@example.test"\n  grain = "contract"\n  entities = ["account", "contract"]\n  outputs = ["contract_id", "policy_summary"]\n  dimensions = ["account", "contract"]\n  allowedFilters = ["account"]\n  query = """\n    SELECT col_00 AS contract_id, 'Rollover policy applies' AS policy_summary\n    FROM model_00001\n  """\n}\n`);
    } else {
      write(join(projectRoot, 'domains', domainId, 'blocks', `${blockId}.dql`), `// dql-format: 1\n\nblock "${blockId}" {\n  domain = "${domainId}"\n  type = "custom"\n  status = "draft"\n  description = "Deterministic PERF-001 block ${blockIndex}."\n  owner = "${domainId}@example.test"\n  grain = "col_00"\n  outputs = ["col_00", "metric_value"]\n  query = """\n    SELECT col_00, COUNT(*) AS metric_value FROM model_${padded(blockIndex % counts.dbtModels)} GROUP BY 1\n  """\n}\n`);
    }
  }

  for (let viewIndex = 0; viewIndex < counts.businessViews; viewIndex += 1) {
    const domainIndex = viewIndex % counts.domains;
    const domainId = scaleDomainId(domainIndex);
    const blockId = scaleBlockName(viewIndex % Math.max(1, counts.blocks));
    const viewId = `view_${padded(viewIndex, 4)}`;
    write(join(projectRoot, 'domains', domainId, 'business-views', `${viewId}.dql`), `// dql-format: 1\n\nbusiness_view "${viewId}" {\n  domain = "${domainId}"\n  status = "draft"\n  owner = "${domainId}@example.test"\n  includes {\n    block "${blockId}"\n  }\n}\n`);
  }

  for (let skillIndex = 0; skillIndex < counts.skills; skillIndex += 1) {
    const domainIndex = skillIndex % counts.domains;
    const domainId = scaleDomainId(domainIndex);
    const blockId = counts.blocks > 0 ? scaleBlockName(skillIndex % counts.blocks) : '';
    write(join(projectRoot, 'domains', domainId, 'skills', `skill_${padded(skillIndex, 4)}.skill.md`), `---\nid: skill_${padded(skillIndex, 4)}\ndomain: ${domainId}\ndomains: [${domainId}]\nkind: analysis_pattern\nstatus: active\ntriggers: [metric ${skillIndex}]\nexclusions: [unrelated ${skillIndex}]\npreferred_blocks: [${blockId}]\n---\nUse the governed ${domainId} path for deterministic metric ${skillIndex}.\n`);
  }

  for (let notebookIndex = 0; notebookIndex < counts.notebooks; notebookIndex += 1) {
    const domainId = scaleDomainId(notebookIndex % counts.domains);
    write(join(projectRoot, 'notebooks', `notebook_${padded(notebookIndex, 4)}.dqlnb`), JSON.stringify({
      dqlnbVersion: 2,
      version: 1,
      title: `Notebook ${notebookIndex}`,
      metadata: { ownerDomain: domainId, usesDomains: [domainId], purpose: 'performance_validation', createdWith: 'dql' },
      cells: [{ id: 'query', type: 'sql', content: `SELECT * FROM model_${padded(notebookIndex % counts.dbtModels)} LIMIT 10` }],
    }));
  }

  for (let appIndex = 0; appIndex < counts.apps; appIndex += 1) {
    const domainId = scaleDomainId(appIndex % counts.domains);
    write(join(projectRoot, 'apps', `app_${padded(appIndex, 4)}`, 'dql.app.json'), JSON.stringify({
      version: 1,
      id: `app_${padded(appIndex, 4)}`,
      name: `App ${appIndex}`,
      domain: domainId,
      ownerDomain: domainId,
      usesDomains: [domainId],
      purpose: 'performance_validation',
      lifecycle: 'draft',
      owners: [`${domainId}@example.test`],
      members: [],
      roles: [],
      policies: [],
    }));
  }

  return { projectRoot, seed, counts, digest: fixtureDigest(projectRoot) };
}

export function fixtureDigest(projectRoot) {
  const hash = createHash('sha256');
  for (const file of walk(projectRoot).sort()) {
    const local = relative(projectRoot, file).replace(/\\/g, '/');
    if (local.startsWith('.dql/')) continue;
    hash.update(local).update('\0').update(readFileSync(file)).update('\0');
  }
  return hash.digest('hex');
}

export function fixtureFileCount(projectRoot) {
  return walk(projectRoot).length;
}

function walk(root) {
  if (!existsSync(root)) return [];
  const output = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...walk(path));
    else if (entry.isFile() && statSync(path).size >= 0) output.push(path);
  }
  return output;
}
