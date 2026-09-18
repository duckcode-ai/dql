/**
 * Browser-safe contract for evidence that makes an already-aggregated Dataset
 * safe to roll up.  It deliberately describes evidence; it does not produce
 * it.  Only the App runtime may create a positive proof after a full-source
 * check on the active warehouse read scope.
 */

import {
  datasetMeasureField,
  datasetPhysicalField,
  type DatasetDescriptor,
  type DatasetMeasureField,
} from './descriptor.js';
import type { TileQuery } from '../apps/tile-query-types.js';

export type DatasetAggregateComponentProofStatus =
  | 'passed'
  | 'unsafe_overlap'
  | 'unsupported_source_shape'
  | 'probe_failed'
  | 'cancelled'
  | 'source_changed'
  | 'target_changed'
  | 'snapshot_unsupported';

/** Exact server-resolved binding for one ephemeral aggregate proof. */
export interface DatasetAggregateComponentBindingV1 {
  sourceId: string;
  sourceRevision: string;
  contractFingerprint: string;
  /** Prepared complete-source SQL, not a tile SQL preview. */
  sourceSqlFingerprint: string;
  /** Source parameters only. Dashboard/page filters never participate. */
  parameterFingerprint: string;
  targetFingerprint: string;
  snapshotId: string;
  snapshotFingerprint: string;
  /**
   * Present only when a data-dependent COUNT(DISTINCT) membership probe ran
   * inside an actual scoped connector transaction. Direct SUM mappings are
   * algebraic source-expression evidence and must not invent a scope id.
   */
  readScopeId?: string;
  /**
   * The resolved schema/session context copied onto the dedicated connection.
   * A scope id alone does not establish that a new DuckDB connection retained
   * the source namespace selected by the normal App execution connection.
   */
  readScopeContextFingerprint?: string;
  groupingFingerprint: string;
  timeBucketFingerprint: string;
  timeGrain: string;
}

/**
 * One direct native aggregate component.  Fingerprints avoid retaining raw
 * source expressions, keys, or values in receipts and browser payloads.
 */
export interface DatasetAggregateComponentV1 {
  alias: string;
  targetOperation: 'sum';
  sourceAggregate: 'sum' | 'count_distinct';
  sourceExpressionFingerprint: string;
  /** Present only for COUNT(DISTINCT raw_key); the key itself is never retained. */
  countedKeyFingerprint?: string;
}

/**
 * A run-owned proof.  It is intentionally not a descriptor artifact: a later
 * run must perform fresh warehouse checks, even when this object is retained
 * as historical receipt provenance.
 */
export interface DatasetAggregateComponentProofV1 {
  version: 1;
  status: DatasetAggregateComponentProofStatus;
  binding: DatasetAggregateComponentBindingV1;
  components: DatasetAggregateComponentV1[];
  /** Redacted existential result for distinct-key membership checks. */
  evidence: {
    checkedAt: string;
    probeFingerprint: string;
    /** Direct SUM mappings are structural; distinct keys require one read scope. */
    method: 'direct_sum_mapping' | 'distinct_membership_scope';
    checkedDistinctComponents: string[];
    overlapDetected?: boolean;
  };
  fingerprint: string;
}

export type DatasetAggregateComponentRequirementCode =
  | 'DATASET_COMPONENT_MEASURE_UNKNOWN'
  | 'DATASET_COMPONENT_UNSUPPORTED_AGGREGATION'
  | 'DATASET_COMPONENT_SOURCE_MISSING'
  | 'DATASET_COMPONENT_FIELD_UNRESOLVED'
  | 'DATASET_COMPONENT_FIELD_UNREVIEWED';

export interface DatasetAggregateComponentRequirementDiagnostic {
  code: DatasetAggregateComponentRequirementCode;
  measure: string;
  message: string;
}

export interface DatasetAggregateComponentRequirement {
  measure: string;
  component: string;
  targetOperation: 'sum';
}

/**
 * Structural component requirements for selected measures.  This validates
 * only the Git-owned query definition.  It must be paired with a fresh
 * server-created DatasetAggregateComponentProofV1 before execution.
 */
export interface DatasetAggregateComponentRequirements {
  requirements: DatasetAggregateComponentRequirement[];
  diagnostics: DatasetAggregateComponentRequirementDiagnostic[];
  /** Measure-local result used by deterministic query validation. */
  byMeasure: ReadonlyMap<string, { supported: boolean; components: string[] }>;
  supported: boolean;
}

export function datasetAggregateComponentRequirements(
  descriptor: DatasetDescriptor,
  query: Pick<TileQuery, 'measures'>,
): DatasetAggregateComponentRequirements {
  const requirements: DatasetAggregateComponentRequirement[] = [];
  const diagnostics: DatasetAggregateComponentRequirementDiagnostic[] = [];
  const byMeasure = new Map<string, { supported: boolean; components: string[] }>();

  for (const selection of query.measures) {
    const measure = datasetMeasureField(descriptor, selection.measure);
    const normalizedMeasure = selection.measure.trim().toLowerCase();
    if (!measure) {
      diagnostics.push({
        code: 'DATASET_COMPONENT_MEASURE_UNKNOWN',
        measure: selection.measure,
        message: `Selected measure ${selection.measure} no longer resolves to a Dataset component contract.`,
      });
      byMeasure.set(normalizedMeasure, { supported: false, components: [] });
      continue;
    }
    const components = measureComponentNames(measure);
    if (!components) {
      diagnostics.push({
        code: measure.aggregation === 'sum' || measure.aggregation === 'ratio'
          ? 'DATASET_COMPONENT_SOURCE_MISSING'
          : 'DATASET_COMPONENT_UNSUPPORTED_AGGREGATION',
        measure: measure.name,
        message: measure.aggregation === 'sum' || measure.aggregation === 'ratio'
          ? `${measure.name} does not name all native physical components required to recompute it.`
          : `${measure.name} uses ${measure.aggregation}, which cannot be rolled up from an aggregate Dataset component in this App runtime.`,
      });
      byMeasure.set(normalizedMeasure, { supported: false, components: [] });
      continue;
    }

    let supported = true;
    const boundComponents: string[] = [];
    for (const component of components) {
      const physical = datasetPhysicalField(descriptor, component);
      if (!physical) {
        diagnostics.push({
          code: 'DATASET_COMPONENT_FIELD_UNRESOLVED',
          measure: measure.name,
          message: `${measure.name} depends on physical component ${component}, which is no longer declared by this Dataset.`,
        });
        supported = false;
        continue;
      }
      if (physical.status !== 'approved') {
        diagnostics.push({
          code: 'DATASET_COMPONENT_FIELD_UNREVIEWED',
          measure: measure.name,
          message: `${measure.name} depends on suggested physical component ${physical.name}; review it before rolling this Dataset up.`,
        });
        supported = false;
        continue;
      }
      boundComponents.push(physical.name);
    }
    const uniqueComponents = Array.from(new Set(boundComponents));
    byMeasure.set(normalizedMeasure, { supported, components: uniqueComponents });
    if (supported) {
      for (const component of uniqueComponents) {
        requirements.push({ measure: measure.name, component, targetOperation: 'sum' });
      }
    }
  }

  const deduped = new Map<string, DatasetAggregateComponentRequirement>();
  for (const requirement of requirements) {
    deduped.set(`${requirement.component.toLowerCase()}:${requirement.targetOperation}`, requirement);
  }
  return {
    requirements: [...deduped.values()].sort((left, right) => left.component.localeCompare(right.component)),
    diagnostics,
    byMeasure,
    supported: diagnostics.length === 0,
  };
}

/** True only when an ephemeral proof covers every selected physical component. */
export function datasetAggregateComponentProofCovers(
  proof: DatasetAggregateComponentProofV1 | undefined,
  requirements: readonly DatasetAggregateComponentRequirement[],
  /**
   * The binding the caller is about to execute under. A proof covers a
   * rollup only for the exact source revision, contract, target, and time
   * grain it was produced for; every supplied field must match.
   */
  expected?: Partial<DatasetAggregateComponentBindingV1>,
): boolean {
  if (!proof || proof.version !== 1 || proof.status !== 'passed') return false;
  if (expected) {
    const binding = proof.binding as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected)) {
      if (value !== undefined && binding[key] !== value) return false;
    }
  }
  const covered = new Set(proof.components
    .filter((component) => component.targetOperation === 'sum')
    .map((component) => component.alias.trim().toLowerCase()));
  return requirements.every((requirement) => covered.has(requirement.component.trim().toLowerCase()));
}

function measureComponentNames(measure: DatasetMeasureField): string[] | undefined {
  if (measure.aggregation === 'ratio') {
    const numerator = measure.numerator?.trim();
    const denominator = measure.denominator?.trim();
    return numerator && denominator ? [numerator, denominator] : undefined;
  }
  if (measure.aggregation !== 'sum') return undefined;
  if (measure.expression) {
    const dependencies = measure.dependsOn.map((dependency) => dependency.trim()).filter(Boolean);
    return dependencies.length > 0 ? dependencies : undefined;
  }
  const source = measure.from?.trim();
  return source ? [source] : undefined;
}
