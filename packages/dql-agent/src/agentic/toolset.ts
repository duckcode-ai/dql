/**
 * Stage-B semantic toolset.
 *
 * These tools are built from the answer-loop's own in-scope objects — the resolved
 * `SemanticLayer` and the `KGStore` — with NO dependency on the MCP DQLContext or
 * a live server, so the answer loop can hand them to the agentic tool loop
 * directly. They are the governed half of Stage B's tool surface (the host's
 * warehouse/validation tools — search_metadata, get_table_schema, validate_sql,
 * query_via_block — are merged in from `input.answerLoopTools`).
 *
 * Governance lives here, in the backends:
 *   - `compile_semantic_query` is the ONLY way to produce SQL the pipeline will
 *     label "governed": it runs `composeSemanticQueryFromMembers`, which validates
 *     every member against the layer and REFUSES hallucinated dimensions. The model
 *     never writes governed SQL itself.
 *   - `search_semantic_layer` / `scan_manifest` are read-only discovery.
 */

import type { SemanticLayer } from '@duckcodeailabs/dql-core';
import type { AgentToolDefinition } from '../providers/types.js';
import type { KGStore } from '../kg/sqlite-fts.js';
import type { KGNode, KGNodeKind } from '../kg/types.js';
import {
  composeSemanticQueryFromCompiledMembers,
  composeSemanticQueryFromMembers,
  type SemanticBridgeFilter,
  type SemanticBridgeOrderBy,
  type SemanticMemberSelection,
} from '../semantic-bridge/compose.js';

export interface SemanticStageToolsInput {
  semanticLayer?: SemanticLayer;
  kg: KGStore;
  driver?: string;
  tableMapping?: Record<string, string>;
  /** Host-owned dbt Cloud/MetricFlow compiler used when the native compiler cannot compose a member set. */
  semanticQueryCompiler?: (selection: SemanticMemberSelection) => Promise<{
    sql: string;
    engine: 'native' | 'metricflow-cli' | 'dbt-cloud';
    /** The compiler may add deterministic requirements such as metric_time. */
    selection?: SemanticMemberSelection;
  }>;
  /** Records the compiled result of the last successful compile_semantic_query call. */
  onCompiled?: (result: {
    sql: string;
    metrics: string[];
    dimensions: string[];
    dqlArtifactSource: string;
    engine?: 'native' | 'metricflow-cli' | 'dbt-cloud';
  }) => void;
}

const TOKEN_RE = /[\p{L}\p{N}_]+/gu;

/**
 * Build the governed Stage-B tools (semantic search, compile, manifest scan). When
 * no semantic layer is configured, the compile/search tools are omitted (there is
 * nothing to compile against) and only `scan_manifest` is returned.
 */
export function buildSemanticStageTools(input: SemanticStageToolsInput): AgentToolDefinition[] {
  const tools: AgentToolDefinition[] = [scanManifestTool(input.kg)];
  if (input.semanticLayer) {
    tools.unshift(searchSemanticLayerTool(input.semanticLayer));
    tools.push(compileSemanticQueryTool(input));
  }
  return tools;
}

function searchSemanticLayerTool(layer: SemanticLayer): AgentToolDefinition {
  return {
    name: 'search_semantic_layer',
    description:
      'Search the governed semantic layer for metrics and dimensions matching a question. Returns member NAMES to pass to compile_semantic_query, with labels, descriptions, and backing tables. Use this before compile_semantic_query.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Natural-language terms, e.g. "tax by region and product".' },
        limit: { type: 'number', description: 'Max members per kind. Default 8.' },
      },
    },
    run: async (args) => {
      const { query, limit } = objectArg(args);
      const terms = tokenizeQuery(typeof query === 'string' ? query : '');
      const max = typeof limit === 'number' && limit > 0 ? Math.min(limit, 25) : 8;
      const metrics = rankSemanticMembers(
        layer.listMetrics().map((m) => ({ name: m.name, label: m.label, description: m.description, table: m.table, tags: m.tags })),
        terms,
      ).slice(0, max);
      const dimensions = rankSemanticMembers(
        layer.listDimensions().map((d) => ({ name: d.name, label: d.label, description: d.description, table: d.table, tags: d.tags })),
        terms,
      ).slice(0, max);
      const timeDimensions = layer.listTimeDimensions().map((d) => ({ name: d.name, label: d.label, granularities: (d as { granularities?: string[] }).granularities }));
      return {
        metrics,
        dimensions,
        timeDimensions,
        note: metrics.length === 0 && dimensions.length === 0
          ? 'No semantic members matched. Try scan_manifest, or fall back to grounded SQL via search_metadata + get_table_schema.'
          : 'Pass member names to compile_semantic_query. The compiler owns the SQL and will refuse members that do not exist.',
      };
    },
  };
}

function compileSemanticQueryTool(input: SemanticStageToolsInput): AgentToolDefinition {
  const layer = input.semanticLayer!;
  return {
    name: 'compile_semantic_query',
    description:
      'Compile a governed SQL query from EXPLICIT semantic members (metrics + dimensions + optional time grain/filters). This is the governed path: the compiler validates every member and joins tables via the semantic graph. Prefer this over hand-written SQL whenever the semantic layer covers the question. Returns compiled SQL, or a refusal reason (e.g. a member that does not exist or an uncomposable metric×dimension pair) so you can adjust and retry.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['metrics'],
      properties: {
        metrics: { type: 'array', items: { type: 'string' }, description: 'Semantic metric names (from search_semantic_layer).' },
        dimensions: { type: 'array', items: { type: 'string' }, description: 'Semantic dimension names to group by.' },
        timeDimension: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'granularity'],
          properties: { name: { type: 'string' }, granularity: { type: 'string' } },
        },
        filters: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['dimension', 'operator', 'values'],
            properties: {
              dimension: { type: 'string' },
              operator: { type: 'string' },
              values: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        orderBy: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'direction'],
            properties: { name: { type: 'string' }, direction: { type: 'string', enum: ['asc', 'desc'] } },
          },
        },
        limit: { type: 'number' },
      },
    },
    run: async (args) => {
      const record = objectArg(args);
      const metrics = stringArray(record.metrics);
      if (metrics.length === 0) return { error: 'Provide at least one metric name.' };
      const selection: SemanticMemberSelection = {
        metrics,
        dimensions: stringArray(record.dimensions),
        timeDimension: parseTimeDimension(record.timeDimension),
        filters: parseFilters(record.filters),
        orderBy: parseOrderBy(record.orderBy),
        limit: typeof record.limit === 'number' ? record.limit : undefined,
      };
      let compiled = composeSemanticQueryFromMembers({
        semanticLayer: layer,
        question: typeof record.question === 'string' ? record.question : metrics.join(', '),
        selection,
        driver: input.driver,
        tableMapping: input.tableMapping,
      });
      let compiledEngine: 'native' | 'metricflow-cli' | 'dbt-cloud' = 'native';
      if (!compiled && input.semanticQueryCompiler) {
        try {
          const external = await input.semanticQueryCompiler(selection);
          compiledEngine = external.engine;
          compiled = composeSemanticQueryFromCompiledMembers({
            semanticLayer: layer,
            question: typeof record.question === 'string' ? record.question : metrics.join(', '),
            selection: external.selection ?? selection,
            sql: external.sql,
          });
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : String(error),
            runtimeRequired: true,
          };
        }
      }
      if (!compiled) {
        return {
          error:
            'The compiler could not produce governed SQL for these members. A member may not exist, or the metric×dimension pair may be uncomposable (unjoinable dimension, derived metric). Re-check names with search_semantic_layer, drop the offending dimension, or fall back to grounded SQL.',
        };
      }
      input.onCompiled?.({
        sql: compiled.sql,
        metrics: compiled.metrics,
        dimensions: compiled.dimensions,
        dqlArtifactSource: compiled.dqlArtifact.source,
        engine: compiledEngine,
      });
      return {
        governed: true,
        sql: compiled.sql,
        metrics: compiled.metrics,
        dimensions: compiled.dimensions,
        engine: compiledEngine,
        note: `Governed SQL compiled from the semantic layer through ${compiledEngine}. Use this SQL verbatim in your final answer; it is labeled governed.`,
      };
    },
  };
}

function scanManifestTool(kg: KGStore): AgentToolDefinition {
  return {
    name: 'scan_manifest',
    description:
      'Grep-style, index-independent scan over the live project graph (certified blocks, metrics, dimensions, dbt models). Returns objects whose name/description/context contains ALL query terms, then ANY. Use when FTS search misses or you want a fresh, ranking-free lookup.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Terms to scan for, e.g. "tax region product".' },
        kinds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional node-kind filter, e.g. ["block","metric","dimension","dbt_model"]. Default all.',
        },
        limit: { type: 'number', description: 'Max results. Default 20.' },
      },
    },
    run: async (args) => {
      const record = objectArg(args);
      const terms = tokenizeQuery(typeof record.query === 'string' ? record.query : '');
      const kinds = stringArray(record.kinds).filter(isKgNodeKind);
      const scanKinds: KGNodeKind[] = kinds.length > 0 ? kinds : ['block', 'metric', 'dimension', 'measure', 'entity', 'semantic_model', 'dbt_model', 'dbt_source', 'term', 'business_view'];
      const max = typeof record.limit === 'number' && record.limit > 0 ? Math.min(record.limit, 50) : 20;
      // Prefer the graph's ranked FTS path. The former first-500-per-kind scan
      // made a relevant metric/model invisible solely because it sorted late.
      const indexed = terms.length > 0
        ? kg.search({ query: typeof record.query === 'string' ? record.query : '', kinds: scanKinds, limit: max })
        : [];
      if (indexed.length > 0) {
        return {
          total: indexed.length,
          returned: indexed.length,
          objects: indexed.map((entry) => ({
            id: entry.node.nodeId,
            kind: entry.node.kind,
            name: entry.node.name,
            domain: entry.node.domain ?? null,
            status: entry.node.status ?? null,
            description: entry.node.description ?? null,
          })),
        };
      }
      // Index-independent repair remains available, but examines complete
      // compact node headers rather than an arbitrary alphabetical prefix.
      const nodes: KGNode[] = scanKinds.flatMap((kind) => kg.getNodesByKind(kind, 100_000));
      const scored = nodes
        .map((node) => {
          const haystack = `${node.name} ${node.description ?? ''} ${node.llmContext ?? ''} ${(node.tags ?? []).join(' ')}`.toLowerCase();
          const nameHay = node.name.toLowerCase();
          let matched = 0;
          let nameMatched = 0;
          for (const term of terms) {
            if (haystack.includes(term)) matched += 1;
            if (nameHay.includes(term)) nameMatched += 1;
          }
          return { node, matched, nameMatched };
        })
        .filter((entry) => terms.length === 0 || entry.matched > 0);
      const allTerms = scored.filter((entry) => entry.matched === terms.length);
      const pool = allTerms.length > 0 ? allTerms : scored;
      const results = pool
        .sort((a, b) => b.nameMatched - a.nameMatched || b.matched - a.matched || a.node.name.localeCompare(b.node.name))
        .slice(0, max)
        .map((entry) => ({
          id: entry.node.nodeId,
          kind: entry.node.kind,
          name: entry.node.name,
          domain: entry.node.domain ?? null,
          status: entry.node.status ?? null,
          description: entry.node.description ?? null,
        }));
      return { total: pool.length, returned: results.length, objects: results };
    },
  };
}

interface RankableMember {
  name: string;
  label?: string;
  description?: string;
  table?: string;
  tags?: string[];
}

function rankSemanticMembers(members: RankableMember[], terms: string[]): Array<{ name: string; label?: string; description?: string; table?: string }> {
  if (terms.length === 0) {
    return members.slice(0, 25).map((m) => ({ name: m.name, label: m.label, description: m.description, table: m.table }));
  }
  return members
    .map((member) => {
      const haystack = `${member.name} ${member.name.replace(/[_.]+/g, ' ')} ${member.label ?? ''} ${member.description ?? ''} ${(member.tags ?? []).join(' ')}`.toLowerCase();
      const name = `${member.name} ${member.name.replace(/[_.]+/g, ' ')}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (name.includes(term)) score += 3;
        else if (haystack.includes(term)) score += 1;
      }
      return { member, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.member.name.localeCompare(b.member.name))
    .map((entry) => ({ name: entry.member.name, label: entry.member.label, description: entry.member.description, table: entry.member.table }));
}

function tokenizeQuery(text: string): string[] {
  return Array.from(new Set((text.toLowerCase().match(TOKEN_RE) ?? []).filter((t) => t.length > 1)));
}

function objectArg(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

const KG_NODE_KINDS = new Set<KGNodeKind>([
  'block', 'term', 'business_view', 'metric', 'dimension', 'measure', 'entity',
  'model_area', 'semantic_model', 'saved_query', 'domain', 'dbt_model', 'dbt_source',
  'notebook', 'dashboard', 'app', 'skill', 'relationship', 'contract',
  'domain_export', 'domain_import', 'conformance', 'policy', 'evaluation',
]);

function isKgNodeKind(value: string): value is KGNodeKind {
  return KG_NODE_KINDS.has(value as KGNodeKind);
}

function parseTimeDimension(value: unknown): { name: string; granularity: string } | undefined {
  const record = objectArg(value);
  return typeof record.name === 'string' && typeof record.granularity === 'string'
    ? { name: record.name, granularity: record.granularity }
    : undefined;
}

function parseFilters(value: unknown): SemanticBridgeFilter[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((raw) => {
      const record = objectArg(raw);
      return typeof record.dimension === 'string'
        ? { dimension: record.dimension, operator: typeof record.operator === 'string' ? record.operator : 'equals', values: stringArray(record.values) }
        : undefined;
    })
    .filter((filter): filter is SemanticBridgeFilter => Boolean(filter && filter.values.length > 0));
}

function parseOrderBy(value: unknown): SemanticBridgeOrderBy[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((raw) => {
      const record = objectArg(raw);
      return typeof record.name === 'string'
        ? { name: record.name, direction: record.direction === 'asc' ? 'asc' as const : 'desc' as const }
        : undefined;
    })
    .filter((order): order is SemanticBridgeOrderBy => Boolean(order));
}
