import { describe, expect, it } from 'vitest';
import { __test__ } from './claude-code.js';
import type { AgentRunRequest } from '../types.js';

describe('claudeCodeRunner governed tool surface', () => {
  it('allows the governed ask, semantic, metadata query, and context expansion tools', () => {
    expect(__test__.CLAUDE_CODE_ALLOWED_TOOLS.split(/\s+/)).toEqual(
      expect.arrayContaining([
        'mcp__dql__ask_dql',
        'mcp__dql__query_semantic_model',
        'mcp__dql__inspect_metadata_context',
        'mcp__dql__query_via_metadata',
        'mcp__dql__query_via_block',
        'mcp__dql__expand_context',
      ]),
    );
  });

  it('instructs Claude Code to route analytics through ask_dql before writing SQL', () => {
    const prompt = __test__.buildPrompt({
      provider: 'claude-code',
      projectRoot: '/tmp/project',
      messages: [{ role: 'user', content: 'show revenue by product' }],
    } as AgentRunRequest);

    expect(prompt).toContain('Use mcp__dql__ask_dql first');
    expect(prompt).toContain('mcp__dql__query_semantic_model');
    expect(prompt).toContain('mcp__dql__query_via_metadata');
    expect(prompt).toContain('mcp__dql__expand_context');
    expect(prompt).toContain('followUp.priorResultRef');
    expect(prompt).toContain('followUp.priorDqlArtifact');
  });
});
