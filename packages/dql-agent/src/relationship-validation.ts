import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { relationshipKeyTypes, relationshipValidationProofFingerprint, type DQLManifest, type ManifestFanoutPolicy, type ManifestRelationshipCardinality, type ManifestRelationshipValidationEvidence } from '@duckcodeailabs/dql-core';

/**
 * ONE PROOF, TWO ASKERS. Domain Studio's Validate action and Ask's warehouse
 * proof used to ask the warehouse different questions about the same pair of
 * relations and write down different evidence. This is the one statement and
 * the one evidence shape both use now: whoever ran it, the evidence is what a
 * certification reuses (REL-005).
 */

export interface RelationshipValidationSpec {
  fromRelation: string;
  toRelation: string;
  keys: Array<{ from: string; to: string }>;
  cardinality: ManifestRelationshipCardinality;
  fanout: ManifestFanoutPolicy;
  /** The key columns' types when known, so the proof fingerprint notices a type change. */
  keyTypes?: Array<{ from?: string; to?: string }>;
}

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export function assertSafeRelationshipIdentifier(identifier: string): string {
  if (!SAFE_IDENTIFIER.test(identifier)) throw new Error(`Unsafe SQL identifier in relationship validation: ${identifier}`);
  return identifier;
}

export function quoteQualifiedRelation(relation: string, quote: (identifier: string) => string): string {
  return relation.replace(/"/g, '').split('.').filter(Boolean).map((part) => quote(assertSafeRelationshipIdentifier(part))).join('.');
}

/** The validation statement: row counts, null keys, max rows per key on both sides, joined rows, and rows the join would drop. */
export function relationshipValidationSql(spec: RelationshipValidationSpec, quote: (identifier: string) => string): string {
  if (!spec.keys.length) throw new Error('At least one join key pair is required.');
  const safeQuote = (identifier: string) => quote(assertSafeRelationshipIdentifier(identifier));
  const fromRelation = quoteQualifiedRelation(spec.fromRelation, quote);
  const toRelation = quoteQualifiedRelation(spec.toRelation, quote);
  const fromNull = spec.keys.map((key) => `f.${safeQuote(key.from)} IS NULL`).join(' OR ');
  const toNull = spec.keys.map((key) => `t.${safeQuote(key.to)} IS NULL`).join(' OR ');
  const join = spec.keys.map((key) => `f.${safeQuote(key.from)} = t.${safeQuote(key.to)}`).join(' AND ');
  const fromKeys = spec.keys.map((key) => safeQuote(key.from)).join(', ');
  const toKeys = spec.keys.map((key) => safeQuote(key.to)).join(', ');
  const firstToKey = safeQuote(spec.keys[0]!.to);
  return `WITH
from_counts AS (SELECT COUNT(*) AS rows, SUM(CASE WHEN ${fromNull} THEN 1 ELSE 0 END) AS null_keys FROM ${fromRelation} f),
to_counts AS (SELECT COUNT(*) AS rows, SUM(CASE WHEN ${toNull} THEN 1 ELSE 0 END) AS null_keys FROM ${toRelation} t),
from_max AS (SELECT COALESCE(MAX(key_count), 0) AS max_per_key FROM (SELECT COUNT(*) AS key_count FROM ${fromRelation} GROUP BY ${fromKeys}) x),
to_max AS (SELECT COALESCE(MAX(key_count), 0) AS max_per_key FROM (SELECT COUNT(*) AS key_count FROM ${toRelation} GROUP BY ${toKeys}) x),
joined AS (SELECT COUNT(*) AS rows FROM ${fromRelation} f JOIN ${toRelation} t ON ${join}),
unmatched AS (SELECT COUNT(*) AS rows FROM ${fromRelation} f LEFT JOIN ${toRelation} t ON ${join} WHERE t.${firstToKey} IS NULL)
SELECT from_counts.rows AS from_rows, to_counts.rows AS to_rows, joined.rows AS joined_rows,
  from_counts.null_keys AS from_null_keys, to_counts.null_keys AS to_null_keys,
  unmatched.rows AS unmatched_from, from_max.max_per_key AS max_from_per_key, to_max.max_per_key AS max_to_per_key
FROM from_counts, to_counts, joined, unmatched, from_max, to_max`;
}

const numeric = (value: unknown): number => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim()) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
  return 0;
};

/** Read a validation result row, case-insensitively, into the evidence shape Domain Studio certifies against. */
export function relationshipEvidenceFromRow(row: Record<string, unknown>, spec: RelationshipValidationSpec, sql: string, checkedAt = new Date()): ManifestRelationshipValidationEvidence {
  const get = (name: string): unknown => row[name] ?? row[name.toUpperCase()];
  const maxFromPerKey = numeric(get('max_from_per_key'));
  const maxToPerKey = numeric(get('max_to_per_key'));
  const cardinalityPassed = spec.cardinality === 'one_to_one'
    ? maxFromPerKey <= 1 && maxToPerKey <= 1
    : spec.cardinality === 'one_to_many'
      ? maxFromPerKey <= 1
      : spec.cardinality === 'many_to_one'
        ? maxToPerKey <= 1
        : false;
  const policyPassed = spec.fanout === 'safe' && cardinalityPassed;
  const queryFingerprint = createHash('sha256').update(sql).digest('hex');
  return {
    status: policyPassed ? 'passed' : 'failed',
    checkedAt: checkedAt.toISOString(),
    queryFingerprint,
    proofFingerprint: relationshipValidationProofFingerprint({
      fromRelation: spec.fromRelation, toRelation: spec.toRelation, keys: spec.keys, cardinality: spec.cardinality, fanout: spec.fanout, queryFingerprint,
      ...(spec.keyTypes ? { keyTypes: spec.keyTypes } : {}),
    }),
    fromRows: numeric(get('from_rows')),
    toRows: numeric(get('to_rows')),
    joinedRows: numeric(get('joined_rows')),
    fromNullKeys: numeric(get('from_null_keys')),
    toNullKeys: numeric(get('to_null_keys')),
    unmatchedFrom: numeric(get('unmatched_from')),
    maxFromPerKey,
    maxToPerKey,
    message: policyPassed
      ? 'Warehouse evidence matches the declared cardinality and safe fanout policy.'
      : 'Warehouse evidence does not prove the declared cardinality and safe fanout policy.',
  };
}

/** Run the one statement and read the one evidence. */
export async function validateRelationshipOnWarehouse(
  spec: RelationshipValidationSpec,
  execute: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>,
  quote: (identifier: string) => string,
  checkedAt = new Date(),
): Promise<ManifestRelationshipValidationEvidence> {
  const sql = relationshipValidationSql(spec, quote);
  const result = await execute(sql);
  return relationshipEvidenceFromRow(result.rows[0] ?? {}, spec, sql, checkedAt);
}

/**
 * The join keys' data types as dbt's catalog records them, read from the
 * `catalog.json` beside the manifest the project compiled from. The compiler
 * folds these into the proof fingerprint, so a validator that omits them writes
 * evidence the next compile calls stale; both askers therefore read the same
 * file. Unknown relations or a missing catalog leave every type undefined.
 */
export function catalogKeyTypes(
  manifest: DQLManifest | undefined,
  spec: Pick<RelationshipValidationSpec, 'fromRelation' | 'toRelation' | 'keys'>,
  readCatalog: (path: string) => Record<string, unknown> | undefined = readCatalogFile,
): Array<{ from?: string; to?: string }> {
  const manifestPath = manifest?.dbtProvenance?.manifestPath;
  if (!manifestPath) return spec.keys.map(() => ({}));
  const catalog = readCatalog(join(dirname(manifestPath), 'catalog.json'));
  if (!catalog) return spec.keys.map(() => ({}));
  const nodes = manifest?.dbtProvenance?.nodes ?? {};
  const uniqueIdOf = (relation: string): string | undefined => Object.values(nodes)
    .find((node) => node.relation?.toLowerCase() === relation.toLowerCase())?.uniqueId;
  const typesOf = (relation: string): Map<string, string> | undefined => {
    const uniqueId = uniqueIdOf(relation);
    if (!uniqueId) return undefined;
    const entry = (catalog.nodes as Record<string, unknown> | undefined)?.[uniqueId] ?? (catalog.sources as Record<string, unknown> | undefined)?.[uniqueId];
    const columns = (entry as { columns?: Record<string, { type?: unknown }> } | undefined)?.columns;
    if (!columns) return undefined;
    const types = new Map<string, string>();
    for (const [name, column] of Object.entries(columns)) {
      if (typeof column?.type === 'string' && column.type) types.set(name, column.type.toLowerCase());
    }
    return types;
  };
  return relationshipKeyTypes(spec.keys, typesOf(spec.fromRelation), typesOf(spec.toRelation));
}

function readCatalogFile(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}
