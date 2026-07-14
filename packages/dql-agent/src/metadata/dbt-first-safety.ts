/** Compatibility wrapper around the unified manifest-v3 analytical policy service. */
import type { DQLManifest } from '@duckcodeailabs/dql-core';
import type { DomainContextEnvelope } from '../domain-context.js';
import { validateAnalyticalSql, type AnalyticalPolicyCode } from './analytical-policy.js';

export type DbtFirstJoinSafetyCode = AnalyticalPolicyCode;

export interface DbtFirstJoinSafetyDecision {
  safe: boolean;
  code?: DbtFirstJoinSafetyCode;
  message?: string;
  entities: string[];
  relationshipIds: string[];
}

/**
 * Validate generated SQL against exact certified path and join-key proof.
 * Kept under the historical name so existing Ask AI integrations remain API
 * compatible while MCP, notebooks, and Apps adopt the same policy service.
 */
export function evaluateDbtFirstGeneratedSql(
  sql: string,
  manifest: DQLManifest,
  purpose?: string,
  domainContext?: DomainContextEnvelope,
): DbtFirstJoinSafetyDecision {
  const decision = validateAnalyticalSql(sql, manifest, 'duckdb', purpose, domainContext);
  return {
    safe: decision.safe,
    code: decision.code,
    message: decision.message,
    entities: decision.entities,
    relationshipIds: decision.relationshipIds,
  };
}
