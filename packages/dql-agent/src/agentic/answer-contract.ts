/**
 * Stage-B answer contract: derive the TRUST of an agentic answer from which tool
 * produced its SQL — never from what the model claims.
 *
 * The agentic tool loop returns free-form final text plus a record of every
 * governed compile it performed (via `compile_semantic_query`). The restructured
 * answer loop parses the text into a proposal; this module decides whether that
 * proposal's SQL is the GOVERNED semantic SQL the compiler emitted (→ semantic_metric
 * tier) or hand-written SQL (→ generated tier, review-required). Certified answers
 * are handled upstream in Stage A, before the loop runs, so they never reach here.
 */

export interface CompiledSemanticRecord {
  sql: string;
  metrics: string[];
  dimensions: string[];
  dqlArtifactSource: string;
  engine?: 'native' | 'metricflow-cli' | 'dbt-cloud';
}

export interface AgenticTrustResult {
  /** 'semantic_metric' when the final SQL is a governed compile; else 'generated'. */
  tier: 'semantic_metric' | 'generated';
  /** The compiled record whose SQL the model adopted, when governed. */
  compiled?: CompiledSemanticRecord;
}

/**
 * Decide the trust tier of the agentic proposal. The final SQL is GOVERNED only if
 * it is (a normalized form of) SQL that `compile_semantic_query` actually returned
 * during this run — the model cannot label its own hand-written SQL as governed.
 */
export function deriveAgenticTrust(
  finalSql: string | undefined,
  compiledRecords: CompiledSemanticRecord[],
): AgenticTrustResult {
  if (!finalSql || compiledRecords.length === 0) return { tier: 'generated' };
  const target = normalizeSql(finalSql);
  if (!target) return { tier: 'generated' };
  // EXACT normalized equality only. Substring tolerance would let the model append
  // an unvalidated WHERE/JOIN to the compiled SQL and still earn the governed label
  // (which skips the hallucination guard) — the model must adopt the compiled SQL
  // verbatim to be trusted as governed. The tool's contract instructs exactly that.
  const match = compiledRecords.find((record) => {
    const compiled = normalizeSql(record.sql);
    return compiled.length > 0 && compiled === target;
  });
  return match ? { tier: 'semantic_metric', compiled: match } : { tier: 'generated' };
}

/**
 * Normalize SQL for equivalence checks: lowercase, collapse whitespace, drop a
 * trailing semicolon. Deliberately conservative — this is a "did the model reuse
 * the compiled SQL" check, not a full SQL parser, so it errs toward `generated`
 * (review-required) when unsure, which is the safe direction for governance.
 */
export function normalizeSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*;\s*$/, '')
    .trim()
    .toLowerCase();
}
