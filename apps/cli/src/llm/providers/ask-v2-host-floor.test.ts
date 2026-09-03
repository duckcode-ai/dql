import { describe, expect, it, vi } from 'vitest';
import type { AgentEvidenceCandidate, AgentProvider, AskAgentStateV4 } from '@duckcodeailabs/dql-agent';
import { __test__ } from './dql-agent-provider.js';

/**
 * The floor: what the HOST does when the analyst's turn ends with nothing
 * executed.
 *
 * Before this, review-required execution was unreachable after a spent
 * budget, a provider fault, or an analyst that declined to act — the user
 * got a sentence about dispatches. These drive the real lane with analysts
 * that fail in each of those ways and assert that the question is still
 * answered from admitted columns, labelled for review, or refused with the
 * measures that ARE available. The one thing the floor must never do is
 * answer a narrower question more broadly than it was asked.
 */

const relation: AgentEvidenceCandidate = {
  id: 'dbt::model.gitlab_snowflake.mart_arr',
  qualifiedId: 'dbt::model.gitlab_snowflake.mart_arr',
  kind: 'dbt_model',
  trustTier: 'exploratory',
  name: 'mart_arr',
  relevanceScore: 1,
  matchReasons: ['relation'],
  compatibility: 'compatible',
  columns: [
    { name: 'crm_account_name', type: 'varchar' },
    { name: 'arr', type: 'number' },
    { name: 'arr_month', type: 'date' },
  ],
  columnCount: 3,
};

const otherRelation: AgentEvidenceCandidate = {
  id: 'dbt::model.gitlab_snowflake.mart_support',
  qualifiedId: 'dbt::model.gitlab_snowflake.mart_support',
  kind: 'dbt_model',
  trustTier: 'exploratory',
  name: 'mart_support',
  relevanceScore: 0.4,
  matchReasons: ['relation'],
  compatibility: 'partial',
  columns: [{ name: 'ticket_count', type: 'number' }],
  columnCount: 1,
};

function askV2State(): AskAgentStateV4 {
  const ids = [relation.qualifiedId!, otherRelation.qualifiedId!];
  return {
    version: 4,
    mode: 'authoritative_v2',
    turnClass: 'analytics',
    snapshotId: 'snapshot:floor-test',
    sourceFingerprint: 'sha256:floor-test',
    retainedCandidateIds: ids,
    initialCandidateIds: ids,
    expansionCandidateIds: [],
    relationshipPathHandles: [],
    conversation: { version: 2, availableResultHandleIds: [] },
    observations: [],
    tierAttempts: [],
  };
}

function workspaceBridge() {
  return {
    version: 2 as const,
    snapshotId: 'snapshot:floor-test',
    sourceFingerprint: 'sha256:floor-test',
    getContextPack: () => ({}),
    getToolWorkspace: () => ({
      version: 1 as const,
      snapshotId: 'snapshot:floor-test',
      sourceFingerprint: 'sha256:floor-test',
      candidates: [relation, otherRelation],
      relationshipPathHandles: [],
      certifiedArtifacts: new Map(),
      certifiedCompleteCandidateIds: [],
      semanticCapabilities: new Map(),
    }),
  };
}

/** Analysts that fail the way real ones did. */
const personas = {
  /** Only ever finishes, never touches a tool. */
  lazy: (): AgentProvider => ({
    name: 'ollama',
    available: async () => true,
    generate: async () => JSON.stringify({ tool: 'finish_answer', input: { answer: 'I would rather not.', evidenceIds: [] } }),
  }),
  /** Dies on its first dispatch. */
  crashing: (): AgentProvider => ({
    name: 'ollama',
    available: async () => true,
    generate: async () => { throw new Error('socket hang up'); },
  }),
  /** Returns text that is not a tool call, every time. */
  garbage: (): AgentProvider => ({
    name: 'ollama',
    available: async () => true,
    generate: async () => 'Sure! Here is what I think you want: SELECT * FROM everything;',
  }),
  /** Invents identifiers and never corrects them. */
  inventing: (): AgentProvider => ({
    name: 'ollama',
    available: async () => true,
    generate: async () => JSON.stringify({
      tool: 'compile_and_run_dql',
      input: { relationalPlan: { measures: [{ id: 'mart_arr.net_arr_total', aggregation: 'sum' }] } },
    }),
  }),
};

async function ask(question: string, provider: AgentProvider, state = askV2State()) {
  const executed: string[] = [];
  const answer = await __test__.createAskV2LaneHandler(state, { maxToolCalls: 4, maxProviderDispatches: 3 })({
    question,
    provider,
    askAgentV2Workspace: workspaceBridge(),
    authorizeAskV2DqlArtifact: async () => ({ planId: 'plan-floor' }),
    executeAskV2DqlArtifact: async (input: { artifact: { source: string } }) => {
      executed.push(input.artifact.source);
      return { columns: ['crm_account_name', 'total_arr'], rows: [{ crm_account_name: 'Tyrell', total_arr: 1 }], rowCount: 1 };
    },
  } as never);
  return { answer, executed, state };
}

const INFRASTRUCTURE = /provider|dispatch|budget|orchestration|snapshot|closure|kernel|tool path|retry/i;

describe('the host floor answers when the analyst did not', () => {
  for (const [name, persona] of Object.entries(personas)) {
    it(`composes and runs a governed relational program when the analyst is ${name}`, async () => {
      const { answer, executed, state } = await ask('top 10 customer accounts by arr', persona());
      const trace = state.observations.map((o) => `${o.tool}:${o.outcome}:${o.reasonCode}`).join(' | ');
      expect(executed, trace).toHaveLength(1);
      expect(executed[0]).toContain('SUM("arr")');
      expect(executed[0]).toContain('GROUP BY "crm_account_name"');
      expect(executed[0]).toContain('LIMIT 10');
      // Host-composed and unverified against the question: labelled for review.
      expect(answer.kind).toBe('uncertified');
      expect(answer.reviewStatus).toBe('analyst_review_required');
      expect(answer.askAgentV2Outcome?.reasonCode).toBe('ASK_V2_HOST_FLOOR_ANSWERED');
      expect(answer.text).not.toMatch(INFRASTRUCTURE);
    });
  }

  it('refuses honestly, naming the measures that exist, when nothing binds', async () => {
    const { answer, executed } = await ask('total churn by region', personas.lazy());
    expect(executed).toHaveLength(0);
    expect(answer.kind).toBe('no_answer');
    expect(answer.refusalCode).toBe('grounding_gap');
    expect(answer.text).toContain('mart_arr (arr)');
    expect(answer.text).not.toMatch(INFRASTRUCTURE);
  });

  it('never answers a narrower question more broadly: a dropped qualifier is a refusal', async () => {
    // "beverage revenue" once became total revenue with nothing in the answer
    // to say the word had been ignored. The floor must not repeat that in
    // host clothing.
    const { answer, executed } = await ask('beverage arr by account', personas.lazy());
    expect(executed).toHaveLength(0);
    expect(answer.kind).toBe('no_answer');
    expect(answer.text).toContain('"beverage"');
  });

  it('does not express a filter it cannot prove', async () => {
    const { answer, executed } = await ask('arr by account for Tyrell', personas.lazy());
    expect(executed).toHaveLength(0);
    expect(answer.kind).toBe('no_answer');
  });

  it('never replaces a plan that reached the warehouse and failed there', async () => {
    const analyst: AgentProvider = {
      name: 'ollama',
      available: async () => true,
      generate: async () => JSON.stringify({
        tool: 'compile_and_run_dql',
        input: { relationalPlan: { measures: [{ id: 'mart_arr.arr', aggregation: 'sum' }], dimensions: [{ id: 'mart_arr.crm_account_name' }] } },
      }),
    };
    const execute = vi.fn(async () => { throw Object.assign(new Error('warehouse: permission denied'), { code: 'EXECUTION_FAILED' }); });
    const answer = await __test__.createAskV2LaneHandler(askV2State(), { maxToolCalls: 4, maxProviderDispatches: 3 })({
      question: 'arr by account',
      provider: analyst,
      askAgentV2Workspace: workspaceBridge(),
      authorizeAskV2DqlArtifact: async () => ({ planId: 'plan-floor' }),
      executeAskV2DqlArtifact: execute,
    } as never);
    expect(answer.askAgentV2Outcome?.kind).toBe('execution_failure');
    expect(answer.askAgentV2Outcome?.reasonCode).not.toBe('ASK_V2_HOST_FLOOR_ANSWERED');
  });
});
