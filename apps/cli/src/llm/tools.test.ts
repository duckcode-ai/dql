import { describe, expect, it } from 'vitest';
import type { DQLContext } from '@duckcodeailabs/dql-mcp';
import { dqlToolNamesForSurface } from '@duckcodeailabs/dql-agent';
import { buildAgentTools } from './tools.js';
import { analyticsSystemPrompt } from './analytics-tools.js';
import type { AgentRunRequest } from './types.js';

describe('native agent tools', () => {
  it('uses the governed DQL route and metadata execution tools', () => {
    const tools = buildAgentTools({} as DQLContext);
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual(dqlToolNamesForSurface('native'));
    expect(tools.find((tool) => tool.name === 'query_semantic_model')?.inputSchema).toMatchObject({
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
      },
    });
    expect(tools.find((tool) => tool.name === 'inspect_metadata_context')?.inputSchema).toMatchObject({
      properties: {
        strictness: {
          type: 'string',
          enum: ['balanced', 'exploratory'],
        },
      },
    });
    expect(tools.find((tool) => tool.name === 'query_via_metadata')?.inputSchema).toMatchObject({
      required: ['question'],
      properties: {
        outputs: {
          type: 'array',
          items: { type: 'string' },
        },
        regroundAttemptsUsed: { type: 'number' },
        followUp: {
          properties: {
            kind: { enum: ['generic', 'drilldown', 'contextual'] },
            priorResultRef: {
              required: ['id', 'columns'],
            },
            priorDqlArtifact: {
              required: ['kind', 'source'],
            },
          },
        },
      },
    });
    expect(tools.find((tool) => tool.name === 'expand_context')?.inputSchema).toMatchObject({
      required: ['contextPackId', 'relations'],
    });
  });

  it('instructs native agents to carry prior result refs into metadata follow-ups', () => {
    const prompt = analyticsSystemPrompt({
      manifest: { blocks: {} },
    } as DQLContext, {
      provider: 'anthropic',
      projectRoot: '/tmp/project',
      messages: [{ role: 'user', content: 'include product details with previous results' }],
    } as AgentRunRequest);

    expect(prompt).toContain('followUp.priorResultRef');
    expect(prompt).toContain('followUp.priorDqlArtifact');
    expect(prompt).toContain('previous results');
  });
});
