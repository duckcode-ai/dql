import { claudeAgentSdkRunner } from './providers/claude-agent-sdk.js';
import { claudeCodeRunner } from './providers/claude-code.js';
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
 * Registry of available LLM providers. Anthropic-backed only today
 * (`claude-agent-sdk` = hosted API, `claude-code` = local CLI). Additional
 * adapters (OpenAI, Gemini, Ollama, …) land as new files under `providers/`
 * and a new entry here — no changes needed to callers or the agent loop.
 */
const RUNNERS: Record<ProviderId, AgentRunner> = {
  'claude-agent-sdk': claudeAgentSdkRunner,
  'claude-code': claudeCodeRunner,
};

export function getRunner(provider: ProviderId): AgentRunner | null {
  return RUNNERS[provider] ?? null;
}
