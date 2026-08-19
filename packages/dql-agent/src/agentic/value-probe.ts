/**
 * `search_values` — bind a literal the user named to a real column value.
 *
 * The recorded highest-severity defect in this program: asking about a specific
 * member returned every row instead of that member's, and the narration then
 * described the truncated result as if the member were absent. The chain was
 * `runtime_value_index` empty -> no member grounding -> empty filters -> plan
 * froze filterless -> 200 of 500 rows -> "no such customer".
 *
 * The persisted index was deleted for a good reason (SEC-003: warehouse cell
 * values must not sit in a rebuildable metadata database). The fix is not to
 * bring it back but to look the value up ON DEMAND, bounded, and only in columns
 * a project has agreed may be searched.
 *
 * Two independent gates, and BOTH must pass:
 *   1. a hard deny-list that no configuration can override — secrets and
 *      free-text payloads are never probed, however a project is set up
 *   2. an allow-list of column-name shapes that plausibly hold an identifier
 *
 * The deny-list is first and unconditional on purpose. An allow-list alone
 * eventually admits something it should not, because it grows by exception.
 */
import type { AgentToolDefinition } from '../providers/types.js';

export interface ProbeColumn {
  name: string;
  type?: string;
}

export interface ProbeRelation {
  relation: string;
  columns: ProbeColumn[];
}

/** Values that must never be probed, whatever the configuration says. */
const DENY_RE = /\b(password|secret|token|credential|hash|salt|notes?|comments?|description|message|body|payload|content|ssn|dob)\b/;
/** Email is denied separately: it is an identifier, but also direct PII. */
const EMAIL_RE = /\bemail\b/;

/** Name shapes that plausibly identify an entity rather than describe one. */
const IDENTIFIER_TOKENS = new Set([
  'account', 'category', 'channel', 'city', 'code', 'country', 'customer',
  'full', 'id', 'key', 'member', 'name', 'number', 'product', 'region',
  'segment', 'sku', 'state', 'status', 'subscriber', 'tier', 'type', 'user',
]);

/** Types that can hold a searchable literal. */
const TEXTUAL_TYPE_RE = /\b(char|character|clob|string|text|uuid|varchar|nvarchar)\b/;

function tokenize(name: string): Set<string> {
  return new Set(
    name
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_\-.]+/g, ' ')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean),
  );
}

/**
 * May this column be probed for a literal?
 *
 * Canonical implementation — the host's `isAgentValueProbeColumn` delegates here
 * so the deny-list has exactly one definition. Two copies of a security rule
 * drift, and the one that drifts is the one nobody is looking at.
 */
export function isProbeSafeColumn(column: ProbeColumn): boolean {
  const normalized = column.name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ').toLowerCase();
  if (DENY_RE.test(normalized)) return false;
  if (EMAIL_RE.test(normalized)) return false;
  const tokens = tokenize(column.name);
  if (![...tokens].some((token) => IDENTIFIER_TOKENS.has(token))) return false;
  const type = column.type?.toLowerCase() ?? '';
  // An unknown type is allowed: many drivers omit it, and the name gates already
  // passed. A KNOWN non-textual type is not — a literal cannot live in a float.
  if (!type) return true;
  return TEXTUAL_TYPE_RE.test(type);
}

/** Escape a single-quoted SQL literal. */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Quote an identifier ANSI-style, rejecting anything that is not a plain name. */
function quoteIdentifier(value: string): string | undefined {
  // Identifiers come from the SCHEMA, never from the user, so anything exotic
  // here means a caller is passing something it should not.
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) return undefined;
  return `"${value}"`;
}

function quoteRelation(relation: string): string | undefined {
  const parts = relation.split('.').map(quoteIdentifier);
  return parts.every(Boolean) ? parts.join('.') : undefined;
}

/**
 * Build a bounded DISTINCT lookup for one column.
 *
 * Exact match first, then a prefix match on the longer tokens. Prefix rather
 * than `%term%`: a leading wildcard cannot use an index, and on a large
 * dimension table that is the difference between a probe and an outage.
 */
export function buildValueProbeSql(relation: string, column: string, terms: readonly string[], limit = 25): string | undefined {
  const quotedRelation = quoteRelation(relation);
  const quotedColumn = quoteIdentifier(column);
  if (!quotedRelation || !quotedColumn) return undefined;
  const cast = `LOWER(CAST(${quotedColumn} AS VARCHAR))`;
  const predicates: string[] = [];
  for (const term of terms) {
    const normalized = term.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!normalized) continue;
    predicates.push(`${cast} = ${sqlLiteral(normalized)}`);
    for (const token of normalized.split(' ').filter((part) => part.length >= 4).slice(0, 2)) {
      predicates.push(`${cast} LIKE ${sqlLiteral(`${token.replace(/[%_\\]/g, '\\$&')}%`)} ESCAPE '\\'`);
    }
  }
  if (predicates.length === 0) return undefined;
  return [
    `SELECT DISTINCT CAST(${quotedColumn} AS VARCHAR) AS value`,
    `FROM ${quotedRelation}`,
    `WHERE ${quotedColumn} IS NOT NULL AND (${[...new Set(predicates)].slice(0, 8).join(' OR ')})`,
    `LIMIT ${Math.max(1, Math.min(limit, 50))}`,
  ].join('\n');
}

export interface SearchValuesOptions {
  execute: (sql: string) => Promise<{ rows: unknown[] }>;
  relations: readonly ProbeRelation[];
  /** Probing is opt-in per project; disabled means the tool reports why. */
  enabled: boolean;
  /** Max relations probed per call, so one question cannot scan the warehouse. */
  maxRelations?: number;
}

/**
 * A tool that answers "does this literal exist, and in which column?".
 *
 * Returns the matched VALUES — which is the point, since the loop needs the
 * exact stored spelling to build a filter — but only from columns that passed
 * both gates, and only values the caller already named.
 */
export function buildSearchValuesTool(options: SearchValuesOptions): AgentToolDefinition {
  const maxRelations = options.maxRelations ?? 6;
  return {
    name: 'search_values',
    description:
      'Check whether a literal the question names (a customer, product, region, status) exists as a value in the data, and get its exact stored spelling. Use it BEFORE filtering on a name, so a filter is built from a real value rather than a guess. Only searches columns approved for value lookup.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['terms'],
      properties: {
        terms: { type: 'array', items: { type: 'string' }, description: 'Literals named in the question, e.g. ["Wesley Jenkins"].' },
        relations: { type: 'array', items: { type: 'string' }, description: 'Optional relations to restrict the search to.' },
      },
    },
    run: async (args: unknown) => {
      const input = (args && typeof args === 'object' ? args : {}) as { terms?: unknown; relations?: unknown };
      const terms = Array.isArray(input.terms)
        ? input.terms.filter((term): term is string => typeof term === 'string' && term.trim().length > 0)
        : [];
      if (terms.length === 0) return { error: 'Pass the literal(s) to look up, e.g. ["Wesley Jenkins"].' };
      if (!options.enabled) {
        // Say WHY, and name the setting. A silent empty result here is what
        // produced the false-absence defect: the loop concluded the value did
        // not exist when it had simply never been allowed to look.
        return {
          searched: false,
          reason: 'Value lookup is disabled for this project. Enable agent.runtimeValueGrounding in dql.config.json to let DQL confirm a named value before filtering on it.',
          matches: [],
        };
      }
      const wanted = Array.isArray(input.relations)
        ? new Set(input.relations.filter((r): r is string => typeof r === 'string').map((r) => r.toLowerCase()))
        : undefined;
      const matches: Array<{ relation: string; column: string; values: string[] }> = [];
      const searched: string[] = [];
      const skipped: string[] = [];
      for (const relation of options.relations) {
        if (wanted && !wanted.has(relation.relation.toLowerCase())) continue;
        if (searched.length >= maxRelations) break;
        const safe = relation.columns.filter(isProbeSafeColumn);
        if (safe.length === 0) { skipped.push(relation.relation); continue; }
        searched.push(relation.relation);
        for (const column of safe.slice(0, 8)) {
          const sql = buildValueProbeSql(relation.relation, column.name, terms);
          if (!sql) continue;
          try {
            const result = await options.execute(sql);
            const values = (result.rows ?? [])
              .map((row) => (Array.isArray(row) ? row[0] : (row as Record<string, unknown>)?.value))
              .filter((value): value is string => typeof value === 'string');
            if (values.length > 0) matches.push({ relation: relation.relation, column: column.name, values });
          } catch {
            // One unreadable relation must not fail the whole probe; a permission
            // error on a single table is normal in a governed warehouse.
          }
        }
      }
      return {
        searched: true,
        terms,
        matches,
        relationsSearched: searched,
        ...(skipped.length > 0 ? { relationsWithNoSearchableColumn: skipped } : {}),
        // An explicit "looked and found nothing" is not the same as "did not
        // look", and the difference is what the narration verifier needs to
        // decide whether absence can be claimed at all.
        ...(matches.length === 0 ? { note: 'Searched the approved columns and found no match for these literals.' } : {}),
      };
    },
  };
}
