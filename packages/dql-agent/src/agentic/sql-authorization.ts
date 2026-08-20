/**
 * Exact-execution authorization (P0.2).
 *
 * The identifier ledger verified SQL and then handed it to the legacy loop as
 * CONTEXT — which is free to generate and execute something else. So the ledger
 * governed a string, not the execution boundary, and "only names lifted from
 * tool observations may appear in executed SQL" was an aspiration rather than a
 * property.
 *
 * This closes that gap at the only place it can be closed: the statement about
 * to reach the warehouse. An authorization records WHICH identifiers were
 * proven and by what evidence; the gateway then refuses any statement that
 * references something outside that set.
 *
 * Deliberately NOT a replacement for the existing gates. RAP freezing, tuple
 * drift, read-only checks, row bounds, permissions, and connector policy all
 * still run. This is one more thing that must hold, never a substitute for
 * something that already holds.
 */

import { createHash } from 'node:crypto';

export type IdentifierEvidence = 'compiler' | 'preview' | 'schema_tool' | 'catalog';

export interface FinalSqlAuthorizationV1 {
  version: 1;
  /** Qualified identities proven for this run, lowercased. */
  provenIdentifiers: string[];
  /** How each was proven. Catalog alone is NOT execution proof — see below. */
  evidence: Record<string, IdentifierEvidence>;
  /** Fingerprint of the statement the authorization was minted for. */
  sqlFingerprint: string;
  planId?: string;
  snapshotId?: string;
  mintedAt: string;
}

export interface SqlAuthorizationVerdict {
  ok: boolean;
  /** Identifiers the statement referenced that nothing proved. */
  unproven: string[];
  /** True when the executing statement is not the one authorized. */
  drifted: boolean;
  reason?: string;
}

/**
 * Normalize before fingerprinting so formatting is not mistaken for drift.
 * Comments and whitespace change nothing about what executes.
 */
export function normalizeSqlForFingerprint(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/;\s*$/, '')
    .trim()
    .toLowerCase();
}

export function fingerprintSql(sql: string): string {
  return createHash('sha256').update(normalizeSqlForFingerprint(sql)).digest('hex').slice(0, 32);
}

export function mintFinalSqlAuthorization(input: {
  sql: string;
  proven: ReadonlyArray<{ identifier: string; evidence: IdentifierEvidence }>;
  planId?: string;
  snapshotId?: string;
  now?: () => Date;
}): FinalSqlAuthorizationV1 {
  const evidence: Record<string, IdentifierEvidence> = {};
  for (const entry of input.proven) {
    const key = entry.identifier.trim().toLowerCase();
    if (!key) continue;
    // Strongest evidence wins when the same identity was proven twice.
    const rank: Record<IdentifierEvidence, number> = {
      compiler: 3, preview: 2, schema_tool: 1, catalog: 0,
    };
    const existing = evidence[key];
    if (!existing || rank[entry.evidence] > rank[existing]) evidence[key] = entry.evidence;
  }
  return {
    version: 1,
    provenIdentifiers: Object.keys(evidence).sort(),
    evidence,
    sqlFingerprint: fingerprintSql(input.sql),
    ...(input.planId ? { planId: input.planId } : {}),
    ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
    mintedAt: (input.now?.() ?? new Date()).toISOString(),
  };
}

/** Bare leaf of a qualified name, so `db.schema.orders` matches `orders`. */
function leaf(identifier: string): string {
  return identifier.split('.').at(-1) ?? identifier;
}

/**
 * Does this statement reference only what was proven?
 *
 * Catalog evidence alone does not authorize execution. Retrieval returning an
 * object means it EXISTS somewhere in the metadata, not that this run proved
 * the relation is real, reachable, and shaped as assumed — which is exactly the
 * confusion that let a hallucinated-but-plausible name through.
 */
export function verifyFinalSql(
  authorization: FinalSqlAuthorizationV1,
  sql: string,
  referenced: ReadonlyArray<string>,
): SqlAuthorizationVerdict {
  const drifted = fingerprintSql(sql) !== authorization.sqlFingerprint;
  const executable = new Set(
    authorization.provenIdentifiers.filter((id) => authorization.evidence[id] !== 'catalog'),
  );
  const executableLeaves = new Set([...executable].map(leaf));
  const unproven = referenced
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean)
    .filter((name) => !executable.has(name) && !executableLeaves.has(leaf(name)));
  const uniqueUnproven = [...new Set(unproven)];
  if (drifted) {
    return {
      ok: false,
      unproven: uniqueUnproven,
      drifted: true,
      reason: 'The statement about to execute is not the one that was authorized.',
    };
  }
  if (uniqueUnproven.length > 0) {
    return {
      ok: false,
      unproven: uniqueUnproven,
      drifted: false,
      reason: `Nothing in this run proved: ${uniqueUnproven.join(', ')}.`,
    };
  }
  return { ok: true, unproven: [], drifted: false };
}
