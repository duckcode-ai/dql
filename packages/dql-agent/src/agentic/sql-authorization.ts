/**
 * Exact generated-SQL execution authorization.
 *
 * This is deliberately a server-only, in-memory capability. It is created by
 * the analyst loop, passed through one call chain, and consumed by the local
 * execution host. It is never an artifact, response field, cache entry, or
 * bearer token.
 */

import { createHash, randomUUID } from 'node:crypto';

export type IdentifierEvidence = 'compiler' | 'preview' | 'schema_tool' | 'catalog';

export interface ExecutionAuthorizationBindingV1 {
  runId: string;
  executionId: string;
  snapshotId: string;
  /** The router plan that selected the target, when a plan exists. */
  planId?: string;
  /** The server-observed physical execution target. */
  targetFingerprint?: string;
  /** Canonical host bindings, never raw parameter values. */
  bindingsFingerprint: string;
}

export interface FinalSqlAuthorizationV1 extends ExecutionAuthorizationBindingV1 {
  version: 1;
  /** Fully-qualified identities proven during this exact loop. */
  provenIdentifiers: string[];
  /** Catalog evidence informs retrieval only and never authorizes execution. */
  evidence: Record<string, IdentifierEvidence>;
  /** SHA-256 of the exact prepared bytes sent to the connector. */
  sqlFingerprint: string;
  mintedAt: string;
}

/**
 * Opaque handoff from the analyst loop to its host execution closure. Do not
 * persist or surface this type; its only valid lifetime is one request/child.
 */
export interface AgenticSqlExecutionCapabilityV1 extends Omit<ExecutionAuthorizationBindingV1, 'planId' | 'targetFingerprint'> {
  version: 1;
  /** Generated execution never proceeds without a frozen plan and target. */
  planId: string;
  targetFingerprint: string;
  candidateSqlFingerprint: string;
  provenIdentifiers: string[];
  evidence: Record<string, IdentifierEvidence>;
}

export interface SqlAuthorizationVerdict {
  ok: boolean;
  unproven: string[];
  drifted: boolean;
  reason?: string;
}

export interface SqlAuthorizationCheck {
  bindings?: unknown;
  runId?: string;
  executionId?: string;
  snapshotId?: string;
  planId?: string;
  targetFingerprint?: string;
}

/**
 * Per-invocation, server-only one-shot gate for analyst capabilities.
 *
 * The host creates one gate for one answer/compound child. It has no registry,
 * static state, persistence, or bearer representation; it merely prevents the
 * exact same capability from crossing the physical execution boundary twice.
 */
export class AgenticExecutionCapabilityGate {
  private readonly consumed = new Set<string>();

  consume(capability: Pick<AgenticSqlExecutionCapabilityV1, 'runId' | 'executionId'>): boolean {
    const identity = `${capability.runId}\u0000${capability.executionId}`;
    if (this.consumed.has(identity)) return false;
    this.consumed.add(identity);
    return true;
  }
}

/** Parsed references supplied by the established SQL validator. */
export interface SqlAuthorizationReferences {
  relations?: readonly string[];
  columns?: ReadonlyArray<{ relation?: string; column: string }>;
}

/**
 * Historical export retained for callers. No SQL rewriting is permitted at
 * this boundary: lowercasing or stripping comments changes string literals and
 * can turn two different queries into the same authorization fingerprint.
 */
export function normalizeSqlForFingerprint(sql: string): string {
  return sql;
}

/** Hash exact SQL bytes. Formatting drift is execution drift here. */
export function fingerprintSql(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex').slice(0, 32);
}

/** Stable, redacted fingerprint for positional/named bindings. */
export function fingerprintSqlBindings(bindings: unknown): string {
  return createHash('sha256').update(stableBindingsValue(bindings), 'utf8').digest('hex').slice(0, 32);
}

export function createAgenticSqlExecutionCapability(input: {
  sql: string;
  proven: ReadonlyArray<{ identifier: string; evidence: IdentifierEvidence }>;
  runId?: string;
  executionId?: string;
  snapshotId?: string;
  planId?: string;
  targetFingerprint?: string;
  bindings?: unknown;
}): AgenticSqlExecutionCapabilityV1 | undefined {
  const runId = requiredCapabilityIdentity(input.runId);
  const snapshotId = requiredCapabilityIdentity(input.snapshotId);
  const planId = requiredCapabilityIdentity(input.planId);
  const targetFingerprint = requiredCapabilityIdentity(input.targetFingerprint);
  if (!runId || !snapshotId || !planId || !targetFingerprint) return undefined;
  const normalizedProof = normalizeProof(input.proven);
  return {
    version: 1,
    runId,
    executionId: input.executionId?.trim() || randomUUID(),
    snapshotId,
    planId,
    targetFingerprint,
    bindingsFingerprint: fingerprintSqlBindings(input.bindings ?? {}),
    candidateSqlFingerprint: fingerprintSql(input.sql),
    ...normalizedProof,
  };
}

export function mintFinalSqlAuthorization(input: {
  sql: string;
  proven: ReadonlyArray<{ identifier: string; evidence: IdentifierEvidence }>;
  runId?: string;
  executionId?: string;
  snapshotId?: string;
  planId?: string;
  targetFingerprint?: string;
  bindings?: unknown;
  now?: () => Date;
}): FinalSqlAuthorizationV1 {
  const normalizedProof = normalizeProof(input.proven);
  return {
    version: 1,
    runId: requiredIdentity(input.runId, 'run'),
    executionId: input.executionId?.trim() || randomUUID(),
    snapshotId: requiredIdentity(input.snapshotId, 'snapshot'),
    ...(input.planId?.trim() ? { planId: input.planId.trim() } : {}),
    ...(input.targetFingerprint?.trim() ? { targetFingerprint: input.targetFingerprint.trim() } : {}),
    bindingsFingerprint: fingerprintSqlBindings(input.bindings ?? {}),
    sqlFingerprint: fingerprintSql(input.sql),
    ...normalizedProof,
    mintedAt: (input.now?.() ?? new Date()).toISOString(),
  };
}

/**
 * Validate that the host is still executing the precise analyst proposal before
 * preparation. The subsequent final authorization binds the prepared bytes.
 */
export function verifyAgenticSqlExecutionCapability(
  capability: AgenticSqlExecutionCapabilityV1,
  candidateSql: string,
  check: SqlAuthorizationCheck = {},
): SqlAuthorizationVerdict {
  if (fingerprintSql(candidateSql) !== capability.candidateSqlFingerprint) {
    return failure('The generated SQL differs from the analyst-approved proposal.', true);
  }
  return verifyBinding(capability, check);
}

/**
 * Does the exact prepared statement reference only observed, non-catalog
 * identities and still match its run/target/binding authority?
 */
export function verifyFinalSql(
  authorization: FinalSqlAuthorizationV1,
  sql: string,
  referenced: ReadonlyArray<string>,
  check: SqlAuthorizationCheck = {},
): SqlAuthorizationVerdict {
  if (fingerprintSql(sql) !== authorization.sqlFingerprint) {
    return failure('The statement about to execute is not the one that was authorized.', true);
  }
  const binding = verifyBinding(authorization, check);
  if (!binding.ok) return binding;
  const executable = new Set(
    authorization.provenIdentifiers.filter((id) => authorization.evidence[id] !== 'catalog'),
  );
  const unproven = [...new Set(referenced
    .map(normalizeQualifiedIdentifier)
    .filter(Boolean)
    // No leaf fallback. `warehouse_a.orders.id` and `warehouse_b.orders.id`
    // are distinct capabilities even when their last component is the same.
    .filter((name) => !executable.has(name)))];
  if (unproven.length > 0) {
    return { ok: false, unproven, drifted: false, reason: `Nothing in this run proved: ${unproven.join(', ')}.` };
  }
  return { ok: true, unproven: [], drifted: false };
}

/**
 * Convert validator references into fully-qualified execution identities using
 * only aliases declared inside the same SQL statement. This is not a leaf-name
 * fallback: an unqualified column in a multi-relation query stays unqualified
 * and is therefore refused by the capability check.
 */
export function qualifyAuthorizationReferences(
  sql: string,
  references: SqlAuthorizationReferences,
): string[] {
  const relations = [...new Set((references.relations ?? []).filter(Boolean))];
  const aliases = relationAliasesInSql(sql);
  const byNormalizedRelation = new Map(relations.map((relation) => [normalizeQualifiedIdentifier(relation), relation]));
  const resolveRelation = (relation: string | undefined): string | undefined => {
    if (relation) {
      const normalized = normalizeQualifiedIdentifier(relation);
      return aliases.get(normalized) ?? byNormalizedRelation.get(normalized);
    }
    return relations.length === 1 ? relations[0] : undefined;
  };
  return [
    ...relations,
    ...(references.columns ?? []).map((column) => {
      const relation = resolveRelation(column.relation);
      return relation ? `${relation}.${column.column}` : column.column;
    }),
  ];
}

function normalizeProof(proven: ReadonlyArray<{ identifier: string; evidence: IdentifierEvidence }>): Pick<FinalSqlAuthorizationV1, 'provenIdentifiers' | 'evidence'> {
  const evidence: Record<string, IdentifierEvidence> = {};
  for (const entry of proven) {
    const key = normalizeQualifiedIdentifier(entry.identifier);
    if (!key) continue;
    const existing = evidence[key];
    if (!existing || evidenceRank(entry.evidence) > evidenceRank(existing)) evidence[key] = entry.evidence;
  }
  return { evidence, provenIdentifiers: Object.keys(evidence).sort() };
}

function verifyBinding(
  authority: ExecutionAuthorizationBindingV1,
  check: SqlAuthorizationCheck,
): SqlAuthorizationVerdict {
  if (check.bindings !== undefined && fingerprintSqlBindings(check.bindings) !== authority.bindingsFingerprint) {
    return failure('The SQL bindings differ from the authorized execution.', true);
  }
  for (const field of ['runId', 'executionId', 'snapshotId', 'planId', 'targetFingerprint'] as const) {
    const expected = check[field];
    const actual = authority[field];
    if (expected !== undefined && expected !== actual) {
      return failure(`The execution ${field} does not match the authorized request.`, true);
    }
  }
  return { ok: true, unproven: [], drifted: false };
}

function failure(reason: string, drifted: boolean): SqlAuthorizationVerdict {
  return { ok: false, unproven: [], drifted, reason };
}

function requiredIdentity(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  // A runless host cannot accidentally turn a global/default execution into a
  // valid capability. The random fallback is isolated per invocation, never
  // shared in a registry, and is useful only inside the supplied closure.
  return normalized || `${label}:${randomUUID()}`;
}

/** Missing generated-execution scope is a fail-closed condition, not a value to mint. */
function requiredCapabilityIdentity(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function normalizeQualifiedIdentifier(value: string): string {
  return value
    .trim()
    .split('.')
    .map((part) => part.trim().replace(/^["`\[]|["`\]]$/g, '').toLowerCase())
    .filter(Boolean)
    .join('.');
}

function relationAliasesInSql(sql: string): Map<string, string> {
  const aliases = new Map<string, string>();
  const stopwords = new Set(['where', 'group', 'order', 'limit', 'having', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'on', 'union']);
  // The validator remains the authority for SQL parsing. This small parser only
  // maps a parser-reported alias back to its exact relation spelling, and does
  // not try to infer a relation from the last segment of an identifier.
  const relation = '(?:"[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[A-Za-z_][A-Za-z0-9_$]*)(?:\\s*\\.\\s*(?:"[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[A-Za-z_][A-Za-z0-9_$]*))*';
  const matcher = new RegExp(`\\b(?:from|join)\\s+(${relation})(?:\\s+(?:as\\s+)?([A-Za-z_][A-Za-z0-9_$]*))?`, 'gi');
  for (const match of sql.matchAll(matcher)) {
    const source = match[1]?.trim();
    const alias = match[2]?.trim();
    if (!source) continue;
    aliases.set(normalizeQualifiedIdentifier(source), source);
    if (alias && !stopwords.has(alias.toLowerCase())) aliases.set(normalizeQualifiedIdentifier(alias), source);
  }
  return aliases;
}

function evidenceRank(source: IdentifierEvidence): number {
  switch (source) {
    case 'compiler': return 3;
    case 'preview': return 2;
    case 'schema_tool': return 1;
    case 'catalog': return 0;
  }
}

function stableBindingsValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableBindingsValue).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableBindingsValue(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}
