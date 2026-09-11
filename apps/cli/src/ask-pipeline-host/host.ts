import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildExecutionPlan } from '@duckcodeailabs/dql-notebook';
import { prepareBlockInvocation } from '../block-invocation.js';
import { writeFileSync } from 'node:fs';
import type { ConnectionConfig, QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { getDialect, type DQLManifest, type SemanticLayer } from '@duckcodeailabs/dql-core';
import {
  type ProjectionScope,
  type PreparedRefusal,
  askScopeFromWorkspace,
  buildVocabularyIndex,
  classifyWarehouseError,
  assessAnalyticalRelationship,
  parseMemberOption,
  projectVocabularySource,
  rankedRefsFromPack,
  resolveDomainContextEnvelope,
  runAskPipeline,
  type DomainContextEnvelope,
  type LocalContextPack,
  type ContextLedgerV1,
  type JoinAuthorityV1,
  type UnprovenJoin,
  catalogKeyTypes,
  validateRelationshipOnWarehouse,
  type AgentProvider,
  type AgentRouteExecutor,
  type AgentRouteExecutorResult,
  type AgentRunArtifact,
  type AgentRunNextAction,
  type AgentRunRequest,
  type AnalyticalIntentV1,
  type PipelineOutcome,
  type PreparedCandidate,
  type PrepareDeps,
  type RelationalJoinStep,
  type ProviderRunOptions,
  type SemanticCompileOutput,
  type SemanticCompileRequest,
  type VocabularyIndex,
  type AskStoryStepV1,
  type PipelineReceipt,
  type VocabularySource,
  type PreparedBlock,
  type VocabularyEntry,
  type PhysicalRelationBindingV1,
  parsePhysicalIdentifier,
  physicalRelationBinding,
  physicalRelationIdentity,
  physicalRelationTailIdentity,
  renderPhysicalIdentifier,
  renderPhysicalRelation,
  mergeDiscoveredRelations,
  aggregatesRows,
  appliedConditions,
  joinKeyPairs,
  missingRequiredFilters,
  missingStatedValues,
  requiredFilterFromText,
  statedValues,
  withRowGuard,
  physicalRelationText,
  type PhysicalIdentifierPartV1,
  renderCard,
  validateSqlAgainstLocalContext,
  type AgentMessage,
  type RuntimeSchemaTable,
} from '@duckcodeailabs/dql-agent';
import { buildProjectVocabulary, buildVocabularySource, embeddedManifestRelations, normalizeRelationName, type VocabularySourceInput } from './vocabulary-source.js';

/**
 * THE ASK PIPELINE HOST.
 *
 * Everything the host-neutral pipeline needs from the running server:
 * the vocabulary of the current snapshot, the configured provider, the
 * semantic compiler, the governed join graph, the warehouse, and the
 * conversation store. It returns an `AgentRouteExecutor`, so the engine
 * keeps owning the run lifecycle, artifacts, persistence and the UI shape.
 */

/**
 * Request-local physical evidence handed from Ask to the semantic runtime.
 *
 * This deliberately travels beside the semantic request rather than being
 * reconstructed from a project-default runtime snapshot.  A Snowflake
 * project can legitimately contain DB_A.PUBLIC.EVENTS and DB_B.PUBLIC.EVENTS;
 * the selected Ask vocabulary is the only authority for which one this run
 * has inspected and may compile against.
 */
export interface AskSemanticCompileContext {
  snapshotId: string;
  executionTargetFingerprint: string;
  vocabulary: VocabularyIndex;
  /** Exact, target-bound bindings relevant to this semantic request. */
  physicalBindings: PhysicalRelationBindingV1[];
}

export interface AskPipelineHostDeps {
  projectRoot: string;
  executor: QueryExecutor;
  resolveConnection(request: AgentRunRequest): Promise<ConnectionConfig>;
  getSemanticLayer(): SemanticLayer | undefined;
  getManifest(): { manifest: DQLManifest | undefined; snapshotId: string };
  selectProvider(request: AgentRunRequest): Promise<AgentProvider | undefined>;
  /** Compile on the project's active semantic engine; throws with the engine's message. */
  compileSemantic(request: SemanticCompileRequest, connection: ConnectionConfig, context?: AskSemanticCompileContext): Promise<SemanticCompileOutput>;
  /** The engine `compileSemantic` will use, known before preparation so the binder can speak its dialect. */
  semanticEngine?(): Promise<'native' | 'metricflow-cli' | 'dbt-cloud'>;
  /** Wrap one physical provider call in the run's dispatch ledger. */
  dispatchOptions?(purpose: 'resolve' | 'correct' | 'repair' | 'draft', request: AgentRunRequest): { options: ProviderRunOptions; settle(outcome: 'ok' | 'error' | 'cancelled', error?: unknown): void };
  /** The executed intent of the last usable turn in this thread, when there is one. */
  /** The previous turn's typed reading. `executed: false` means it was blocked: its question stands, its result does not exist. */
  priorIntent(request: AgentRunRequest): { intent: AnalyticalIntentV1; summary?: string; executed?: boolean } | undefined;
  guidance?(request: AgentRunRequest): string | undefined;
  /**
   * The request-bound context pack for this envelope (CTX-010): complete
   * eligible admission, the selected skills, the approved hints, the domain
   * briefing. The vocabulary the interpreter reads is a view over it.
   */
  buildContextPack?(request: AgentRunRequest, envelope: DomainContextEnvelope): Promise<LocalContextPack | undefined>;
  /** The thread's compacted memory for a follow-up. */
  conversation?(request: AgentRunRequest): { summary?: string; pendingClarification?: string } | undefined;
  /**
   * The catalog's own search (full text over names, descriptions and documented
   * columns), held to the request's domains. The SQL drafter finds the tables a
   * question or a missing field names with it; a hit is kept only when the
   * request's projected source admits its relation.
   */
  searchCatalog?(request: AgentRunRequest, envelope: DomainContextEnvelope, query: string, options: { objectTypes: string[]; limit: number }): Array<{ objectType: string; name: string; relation?: string; description?: string }>;
  buildIdentity?(): Record<string, string>;
  maxRows?: number;
  /** Run the review-required SQL tier on its own when nothing governed prepares (default true); `agent.askAutoExploration: false` keeps it opt-in. */
  autoExploration?: boolean;
  /** Whether the project allowlists this physical column for an exact literal probe (`agent.runtimeValueGrounding`). */
  literalProbeAllowed?(relation: string, column: string): boolean;
  /** Distinct stored values equal to the literal ignoring case, on an allowlisted column; bounded, equality-predicated. */
  probeLiteral?(relation: string, column: string, value: string, connection: ConnectionConfig): Promise<string[]>;
  /** The entity keys behind a label value on an allowlisted label column (`SELECT DISTINCT key, label ... LIMIT 6`). */
  probeLabelKeys?(relation: string, keyColumn: string, labelColumn: string, value: string, connection: ConnectionConfig): Promise<Array<{ key: string; label: string }>>;
  /**
   * Open a physical trace span for a warehouse statement or a value probe;
   * the host never records SQL or values, only fingerprints and outcomes.
   */
  traceExecution?(request: AgentRunRequest, span: AskHostTraceSpan): { finish(outcome: 'ok' | 'error', extra?: { rowCount?: number; resultFingerprint?: string; safeErrorCode?: string }): void } | undefined;
}

export type AskHostTraceSpan =
  | { name: 'sql.execute'; sqlFingerprint: string; purpose: 'query' | 'fanout_probe'; tier?: 'certified' | 'semantic' | 'relational' | 'exploratory' }
  | { name: 'tool.call'; toolKind: 'search_values'; inputFingerprint: string };

const fingerprintText = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 24);

interface VocabularyCacheEntry { key: string; source: VocabularySource }

type ProbedRelation = NonNullable<VocabularySourceInput['relations']>[number];
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const METADATA_PAGE_SIZE = 800;

type ProbeIdentifier = { database?: PhysicalIdentifierPartV1; schema?: PhysicalIdentifierPartV1; table: PhysicalIdentifierPartV1; raw: string };

/** Only simple dbt/Snowflake identifiers enter a metadata predicate. */
function probeIdentifier(raw: string): ProbeIdentifier | undefined {
  const parts = parsePhysicalIdentifier(raw);
  const table = parts.at(-1);
  const schema = parts.length >= 2 ? parts.at(-2) : undefined;
  const database = parts.length >= 3 ? parts.at(-3) : undefined;
  if (parts.length > 3 || !table || (!table.quoted && !IDENTIFIER.test(table.value)) || (schema && !schema.quoted && !IDENTIFIER.test(schema.value)) || (database && !database.quoted && !IDENTIFIER.test(database.value))) return undefined;
  return { ...(database ? { database } : {}), ...(schema ? { schema } : {}), table, raw };
}

const sqlLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;
const probeSegment = (part: PhysicalIdentifierPartV1) => part.quoted ? `"${part.value.replace(/"/g, '""')}"` : part.value;
const probeMatch = (column: string, part: PhysicalIdentifierPartV1) => part.quoted
  ? `${column} = ${sqlLiteral(part.value)}`
  : `LOWER(${column}) = ${sqlLiteral(part.value.toLowerCase())}`;

function probePredicate(relation: ProbeIdentifier): string {
  return relation.schema
    ? `(${probeMatch('table_schema', relation.schema)} AND ${probeMatch('table_name', relation.table)})`
    : `(${probeMatch('table_name', relation.table)})`;
}

/**
 * The information_schema lookup for a handful of NAMED relations: identifiers
 * only, a bounded predicate list, a row cap. It reads column names and types,
 * never row values, so it is a metadata point lookup rather than discovery.
 */
export function relationColumnsProbeSql(relations: string[], maxRelations = 8, offset = 0, driver = 'snowflake'): string | undefined {
  const groups = new Map<string, ProbeIdentifier[]>();
  const seen = new Set<string>();
  for (const raw of relations) {
    const relation = probeIdentifier(raw);
    if (!relation) continue;
    const partKey = (part: PhysicalIdentifierPartV1 | undefined) => part ? `${part.quoted ? 'q' : 'u'}:${part.quoted ? part.value : part.value.toLowerCase()}` : '';
    const key = [relation.database, relation.schema, relation.table].map(partKey).join('.');
    if (seen.has(key)) continue;
    seen.add(key);
    const group = relation.database ? `${relation.database.quoted ? 'q' : 'u'}:${relation.database.value}` : '';
    const list = groups.get(group) ?? [];
    list.push(relation);
    groups.set(group, list);
    if (seen.size >= maxRelations) break;
  }
  if (groups.size === 0) return undefined;
  // Snowflake's INFORMATION_SCHEMA is per database.  A database-qualified
  // dbt relation therefore MUST NOT be collapsed into the session database.
  // Every branch retains table_catalog so rows merge only back into the exact
  // binding that asked for them. `ROW_NUMBER` makes a bounded page explicit;
  // callers mark an exact-page result partial rather than treating it absent.
  const databaseScopedInformationSchema = driver.toLowerCase() === 'snowflake';
  const branches = [...groups.entries()].map(([, group]) => {
    const database = group[0]?.database;
    // Snowflake's information schema is per database. DuckDB (and most
    // other local engines) exposes the current connection's information
    // schema directly; prefixing it with the dbt catalog produces a relation
    // that does not exist. Keep exact database identity for Snowflake while
    // retaining a valid local-MetricFlow discovery path.
    const source = database && databaseScopedInformationSchema ? `${probeSegment(database)}.information_schema.columns` : 'information_schema.columns';
    const catalog = database ? sqlLiteral(database.value) : 'CURRENT_DATABASE()';
    const predicate = group.map(probePredicate).join(' OR ');
    return [
      'SELECT table_catalog, table_schema, table_name, column_name, data_type, ordinal_position, dql_column_total',
      'FROM (',
      `  SELECT ${catalog} AS table_catalog, table_schema, table_name, column_name, data_type, ordinal_position,`,
      '    ROW_NUMBER() OVER (PARTITION BY table_schema, table_name ORDER BY ordinal_position) AS dql_column_page,',
      '    COUNT(*) OVER (PARTITION BY table_schema, table_name) AS dql_column_total',
      `  FROM ${source}`,
      "  WHERE UPPER(table_schema) NOT IN ('INFORMATION_SCHEMA', 'PG_CATALOG')",
      `    AND (${predicate})`,
      ') dql_columns',
      `WHERE dql_column_page > ${Math.max(0, offset)} AND dql_column_page <= ${Math.max(0, offset) + METADATA_PAGE_SIZE}`,
    ].join('\n');
  });
  return `${branches.join('\nUNION ALL\n')}\nORDER BY table_catalog, table_schema, table_name, ordinal_position`;
}

/**
 * A probed relation under the name the probe ASKED for: the warehouse spells
 * CONSUMPTION_METRICS.HEADER where the manifest says consumption_metrics.header,
 * and the vocabulary must merge the columns into the manifest's relation, not
 * add a second one. A relation nobody asked for keeps the warehouse's spelling.
 */
export function underAskedNames(found: ProbedRelation[], wanted: string[]): ProbedRelation[] {
  const asked = wanted.map(probeIdentifier).filter((item): item is ProbeIdentifier => Boolean(item));
  const samePart = (actual: string | undefined, wantedPart: PhysicalIdentifierPartV1 | undefined) => {
    if (!wantedPart) return true;
    if (!actual) return false;
    return wantedPart.quoted ? actual === wantedPart.value : actual.toLowerCase() === wantedPart.value.toLowerCase();
  };
  const rawPart = (part: PhysicalIdentifierPartV1) => probeSegment(part);
  const bindingFor = (relation: ProbedRelation, requested?: ProbeIdentifier) => {
    const physical = requested?.database
      ? requested.raw
      : [relation.database, requested?.schema ? rawPart(requested.schema) : relation.schema, requested ? rawPart(requested.table) : relation.name].filter(Boolean).join('.');
    const logical = requested?.schema ? `${requested.schema.value}.${requested.table.value}` : requested?.table.value ?? (relation.schema ? `${relation.schema}.${relation.name}` : relation.name);
    return physicalRelationBinding({
      logicalRelation: logical,
      physicalRelation: physical,
      source: 'warehouse_probe',
      columns: relation.columns.map((column) => ({ name: column.name, ...(column.dataType ? { type: column.dataType } : {}), ...(column.description ? { description: column.description } : {}) })),
      columnCompleteness: relation.columnCompleteness ?? 'partial',
      ...(relation.observedAt ? { observedAt: relation.observedAt } : {}),
      ...(relation.truncated ? { truncated: true } : {}),
    });
  };
  return found.map((relation) => {
    const matching = asked.filter((candidate) => samePart(relation.database, candidate.database) && samePart(relation.schema, candidate.schema) && samePart(relation.name, candidate.table));
    // A short alias is safe only when this request identifies one exact
    // physical object. Keep a warehouse spelling otherwise, rather than
    // mapping DB_A.PUBLIC.EVENTS onto DB_B.PUBLIC.EVENTS by tail name.
    const requested = matching.length === 1 ? matching[0] : undefined;
    const binding = bindingFor(relation, requested);
    return {
      ...relation,
      ...(requested ? { name: requested.table.value, ...(requested.schema ? { schema: requested.schema.value } : {}), ...(requested.database ? { database: requested.database.value } : {}) } : {}),
      binding,
    };
  });
}

/** Probe rows grouped into relations the vocabulary can merge. */
export function relationsFromProbeRows(rows: Array<Record<string, unknown>>, complete = true, offset = 0): ProbedRelation[] {
  const byRelation = new Map<string, ProbedRelation & { dqlColumnTotal?: number }>();
  for (const row of rows) {
    const record = Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]));
    const schema = typeof record.table_schema === 'string' ? record.table_schema : undefined;
    const database = typeof record.table_catalog === 'string' ? record.table_catalog : undefined;
    const name = typeof record.table_name === 'string' ? record.table_name : undefined;
    const column = typeof record.column_name === 'string' ? record.column_name : undefined;
    if (!name || !column) continue;
    const key = [database, schema, name].filter(Boolean).join('.');
    const total = typeof record.dql_column_total === 'number'
      ? record.dql_column_total
      : typeof record.dql_column_total === 'string' && /^\d+$/.test(record.dql_column_total) ? Number(record.dql_column_total) : undefined;
    const relation = byRelation.get(key) ?? { ...(database ? { database } : {}), ...(schema ? { schema } : {}), name, columns: [], columnCompleteness: complete ? 'complete' : 'partial', observedAt: new Date().toISOString(), ...(total !== undefined ? { dqlColumnTotal: total } : {}) };
    relation.columns.push({ name: column, ...(typeof record.data_type === 'string' && record.data_type ? { dataType: record.data_type } : {}) });
    if (total !== undefined) relation.dqlColumnTotal = total;
    byRelation.set(key, relation);
  }
  return [...byRelation.values()].map(({ dqlColumnTotal, ...relation }) => {
    // A page boundary belongs to each relation.  A batch with A=800 and B=1
    // is not one 801-column relation: only the relation whose own page is
    // incomplete stays partial.  Count windows give a definitive answer when
    // the driver exposes them; mocks/older engines remain conservative.
    const fullyLoaded = dqlColumnTotal !== undefined
      ? offset + relation.columns.length >= dqlColumnTotal
      : relation.columns.length < METADATA_PAGE_SIZE;
    return {
      ...relation,
      columnCompleteness: complete && fullyLoaded ? 'complete' : 'partial',
      ...(!fullyLoaded ? { truncated: true } : {}),
    };
  });
}

/**
 * Relations the vocabulary knows by name but not by column: a table the
 * semantic layer or a dbt source references that no manifest documented, or
 * one documented without types. A partial description is not evidence that
 * the other columns are absent.
 */
/**
 * Rows of Snowflake's `SHOW COLUMNS IN <table>` in the shape of the
 * information_schema probe (`table_catalog … dql_column_total`), so one
 * grouping routine serves both. `data_type` arrives as JSON
 * (`{"type":"FIXED","precision":38,"scale":0,…}`); the type name is kept and
 * FIXED/TEXT/REAL are spelled as the column roles expect.
 */
export function snowflakeShowColumnsRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const record = Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]));
    const name = typeof record.column_name === 'string' ? record.column_name : undefined;
    const table = typeof record.table_name === 'string' ? record.table_name : undefined;
    if (!name || !table) continue;
    let type: string | undefined = typeof record.data_type === 'string' ? record.data_type : undefined;
    if (type && type.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(type) as { type?: string; precision?: number; scale?: number; length?: number };
        const kind = typeof parsed.type === 'string' ? parsed.type.toUpperCase() : undefined;
        type = kind === 'FIXED' ? `NUMBER(${parsed.precision ?? 38},${parsed.scale ?? 0})`
          : kind === 'TEXT' ? `VARCHAR${parsed.length ? `(${parsed.length})` : ''}`
            : kind === 'REAL' ? 'FLOAT'
              : kind;
      } catch { /* keep the raw spelling */ }
    }
    out.push({
      ...(typeof record.database_name === 'string' ? { table_catalog: record.database_name } : {}),
      ...(typeof record.schema_name === 'string' ? { table_schema: record.schema_name } : {}),
      table_name: table,
      column_name: name,
      ...(type ? { data_type: type } : {}),
      ordinal_position: out.length + 1,
    });
  }
  for (const row of out) row.dql_column_total = out.filter((other) => other.table_name === row.table_name && other.table_schema === row.table_schema).length;
  return out;
}

/**
 * The database each dbt relation lives in, from the manifest's provenance
 * (`"DB"."SCHEMA"."TABLE"`), keyed by `schema.table` in lower case. The
 * vocabulary identifies a relation by schema and table; a warehouse that
 * addresses objects across databases (Snowflake) is written the full name.
 */
export function relationDatabases(manifest: { dbtProvenance?: { nodes: Record<string, { relation?: string }> } } | undefined): Map<string, string> {
  const candidates = new Map<string, Set<string>>();
  const legacyAliases = new Map<string, string>();
  for (const node of Object.values(manifest?.dbtProvenance?.nodes ?? {})) {
    const parts = parsePhysicalIdentifier(node.relation ?? '');
    if (parts.length === 3) {
      // The key encodes quote state.  `PUBLIC.EVENTS` and
      // `"Public"."Events"` are different Snowflake identities.
      const key = physicalRelationIdentity([parts[1], parts[2]].map((part) => part.quoted ? `"${part.value.replace(/"/g, '""')}"` : part.value).join('.'));
      const seen = candidates.get(key) ?? new Set<string>();
      const database = parts[0]!;
      seen.add(database.quoted ? `"${database.value.replace(/"/g, '""')}"` : database.value);
      candidates.set(key, seen);
      // Keep stored schema.table references working only when the exact-tail
      // provenance resolves to one database. The physical identity remains the
      // authoritative lookup; this alias is a compatibility convenience.
      legacyAliases.set(key, [parts[1], parts[2]].map((part) => part.value.toLowerCase()).join('.'));
    }
  }
  const out = new Map<string, string>();
  for (const [key, databases] of candidates) if (databases.size === 1) {
    const database = [...databases][0]!;
    out.set(key, database);
    const legacy = legacyAliases.get(key);
    if (legacy) out.set(legacy, database);
  }
  return out;
}

/** `schema.table` as the warehouse addresses it: with its database on Snowflake when provenance knows it; unchanged elsewhere. */
export function physicalRelationName(relation: string, databases: Map<string, string>, driver: string | undefined): string {
  if (driver?.toLowerCase() !== 'snowflake') return relation;
  const parts = parsePhysicalIdentifier(relation);
  if (parts.length !== 2) return relation;
  const database = databases.get(physicalRelationIdentity(relation))
    ?? databases.get(parts.map((part) => part.value.toLowerCase()).join('.'));
  return database ? `${database}.${relation}` : relation;
}

/** The wall-clock budget of the column probe per snapshot and connection; `DQL_ASK_COLUMN_PROBE_MS` overrides (default 12 s). */
export function columnProbeBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.DQL_ASK_COLUMN_PROBE_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 12_000;
}

export function relationsNeedingColumns(source: ReturnType<typeof buildVocabularySource>, max = 48): string[] {
  // A relation the warehouse has not described yet: no columns at all, or a
  // handful a cube or a binding happened to name (one exposed key does not
  // make "the team directory only exposes team_id" true — the relation has
  // its columns, the vocabulary just has not asked for them).
  const sparse = (relation: { columns: Array<{ name: string; dataType?: string }>; columnCompleteness?: string }) => relation.columnCompleteness !== 'complete' || relation.columns.length < 4 || relation.columns.some((column) => !column.dataType);
  return (source.relations ?? [])
    .filter((relation) => sparse(relation))
    .map((relation) => relation.binding ? physicalRelationText(relation.binding) : [relation.schema, relation.name].filter(Boolean).join('.'))
    .slice(0, max);
}

/**
 * Relation-first discovery.  A manifest-only project may have tens of
 * thousands of documented columns, but ordinary questions need a handful of
 * tables.  Score embedded column metadata too, which keeps the enterprise
 * catalog storage bound without making the columns invisible to retrieval.
 */
type RelevanceIndex = {
  relations: Array<{ name: string; words: Set<string>; tail: string; partial: number }>;
  semanticByTail: Map<string, Array<{ words: Set<string>; isTime: boolean }>>;
};
// The word sets of every relation and semantic entry, computed ONCE per base
// source (the source object is cached per snapshot and connection). Scoring
// per question is then an intersection with the question's few words. The
// first shape recomputed every description's words and walked every semantic
// entry for every relation on each question: 95 s on a 4,700-model project.
const relevanceIndexCache = new WeakMap<object, RelevanceIndex>();
const splitRelevanceIndexCache = new WeakMap<object, RelevanceIndex>();
const relevanceStem = (value: string) => {
  const lower = value.toLowerCase();
  if (lower.endsWith('ies') && lower.length > 4) return `${lower.slice(0, -3)}y`;
  if (lower.endsWith('ing') && lower.length > 5) return lower.slice(0, -3);
  if (lower.endsWith('ed') && lower.length > 4) return lower.slice(0, -2);
  if (lower.endsWith('s') && lower.length > 3 && !lower.endsWith('ss')) return lower.slice(0, -1);
  return lower;
};
const relevanceWords = (values: Array<string | undefined>, splitNames = false): Set<string> => {
  const words = new Set<string>();
  for (const text of values) {
    if (!text) continue;
    for (const word of text.toLowerCase().split(/[^a-z0-9_]+/)) {
      if (word.length > 2) words.add(relevanceStem(word));
      // COMPETITOR_C, PRIMARY_COMPETITOR: a column name is words joined by
      // underscores, and a question names the words, not the spelling.
      // The governed context keeps whole names (its cards, and the recorded
      // prompts, depend on the relations it hydrates); the SQL drafter splits.
      if (splitNames && word.includes('_')) for (const part of word.split('_')) if (part.length > 2) words.add(relevanceStem(part));
    }
  }
  return words;
};
const relevanceTail = (value: string | undefined) => {
  const parts = parsePhysicalIdentifier(value ?? '');
  if (parts.length === 0) return '';
  return parts.slice(-2).map((part) => `${part.quoted ? 'q' : 'u'}:${part.quoted ? part.value : part.value.toLowerCase()}`).join('.');
};
function relevanceIndexFor(source: ReturnType<typeof buildVocabularySource>, splitNames = false): RelevanceIndex {
  const cache = splitNames ? splitRelevanceIndexCache : relevanceIndexCache;
  const cached = cache.get(source);
  if (cached) return cached;
  type SemanticSource = NonNullable<VocabularySource['metrics']>[number]
    | NonNullable<VocabularySource['measures']>[number]
    | NonNullable<VocabularySource['dimensions']>[number]
    | NonNullable<VocabularySource['entities']>[number];
  const semanticEntries: SemanticSource[] = [...(source.metrics ?? []), ...(source.measures ?? []), ...(source.dimensions ?? []), ...(source.entities ?? [])];
  const semanticByTail = new Map<string, Array<{ words: Set<string>; isTime: boolean }>>();
  for (const entry of semanticEntries) {
    const physical = entry.physical?.relation;
    if (!physical) continue;
    const tail = relevanceTail(physical);
    const list = semanticByTail.get(tail) ?? [];
    list.push({
      words: relevanceWords([entry.name, 'label' in entry ? entry.label : undefined, entry.description, 'aliases' in entry ? entry.aliases?.join(' ') : undefined, entry.physical?.column], splitNames),
      isTime: ('isTime' in entry && Boolean(entry.isTime)) || ('dataType' in entry && /(?:date|time|timestamp)/i.test(entry.dataType ?? '')),
    });
    semanticByTail.set(tail, list);
  }
  const relations = (source.relations ?? []).map((relation) => {
    const name = relation.binding ? physicalRelationText(relation.binding) : [relation.schema, relation.name].filter(Boolean).join('.');
    return {
      name,
      // Large dbt manifests keep column data embedded on the relation rather
      // than as catalog objects; that relation-level lane is only for
      // selection: physical columns are still hydrated and validated before
      // an Ask run can use them.
      words: relevanceWords([relation.name, relation.schema, relation.description, ...relation.columns.flatMap((column) => [column.name, column.description]), ...(relation.embeddedColumns ?? []).flatMap((column) => [column.name, column.description])], splitNames),
      tail: relevanceTail(name),
      partial: relation.columnCompleteness !== 'complete' ? 1 : 0,
    };
  });
  const index = { relations, semanticByTail };
  cache.set(source, index);
  return index;
}

/**
 * Relation-first discovery.  A manifest-only project may have tens of
 * thousands of documented columns, but ordinary questions need a handful of
 * tables.  Score embedded column metadata too, which keeps the enterprise
 * catalog storage bound without making the columns invisible to retrieval.
 *
 * Compare distinct terms (a relation description repeated on every column
 * must not outrank the narrow fact table), then give the physical home of a
 * matching semantic field a bounded boost. The boost selects metadata to
 * inspect; it is never a binding or evidence that two fields compose.
 */
/**
 * THE WIDER LOOK. A draft over the tables first chosen found no field for
 * something the question asks: every relation in the source is searched for a
 * column whose name or description carries those words. Words the question,
 * the reading's open clauses or the conversation used weigh more than words
 * only the drafter's sentence used, so "competitor" outranks "primary".
 */
export function relationsWithColumnWords(
  source: Pick<VocabularySource, 'relations'>,
  words: string[],
  emphasis: string,
  exclude: string[],
  max = 3,
): string[] {
  const wanted = [...relevanceWords(words, true)];
  if (wanted.length === 0) return [];
  const emphasized = relevanceWords([emphasis], true);
  const excluded = new Set(exclude.map((name) => physicalRelationIdentity(name)));
  return (source.relations ?? [])
    .map((relation) => {
      const name = relation.binding ? physicalRelationText(relation.binding) : [relation.schema, relation.name].filter(Boolean).join('.');
      const columnWords = [...relation.columns, ...(relation.embeddedColumns ?? [])].map((column) => relevanceWords([column.name, column.description], true));
      let score = 0;
      for (const word of wanted) if (columnWords.some((set) => set.has(word))) score += emphasized.has(word) ? 3 : 1;
      return { name, score };
    })
    .filter((item) => item.score > 0 && !excluded.has(physicalRelationIdentity(item.name)))
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, max)
    .map((item) => item.name);
}

/**
 * Catalog hits (a documented column, a model) named as the relations the
 * request's projected source admits, in hit order. A hit whose relation is
 * outside the source is outside the envelope and is dropped.
 */
export function relationsFromCatalogHits(
  hits: Array<{ objectType: string; name: string; relation?: string }>,
  scoped: Pick<VocabularySource, 'relations'> | undefined,
  exclude: string[],
  max = 3,
): string[] {
  const tail = (value: string) => parsePhysicalIdentifier(value).slice(-2).map((part) => part.value.toLowerCase()).join('.');
  const admitted = new Map<string, string>();
  for (const relation of scoped?.relations ?? []) {
    const name = relation.binding ? physicalRelationText(relation.binding) : [relation.schema, relation.name].filter(Boolean).join('.');
    admitted.set(tail(name), name);
    if (!admitted.has(relation.name.toLowerCase())) admitted.set(relation.name.toLowerCase(), name);
  }
  const excluded = new Set(exclude.map((name) => physicalRelationIdentity(name)));
  const picked: string[] = [];
  for (const hit of hits) {
    const raw = hit.relation ?? (hit.objectType === 'dbt_column' ? undefined : hit.name);
    if (!raw) continue;
    const name = admitted.get(tail(raw)) ?? admitted.get(raw.toLowerCase());
    if (!name || excluded.has(physicalRelationIdentity(name)) || picked.includes(name)) continue;
    picked.push(name);
    if (picked.length >= max) break;
  }
  return picked;
}

const MISSING_WORD_STOP = new Set(['column', 'columns', 'table', 'tables', 'relation', 'relations', 'field', 'fields', 'listed', 'available', 'such', 'that', 'this', 'which', 'with', 'from', 'there', 'none', 'into', 'filter', 'value', 'values', 'named', 'name', 'holds', 'hold', 'question', 'asked', 'data', 'these', 'those', 'what', 'where', 'records', 'record', 'cannot', 'answer', 'nothing', 'missing', 'only', 'contain', 'contains']);
/** The words of a decline and of the reading's open clauses that could name a column. */
export function missingFieldWords(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 3 && !/^\d+$/.test(word) && !MISSING_WORD_STOP.has(word)))].slice(0, 10);
}

export function relevantRelationsForQuestion(
  source: ReturnType<typeof buildVocabularySource>,
  question: string,
  max = 3,
  options: { splitNames?: boolean } = {},
): string[] {
  const index = relevanceIndexFor(source, options.splitNames);
  const words = relevanceWords([question], options.splitNames);
  if (words.size === 0) return [];
  const requestsTime = [...words].some((word) => ['date', 'day', 'week', 'month', 'quarter', 'year', 'calendar', 'fiscal', 'period'].includes(word));
  const overlap = (set: Set<string>) => { let count = 0; for (const word of words) if (set.has(word)) count += 1; return count; };
  const scored = index.relations.map((relation) => {
    const matched = overlap(relation.words);
    // A requested time grain must hydrate the fact relation that owns a
    // compatible time field even when its manifest lists only keys. A direct
    // semantic-name hit is stronger than a repeated word in an unrelated
    // model's column descriptions.
    const semanticAffinity = (index.semanticByTail.get(relation.tail) ?? []).reduce((sum, entry) => sum + overlap(entry.words) * 12 + (requestsTime && entry.isTime ? 12 : 0), 0);
    return { name: relation.name, matched, semanticAffinity, score: matched * 10 + semanticAffinity + relation.partial };
  });
  // A question that matches nothing hydrates nothing: probing three
  // alphabetically-first partial relations costs warehouse round trips and
  // tells the interpreter nothing about this question.
  return scored
    .filter((item) => item.matched > 0 || item.semanticAffinity > 0)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, max)
    .map((item) => item.name);
}

/** Request-local extension used by both the drafter and SQL validator. */
export function runtimeSchemaForVocabulary(vocabulary: VocabularyIndex): RuntimeSchemaTable[] {
  return vocabulary.entries
    .filter((entry) => entry.kind === 'relation')
    .map((entry) => {
      const binding = entry.physical?.binding;
      const logical = entry.model ?? entry.name;
      const relation = binding ? physicalRelationText(binding) : logical;
      const columns = columnsForPhysicalEntry(vocabulary, entry);
      return {
        relation,
        ...(binding?.database ? { catalogOrDatabase: binding.database.value } : {}),
        ...(binding?.schema ? { schema: binding.schema.value } : {}),
        name: binding?.table.value ?? entry.name,
        ...(binding?.executionTargetFingerprint ? { executionTargetFingerprint: binding.executionTargetFingerprint } : {}),
        ...(entry.description ? { description: entry.description } : {}),
        columns,
        source: binding?.source ?? 'vocabulary relation',
        columnCompleteness: binding?.columnCompleteness === 'unknown' ? 'partial' : binding?.columnCompleteness ?? 'partial',
      };
    });
}

function entryPhysicalRelation(entry: VocabularyEntry | undefined): string | undefined {
  if (!entry) return undefined;
  return entry.physical?.binding ? physicalRelationText(entry.physical.binding) : entry.physical?.relation ?? (entry.kind === 'relation' ? entry.model ?? entry.name : undefined);
}

/** Exact physical identity whenever a binding exists; legacy unbound entries
 * retain their one stored relation identity. This is intentionally not the
 * logical schema.table alias used to keep old references readable. */
function physicalEntryIdentity(entry: VocabularyEntry | undefined): string | undefined {
  const relation = entryPhysicalRelation(entry);
  return relation ? physicalRelationIdentity(relation) : undefined;
}

function samePhysicalEntry(left: VocabularyEntry | undefined, right: VocabularyEntry | undefined): boolean {
  const leftIdentity = physicalEntryIdentity(left);
  const rightIdentity = physicalEntryIdentity(right);
  return Boolean(leftIdentity && rightIdentity && leftIdentity === rightIdentity);
}

/** The one column admission path for runtime validation and draft cards. */
export function columnsForPhysicalEntry(vocabulary: VocabularyIndex, relation: VocabularyEntry | undefined): Array<{ name: string; type?: string; description?: string }> {
  return vocabulary.entries
    // A logical dbt name is a compatibility alias, not a physical join key.
    // Two Snowflake databases may both expose PUBLIC.EVENTS; columns admitted
    // for DB_A must never appear in DB_B's draft/validator card.
    .filter((candidate) => candidate.kind === 'column' && samePhysicalEntry(candidate, relation))
    .map((column) => ({ name: column.physical?.column ?? column.name, ...(column.dataType ? { type: column.dataType } : {}), ...(column.description ? { description: column.description } : {}) }));
}

/**
 * GROUND MEMBER LITERALS. A question says "Ryan byrd"; the warehouse holds
 * "Ryan Byrd". The relational tier compares case-insensitively, the semantic
 * compilers do not, so the literal is looked up once, on columns the project
 * explicitly allowlists, and replaced by the stored value. One stored value
 * is a correction; several are left to the query; none is recorded so the
 * reader learns the member is absent rather than seeing an empty aggregate.
 */
export async function groundIntentLiterals(
  intent: AnalyticalIntentV1,
  vocabulary: VocabularyIndex,
  connection: ConnectionConfig,
  deps: Pick<AskPipelineHostDeps, 'literalProbeAllowed' | 'probeLiteral' | 'probeLabelKeys'>,
): Promise<{ intent: AnalyticalIntentV1; notes: string[] }> {
  const notes: string[] = [];
  const ground = async <T extends { ref: string; op: string; values: unknown[] }>(predicate: T): Promise<T> => {
    if (!(predicate.op === 'eq' || predicate.op === 'in') || !predicate.values.some((value) => typeof value === 'string')) return predicate;
    const entry = vocabulary.get(predicate.ref);
    const relation = entryPhysicalRelation(entry);
    const column = entry?.physical?.column;
    if (!relation || !column || !deps.literalProbeAllowed!(relation, column)) return predicate;
    const values: unknown[] = [];
    for (const value of predicate.values) {
      if (typeof value !== 'string' || !value.trim()) { values.push(value); continue; }
      let stored: string[];
      try { stored = await deps.probeLiteral!(relation, column, value, connection); } catch (error) { notes.push(`${column}: probe failed (${error instanceof Error ? error.message : String(error)})`); values.push(value); continue; }
      if (stored.length === 1 && stored[0] !== value) { notes.push(`${column}: ${JSON.stringify(value)} is stored as ${JSON.stringify(stored[0])}`); values.push(stored[0]); }
      else if (stored.length === 0) { notes.push(`${column}: no stored value matches ${JSON.stringify(value)}`); values.push(value); }
      else values.push(value);
    }
    return { ...predicate, values };
  };
  const filters = [] as AnalyticalIntentV1['filters'];
  for (const predicate of intent.filters) filters.push(await ground(predicate));
  const measures = [] as AnalyticalIntentV1['measures'];
  for (const measure of intent.measures) {
    if (!measure.scope?.length) { measures.push(measure); continue; }
    const scope = [] as NonNullable<AnalyticalIntentV1['measures'][number]['scope']>;
    for (const predicate of measure.scope) scope.push(await ground(predicate));
    measures.push({ ...measure, scope });
  }
  let next: AnalyticalIntentV1 = { ...intent, filters, measures };
  // IDENTITY. A singular label ("Ryan Byrd") can name several members. The
  // keys behind the label are looked up on the same allowlist; several keys
  // make the answer one row per member, keyed, with the label displayed,
  // never one merged number.
  if (deps.probeLabelKeys) {
    for (const predicate of next.filters) {
      if (!(predicate.op === 'eq' || predicate.op === 'in') || predicate.values.length !== 1 || typeof predicate.values[0] !== 'string') continue;
      const entry = vocabulary.get(predicate.ref);
      const relation = entryPhysicalRelation(entry);
      const column = entry?.physical?.column;
      if (!entry || !relation || !column || !entry.roles.includes('label') || !deps.literalProbeAllowed!(relation, column)) continue;
      const owner = vocabulary.entries.find((candidate) => candidate.kind === 'entity' && candidate.model === entry.model && candidate.entityType === 'primary' && entryPhysicalRelation(candidate) === relation && candidate.physical?.column);
      if (!owner?.physical?.column) continue;
      let members: Array<{ key: string; label: string }>;
      try { members = await deps.probeLabelKeys(relation, owner.physical.column, column, predicate.values[0], connection); } catch (error) { notes.push(`${column}: key probe failed (${error instanceof Error ? error.message : String(error)})`); continue; }
      const keys = [...new Set(members.map((member) => member.key))];
      if (keys.length <= 1) { if (keys.length === 1) notes.push(`identity: ${JSON.stringify(predicate.values[0])} identifies one ${owner.name}`); continue; }
      const keyed = next.groupBy.some((group) => group.ref === owner.ref);
      next = {
        ...next,
        groupBy: keyed ? next.groupBy : [{ ref: owner.ref, role: 'key' }, ...next.groupBy],
        display: next.display.includes(predicate.ref) ? next.display : [...next.display, predicate.ref],
        expectedShape: next.expectedShape === 'scalar' || next.expectedShape === 'comparison' || next.expectedShape === 'lookup' ? 'grouped' : next.expectedShape,
        provenance: { ...next.provenance, [owner.ref]: next.provenance[owner.ref] ?? `host:${keys.length} ${owner.name}s share ${JSON.stringify(predicate.values[0])}; one row per ${owner.name}` },
      };
      notes.push(`identity: ${keys.length} ${owner.name}s share the name ${JSON.stringify(predicate.values[0])}; one row per ${owner.name}, keyed by ${owner.physical.column}`);
    }
  }
  return { intent: next, notes };
}

/** Value probes are tool calls in the physical trace: one `search_values` span each, fingerprints only. */
export function tracedProbes(deps: Pick<AskPipelineHostDeps, 'literalProbeAllowed' | 'probeLiteral' | 'probeLabelKeys' | 'traceExecution'>, request: AgentRunRequest): Pick<AskPipelineHostDeps, 'literalProbeAllowed' | 'probeLiteral' | 'probeLabelKeys'> {
  if (!deps.traceExecution) return deps;
  const traced = async <T>(input: string, work: () => Promise<T>): Promise<T> => {
    const span = deps.traceExecution!(request, { name: 'tool.call', toolKind: 'search_values', inputFingerprint: fingerprintText(input) });
    try { const value = await work(); span?.finish('ok'); return value; } catch (error) { span?.finish('error', { safeErrorCode: 'probe_failure' }); throw error; }
  };
  return {
    literalProbeAllowed: deps.literalProbeAllowed,
    ...(deps.probeLiteral ? { probeLiteral: (relation, column, value, connection) => traced(`${relation}.${column}=${value}`, () => deps.probeLiteral!(relation, column, value, connection)) } : {}),
    ...(deps.probeLabelKeys ? { probeLabelKeys: (relation, key, label, value, connection) => traced(`${relation}.${key}/${label}=${value}`, () => deps.probeLabelKeys!(relation, key, label, value, connection)) } : {}),
  };
}

/**
 * Join paths over the relationships the team declared in Domain Studio.
 * Each relationship names two modeling entities bound to dbt models, with
 * the key pairs; a breadth-first walk over the undirected graph finds the
 * shortest declared path between two physical relations. Deprecated or
 * rejected relationships never join; a draft one does, and the proof says so.
 */
/**
 * JOIN AUTHORITY (REL-002, amendment A-003). Two graphs over the declared
 * relationships: the AUTHORIZED one, whose edges pass the complete executable
 * invariant (`assessAnalyticalRelationship`: certified, fresh proof, safe
 * fanout, cross-domain chain), and the DECLARED-UNPROVEN one, whose edges are
 * offers — a draft says a join exists, and the host may prove or refuse it,
 * never take it on the author's word. Each authorized step carries its
 * authority so the receipt can name it.
 */
export interface ModelingJoinGraph {
  path(fromRelation: string, toRelation: string): RelationalJoinStep[] | undefined;
  unproven(fromRelation: string, toRelation: string): UnprovenJoin[];
  /** Every domain a relation is bound to through a modeled entity; empty when none. */
  domainsOf(relation: string): string[];
  /** The declared relationship between two relations, when exactly one exists, for a proof to honour its keys and direction. */
  declared(fromRelation: string, toRelation: string): { id: string; keys: Array<{ from: string; to: string }>; cardinality: string; fanout: string; reversed: boolean } | undefined;
  hasDomains: boolean;
}

export function modelingJoinGraph(manifest: DQLManifest | undefined, quoteRelation: (relation: string) => string): ModelingJoinGraph {
  const modeling = manifest?.modeling;
  const empty: ModelingJoinGraph = { path: () => undefined, unproven: () => [], domainsOf: () => [], declared: () => undefined, hasDomains: false };
  if (!modeling) return empty;
  const relationOfEntity = new Map<string, string>();
  const domainsOfRelation = new Map<string, Set<string>>();
  for (const entity of Object.values(modeling.entities ?? {})) {
    const relation = normalizeRelationName(manifest?.dbtProvenance?.nodes[entity.dbtUniqueId]?.relation);
    if (!relation) continue;
    for (const key of [entity.id, entity.localId, entity.qualifiedId]) if (key) relationOfEntity.set(key, relation);
    if (entity.domain) { if (!domainsOfRelation.has(relation)) domainsOfRelation.set(relation, new Set()); domainsOfRelation.get(relation)!.add(entity.domain); }
  }
  const authorized = new Map<string, Array<{ relation: string; on: string; authority: JoinAuthorityV1 }>>();
  const declared = new Map<string, Array<{ id: string; keys: Array<{ from: string; to: string }>; cardinality: string; fanout: string; status: string; reason: string; reversed: boolean }>>();
  const addAuthorized = (from: string, to: string, on: string, authority: JoinAuthorityV1) => {
    if (!authorized.has(from)) authorized.set(from, []);
    authorized.get(from)!.push({ relation: to, on, authority });
  };
  const addDeclared = (from: string, to: string, edge: { id: string; keys: Array<{ from: string; to: string }>; cardinality: string; fanout: string; status: string; reason: string; reversed: boolean }) => {
    const key = `${from}->${to}`;
    if (!declared.has(key)) declared.set(key, []);
    declared.get(key)!.push(edge);
  };
  const hasDomains = Object.keys(modeling.packages ?? {}).length > 0;
  for (const relationship of Object.values(modeling.relationships ?? {})) {
    if (relationship.status === 'deprecated') continue;
    const from = relationOfEntity.get(relationship.from);
    const to = relationOfEntity.get(relationship.to);
    if (!from || !to || from === to || relationship.keys.length === 0) continue;
    const decision = assessAnalyticalRelationship(relationship, manifest);
    const on = relationship.keys.map((key) => `${quoteRelation(from)}.${key.from} = ${quoteRelation(to)}.${key.to}`).join(' AND ');
    if (decision.executable) {
      const fromDomains = [...(domainsOfRelation.get(from) ?? [])];
      const toDomains = [...(domainsOfRelation.get(to) ?? [])];
      const crossDomain = Boolean(relationship.crossDomain) || (fromDomains.length > 0 && toDomains.length > 0 && !fromDomains.some((domain) => toDomains.includes(domain)));
      const authority: JoinAuthorityV1 = {
        version: 1, from, to, keys: relationship.keys, source: 'dql_relationship', relationshipId: relationship.qualifiedId ?? relationship.id, authority: 'certified',
        scope: crossDomain ? 'cross_domain_certified' : hasDomains ? 'within_domain' : 'no_domains', domains: { from: fromDomains, to: toDomains },
        ...(relationship.validation ? { evidence: relationship.validation } : {}),
      };
      addAuthorized(from, to, on, authority);
      addAuthorized(to, from, on, { ...authority, from: to, to: from, keys: relationship.keys.map((key) => ({ from: key.to, to: key.from })), domains: { from: toDomains, to: fromDomains } });
    } else {
      const edge = { id: relationship.qualifiedId ?? relationship.id, keys: relationship.keys, cardinality: relationship.cardinality, fanout: relationship.fanout, status: relationship.status, reason: decision.message, reversed: false };
      addDeclared(from, to, edge);
      addDeclared(to, from, { ...edge, keys: relationship.keys.map((key) => ({ from: key.to, to: key.from })), reversed: true });
    }
  }
  return {
    hasDomains,
    domainsOf: (relation) => [...(domainsOfRelation.get(relation) ?? [])],
    declared: (fromRelation, toRelation) => {
      const edges = declared.get(`${fromRelation}->${toRelation}`) ?? [];
      return edges.length === 1 ? edges[0] : undefined;
    },
    unproven: (fromRelation, toRelation) => (declared.get(`${fromRelation}->${toRelation}`) ?? []).map((edge) => ({ relationshipId: edge.id, from: fromRelation, to: toRelation, keys: edge.keys, status: edge.status, cardinality: edge.cardinality, fanout: edge.fanout, reason: edge.reason })),
    path: (fromRelation, toRelation) => {
      if (fromRelation === toRelation) return [];
      const previous = new Map<string, { relation: string; on: string; authority: JoinAuthorityV1 }>();
      const queue = [fromRelation];
      const seen = new Set([fromRelation]);
      while (queue.length) {
        const current = queue.shift()!;
        for (const edge of authorized.get(current) ?? []) {
          if (seen.has(edge.relation)) continue;
          seen.add(edge.relation);
          previous.set(edge.relation, { relation: current, on: edge.on, authority: edge.authority });
          if (edge.relation === toRelation) {
            const steps: RelationalJoinStep[] = [];
            for (let at = toRelation; at !== fromRelation;) {
              const step = previous.get(at)!;
              steps.unshift({ relation: at, on: step.on, authority: step.authority });
              at = step.relation;
            }
            return steps;
          }
          queue.push(edge.relation);
        }
      }
      return undefined;
    },
  };
}

/**
 * DOMAIN BOUNDARIES DECIDE BEFORE ANY PROBE (A-003). A project with no
 * domains may prove a join anywhere; two relations bound to one domain may be
 * proven within it; an endpoint nobody modeled, or one bound to several
 * domains, is a modeling gap; endpoints in different domains need the
 * governed interface chain and are never probed. Missing domain information
 * never widens eligibility.
 */
export function joinScopeDecision(
  fromRelation: string,
  toRelation: string,
  fromDomains: string[],
  toDomains: string[],
  hasDomains: boolean,
): { scope: JoinAuthorityV1['scope'] } | { refusal: PreparedRefusal } {
  if (!hasDomains) return { scope: 'no_domains' };
  if (fromDomains.length === 1 && toDomains.length === 1 && fromDomains[0] === toDomains[0]) return { scope: 'within_domain' };
  if (fromDomains.length === 0 || toDomains.length === 0 || fromDomains.length > 1 || toDomains.length > 1) {
    const which = [fromDomains.length !== 1 ? fromRelation : '', toDomains.length !== 1 ? toRelation : ''].filter(Boolean).join(' and ');
    return { refusal: { tier: 'relational', code: 'relationship_domain_unknown', message: `no certified relationship reaches ${toRelation} from ${fromRelation}, and ${which} ${which.includes(' and ') ? 'are' : 'is'} not bound to exactly one domain, so the warehouse was not asked to prove one; bind the relation to an entity in one domain, or declare and validate the relationship in Domain Studio`, repairable: false, relations: [fromRelation, toRelation] } };
  }
  return { refusal: { tier: 'relational', code: 'join_requires_domain_contract', message: `${fromRelation} (${fromDomains[0]}) and ${toRelation} (${toDomains[0]}) belong to different domains: a join across them needs a certified export from ${toDomains[0]}, a matching import in ${fromDomains[0]} with an allowed purpose, and a certified relationship; the warehouse is not asked to prove a cross-domain join`, repairable: false, relations: [fromRelation, toRelation] } };
}

/**
 * What a pinned envelope owns physically, and what each import carries: the
 * pinned domain with its ancestors and descendants, plus, per import
 * provider, the relations of the entities its matching exports name.
 */
/** The coverage evaluations of a receipt: UNSATISFIED words (a restriction the reading did not apply) warn; UNCERTAIN words (a lexical miss) inform. Neither is a passed check. */
export function coverageEvaluations(receipt: Pick<PipelineReceipt, 'uncovered' | 'coverage'>): Array<{ id: string; label: string; passed: boolean; severity: 'warning' | 'info'; message: string }> {
  if (!receipt.uncovered?.length) return [];
  const states = new Map((receipt.coverage ?? []).map((item) => [item.word, item.state]));
  const unsatisfied = receipt.uncovered.filter((word) => states.get(word) === 'unsatisfied');
  const uncertain = receipt.uncovered.filter((word) => states.get(word) !== 'unsatisfied');
  const quoted = (words: string[]) => words.map((word) => `"${word}"`).join(', ');
  return [
    ...(unsatisfied.length ? [{ id: 'pipeline-coverage', label: 'Question coverage', passed: false, severity: 'warning' as const, message: `The question restricts on ${quoted(unsatisfied)}, which this reading does not apply. Say the condition explicitly, or name the field it lives on.` }] : []),
    ...(uncertain.length ? [{ id: 'pipeline-coverage-uncertain', label: 'Question coverage', passed: false, severity: 'info' as const, message: `The question mentioned ${quoted(uncertain)}; this reading uses no field of that name, though it may cover it under another. If it was a condition or an output, say so explicitly.` }] : []),
  ];
}

const SCOPE_WORD_STOPWORDS = new Set(['what', 'which', 'show', 'give', 'list', 'have', 'with', 'from', 'that', 'this', 'each', 'many', 'much', 'total', 'both', 'need', 'please', 'could', 'would', 'should', 'about', 'their', 'there', 'than', 'then', 'into', 'over', 'using', 'calendar', 'season', 'year', 'top', 'five', 'rows', 'row', 'count', 'name', 'names', 'label', 'key', 'directory', 'facts', 'fact', 'table', 'column', 'dimension', 'defined', 'expected', 'specific', 'used', 'instead', 'grouping', 'vocabulary', 'exposes', 'only', 'more', 'than', 'one', 'way', 'read', 'governed', 'query', 'run', 'because', 'nearest']);

/**
 * Words of a question (or of the gap that answered it) that name an object
 * the whole inventory holds but this envelope does not — by exact name, and
 * only objects with a known owner. The explanation names the owner and what
 * admits it; nothing outside the scope is read.
 */
export function explainOutOfScopeWords(text: string, inventory: VocabularyIndex, scoped: VocabularyIndex, envelope: Pick<DomainContextEnvelope, 'activeDomain' | 'purpose'>): { message: string; refs: Array<{ ref: string; domain?: string }> } | undefined {
  const refs = new Map<string, { ref: string; domain?: string; word: string }>();
  for (const word of new Set(text.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? [])) {
    if (SCOPE_WORD_STOPWORDS.has(word)) continue;
    for (const hit of inventory.lookup(word, { limit: 4, minScore: 0.97 })) {
      if (hit.matchedOn !== 'name' && hit.matchedOn !== 'alias') continue;
      if (scoped.get(hit.entry.ref)) continue; // in scope: not this explanation's business
      const entry = hit.entry;
      const relation = entry.physical?.relation ?? (entry.kind === 'column' ? entry.ref.slice(entry.ref.indexOf(':') + 1).split('.').slice(0, -1).join('.') : entry.kind === 'relation' ? entry.model : undefined);
      const owner = entry.domain ?? (relation ? inventory.get(`relation:${relation}`)?.domain : undefined);
      if (!owner || owner === envelope.activeDomain) continue;
      if (!refs.has(entry.ref)) refs.set(entry.ref, { ref: entry.ref, domain: owner, word });
      if (refs.size >= 3) break;
    }
    if (refs.size >= 3) break;
  }
  if (refs.size === 0) return undefined;
  const where = envelope.activeDomain ? `the ${envelope.activeDomain} scope${envelope.purpose ? ` for purpose ${envelope.purpose}` : ' (no purpose given)'}` : 'this scope';
  const named = [...refs.values()].map((item) => `"${item.word}" (${item.ref}, owned by ${item.domain})`).join(', ');
  return { message: `${named} ${refs.size === 1 ? 'is' : 'are'} modeled in the project but not in ${where}: ask with a purpose whose import carries it, or declare the import in Domain Studio. Nothing outside the scope was read.`, refs: [...refs.values()].map(({ ref, domain }) => ({ ref, ...(domain ? { domain } : {}) })) };
}

/**
 * A ref the interpreter named that the whole inventory holds but this
 * envelope does not: the explanation names the owning domain and what would
 * admit it (a purpose whose import carries it, or a declared import) — and
 * never the object's data. Returns nothing when the ref is truly unknown.
 */
export function explainOutOfScope(problems: Array<{ path: string; message: string }>, inventory: VocabularyIndex, envelope: Pick<DomainContextEnvelope, 'activeDomain' | 'purpose'>): { message: string; refs: Array<{ ref: string; domain?: string }> } | undefined {
  const refs: Array<{ ref: string; domain?: string }> = [];
  for (const problem of problems) {
    const match = /^(\S+) is not in the vocabulary/.exec(problem.message);
    if (!match) continue;
    const ref = match[1]!;
    // The model may spell an entry the inventory holds with the wrong kind and
    // a schema in front (`column:TRANSFORMED.team_directory.city` for
    // `dimension:team_directory.city`). Drop the kind, then try shorter dotted
    // tails down to two parts; a bare field name alone is never guessed.
    const suffixMatch = (): VocabularyEntry | undefined => {
      const path = ref.replace(/^[a-z_]+:/i, '').split('.');
      for (let start = 0; path.length - start >= 2; start += 1) {
        const found = inventory.resolve(path.slice(start).join('.'));
        if (found) return found;
      }
      return undefined;
    };
    const entry = inventory.get(ref) ?? inventory.resolve(ref) ?? suffixMatch();
    if (!entry) continue;
    const relation = entry.physical?.relation ?? (entry.kind === 'column' ? ref.slice(ref.indexOf(':') + 1).split('.').slice(0, -1).join('.') : undefined);
    const owner = entry.domain ?? (relation ? inventory.get(`relation:${relation}`)?.domain : undefined);
    refs.push({ ref, ...(owner ? { domain: owner } : {}) });
  }
  if (!refs.length) return undefined;
  const where = envelope.activeDomain ? `the ${envelope.activeDomain} scope${envelope.purpose ? ` for purpose ${envelope.purpose}` : ' (no purpose given)'}` : 'this scope';
  const named = refs.map((item) => `${item.ref}${item.domain ? ` (owned by ${item.domain})` : ''}`).join(', ');
  return { message: `${named} ${refs.length === 1 ? 'is' : 'are'} modeled in the project but not in ${where}: ask with a purpose whose import carries it, or declare the import in Domain Studio. Nothing outside the scope was read.`, refs };
}

/**
 * The projected vocabulary is a function of the base source AND of the whole
 * envelope selection. The purpose chooses which exports are imported, and a
 * different export is different physical context; a key that ignored it
 * served the previous purpose's provider relations to the next request.
 */
export function vocabularyViewKey(baseKey: string, envelope: Pick<DomainContextEnvelope, 'activeDomain' | 'purpose' | 'modelAreaId' | 'allowedImports' | 'descendants'>, pack: Pick<LocalContextPack, 'skills' | 'appliedHints' | 'eligible' | 'domainBriefing'>): string {
  const skillRefs = pack.skills.map((skill) => skill.qualifiedId ?? skill.id).sort().join(',');
  const hintIds = pack.appliedHints.map((hint) => hint.hintId).sort().join(',');
  const imports = envelope.allowedImports.map((item) => `${item.providerDomain}:${item.exportRef}@${item.purpose}`).sort().join(',');
  return [baseKey, pack.eligible?.fingerprint ?? 'ranked', skillRefs, hintIds, pack.domainBriefing?.domainId ?? '', envelope.activeDomain ?? '', envelope.purpose ?? '', envelope.modelAreaId ?? '', (envelope.descendants ?? []).join(','), imports].join('|');
}

export function projectionScopeFor(envelope: DomainContextEnvelope, manifest: DQLManifest | undefined): ProjectionScope | undefined {
  if (!envelope.activeDomain) return undefined;
  const own = [envelope.activeDomain, ...envelope.ancestors, ...(envelope.descendants ?? [])];
  const entities = manifest?.modeling?.entities ?? {};
  const relationOf = (entityRef: string, domain: string): string | undefined => {
    const entity = entities[entityRef] ?? Object.values(entities).find((item) => item.domain === domain && (item.localId === entityRef || item.id === entityRef || item.qualifiedId === entityRef));
    return entity ? normalizeRelationName(manifest?.dbtProvenance?.nodes[entity.dbtUniqueId]?.relation) : undefined;
  };
  const imports = envelope.allowedImports.map((item) => {
    const relations = Object.values(manifest?.modeling?.interfaces?.exports ?? {})
      .filter((exported) => exported.domain === item.providerDomain && [`${exported.domain}.${exported.localId}@${exported.version}`, `${exported.domain}.${exported.localId}`, exported.qualifiedId, exported.id].includes(item.exportRef))
      .flatMap((exported) => exported.entity ? [relationOf(exported.entity, exported.domain)] : [])
      .filter((relation): relation is string => Boolean(relation));
    return { providerDomain: item.providerDomain, relations };
  });
  return { own, imports };
}

/** Compatibility: the authorized path function alone. */
export function modelingJoinPaths(manifest: DQLManifest | undefined, quoteRelation: (relation: string) => string): (fromRelation: string, toRelation: string) => RelationalJoinStep[] | undefined {
  return modelingJoinGraph(manifest, quoteRelation).path;
}

/** Date cells become ISO instants so every consumer reads one calendar value. */
export function normalizeExecutedRow(row: Record<string, unknown>): Record<string, unknown> {
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Date) {
      out[key] = Number.isFinite(value.getTime()) ? value.toISOString() : null;
      changed = true;
    } else out[key] = value;
  }
  return changed ? out : row;
}

export function createAskPipelineRouteExecutor(deps: AskPipelineHostDeps): AgentRouteExecutor {
  let vocabularyCache: VocabularyCacheEntry | undefined;
  const preparationCache = new Map<string, PreparedCandidate>();

  // The warehouse completes only the relations this question is about.  Cache
  // entries are target-specific and short lived for partial/negative evidence:
  // a failed or bounded metadata page never becomes a permanent "missing"
  // claim after a role/catalog/configuration change.
  type ProbeCacheState = 'complete' | 'partial' | 'negative';
  type ProbeCacheEntry = { relation?: ProbedRelation; state: ProbeCacheState; expiresAt: number };
  // Cache one exact physical relation at a time. A wide table must not make
  // a narrow sibling partial (or vice versa), and negative warehouse evidence
  // must expire quickly because Snowflake deliberately conflates unavailable
  // and unauthorized objects in its error text.
  const probedColumns = new Map<string, ProbeCacheEntry>();
  const probeColumns = async (
    connection: ConnectionConfig | undefined,
    base: ReturnType<typeof buildVocabularySource>,
    snapshotId: string,
    requested?: string[],
    remainingMs?: number,
    signal?: AbortSignal,
  ): Promise<ProbedRelation[]> => {
    if (!connection) return [];
    // An explicit empty list probes nothing; only an absent list falls back to
    // the relations the metadata left without columns.
    const wanted = requested ?? relationsNeedingColumns(base);
    if (wanted.length === 0) return [];
    const cacheKey = (relation: string) => `${snapshotId}|${connectionKey(connection)}|${physicalRelationIdentity(relation)}`;
    const found: ProbedRelation[] = [];
    // BOUNDED: an information_schema lookup on a large warehouse can take
    // seconds per statement; the probe stops issuing statements once its
    // budget is spent and the metadata stands as it was for the rest. What
    // it did not describe is asked for by name, never assumed absent.
    const started = Date.now();
    const budgetMs = Math.max(0, Math.min(columnProbeBudgetMs(), remainingMs ?? columnProbeBudgetMs()));
    const budgetLeft = () => Math.max(0, budgetMs - (Date.now() - started));
    const remember = (raw: string, aggregate: ProbedRelation | undefined, state: ProbeCacheState) => {
      if (aggregate) {
        aggregate.columnCompleteness = state === 'complete' ? 'complete' : 'partial';
        if (state !== 'complete') aggregate.truncated = true;
        found.push(aggregate);
      }
      probedColumns.set(cacheKey(raw), {
        ...(aggregate ? { relation: aggregate } : {}),
        state,
        expiresAt: Date.now() + (state === 'complete' ? 15 * 60_000 : 60_000),
      });
    };
    const mergePage = (aggregate: ProbedRelation | undefined, page: ProbedRelation): ProbedRelation => {
      if (!aggregate) return { ...page, columns: [...page.columns] };
      const seenColumns = new Set(aggregate.columns.map((column) => column.name.toLowerCase()));
      for (const column of page.columns) if (!seenColumns.has(column.name.toLowerCase())) {
        aggregate.columns.push(column);
        seenColumns.add(column.name.toLowerCase());
      }
      aggregate.binding = page.binding ?? aggregate.binding;
      aggregate.observedAt = page.observedAt ?? aggregate.observedAt;
      return aggregate;
    };
    // Which requested spelling a returned page answers (the batch may hold several).
    // Names only, case-insensitive, quote state ignored: the warehouse answered
    // for the object this request named, whether provenance spelled it
    // `"db"."schema"."table"` or the request said `DB.SCHEMA.TABLE`.
    const loose = (parts: Array<string | undefined>) => parts.filter(Boolean).map((part) => part!.toLowerCase()).join('.');
    const pageOwner = (page: ProbedRelation, candidates: string[]): string | undefined => {
      const named = loose([page.database, page.schema, page.name]);
      const tail = loose([page.schema, page.name]);
      const values = (raw: string) => parsePhysicalIdentifier(raw).map((part) => part.value);
      return candidates.find((raw) => loose(values(raw)) === named)
        ?? candidates.find((raw) => loose(values(raw).slice(-2)) === tail);
    };
    const pending: string[] = [];
    for (const raw of wanted) {
      if (!probeIdentifier(raw)) continue;
      const cached = probedColumns.get(cacheKey(raw));
      if (cached && cached.expiresAt > Date.now()) {
        if (cached.relation) found.push(cached.relation);
        continue;
      }
      pending.push(raw);
    }
    if (pending.length === 0) return found;
    // ONE statement for every relation this question needs (they are a
    // handful), then further pages only for a relation wider than a page. The
    // earlier shape issued one round trip per relation, and each metadata
    // statement on a large warehouse is seconds.
    const aggregates = new Map<string, ProbedRelation>();
    const settled = new Set<string>();
    const runPage = async (relations: string[], offset: number): Promise<ProbedRelation[] | undefined> => {
      if (signal?.aborted || budgetLeft() <= 0) return undefined;
      const sql = relationColumnsProbeSql(relations, Math.max(relations.length, 1), offset, connection.driver);
      if (!sql) return [];
      const result = await deps.executor.executeQuery(sql, [], {}, connection, {
        ...(signal ? { signal } : {}),
        deadlineMs: budgetLeft(),
      });
      const rows = (result.rows ?? []) as Array<Record<string, unknown>>;
      return underAskedNames(relationsFromProbeRows(rows, true, offset), relations);
    };
    // SNOWFLAKE FAST PATH: `SHOW COLUMNS IN <table>` is a metadata command
    // answered in milliseconds, where `information_schema.columns` scans every
    // column of the database and is the statement that spent the whole probe
    // budget on the office warehouse. It answers one relation completely; a
    // relation it cannot describe falls through to the information_schema
    // batch below, so nothing is lost when the command is refused.
    if (connection.driver.toLowerCase() === 'snowflake') {
      for (const raw of [...pending]) {
        if (signal?.aborted || budgetLeft() <= 0) break;
        const identifier = probeIdentifier(raw);
        if (!identifier) continue;
        try {
          const target = [identifier.database, identifier.schema, identifier.table].filter((part): part is PhysicalIdentifierPartV1 => Boolean(part)).map(probeSegment).join('.');
          const result = await deps.executor.executeQuery(`SHOW COLUMNS IN ${target}`, [], {}, connection, { ...(signal ? { signal } : {}), deadlineMs: budgetLeft() });
          const rows = snowflakeShowColumnsRows((result.rows ?? []) as Array<Record<string, unknown>>);
          if (rows.length === 0) continue;
          const page = underAskedNames(relationsFromProbeRows(rows, true, 0), [raw])[0];
          if (!page) continue;
          remember(raw, mergePage(undefined, page), 'complete');
          settled.add(raw);
          pending.splice(pending.indexOf(raw), 1);
        } catch { /* described by the batch below */ }
      }
      if (pending.length === 0) return found;
    }
    let firstPage: ProbedRelation[] | undefined;
    try {
      firstPage = await runPage(pending.slice(0, 8), 0);
    } catch {
      // Stale catalog metadata, a different current database or a role
      // change: keep the negative evidence short-lived and never turn it into
      // proof that the object is absent.
      firstPage = undefined;
    }
    if (firstPage === undefined) {
      for (const raw of pending) remember(raw, undefined, 'negative');
      return found;
    }
    for (const page of firstPage) {
      const owner = pageOwner(page, pending);
      if (!owner) continue;
      aggregates.set(owner, mergePage(aggregates.get(owner), page));
      if (page.columnCompleteness === 'complete') { remember(owner, aggregates.get(owner), 'complete'); settled.add(owner); }
    }
    for (const raw of pending) {
      if (settled.has(raw)) continue;
      let aggregate = aggregates.get(raw);
      if (!aggregate) { remember(raw, undefined, 'negative'); continue; }
      let offset = aggregate.columns.length;
      let state: ProbeCacheState = 'partial';
      // A relation wider than one page: keep paging this one alone while the budget lasts.
      while (true) {
        let page: ProbedRelation[] | undefined;
        try { page = await runPage([raw], offset); } catch { page = undefined; }
        if (page === undefined) { state = 'partial'; break; }
        const own = page[0];
        if (!own || own.columns.length === 0) { state = 'partial'; break; }
        aggregate = mergePage(aggregate, own);
        if (own.columnCompleteness === 'complete') { state = 'complete'; break; }
        offset += own.columns.length;
      }
      remember(raw, aggregate, state);
    }
    return found;
  };
  type VocabularyView = { vocabulary: VocabularyIndex; context?: NonNullable<Parameters<typeof runAskPipeline>[0]['context']>; envelope: DomainContextEnvelope; pack?: LocalContextPack; /** The request's projected source: the relations this envelope admits. Table choice for drafted SQL reads this, never the whole project. */ source?: VocabularySource };
  let viewCache: { key: string; view: VocabularyView } | undefined;

  /** The request's scope, resolved server-side from what the surface sent; never from client-supplied ancestors or imports. */
  const resolveAskEnvelope = (request: AgentRunRequest): DomainContextEnvelope => {
    const { manifest, snapshotId } = deps.getManifest();
    // The four selections every surface carries (CTX-001), read the one way.
    const scope = askScopeFromWorkspace(request.workspaceContext);
    const empty: DomainContextEnvelope = { activeDomain: null, ancestors: [], descendants: [], allowedImports: [], source: 'inferred', confidence: 'low', snapshotId };
    if (!manifest) return empty;
    try {
      return resolveDomainContextEnvelope({
        manifest, activeDomain: scope.domain ?? null, purpose: scope.purpose, modelAreaId: scope.modelAreaId, skillRefs: scope.skillRefs,
        source: scope.domain ? 'explicit_ui' : 'inferred', snapshotId,
      });
    } catch {
      // An unknown domain or area is not a reason to answer unscoped: the
      // request keeps no-domain scope and the envelope says so.
      return empty;
    }
  };

  /** The whole inventory as an index, for explaining a ref outside this envelope. Cached with the base source. */
  let baseIndexCache: { key: string; index: VocabularyIndex } | undefined;
  const baseIndexFor = async (connection?: ConnectionConfig): Promise<VocabularyIndex> => {
    const { key, source } = await baseSourceFor(connection);
    if (baseIndexCache?.key !== key) baseIndexCache = { key, index: buildVocabularyIndex(source) };
    return baseIndexCache.index;
  };
  const sourceInputFor = (connection: ConnectionConfig | undefined, relations?: ProbedRelation[]): VocabularySourceInput => {
    const { manifest, snapshotId } = deps.getManifest();
    const layer = deps.getSemanticLayer();
    return {
      ...(layer ? { semanticLayer: layer } : {}),
      ...(manifest ? { manifest } : {}),
      ...(connection?.driver ? { driver: connection.driver } : {}),
      ...(connection?.database ?? connection?.catalog ? { defaultDatabase: connection?.database ?? connection?.catalog } : {}),
      snapshotId,
      ...(connection ? { executionTargetFingerprint: fingerprintText(connectionKey(connection)) } : {}),
      relations: [...embeddedManifestRelations(manifest), ...(relations ?? [])],
    };
  };
  /** The base source: everything the host can bind physically, per snapshot and connection. Cached; the pack projects it per request. */
  const baseSourceFor = async (connection?: ConnectionConfig): Promise<{ key: string; source: VocabularySource }> => {
    const { snapshotId } = deps.getManifest();
    const layer = deps.getSemanticLayer();
    const key = `${snapshotId}|${layer ? layer.listCubes().map((cube) => cube.name).join(',') : 'no-semantic'}|${connection ? connectionKey(connection) : 'no-connection'}`;
    if (vocabularyCache?.key === key) return { key, source: vocabularyCache.source };
    const source = buildVocabularySource(sourceInputFor(connection));
    vocabularyCache = { key, source };
    return { key, source };
  };

  /**
   * THE VOCABULARY IS A VIEW OVER THE PACK (CTX-010). The envelope decides
   * eligibility, the pack admits the complete eligible set and selects the
   * skills and hints for this question, and the host's base source supplies
   * the physical bindings; the view is their projection. Without a pack (no
   * host builder, or a snapshot that could not be opened) the base source is
   * served whole and the ledger says no envelope was applied.
   */
  // A source rebuilt with this question's discovered columns, kept for the
  // next question about the same relations (the base is cached above; a
  // rebuild is a few hundred milliseconds at 5,000 relations, but not free).
  const discoveredSourceCache = new Map<string, VocabularySource>();
  const vocabularyFor = async (request: AgentRunRequest, connection?: ConnectionConfig): Promise<VocabularyView> => {
    // Where the context time goes, phase by phase: the office trace reads it.
    const phases: Record<string, number> = {};
    const timed = async <T>(phase: string, work: () => Promise<T> | T): Promise<T> => {
      const started = Date.now();
      try { return await work(); } finally { phases[phase] = (phases[phase] ?? 0) + (Date.now() - started); }
    };
    const envelope = resolveAskEnvelope(request);
    const { key: baseKey, source: base } = await timed('base', () => baseSourceFor(connection));
    const remaining = request.runBudget?.remainingMs();
    const relevant = await timed('relevance', () => relevantRelationsForQuestion(base, request.question, 3));
    const discovered = await timed('probe', () => probeColumns(connection, base, envelope.snapshotId, relevant, remaining, request.signal));
    const key = `${baseKey}|discovery:${discovered.map((relation) => `${relation.database ?? ''}.${relation.schema ?? ''}.${relation.name}:${relation.columns.length}:${relation.columnCompleteness ?? 'unknown'}`).join(',')}`;
    const source = discovered.length
      ? await timed('source', () => {
        const cached = discoveredSourceCache.get(key);
        if (cached) return cached;
        const rebuilt = buildVocabularySource(sourceInputFor(connection, discovered));
        if (discoveredSourceCache.size >= 8) discoveredSourceCache.delete(discoveredSourceCache.keys().next().value!);
        discoveredSourceCache.set(key, rebuilt);
        return rebuilt;
      })
      : base;
    let pack: LocalContextPack | undefined;
    try { pack = await timed('pack', () => deps.buildContextPack?.(request, envelope)); } catch { pack = undefined; }
    if (!pack) {
      const vocabulary = await timed('index', () => buildVocabularyIndex(source));
      return { vocabulary, envelope, source, context: { envelope: ledgerEnvelope(envelope), admitted: { byKind: countKinds(vocabulary) }, timings: phases } };
    }
    const viewKey = vocabularyViewKey(key, envelope, pack);
    const projected = await timed('projection', () => projectVocabularySource(source, pack!, projectionScopeFor(envelope, deps.getManifest().manifest)));
    const vocabulary = viewCache?.key === viewKey ? viewCache.view.vocabulary : await timed('index', () => buildVocabularyIndex(projected.source));
    const rankedRefs = rankedRefsFromPack(pack.objects);
    const lanes: Record<string, number> = {};
    for (const [lane, result] of Object.entries(pack.retrievalDiagnostics.fusion?.lanes ?? {})) lanes[lane] = result.returned;
    const relationsTotal = pack.eligible ? Object.entries(pack.eligible.counts).filter(([type]) => type === 'dbt_model' || type === 'dbt_source' || type === 'warehouse_table').reduce((sum, [, count]) => sum + count, 0) : (projected.source.relations?.length ?? 0);
    const relationsWithColumns = (projected.source.relations ?? []).filter((relation) => relation.columns.length > 0).length;
    const view: VocabularyView = {
      vocabulary, envelope, pack, source: projected.source,
      context: {
        packId: pack.id, snapshotId: envelope.snapshotId, envelope: ledgerEnvelope(envelope),
        retrieved: { lanes, fused: pack.retrievalDiagnostics.fusion?.selectedKeys.length ?? pack.objects.length },
        // Counted on the built index, so columns and the request overlay (skills, hints) are in the number the answer quotes.
        admitted: { byKind: countKinds(vocabulary), ...(Object.keys(projected.dropped).length ? { dropped: projected.dropped } : {}), ...(Object.keys(projected.unindexed).length ? { unindexed: projected.unindexed } : {}), ...(pack.eligible ? { eligibleFingerprint: pack.eligible.fingerprint } : {}) },
        rankedRefs, ...(projected.source.domain ? { header: projected.source.domain } : {}),
        columnsFor: { shown: relationsWithColumns, total: Math.max(relationsTotal, relationsWithColumns) },
        timings: phases,
      },
    };
    viewCache = { key: viewKey, view };
    if (process.env.DQL_ASK_PIPELINE_DUMP_VOCABULARY) {
      try { writeFileSync(process.env.DQL_ASK_PIPELINE_DUMP_VOCABULARY, `${vocabulary.renderCards({ maxChars: 1_000_000 })}\n`); } catch { /* debug only */ }
    }
    return view;
  };
  const ledgerEnvelope = (envelope: DomainContextEnvelope): NonNullable<ContextLedgerV1['envelope']> => ({
    activeDomain: envelope.activeDomain, ancestors: envelope.ancestors, descendants: envelope.descendants ?? [], allowedImports: envelope.allowedImports.length,
    ...(envelope.purpose ? { purpose: envelope.purpose } : {}), ...(envelope.modelAreaId ? { modelAreaId: envelope.modelAreaId } : {}), ...(envelope.skillRefs ? { skillRefs: envelope.skillRefs } : {}),
    source: envelope.source, confidence: envelope.confidence,
  });
  const countKinds = (vocabulary: VocabularyIndex): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const entry of vocabulary.entries) counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
    return counts;
  };

  // A relationship the warehouse proved holds for as long as the snapshot and
  // the connection do; proving it twice would ask the same question twice.
  const provenJoins = new Map<string, Map<string, { steps: RelationalJoinStep[]; expiresAt: number; generationToken?: string }>>();
  const prepareDeps = (connection: ConnectionConfig, vocabulary: VocabularyIndex | (() => VocabularyIndex), engine?: PrepareDeps['engine'], signal?: AbortSignal): PrepareDeps => {
    const currentVocabulary = () => typeof vocabulary === 'function' ? vocabulary() : vocabulary;
    const layer = deps.getSemanticLayer();
    /**
     * The semantic runtime must compile against the exact relation Ask has
     * admitted for this request.  Do not hand it the project-default runtime
     * snapshot: that snapshot can describe DB_A while this Ask run discovered
     * DB_B.  Where one logical semantic table has multiple physical bindings,
     * select only a single complete target-bound observation; otherwise leave
     * the table unmapped and let the semantic engine report the ambiguity.
     */
    const semanticCompileContext = (semanticRequest: SemanticCompileRequest): AskSemanticCompileContext => {
      const current = currentVocabulary();
      const target = fingerprintText(connectionKey(connection));
      const relationBindings = current.entries
        .filter((entry) => entry.kind === 'relation' && entry.physical?.binding)
        .map((entry) => entry.physical!.binding!)
        .filter((binding, index, all) => all.findIndex((candidate) => physicalRelationIdentity(physicalRelationText(candidate)) === physicalRelationIdentity(physicalRelationText(binding))) === index)
        // A binding acquired for another execution identity is not evidence
        // for this connection, even if its table tail looks identical.
        .filter((binding) => binding.executionTargetFingerprint === target);
      const requestedNames = new Set([
        ...semanticRequest.metrics,
        ...semanticRequest.dimensions,
        ...(semanticRequest.filters?.flatMap((filter) => filter.dimension ? [filter.dimension] : []) ?? []),
        ...(semanticRequest.timeDimension ? [semanticRequest.timeDimension.name] : []),
      ].map((name) => name.toLowerCase()));
      const namesDefinition = (name: string, table?: string) => requestedNames.has(name.toLowerCase())
        || (table ? requestedNames.has(`${table}.${name}`.toLowerCase()) : false)
        || [...requestedNames].some((requested) => requested.endsWith(`.${name.toLowerCase()}`));
      const semanticTables = new Set<string>();
      for (const metric of layer?.listMetrics() ?? []) {
        if (!namesDefinition(metric.name, metric.table)) continue;
        if (metric.table) semanticTables.add(metric.table);
        else {
          const measureName = (metric as { typeParams?: { measure?: { name?: string } } }).typeParams?.measure?.name;
          const measure = measureName ? layer?.listMeasures().find((candidate) => candidate.name === measureName) : undefined;
          if (measure?.table) semanticTables.add(measure.table);
        }
      }
      for (const measure of layer?.listMeasures() ?? []) if (namesDefinition(measure.name, measure.table) && measure.table) semanticTables.add(measure.table);
      for (const dimension of layer?.listDimensions(undefined, { includeVariants: true }) ?? []) if (namesDefinition(dimension.name, dimension.table) && dimension.table) semanticTables.add(dimension.table);

      const suffixMatches = (logical: string, semanticTable: string): boolean => {
        const logicalParts = parsePhysicalIdentifier(logical);
        const semanticParts = parsePhysicalIdentifier(semanticTable);
        if (logicalParts.length === 0 || semanticParts.length === 0 || logicalParts.length < semanticParts.length) return false;
        return semanticParts.every((part, index) => {
          const candidate = logicalParts[logicalParts.length - semanticParts.length + index]!;
          const render = (value: PhysicalIdentifierPartV1) => value.quoted ? `"${value.value.replace(/"/g, '""')}"` : value.value;
          return physicalRelationIdentity(render(candidate)) === physicalRelationIdentity(render(part));
        });
      };
      const selected = new Map<string, PhysicalRelationBindingV1>();
      // Bindings already attached to an admitted semantic entry are the most
      // specific proof. They take precedence over logical-name inference.
      for (const entry of current.entries) {
        if (!entry.physical?.binding || !['metric', 'measure', 'dimension', 'entity'].includes(entry.kind)) continue;
        const table = entry.model;
        if (!namesDefinition(entry.sourceId ?? entry.name, table)) continue;
        const binding = entry.physical.binding;
        if (binding.executionTargetFingerprint === target) selected.set(physicalRelationIdentity(physicalRelationText(binding)), binding);
      }
      for (const semanticTable of semanticTables) {
        const candidates = relationBindings.filter((binding) => suffixMatches(binding.logicalRelation, semanticTable));
        const complete = candidates.filter((binding) => binding.columnCompleteness === 'complete');
        const choice = complete.length === 1 ? complete[0] : candidates.length === 1 ? candidates[0] : undefined;
        // More than one complete DB/schema/table is an actual ambiguity. Do
        // not turn a suffix match into a default-database selection.
        if (choice) selected.set(physicalRelationIdentity(physicalRelationText(choice)), choice);
      }
      return {
        snapshotId: deps.getManifest().snapshotId,
        executionTargetFingerprint: target,
        vocabulary: current,
        physicalBindings: [...selected.values()],
      };
    };
    const provenScope = `${deps.getManifest().snapshotId}|${connectionKey(connection)}`;
    if (!provenJoins.has(provenScope)) provenJoins.set(provenScope, new Map());
    const provenJoinPath = provenJoins.get(provenScope)!;
    const dialect = getDialect(connection.driver);
    const relationOfCube = new Map<string, string>();
    const cubeOfRelation = new Map<string, string>();
    for (const cube of layer?.listCubes() ?? []) {
      const relation = normalizeRelationName(cube.table) ?? cube.name;
      relationOfCube.set(cube.name, relation);
      cubeOfRelation.set(relation, cube.name);
    }
    // A physical name as the warehouse knows it (Snowflake folds unquoted
    // names; dbt creates them unquoted), an alias as this program mints it.
    const quotePhysical = (name: string) => renderPhysicalIdentifier(name, connection.driver, (value) => dialect.quoteIdentifier(value));
    const databases = relationDatabases(deps.getManifest().manifest);
    const bindingForRelation = (relation: string) => {
      const candidates = currentVocabulary().entries
        .filter((entry) => entry.kind === 'relation' && (entry.model === relation || entry.physical?.binding?.logicalRelation === relation || entry.physical?.binding?.aliases?.includes(relation)))
        .map((entry) => entry.physical?.binding)
        .filter((binding): binding is NonNullable<typeof binding> => Boolean(binding));
      const exact = new Map(candidates.map((binding) => [physicalRelationText(binding), binding]));
      return exact.size === 1 ? [...exact.values()][0] : undefined;
    };
    const quoteRelation = (relation: string) => {
      const binding = bindingForRelation(relation);
      const physical = binding ? physicalRelationText(binding) : physicalRelationName(relation, databases, connection.driver);
      return renderPhysicalRelation(physical, connection.driver, (value) => dialect.quoteIdentifier(value));
    };
    const joinGraph = modelingJoinGraph(deps.getManifest().manifest, quoteRelation);
    const semanticJoinPath = (fromRelation: string, toRelation: string): RelationalJoinStep[] | undefined => {
      if (!layer) return undefined;
      const from = cubeOfRelation.get(fromRelation);
      const to = cubeOfRelation.get(toRelation);
      if (!from || !to) return undefined;
      const path = layer.findJoinPath(from, to);
      if (path.length === 0) return undefined;
      return path.map((join) => {
        const left = relationOfCube.get(join.left) ?? join.left;
        const right = relationOfCube.get(join.right) ?? join.right;
        // The compiler owns this join (REL-002 source one): the ledger says so
        // instead of calling it a declared edge of unknown authority.
        const domains = { from: joinGraph.domainsOf(left), to: joinGraph.domainsOf(right) };
        const authority: JoinAuthorityV1 = {
          version: 1, from: left, to: right, keys: [], source: 'semantic_layer', authority: 'certified',
          scope: !joinGraph.hasDomains ? 'no_domains' : domains.from.length === 1 && domains.to.length === 1 && domains.from[0] === domains.to[0] ? 'within_domain' : 'cross_domain_certified',
          domains, snapshotId: deps.getManifest().snapshotId,
        };
        return { relation: right, on: join.sql.replace(/\$\{left\}/g, quoteRelation(left)).replace(/\$\{right\}/g, quoteRelation(right)), authority };
      });
    };
    const declaredJoinPath = joinGraph.path;
    const sessionProvenPath = (fromRelation: string, toRelation: string): RelationalJoinStep[] | undefined => {
      const prefix = `${fromRelation}->${toRelation}|`;
      const now = Date.now();
      for (const [key, entry] of provenJoinPath) if (key.startsWith(prefix) && entry.expiresAt > now) return entry.steps;
      return undefined;
    };
    return {
      ...(layer ? {
        compileSemantic: (request) => deps.compileSemantic({ ...request, ...(signal ? { signal } : {}) }, connection, semanticCompileContext(request)),
        // Different periods are separate MetricFlow/dbt semantic requests, but
        // every branch retains the same selected adapter, connection and
        // cancellation signal.  The host returns executable SQL per branch;
        // the pipeline aligns rows only after the engine has produced them.
        compileSemanticProgram: async (program) => {
          let selectedEngine: string | undefined;
          const branches: typeof program.branches = [];
          for (const branch of program.branches) {
            if (signal?.aborted) throw new Error('the semantic execution program was cancelled before every period compiled');
            const branchRequest = { ...branch.request, ...(signal ? { signal } : {}) };
            const compiled = await deps.compileSemantic(branchRequest, connection, semanticCompileContext(branchRequest));
            if (selectedEngine && selectedEngine !== compiled.engine) {
              throw new Error(`semantic execution program selected more than one adapter (${selectedEngine}, ${compiled.engine}); all periods must compile on one target`);
            }
            selectedEngine = compiled.engine;
            branches.push({ ...branch, sql: compiled.sql, engine: compiled.engine });
          }
          if (!selectedEngine) throw new Error('the semantic execution program had no compiled branches');
          return {
            // `executeCandidate` executes branches, not this marker. Keeping a
            // deterministic SQL fingerprint retains existing receipts/caches.
            sql: branches.map((branch) => `-- ${branch.id}\n${branch.sql ?? ''}`).join('\n'),
            engine: selectedEngine,
            program: { ...program, branches },
            strategy: `${branches.length} bounded semantic period branches`,
          };
        },
      } : {}),
      // Two governed join sources, in order: the semantic layer's entity
      // joins, then the relationships the team declared in Domain Studio.
      // Order of authority: the semantic layer, a certified relationship, then
      // a proof this session gathered and has not yet outlived.
      joinPath: (fromRelation, toRelation) => semanticJoinPath(fromRelation, toRelation) ?? declaredJoinPath(fromRelation, toRelation) ?? sessionProvenPath(fromRelation, toRelation),
      unprovenJoinPath: (fromRelation, toRelation) => joinGraph.unproven(fromRelation, toRelation),
      proveJoinPath: async (fromRelation, toRelation) => {
        const executor = deps.executor as QueryExecutor & { executePositional?: QueryExecutor['executePositional'] };
        if (!connection || typeof executor.executePositional !== 'function') return undefined;
        // DOMAIN BOUNDARIES FIRST (A-003). Missing domain information never
        // widens eligibility: an endpoint nobody modeled, or one bound to
        // several domains, is a gap; endpoints in different domains need the
        // governed interface chain and are never probed.
        const fromDomains = joinGraph.domainsOf(fromRelation);
        const toDomains = joinGraph.domainsOf(toRelation);
        const decision = joinScopeDecision(fromRelation, toRelation, fromDomains, toDomains, joinGraph.hasDomains);
        if ('refusal' in decision) return decision;
        const scope = decision.scope;
        const declaredEdge = joinGraph.declared(fromRelation, toRelation);
        // A declared draft supplies the keys, direction and cardinality; an
        // attribution or many-to-many declaration is never probed as if it
        // were many-to-one. Without a draft, the probe runs fact -> label on a
        // key whose name matches on both sides.
        if (declaredEdge && (declaredEdge.cardinality === 'many_to_many' || declaredEdge.fanout === 'attribution_required' || declaredEdge.fanout === 'forbidden')) return undefined;
        const columnsOf = (relation: string): string[] => currentVocabulary().entries.find((entry) => entry.kind === 'relation' && entry.ref.endsWith(relation))?.columns ?? [];
        const keys = declaredEdge?.keys ?? (() => { const column = sharedKeyColumn(columnsOf(fromRelation), columnsOf(toRelation)); return column ? [{ from: column, to: column }] : []; })();
        if (keys.length === 0) return undefined;
        const cardinality = (declaredEdge?.cardinality ?? 'many_to_one') as 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many' | 'unknown';
        if (cardinality === 'unknown') return undefined;
        const manifestFingerprint = deps.getManifest().manifest?.dbtProvenance?.manifestFingerprint ?? deps.getManifest().snapshotId;
        const cacheKey = `${fromRelation}->${toRelation}|${keys.map((key) => `${key.from}=${key.to}`).join(',')}|${cardinality}|${manifestFingerprint}`;
        const now = Date.now();
        const cached = provenJoinPath.get(cacheKey);
        if (cached && cached.expiresAt > now && cached.generationToken === (await evidenceGenerationToken(connection))) return cached.steps;
        try {
          const evidence = await validateRelationshipOnWarehouse(
            { fromRelation, toRelation, keys, cardinality, fanout: 'safe', keyTypes: catalogKeyTypes(deps.getManifest().manifest, { fromRelation, toRelation, keys }) },
            async (sql) => executor.executePositional!(sql, [], connection, { maxRows: 1, ...(signal ? { signal } : {}) }).then((result) => ({ rows: result.rows as Array<Record<string, unknown>> })),
            quotePhysical,
          );
          // Unique there, and covering every row here (Ask's own rule on top of
          // the declared cardinality): anything else is not a relationship, it
          // is a guess that would multiply or drop rows.
          if (evidence.status !== 'passed' || evidence.unmatchedFrom !== 0) return undefined;
          const ttlHours = relationshipEvidenceTtlHours();
          const generationToken = await evidenceGenerationToken(connection);
          const freshness = { checkedAt: evidence.checkedAt, expiresAt: new Date(now + ttlHours * 3_600_000).toISOString(), target: connectionKey(connection), ...(generationToken ? { generationToken } : {}) };
          const authority: JoinAuthorityV1 = { version: 1, from: fromRelation, to: toRelation, keys, source: 'warehouse_proof', ...(declaredEdge ? { relationshipId: declaredEdge.id } : {}), authority: 'proven_default', scope, domains: { from: fromDomains, to: toDomains }, evidence, freshness, snapshotId: deps.getManifest().snapshotId };
          const left = quoteRelation(fromRelation);
          const right = quoteRelation(toRelation);
          const steps: RelationalJoinStep[] = [{ relation: toRelation, on: keys.map((key) => `${left}.${quotePhysical(key.from)} = ${right}.${quotePhysical(key.to)}`).join(' AND '), authority }];
          provenJoinPath.set(cacheKey, { steps, expiresAt: now + ttlHours * 3_600_000, generationToken });
          writeRelationshipEvidence(deps.projectRoot, { fromRelation, toRelation, keys, cardinality, fanout: 'safe', ...(declaredEdge ? { relationshipId: declaredEdge.id } : {}), evidence, freshness, snapshotId: deps.getManifest().snapshotId });
          return steps;
        } catch { return undefined; }
      },
      dialect: { quoteIdentifier: (name) => dialect.quoteIdentifier(name), quotePhysical, qualifyRelation: quoteRelation, dateTrunc: (grain, expr) => dialect.dateTrunc(grain, expr), limitClause: (limit) => dialect.limitClause(limit) },
      blockSql: (ref) => currentVocabulary().get(ref)?.sql,
      prepareBlock: (ref, context) => prepareBlockForAsk(deps.projectRoot, currentVocabulary().get(ref), context, connection?.driver),
      ...(engine ? { engine } : {}),
    };
  };

  return async ({ runId, request, emit }) => {
    const startedAt = Date.now();
    const provider = await deps.selectProvider(request);
    if (!provider) {
      return failure(runId, 'No AI model is configured for this project, so the question could not be interpreted.', 'provider_error', startedAt);
    }
    // Interpretation never needs a warehouse: a greeting, a definition, a
    // clarification or a modeling gap is answered without one. A missing
    // connection surfaces verbatim at the first execution instead.
    let connection: ConnectionConfig | undefined;
    let connectionError: unknown;
    emit({ type: 'executor.started', message: 'Assembling the governed context for this question.', route: 'generated_answer' });
    const contextStarted = Date.now();
    try {
      connection = await deps.resolveConnection(request);
    } catch (error) {
      connectionError = error;
    }
    const view = await vocabularyFor(request, connection);
    const contextMs = Date.now() - contextStarted;
    const vocabulary = view.vocabulary;
    // Discovery may hydrate a relation after the first interpretation. Keep
    // one request-local pointer so every later consumer (prepare, final SQL
    // validation, execution evidence and receipt) reads the same bindings.
    let requestVocabulary = vocabulary;
    const currentVocabulary = () => requestVocabulary;
    const prior = request.threadId ? deps.priorIntent(request) : undefined;
    let engine: PrepareDeps['engine'];
    try { engine = await deps.semanticEngine?.(); } catch { engine = undefined; }
    // The context is assembled BEFORE the first model call; a run that ends
    // in this phase must show where its time went, so the assembly is an event.
    const phaseSummary = Object.entries(view.context?.timings ?? {}).filter(([, ms]) => ms >= 50).map(([phase, ms]) => `${phase} ${ms} ms`).join(' · ');
    // THE RUN'S STORY. Steps the host takes (the search, the tables the
    // drafter chose) stream beside the pipeline's own and are kept on the
    // receipt in order, so a finished answer can replay how it was reached.
    const hostSteps: AskStoryStepV1[] = [];
    const hostStep = (entry: Omit<AskStoryStepV1, 'version' | 'at'>) => {
      const full: AskStoryStepV1 = { version: 1, at: Date.now(), ...entry };
      hostSteps.push(full);
      emit({ type: 'executor.started', message: full.title, route: 'generated_answer', payload: { askStep: full } });
    };
    {
      const counts = new Map<string, number>();
      for (const entry of vocabulary.entries) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
      const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
      const found = [
        counts.get('block') ? plural(counts.get('block')!, 'certified block', 'certified blocks') : '',
        (counts.get('metric') ?? 0) + (counts.get('measure') ?? 0) ? plural((counts.get('metric') ?? 0) + (counts.get('measure') ?? 0), 'metric', 'metrics') : '',
        counts.get('dimension') ? plural(counts.get('dimension')!, 'dimension', 'dimensions') : '',
        counts.get('relation') ? plural(counts.get('relation')!, 'table', 'tables') : '',
        counts.get('column') ? plural(counts.get('column')!, 'column', 'columns') : '',
        counts.get('term') ? plural(counts.get('term')!, 'business term', 'business terms') : '',
      ].filter(Boolean).join(', ');
      hostStep({ phase: 'context', title: `Searched the project: ${found || 'no governed objects in scope'}`, state: found ? 'done' : 'missed', ms: contextMs, ...(phaseSummary ? { detail: phaseSummary } : {}) });
    }
    emit({ type: 'executor.started', message: `Context assembled in ${contextMs} ms: ${vocabulary.entries.length} governed objects${engine ? ` · semantic engine ${engine}` : ''}${phaseSummary ? ` (${phaseSummary})` : ''}.`, route: 'generated_answer' });
    emit({ type: 'executor.started', message: prior ? 'Reading the question as an edit of the previous analysis.' : 'Reading the question against the governed vocabulary.', route: 'generated_answer' });
    const ledgered = withLedger(provider, deps, request);
    const draftDispatches: Array<{ purpose: string; ms: number; reply?: string; promptChars?: number }> = [];
    // ON-DEMAND DESCRIPTION: a relation the reading names whose columns the
    // bounded probe never reached is described now, for this one run.
    const describeRelations = async (relations: string[]) => {
      if (!connection) return [];
      const { source } = await baseSourceFor(connection);
      const remaining = request.runBudget?.remainingMs();
      // Up to five: the drafter may choose tables from the reading, the question
      // and the conversation, and a table it cannot describe cannot be drafted over.
      return probeColumns(connection, source, deps.getManifest().snapshotId, relations.slice(0, 5), remaining, request.signal);
    };
    // THE LAST TIER'S DRAFT: one read-only statement from the reading and the
    // admitted relations and columns, validated against the catalog before
    // the tier may even consider it. Review-required by construction.
    const draftSql: NonNullable<PrepareDeps['draftSql']> = async ({ question, intent, vocabulary: initial, reason, previous }) => {
      let current = initial;
      const refs = intent ? [...intent.measures.flatMap((measure) => measure.derived ? [measure.derived.numerator, measure.derived.denominator] : [measure.ref]), ...intent.groupBy.map((group) => group.ref), ...intent.display, ...intent.filters.map((filter) => filter.ref), ...(intent.time?.ref ? [intent.time.ref] : [])] : [];
      const relationOf = (ref: string): string | undefined => {
        const entry = current.get(ref) ?? current.resolve(ref);
        if (entry) return entryPhysicalRelation(entry);
        // A ref the governed vocabulary rejected still names a table: the part
        // before the column, matched on its last two parts.
        const path = ref.replace(/^[a-z_]+:/i, '').split('.');
        if (path.length < 3) return undefined;
        const tail = path.slice(-3, -1).join('.').toLowerCase();
        const relation = current.entries.find((item) => item.kind === 'relation' && [item.model ?? '', ...item.aliases, ...(item.physical?.binding?.aliases ?? [])].some((name) => name.toLowerCase() === tail || name.toLowerCase().endsWith(`.${tail}`)));
        return relation ? entryPhysicalRelation(relation) : undefined;
      };
      const text = ` ${question} ${intent?.reading ?? ''} `.toLowerCase();
      const named = current.entries
        .filter((entry) => entry.kind === 'relation' && [entry.name, entry.model ?? '', ...(entry.physical?.binding?.aliases ?? [])].some((name) => name && text.includes(` ${name.toLowerCase()} `)))
        .map((entry) => entryPhysicalRelation(entry))
        .filter((relation): relation is string => Boolean(relation));
      const mentioned = [...`${reason ?? ''} ${previous?.error ?? ''}`.matchAll(/\b(?:column|relation|dimension|metric|measure):[A-Za-z0-9_.$"]+/g)].map((match) => match[0]);
      let relations = [...new Set([...refs, ...mentioned].map(relationOf).filter((relation): relation is string => Boolean(relation)).concat(named))].slice(0, 6);
      // THE TABLES THE QUESTION IS ABOUT. With no reading to name them, the
      // question's own words choose them, the same relation-first discovery
      // context assembly uses; they are described before any SQL is written.
      // WHAT THE USER HAS SAID counts as much as what the reading named: the
      // conversation so far and the clauses the reading could not govern
      // choose tables too ("the competitor is in the deal notes").
      const conversation = deps.conversation?.(request);
      const contextText = [conversation?.summary, conversation?.pendingClarification].filter(Boolean).join(' ');
      const open = intent?.unresolved.map((item) => `${item.clause} ${item.question ?? ''}`).join(' ') ?? '';
      // THE CATALOG'S OWN SEARCH first: names, descriptions and documented
      // columns, held to the request's domains, kept only when admitted.
      const catalogPick = (text: string, exclude: string[], max: number): string[] => {
        if (!deps.searchCatalog || !text.trim()) return [];
        try {
          const hits = deps.searchCatalog(request, view.envelope, text, { objectTypes: ['dbt_column', 'dbt_model', 'dbt_source', 'warehouse_table'], limit: 40 });
          return relationsFromCatalogHits(hits, view.source, exclude, max);
        } catch { return []; }
      };
      const catalogPicked = catalogPick(`${question} ${open} ${contextText}`, relations, 3);
      for (const relation of catalogPicked) if (relations.length < 5) relations.push(relation);
      if (relations.length < 4) {
        try {
          // THE ENVELOPE HOLDS: drafted SQL chooses among the relations this
          // request admits, not every relation in the project.
          const source = view.source ?? (await baseSourceFor(connection)).source;
          for (const relation of relevantRelationsForQuestion(source, `${question} ${open} ${contextText}`, 5, { splitNames: true })) {
            if (relations.length >= 5) break;
            if (!relations.some((known) => physicalRelationIdentity(known) === physicalRelationIdentity(relation))) relations.push(relation);
          }
        } catch { /* the relations named so far stand */ }
      }
      if (relations.length === 0) return { error: 'no table in this project matches the question' };
      const needsColumns = relations.filter((relation) => {
        const entry = current.entries.find((item) => item.kind === 'relation' && entryPhysicalRelation(item) !== undefined && physicalRelationIdentity(entryPhysicalRelation(item)!) === physicalRelationIdentity(relation));
        return !entry || entry.physical?.binding?.columnCompleteness !== 'complete' || !current.entries.some((item) => item.kind === 'column' && samePhysicalEntry(item, entry));
      });
      if (needsColumns.length > 0) {
        try {
          const found = await describeRelations(needsColumns.slice(0, 5));
          if (found.length > 0) {
            current = mergeDiscoveredRelations(current, found);
            requestVocabulary = current;
          }
        } catch { /* draft over what is already described */ }
      }
      // Only tables whose columns are known can be drafted over.
      relations = relations.filter((relation) => current.entries.some((item) => item.kind === 'column' && (() => { const physical = entryPhysicalRelation(item); return physical !== undefined && physicalRelationIdentity(physical) === physicalRelationIdentity(relation); })()));
      if (relations.length === 0) return { error: 'the tables that match the question could not be described on this connection' };
      hostStep({ phase: 'schema', title: `Chose ${relations.length === 1 ? 'the table' : 'the tables'} ${relations.join(', ')}`, state: 'done', detail: `picked from ${refs.length ? 'the fields the reading named' : 'the words of the question'}${catalogPicked.length ? `; found by the catalog search: ${catalogPicked.join(', ')}` : ''}${needsColumns.length ? `; columns of ${needsColumns.slice(0, 4).join(', ')} read from the warehouse` : ''}` });
      // THE CONTEXT THE DRAFT READS: what the user said, the previous reading,
      // and what the project says about this data (domain notes, business
      // terms the question uses, approved hints).
      const spoken = ` ${question} ${contextText} `.toLowerCase();
      const termLines = current.entries
        .filter((entry) => entry.kind === 'term' && [entry.name, entry.label ?? '', ...entry.aliases].some((name) => name.length > 2 && spoken.includes(name.toLowerCase())))
        .slice(0, 5)
        .map((entry) => `- business term ${entry.label ?? entry.name}: ${[entry.description, ...(entry.rules ?? [])].filter(Boolean).join(' ').slice(0, 300)}`);
      const briefing = view.pack?.domainBriefing;
      const hintLines = (view.pack?.appliedHints ?? []).slice(0, 5)
        .map((hint) => hint.lesson?.rule || hint.guidance)
        .filter((rule): rule is string => Boolean(rule))
        .map((rule) => `- approved hint: ${rule.slice(0, 300)}`);
      // A GOVERNED METRIC the question or the reading names is computed the
      // governed way: its definition is part of the context, never re-invented.
      const measureRefs = new Set(intent ? intent.measures.flatMap((measure) => measure.derived ? [measure.derived.numerator, measure.derived.denominator] : [measure.ref]) : []);
      const metricLines = current.entries
        .filter((entry) => (entry.kind === 'metric' || entry.kind === 'measure') && !entry.engineOnly && (measureRefs.has(entry.ref) || [entry.name.replace(/_/g, ' '), entry.label ?? '', ...entry.aliases].some((name) => name.length > 3 && spoken.includes(name.toLowerCase()))))
        .slice(0, 5)
        .map((entry) => {
          const physical = entry.physical;
          const definition = entry.derived
            ? `${entry.derived.expr} over ${entry.derived.inputs.map((input) => `${input.alias} = ${input.ref}`).join(', ')}`
            : physical?.expr
              ? physical.expr
              : physical?.column
                ? `${(physical.aggregate ?? entry.aggregation ?? 'sum').toUpperCase()}(${physical.column})`
                : entry.expr ?? 'as described';
          return `- governed ${entry.kind} ${entry.label ?? entry.name}: ${definition}${physical?.relation ? ` on ${physical.relation}` : ''}${entry.timeRef ? `, time ${entry.timeRef}` : ''}${entry.description ? ` (${entry.description.slice(0, 120)})` : ''}`;
        });
      const contextLines = [
        ...(contextText ? [`- conversation so far: ${contextText.slice(0, 600)}`] : []),
        ...(prior?.intent.reading ? [`- previous reading: ${prior.intent.reading.slice(0, 300)}${prior.summary ? `; its answer: ${prior.summary.slice(0, 300)}` : ''}`] : []),
        ...(briefing ? [`- domain ${briefing.name}${briefing.description ? `: ${briefing.description.slice(0, 300)}` : ''}${briefing.caveats.length ? `; caveats: ${briefing.caveats.slice(0, 3).join('; ')}` : ''}${briefing.requiredFilters.length ? `; required filters: ${briefing.requiredFilters.slice(0, 3).join('; ')}` : ''}`] : []),
        ...termLines,
        ...metricLines,
        ...hintLines,
      ];
      const attemptDraft = async (note?: string): Promise<Awaited<ReturnType<NonNullable<PrepareDeps['draftSql']>>>> => {
        const unresolvedPhysical = current.entries
          .filter((entry) => entry.kind === 'relation' && relations.some((relation) => {
            const physical = entryPhysicalRelation(entry);
            return physical !== undefined && physicalRelationIdentity(physical) === physicalRelationIdentity(relation);
          }))
          .filter((entry) => !entry.physical?.binding || (connection?.driver.toLowerCase() === 'snowflake' && !entry.physical.binding.database));
        if (unresolvedPhysical.length > 0) {
          return { error: `the relation ${unresolvedPhysical.map((entry) => entry.model ?? entry.name).join(', ')} does not have one exact physical database binding for this target; refresh metadata or resolve the duplicate database identity before drafting SQL` };
        }
        const cards: string[] = [];
        let chars = 0;
        for (const relation of relations) {
          const entry = current.entries.find((item) => {
            if (item.kind !== 'relation') return false;
            const physical = entryPhysicalRelation(item);
            return physical !== undefined && physicalRelationIdentity(physical) === physicalRelationIdentity(relation);
          });
          const lines = [
            entry ? `- executable relation:${relation} [${entry.physical?.binding?.columnCompleteness ?? 'partial'} columns; logical ${entry.physical?.binding?.logicalRelation ?? entry.model ?? relation}]` : `- executable relation:${relation}`,
            ...current.entries.filter((item) => item.kind === 'column' && samePhysicalEntry(item, entry)).map((item) => renderCard(item)),
          ];
          for (const line of lines) { if (chars + line.length > 14_000) break; cards.push(line); chars += line.length + 1; }
        }
        const dialect = connection?.driver ?? 'duckdb';
        const messages: AgentMessage[] = [
          { role: 'system', content: `You write exactly ONE read-only SQL statement for ${dialect} that answers the question from the tables below. No certified block or governed metric answers it, so you choose the tables, columns, joins and filters. Use ONLY the executable physical relations and columns listed below, spelled exactly as listed (including database and quoting where shown). Join two relations only on columns that exist in both. Apply every restriction the question states; when unsure how a text value is stored, match it case-insensitively; aggregate at the grain the question asks for; order and limit as it asks; never return more than 500 rows. No DDL or DML, no comments, no explanation. The CONTEXT lines are what the user and the project have said about this data (definitions, rules, where values are kept): follow them, and use a table or field the user names as named. A governed metric listed in CONTEXT is computed exactly as it is defined there. When no column is dedicated to a restriction the question states, apply it to the text, tag, category or custom field that most plausibly holds that value, matched case-insensitively (a partial match is allowed). Reply exactly NO_SQL: followed by one sentence naming what is missing only when no listed column could hold a measure or a restriction the question asks for, and never substitute a different measure for the one asked. Otherwise return the SQL only.` },
          { role: 'user', content: `QUESTION: ${question}\n${reason ? `WHY NO GOVERNED ANSWER: ${reason.slice(0, 600)}\n` : ''}${intent ? `READING: ${intent.reading}\nINTENT: ${JSON.stringify({ measures: intent.measures, groupBy: intent.groupBy, display: intent.display, filters: intent.filters, time: intent.time ?? null, ordering: intent.ordering ?? null, limit: intent.limit ?? null })}\n` : ''}${contextLines.length ? `CONTEXT:\n${contextLines.join('\n')}\n` : ''}${note ? `NOTE: ${note}\n` : ''}${previous ? `PREVIOUS SQL (the warehouse rejected it; fix it):\n${previous.sql}\nWAREHOUSE ERROR: ${previous.error.slice(0, 600)}\n` : ''}RELATIONS AND COLUMNS:\n${cards.join('\n')}` },
        ];
        const draftStarted = Date.now();
        const trace = deps.dispatchOptions?.('draft', request);
        let raw: string;
        try {
          if (request.signal?.aborted) throw new Error('the request was cancelled before SQL drafting started');
          raw = await provider.generate(messages, { temperature: 0, ...(trace?.options ?? {}), ...(request.signal ? { signal: request.signal } : {}) });
          trace?.settle('ok');
        } catch (error) {
          trace?.settle(request.signal?.aborted ? 'cancelled' : 'error', error);
          throw error;
        } finally {
          draftDispatches.push({ purpose: 'intent:draft', ms: Date.now() - draftStarted, promptChars: messages.reduce((sum, message) => sum + message.content.length, 0) });
        }
        const declined = /^\s*NO_SQL\s*:?\s*([\s\S]*)$/i.exec(raw.trim());
        if (declined) return { declined: declined[1]!.trim() || 'the available tables do not hold what the question asks for' };
        const fenced = /```(?:sql)?\s*([\s\S]*?)```/i.exec(raw);
        const sql = (fenced ? fenced[1]! : raw).trim();
        if (!sql) return { error: 'the provider returned no SQL' };
        const runtimeSchema = runtimeSchemaForVocabulary(current)
          .filter((table) => relations.some((relation) => physicalRelationIdentity(relation) === physicalRelationIdentity(table.relation)));
        const validation = validateSqlAgainstLocalContext(sql, view.pack, {
          dialect,
          question,
          runtimeSchema,
          runtimeSchemaExact: true,
          ...(connection ? { executionTargetFingerprint: fingerprintText(connectionKey(connection)) } : {}),
          enforceGenerationReadiness: false,
        });
        if (!validation.ok) {
          // A parser that cannot read this dialect is not evidence against the
          // draft: prove it by the relations it reads, exactly as the frozen
          // statement is proven before execution. Read-only-ness is proven by
          // the tier itself.
          if (!/could not be parsed/i.test(validation.error)) return { error: `the drafted SQL was not accepted: ${validation.error}` };
          const inspected = new Set(runtimeSchema.map((table) => executionRelationIdentityFor(table.relation, dialect)));
          const read = relationsInSql(sql).filter((relation) => parsePhysicalIdentifier(relation).length >= 2);
          const foreign = read.find((relation) => !inspected.has(executionRelationIdentityFor(relation, dialect)));
          if (foreign) return { error: `the drafted SQL reads ${foreign}, which this request did not inspect` };
          if (read.length === 0) return { error: 'the drafted SQL names no inspected relation' };
          return { sql, relations: read, proof: [`reads only the inspected physical bindings: ${read.join(', ')} (the SQL parser could not read this dialect; relations proven by name)`], engine: dialect };
        }
        return { sql, relations: validation.referencedRelations, proof: [`validated against the inspected physical bindings: it reads ${validation.referencedRelations.join(', ') || 'admitted relations only'}`, ...validation.warnings.slice(0, 3)], engine: dialect };
      };
      // THE CHECKS BEFORE ANYTHING RUNS. Every value the question states and
      // every required filter of the project must be in the statement, and a
      // join that repeats its key on both sides must not feed an aggregate.
      // One redraft names the failure; a failure that survives it is refused,
      // never run. What passes is row-guarded and says what it filters on.
      const stated = statedValues(question, intent);
      const requiredTexts = [...new Set([
        ...current.entries.filter((entry) => entry.kind === 'skill').flatMap((entry) => entry.skill?.requiredFilters ?? []),
        ...(view.pack?.domainBriefing?.requiredFilters ?? []),
      ])];
      const required = requiredTexts.map((text) => requiredFilterFromText(text)).filter((item): item is NonNullable<typeof item> => Boolean(item));
      const probeOne = async (sql: string): Promise<boolean> => {
        if (!connection) return false;
        const options = { maxRows: 1, ...(request.signal ? { signal: request.signal } : {}), ...(request.runBudget ? { deadlineMs: Math.min(8_000, request.runBudget.remainingMs()) } : {}) };
        const result = deps.executor.executePositional
          ? await deps.executor.executePositional(sql, [], connection, options)
          : await deps.executor.executeQuery(sql, [], {}, connection, options);
        return (result.rows?.length ?? 0) > 0;
      };
      const failedChecks = async (sql: string): Promise<string[]> => {
        const failures: string[] = [];
        const missing = missingStatedValues(sql, stated);
        if (missing.length) failures.push(`it does not apply ${missing.map((item) => `"${item.value}"`).join(', ')} from the question`);
        const missingRequired = missingRequiredFilters(sql, required);
        if (missingRequired.length) failures.push(`it does not apply the required filter ${missingRequired.map((item) => item.text).join(', ')}`);
        if (aggregatesRows(sql)) {
          for (const pair of joinKeyPairs(sql).slice(0, 3)) {
            const repeats = async (side: { relation: string; column: string }) => {
              try { return await probeOne(`SELECT ${side.column} FROM ${side.relation} GROUP BY ${side.column} HAVING COUNT(*) > 1`); } catch { return false; }
            };
            if (await repeats(pair.left) && await repeats(pair.right)) failures.push(`its join of ${pair.left.relation} and ${pair.right.relation} on ${pair.left.column} = ${pair.right.column} repeats the key on both sides, so totals would count rows more than once`);
          }
        }
        return failures;
      };
      type Drafted = Awaited<ReturnType<typeof attemptDraft>>;
      const finalize = async (drafted: Drafted): Promise<Drafted> => {
        if (!drafted || !('sql' in drafted)) return drafted;
        let chosen = drafted;
        let failures = await failedChecks(chosen.sql);
        if (failures.length > 0) {
          hostStep({ phase: 'schema', title: 'The drafted SQL failed a check: asking the AI to fix it', state: 'failed', detail: failures.join('; ') });
          const repaired = await attemptDraft(`The previous statement was not run because ${failures.join('; ')}. Fix exactly that and keep everything else the question asks.`);
          if (!repaired || !('sql' in repaired)) return repaired;
          chosen = repaired;
          failures = await failedChecks(chosen.sql);
          if (failures.length > 0) return { refused: failures.join('; ') };
        }
        const applied = appliedConditions(chosen.sql);
        hostStep({ phase: 'schema', title: 'Checked the drafted SQL', state: 'done', detail: [stated.length ? `applies ${stated.map((item) => item.value).join(', ')}` : '', required.length ? `required filters present: ${required.map((item) => item.text).join(', ')}` : '', applied ? `filters on ${applied}` : ''].filter(Boolean).join('; ') || 'read-only and in scope' });
        return {
          ...chosen,
          sql: withRowGuard(chosen.sql, (deps.maxRows ?? 500) + 1),
          proof: [
            ...chosen.proof,
            ...(applied ? [`applied on the data: ${applied}`] : []),
            ...(stated.length ? [`stated values applied: ${stated.map((item) => item.value).join(', ')}`] : []),
            ...(required.length ? [`required filters present: ${required.map((item) => item.text).join(', ')}`] : []),
          ],
        };
      };
      // WHERE A STATED VALUE LIVES. A name the question states ("Splunk") is
      // looked for in the stored values of text columns the project allows to
      // be searched (agent.runtimeValueGrounding.searchSafeColumns). The probe
      // answers only whether the value occurs, never what else is stored, and
      // a column nobody allowlisted is never read.
      const textValues = stated.filter((item) => item.kind === 'text').slice(0, 3);
      if (textValues.length > 0 && connection) {
        const allowed = deps.literalProbeAllowed;
        const chosen = new Set(relations.map((relation) => physicalRelationIdentity(relation)));
        const asked = relevanceWords([`${question} ${open} ${contextText}`], true);
        const candidates: Array<{ relation: string; column: string; rank: number }> = [];
        if (allowed) {
          for (const relation of view.source?.relations ?? []) {
            const name = relation.binding ? physicalRelationText(relation.binding) : [relation.schema, relation.name].filter(Boolean).join('.');
            for (const column of [...relation.columns, ...(relation.embeddedColumns ?? [])]) {
              if (column.dataType && !/char|text|string|variant|array|json|object/i.test(column.dataType)) continue;
              if (!allowed(name, column.name)) continue;
              const overlap = [...relevanceWords([column.name, column.description], true)].filter((word) => asked.has(word)).length;
              candidates.push({ relation: name, column: column.name, rank: (chosen.has(physicalRelationIdentity(name)) ? 10 : 0) + overlap });
            }
          }
        }
        const probes = candidates.sort((left, right) => right.rank - left.rank || left.relation.localeCompare(right.relation)).slice(0, 6);
        const probeDialect = getDialect(connection.driver);
        const quoteName = (value: string) => renderPhysicalIdentifier(value, connection.driver, (part) => probeDialect.quoteIdentifier(part));
        for (const item of textValues) {
          if (probes.length === 0) {
            hostStep({ phase: 'search', title: `Did not look for "${item.value}" in stored values`, state: 'missed', detail: 'no text column of these tables is allowlisted for value search (agent.runtimeValueGrounding.searchSafeColumns); the AI chooses the field from names and descriptions' });
            continue;
          }
          let found: { relation: string; column: string } | undefined;
          for (const probe of probes) {
            const relationSql = parsePhysicalIdentifier(probe.relation).map((part) => part.quoted ? `"${part.value.replace(/"/g, '""')}"` : quoteName(part.value)).join('.');
            // The value is the question's own text: quotes are escaped and a
            // wildcard in it is dropped, so it can neither break nor widen the probe.
            const pattern = item.value.toLowerCase().replace(/[%_]/g, '').replace(/'/g, "''");
            try {
              if (await probeOne(`SELECT 1 AS hit FROM ${relationSql} WHERE LOWER(CAST(${quoteName(probe.column)} AS VARCHAR)) LIKE '%${pattern}%'`)) { found = probe; break; }
            } catch { /* a column that cannot be read is not where the value lives */ }
          }
          if (!found) {
            hostStep({ phase: 'search', title: `Looked for "${item.value}" in stored values: not found`, state: 'missed', detail: `searched ${probes.map((probe) => `${probe.relation}.${probe.column}`).join(', ')}` });
            continue;
          }
          contextLines.push(`- the value "${item.value}" occurs in ${found.relation}.${found.column}`);
          hostStep({ phase: 'search', title: `Found where "${item.value}" is stored: ${found.relation}.${found.column}`, state: 'done' });
          if (!relations.some((relation) => physicalRelationIdentity(relation) === physicalRelationIdentity(found!.relation)) && relations.length < 6) {
            relations.push(found.relation);
            const hasColumns = current.entries.some((entry) => entry.kind === 'column' && (() => { const physical = entryPhysicalRelation(entry); return physical !== undefined && physicalRelationIdentity(physical) === physicalRelationIdentity(found!.relation); })());
            if (!hasColumns) {
              try {
                const described = await describeRelations([found.relation]);
                if (described.length > 0) { current = mergeDiscoveredRelations(current, described); requestVocabulary = current; }
              } catch { /* drafted over what is described */ }
            }
          }
        }
      }
      const shown = [...relations];
      const first = await attemptDraft();
      if (!first || !('declined' in first)) return finalize(first);
      // THE WIDER LOOK: a decline over the tables first chosen is not a
      // decline over the project. Search every table for a column the missing
      // words name, add what is found, and draft once more.
      const words = missingFieldWords(`${first.declined} ${open}`);
      let wider: string[] = [];
      try {
        const source = view.source ?? (await baseSourceFor(connection)).source;
        const fromCatalog = catalogPick(words.join(' '), relations, 3);
        wider = [...fromCatalog, ...relationsWithColumnWords(source, words, `${question} ${open} ${contextText}`, [...relations, ...fromCatalog], 3)].slice(0, 3);
      } catch { wider = []; }
      if (wider.length > 0) {
        try {
          const found = await describeRelations(wider);
          if (found.length > 0) {
            current = mergeDiscoveredRelations(current, found);
            requestVocabulary = current;
          }
        } catch { /* only tables already described can be added */ }
        wider = wider.filter((relation) => current.entries.some((item) => item.kind === 'column' && (() => { const physical = entryPhysicalRelation(item); return physical !== undefined && physicalRelationIdentity(physical) === physicalRelationIdentity(relation); })()));
      }
      if (wider.length === 0) {
        hostStep({ phase: 'search', title: 'Searched every table for the missing field: none has it', state: 'missed', detail: `looked for ${words.slice(0, 4).join(', ') || 'the missing field'} beyond ${shown.join(', ')}` });
        return { declined: `${first.declined.replace(/[.\s]+$/, '')} (searched ${shown.join(', ')}, and no other table has a column for ${words.slice(0, 3).join(', ') || 'it'})` };
      }
      relations = [...relations, ...wider];
      hostStep({ phase: 'search', title: `Searched every table for the missing field: found ${wider.join(', ')}`, state: 'done', detail: `looked for ${words.slice(0, 4).join(', ')}; the first draft over ${shown.join(', ')} found none` });
      const second = await attemptDraft(`A first draft over ${shown.join(', ')} found no field for this ("${first.declined.slice(0, 240)}"). The tables ${wider.join(', ')} have columns named for it and were added; use them, joining on a key both tables carry.`);
      if (second && 'declined' in second) return { declined: `${second.declined.replace(/[.\s]+$/, '')} (searched ${relations.join(', ')})` };
      return finalize(second);
    };
    const outcome = await runAskPipeline({
      question: request.question,
      vocabulary,
      provider: ledgered,
      describeRelations,
      explorationAuto: deps.autoExploration !== false,
      prepareDeps: { ...prepareDeps(connection ?? { driver: 'duckdb' } as ConnectionConfig, currentVocabulary, engine, request.signal), draftSql },
      executeDeps: {
        maxRows: deps.maxRows ?? 500,
        ...(request.signal ? { signal: request.signal } : {}),
        validateCandidate: (candidate) => {
          // MetricFlow owns the physical SQL it compiles against its target.
          // Relational and review-required SQL are admitted only when their
          // statement names the same inspected bindings the drafter saw.
          if (!connection || (candidate.tier !== 'relational' && candidate.tier !== 'exploratory')) return;
          const runtimeSchema = runtimeSchemaForVocabulary(currentVocabulary());
          const unbound = currentVocabulary().entries.filter((entry) => entry.kind === 'relation' && !entry.physical?.binding);
          const usesUnbound = relationsInSql(candidate.sql).find((relation) => unbound.some((entry) => {
            const logical = entry.model ?? entry.name;
            return physicalRelationIdentity(relation) === physicalRelationIdentity(logical)
              || relation.toLowerCase().endsWith(`.${logical.toLowerCase()}`);
          }));
          if (usesUnbound) throw new Error(`SQL references ${usesUnbound}, whose physical database binding is ambiguous for this target. Refresh the relation metadata before executing.`);
          // The composer's own SQL is proven by what it READS: every qualified
          // relation it names must be one this request inspected, compared by
          // the warehouse's identifier rule. That proof needs no SQL parser; a
          // third-party parser that cannot read a dialect (three-part names on
          // SQLite, a window clause) must never veto a governed statement.
          const inspected = new Set(runtimeSchema.map((table) => executionRelationIdentityFor(table.relation, connection.driver)));
          const foreign = relationsInSql(candidate.sql)
            .filter((relation) => parsePhysicalIdentifier(relation).length >= 2)
            .find((relation) => !inspected.has(executionRelationIdentityFor(relation, connection.driver)));
          if (foreign) throw new Error(`the frozen SQL reads ${foreign}, which this request did not inspect (it inspected ${runtimeSchema.map((table) => table.relation).join(', ')}). Use the exact bound physical relation.`);
          if (candidate.tier !== 'exploratory') return;
          // Drafted SQL was parsed and validated when it was drafted; the same
          // check is repeated on the frozen statement, and a parser limitation
          // falls back to the relation proof above rather than refusing.
          const validation = validateSqlAgainstLocalContext(candidate.sql, view.pack, {
            dialect: connection.driver,
            runtimeSchema,
            runtimeSchemaExact: true,
            executionTargetFingerprint: fingerprintText(connectionKey(connection)),
            enforceGenerationReadiness: false,
            positionalParameterCount: candidate.params?.length ?? 0,
          });
          if (!validation.ok && !/could not be parsed/i.test(validation.error)) throw new Error(`the frozen SQL is not bound to this execution target: ${validation.error}`);
        },
        run: async (sql, params, options) => {
          if (request.signal?.aborted) throw new Error('the request was cancelled before warehouse execution started');
          if (!connection) throw connectionError instanceof Error ? connectionError : new Error(String(connectionError ?? 'No database connection is configured.'));
          // A relation this connection has already proven it cannot see is
          // refused before SQL: the catalog lists it, the warehouse does not
          // have it, and a second round trip would say the same thing.
          const cacheKey = connectionKey(connection);
          const known = knownMissingRelation(cacheKey, sql);
          if (known) throw new Error(`'${known}' is known to be missing on this connection: the catalog lists it, the warehouse does not have it`);
          const started = Date.now();
          const executor = deps.executor as QueryExecutor & { executePositional?: QueryExecutor['executePositional'] };
          const span = deps.traceExecution?.(request, { name: 'sql.execute', sqlFingerprint: fingerprintText(`${sql}\n${JSON.stringify(params ?? [])}`), purpose: options.purpose ?? 'query', ...(options.tier ? { tier: options.tier } : {}) });
          let result: Awaited<ReturnType<QueryExecutor['executeQuery']>>;
          try {
            options.onWarehouseAttempt?.();
            result = typeof executor.executePositional === 'function'
              ? await executor.executePositional(sql, params ?? [], connection, { maxRows: options.maxRows, ...(options.signal ?? request.signal ? { signal: options.signal ?? request.signal } : {}), ...(request.runBudget ? { deadlineMs: request.runBudget.remainingMs() } : {}) })
              : await (async () => {
                if (params?.length) throw new Error('this warehouse executor cannot bind positional parameters');
                return executor.executeQuery(sql, [], {}, connection, { maxRows: options.maxRows, ...(options.signal ?? request.signal ? { signal: options.signal ?? request.signal } : {}), ...(request.runBudget ? { deadlineMs: request.runBudget.remainingMs() } : {}) });
              })();
          } catch (error) {
            options.onWarehouseResult?.('failed');
            span?.finish('error', { safeErrorCode: 'sql_failure' });
            const message = error instanceof Error ? error.message : String(error);
            recordRelationEvidence(cacheKey, sql, classifyWarehouseError(message), message);
            throw error;
          }
          options.onWarehouseResult?.('succeeded');
          recordRelationEvidence(cacheKey, sql);
          span?.finish('ok', { rowCount: result.rowCount, resultFingerprint: createHash('sha256').update(JSON.stringify({ columns: result.columns, rows: result.rows })).digest('hex') });
          // An executor may describe columns as objects or as bare names.
          const columns = result.columns.length
            ? (result.columns as Array<string | { name?: string }>).map((column, index) => typeof column === 'string' ? column : column?.name ?? Object.keys(result.rows[0] ?? {})[index] ?? `column_${index + 1}`)
            : Object.keys(result.rows[0] ?? {});
          // Calendar cells leave the warehouse as JS Dates; every consumer
          // (narration, persistence, the table) must read the same instant,
          // never a host-timezone rendering of it.
          const rows = (result.rows as Array<Record<string, unknown>>).map((row) => normalizeExecutedRow(row));
          return { columns, rows, rowCount: result.rowCount, executionTimeMs: result.executionTimeMs ?? Date.now() - started, ...(result.truncated ? { truncated: true } : {}) };
        },
      },
      ...(prior ? { prior: prior.intent, ...(prior.executed === false ? { priorExecuted: false } : {}), ...(prior.summary ? { priorAnswerSummary: prior.summary } : {}) } : {}),
      ...(deps.guidance?.(request) ? { guidance: deps.guidance(request) } : {}),
      ...(connection && deps.probeLiteral && deps.literalProbeAllowed ? { groundLiterals: (intent: AnalyticalIntentV1) => groundIntentLiterals(intent, currentVocabulary(), connection, tracedProbes(deps, request)) } : {}),
      // A name that matched nothing exactly may still name members of the same
      // column the query already read.
      suggestMembers: async (ref: string, literal: string) => {
        const entry = currentVocabulary().get(ref);
        const relation = entryPhysicalRelation(entry);
        const column = entry?.physical?.column;
        if (!connection || !relation || !column || !entry || entry.roles.includes('time') || entry.roles.includes('numeric') || entry.roles.includes('boolean')) return [];
        const executor = deps.executor as QueryExecutor & { executePositional?: QueryExecutor['executePositional'] };
        if (typeof executor.executePositional !== 'function') return [];
        const sql = memberCandidatesSql(relation, column, (name) => renderPhysicalIdentifier(name, connection?.driver, (value) => `"${value.replace(/"/g, '""')}"`));
        const found = await executor.executePositional(sql, [`%${literal.toLowerCase()}%`], connection, { maxRows: 8, ...(request.signal ? { signal: request.signal } : {}), ...(request.runBudget ? { deadlineMs: request.runBudget.remainingMs() } : {}) });
        return (found.rows as Array<Record<string, unknown>>)
          .map((row) => row.member)
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
      },
      // The option the user clicked is a governed ref, and the turn that
      // follows must carry it: a selection that only reaches the prompt can be
      // ignored, and the question then comes back a second time.
      ...(selectedMeaning(request, vocabulary) ? { selection: selectedMeaning(request, vocabulary)! } : {}),
      // An identity the user settled is carried the same way: the option names
      // the dimension and the member, so the next turn reads that person.
      ...(selectedMember(request) ? { memberSelection: selectedMember(request)! } : {}),
      ...(view.context ? { context: view.context } : {}),
      ...(deps.conversation?.(request) ? { conversation: deps.conversation(request)! } : {}),
      explorationOptIn: explorationOptIn(request),
      // Research branches phrase hypotheses ("because", "drivers"); the
      // full-question clause check is for questions a person asked.
      clauseCoverage: request.requestedMode !== 'research',
      ...(request.signal ? { signal: request.signal } : {}),
      onVocabularyUpdate: (next) => { requestVocabulary = next; },
      // Room for one interpreter retry after a 90 s provider timeout plus the
      // rest of the turn; the engine's own hard deadline still wins.
      deadlineMs: request.runBudget ? Math.max(1, request.runBudget.remainingMs()) : 240_000,
      preparationCache,
      cacheScope: `${deps.getManifest().snapshotId}|${connection ? connectionKey(connection) : 'none'}|${vocabulary.fingerprint}`,
      ...(deps.buildIdentity ? { build: deps.buildIdentity() } : {}),
      trace: (event) => emit({ type: 'executor.started', message: `${event.stage}${typeof event.detail === 'number' ? ` ${event.detail} ms` : ''}`, route: 'generated_answer' }),
      onStep: (entry) => emit({ type: 'executor.started', message: entry.title, route: 'generated_answer', payload: { askStep: entry } }),
    });
    // How long the context took to assemble, beside the stages the pipeline
    // timed itself: the receipt is the only place a latency claim can be read from.
    if ('receipt' in outcome && outcome.receipt) {
      outcome.receipt.timings.context = contextMs;
      outcome.receipt.story = [...hostSteps, ...(outcome.receipt.story ?? [])].sort((left, right) => left.at - right.at);
      outcome.receipt.dispatches.push(...draftDispatches);
      outcome.receipt.physicalBindings = runtimeSchemaForVocabulary(currentVocabulary()).map((table) => ({ relation: table.relation, completeness: table.columnCompleteness ?? 'partial', columns: table.columns.length, targetFingerprint: connection ? fingerprintText(connectionKey(connection)) : undefined }));
    }
    // A ref the interpreter named that the whole inventory holds but this
    // envelope does not is OUT OF SCOPE, not "does not exist": the reader is
    // told which domain owns it and what admits it — never its data.
    if (outcome.kind === 'failed' && outcome.stage === 'resolve' && outcome.receipt.failure?.reason === 'invalid' && outcome.receipt.failure.problems?.length) {
      const explained = explainOutOfScope(outcome.receipt.failure.problems, await baseIndexFor(connection), view.envelope);
      if (explained) {
        outcome.message = explained.message;
        outcome.text = `This could not be completed while reading the question: ${explained.message}`;
        outcome.receipt.failure = { ...outcome.receipt.failure, reason: 'out_of_scope', message: explained.message };
        outcome.receipt.outOfScope = explained.refs;
      }
    }
    // The same for a gap: a clause the reading could not place may name an
    // object another domain owns; the gap says so beside what it already says.
    if (outcome.kind === 'gap' && (outcome.gap === 'not_modeled' || outcome.gap === 'ambiguous' || outcome.gap === 'not_retrieved')) {
      const explained = explainOutOfScopeWords(`${request.question} ${outcome.message}`, await baseIndexFor(connection), currentVocabulary(), view.envelope);
      if (explained) {
        outcome.text = `${outcome.text} ${explained.message}`;
        outcome.receipt.outOfScope = explained.refs;
      }
    }
    return toExecutorResult(runId, outcome, startedAt);
  };
}

function explorationOptIn(request: AgentRunRequest): boolean {
  const workspace = request.workspaceContext && typeof request.workspaceContext === 'object' ? request.workspaceContext as Record<string, unknown> : {};
  return workspace.explorationOptIn === true || request.requestedMode === 'sql';
}

/** Every physical call, corrective ones included, passes through the run's ledger. */
function withLedger(provider: AgentProvider, deps: AskPipelineHostDeps, request: AgentRunRequest): AgentProvider {
  if (!deps.dispatchOptions) return provider;
  let calls = 0;
  return {
    name: provider.name,
    available: () => provider.available(),
    generate: async (messages, options) => {
      calls += 1;
      const trace = deps.dispatchOptions!(calls === 1 ? 'resolve' : 'correct', request);
      try {
        // The host ledger contributes egress accounting only. It may not
        // replace the inherited cancellation signal carried by Ask.
        const text = await provider.generate(messages, { ...options, ...trace.options, ...(options?.signal ? { signal: options.signal } : {}) });
        trace.settle('ok');
        return text;
      } catch (error) {
        trace.settle('error', error);
        throw error;
      }
    },
  };
}

const sha = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function failure(runId: string, message: string, code: 'provider_error' | 'execution_error', startedAt: number): AgentRouteExecutorResult {
  // Even a run that stops before reading the question tells the reader where
  // it stopped and why, in its own words, never a generic "not worked out".
  const receipt: PipelineReceipt = {
    version: 1, vocabularyFingerprint: '', dispatches: [], candidates: [], refusals: [], tiers: [],
    timings: { total: Date.now() - startedAt },
    failure: { stage: 'resolve', reason: code, message },
    story: [{ version: 1, phase: 'read', title: code === 'provider_error' ? 'Could not reach an AI model' : 'Could not run the query', detail: message, state: 'failed', at: Date.now() }],
  };
  return {
    askPipelineReceipt: receipt,
    summary: message, answer: message, status: 'blocked', trustState: 'blocked', stopReason: 'blocked', resolvedRoute: 'generated_answer', answerRefusalCode: code,
    artifacts: [{ id: `${runId}:diagnostic`, kind: 'answer', title: 'Could not answer', trustState: 'blocked', payload: { kind: 'no_answer', text: message, answer: message, executionError: message } }],
    evaluations: [], nextActions: [{ id: 'retry-after-provider', label: 'Retry after fixing the AI model settings', route: 'generated_answer' }],
    telemetry: { version: 1, stageDurationsMs: { total: Date.now() - startedAt }, providerRoundTrips: 0, toolCalls: 0, sqlExecutions: 0, repairs: 0, egressReceipts: 0 },
  };
}

/** How a gap is headed: no matching data is not a modeling gap. */
/**
 * The clarification option the user picked, when it names something this
 * vocabulary holds. A selection the vocabulary cannot resolve is ignored here
 * (the router validates the id separately); it is never turned into SQL.
 */
export function selectedMember(request: AgentRunRequest): { ref: string; values: string[] } | undefined {
  const id = request.selectedEvidenceId?.trim();
  return id ? parseMemberOption(id) : undefined;
}

/**
 * The clarification option the user picked, when it names something this
 * vocabulary holds.
 */
export function selectedMeaning(request: AgentRunRequest, vocabulary: VocabularyIndex): { ref: string; label?: string } | undefined {
  const id = request.selectedEvidenceId?.trim();
  if (!id) return undefined;
  const entry = vocabulary.get(id) ?? vocabulary.resolve(id);
  return entry ? { ref: entry.ref, ...(entry.label ? { label: entry.label } : {}) } : undefined;
}

/**
 * The members of one column whose stored value CONTAINS a literal. Asked only
 * after a query that already filtered that column came back empty, so it opens
 * nothing new: it reads the column the answer was about, bounded to a handful
 * of values, and text columns only. "Curry" is not missing from the data — it
 * names two players.
 */
export function memberCandidatesSql(relation: string, column: string, quote: (name: string) => string, limit = 7): string {
  // `split('.')` turns "Db.With.Dot" into three names. Reuse the physical
  // parser used by probing and drafting; quoted components remain one exact
  // warehouse identifier while unquoted components use the connector dialect.
  const qualified = parsePhysicalIdentifier(relation)
    .map((part) => part.quoted ? `"${part.value.replace(/"/g, '""')}"` : quote(part.value))
    .join('.');
  return `SELECT DISTINCT ${quote(column)} AS member FROM ${qualified} WHERE ${quote(column)} IS NOT NULL AND LOWER(CAST(${quote(column)} AS VARCHAR)) LIKE ? ORDER BY 1 LIMIT ${limit}`;
}

/**
 * THE TWO THINGS A RELATIONSHIP MUST PROVE. A key that repeats in the relation
 * carrying the label multiplies the facts joined to it, and a key the label
 * relation does not hold drops rows silently — so a join nobody declared is
 * admitted only when the warehouse says the key is unique there AND every key
 * the facts carry appears there. One statement answers both.
 */

/** How long a warehouse proof authorizes execution before it must be gathered again (`agent.relationshipEvidenceTtlHours`, default 24). */
export function relationshipEvidenceTtlHours(): number {
  const raw = Number(process.env.DQL_RELATIONSHIP_EVIDENCE_TTL_HOURS ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : 24;
}

/**
 * A DATA-GENERATION TOKEN, where the driver offers one. The snapshot is
 * metadata; warehouse rows change without a manifest change, so a proof that
 * held yesterday may not hold today. A DuckDB file's size and modification
 * time change when its data does; other drivers yield no token and rely on the
 * bounded expiry alone.
 */
export async function evidenceGenerationToken(connection: ConnectionConfig): Promise<string | undefined> {
  try {
    const path = (connection as { path?: unknown; database?: unknown }).path ?? (connection as { database?: unknown }).database;
    if (connection.driver === 'duckdb' && typeof path === 'string' && path && path !== ':memory:') {
      const stat = statSync(path);
      return `duckdb:${stat.size}:${Math.round(stat.mtimeMs)}`;
    }
  } catch { /* no token */ }
  return undefined;
}

/**
 * Persist the evidence a proof gathered so Domain Studio can show "validated
 * by Ask on <date>" and certify from it. Ignored local state, never governed
 * source; the file names the pair, and a later proof overwrites it.
 */
export function writeRelationshipEvidence(projectRoot: string, record: Record<string, unknown> & { fromRelation: string; toRelation: string }): void {
  try {
    const dir = join(projectRoot, '.dql', 'evidence', 'relationships');
    mkdirSync(dir, { recursive: true });
    const name = `${record.fromRelation}__${record.toRelation}`.replace(/[^A-Za-z0-9_.-]+/g, '_');
    writeFileSync(join(dir, `${name}.relationship-evidence.json`), `${JSON.stringify({ version: 1, gatheredBy: 'ask', ...record }, null, 2)}\n`);
  } catch { /* evidence is a convenience for review, never a condition of the answer */ }
}

/** A key both relations spell the same way, and that reads like an identifier. */
export function sharedKeyColumn(factColumns: Iterable<string>, labelColumns: Iterable<string>): string | undefined {
  const label = new Map([...labelColumns].map((column) => [column.toLowerCase(), column]));
  const shared = [...factColumns].filter((column) => label.has(column.toLowerCase()));
  return shared.find((column) => /(^|_)(id|key)$/i.test(column)) ?? undefined;
}

/**
 * The context ledger, in one line the reader can check: how many governed
 * objects the question was read against and in which domain, how many were
 * shown, which skills and hints were selected, and what the answer used.
 */
export function contextEvaluation(receipt: { context?: ContextLedgerV1 }): Array<{ id: string; label: string; passed: boolean; severity: 'info'; message: string }> {
  const ledger = receipt.context;
  if (!ledger?.admitted) return [];
  const admitted = Object.values(ledger.admitted.byKind).reduce((sum, count) => sum + count, 0);
  const shown = Object.values(ledger.rendered?.byKind ?? {}).reduce((sum, count) => sum + count, 0);
  const where = ledger.envelope?.activeDomain ? ` in ${ledger.envelope.activeDomain}` : '';
  const shortName = (ref: string) => ref.replace(/^(skill|hint):/, '').split('::').pop() ?? ref;
  const skills = ledger.rendered?.skills.length ? `; skill${ledger.rendered.skills.length === 1 ? '' : 's'} ${ledger.rendered.skills.map(shortName).join(', ')}` : '';
  const hints = ledger.rendered?.hints.length ? `; approved correction${ledger.rendered.hints.length === 1 ? '' : 's'} ${ledger.rendered.hints.map(shortName).join(', ')}` : '';
  const unrendered = ledger.selected?.unrendered.length ? `; ${ledger.selected.unrendered.length} of the refs the reading used were found beyond the cards shown` : '';
  const used = ledger.used?.tier ? `; answered on the ${ledger.used.tier} tier${ledger.used.engine ? ` (${ledger.used.engine})` : ''}` : '';
  const joins = (ledger.used?.joins ?? []).map((join) => join.authority === 'proven_default'
    ? 'a join proven on the warehouse (structurally safe on this snapshot and connection; not a certified business relationship)'
    : join.source === 'semantic_layer' ? 'a semantic-layer join' : `a certified relationship${join.relationshipId ? ` (${shortName(join.relationshipId)})` : ''}`);
  const joined = joins.length ? `; joins: ${[...new Set(joins)].join(', ')}` : '';
  return [{ id: 'pipeline-context', label: 'Context read', passed: true, severity: 'info', message: `Read against ${admitted} governed objects${where} (${shown} shown)${skills}${hints}${unrendered}${used}${joined}.` }];
}

export function gapPresentation(gap: Extract<PipelineOutcome, { kind: 'gap' }>['gap'], message?: string): { title: string; code: 'policy_blocked' | 'ambiguous' | 'no_data' | 'modeling_gap' } {
  if (gap === 'denied') return { title: 'Blocked by policy', code: 'policy_blocked' };
  if (gap === 'ambiguous') return { title: 'One detail is missing', code: 'ambiguous' };
  // The heading names what actually came back empty. A card titled "for that
  // period" over a body about a member nobody could find contradicts itself,
  // and the reader believes the heading.
  if (gap === 'not_retrieved') {
    if (message && /no rows matched\s+"/.test(message)) return { title: 'No matching data for that name', code: 'no_data' };
    if (message && /no rows matched the restriction/.test(message)) return { title: 'No matching data under those filters', code: 'no_data' };
    return { title: 'No matching data for that period', code: 'no_data' };
  }
  return { title: 'No governed answer', code: 'modeling_gap' };
}

/**
 * A certified block, compiled and bound the way Block Studio, Apps and the
 * Notebook run it: values from the shared invocation contract (declared
 * defaults, values the question states outright, explicit inputs), SQL
 * lowered by the DQL compiler to positional placeholders, and the bound
 * values in placeholder order. No template placeholder survives.
 */
export function prepareBlockForAsk(projectRoot: string, entry: VocabularyEntry | undefined, context: { question?: string }, driver?: string): PreparedBlock | undefined {
  if (!entry || entry.kind !== 'block') return undefined;
  if (!entry.sourcePath) {
    // No declaration on disk: the raw query is only usable without parameters.
    return entry.sql && !/\$\{/.test(entry.sql) ? { sql: entry.sql, params: [], parameters: [] } : { error: 'the block declaration is not available to bind its parameters' };
  }
  let source: string;
  try {
    source = readFileSync(join(projectRoot, entry.sourcePath), 'utf8');
  } catch (error) {
    return { error: `the block source could not be read (${entry.sourcePath}): ${error instanceof Error ? error.message : String(error)}` };
  }
  const invocation = prepareBlockInvocation({ block: entry.name, source, question: context.question, surface: 'ask_ai' });
  if (invocation.errors.length) return { error: invocation.errors.join(' '), unresolved: invocation.unresolvedParameters };
  if (invocation.unresolvedParameters.length) return { error: `it still needs values for ${invocation.unresolvedParameters.join(', ')}`, unresolved: invocation.unresolvedParameters };
  let plan: ReturnType<typeof buildExecutionPlan>;
  try {
    plan = buildExecutionPlan({ id: `ask-${entry.name}`, type: 'dql', source, title: entry.name }, { ...(driver ? { driver } : {}), parameters: invocation.values });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (!plan?.sql) return { error: 'the block produced no executable SQL' };
  const specs = [...plan.sqlParams].sort((left, right) => left.position - right.position);
  // The invocation's resolved values win (a question's "top 3" over the declared default); the plan's variables are the declared defaults.
  const params = specs.map((spec) => (invocation.values[spec.name] !== undefined ? invocation.values[spec.name] : plan.variables[spec.name] !== undefined ? plan.variables[spec.name] : spec.literalValue));
  const missing = specs.filter((spec, index) => params[index] === undefined).map((spec) => spec.name);
  if (missing.length) return { error: `no value bound for ${missing.join(', ')}`, unresolved: missing };
  if (/\$\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}/.test(plan.sql)) return { error: 'a template placeholder survived compilation' };
  const sources = new Map(invocation.resolvedParameters.map((parameter) => [parameter.name, parameter.source]));
  return {
    sql: plan.sql,
    params,
    parameters: specs.map((spec, index) => ({ name: spec.name, position: spec.position, value: params[index], source: sources.get(spec.name) ?? 'default' })),
    ...(entry.contract?.outputs?.length ? { outputs: entry.contract.outputs } : {}),
  };
}

/**
 * What a connection has proven it cannot see. The catalog is a snapshot of the
 * project's models; the connection is the warehouse as it is right now. When
 * the two disagree the disagreement is durable for the session: asking the
 * same missing table again costs another failed round trip and tells the
 * reader nothing new, so the second question is refused before SQL.
 */
interface MissingRelationEvidence {
  expiresAt: number;
  /** Original warehouse spelling for an actionable, non-quoted diagnostic. */
  relation: string;
}

const MISSING_RELATION_TTL_MS = 60_000;
const missingByConnection = new Map<string, Map<string, MissingRelationEvidence>>();

/** A stable key for a connection: the account and database, never a credential. */
export function connectionKey(connection: ConnectionConfig): string {
  // Keep cache reuse scoped to the execution identity, never a credential.
  // Snowflake role/warehouse/database changes can alter INFORMATION_SCHEMA
  // visibility without changing account or host, so omitting them turns a
  // short-lived observation into the wrong target's metadata.
  const candidate = connection as ConnectionConfig & Record<string, unknown>;
  const fields: Array<[string, unknown]> = [
    ['driver', connection.driver], ['account', connection.account], ['host', connection.host], ['port', connection.port],
    ['database', connection.database ?? connection.catalog], ['schema', connection.schema], ['warehouse', connection.warehouse], ['role', connection.role],
    ['user', connection.username ?? candidate.user], ['filepath', connection.filepath], ['project', connection.projectId],
    ['runtimeGeneration', candidate.runtimeGeneration ?? candidate.runtime_generation ?? candidate.generationId],
    ['currentDatabase', candidate.currentDatabase], ['currentSchema', candidate.currentSchema],
  ];
  return fields
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([name, value]) => `${name}=${String(value)}`)
    .join('|');
}

/** Relation names as SQL writes them, lowercased and unquoted. */
function relationsInSql(sql: string): string[] {
  const found = new Set<string>();
  for (const match of sql.matchAll(/(?:FROM|JOIN)\s+((?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w$]*)){0,2})/gi)) {
    const name = (match[1] ?? '').trim();
    if (name) found.add(name);
  }
  return [...found];
}

/**
 * The identity a warehouse gives a relation written in SQL. Snowflake keeps
 * quote state; DuckDB and SQLite compare quoted and unquoted names alike and
 * case-insensitively (their compilers quote every component), so only the
 * component count and the folded spelling count there.
 */
function executionRelationIdentityFor(relation: string, driver: string | undefined): string {
  const lower = driver?.trim().toLowerCase();
  if (lower !== 'duckdb' && lower !== 'sqlite') return physicalRelationIdentity(relation);
  return parsePhysicalIdentifier(relation).map((part) => `d:${part.value.toLocaleLowerCase('en-US')}`).join('.');
}

/** Exact Snowflake-aware identity for a relation already written in SQL. */
function relationKey(name: string): string {
  return physicalRelationIdentity(name);
}

/** A legacy two-part alias is safe only for an unqualified SQL reference. */
function relationTailKey(name: string): string | undefined {
  const parts = parsePhysicalIdentifier(name);
  if (parts.length < 2) return undefined;
  return `tail:${parts.slice(-2).map((part) => part.value.toLowerCase()).join('.')}`;
}

/** The relation this query reads that the connection is already known to lack. */
export function knownMissingRelation(key: string, sql: string): string | undefined {
  const missing = missingByConnection.get(key);
  if (!missing || missing.size === 0) return undefined;
  const now = Date.now();
  for (const [relation, evidence] of missing) if (evidence.expiresAt <= now) missing.delete(relation);
  for (const relation of relationsInSql(sql)) {
    const evidence = missing.get(relationKey(relation));
    if (evidence) return evidence.relation;
    // The current connection's database is part of its cache key, so a legacy
    // schema.table statement can reuse a definite failure learned from the
    // fully qualified version. A different fully-qualified database never
    // consults this alias.
    if (parsePhysicalIdentifier(relation).length === 2) {
      const tailEvidence = relationTailKey(relation) ? missing.get(relationTailKey(relation)!) : undefined;
      if (tailEvidence) return tailEvidence.relation;
    }
  }
  return undefined;
}

/** Record what a failed query proved about the connection, and what a successful one disproved. */
export function recordRelationEvidence(key: string, sql: string, failure?: { class: string; relations: string[] }, rawMessage?: string): void {
  if (!failure) {
    const missing = missingByConnection.get(key);
    if (!missing) return;
    for (const relation of relationsInSql(sql)) {
      missing.delete(relationKey(relation));
      const tail = relationTailKey(relation);
      if (tail) {
        // A success on a legacy schema.table reference disproves the bounded
        // negative observation recorded from its fully-qualified spelling on
        // this same target. Remove both forms together.
        for (const [cacheKey, evidence] of missing) {
          if (cacheKey === tail || relationTailKey(evidence.relation) === tail) missing.delete(cacheKey);
        }
      }
    }
    return;
  }
  if (failure.class !== 'relation_missing') return;
  // Snowflake intentionally combines a missing object and an access denial in
  // one message. Caching that message as absence would survive a role change
  // and turn a permission/configuration problem into a false catalog claim.
  if (/does not exist\s+or\s+not authorized|not exist\s+or\s+not authorized/i.test(rawMessage ?? '')) return;
  const named = failure.relations.length ? failure.relations : relationsInSql(sql);
  if (named.length !== 1) return;
  const missing = missingByConnection.get(key) ?? new Map<string, MissingRelationEvidence>();
  const namedRelation = named[0]!;
  const sourceRelation = relationsInSql(sql).find((relation) => relationTailKey(relation) === relationTailKey(namedRelation)) ?? namedRelation;
  const evidence = { expiresAt: Date.now() + MISSING_RELATION_TTL_MS, relation: namedRelation };
  // Use the exact relation that was actually submitted, since Snowflake error
  // text drops quote state. The original error spelling remains the user-facing
  // diagnostic.
  missing.set(relationKey(sourceRelation), evidence);
  const tail = relationTailKey(namedRelation);
  if (tail) missing.set(tail, evidence);
  missingByConnection.set(key, missing);
}

/** Test seam: forget everything learned about connections. */
export function resetRelationEvidence(): void {
  missingByConnection.clear();
}

export function toExecutorResult(runId: string, outcome: PipelineOutcome, startedAt: number): AgentRouteExecutorResult {
  const receipt = outcome.receipt;
  const telemetry: AgentRouteExecutorResult['telemetry'] = {
    version: 1,
    stageDurationsMs: {
      ...(receipt.timings.context !== undefined ? { context: receipt.timings.context } : {}),
      ...(receipt.timings.resolve !== undefined ? { meaning: receipt.timings.resolve } : {}),
      ...(receipt.timings.execute !== undefined ? { execution: receipt.timings.execute } : {}),
      total: Date.now() - startedAt,
    },
    providerRoundTrips: receipt.dispatches.length,
    toolCalls: receipt.candidates.length + receipt.refusals.length,
    sqlExecutions: receipt.warehouse?.executions ?? (receipt.executed ? 1 : 0),
    ...(receipt.warehouse ? { sqlAttempts: receipt.warehouse.attempts, sqlFailures: receipt.warehouse.failures } : {}),
    repairs: receipt.dispatches.filter((dispatch) => dispatch.purpose.includes('repair')).length,
    egressReceipts: receipt.dispatches.length,
  };
  const common = { askIntentV1: outcome.intent, askPipeline: receipt };
  const withReceipt = <T extends AgentRouteExecutorResult>(result: T): T => ({ ...result, askPipelineReceipt: receipt });
  if (outcome.kind === 'conversation' || outcome.kind === 'definition') {
    return withReceipt({ summary: outcome.kind === 'definition' ? 'Explained a governed definition.' : 'Replied conversationally.', answer: outcome.reply, answerKind: 'conversational', status: 'completed', trustState: 'not_applicable', stopReason: 'conversational_reply', resolvedRoute: 'conversation', artifacts: [], evaluations: [], nextActions: [], telemetry });
  }
  if (outcome.kind === 'clarify') {
    const clarificationOptions: NonNullable<AgentRouteExecutorResult['clarificationOptions']> = outcome.options.map((option) => ({ id: option.ref, label: option.label, ...(option.description ? { description: option.description } : {}), kind: option.ref.startsWith('member:') ? 'member' : 'vocabulary' }));
    return withReceipt({ summary: outcome.question, answer: outcome.question, status: 'needs_clarification', trustState: 'not_applicable', stopReason: 'needs_clarification', resolvedRoute: 'clarify', answerRefusalCode: 'ambiguous', clarificationOptions, artifacts: [{ id: `${runId}:clarify`, kind: 'answer', title: 'One question before running this', trustState: 'not_applicable', payload: { kind: 'no_answer', text: outcome.question, answer: outcome.question, ...common } }], evaluations: [], nextActions: [{ id: 'clarify', label: 'Clarify question', route: 'generated_answer' }], telemetry });
  }
  if (outcome.kind === 'gap') {
    const nextActions: AgentRunNextAction[] = [
      ...(receipt.outOfScope?.length ? [{ id: 'widen-scope', label: 'Ask with a purpose that imports it, or declare the import in Domain Studio', route: 'modeling_draft' as const }] : []),
      { id: 'review-metadata-gap', label: 'Review what the project models', route: 'blocked' },
      ...(outcome.offerExploration ? [{ id: 'explore-review-required', label: 'Explore the physical tables (review-required)', route: 'generated_answer' as const }] : []),
    ];
    const presentation = gapPresentation(outcome.gap, outcome.message);
    return withReceipt({ summary: outcome.text, answer: outcome.text, status: 'blocked', trustState: 'blocked', stopReason: 'blocked', resolvedRoute: 'generated_answer', answerRefusalCode: presentation.code, artifacts: [{ id: `${runId}:gap`, kind: 'answer', title: presentation.title, trustState: 'blocked', payload: { kind: 'no_answer', text: outcome.text, answer: outcome.text, gap: { kind: outcome.gap, message: outcome.message, nearest: outcome.nearest }, ...common } }], evaluations: [], nextActions, telemetry });
  }
  if (outcome.kind === 'failed') {
    const outOfScope = receipt.failure?.reason === 'out_of_scope';
    const invalid = receipt.failure?.reason === 'invalid';
    return withReceipt({ summary: outcome.text, answer: outcome.text, status: 'blocked', trustState: 'blocked', stopReason: 'blocked', resolvedRoute: 'generated_answer', answerRefusalCode: outOfScope || invalid ? 'modeling_gap' : outcome.stage === 'resolve' ? 'provider_error' : 'execution_error', artifacts: [{ id: `${runId}:failed`, kind: 'answer', title: outcome.stage === 'execute' ? 'The query failed on the warehouse' : outOfScope ? 'Outside this question\'s scope' : 'Could not prepare the query', trustState: 'blocked', payload: { kind: 'no_answer', text: outcome.text, answer: outcome.text, executionError: outcome.message, failedStage: outcome.stage, ...common } }], evaluations: [], nextActions: outOfScope
      ? [{ id: 'widen-scope', label: 'Ask with a purpose that imports it, or declare the import in Domain Studio', route: 'modeling_draft' }]
      : [{ id: 'review-analytical-failure', label: 'Review the interpretation and the engine message', route: 'blocked' }], telemetry });
  }
  if (outcome.kind !== 'answered') throw new Error(`unreachable pipeline outcome ${String((outcome as { kind: string }).kind)}`);
  const { candidate, result } = outcome;
  const certified = candidate.trust === 'certified';
  const reviewRequired = candidate.trust === 'review_required';
  // A certified block served as published for a question it cannot answer
  // with identity is evidence: governed trust, the block as its source.
  const blockAsEvidence = candidate.tier === 'certified' && !certified;
  const route = certified ? { tier: 'certified_block', label: 'Certified block' } : blockAsEvidence ? { tier: 'certified_block', label: 'Certified block, served as evidence' } : reviewRequired ? { tier: 'generated_sql', label: 'AI-drafted SQL (review required)' } : candidate.tier === 'semantic' ? { tier: 'semantic_metric', label: 'Semantic metric' } : { tier: 'governed_relational', label: 'Governed relational program' };
  const trustState = certified ? 'certified' : reviewRequired ? 'review_required' : 'governed';
  const payload = {
    kind: certified ? 'certified' : 'uncertified',
    route,
    sourceTier: certified || blockAsEvidence ? 'certified_artifact' : candidate.tier === 'semantic' ? 'semantic_layer' : 'dbt_manifest',
    certification: certified ? 'certified' : reviewRequired ? 'review_required' : 'governed',
    reviewStatus: certified ? 'certified' : reviewRequired ? 'review_required' : 'governed',
    text: outcome.text,
    answer: outcome.text,
    sql: candidate.sql,
    ...(candidate.params?.length ? { sqlParams: candidate.params } : {}),
    result: {
      columns: result.columns, rows: result.rows, rowCount: result.rowCount, executionTime: result.executionTimeMs, sql: candidate.sql,
      // Canonical result identity is a bare sha256 hex: every reader of
      // execution proof (Research branches, result follow-ups) validates that shape.
      resultFingerprint: createHash('sha256').update(JSON.stringify({ columns: result.columns, rows: result.rows })).digest('hex'), trustState, answerTier: route.tier, ...(result.truncated ? { truncated: true } : {}),
      // The units contract; absent on legacy results, which render exactly as before.
      ...(result.columnsMeta?.length ? { columnsMeta: result.columnsMeta } : {}),
    },
    ...(candidate.sourceRef ? { certifiedBlockRef: candidate.sourceRef } : {}),
    ...(candidate.artifact !== undefined ? { dqlArtifact: candidate.artifact } : {}),
    proof: [...candidate.proof, ...(receipt.executed?.proofs ?? [])],
    ...common,
  };
  // An answer whose SQL the AI wrote from the schema is never headed as governed.
  const artifact: AgentRunArtifact = { id: `${runId}:answer`, kind: 'answer', title: certified ? 'Certified answer' : candidate.tier === 'exploratory' ? 'AI-drafted answer' : 'Governed answer', trustState, payload };
  return withReceipt({
    summary: outcome.text, answer: outcome.text, status: 'completed', trustState,
    stopReason: certified ? 'certified_answer_found' : 'governed_semantic_answer',
    resolvedRoute: certified ? 'certified_answer' : candidate.tier === 'semantic' ? 'semantic_answer' : 'generated_answer',
    answerTier: route.tier, result: payload.result, artifacts: [artifact],
    evaluations: [
      ...contextEvaluation(receipt),
      { id: 'pipeline-interpretation', label: 'Interpretation', passed: true, severity: 'info', message: `Read as: ${outcome.intent.reading || 'the intent below'}` },
      { id: 'pipeline-preparation', label: certified ? 'Certified entailment' : candidate.tier === 'semantic' ? 'Semantic compilation' : 'Governed composition', passed: true, severity: 'info', message: candidate.proof.join(' ') },
      ...(receipt.executed?.proofs ?? []).map((proof, index) => ({ id: `pipeline-execution-${index + 1}`, label: 'Execution proof', passed: true, severity: 'info' as const, message: proof })),
      // Words the reading does not use are never a passed check; the
      // evaluation carries no repair action, so it informs and does not loop.
      // A restriction the reading did not apply is a warning; a word it may
      // cover under another name is a question, never a claim of omission.
      ...coverageEvaluations(receipt),
      ...(receipt.grounding ?? []).filter((note) => note.startsWith('identity:') && /share the name/.test(note)).map((note, index) => ({ id: `pipeline-identity-${index + 1}`, label: 'Identity', passed: true, severity: 'warning' as const, message: note.slice('identity:'.length).trim() })),
      // A certified block served as published with a label-only grouping
      // says so: the answer cannot keep two same-named entities apart.
      ...(candidate.tier === 'certified' ? candidate.proof.filter((line) => /no identity key/.test(line)).map((line, index) => ({ id: `pipeline-certified-caveat-${index + 1}`, label: 'Certified block identity', passed: false, severity: 'warning' as const, message: `${line.replace(/^the block/, 'The block')}. Recertify it with the entity key to keep same-named members apart.` })) : []),
      // An answer that could not carry a requested output says so, and the
      // check does not pass: a ranking whose only identity is a numeric key
      // has not answered "which teams".
      ...(receipt.unmet ?? []).map((unmet, index) => ({ id: `pipeline-unmet-${index + 1}`, label: unmet.obligation === 'display_label' ? 'Requested identity' : 'Requested coverage', passed: false, severity: 'warning' as const, message: `${unmet.message.charAt(0).toUpperCase()}${unmet.message.slice(1)}.` })),
      // A certified block refused for identity is shown as source evidence
      // beside the keyed governed answer that replaced it.
      ...receipt.refusals.filter((refusal) => refusal.tier === 'certified' && /no identity key/.test(refusal.message)).map((refusal, index) => ({ id: `pipeline-certified-identity-${index + 1}`, label: 'Certified source, not applicable', passed: false, severity: 'warning' as const, message: `${refusal.message.replace(/^block:/, 'Block ')}. The answer is composed by entity key; recertify the block with the key column to serve it as certified.` })),
    ],
    nextActions: [
      ...((receipt.unmet ?? []).some((unmet) => unmet.obligation === 'display_label') ? [
        { id: 'declare-relationship', label: 'Declare the relationship that carries the label', route: 'modeling_draft' as const },
        // The label lives on another entity of the same thing: a concept draft can name that (A-005), for review, never certified by asking.
        { id: 'draft-concept', label: 'Draft a business concept for this identity', route: 'modeling_draft' as const },
      ] : []),
      ...(receipt.refusals.some((refusal) => refusal.tier === 'certified' && /no identity key/.test(refusal.message)) || (candidate.tier === 'certified' && candidate.proof.some((line) => /no identity key/.test(line))) ? [{ id: 'recertify-with-key', label: 'Recertify this block with the entity key', route: 'dql_block_draft' as const, artifactKind: 'dql_block_draft' as const }] : []),
      { id: 'create-block', label: 'Save as block', route: 'dql_block_draft', artifactKind: 'dql_block_draft' }, { id: 'research-gap', label: 'Research deeper', route: 'research' },
    ],
    telemetry,
  });
}
