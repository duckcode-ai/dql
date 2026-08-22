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
  // SQL parsers quite correctly report an unqualified `ORDER BY total` as a
  // column reference.  `total` can instead be a SELECT output alias, which is
  // not a physical warehouse column and therefore must not be minted as one
  // into the execution capability.  Only replace an exact alias with the
  // source references which the same parser already found in that alias's
  // expression.  This keeps the physical proof load-bearing: a scalar alias,
  // an arbitrary/unbound alias, or an alias over an unknown source remains a
  // denied reference rather than becoming an authorization bypass.
  const outputAliasSources = selectOutputAliasSourceReferences(sql, references, resolveRelation);
  return Array.from(new Set([
    ...relations,
    ...(references.columns ?? []).map((column) => {
      const outputSources = outputAliasSources.get(normalizeQualifiedIdentifier(column.column));
      // Some parsers attach the only FROM relation to an otherwise bare
      // `ORDER BY total` reference.  Syntax, not that parser convenience, is
      // the authority here: a qualified `ORDER BY t.total` remains physical.
      if (outputSources && isBareTopLevelOrderByAlias(sql, column.column)) return outputSources;
      const relation = resolveRelation(column.relation);
      return relation ? `${relation}.${column.column}` : column.column;
    }),
  ].flat()));
}

/**
 * Return physical source identities for exact SELECT aliases.  This is a
 * deliberately narrow companion to the established SQL parser: it does not
 * parse SQL, infer joins, or resolve a leaf against another relation.  It only
 * recognizes an alias when an existing parser-reported source column occurs in
 * that same SELECT expression.  The caller subsequently proves each returned
 * identity against the router-owned runtime closure.
 */
function selectOutputAliasSourceReferences(
  sql: string,
  references: SqlAuthorizationReferences,
  resolveRelation: (relation: string | undefined) => string | undefined,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const columns = references.columns ?? [];
  for (const item of splitTopLevelSelectItems(topLevelSelectList(sql))) {
    const output = selectOutputAlias(item);
    if (!output) continue;
    const alias = normalizeQualifiedIdentifier(output.alias);
    if (!alias) continue;
    const sources = columns.flatMap((column) => {
      // An output alias cannot prove itself.  It must be backed by an existing
      // parser-reported source reference from its own expression.
      if (!column.relation && normalizeQualifiedIdentifier(column.column) === alias) return [];
      if (!expressionReferencesColumn(output.expression, column.column)) return [];
      const relation = resolveRelation(column.relation);
      return relation ? [`${relation}.${column.column}`] : [];
    });
    if (sources.length > 0) result.set(alias, Array.from(new Set(sources)));
  }
  return result;
}

function topLevelSelectList(sql: string): string {
  let depth = 0;
  let quote: '"' | "'" | '`' | undefined;
  let selectStart = -1;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (quote) {
      if (char === quote) {
        if (quote === "'" && next === "'") {
          index += 1;
          continue;
        }
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0 || !/[A-Za-z_]/.test(char)) continue;
    const match = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(index));
    if (!match) continue;
    const token = match[0].toLowerCase();
    if (token === 'select') selectStart = index + match[0].length;
    if (token === 'from' && selectStart >= 0) return sql.slice(selectStart, index);
    index += match[0].length - 1;
  }
  return '';
}

function isBareTopLevelOrderByAlias(sql: string, alias: string): boolean {
  const list = topLevelOrderByList(sql);
  const normalizedAlias = normalizeQualifiedIdentifier(alias);
  if (!list || !normalizedAlias) return false;
  return splitTopLevelSelectItems(list).some((item) => {
    const withoutDirection = item
      .trim()
      .replace(/\s+(?:asc|desc)(?:\s+nulls\s+(?:first|last))?\s*$/i, '')
      .trim();
    return !withoutDirection.includes('.')
      && normalizeQualifiedIdentifier(withoutDirection) === normalizedAlias;
  });
}

function topLevelOrderByList(sql: string): string {
  let depth = 0;
  let quote: '"' | "'" | '`' | undefined;
  let orderByStart = -1;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (quote) {
      if (char === quote) {
        if (quote === "'" && next === "'") {
          index += 1;
          continue;
        }
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0 || !/[A-Za-z_]/.test(char)) continue;
    const match = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(index));
    if (!match) continue;
    const token = match[0].toLowerCase();
    if (orderByStart < 0 && token === 'order') {
      const by = /^\s+by\b/i.exec(sql.slice(index + match[0].length));
      if (by) {
        orderByStart = index + match[0].length + by[0].length;
        index = orderByStart - 1;
        continue;
      }
    } else if (orderByStart >= 0 && ['limit', 'offset', 'fetch', 'union', 'intersect', 'except', 'qualify'].includes(token)) {
      return sql.slice(orderByStart, index);
    }
    index += match[0].length - 1;
  }
  return orderByStart >= 0 ? sql.slice(orderByStart) : '';
}

function splitTopLevelSelectItems(section: string): string[] {
  const items: string[] = [];
  let current = '';
  let depth = 0;
  let quote: '"' | "'" | '`' | undefined;
  for (let index = 0; index < section.length; index += 1) {
    const char = section[index]!;
    const next = section[index + 1];
    if (quote) {
      current += char;
      if (char === quote) {
        if (quote === "'" && next === "'") {
          current += next;
          index += 1;
          continue;
        }
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(') {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }
    if (char === ',' && depth === 0) {
      if (current.trim()) items.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function selectOutputAlias(item: string): { alias: string; expression: string } | undefined {
  const identifier = '(?:"[^"]+"|`[^`]+`|[A-Za-z_][A-Za-z0-9_$]*)';
  const explicit = new RegExp(`\\bAS\\s+(${identifier})\\s*$`, 'i').exec(item);
  if (explicit?.[1]) {
    return { alias: cleanSqlIdentifier(explicit[1]), expression: item.slice(0, explicit.index).trim() };
  }
  const implicit = new RegExp(`(?:\\bEND|\\)|\\])\\s+(${identifier})\\s*$`, 'i').exec(item);
  if (!implicit?.[1]) return undefined;
  const alias = cleanSqlIdentifier(implicit[1]);
  if (!alias || SQL_OUTPUT_ALIAS_STOPWORDS.has(alias.toLowerCase())) return undefined;
  return { alias, expression: item.slice(0, implicit.index).trim() };
}

const SQL_OUTPUT_ALIAS_STOPWORDS = new Set(['asc', 'desc', 'from', 'group', 'having', 'limit', 'order', 'where']);

function cleanSqlIdentifier(value: string): string {
  return value.trim().replace(/^(["`])|(["`])$/g, '');
}

function expressionReferencesColumn(expression: string, column: string): boolean {
  const normalized = cleanSqlIdentifier(column);
  if (!normalized || !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(normalized)) return false;
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9_$])(?:[A-Za-z_][A-Za-z0-9_$]*\\s*\\.\\s*)?${escaped}(?=$|[^A-Za-z0-9_$])`, 'i')
    .test(expression);
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
