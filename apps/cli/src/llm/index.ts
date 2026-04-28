import { claudeAgentSdkRunner } from './providers/claude-agent-sdk.js';
import { claudeCodeRunner } from './providers/claude-code.js';
import { createDqlAgentProviderRunner } from './providers/dql-agent-provider.js';
import type { AgentRunner, ProviderId } from './types.js';

export {
  type AgentRunRequest,
  type AgentRunner,
  type AgentTurn,
  type BlockProposal,
  type ChatTurn,
  type LLMProvider,
  type ProviderId,
} from './types.js';

/**
 * Registry of available LLM providers. Notebook and App chat default to the
 * Settings-resolved DQL agent providers. Claude Agent SDK / Claude Code remain
 * explicit experimental runners for MCP-oriented workflows.
 */
const RUNNERS: Record<ProviderId, AgentRunner> = {
  'claude-agent-sdk': claudeAgentSdkRunner,
  'claude-code': claudeCodeRunner,
  openai: createDqlAgentProviderRunner('openai'),
  gemini: createDqlAgentProviderRunner('gemini'),
  ollama: createDqlAgentProviderRunner('ollama'),
  'custom-openai': createDqlAgentProviderRunner('custom-openai'),
};

export function getRunner(provider: ProviderId): AgentRunner | null {
  return RUNNERS[provider] ?? null;
}
