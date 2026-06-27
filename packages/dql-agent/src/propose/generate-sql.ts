/**
 * Deterministic business-block SQL generation for `dql propose` (Slice 2).
 *
 * Replaces the old `SELECT * FROM {{ ref(model) }}` passthrough with SQL that
 * reflects the model's business shape — still a SCAFFOLD the human refines, but
 * one whose value (grain, declared outputs, measure aggregation) is real:
 *
 *   - metric-backed model (semantic measure) → a real AGGREGATION block: the
 *     measure aggregation + declared dimensions/grain from the semantic manifest
 *     (the existing `metric_wrapper` pattern). NOT select-star.
 *   - entity / dim mart → a NARROWED projection over the canonical columns
 *     (grain + declared outputs), not a blind `SELECT *`.
 *   - everything else in the selection → a narrowed projection over the declared
 *     outputs (falls back to `SELECT *` only when no columns are known).
 *
 * Everything here is deterministic (no LLM). AI enrichment stays an isolated,
 * optional hook elsewhere — this module only uses dbt + semantic evidence.
 */

import type { DbtArtifacts, DbtModelNode } from './dbt-artifacts.js';
import type { ProposalInference } from './propose.js';

/** Map MetricFlow agg names to a SQL aggregate expression over `expr`. */
function aggToSql(agg: string | undefined, expr: string): string {
  switch ((agg ?? '').toLowerCase()) {
    case 'count_distinct':
      return `COUNT(DISTINCT ${expr})`;
    case 'count':
      return `COUNT(${expr})`;
    case 'average':
    case 'avg':
      return `AVG(${expr})`;
    case 'min':
      return `MIN(${expr})`;
    case 'max':
      return `MAX(${expr})`;
    case 'median':
      return `MEDIAN(${expr})`;
    case 'sum':
    case 'sum_boolean':
    default:
      return `SUM(${expr})`;
  }
}

/** A safe SQL identifier alias for a measure/metric. */
function aliasFor(name: string): string {
  const safe = name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return safe || 'metric';
}

/**
 * Build an AGGREGATION query for a metric-backed model from the semantic
 * manifest: group by the declared dimensions/grain, aggregate each bound
 * measure. Returns undefined when there is no usable semantic measure (caller
 * falls back to a projection).
 */
function buildMetricAggregation(model: DbtModelNode, artifacts: DbtArtifacts): string | undefined {
  const metrics = artifacts.semanticMetrics.filter(
    (m) => m.model && m.model.toLowerCase() === model.name.toLowerCase() && (m.measure || m.expr),
  );
  if (metrics.length === 0) return undefined;

  const semanticModel = artifacts.semanticModels.get(model.name);
  // Group-by dimensions: declared time dimensions first, then the primary entity.
  const groupCols: string[] = [];
  if (semanticModel) {
    for (const dim of semanticModel.timeDimensions) {
      if (!groupCols.includes(dim)) groupCols.push(dim);
    }
    if (semanticModel.primaryEntity && !groupCols.includes(semanticModel.primaryEntity)) {
      groupCols.push(semanticModel.primaryEntity);
    }
  }

  // One aggregate column per distinct measure (dedupe by alias).
  const seen = new Set<string>();
  const aggregates: string[] = [];
  for (const metric of metrics) {
    const expr = metric.expr || metric.measure!;
    const alias = aliasFor(metric.measure || metric.name);
    if (seen.has(alias)) continue;
    seen.add(alias);
    aggregates.push(`${aggToSql(metric.agg, expr)} AS ${alias}`);
  }
  if (aggregates.length === 0) return undefined;

  const ref = `{{ ref('${model.name}') }}`;
  const selectLines = [...groupCols, ...aggregates];
  const select = selectLines.map((line) => `  ${line}`).join(',\n');
  let sql = `SELECT\n${select}\nFROM ${ref}`;
  if (groupCols.length > 0) {
    sql += `\nGROUP BY ${groupCols.map((_, i) => i + 1).join(', ')}`;
  }
  return sql;
}

/**
 * Build a NARROWED projection over the model's declared outputs (canonical
 * columns), grain column first when known. Falls back to `SELECT *` only when no
 * columns are known at all.
 */
function buildProjection(model: DbtModelNode, inference: ProposalInference): string {
  const ref = `{{ ref('${model.name}') }}`;
  const outputs = inference.declaredOutputs ?? [];
  if (outputs.length === 0) {
    return `SELECT * FROM ${ref}`;
  }
  // Grain column leads the projection so the row identity is obvious.
  const grain = inference.grain;
  const ordered = grain && outputs.includes(grain)
    ? [grain, ...outputs.filter((c) => c !== grain)]
    : outputs;
  const select = ordered.map((c) => `  ${c}`).join(',\n');
  return `SELECT\n${select}\nFROM ${ref}`;
}

/**
 * Build the business-block SQL for a selected model. Deterministic; chooses the
 * aggregation form for metric-backed models and a narrowed projection otherwise.
 */
export function buildBusinessQuery(
  model: DbtModelNode,
  inference: ProposalInference,
  artifacts: DbtArtifacts,
): string {
  if (inference.pattern === 'metric_wrapper') {
    const aggregation = buildMetricAggregation(model, artifacts);
    if (aggregation) return aggregation;
    // No usable measure metadata → fall back to a narrowed projection.
  }
  return buildProjection(model, inference);
}
