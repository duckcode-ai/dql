import type {
  ConnectionConfig,
  DatabaseConnector,
  QueryExecutionOptions,
  QueryExecutor,
  QueryPurpose,
} from '@duckcodeailabs/dql-connectors';
import { analyzeSqlReferences, extractTablesFromSql } from '@duckcodeailabs/dql-core';
import { currentPrincipal, type DqlPrincipal } from './request-context.js';

/**
 * ONE QUERY PATH (RFC 0010, slice HH-3). Every statement DQL sends to a
 * warehouse — a certified Dataset, a page tile, AI-written SQL, a notebook
 * cell, a proof — goes through the server's one executor. When a host
 * supplies `rowPolicy`, that executor asks it about each statement first and
 * runs what it returns: the same SQL, a narrowed rewrite, or nothing.
 *
 * The policy sees who is asking (null for work DQL starts on its own, such
 * as a startup catalog sync), the SQL and its values, the tables it reads
 * (best effort), the connection, and whether it reads data or only schema.
 * Rewrites must keep the placeholder style of the SQL they receive.
 *
 * Cached and proven results are keyed by the signed-in person (HH-2), so a
 * policy must depend only on the person and the statement. A policy that
 * changes for other reasons should carry a version in the person's
 * attributes.
 */
export interface DqlQueryContext {
  principal: DqlPrincipal | null;
  sql: string;
  params: unknown[];
  /** Tables the statement reads, from DQL's SQL reference scan (best effort). */
  relations: string[];
  connection: { driver: string; name?: string };
  purpose: QueryPurpose;
}

export type DqlRowPolicyResult = { sql: string; params?: unknown[] } | { refuse: string };

export type DqlRowPolicy = (query: DqlQueryContext) => Promise<DqlRowPolicyResult> | DqlRowPolicyResult;

export class RowPolicyRefusedError extends Error {
  readonly code = 'ROW_POLICY_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'RowPolicyRefusedError';
  }
}

/**
 * The tables a statement reads: the SQL parser's answer (quoted and
 * schema-qualified names come out as `schema.table`), plus file readers such
 * as `read_parquet(...)` that only the reference scan sees. When the parser
 * cannot read the statement, the scan alone.
 */
export function relationsOf(sql: string, dialect: string): string[] {
  try {
    const scanned = extractTablesFromSql(sql).tables;
    const analysis = analyzeSqlReferences(sql, dialect);
    if (!analysis.parsed) return scanned;
    return [...new Set([...analysis.tables, ...scanned.filter((table) => table.includes('('))])];
  } catch {
    return [];
  }
}

/** Ask the policy about one statement; refuse on a refusal, an error, or an unusable answer. */
export async function applyRowPolicy(
  policy: DqlRowPolicy,
  sql: string,
  params: unknown[],
  connection: Pick<ConnectionConfig, 'driver'> & { name?: string },
  purpose: QueryPurpose = 'data',
): Promise<{ sql: string; params: unknown[] }> {
  let answer: DqlRowPolicyResult;
  try {
    answer = await policy({
      principal: currentPrincipal() ?? null,
      sql,
      params: [...params],
      relations: relationsOf(sql, connection.driver),
      connection: { driver: connection.driver, ...(connection.name ? { name: connection.name } : {}) },
      purpose,
    });
  } catch {
    throw new RowPolicyRefusedError('DQL could not check what you may see, so it did not run this query.');
  }
  if (answer && 'refuse' in answer) {
    throw new RowPolicyRefusedError(typeof answer.refuse === 'string' && answer.refuse.trim() ? answer.refuse.trim() : 'You may not see the data this query reads.');
  }
  if (!answer || typeof answer.sql !== 'string' || !answer.sql.trim()) {
    throw new RowPolicyRefusedError('DQL could not check what you may see, so it did not run this query.');
  }
  return { sql: answer.sql, params: Array.isArray(answer.params) ? answer.params : params };
}

/** A connector whose statements — direct, streamed, or in a consistent read scope — pass the policy. */
function guardConnector(connector: DatabaseConnector, policy: DqlRowPolicy, config: ConnectionConfig): DatabaseConnector {
  const target = connector as DatabaseConnector & { openConsistentReadScope?: () => Promise<{ execute: DatabaseConnector['execute'] }> };
  return new Proxy(target, {
    get(object, property) {
      if (property === 'execute') {
        return async (sql: string, params: unknown[] = [], options?: QueryExecutionOptions) => {
          const allowed = await applyRowPolicy(policy, sql, params, config, options?.purpose);
          return object.execute(allowed.sql, allowed.params.length ? allowed.params : undefined, options);
        };
      }
      if (property === 'stream' && typeof object.stream === 'function') {
        return (sql: string, params: unknown[] = [], options?: QueryExecutionOptions) => {
          const stream = object.stream!.bind(object);
          return (async function* guarded() {
            const allowed = await applyRowPolicy(policy, sql, params, config, options?.purpose);
            yield* stream(allowed.sql, allowed.params.length ? allowed.params : undefined, options);
          })();
        };
      }
      if (property === 'openConsistentReadScope' && typeof object.openConsistentReadScope === 'function') {
        return async () => {
          const scope = await object.openConsistentReadScope!();
          return new Proxy(scope, {
            get(inner, key) {
              if (key === 'execute') {
                return async (sql: string, params: unknown[] = [], options?: QueryExecutionOptions) => {
                  const allowed = await applyRowPolicy(policy, sql, params, config, options?.purpose);
                  return inner.execute(allowed.sql, allowed.params.length ? allowed.params : undefined, options);
                };
              }
              const value = Reflect.get(inner, key, inner);
              return typeof value === 'function' ? value.bind(inner) : value;
            },
          });
        };
      }
      const value = Reflect.get(object, property, object);
      return typeof value === 'function' ? value.bind(object) : value;
    },
  });
}

/**
 * The server's executor with the host's row policy in front of every
 * statement. `executeQuery` expands its parameters and then goes through
 * the same guarded `executePositional`, so each statement is checked once.
 */
export function withRowPolicy<T extends QueryExecutor>(executor: T, policy: DqlRowPolicy): T {
  return new Proxy(executor, {
    get(target, property, receiver) {
      const own = Reflect.get(target, property, target);
      if (typeof own !== 'function') return own;
      if (property === 'executePositional') {
        return async (sql: string, paramValues: unknown[], config: ConnectionConfig, options?: QueryExecutionOptions) => {
          const allowed = await applyRowPolicy(policy, sql, paramValues ?? [], config, options?.purpose);
          return target.executePositional(allowed.sql, allowed.params, config, options);
        };
      }
      if (property === 'executeQuery') {
        // Runs the original expansion with `this` = the guarded executor.
        return (target.executeQuery as (...args: unknown[]) => unknown).bind(receiver);
      }
      if (property === 'getConnector') {
        return async (config: ConnectionConfig) => guardConnector(await target.getConnector(config), policy, config);
      }
      return own.bind(target);
    },
  });
}
