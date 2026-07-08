/**
 * Grain ledger + static fan-out detection (W1.3).
 *
 * The class-B (wrong-number) failure mode is a VALID query over real columns that
 * returns an inflated total because an additive aggregate is computed after a
 * one-to-many join — every row of the aggregated relation is multiplied by the
 * number of matching rows on the "many" side. `validateSql` proves identifiers
 * exist; it says nothing about join grain. This module adds a deterministic,
 * zero-LLM check: given per-relation unique keys (the ledger) and the parsed join
 * graph, flag an additive aggregate over relation R when R is joined to a relation
 * S on a column that is NOT a unique key of S (so S contributes multiple rows per
 * R row). It is intentionally conservative — no key data for a relation ⇒ no flag —
 * so it never demotes a correct answer; it is wired warn-only.
 */
import { analyzeSqlReferences, type SqlReferenceAnalysis } from '@duckcodeailabs/dql-core';
import type { MetadataObject } from './catalog.js';

export interface RelationGrain {
  /** Normalized relation tail token (e.g. `fct_orders`). */
  relation: string;
  /** Columns that ALONE uniquely identify a row (single-column keys only). */
  uniqueKeys: Set<string>;
  source: string;
}

export type GrainLedger = Map<string, RelationGrain>;

export interface FanoutRisk {
  aggregate: string;
  aggregatedRelation: string;
  fanoutRelation: string;
  joinColumn: string;
  message: string;
}

/** Additive aggregates whose value changes when rows are duplicated. MIN/MAX are safe. */
const ADDITIVE_AGGREGATES = new Set(['SUM', 'AVG', 'COUNT']);

function normalizeRelationTail(relation: string | undefined): string | undefined {
  if (!relation) return undefined;
  const tail = relation.split('.').at(-1) ?? relation;
  const cleaned = tail.replace(/["`]/g, '').trim().toLowerCase();
  return cleaned || undefined;
}

function normalizeColumn(column: string): string {
  return column.replace(/["`]/g, '').trim().toLowerCase();
}

function addUniqueKey(ledger: GrainLedger, relation: string | undefined, column: string, source: string): void {
  const key = normalizeRelationTail(relation);
  if (!key) return;
  const existing = ledger.get(key);
  if (existing) {
    existing.uniqueKeys.add(normalizeColumn(column));
    return;
  }
  ledger.set(key, { relation: key, uniqueKeys: new Set([normalizeColumn(column)]), source });
}

/**
 * Build a grain ledger from catalog objects. v0 sources single-column unique keys
 * from DataLex entity primary-key fields and any dbt/catalog object that carries a
 * `primaryKey` / `uniqueColumns` payload (the hook dbt unique-test extraction fills
 * in W5.3). Composite keys are intentionally skipped — a single column of a
 * composite key is not unique on its own, so treating it as one would miss fan-out.
 */
export function buildGrainLedger(objects: MetadataObject[]): GrainLedger {
  const ledger: GrainLedger = new Map();
  for (const object of objects) {
    if (object.objectType === 'datalex_entity') {
      const binding = object.payload?.binding as { ref?: string } | undefined;
      const relation = binding?.ref ?? object.fullName ?? object.name;
      const fields = Array.isArray(object.payload?.fields) ? object.payload!.fields as Array<Record<string, unknown>> : [];
      const primaryKeys = fields.filter((field) => field?.primaryKey === true && typeof field.name === 'string');
      // Only a lone primary key column is a single-column unique key.
      if (primaryKeys.length === 1) {
        addUniqueKey(ledger, relation, String(primaryKeys[0].name), 'datalex primary key');
      }
      continue;
    }
    // Generic hook: an object may declare its own key columns (dbt constraints /
    // unique tests once extracted, or explicit metadata). uniqueColumns lists
    // single-column unique keys; primaryKey is a single-column PK.
    const uniqueColumns = object.payload?.uniqueColumns;
    if (Array.isArray(uniqueColumns)) {
      const relation = metadataRelationName(object);
      for (const column of uniqueColumns) {
        if (typeof column === 'string') addUniqueKey(ledger, relation, column, 'declared unique column');
      }
    }
    const primaryKey = object.payload?.primaryKey;
    if (typeof primaryKey === 'string') {
      addUniqueKey(ledger, metadataRelationName(object), primaryKey, 'declared primary key');
    }
  }
  return ledger;
}

function metadataRelationName(object: MetadataObject): string | undefined {
  const relation = object.payload?.relation;
  if (typeof relation === 'string' && relation.trim()) return relation;
  return object.fullName ?? object.name;
}

/**
 * Detect additive aggregates that risk fan-out double-counting given the ledger.
 * An aggregate over relation R is flagged when R is joined to a relation S on a
 * column that is NOT a known unique key of S (S can contribute many rows per R row).
 */
export function detectFanoutRisks(analysis: SqlReferenceAnalysis, ledger: GrainLedger): FanoutRisk[] {
  if (!analysis.parsed || analysis.joins.length === 0) return [];
  const risks: FanoutRisk[] = [];
  const seen = new Set<string>();
  for (const aggregate of analysis.aggregates) {
    if (aggregate.distinct) continue;
    if (!ADDITIVE_AGGREGATES.has(aggregate.func)) continue;
    const aggregatedRelation = normalizeRelationTail(aggregate.relation);
    if (!aggregatedRelation) continue; // COUNT(*) / unattributed — out of scope for v0
    for (const join of analysis.joins) {
      const left = normalizeRelationTail(join.leftRelation);
      const right = normalizeRelationTail(join.rightRelation);
      let counterpart: string | undefined;
      let counterpartColumn: string | undefined;
      if (left === aggregatedRelation) {
        counterpart = right;
        counterpartColumn = normalizeColumn(join.rightColumn);
      } else if (right === aggregatedRelation) {
        counterpart = left;
        counterpartColumn = normalizeColumn(join.leftColumn);
      } else {
        continue;
      }
      if (!counterpart || !counterpartColumn) continue;
      const counterpartGrain = ledger.get(counterpart);
      if (!counterpartGrain) continue; // unknown counterpart grain → conservative, no flag
      if (counterpartGrain.uniqueKeys.has(counterpartColumn)) continue; // N:1 — safe
      const aggregateLabel = `${aggregate.func}(${aggregate.column ?? '*'})`;
      const dedupeKey = `${aggregateLabel}|${aggregatedRelation}|${counterpart}|${counterpartColumn}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      risks.push({
        aggregate: aggregateLabel,
        aggregatedRelation,
        fanoutRelation: counterpart,
        joinColumn: counterpartColumn,
        message:
          `Possible fan-out: ${aggregateLabel} aggregates ${aggregatedRelation}, which is joined one-to-many to ` +
          `${counterpart} on ${counterpartColumn} (not a unique key of ${counterpart}). This can double-count. ` +
          `Pre-aggregate ${aggregatedRelation} in a CTE before joining, or use COUNT(DISTINCT ...).`,
      });
    }
  }
  return risks;
}

/**
 * Convenience wrapper: parse the SQL, build the ledger from the objects, and return
 * fan-out warning strings. Best-effort — any parse failure yields no warnings.
 */
export function fanoutWarningsForSql(sql: string, objects: MetadataObject[], dialect = 'duckdb'): string[] {
  try {
    const analysis = analyzeSqlReferences(sql, dialect);
    if (!analysis.parsed) return [];
    const ledger = buildGrainLedger(objects);
    if (ledger.size === 0) return [];
    return detectFanoutRisks(analysis, ledger).map((risk) => risk.message);
  } catch {
    return [];
  }
}
