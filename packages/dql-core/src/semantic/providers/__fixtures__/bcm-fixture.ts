/**
 * The "bcm" fixture — a dbt semantic project mirroring the office reproduction
 * that surfaced DQL's semantic-catalog gaps (bare vs entity-qualified names,
 * discarded time grains, measure/metric conflation, derived metrics).
 *
 * Three semantic models:
 *   - bcm_hdr    primary entity `bcm_hdr`; carries the customer dimension and a
 *                MONTH-grain time dimension (proves real-grain extraction).
 *   - bcm_dtl    foreign entity → bcm_hdr (a join hop for multi-hop qualified
 *                names); its own measure.
 *   - bcm_ccu_pc a disjoint model (no join to bcm_hdr) — proves the
 *                `no_join_path` / `not_shared_across_metrics` incompatibility
 *                reasons.
 *
 * Metrics: `total_bcm` (simple, natively composable), `percent_mom_bcm`
 * (derived — catalog-only, requires a runtime).
 *
 * Both the source-YAML and semantic_manifest.json parse paths are provided so
 * tests can exercise either. Written into a caller-supplied temp dir to match
 * the existing dbt-provider test style.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const BCM_SEMANTIC_YAML = `
semantic_models:
  - name: bcm_hdr
    description: "Billed consumption header, one row per customer per month."
    model: "ref('bcm_hdr')"
    defaults:
      agg_time_dimension: consumption_month
    entities:
      - name: bcm_hdr
        type: primary
        expr: bcm_hdr_id
    measures:
      - name: bcm_amount
        description: "Billed consumption amount."
        agg: sum
        expr: bcm_amount
        create_metric: false
    dimensions:
      - name: customer_name
        type: categorical
        expr: customer_name
      - name: consumption_month
        type: time
        type_params:
          time_granularity: month

  - name: bcm_dtl
    description: "Billed consumption detail lines."
    model: "ref('bcm_dtl')"
    entities:
      - name: bcm_dtl
        type: primary
        expr: bcm_dtl_id
      - name: bcm_hdr
        type: foreign
        expr: bcm_hdr_id
    measures:
      - name: bcm_line_amount
        agg: sum
        expr: line_amount
    dimensions:
      - name: line_status
        type: categorical
        expr: line_status

  - name: bcm_ccu_pc
    description: "Cloud consumption units by product category — disjoint model."
    model: "ref('bcm_ccu_pc')"
    entities:
      - name: bcm_ccu_pc
        type: primary
        expr: bcm_ccu_pc_id
    measures:
      - name: ccu_amount
        agg: sum
        expr: ccu_amount
    dimensions:
      - name: product_category
        type: categorical
        expr: product_category

metrics:
  - name: total_bcm
    label: "Total BCM"
    description: "Total billed consumption."
    type: simple
    type_params:
      measure: bcm_amount
    meta:
      format: currency

  - name: percent_mom_bcm
    label: "Percent MoM BCM"
    description: "Month-over-month percent change in billed consumption."
    type: derived
    type_params:
      expr: "(total_bcm - total_bcm_prev) / nullif(total_bcm_prev, 0)"
      metrics:
        - name: total_bcm
        - name: total_bcm
          offset_window: 1 month
          alias: total_bcm_prev
    meta:
      format: percent
`;

/** Write the bcm project as source YAML under `<dir>/models/`. Forces the
 *  raw-YAML parse path (no target/ artifacts present). */
export function writeBcmYamlProject(dir: string): void {
  const modelsDir = join(dir, 'models');
  mkdirSync(modelsDir, { recursive: true });
  writeFileSync(join(modelsDir, 'bcm_semantic.yml'), BCM_SEMANTIC_YAML, 'utf-8');
}

/**
 * A minimal semantic_manifest.json for the same catalog (keyed-by-unique-id
 * shape dbt emits). Forces the semantic_manifest parse path.
 */
export function bcmSemanticManifest(): Record<string, unknown> {
  return {
    semantic_models: {
      'semantic_model.demo.bcm_hdr': {
        name: 'bcm_hdr',
        model: "ref('bcm_hdr')",
        defaults: { agg_time_dimension: 'consumption_month' },
        entities: [{ name: 'bcm_hdr', type: 'primary', expr: 'bcm_hdr_id' }],
        measures: [{ name: 'bcm_amount', agg: 'sum', expr: 'bcm_amount' }],
        dimensions: [
          { name: 'customer_name', type: 'categorical', expr: 'customer_name' },
          { name: 'consumption_month', type: 'time', type_params: { time_granularity: 'month' } },
        ],
      },
      'semantic_model.demo.bcm_dtl': {
        name: 'bcm_dtl',
        model: "ref('bcm_dtl')",
        entities: [
          { name: 'bcm_dtl', type: 'primary', expr: 'bcm_dtl_id' },
          { name: 'bcm_hdr', type: 'foreign', expr: 'bcm_hdr_id' },
        ],
        measures: [{ name: 'bcm_line_amount', agg: 'sum', expr: 'line_amount' }],
        dimensions: [{ name: 'line_status', type: 'categorical', expr: 'line_status' }],
      },
      'semantic_model.demo.bcm_ccu_pc': {
        name: 'bcm_ccu_pc',
        model: "ref('bcm_ccu_pc')",
        entities: [{ name: 'bcm_ccu_pc', type: 'primary', expr: 'bcm_ccu_pc_id' }],
        measures: [{ name: 'ccu_amount', agg: 'sum', expr: 'ccu_amount' }],
        dimensions: [{ name: 'product_category', type: 'categorical', expr: 'product_category' }],
      },
    },
    metrics: {
      'metric.demo.total_bcm': {
        name: 'total_bcm',
        label: 'Total BCM',
        type: 'simple',
        type_params: { measure: 'bcm_amount' },
        meta: { format: 'currency' },
      },
      'metric.demo.percent_mom_bcm': {
        name: 'percent_mom_bcm',
        label: 'Percent MoM BCM',
        type: 'derived',
        type_params: {
          expr: '(total_bcm - total_bcm_prev) / nullif(total_bcm_prev, 0)',
          metrics: [
            { name: 'total_bcm' },
            { name: 'total_bcm', offset_window: '1 month', alias: 'total_bcm_prev' },
          ],
        },
        meta: { format: 'percent' },
      },
    },
  };
}

/** Write the bcm project as `<dir>/target/semantic_manifest.json`. */
export function writeBcmManifestProject(dir: string): void {
  const targetDir = join(dir, 'target');
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, 'semantic_manifest.json'), JSON.stringify(bcmSemanticManifest()), 'utf-8');
}
