import { DQLContext } from '@duckcodeailabs/dql-mcp';
import type { KGNode } from '@duckcodeailabs/dql-agent';
import type { AgentRunRequest, AgentTurn, BlockProposal } from './types.js';
import { buildAgentTools, type AgentTool } from './tools.js';

const QUERY_CERTIFIED_BLOCK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', description: 'Certified DQL block name to execute.' },
    limit: { type: 'number', description: 'Maximum rows to return in the tool result. Default 200.' },
  },
} as const;

const INSPECT_RUNTIME_SCHEMA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['question'],
  properties: {
    question: { type: 'string', description: 'The user question or analytical task to inspect schema for.' },
  },
} as const;

const EXECUTE_GENERATED_SQL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sql'],
  properties: {
    sql: {
      type: 'string',
      description: 'Read-only SQL to execute as a bounded, uncertified preview. DQL will add safety limits.',
    },
  },
} as const;

export function buildAnalyticsAgentTools(ctx: DQLContext, req: AgentRunRequest): AgentTool[] {
  return [
    ...buildAgentTools(ctx),
    {
      name: 'query_certified_block',
      description:
        'Execute a certified DQL block by name through the local governed runtime. ' +
        'Use this when a certified block exactly answers the question.',
      inputSchema: QUERY_CERTIFIED_BLOCK_SCHEMA,
      run: async (args) => {
        if (!req.executeCertifiedBlock) {
          return { error: 'Certified block execution is not available in this host.' };
        }
        const input = objectArgs(args);
        const name = requiredString(input.name, 'name');
        const result = await req.executeCertifiedBlock(blockNodeFor(name));
        const limit = typeof input.limit === 'number' && Number.isFinite(input.limit)
          ? Math.max(1, Math.min(10000, Math.floor(input.limit)))
          : 200;
        return {
          trust: 'certified',
          block: name,
          rowCount: result.rowCount,
          executionTime: result.executionTime,
          columns: result.columns,
          rows: Array.isArray(result.rows) ? result.rows.slice(0, limit) : [],
          sql: result.sql,
          chartConfig: result.chartConfig,
          blockPath: result.blockPath,
        };
      },
    },
    {
      name: 'inspect_runtime_schema',
      description:
        'Inspect runtime table and column context for an arbitrary analytics question. ' +
        'Use this before writing new SQL when no certified block directly answers the question.',
      inputSchema: INSPECT_RUNTIME_SCHEMA_SCHEMA,
      run: async (args) => {
        if (!req.getSchemaContext) {
          return { error: 'Runtime schema inspection is not available in this host.' };
        }
        const input = objectArgs(args);
        const question = requiredString(input.question, 'question');
        const tables = await req.getSchemaContext(question);
        return {
          question,
          tables: tables.slice(0, 24),
          tableCount: tables.length,
        };
      },
    },
    {
      name: 'execute_generated_sql',
      description:
        'Execute generated SQL as a bounded, uncertified preview. ' +
        'Use only after inspecting DQL/DBT/semantic context and only for read-only SELECT/WITH analysis.',
      inputSchema: EXECUTE_GENERATED_SQL_SCHEMA,
      run: async (args) => {
        if (!req.executeGeneratedSql) {
          return { error: 'Generated SQL preview execution is not available in this host.' };
        }
        const input = objectArgs(args);
        const sql = requiredString(input.sql, 'sql');
        const result = await req.executeGeneratedSql(sql);
        return {
          trust: 'uncertified',
          reviewStatus: 'draft_ready',
          warning: 'Generated SQL results are a preview and require analyst review before certification.',
          rowCount: result.rowCount,
          executionTime: result.executionTime,
          columns: result.columns,
          rows: Array.isArray(result.rows) ? result.rows.slice(0, 200) : [],
          sql: result.sql ?? sql,
          chartConfig: result.chartConfig,
        };
      },
    },
  ];
}

export function analyticsSystemPrompt(ctx: DQLContext, req: AgentRunRequest): string {
  const domains = Array.from(new Set(Object.values(ctx.manifest.blocks).map((block) => block.domain).filter(Boolean))).sort();
  const upstream = req.upstream?.sql?.trim();
  const context = req.conversationContext;
  const lines = [
    'You are the DQL agentic analytics runtime.',
    'Answer business questions by using tools, not by guessing from memory.',
    '',
    'Tool order and trust policy:',
    '1. Search DQL knowledge graph, certified blocks, business views, semantic objects, DQL manifest, and dbt/source metadata first.',
    '2. If a certified block exactly answers the question, run query_certified_block and label the result certified.',
    '3. If the question needs a different grain, entity list, ranking, drilldown, or filter, inspect_runtime_schema before writing SQL.',
    '4. Use execute_generated_sql only for read-only SELECT/WITH SQL previews. Label those results uncertified and review-required.',
    '5. Use external MCP servers only as optional extra context; never let them bypass DQL validation, execution safety, or certification.',
    '6. When producing a reusable asset, call suggest_block or describe the draft block path and review status.',
    '',
    'Final answers must include: answer, table/result summary when available, SQL when generated, trust status, and next review/certification action.',
    `Project context: ${Object.keys(ctx.manifest.blocks).length} blocks. Domains: ${domains.join(', ') || '(none yet)'}.`,
    upstream ? `Current UI/app context:\n${upstream}` : '',
    context?.sourceCertifiedBlock ? `Selected/source certified block: ${context.sourceCertifiedBlock}` : '',
    context?.sourceQuestion ? `Prior question: ${context.sourceQuestion}` : '',
    context?.sourceAnswerSummary ? `Prior answer summary: ${context.sourceAnswerSummary}` : '',
    context?.requestedFilters?.length ? `Remembered filters: ${context.requestedFilters.join(', ')}` : '',
    context?.requestedDimensions?.length ? `Remembered dimensions: ${context.requestedDimensions.join(', ')}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

export function emitProposalFromSuggestBlock(input: unknown, output: unknown, emit: (turn: AgentTurn) => void): void {
  if (!input || typeof input !== 'object') return;
  const proposalInput = input as Partial<BlockProposal>;
  if (!proposalInput.name || !proposalInput.sql) return;
  const outputRecord = output && typeof output === 'object'
    ? output as { certified?: boolean; errors?: unknown[]; warnings?: unknown[] }
    : {};
  emit({
    kind: 'proposal',
    proposal: {
      name: String(proposalInput.name),
      domain: String(proposalInput.domain ?? ''),
      owner: String(proposalInput.owner ?? ''),
      description: String(proposalInput.description ?? ''),
      sql: String(proposalInput.sql),
      tags: Array.isArray(proposalInput.tags) ? proposalInput.tags.map(String) : undefined,
      chartType: typeof proposalInput.chartType === 'string' ? proposalInput.chartType : undefined,
    },
    governance: {
      certified: Boolean(outputRecord.certified),
      errors: Array.isArray(outputRecord.errors) ? outputRecord.errors.map(String) : [],
      warnings: Array.isArray(outputRecord.warnings) ? outputRecord.warnings.map(String) : [],
    },
  });
}

function blockNodeFor(name: string): KGNode {
  return {
    nodeId: `block:${name}`,
    kind: 'block',
    name,
    sourceTier: 'certified_artifact',
    certification: 'certified',
  };
}

function objectArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}
