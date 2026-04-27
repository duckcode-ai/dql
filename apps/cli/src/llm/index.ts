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
 * Registry of available LLM providers. Claude keeps the tool-use loop; the
 * OpenAI/Gemini/Ollama adapters reuse `@duckcodeailabs/dql-agent` providers
 * and emit the same AgentTurn SSE envelope for notebook Chat.
 */
const RUNNERS: Record<ProviderId, AgentRunner> = {
  'claude-agent-sdk': claudeAgentSdkRunner,
  'claude-code': claudeCodeRunner,
  openai: createDqlAgentProviderRunner('openai'),
  gemini: createDqlAgentProviderRunner('gemini'),
  ollama: createDqlAgentProviderRunner('ollama'),
};

export function getRunner(provider: ProviderId): AgentRunner | null {
  return RUNNERS[provider] ?? null;
}
