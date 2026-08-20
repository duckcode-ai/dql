/**
 * Ledger enforcement over a tool loop.
 *
 * The rule that carries most of the 94.15%-on-Spider2 result is not a better
 * prompt: only identifiers LIFTED FROM A TOOL OUTPUT may appear in executed SQL.
 * Prompting for it does not work — a model asked to "only use real columns" will
 * still invent `customer_tier` when the schema says `service_tier`, because the
 * invented name is more plausible than the real one.
 *
 * So it is enforced structurally. Every tool result is harvested into an
 * {@link IdentifierLedger} as the loop runs, and the SQL the model finally
 * proposes is adjudicated against what was actually observed. A violation comes
 * back as a correction naming the nearest observed identifier — not as a
 * refusal, which is what the old pipeline turned it into.
 */
import type { AgentToolDefinition } from '../providers/types.js';
import { IdentifierLedger, type IdentifierSource } from './identifier-ledger.js';

/**
 * Where each tool's output sits on the evidence scale.
 *
 * A compiler emitting SQL is the strongest claim that a name exists; a catalog
 * search only says something was INDEXED under that name, which is a weaker
 * thing entirely — a stale index still returns rows.
 */
const TOOL_EVIDENCE: Record<string, IdentifierSource> = {
  compile_semantic_query: 'compiler',
  compile_governed_query: 'compiler',
  preview_query: 'preview',
  sample_notebook_dataset: 'preview',
  execute_local_analysis: 'preview',
  get_table_schema: 'schema_tool',
  describe_notebook_dataset: 'schema_tool',
  inspect_metadata_context: 'schema_tool',
  list_notebook_datasets: 'schema_tool',
  scan_manifest: 'catalog',
  search_semantic_layer: 'catalog',
  search_metadata: 'catalog',
  check_compatibility: 'catalog',
};

export function evidenceSourceForTool(toolName: string): IdentifierSource {
  return TOOL_EVIDENCE[toolName] ?? 'catalog';
}

/** Keys whose STRING values name a relation or column. */
const IDENTIFIER_KEYS = new Set([
  'relation', 'table', 'tableName', 'fullName', 'qualifiedName', 'name',
  'column', 'columnName', 'dimension', 'metric', 'measure', 'resolvedName',
]);

/** Keys whose ARRAY values are lists of identifiers or column records. */
const IDENTIFIER_LIST_KEYS = new Set([
  'columns', 'relations', 'tables', 'dimensions', 'metrics', 'measures',
  'compatibleDimensions', 'outputs', 'groupBy', 'selectedColumns',
]);

/**
 * Pull identifiers out of an arbitrary tool result.
 *
 * Deliberately structural rather than a schema per tool: the tool set grows, and
 * a harvester that silently misses a new tool's output would quietly re-open the
 * hole this class exists to close — every unharvested name becomes an
 * "unadmitted" false alarm on correct SQL.
 *
 * Bounded in depth and count so a large preview cannot turn one observation into
 * a pathological walk.
 */
export function harvestIdentifiers(output: unknown, limit = 500): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  const push = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    // A SQL string or a sentence is not an identifier. Bare-ish names only.
    if (!trimmed || trimmed.length > 128 || /\s/.test(trimmed)) return;
    if (seen.has(trimmed) || found.length >= limit) return;
    seen.add(trimmed);
    found.push(trimmed);
  };

  const walk = (node: unknown, depth: number): void => {
    if (found.length >= limit || depth > 6 || node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const entry of node) {
        // A bare string inside an identifier list is itself an identifier.
        if (typeof entry === 'string') push(entry);
        else walk(entry, depth + 1);
      }
      return;
    }
    if (typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    // Schema/preview tools commonly return `{ relation, columns: [{ name }] }`.
    // Preserve that ownership in the ledger.  A bare `id` is not an execution
    // identity: it could belong to any relation in the same result.
    const relation = [record.relation, record.table, record.fullName, record.qualifiedName]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
      ?.trim();
    const ownedColumnKeys = new Set(['columns', 'selectedColumns', 'outputs']);
    if (relation) {
      for (const key of ['columns', 'selectedColumns', 'outputs']) {
        const values = record[key];
        if (!Array.isArray(values)) continue;
        for (const entry of values) {
          const column = typeof entry === 'string'
            ? entry
            : entry && typeof entry === 'object'
              ? [
                  (entry as Record<string, unknown>).column,
                  (entry as Record<string, unknown>).name,
                  (entry as Record<string, unknown>).columnName,
                ].find((value): value is string => typeof value === 'string')
              : undefined;
          if (column && !/\s/.test(column)) push(`${relation}.${column}`);
        }
      }
    }
    for (const [key, value] of Object.entries(record)) {
      if (IDENTIFIER_KEYS.has(key)) push(value);
      if (IDENTIFIER_LIST_KEYS.has(key) && Array.isArray(value)) {
        // Relation-shaped schema and preview payloads were already harvested
        // above as `relation.column`. Re-admitting their bare column leaves
        // would let one table authorize the same leaf on another table.
        if (relation && ownedColumnKeys.has(key)) continue;
        for (const entry of value) {
          if (typeof entry === 'string') push(entry);
          else walk(entry, depth + 1);
        }
        continue;
      }
      walk(value, depth + 1);
    }
  };

  walk(output, 0);
  return found;
}

/**
 * Wrap tools so every observation feeds the ledger.
 *
 * The wrapper is transparent: it returns the tool's own output untouched and
 * never fails the call. A harvesting bug must not break a working tool — the
 * worst case is a name that goes unadmitted and surfaces as a correction, which
 * the loop can recover from.
 */
export function withLedgerHarvest(
  tools: readonly AgentToolDefinition[],
  ledger: IdentifierLedger,
  onObservation?: (event: { tool: string; admitted: number }) => void,
): AgentToolDefinition[] {
  return tools.map((tool, index) => ({
    ...tool,
    run: async (args: unknown) => {
      const output = await tool.run(args);
      try {
        const identifiers = harvestIdentifiers(output);
        ledger.admit(evidenceSourceForTool(tool.name), identifiers, `${tool.name}#${index}`);
        onObservation?.({ tool: tool.name, admitted: identifiers.length });
      } catch {
        // Never let harvesting break a tool that worked.
      }
      return output;
    },
  }));
}

/**
 * The explore-then-compose discipline, as a system message.
 *
 * Mirrors the two phases that produced the 94% result: establish real names
 * first, then assemble over only those names.
 */
export const ANALYST_TOOL_POLICY = [
  'Work in two phases.',
  '',
  'EXPLORE — establish what actually exists before writing any SQL:',
  '  · search for the governed metrics and dimensions the question needs',
  '  · check compatibility before assuming a breakdown is reachable; when it is not,',
  '    the tool tells you which dimensions ARE reachable — use one of those rather',
  '    than stopping',
  '  · compile a governed query and read back the identifiers it returns',
  '',
  'COMPOSE — assemble the final query using ONLY names a tool returned to you.',
  'Every table and column in executed SQL must have appeared in a compile, preview,',
  'or schema result. Preserve the qualified relation.column identity returned by the tool;',
  'a bare leaf is not enough when multiple relations can contain the same name. A name that merely looks plausible is the single most common',
  'way these queries go wrong: if you need a column you have not seen, inspect it',
  'first rather than guessing its spelling.',
].join('\n');

/**
 * Adjudicate proposed SQL against what the loop actually observed.
 *
 * Returns a correction to feed back, or `undefined` when everything checks out.
 * Never throws and never refuses: an unadmitted identifier is a fixable mistake,
 * and the old pipeline turning it into a terminal `grounding_gap` is precisely
 * the dead end being removed.
 */
export function adjudicateProposedSql(
  ledger: IdentifierLedger,
  references: { relations?: readonly string[]; columns?: readonly string[] },
): { ok: true } | { ok: false; correction: string; unadmitted: string[] } {
  // Catalog retrieval narrows tool search but is never execution evidence. A
  // generated statement must name identifiers a compiler, preview, or schema
  // observation actually returned during this invocation.
  const verdict = ledger.adjudicate(references, { requireObserved: true });
  if (verdict.ok) return { ok: true };
  return {
    ok: false,
    unadmitted: verdict.unadmitted,
    correction: IdentifierLedger.renderCorrection(verdict) ?? 'Some identifiers were never observed.',
  };
}
