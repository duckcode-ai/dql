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
  type PipelineReceipt,
  type VocabularySource,
  type PreparedBlock,
  type VocabularyEntry,
  renderPhysicalIdentifier,
  renderPhysicalRelation,
} from '@duckcodeailabs/dql-agent';
import { buildProjectVocabulary, buildVocabularySource, normalizeRelationName, type VocabularySourceInput } from './vocabulary-source.js';

/**
 * THE ASK PIPELINE HOST.
 *
 * Everything the host-neutral pipeline needs from the running server:
 * the vocabulary of the current snapshot, the configured provider, the
 * semantic compiler, the governed join graph, the warehouse, and the
 * conversation store. It returns an `AgentRouteExecutor`, so the engine
 * keeps owning the run lifecycle, artifacts, persistence and the UI shape.
 */

export interface AskPipelineHostDeps {
  projectRoot: string;
  executor: QueryExecutor;
  resolveConnection(request: AgentRunRequest): Promise<ConnectionConfig>;
  getSemanticLayer(): SemanticLayer | undefined;
  getManifest(): { manifest: DQLManifest | undefined; snapshotId: string };
  selectProvider(request: AgentRunRequest): Promise<AgentProvider | undefined>;
  /** Compile on the project's active semantic engine; throws with the engine's message. */
  compileSemantic(request: SemanticCompileRequest, connection: ConnectionConfig): Promise<SemanticCompileOutput>;
  /** The engine `compileSemantic` will use, known before preparation so the binder can speak its dialect. */
  semanticEngine?(): Promise<'native' | 'metricflow-cli' | 'dbt-cloud'>;
  /** Wrap one physical provider call in the run's dispatch ledger. */
  dispatchOptions?(purpose: 'resolve' | 'correct' | 'repair', request: AgentRunRequest): { options: ProviderRunOptions; settle(outcome: 'ok' | 'error' | 'cancelled', error?: unknown): void };
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
  buildIdentity?(): Record<string, string>;
  maxRows?: number;
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

/**
 * The information_schema lookup for a handful of NAMED relations: identifiers
 * only, a bounded predicate list, a row cap. It reads column names and types,
 * never row values, so it is a metadata point lookup rather than discovery.
 */
export function relationColumnsProbeSql(relations: string[], maxRelations = 8): string | undefined {
  const predicates: string[] = [];
  const seen = new Set<string>();
  for (const raw of relations) {
    const parts = raw.replace(/["`[\]]/g, '').trim().split('.').filter(Boolean);
    const table = parts.at(-1);
    const schema = parts.length >= 2 ? parts.at(-2) : undefined;
    if (!table || !IDENTIFIER.test(table) || (schema && !IDENTIFIER.test(schema))) continue;
    const key = `${schema ?? ''}.${table}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    predicates.push(schema
      ? `(LOWER(table_schema) = '${schema.toLowerCase()}' AND LOWER(table_name) = '${table.toLowerCase()}')`
      : `(LOWER(table_name) = '${table.toLowerCase()}')`);
    if (predicates.length >= maxRelations) break;
  }
  if (predicates.length === 0) return undefined;
  return [
    'SELECT table_schema, table_name, column_name, data_type',
    'FROM information_schema.columns',
    "WHERE UPPER(table_schema) NOT IN ('INFORMATION_SCHEMA', 'PG_CATALOG')",
    `  AND (${predicates.join(' OR ')})`,
    'ORDER BY table_schema, table_name, ordinal_position',
    'LIMIT 800',
  ].join('\n');
}

/**
 * A probed relation under the name the probe ASKED for: the warehouse spells
 * CONSUMPTION_METRICS.HEADER where the manifest says consumption_metrics.header,
 * and the vocabulary must merge the columns into the manifest's relation, not
 * add a second one. A relation nobody asked for keeps the warehouse's spelling.
 */
export function underAskedNames(found: ProbedRelation[], wanted: string[]): ProbedRelation[] {
  const asked = new Map(wanted.map((name) => [name.replace(/["`[\]]/g, '').toLowerCase(), name]));
  return found.map((relation) => {
    const key = (relation.schema ? `${relation.schema}.${relation.name}` : relation.name).toLowerCase();
    const original = asked.get(key) ?? [...asked.entries()].find(([candidate]) => candidate.endsWith(`.${key}`) || key.endsWith(`.${candidate}`))?.[1];
    if (!original) return relation;
    const parts = original.split('.');
    return { ...relation, name: parts.at(-1)!, ...(parts.length > 1 ? { schema: parts.slice(0, -1).join('.') } : {}) };
  });
}

/** Probe rows grouped into relations the vocabulary can merge. */
export function relationsFromProbeRows(rows: Array<Record<string, unknown>>): ProbedRelation[] {
  const byRelation = new Map<string, ProbedRelation>();
  for (const row of rows) {
    const record = Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]));
    const schema = typeof record.table_schema === 'string' ? record.table_schema : undefined;
    const name = typeof record.table_name === 'string' ? record.table_name : undefined;
    const column = typeof record.column_name === 'string' ? record.column_name : undefined;
    if (!name || !column) continue;
    const key = schema ? `${schema}.${name}` : name;
    const relation = byRelation.get(key) ?? { ...(schema ? { schema } : {}), name, columns: [] };
    relation.columns.push({ name: column, ...(typeof record.data_type === 'string' && record.data_type ? { dataType: record.data_type } : {}) });
    byRelation.set(key, relation);
  }
  return [...byRelation.values()];
}

/**
 * Relations the vocabulary knows by name but not by column: a table the
 * semantic layer or a dbt source references that no manifest documented, or
 * one documented without types. A partial description is not evidence that
 * the other columns are absent.
 */
/**
 * The database each dbt relation lives in, from the manifest's provenance
 * (`"DB"."SCHEMA"."TABLE"`), keyed by `schema.table` in lower case. The
 * vocabulary identifies a relation by schema and table; a warehouse that
 * addresses objects across databases (Snowflake) is written the full name.
 */
export function relationDatabases(manifest: { dbtProvenance?: { nodes: Record<string, { relation?: string }> } } | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const node of Object.values(manifest?.dbtProvenance?.nodes ?? {})) {
    const parts = (node.relation ?? '').replace(/["`]/g, '').split('.').map((part) => part.trim()).filter(Boolean);
    if (parts.length === 3) out.set(`${parts[1]}.${parts[2]}`.toLowerCase(), parts[0]!);
  }
  return out;
}

/** `schema.table` as the warehouse addresses it: with its database on Snowflake when provenance knows it; unchanged elsewhere. */
export function physicalRelationName(relation: string, databases: Map<string, string>, driver: string | undefined): string {
  if (driver?.toLowerCase() !== 'snowflake') return relation;
  const parts = relation.replace(/["`]/g, '').split('.');
  if (parts.length !== 2) return relation;
  const database = databases.get(relation.toLowerCase());
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
  const sparse = (relation: { columns: Array<{ name: string; dataType?: string }> }) => relation.columns.length < 4 || relation.columns.some((column) => !column.dataType);
  return (source.relations ?? [])
    .filter((relation) => sparse(relation))
    .map((relation) => (relation.schema ? `${relation.schema}.${relation.name}` : relation.name))
    .slice(0, max);
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
    const relation = entry?.physical?.relation;
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
      const relation = entry?.physical?.relation;
      const column = entry?.physical?.column;
      if (!entry || !relation || !column || !entry.roles.includes('label') || !deps.literalProbeAllowed!(relation, column)) continue;
      const owner = vocabulary.entries.find((candidate) => candidate.kind === 'entity' && candidate.model === entry.model && candidate.entityType === 'primary' && candidate.physical?.relation === relation && candidate.physical.column);
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
    const entry = inventory.get(ref) ?? inventory.resolve(ref);
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

  // The warehouse completes what the metadata left out. For every relation
  // the vocabulary names without columns or without types, one bounded
  // information_schema lookup fills them in, once per snapshot and
  // connection. A failure leaves the metadata as it was.
  const probedColumns = new Map<string, ProbedRelation[]>();
  const probeColumns = async (connection: ConnectionConfig | undefined, base: ReturnType<typeof buildVocabularySource>, snapshotId: string): Promise<ProbedRelation[]> => {
    if (!connection) return [];
    const cacheKey = `${snapshotId}|${connectionKey(connection)}`;
    const cached = probedColumns.get(cacheKey);
    if (cached) return cached;
    const wanted = relationsNeedingColumns(base);
    const found: ProbedRelation[] = [];
    // BOUNDED: an information_schema lookup on a large warehouse can take
    // seconds per statement; the probe stops issuing statements once its
    // budget is spent and the metadata stands as it was for the rest. What
    // it did not describe is asked for by name, never assumed absent.
    const started = Date.now();
    const budgetMs = columnProbeBudgetMs();
    for (let at = 0; at < wanted.length; at += 16) {
      if (Date.now() - started > budgetMs) break;
      const sql = relationColumnsProbeSql(wanted.slice(at, at + 16), 16);
      if (!sql) continue;
      try {
        const result = await deps.executor.executeQuery(sql, [], {}, connection);
        found.push(...relationsFromProbeRows((result.rows ?? []) as Array<Record<string, unknown>>));
      } catch { /* the metadata stands as it was */ }
    }
    const named = underAskedNames(found, wanted);
    probedColumns.set(cacheKey, named);
    return named;
  };
  type VocabularyView = { vocabulary: VocabularyIndex; context?: NonNullable<Parameters<typeof runAskPipeline>[0]['context']>; envelope: DomainContextEnvelope };
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
  /** The base source: everything the host can bind physically, per snapshot and connection. Cached; the pack projects it per request. */
  const baseSourceFor = async (connection?: ConnectionConfig): Promise<{ key: string; source: VocabularySource }> => {
    const { manifest, snapshotId } = deps.getManifest();
    const layer = deps.getSemanticLayer();
    const input: VocabularySourceInput = { ...(layer ? { semanticLayer: layer } : {}), ...(manifest ? { manifest } : {}), ...(connection?.driver ? { driver: connection.driver } : {}) };
    const key = `${snapshotId}|${layer ? layer.listCubes().map((cube) => cube.name).join(',') : 'no-semantic'}|${connection ? connectionKey(connection) : 'no-connection'}`;
    if (vocabularyCache?.key === key) return { key, source: vocabularyCache.source };
    const base = buildVocabularySource(input);
    const probed = await probeColumns(connection, base, snapshotId);
    const source = probed.length ? buildVocabularySource({ ...input, relations: probed }) : base;
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
  const vocabularyFor = async (request: AgentRunRequest, connection?: ConnectionConfig): Promise<VocabularyView> => {
    const envelope = resolveAskEnvelope(request);
    const { key, source: base } = await baseSourceFor(connection);
    let pack: LocalContextPack | undefined;
    try { pack = await deps.buildContextPack?.(request, envelope); } catch { pack = undefined; }
    if (!pack) {
      const vocabulary = buildVocabularyIndex(base);
      return { vocabulary, envelope, context: { envelope: ledgerEnvelope(envelope), admitted: { byKind: countKinds(vocabulary) } } };
    }
    const viewKey = vocabularyViewKey(key, envelope, pack);
    const projected = projectVocabularySource(base, pack, projectionScopeFor(envelope, deps.getManifest().manifest));
    const vocabulary = viewCache?.key === viewKey ? viewCache.view.vocabulary : buildVocabularyIndex(projected.source);
    const rankedRefs = rankedRefsFromPack(pack.objects);
    const lanes: Record<string, number> = {};
    for (const [lane, result] of Object.entries(pack.retrievalDiagnostics.fusion?.lanes ?? {})) lanes[lane] = result.returned;
    const relationsTotal = pack.eligible ? Object.entries(pack.eligible.counts).filter(([type]) => type === 'dbt_model' || type === 'dbt_source' || type === 'warehouse_table').reduce((sum, [, count]) => sum + count, 0) : (projected.source.relations?.length ?? 0);
    const relationsWithColumns = (projected.source.relations ?? []).filter((relation) => relation.columns.length > 0).length;
    const view: VocabularyView = {
      vocabulary, envelope,
      context: {
        packId: pack.id, snapshotId: envelope.snapshotId, envelope: ledgerEnvelope(envelope),
        retrieved: { lanes, fused: pack.retrievalDiagnostics.fusion?.selectedKeys.length ?? pack.objects.length },
        // Counted on the built index, so columns and the request overlay (skills, hints) are in the number the answer quotes.
        admitted: { byKind: countKinds(vocabulary), ...(Object.keys(projected.dropped).length ? { dropped: projected.dropped } : {}), ...(Object.keys(projected.unindexed).length ? { unindexed: projected.unindexed } : {}), ...(pack.eligible ? { eligibleFingerprint: pack.eligible.fingerprint } : {}) },
        rankedRefs, ...(projected.source.domain ? { header: projected.source.domain } : {}),
        columnsFor: { shown: relationsWithColumns, total: Math.max(relationsTotal, relationsWithColumns) },
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
  const prepareDeps = (connection: ConnectionConfig, vocabulary: VocabularyIndex, engine?: PrepareDeps['engine']): PrepareDeps => {
    const layer = deps.getSemanticLayer();
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
    const quoteRelation = (relation: string) => renderPhysicalRelation(physicalRelationName(relation, databases, connection.driver), connection.driver, (value) => dialect.quoteIdentifier(value));
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
      ...(layer ? { compileSemantic: (request) => deps.compileSemantic(request, connection) } : {}),
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
        const columnsOf = (relation: string): string[] => vocabulary.entries.find((entry) => entry.kind === 'relation' && entry.ref.endsWith(relation))?.columns ?? [];
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
            async (sql) => executor.executePositional!(sql, [], connection, { maxRows: 1 }).then((result) => ({ rows: result.rows as Array<Record<string, unknown>> })),
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
      blockSql: (ref) => vocabulary.get(ref)?.sql,
      prepareBlock: (ref, context) => prepareBlockForAsk(deps.projectRoot, vocabulary.get(ref), context, connection?.driver),
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
    const prior = request.threadId ? deps.priorIntent(request) : undefined;
    let engine: PrepareDeps['engine'];
    try { engine = await deps.semanticEngine?.(); } catch { engine = undefined; }
    // The context is assembled BEFORE the first model call; a run that ends
    // in this phase must show where its time went, so the assembly is an event.
    emit({ type: 'executor.started', message: `Context assembled in ${contextMs} ms: ${vocabulary.entries.length} governed objects${engine ? ` · semantic engine ${engine}` : ''}.`, route: 'generated_answer' });
    emit({ type: 'executor.started', message: prior ? 'Reading the question as an edit of the previous analysis.' : 'Reading the question against the governed vocabulary.', route: 'generated_answer' });
    const outcome = await runAskPipeline({
      question: request.question,
      vocabulary,
      provider: withLedger(provider, deps, request),
      prepareDeps: prepareDeps(connection ?? { driver: 'duckdb' } as ConnectionConfig, vocabulary, engine),
      executeDeps: {
        maxRows: deps.maxRows ?? 500,
        run: async (sql, params, options) => {
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
            result = typeof executor.executePositional === 'function'
              ? await executor.executePositional(sql, params ?? [], connection, { maxRows: options.maxRows })
              : await (async () => {
                if (params?.length) throw new Error('this warehouse executor cannot bind positional parameters');
                return executor.executeQuery(sql, [], {}, connection);
              })();
          } catch (error) {
            span?.finish('error', { safeErrorCode: 'sql_failure' });
            recordRelationEvidence(cacheKey, sql, classifyWarehouseError(error instanceof Error ? error.message : String(error)));
            throw error;
          }
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
      ...(connection && deps.probeLiteral && deps.literalProbeAllowed ? { groundLiterals: (intent: AnalyticalIntentV1) => groundIntentLiterals(intent, vocabulary, connection, tracedProbes(deps, request)) } : {}),
      // A name that matched nothing exactly may still name members of the same
      // column the query already read.
      suggestMembers: async (ref: string, literal: string) => {
        const entry = vocabulary.get(ref);
        const relation = entry?.physical?.relation;
        const column = entry?.physical?.column;
        if (!connection || !relation || !column || !entry || entry.roles.includes('time') || entry.roles.includes('numeric') || entry.roles.includes('boolean')) return [];
        const executor = deps.executor as QueryExecutor & { executePositional?: QueryExecutor['executePositional'] };
        if (typeof executor.executePositional !== 'function') return [];
        const sql = memberCandidatesSql(physicalRelationName(relation, relationDatabases(deps.getManifest().manifest), connection?.driver), column, (name) => renderPhysicalIdentifier(name, connection?.driver, (value) => `"${value.replace(/"/g, '""')}"`));
        const found = await executor.executePositional(sql, [`%${literal.toLowerCase()}%`], connection, { maxRows: 8 });
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
      // Room for one interpreter retry after a 90 s provider timeout plus the
      // rest of the turn; the engine's own hard deadline still wins.
      deadlineMs: 240_000,
      preparationCache,
      cacheScope: `${deps.getManifest().snapshotId}|${connection?.driver ?? 'none'}|${vocabulary.fingerprint}`,
      ...(deps.buildIdentity ? { build: deps.buildIdentity() } : {}),
      trace: (event) => emit({ type: 'executor.started', message: `${event.stage}${typeof event.detail === 'number' ? ` ${event.detail} ms` : ''}`, route: 'generated_answer' }),
    });
    // How long the context took to assemble, beside the stages the pipeline
    // timed itself: the receipt is the only place a latency claim can be read from.
    if ('receipt' in outcome && outcome.receipt) outcome.receipt.timings.context = contextMs;
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
      const explained = explainOutOfScopeWords(`${request.question} ${outcome.message}`, await baseIndexFor(connection), vocabulary, view.envelope);
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
        const text = await provider.generate(messages, { ...options, ...trace.options });
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
  return {
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
  const qualified = relation.split('.').map((part) => quote(part)).join('.');
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
const missingByConnection = new Map<string, Set<string>>();

/** A stable key for a connection: the account and database, never a credential. */
export function connectionKey(connection: ConnectionConfig): string {
  return [connection.driver, connection.account, connection.host, connection.port, connection.database ?? connection.catalog, connection.filepath, connection.schema]
    .filter((part) => part !== undefined && part !== '')
    .join('|');
}

/** Relation names as SQL writes them, lowercased and unquoted. */
function relationsInSql(sql: string): string[] {
  const found = new Set<string>();
  for (const match of sql.matchAll(/(?:FROM|JOIN)\s+((?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w$]*)){0,2})/gi)) {
    const name = (match[1] ?? '').replace(/["`[\]]/g, '').replace(/\s+/g, '').toLowerCase();
    if (name) found.add(name);
  }
  return [...found];
}

/** The tail of a qualified name, so dev.orders matches analytics.dev.orders. */
function relationTail(name: string): string {
  const parts = name.toLowerCase().replace(/["`[\]]/g, '').split('.');
  return parts.slice(-2).join('.');
}

/** The relation this query reads that the connection is already known to lack. */
export function knownMissingRelation(key: string, sql: string): string | undefined {
  const missing = missingByConnection.get(key);
  if (!missing || missing.size === 0) return undefined;
  const tails = new Map([...missing].map((name) => [relationTail(name), name]));
  for (const relation of relationsInSql(sql)) {
    const hit = tails.get(relationTail(relation));
    if (hit) return hit;
  }
  return undefined;
}

/** Record what a failed query proved about the connection, and what a successful one disproved. */
export function recordRelationEvidence(key: string, sql: string, failure?: { class: string; relations: string[] }): void {
  if (!failure) {
    const missing = missingByConnection.get(key);
    if (!missing) return;
    for (const relation of relationsInSql(sql)) {
      for (const name of [...missing]) if (relationTail(name) === relationTail(relation)) missing.delete(name);
    }
    return;
  }
  if (failure.class !== 'relation_missing') return;
  const named = failure.relations.length ? failure.relations : relationsInSql(sql);
  if (named.length !== 1) return;
  const missing = missingByConnection.get(key) ?? new Set<string>();
  missing.add(named[0]!);
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
  // A certified block served as published for a question it cannot answer
  // with identity is evidence: governed trust, the block as its source.
  const blockAsEvidence = candidate.tier === 'certified' && !certified;
  const route = certified ? { tier: 'certified_block', label: 'Certified block' } : blockAsEvidence ? { tier: 'certified_block', label: 'Certified block, served as evidence' } : candidate.tier === 'semantic' ? { tier: 'semantic_metric', label: 'Semantic metric' } : { tier: 'governed_relational', label: 'Governed relational program' };
  const trustState = certified ? 'certified' : 'governed';
  const payload = {
    kind: certified ? 'certified' : 'uncertified',
    route,
    sourceTier: certified || blockAsEvidence ? 'certified_artifact' : candidate.tier === 'semantic' ? 'semantic_layer' : 'dbt_manifest',
    certification: certified ? 'certified' : 'governed',
    reviewStatus: certified ? 'certified' : 'governed',
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
  const artifact: AgentRunArtifact = { id: `${runId}:answer`, kind: 'answer', title: certified ? 'Certified answer' : 'Governed answer', trustState, payload };
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
