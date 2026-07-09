import { describe, expect, it } from 'vitest';
import {
  DQL_TOOL_REGISTRY,
  dqlMcpToolNamesForSurface,
  dqlToolDefinitionsForSurface,
  dqlToolNamesForSurface,
  getDqlToolDefinition,
} from './registry.js';

describe('DQL tool registry', () => {
  it('has unique canonical tool names', () => {
    const names = DQL_TOOL_REGISTRY.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps native agent tools inside the bounded action-space budget', () => {
    const nativeTools = dqlToolDefinitionsForSurface('native');

    expect(nativeTools.map((tool) => tool.name)).toEqual([
      'ask_dql',
      'query_semantic_model',
      'kg_search',
      'search_blocks',
      'get_block',
      'query_via_block',
      'inspect_metadata_context',
      'query_via_metadata',
      'expand_context',
      'lineage_impact',
      'certify',
      'suggest_block',
      // P3: schema-discovery tools, added to give the answer loop the same
      // relation/column/join-key discovery Claude Code gets over MCP.
      'search_metadata',
      'get_table_schema',
      'validate_sql',
    ]);
    // Ceiling deliberately raised 15 -> 18 for the P3 discovery tools; still a
    // bounded, auditable action space, not an unlimited toolset.
    expect(nativeTools.length + 3).toBeLessThanOrEqual(18);
  });

  it('exposes the schema-discovery tools on the answer_loop surface (P3)', () => {
    const answerLoop = dqlToolNamesForSurface('answer_loop');
    expect(answerLoop).toContain('search_metadata');
    expect(answerLoop).toContain('get_table_schema');
    expect(answerLoop).toContain('validate_sql');
  });

  it('keeps the default MCP agentic surface bounded while preserving the governed cascade tools', () => {
    const mcpAgenticTools = dqlToolDefinitionsForSurface('mcp_agentic');

    expect(mcpAgenticTools.map((tool) => tool.name)).toEqual([
      'ask_dql',
      'query_semantic_model',
      'kg_search',
      'search_blocks',
      'get_block',
      'query_via_block',
      'inspect_metadata_context',
      'query_via_metadata',
      'expand_context',
      // Governed-generation tools (DQL generates end-to-end; UI parity).
      'answer_question',
      'build_block_from_prompt',
      'lineage_impact',
      'certify',
      'suggest_block',
      'inspect_dql_project',
    ]);
    expect(mcpAgenticTools).toHaveLength(15);
    expect(mcpAgenticTools.length).toBeLessThanOrEqual(15);
  });

  it('keeps the full MCP surface available for explicit expert sessions', () => {
    const fullMcpTools = dqlToolDefinitionsForSurface('mcp').map((tool) => tool.name);

    expect(fullMcpTools).toEqual(
      expect.arrayContaining([
        'build_dql_app',
        'list_proposals',
        'feedback_record',
        'record_correction',
        'approve_hint',
        'list_hints',
        'search_metadata',
        'get_table_schema',
        'validate_sql',
      ]),
    );
    expect(fullMcpTools.length).toBeGreaterThan(dqlToolDefinitionsForSurface('mcp_agentic').length);
  });

  it('prefixes MCP agentic tool names for Claude-style allowlists', () => {
    expect(dqlMcpToolNamesForSurface('mcp_agentic')).toEqual(
      expect.arrayContaining([
        'mcp__dql__ask_dql',
        'mcp__dql__query_semantic_model',
        'mcp__dql__inspect_metadata_context',
        'mcp__dql__query_via_metadata',
        'mcp__dql__expand_context',
      ]),
    );
  });

  it('allows Claude Code to use the governed ask and metadata execution path', () => {
    expect(dqlToolNamesForSurface('claude_code')).toEqual(
      expect.arrayContaining(['ask_dql', 'query_semantic_model', 'inspect_metadata_context', 'query_via_metadata', 'expand_context']),
    );
    expect(dqlMcpToolNamesForSurface('claude_code')).toEqual(
      expect.arrayContaining([
        'mcp__dql__ask_dql',
        'mcp__dql__query_semantic_model',
        'mcp__dql__inspect_metadata_context',
        'mcp__dql__query_via_metadata',
        'mcp__dql__expand_context',
      ]),
    );
  });

  it('publishes provider-ready JSON schemas', () => {
    expect(getDqlToolDefinition('query_via_metadata').inputSchema).toMatchObject({
      type: 'object',
      required: ['question'],
      properties: {
        question: { type: 'string' },
        outputs: {
          type: 'array',
          items: { type: 'string' },
        },
        followUp: {
          properties: {
            kind: { enum: ['generic', 'drilldown', 'contextual'] },
            priorResultRef: {
              required: ['id', 'columns'],
              properties: {
                columns: { type: 'array', items: { type: 'string' } },
                sourceSql: { type: 'string' },
              },
            },
            priorDqlArtifact: {
              required: ['kind', 'source'],
              properties: {
                kind: { enum: ['certified_block', 'semantic_block', 'sql_block'] },
                source: { type: 'string' },
                metrics: { type: 'array', items: { type: 'string' } },
                dimensions: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
        regroundAttemptsUsed: { type: 'number' },
      },
    });
    expect(getDqlToolDefinition('inspect_metadata_context').inputSchema).toMatchObject({
      type: 'object',
      required: ['question'],
      properties: {
        strictness: {
          type: 'string',
          enum: ['balanced', 'exploratory'],
        },
      },
    });
    expect(getDqlToolDefinition('query_semantic_model').inputSchema).toMatchObject({
      type: 'object',
      properties: {
        metrics: {
          type: 'array',
          items: { type: 'string' },
        },
        saveDraft: {
          type: 'boolean',
        },
        dryRun: {
          type: 'boolean',
        },
        rowLimit: {
          type: 'number',
        },
        serverUrl: {
          type: 'string',
        },
      },
    });
    expect(getDqlToolDefinition('expand_context').inputSchema).toMatchObject({
      type: 'object',
      required: ['contextPackId', 'relations'],
    });
  });
});
