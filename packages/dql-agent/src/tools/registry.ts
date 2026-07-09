export type DqlToolSurface = 'mcp' | 'mcp_agentic' | 'native' | 'claude_code' | 'answer_loop';

export type JsonSchema = Record<string, unknown>;

export type DqlToolName =
  | 'ask_dql'
  | 'query_semantic_model'
  | 'kg_search'
  | 'search_blocks'
  | 'get_block'
  | 'query_via_block'
  | 'inspect_metadata_context'
  | 'expand_context'
  | 'query_via_metadata'
  | 'answer_question'
  | 'build_block_from_prompt'
  | 'list_metrics'
  | 'list_dimensions'
  | 'lineage_impact'
  | 'certify'
  | 'suggest_block'
  | 'search_metadata'
  | 'get_table_schema'
  | 'validate_sql'
  | 'inspect_dql_project'
  | 'build_dql_block'
  | 'build_dql_app'
  | 'list_proposals'
  | 'feedback_record'
  | 'record_correction'
  | 'approve_hint'
  | 'list_hints';

export interface DqlToolDefinition {
  name: DqlToolName;
  description: string;
  inputSchema: JsonSchema;
  surfaces: readonly DqlToolSurface[];
}

const BLOCK_STATUS_ENUM = ['draft', 'review', 'certified', 'deprecated', 'pending_recertification'] as const;

const KG_KIND_ENUM = [
  'block',
  'term',
  'business_view',
  'metric',
  'dimension',
  'measure',
  'entity',
  'semantic_model',
  'saved_query',
  'domain',
  'dbt_model',
  'dbt_source',
  'notebook',
  'dashboard',
  'app',
  'skill',
] as const;

const RESEARCH_INTENT_ENUM = [
  'diagnose_change',
  'driver_breakdown',
  'segment_compare',
  'entity_drilldown',
  'anomaly_investigation',
  'trust_gap_review',
] as const;

const HINT_STATUS_ENUM = ['candidate', 'approved', 'rejected'] as const;

const DOMAIN_FILTER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    domain: { type: 'string', description: 'Filter to a single domain.' },
  },
} as const satisfies JsonSchema;

const HINT_SCOPE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    metric: { type: 'string', description: 'Metric or KPI the hint is about.' },
    dbtModel: { type: 'string', description: 'dbt model the hint is about.' },
    domain: { type: 'string', description: 'Business domain the hint applies within.' },
    dialect: { type: 'string', description: 'Warehouse SQL dialect the hint applies within.' },
    term: { type: 'string', description: 'Business term the hint refines.' },
    block: { type: 'string', description: 'Certified block the hint relates to.' },
  },
} as const satisfies JsonSchema;

const PRIOR_RESULT_REFERENCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'columns'],
  properties: {
    id: { type: 'string', description: 'Stable id of the prior result set or conversation turn.' },
    question: { type: 'string', description: 'Prior user question that produced the referenced result.' },
    columns: {
      type: 'array',
      items: { type: 'string' },
      description: 'Column names present in the prior result.',
    },
    rowCount: { type: 'number', description: 'Number of rows in the prior result, when known.' },
    sourceSql: { type: 'string', description: 'SQL that produced the prior result, when available. Used only for grounding.' },
  },
} as const satisfies JsonSchema;

const DQL_ARTIFACT_REFERENCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'source'],
  properties: {
    kind: { type: 'string', enum: ['certified_block', 'semantic_block', 'sql_block'] },
    source: { type: 'string', description: 'DQL artifact source text used for the prior result.' },
    name: { type: 'string' },
    sourcePath: { type: 'string' },
    metrics: { type: 'array', items: { type: 'string' } },
    dimensions: { type: 'array', items: { type: 'string' } },
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
    timeDimension: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'granularity'],
      properties: {
        name: { type: 'string' },
        granularity: { type: 'string' },
      },
    },
    orderBy: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'direction'],
        properties: {
          name: { type: 'string' },
          direction: { type: 'string', enum: ['asc', 'desc'] },
        },
      },
    },
    limit: { type: 'number' },
  },
} as const satisfies JsonSchema;

const CORE_TOOL_DEFINITIONS = [
  {
    name: 'ask_dql',
    description:
      'High-level governed ask router. Use first for business questions. Returns certified-vs-generated route, contextPackId, exact block candidate, allowed SQL context, missing context, trust status, and next safe DQL tool.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['question'],
      properties: {
        question: { type: 'string', description: 'Business or analytics question to route through governed DQL context.' },
        focusObjectKey: { type: 'string', description: 'Optional metadata object key to bias retrieval.' },
        limit: { type: 'number', description: 'Maximum metadata objects in the context pack. Default 100.' },
      },
    },
    surfaces: ['mcp', 'mcp_agentic', 'native', 'claude_code', 'answer_loop'],
  },
  {
    name: 'query_semantic_model',
    description:
      'Semantic-layer compiler and bounded preview runner. Use after ask_dql when a governed metric/dimension/time-grain selection can answer the question before deep dbt/warehouse SQL search. Accepts explicit semantic members or a question, returns selected members, compiled SQL, bounded preview rows when runtime execution is available, and a reviewable DQL semantic artifact.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        question: {
          type: 'string',
          description: 'Business question to map to semantic-layer members when metrics are not supplied explicitly.',
        },
        metrics: {
          type: 'array',
          items: { type: 'string' },
          description: 'Semantic metric names to compile. When supplied, these are used directly instead of question-based member selection.',
        },
        dimensions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Semantic dimensions to group by.',
        },
        timeDimension: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'granularity'],
          properties: {
            name: { type: 'string' },
            granularity: { type: 'string' },
          },
          description: 'Optional semantic time dimension and granularity such as {name:"order_date", granularity:"month"}.',
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
          description: 'Optional semantic filters to compile through the semantic layer.',
        },
        orderBy: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'direction'],
            properties: {
              name: { type: 'string' },
              direction: { type: 'string', enum: ['asc', 'desc'] },
            },
          },
          description: 'Optional semantic order by clauses.',
        },
        limit: {
          type: 'number',
          description: 'Optional result limit for the compiled semantic query.',
        },
        rowLimit: {
          type: 'number',
          description: 'Maximum rows returned from bounded preview execution. Default 200. Does not change the semantic query limit.',
        },
        saveDraft: {
          type: 'boolean',
          description: 'Persist the generated semantic DQL artifact to blocks/_drafts for review. Default true.',
        },
        dryRun: {
          type: 'boolean',
          description: 'Return the semantic DQL artifact and compiled SQL without runtime execution. Default false.',
        },
        serverUrl: {
          type: 'string',
          description: 'Base URL of the local DQL runtime for preview execution. Default http://127.0.0.1:3474.',
        },
        driver: {
          type: 'string',
          description: 'Optional SQL driver/dialect hint, such as duckdb, snowflake, bigquery, or postgres.',
        },
        tableMapping: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Optional mapping from semantic table names to physical database relations.',
        },
      },
    },
    surfaces: ['mcp', 'mcp_agentic', 'native', 'claude_code', 'answer_loop'],
  },
  {
    name: 'kg_search',
    description:
      'Search the DQL knowledge graph across business terms, business views, blocks, apps, dashboards, notebooks, semantic objects, and dbt/source metadata.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Natural-language or keyword query.' },
        kinds: {
          type: 'array',
          items: { type: 'string', enum: KG_KIND_ENUM },
          description: 'Optional KG node-kind filter.',
        },
        domain: { type: 'string', description: 'Filter to a single business domain.' },
        limit: { type: 'number', description: 'Max hits. Default 10.' },
      },
    },
    surfaces: ['mcp', 'mcp_agentic', 'native', 'claude_code', 'answer_loop'],
  },
  {
    name: 'search_blocks',
    description: 'Find certified DQL blocks by keyword, domain, or status.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Substring matched against name, description, or tags.' },
        domain: { type: 'string', description: 'Filter to a single business domain.' },
        status: { type: 'string', enum: BLOCK_STATUS_ENUM, description: 'Filter by certification status.' },
        limit: { type: 'number', description: 'Max results. Default 50.' },
      },
    },
    surfaces: ['mcp', 'mcp_agentic', 'native', 'claude_code', 'answer_loop'],
  },
  {
    name: 'get_block',
    description: 'Return full metadata, dependencies, and SQL for a block.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Block name as shown in search_blocks.' },
        includeSource: { type: 'boolean', description: 'Include full .dql source text. Default true.' },
      },
    },
    surfaces: ['mcp', 'mcp_agentic', 'native', 'claude_code', 'answer_loop'],
  },
  {
    name: 'query_via_block',
    description:
      'Tier-1 of graduated trust. Execute a certified block against the local DQL runtime when the block grain exactly answers the user question. For named-entity filters, custom rankings, breakdowns, comparisons, or drill-throughs, use the block as context and call query_via_metadata instead.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Certified block to execute.' },
        limit: { type: 'number', description: 'Max rows to return. Default 200.' },
        question: {
          type: 'string',
          description: 'Original question. Enables a defense-in-depth grain gate before serving the block.',
        },
        serverUrl: {
          type: 'string',
          description: 'Base URL of the local DQL runtime. Default http://127.0.0.1:3474.',
        },
      },
    },
    surfaces: ['mcp', 'mcp_agentic', 'native', 'claude_code', 'answer_loop'],
  },
  {
    name: 'inspect_metadata_context',
    description:
      'Build the local SQLite metadata context pack for a question. Use before Tier-2 SQL generation to inspect certified blocks, semantic metrics, DQL terms/views, dbt/warehouse objects, lineage edges, diagnostics, selected evidence, rejected candidates, and trust labels.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['question'],
      properties: {
        question: { type: 'string', description: 'User question to ground in the local SQLite metadata catalog.' },
        focusObjectKey: { type: 'string', description: 'Optional object key, such as dql:block:Revenue or semantic:metric:revenue.' },
        objectTypes: { type: 'array', items: { type: 'string' }, description: 'Optional metadata object type filter.' },
        limit: { type: 'number', description: 'Maximum selected objects in the context pack. Default 100.' },
        strictness: {
          type: 'string',
          enum: ['balanced', 'exploratory'],
          description: 'Retrieval depth. Use exploratory for deep research; it widens context when limit is omitted.',
        },
      },
    },
    surfaces: ['mcp', 'mcp_agentic', 'native', 'claude_code', 'answer_loop'],
  },
  {
    name: 'query_via_metadata',
    description:
      'Tier-2 of graduated trust. Use when no certified block exactly answers the requested grain, including named filters, rankings, breakdowns, comparisons, anomalies, and drill-throughs. Call inspect_metadata_context first and pass its contextPackId. If proposedSql is omitted, this returns the catalog route plan and allowed SQL context. If proposedSql is supplied, it must be one read-only SELECT/WITH query using only inspected relations/columns. The runtime executes a bounded preview, returns uncertified trust evidence, and saves a reviewable DQL draft.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['question'],
      properties: {
        question: { type: 'string', description: 'The user question being answered, verbatim.' },
        proposedSql: { type: 'string', description: 'Read-only SELECT/WITH SQL inferred from inspected metadata context.' },
        contextPackId: { type: 'string', description: 'Context-pack id returned by inspect_metadata_context.' },
        intent: { type: 'string', enum: RESEARCH_INTENT_ENUM, description: 'Optional deep-research intent.' },
        upstreamRefs: { type: 'array', items: { type: 'string' }, description: 'Tables or blocks involved in the proposed SQL.' },
        outputs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Declared output column names returned by the proposed SQL and written into the DQL draft.',
        },
        followUp: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['generic', 'drilldown', 'contextual'] },
            sourceBlockName: { type: 'string' },
            sourceQuestion: { type: 'string' },
            sourceAnswer: { type: 'string' },
            filters: { type: 'array', items: { type: 'string' } },
            dimensions: { type: 'array', items: { type: 'string' } },
            priorResultColumns: { type: 'array', items: { type: 'string' } },
            priorResultValues: {
              type: 'object',
              additionalProperties: { type: 'array', items: { type: 'string' } },
            },
            priorResultRef: PRIOR_RESULT_REFERENCE_SCHEMA,
            priorDqlArtifact: DQL_ARTIFACT_REFERENCE_SCHEMA,
            priorLimit: { type: 'number' },
            priorMeasures: { type: 'array', items: { type: 'string' } },
          },
        },
        proposedDomain: { type: 'string', description: 'Best guess at the DataLex domain that owns this question.' },
        proposedEntity: { type: 'string', description: 'Best guess at the owning entity, such as Customer.' },
        saveDraft: { type: 'boolean', description: 'Persist a draft .dql file. Default true.' },
        dryRun: { type: 'boolean', description: 'Return proposal only without execution. Default false.' },
        regroundAttemptsUsed: {
          type: 'number',
          description: 'Number of expand_context re-ground attempts already used for this query. Pass 1 when retrying with an expanded context pack.',
        },
        limit: { type: 'number', description: 'Max rows to return on execution.' },
        serverUrl: { type: 'string', description: 'Base URL of the local DQL runtime. Default http://127.0.0.1:3474.' },
      },
    },
    surfaces: ['mcp', 'mcp_agentic', 'native', 'claude_code', 'answer_loop'],
  },
  {
    name: 'expand_context',
    description:
      'Repair-loop context expander. Use after inspect_metadata_context or query_via_metadata reports an allowed-context gap for a known catalog/runtime relation. It creates a new contextPackId with the requested relation(s), so the agent can retry query_via_metadata without starting over or inventing uninspected SQL.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['contextPackId', 'relations'],
      properties: {
        contextPackId: {
          type: 'string',
          description: 'Existing context-pack id returned by ask_dql or inspect_metadata_context.',
        },
        relations: {
          type: 'array',
          minItems: 1,
          maxItems: 16,
          items: { type: 'string' },
          description: 'Relations to add to the context pack, such as dev.supplies or SHOP.ANALYTICS.supplies.',
        },
        question: {
          type: 'string',
          description: 'Optional refined question used in expansion notes. Defaults to the original context-pack question.',
        },
      },
    },
    surfaces: ['mcp', 'mcp_agentic', 'native', 'claude_code', 'answer_loop'],
  },
  {
    name: 'answer_question',
    description:
      "Governed one-shot answer. Runs DQL's OWN governed cascade (certified block → semantic metric → generated SQL) end-to-end and returns the executed answer with rows, SQL preview, canonical trust label, citations, and a reviewable draft — the SAME engine and trust guards as the DQL UI. Use this when you want DQL to generate AND answer for you. Prefer query_via_metadata when you want to author the SQL yourself. Requires the DQL runtime (`dql serve`).",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['question'],
      properties: {
        question: { type: 'string', description: 'Business or analytics question to answer.' },
        audience: { type: 'string', enum: ['analyst', 'stakeholder'], description: 'Answer audience. Default analyst.' },
        requestedMode: { type: 'string', enum: ['auto', 'ask', 'research'], description: 'Routing mode. Default auto (let the cascade decide).' },
        reasoningEffort: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Optional model effort (host ceilings still apply).' },
        analysisDepth: { type: 'string', enum: ['quick', 'deep'], description: 'Optional retrieval/analysis depth.' },
        threadId: { type: 'string', description: 'Continue a persisted conversation thread.' },
        serverUrl: { type: 'string', description: 'Base URL of the local DQL runtime. Default http://127.0.0.1:3474.' },
      },
    },
    surfaces: ['mcp', 'mcp_agentic'],
  },
  {
    name: 'build_block_from_prompt',
    description:
      "Governed block builder from a natural-language prompt. Runs DQL's buildFromPrompt (the same governed engine the UI uses) to draft a reusable, review-required DQL block — you do NOT author SQL. Symmetric with build_dql_app. Returns the draft path, dqlArtifact source, and the Certifier verdict; NEVER auto-certifies. Requires the DQL runtime (`dql serve`).",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'What the block should compute, e.g. "weekly revenue by region".' },
        mode: { type: 'string', enum: ['create', 'edit'], description: 'Create a new draft, or edit an existing block in place. Default create.' },
        blockPath: { type: 'string', description: 'Required for mode=edit: the block file to modify.' },
        owner: { type: 'string', description: 'Owner identity to stamp on the draft.' },
        serverUrl: { type: 'string', description: 'Base URL of the local DQL runtime. Default http://127.0.0.1:3474.' },
      },
    },
    surfaces: ['mcp', 'mcp_agentic'],
  },
  {
    name: 'list_metrics',
    description: 'List semantic-layer metrics, optionally filtered by domain.',
    inputSchema: DOMAIN_FILTER_SCHEMA,
    surfaces: ['mcp'],
  },
  {
    name: 'list_dimensions',
    description: 'List semantic-layer dimensions, optionally filtered by domain.',
    inputSchema: DOMAIN_FILTER_SCHEMA,
    surfaces: ['mcp'],
  },
  {
    name: 'lineage_impact',
    description: 'Return upstream/downstream lineage for a block, metric, or model.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['focus'],
      properties: {
        focus: { type: 'string', description: 'Node id, such as block:revenue, or a bare name.' },
        upstreamDepth: { type: 'number' },
        downstreamDepth: { type: 'number' },
        nodeLimit: { type: 'number', description: 'Maximum lineage nodes to return. Default 80.' },
        edgeLimit: { type: 'number', description: 'Maximum lineage edges to return. Default 120.' },
        pathLimit: {
          type: 'number',
          description: 'Maximum complete paths per direction when paths=true. Default 20.',
        },
        paths: { type: 'boolean', description: 'Include full source-to-leaf paths.' },
        recert: { type: 'boolean', description: 'Return re-certification impact for a changed block.' },
        nonSemantic: { type: 'boolean', description: 'With recert, treat the change as non-semantic.' },
      },
    },
    surfaces: ['mcp', 'mcp_agentic', 'native', 'claude_code', 'answer_loop'],
  },
  {
    name: 'certify',
    description: 'Run governance rules against a block and report pass/fail.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Block name to evaluate.' },
      },
    },
    surfaces: ['mcp', 'mcp_agentic', 'native', 'claude_code'],
  },
  {
    name: 'suggest_block',
    description:
      'Write a curated proposed block to the local draft queue with a hand-shaped name and structure, plus the governance gate result. Use when proposing a shared building block; for one-shot ad-hoc Tier-2 captures, use query_via_metadata instead.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'domain', 'owner', 'description', 'sql'],
      properties: {
        name: { type: 'string', description: 'Proposed block name.' },
        domain: { type: 'string', description: 'Business domain.' },
        owner: { type: 'string', description: 'Block owner identity.' },
        description: { type: 'string', description: 'One-line description.' },
        sql: { type: 'string', description: 'The block body SQL.' },
        tags: { type: 'array', items: { type: 'string' } },
        chartType: { type: 'string', description: 'Optional visualization type.' },
      },
    },
    surfaces: ['mcp', 'mcp_agentic', 'native', 'claude_code'],
  },
  {
    name: 'search_metadata',
    description:
      'Grounded-SQL retrieval: rank dbt tables relevant to a request and return each table qualified relation and ref form. Use before writing SQL so you reference the real relation, never a bare model name.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Natural-language request to find relevant tables for.' },
        limit: { type: 'number', description: 'Max tables to return. Default 12.' },
      },
    },
    surfaces: ['mcp', 'native', 'answer_loop'],
  },
  {
    name: 'get_table_schema',
    description:
      'Return the qualified relation, ref form, real columns and types, and inferred join keys for a dbt table by model name, alias, or qualified relation.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['table'],
      properties: {
        table: { type: 'string', description: 'Model name, alias, or qualified relation.' },
      },
    },
    surfaces: ['mcp', 'native', 'answer_loop'],
  },
  {
    name: 'validate_sql',
    description:
      'Validate that a read-only SELECT/WITH query references only relations and columns that exist in the dbt schema. Returns the precise offending table or column on a miss.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sql'],
      properties: {
        sql: { type: 'string', description: 'A read-only SELECT/WITH query to validate against the dbt schema.' },
        query: { type: 'string', description: 'Optional original request, used to scope grounding.' },
      },
    },
    surfaces: ['mcp', 'native', 'answer_loop'],
  },
  {
    name: 'inspect_dql_project',
    description:
      'Front-door project health/context tool for MCP clients. Refreshes metadata/index by default and returns block, app, dashboard, semantic, catalog, and recommended-next-step status.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        refresh: { type: 'boolean', description: 'Refresh metadata and agent index before returning status. Default true.' },
      },
    },
    surfaces: ['mcp', 'mcp_agentic'],
  },
  {
    name: 'build_dql_block',
    description:
      'High-level draft-block tool. Writes a proposed block to the local draft queue with governance results. Does not certify automatically.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'domain', 'owner', 'description', 'sql'],
      properties: {
        name: { type: 'string', description: 'Proposed block name.' },
        domain: { type: 'string', description: 'Business domain.' },
        owner: { type: 'string', description: 'Block owner identity.' },
        description: { type: 'string', description: 'One-line description.' },
        sql: { type: 'string', description: 'The block body SQL.' },
        tags: { type: 'array', items: { type: 'string' } },
        chartType: { type: 'string', description: 'Optional visualization type.' },
      },
    },
    surfaces: ['mcp'],
  },
  {
    name: 'build_dql_app',
    description:
      'High-level app builder. Creates or plans a governed DQL app draft from a prompt using certified tiles first and review-only placeholders for missing evidence.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'App outcome request.' },
        domain: { type: 'string', description: 'Optional business domain to prioritize.' },
        owner: { type: 'string', description: 'Owner identity to store on the generated app.' },
        aiLayout: { type: 'boolean', description: 'Store richer dynamic GenUI layout metadata.' },
        saveDraft: { type: 'boolean', description: 'Write app draft files. Default true.' },
        overwrite: { type: 'boolean', description: 'Overwrite an existing app folder. Default false.' },
      },
    },
    surfaces: ['mcp'],
  },
  {
    name: 'list_proposals',
    description:
      'List Tier-2 block drafts, semantic metric drafts, and semantic recertification proposals ordered by askedTimes DESC. Use this to prioritize recurring questions and composted metrics for certification.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        askedAtLeastTimes: {
          type: 'number',
          description: 'Filter to drafts asked at least N times. Default 1.',
        },
        since: {
          type: 'string',
          description: 'ISO 8601 timestamp; only return drafts whose last_asked is on or after this.',
        },
      },
    },
    surfaces: ['mcp'],
  },
  {
    name: 'feedback_record',
    description:
      'Record thumbs-up/down feedback on an answer. Feedback feeds promotion signals and answer-quality review; it never upgrades generated output to certified.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['user', 'question', 'answerKind', 'rating'],
      properties: {
        user: { type: 'string', description: 'User who submitted the feedback.' },
        question: { type: 'string', description: 'Original question.' },
        answerKind: { type: 'string', enum: ['certified', 'uncertified'], description: 'How the answer was classified.' },
        blockId: { type: 'string', description: 'Block id the answer was anchored to, if any.' },
        rating: { type: 'string', enum: ['up', 'down'], description: 'Thumbs up or down.' },
        comment: { type: 'string', description: 'Optional free-text rationale.' },
      },
    },
    surfaces: ['mcp'],
  },
  {
    name: 'record_correction',
    description:
      'Capture an analyst correction of a Tier-2 generated answer as a scoped, Git-versioned candidate hint. The hint is not used until approved.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['question', 'wrongAnswer', 'correction', 'scope'],
      properties: {
        question: { type: 'string', description: 'The analyst question the Tier-2 answer was for.' },
        wrongAnswer: { type: 'string', description: 'The generated answer or SQL that was wrong.' },
        correction: { type: 'string', description: 'The analyst correction: corrected SQL, rule, or guidance.' },
        scope: HINT_SCOPE_SCHEMA,
        rationale: { type: 'string', description: 'Why the original answer was wrong.' },
        author: { type: 'string', description: 'Who recorded the correction.' },
        correctedSql: { type: 'string', description: 'Optional canonical corrected SQL to endorse.' },
        hintTitle: { type: 'string', description: 'Override the derived hint title.' },
        hintGuidance: { type: 'string', description: 'Override the hint guidance.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Searchable keywords.' },
        anchorObjectKey: { type: 'string', description: 'Context pack, block, or object id the correction anchored to.' },
      },
    },
    surfaces: ['mcp'],
  },
  {
    name: 'approve_hint',
    description:
      'Approve or reject a candidate correction hint. Approval is the only path that makes a scoped hint usable in future Tier-2 drafts.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['hintId', 'decision', 'reviewer'],
      properties: {
        hintId: { type: 'string', description: 'Id of the candidate hint to review.' },
        decision: { type: 'string', enum: ['approved', 'rejected'], description: 'Approve or reject the candidate hint.' },
        reviewer: { type: 'string', description: 'Who is reviewing.' },
        note: { type: 'string', description: 'Optional review note.' },
      },
    },
    surfaces: ['mcp'],
  },
  {
    name: 'list_hints',
    description:
      'List scoped correction hints, optionally filtered by lifecycle status, domain, or metric. Approved hints are folded into future Tier-2 drafts after certified routing.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: HINT_STATUS_ENUM, description: 'Filter by lifecycle status.' },
        domain: { type: 'string', description: 'Filter to a single domain scope.' },
        metric: { type: 'string', description: 'Filter to a single metric scope.' },
      },
    },
    surfaces: ['mcp'],
  },
] as const satisfies readonly DqlToolDefinition[];

export const DQL_TOOL_REGISTRY: readonly DqlToolDefinition[] = CORE_TOOL_DEFINITIONS;

export function getDqlToolDefinition(name: DqlToolName): DqlToolDefinition {
  const definition = DQL_TOOL_REGISTRY.find((tool) => tool.name === name);
  if (!definition) throw new Error(`Unknown DQL tool definition: ${name}`);
  return definition;
}

export function dqlToolDefinitionsForSurface(surface: DqlToolSurface): DqlToolDefinition[] {
  return DQL_TOOL_REGISTRY.filter((tool) => tool.surfaces.includes(surface));
}

export function dqlToolNamesForSurface(surface: DqlToolSurface): DqlToolName[] {
  return dqlToolDefinitionsForSurface(surface).map((tool) => tool.name);
}

export function dqlMcpToolNamesForSurface(surface: DqlToolSurface, prefix = 'mcp__dql__'): string[] {
  return dqlToolNamesForSurface(surface).map((name) => `${prefix}${name}`);
}
