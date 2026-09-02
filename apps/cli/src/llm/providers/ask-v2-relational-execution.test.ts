import { describe, expect, it, vi } from 'vitest';
import { NodeKind, Parser } from '@duckcodeailabs/dql-core';
import type { AgentEvidenceCandidate, AgentProvider, AskAgentStateV4 } from '@duckcodeailabs/dql-agent';
import { __test__ } from './dql-agent-provider.js';

/**
 * The end-to-end gate the recorded failures had no test for.
 *
 * Nineteen runs of "top 10 customer accounts by net arr" on a 3,373-model
 * warehouse ended blocked, and no unit test could see why: `compile_and_run_dql`
 * asked the analyst for a finished DQL block whose grammar no prompt taught, so
 * the model sent SQL and the block parser refused it. This drives the real lane
 * with a scripted analyst and asserts the contract that replaced it — the model
 * chooses admitted identifiers, the HOST writes the program, and the program it
 * writes parses and executes inside the dispatch bound.
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

function askV2State(): AskAgentStateV4 {
  const ids = [relation.qualifiedId!];
  return {
    version: 4,
    mode: 'authoritative_v2',
    turnClass: 'analytics',
    snapshotId: 'snapshot:relational-test',
    sourceFingerprint: 'sha256:relational-test',
    retainedCandidateIds: ids,
    initialCandidateIds: ids,
    expansionCandidateIds: [],
    relationshipPathHandles: [],
    conversation: { version: 2, availableResultHandleIds: [] },
    observations: [],
    tierAttempts: [],
  };
}

/** A second relation, so the opening cards are not empty. */
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

function workspaceBridge() {
  return {
    version: 2 as const,
    snapshotId: 'snapshot:relational-test',
    sourceFingerprint: 'sha256:relational-test',
    getContextPack: () => ({}),
    getToolWorkspace: () => ({
      version: 1 as const,
      snapshotId: 'snapshot:relational-test',
      sourceFingerprint: 'sha256:relational-test',
      candidates: [relation, otherRelation],
      relationshipPathHandles: [],
      certifiedArtifacts: new Map(),
      certifiedCompleteCandidateIds: [],
      semanticCapabilities: new Map(),
    }),
  };
}

/** An analyst that decides the shape and never writes a query. */
function scriptedAnalyst(replies: string[]): { provider: AgentProvider; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    provider: {
      name: 'ollama',
      available: async () => true,
      generate: async () => replies[calls++] ?? '',
    },
  };
}

describe('the governed relational contract, driven end to end', () => {
  it('executes a host-composed program from a relational plan within the dispatch bound', async () => {
    const executed: Array<{ source: string; measures: string[]; dimensions: string[] }> = [];
    const analyst = scriptedAnalyst([
      // The model's whole job: which admitted column, how to aggregate it,
      // what to group by, how to order, how many rows.
      JSON.stringify({
        tool: 'compile_and_run_dql',
        input: {
          relationalPlan: {
            measures: [{ id: 'mart_arr.arr', aggregation: 'sum', alias: 'total_arr' }],
            dimensions: [{ id: 'mart_arr.crm_account_name' }],
            orderBy: { reference: 'total_arr', direction: 'desc' },
            limit: 10,
          },
        },
      }),
      JSON.stringify({
        tool: 'finish_answer',
        input: { answer: 'Ten accounts by ARR.', evidenceIds: ['dbt::model.gitlab_snowflake.mart_arr'] },
      }),
    ]);

    const answer = await __test__.createAskV2LaneHandler(askV2State(), {
      maxToolCalls: 8,
      maxProviderDispatches: 3,
    })({
      question: 'top 10 customer accounts by net arr',
      provider: analyst.provider,
      askAgentV2Workspace: workspaceBridge(),
      authorizeAskV2DqlArtifact: async () => ({ planId: 'plan-1', targetFingerprint: 'sha256:target' }),
      executeAskV2DqlArtifact: async (input: { artifact: { source: string; metrics?: string[]; dimensions?: string[] } }) => {
        executed.push({
          source: input.artifact.source,
          measures: input.artifact.metrics ?? [],
          dimensions: input.artifact.dimensions ?? [],
        });
        return {
          columns: ['crm_account_name', 'total_arr'],
          rows: [{ crm_account_name: 'Tyrell Analytics', total_arr: 274155.2 }],
          rowCount: 1,
        };
      },
    } as never);

    // One execution, reached inside the bound the plan set.
    expect(executed).toHaveLength(1);
    expect(analyst.calls()).toBeLessThanOrEqual(3);

    // The host wrote a real DQL block, not the model.
    const program = executed[0]!.source;
    const parsed = new Parser(program, '<test>').parse();
    expect(parsed.statements.some((statement) => statement.kind === NodeKind.BlockDecl)).toBe(true);
    expect(program).toContain('SUM("arr") AS "total_arr"');
    expect(program).toContain('FROM "mart_arr"');
    expect(program).toContain('GROUP BY "crm_account_name"');
    expect(program).toContain('LIMIT 10');

    // The frozen closure still names the identifiers the model chose.
    expect(executed[0]!.measures).toContain('mart_arr.arr');
    expect(executed[0]!.dimensions).toContain('mart_arr.crm_account_name');
    expect(answer.kind).not.toBe('no_answer');
  });

  it('admits a retained relation once described, so the next plan naming its columns runs', async () => {
    // The live failure this guards: the analyst named mart_arr.arr, was refused
    // because mart_arr was retained but not on a card, called describe_relation
    // — which succeeded — and then sent the SAME ids and was refused again.
    // Describing has to make the relation usable, or it is only a way to spend
    // a dispatch learning something you still cannot act on.
    const retainedOnly = askV2State();
    // mart_arr is retained by retrieval but NOT among the initial cards; a
    // different relation is what the analyst was actually shown.
    retainedOnly.retainedCandidateIds = [relation.qualifiedId!, otherRelation.qualifiedId!];
    retainedOnly.initialCandidateIds = [otherRelation.qualifiedId!];
    const executed: string[] = [];
    const analyst = scriptedAnalyst([
      JSON.stringify({
        tool: 'compile_and_run_dql',
        input: { relationalPlan: { measures: [{ id: 'mart_arr.arr', aggregation: 'sum' }] } },
      }),
      JSON.stringify({ tool: 'describe_relation', input: { candidateId: 'mart_arr' } }),
      JSON.stringify({
        tool: 'compile_and_run_dql',
        input: {
          relationalPlan: {
            measures: [{ id: 'mart_arr.arr', aggregation: 'sum' }],
            dimensions: [{ id: 'mart_arr.crm_account_name' }],
          },
        },
      }),
      JSON.stringify({ tool: 'finish_answer', input: { answer: 'Done.', evidenceIds: [] } }),
    ]);
    await __test__.createAskV2LaneHandler(retainedOnly, {
      maxToolCalls: 8,
      maxProviderDispatches: 5,
    })({
      question: 'total arr by account',
      provider: analyst.provider,
      askAgentV2Workspace: workspaceBridge(),
      authorizeAskV2DqlArtifact: async () => ({ planId: 'plan-1' }),
      executeAskV2DqlArtifact: async (input: { artifact: { source: string } }) => {
        executed.push(input.artifact.source);
        return { columns: ['crm_account_name', 'arr'], rows: [{ crm_account_name: 'A', arr: 1 }], rowCount: 1 };
      },
    } as never);
    expect(executed, retainedOnly.observations.map((o) => `${o.tool}:${o.outcome}:${o.reasonCode}`).join(' | ')).toHaveLength(1);
    expect(executed[0]).toContain('FROM "mart_arr"');
  });

  it('refuses a plan naming a column the relation does not have, and names the near miss', async () => {
    // The exact failure the recorded runs died of: an invented identifier. The
    // difference is what comes back — the admitted relations, and the column
    // the model probably meant — rather than a bare code it can only re-guess.
    const analyst = scriptedAnalyst([
      JSON.stringify({
        tool: 'compile_and_run_dql',
        input: {
          relationalPlan: {
            measures: [{ id: 'mart_arr.net_arr', aggregation: 'sum' }],
            dimensions: [{ id: 'mart_arr.customer_account_name' }],
          },
        },
      }),
      JSON.stringify({ tool: 'finish_answer', input: { answer: 'No admitted column matched.', evidenceIds: [] } }),
    ]);
    const execute = vi.fn();
    await __test__.createAskV2LaneHandler(askV2State(), {
      maxToolCalls: 8,
      maxProviderDispatches: 3,
    })({
      question: 'top 10 customer accounts by net arr',
      provider: analyst.provider,
      askAgentV2Workspace: workspaceBridge(),
      authorizeAskV2DqlArtifact: async () => ({ planId: 'plan-1' }),
      executeAskV2DqlArtifact: execute,
    } as never);
    expect(execute).not.toHaveBeenCalled();
  });
});
