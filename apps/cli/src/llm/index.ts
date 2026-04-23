import { claudeAgentSdkRunner } from './claude-agent-sdk.js';
import { claudeCodeRunner } from './claude-code.js';
import type { AgentRunner, ProviderId } from './types.js';

export { type AgentRunRequest, type AgentRunner, type AgentTurn, type BlockProposal, type ChatTurn, type ProviderId } from './types.js';

const RUNNERS: Record<ProviderId, AgentRunner> = {
  'claude-agent-sdk': claudeAgentSdkRunner,
  'claude-code': claudeCodeRunner,
};

export function getRunner(provider: ProviderId): AgentRunner | null {
  return RUNNERS[provider] ?? null;
}
