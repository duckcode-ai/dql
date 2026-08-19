/**
 * `preview_query` — the tool that lets the loop ESTABLISH identifiers.
 *
 * The ledger can only admit names a tool returned, so without a way to run
 * something the loop is limited to whatever search and compile happened to
 * surface. That makes it a verifier of other tools' output rather than an
 * investigator: it can reject a wrong column but never discover the right one.
 *
 * A bounded preview closes that. It executes the candidate SQL against the real
 * warehouse and returns the COLUMN NAMES the engine actually produced — the
 * strongest evidence a name exists short of the compiler emitting it, because
 * the database itself resolved it.
 *
 * It returns no cell VALUES. The loop needs to know a column exists, not what is
 * in it, and shipping rows here would route warehouse data to a provider outside
 * the egress policy that governs narration.
 */
import type { AgentToolDefinition } from '../providers/types.js';

export interface PreviewExecutor {
  (sql: string): Promise<{ columns: unknown[]; rows: unknown[]; rowCount: number }>;
}

/** Statements a read-only preview may run. */
const READ_ONLY_START_RE = /^\s*(select|with)\b/i;
const MUTATION_RE = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|attach|install|load|pragma|call|merge)\b/i;

/** Column name from whatever shape the driver returns. */
function columnName(column: unknown): string | undefined {
  if (typeof column === 'string') return column;
  if (column && typeof column === 'object') {
    const name = (column as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return undefined;
}

/**
 * Wrap the candidate in a bounded outer SELECT.
 *
 * Wrapping rather than appending `LIMIT`: the candidate may already carry its
 * own LIMIT, an ORDER BY, or a trailing comment, and appending to any of those
 * produces either a syntax error or a silently different query. A subselect
 * bounds it without rewriting what the model wrote.
 */
export function boundedPreviewSql(sql: string, limit = 5): string {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  return `SELECT * FROM (\n${trimmed}\n) AS dql_preview LIMIT ${Math.max(1, Math.min(limit, 50))}`;
}

export function buildPreviewQueryTool(execute: PreviewExecutor, limit = 5): AgentToolDefinition {
  return {
    name: 'preview_query',
    description:
      'Run candidate SQL against the real warehouse with a small row limit and get back the COLUMN NAMES it produced, plus whether it executed. Use this to confirm a query compiles and to learn the exact output column names before composing the final answer. Returns no cell values.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sql'],
      properties: {
        sql: { type: 'string', description: 'A single read-only SELECT or WITH statement.' },
      },
    },
    run: async (args: unknown) => {
      const input = (args && typeof args === 'object' ? args : {}) as { sql?: unknown };
      const sql = typeof input.sql === 'string' ? input.sql.trim() : '';
      if (!sql) return { error: 'Pass the SQL to preview.' };
      if (!READ_ONLY_START_RE.test(sql) || MUTATION_RE.test(sql)) {
        return { error: 'preview_query runs one read-only SELECT or WITH statement. It cannot modify data.' };
      }
      try {
        const result = await execute(boundedPreviewSql(sql, limit));
        const columns = (result.columns ?? [])
          .map(columnName)
          .filter((name): name is string => Boolean(name));
        return {
          executed: true,
          // Names only — never cell values. See the module comment.
          columns,
          rowCount: typeof result.rowCount === 'number' ? result.rowCount : (result.rows?.length ?? 0),
        };
      } catch (error) {
        // A failure is INFORMATION, not an outage: the message names the column
        // or table the warehouse rejected, which is exactly what the loop needs
        // to correct itself. Swallowing it would leave the model guessing again.
        return {
          executed: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
