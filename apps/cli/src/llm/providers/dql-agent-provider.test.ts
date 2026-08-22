import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildManifest } from '@duckcodeailabs/dql-core';
import { __test__, createDqlAgentProviderRunner, createEvalCassetteReplayProvider, renderAppContextForPrompt, renderExtraContext, resolveEffectiveQuestion } from './dql-agent-provider.js';
import {
  CassetteStore,
  cassetteEvidenceSummary,
  cassetteFingerprint,
  cassetteKey,
  evalCassetteCanonicalizationV2,
  withCassette,
} from '../../commands/agent-eval-cassette.js';
import type { AgentRunRequest } from '../types.js';
import {
  buildAnalysisQuestionPlan,
  buildLocalContextPack,
  createAgenticSqlExecutionCapability,
  dqlToolNamesForSurface,
  scopeContextPackToExploratoryCandidateClosure,
  type AgentMessage,
  type AgentProvider,
  type ProviderToolLoopOptions,
} from '@duckcodeailabs/dql-agent';

function req(messages: Array<{ role: 'user' | 'assistant'; content: string }>): AgentRunRequest {
  return { provider: 'ollama', messages, projectRoot: '/tmp/x' } as AgentRunRequest;
}

async function customerExploratoryClosure(projectRoot: string, question: string) {
  const contextPack = await buildLocalContextPack(projectRoot, {
    question,
    surface: 'notebook',
    limit: 80,
  });
  const candidateIds = contextPack.objects
    .filter((object) => object.objectType === 'dbt_model' && object.name === 'dim_customers')
    .map((object) => object.objectKey);
  const closure = scopeContextPackToExploratoryCandidateClosure(contextPack, candidateIds);
  if (!closure) throw new Error('Expected the router-selected dim_customers closure.');
  return { contextPack, candidateIds, closure };
}

describe('eval cassette provider bootstrap', () => {
  it('replays a labelled deterministic migration without configured provider settings', async () => {
    const cassetteDir = mkdtempSync(join(tmpdir(), 'dql-runtime-cassette-provider-'));
    const messages: AgentMessage[] = [{ role: 'user', content: 'show revenue' }];
    const projectRoot = '/tmp/dql-runtime-cassette-project';
    const key = cassetteKey({
      providerName: 'claude',
      operation: 'generate',
      messages,
      canonicalization: evalCassetteCanonicalizationV2(projectRoot),
    });
    const oldDir = process.env.DQL_EVAL_CASSETTE_DIR;
    const oldMode = process.env.DQL_EVAL_CASSETTE_MODE;
    try {
      new CassetteStore(cassetteDir).put({
        key,
        operation: 'generate',
        text: 'recorded governed interpretation',
        providerName: 'claude',
        recordedAt: '2026-08-22T00:00:00.000Z',
        provenance: {
          kind: 'migrated_legacy_deterministic_fixture',
          sourceLegacyKey: 'legacy-order-count-v1',
          replayClassification: 'orchestration_replay_only',
          providerQuality: 'excluded',
        },
      });
      process.env.DQL_EVAL_CASSETTE_DIR = cassetteDir;
      delete process.env.DQL_EVAL_CASSETTE_MODE;

      const provider = createEvalCassetteReplayProvider(projectRoot);
      expect(provider).toBeDefined();
      expect(provider!.name).toBe('claude');
      await expect(provider!.available()).resolves.toBe(true);
      await expect(provider!.generate(messages)).resolves.toBe('recorded governed interpretation');
    } finally {
      if (oldDir === undefined) delete process.env.DQL_EVAL_CASSETTE_DIR;
      else process.env.DQL_EVAL_CASSETTE_DIR = oldDir;
      if (oldMode === undefined) delete process.env.DQL_EVAL_CASSETTE_MODE;
      else process.env.DQL_EVAL_CASSETTE_MODE = oldMode;
      rmSync(cassetteDir, { recursive: true, force: true });
    }
  });
});

describe('resolveEffectiveQuestion — clarify follow-up folding', () => {
  it('folds the original question with the clarification answer', () => {
    const out = resolveEffectiveQuestion(req([
      { role: 'user', content: 'Can you give me total revenue based on most products performed?' },
      { role: 'assistant', content: 'Needs clarification before a governed answer can be produced. For "…", which business object and measure should I use, and at what grain?' },
      { role: 'user', content: 'I need product details with name' },
    ]));
    expect(out).toContain('Can you give me total revenue based on most products performed?');
    expect(out).toContain('clarification: I need product details with name');
  });

  it('returns the current message unchanged when the prior assistant turn was NOT a clarification', () => {
    const out = resolveEffectiveQuestion(req([
      { role: 'user', content: 'what is total revenue?' },
      { role: 'assistant', content: 'Revenue is $2.8M this quarter.' },
      { role: 'user', content: 'now break it down by region' },
    ]));
    expect(out).toBe('now break it down by region');
  });

  it('returns the single user message when there is no prior turn', () => {
    expect(resolveEffectiveQuestion(req([{ role: 'user', content: 'top products by revenue' }]))).toBe('top products by revenue');
  });

  it('does not merge when the original equals the current answer', () => {
    const out = resolveEffectiveQuestion(req([
      { role: 'user', content: 'revenue by product' },
      { role: 'assistant', content: 'I need one more detail before querying: which metric should define the answer?' },
      { role: 'user', content: 'revenue by product' },
    ]));
    expect(out).toBe('revenue by product');
  });

  it('does not merge a complete new analytical question after clarification', () => {
    const out = resolveEffectiveQuestion(req([
      { role: 'user', content: 'which customer should I use?' },
      { role: 'assistant', content: 'Needs clarification: which customer should define the answer?' },
      { role: 'user', content: 'what region has the most revenue' },
    ]));
    expect(out).toBe('what region has the most revenue');
  });

  it('does not merge a compact standalone analytical request after clarification', () => {
    const out = resolveEffectiveQuestion(req([
      { role: 'user', content: 'which breakdown should I use?' },
      { role: 'assistant', content: 'I need one more detail: which metric and dimension should define the answer?' },
      { role: 'user', content: 'revenue by region' },
    ]));
    expect(out).toBe('revenue by region');
  });
});

describe('answer-loop tool surface', () => {
  it('converts a server-only compound parent binding into one exact child filter', () => {
    const followUp = __test__.followUpFromConversationContext({
      ...req([{ role: 'user', content: 'top customers in that region' }]),
      conversationContext: {
        analyticalTaskDependencyBinding: {
          version: 1,
          sourceTaskId: 'task-1',
          sourceResultFingerprint: 'a'.repeat(64),
          canonicalColumn: 'region',
          value: 'Philadelphia',
          rowFingerprint: 'b'.repeat(64),
        },
      },
    }, 'top customers in that region');

    expect(followUp).toMatchObject({
      kind: 'drilldown',
      sourceTurnId: 'task:task-1',
      filters: ['Philadelphia'],
      dimensions: ['region'],
      memberBindings: [{ dimension: 'region', values: ['Philadelphia'], confidence: 'exact' }],
    });
    expect(followUp).not.toHaveProperty('sourceAnswer');
    expect(followUp).not.toHaveProperty('priorResult');
  });

  it('does not turn deep Ask thinking into the Research lane (E2E-022)', () => {
    expect(__test__.agenticLaneForRequest({ ...req([{ role: 'user', content: 'explain revenue' }]), analysisDepth: 'deep' }))
      .toBe('generated');
    expect(__test__.agenticLaneForRequest({ ...req([{ role: 'user', content: 'research revenue drivers' }]), analysisDepth: 'deep', orchestrationMode: 'research' }))
      .toBe('research');
  });

  it('defaults Research row tools off and enables only the bounded tools on explicit opt-in', () => {
    const tools = __test__.buildAnswerLoopTools('/tmp/dql-agent-provider-tools');
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual([
      ...dqlToolNamesForSurface("answer_loop"),
      "search_project_files",
      "list_notebook_datasets",
      "describe_notebook_dataset",
      "propose_cross_source_join",
    ]);
    expect(names).not.toEqual(expect.arrayContaining([
      "sample_notebook_dataset",
      "execute_local_analysis",
    ]));
    const optedInNames = __test__.buildAnswerLoopTools('/tmp/dql-agent-provider-tools', {
      researchResultRowsOptIn: true,
    }).map((tool) => tool.name);
    expect(optedInNames).toEqual([
      ...dqlToolNamesForSurface("answer_loop"),
      "search_project_files",
      "list_notebook_datasets",
      "describe_notebook_dataset",
      "sample_notebook_dataset",
      "propose_cross_source_join",
      "execute_local_analysis",
    ]);
    expect(optedInNames).toEqual(
      expect.arrayContaining([
        "expand_context",
        "search_metadata",
        "get_table_schema",
        "validate_sql",
        "search_project_files",
        "list_notebook_datasets",
        "describe_notebook_dataset",
        "sample_notebook_dataset",
        "propose_cross_source_join",
        "execute_local_analysis",
      ]),
    );
    expect(names).not.toEqual(
      expect.arrayContaining([
        "ask_dql",
        "query_via_metadata",
        "query_via_block",
      ]),
    );
  });

  it('labels local-analysis follow-ups separately from bounded narration samples', () => {
    expect(__test__.researchDispatchPurposeForTool('execute_local_analysis')).toBe('research_tool');
    expect(__test__.researchDispatchPurposeForTool('sample_notebook_dataset')).toBe('research_narration');
    expect(__test__.researchDispatchPurposeForTool('search_project_files')).toBe('research_narration');
  });
});

describe('provider runner — analyst physical dispatch budget', () => {
  it('records production exploratory messages and replays them across fresh roots', async () => {
    const rootA = mkdtempSync(join(tmpdir(), 'dql-provider-exploratory-a-'));
    const rootB = mkdtempSync(join(tmpdir(), 'dql-provider-exploratory-b-'));
    const cassetteDir = mkdtempSync(join(tmpdir(), 'dql-provider-exploratory-cassette-'));
    const question = 'what is the order count for each customer?';
    const proposal = '```json\n{"summary":"Order count by customer.","sql":"SELECT customer_name AS customer_name, count_lifetime_orders AS count_lifetime_orders FROM jaffle_shop.dev.dim_customers ORDER BY customer_name","outputs":["customer_name","count_lifetime_orders"]}\n```';
    const copiedFixture = join(process.cwd(), 'test', 'fixtures', 'jaffle-supply-chain');
    const run = async (
      projectRoot: string,
      provider: AgentProvider,
      captures: AgentMessage[][],
    ) => {
      const manifest = buildManifest({ projectRoot, dbtManifestPath: join(projectRoot, 'target', 'manifest.json') });
      const {
        contextPack,
        candidateIds: exploratoryCandidateIds,
        closure: exploratoryContextPack,
      } = await customerExploratoryClosure(projectRoot, question);
      const turns: Array<{ kind: string; [key: string]: unknown }> = [];
      let certifiedCalls = 0;
      let sqlCalls = 0;
      let prepareCalls = 0;
      const runId = `order-count-${projectRoot.split('-').at(-1)}`;
      let executedCapability: ReturnType<typeof createAgenticSqlExecutionCapability> | undefined;
      await createDqlAgentProviderRunner('ollama', provider).run({
        provider: 'ollama',
        projectRoot,
        agentRunId: runId,
        projectSnapshot: { snapshotId: contextPack.knowledgeLens.snapshotId, manifest },
        preparedContextPack: contextPack,
        preparedExploratoryContextPack: exploratoryContextPack,
        selectedCascadeTier: 'exploratory_sql',
        exploratoryCandidateIds,
        messages: [{ role: 'user', content: question }],
        executeCertifiedBlock: async () => {
          certifiedCalls += 1;
          throw new Error('Router-selected exploratory execution must not reopen certified execution.');
        },
        // Router-selected exploratory SQL is no longer permitted to use the
        // legacy raw callback. Model text must first cross the host-owned,
        // exact-SQL capability handoff that production uses before the one
        // physical execution callback runs.
        prepareExploratorySqlExecution: async (sql) => {
          prepareCalls += 1;
          const targetFingerprint = `target-${projectRoot.split('-').at(-1)}`;
          const capability = createAgenticSqlExecutionCapability({
            sql,
            runId,
            executionId: `${runId}:exploratory`,
            snapshotId: contextPack.knowledgeLens.snapshotId,
            planId: `exploratory-${projectRoot.split('-').at(-1)}`,
            targetFingerprint,
            bindings: { sqlParams: [], variables: {} },
            proven: [
              { identifier: 'jaffle_shop.dev.dim_customers', evidence: 'schema_tool' },
              { identifier: 'jaffle_shop.dev.dim_customers.customer_name', evidence: 'schema_tool' },
              { identifier: 'jaffle_shop.dev.dim_customers.count_lifetime_orders', evidence: 'schema_tool' },
            ],
          });
          if (!capability) throw new Error('Expected a server-scoped exploratory capability.');
          return {
            capability,
            freeze: {
              version: 1,
              selectedTier: 'exploratory_sql',
              planId: capability.planId,
              planFingerprint: 'a'.repeat(64),
              snapshotId: contextPack.knowledgeLens.snapshotId,
              targetFingerprint,
              sqlFingerprint: capability.candidateSqlFingerprint,
              candidateIds: ['model.jaffle_shop.dim_customers'],
              authorization: 'capability_minted',
            },
          };
        },
        executeAgenticGeneratedSql: async (capability, sql) => {
          executedCapability = capability;
          sqlCalls += 1;
          return {
            columns: ['customer_name', 'count_lifetime_orders'],
            rows: [{ customer_name: 'Ada', count_lifetime_orders: 3 }],
            rowCount: 1,
            sql,
          };
        },
      }, (turn) => turns.push(turn as typeof turns[number]), new AbortController().signal);
      return {
        contextPack,
        exploratoryContextPack,
        exploratoryCandidateIds,
        turns,
        certifiedCalls,
        sqlCalls,
        prepareCalls,
        executedCapability,
        captures,
      };
    };
    try {
      cpSync(copiedFixture, rootA, { recursive: true });
      cpSync(copiedFixture, rootB, { recursive: true });
      const messagesA: AgentMessage[][] = [];
      const liveA: AgentProvider = {
        name: 'claude',
        available: async () => true,
        generate: async (messages) => {
          messagesA.push(messages);
          return proposal;
        },
      };
      const recorded = withCassette(
        liveA,
        new CassetteStore(cassetteDir),
        'record',
        evalCassetteCanonicalizationV2(rootA),
      );
      const first = await run(rootA, recorded, messagesA);
      expect(messagesA).toHaveLength(1);
      const firstPrompt = messagesA[0]!.map((message) => message.content).join('\n');
      expect(first.exploratoryContextPack.allowedSqlContext.relations.map((relation) => relation.relation))
        .toEqual(['jaffle_shop.dev.dim_customers']);
      expect(firstPrompt).toContain('jaffle_shop.dev.dim_customers');
      expect(firstPrompt).not.toContain('jaffle_shop.dev.order_items');
      expect(firstPrompt).not.toContain('jaffle_shop.dev.supplies');
      expect(first.certifiedCalls).toBe(0);
      expect(first.prepareCalls).toBe(1);
      expect(first.sqlCalls).toBe(1);
      const firstAnswer = first.turns.find((turn) => turn.kind === 'tool_result' && turn.id === 'governed_answer')?.output as {
        sourceTier?: string;
        certification?: string;
        exploratoryExecutionFreeze?: { selectedTier?: string; authorization?: string; planId?: string };
      } | undefined;
      expect(firstAnswer).toMatchObject({
        sourceTier: 'dbt_manifest',
        certification: 'ai_generated',
        exploratoryExecutionFreeze: {
          selectedTier: 'exploratory_sql',
          authorization: 'capability_minted',
        },
      });
      expect(first.executedCapability).toMatchObject({
        runId: `order-count-${rootA.split('-').at(-1)}`,
        planId: `exploratory-${rootA.split('-').at(-1)}`,
      });

      const messagesB: AgentMessage[][] = [];
      let rawReplayCalls = 0;
      const replay = withCassette({
        name: 'claude',
        available: async () => true,
        generate: async () => {
          rawReplayCalls += 1;
          throw new Error('The fresh-root replay must not call a live provider.');
        },
      }, new CassetteStore(cassetteDir), 'replay', evalCassetteCanonicalizationV2(rootB));
      const observingReplay: AgentProvider = {
        name: 'claude',
        available: () => replay.available(),
        generate: async (messages, options) => {
          messagesB.push(messages);
          return replay.generate(messages, options);
        },
      };
      const second = await run(rootB, observingReplay, messagesB);
      expect(messagesB).toHaveLength(1);
      expect(rawReplayCalls).toBe(0);
      expect(second.certifiedCalls).toBe(0);
      expect(second.prepareCalls).toBe(1);
      expect(second.sqlCalls).toBe(1);
      expect(second.executedCapability).toMatchObject({
        runId: `order-count-${rootB.split('-').at(-1)}`,
        planId: `exploratory-${rootB.split('-').at(-1)}`,
      });

      const firstFingerprint = cassetteFingerprint({
        providerName: 'claude', operation: 'generate', messages: messagesA[0]!,
        canonicalization: evalCassetteCanonicalizationV2(rootA),
      });
      const secondFingerprint = cassetteFingerprint({
        providerName: 'claude', operation: 'generate', messages: messagesB[0]!,
        canonicalization: evalCassetteCanonicalizationV2(rootB),
      });
      expect(secondFingerprint.key).toBe(firstFingerprint.key);
      expect(firstFingerprint.diagnostics).toMatchObject({
        version: 2,
        messageCount: messagesA[0]!.length,
        messageRoles: messagesA[0]!.map((message) => message.role),
      });
      expect(new CassetteStore(cassetteDir).get(firstFingerprint.key)?.fingerprintDiagnostics)
        .toEqual(firstFingerprint.diagnostics);
      expect(new CassetteStore(cassetteDir).get(firstFingerprint.key)?.provenance)
        .toEqual({
          kind: 'recorded_provider',
          replayClassification: 'recorded_provider',
          providerQuality: 'eligible',
        });
      expect(cassetteEvidenceSummary(new CassetteStore(cassetteDir))).toMatchObject({
        totalEntries: 1,
        recordedProviderEntries: 1,
        migratedLegacyDeterministicFixtureEntries: 0,
        realProviderQualityEligible: true,
      });
    } finally {
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
      rmSync(cassetteDir, { recursive: true, force: true });
    }
  });

  it('rejects a same-snapshot provider proposal outside the router-selected exploratory relation closure before capability minting', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-provider-exploratory-outside-closure-'));
    try {
      cpSync(join(process.cwd(), 'test', 'fixtures', 'jaffle-supply-chain'), projectRoot, { recursive: true });
      const question = 'what is the order count for each customer?';
      const { contextPack, candidateIds, closure } = await customerExploratoryClosure(projectRoot, question);
      const manifest = buildManifest({ projectRoot, dbtManifestPath: join(projectRoot, 'target', 'manifest.json') });
      const calls: AgentMessage[][] = [];
      const provider: AgentProvider = {
        name: 'claude',
        available: async () => true,
        generate: async (messages) => {
          calls.push(messages);
          return '```json\n{"summary":"Wrong relation.","sql":"SELECT product_name FROM jaffle_shop.dev.order_items","outputs":["product_name"]}\n```';
        },
      };
      const prepare = vi.fn(async () => {
        throw new Error('An out-of-closure proposal must not reach the host capability boundary.');
      });
      const execute = vi.fn(async () => {
        throw new Error('An out-of-closure proposal must not execute.');
      });
      const turns: Array<{ kind: string; [key: string]: unknown }> = [];
      await createDqlAgentProviderRunner('ollama', provider).run({
        provider: 'ollama',
        projectRoot,
        agentRunId: 'outside-closure-run',
        projectSnapshot: { snapshotId: contextPack.knowledgeLens.snapshotId, manifest },
        preparedContextPack: contextPack,
        preparedExploratoryContextPack: closure,
        selectedCascadeTier: 'exploratory_sql',
        exploratoryCandidateIds: candidateIds,
        messages: [{ role: 'user', content: question }],
        prepareExploratorySqlExecution: prepare,
        executeAgenticGeneratedSql: execute,
      }, (turn) => turns.push(turn as typeof turns[number]), new AbortController().signal);

      expect(calls).toHaveLength(1);
      expect(calls[0]!.map((message) => message.content).join('\n')).not.toContain('jaffle_shop.dev.order_items');
      expect(prepare).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      const answer = turns.find((turn) => turn.kind === 'tool_result' && turn.id === 'governed_answer')?.output as {
        kind?: string;
        executionError?: string;
        refusalCode?: string;
        proposedSql?: string;
        sql?: string;
        dqlArtifact?: unknown;
      } | undefined;
      expect(answer?.kind).toBe('no_answer');
      expect(`${answer?.executionError ?? ''} ${answer?.refusalCode ?? ''}`).toMatch(/outside|context|grounding/i);
      expect(answer?.proposedSql).toBeUndefined();
      expect(answer?.sql).toBeUndefined();
      expect(answer?.dqlArtifact).toBeUndefined();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('fails closed before provider dispatch when a supplied exploratory closure has another snapshot', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-provider-exploratory-other-snapshot-'));
    try {
      cpSync(join(process.cwd(), 'test', 'fixtures', 'jaffle-supply-chain'), projectRoot, { recursive: true });
      const question = 'what is the order count for each customer?';
      const { contextPack, candidateIds, closure } = await customerExploratoryClosure(projectRoot, question);
      const manifest = buildManifest({ projectRoot, dbtManifestPath: join(projectRoot, 'target', 'manifest.json') });
      const provider = {
        name: 'claude' as const,
        available: async () => true,
        generate: vi.fn(async () => {
          throw new Error('A mismatched closure must not reach the provider.');
        }),
      } satisfies AgentProvider;
      const prepare = vi.fn(async () => {
        throw new Error('A mismatched closure must not mint a capability.');
      });
      const execute = vi.fn(async () => {
        throw new Error('A mismatched closure must not execute SQL.');
      });
      const turns: Array<{ kind: string; [key: string]: unknown }> = [];
      await createDqlAgentProviderRunner('ollama', provider).run({
        provider: 'ollama',
        projectRoot,
        agentRunId: 'other-snapshot-run',
        projectSnapshot: { snapshotId: contextPack.knowledgeLens.snapshotId, manifest },
        preparedContextPack: contextPack,
        preparedExploratoryContextPack: {
          ...closure,
          knowledgeLens: { ...closure.knowledgeLens, snapshotId: 'another-snapshot' },
        },
        selectedCascadeTier: 'exploratory_sql',
        exploratoryCandidateIds: candidateIds,
        messages: [{ role: 'user', content: question }],
        prepareExploratorySqlExecution: prepare,
        executeAgenticGeneratedSql: execute,
      }, (turn) => turns.push(turn as typeof turns[number]), new AbortController().signal);

      expect(provider.generate).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      const answer = turns.find((turn) => turn.kind === 'tool_result' && turn.id === 'governed_answer')?.output as {
        kind?: string;
        refusalDetails?: { code?: string };
        proposedSql?: string;
        sql?: string;
        dqlArtifact?: unknown;
      } | undefined;
      expect(answer).toMatchObject({
        kind: 'no_answer',
        refusalDetails: { code: 'EXPLORATORY_CLOSURE_MISMATCH' },
      });
      expect(answer?.proposedSql).toBeUndefined();
      expect(answer?.sql).toBeUndefined();
      expect(answer?.dqlArtifact).toBeUndefined();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('allows three text tools and a final SQL response under the ordinary four-dispatch wrapper cap', async () => {
    // This exercises the actual provider-runner wrapper, not just the generic
    // text loop: historically the runner silently replaced the loop options
    // with maxProviderDispatches=4 while the analyst was allowed to schedule
    // four tools plus a final response.
    const root = mkdtempSync(join(tmpdir(), 'dql-provider-runner-budget-'));
    try {
      cpSync(join(process.cwd(), 'test', 'fixtures', 'jaffle-supply-chain'), root, { recursive: true });
      const configPath = join(root, 'dql.config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      config.agent = { orchestrator: { mode: 'agentic', lanes: ['generated'], maxIterations: 8 } };
      writeFileSync(configPath, `${JSON.stringify(config)}\n`);

      const replies = [
        '```json\n{"tool":"get_table_schema","input":{"table":"order_items"}}\n```',
        '```json\n{"tool":"get_table_schema","input":{"table":"order_items"}}\n```',
        '```json\n{"tool":"get_table_schema","input":{"table":"order_items"}}\n```',
        '```json\n{"summary":"final SQL after three observations","sql":"SELECT 1 FROM order_items","outputs":["value"]}\n```',
      ];
      const calls: AgentMessage[][] = [];
      const provider: AgentProvider = {
        name: 'ollama',
        available: async () => true,
        generate: async (messages, options?: ProviderToolLoopOptions) => {
          calls.push(messages);
          options?.onProviderDispatch?.({
            provider: 'ollama', operation: 'generate', attemptIndex: 1, envelope: { messages },
          });
          const reply = replies[calls.length - 1];
          if (!reply) throw new Error('unexpected provider dispatch after reserved final response');
          return reply;
        },
      };
      const manifest = buildManifest({ projectRoot: root, dbtManifestPath: join(root, 'target', 'manifest.json') });
      const turns: Array<{ kind: string; [key: string]: unknown }> = [];
      await createDqlAgentProviderRunner('ollama', provider).run({
        provider: 'ollama',
        projectRoot: root,
        agentRunId: 'budget-run',
        projectSnapshot: { snapshotId: 'snapshot-budget', manifest },
        // The runner normally receives this frozen server plan from the host.
        // The test only needs its stable IDs so the analyst handoff remains
        // capability-bound and never falls back to a second provider call.
        resolvedAnalyticalPlan: { planId: 'plan-budget', snapshotId: 'snapshot-budget' } as never,
        generatedProposalTargetFingerprint: 'target-budget',
        // Skip retrieval/reranking so this isolates the runner's answer-stage
        // physical dispatch allowance. The prebuilt pack is server-owned in
        // production too, when route planning already prepared one.
        preparedContextPack: {
          id: 'pack-budget',
          question: 'show order items',
          focusObjectKey: null,
          mode: 'question',
          questionPlan: buildAnalysisQuestionPlan('show order items'),
          objects: [],
          skills: [],
          knowledgeLens: { snapshotId: 'snapshot-budget' },
          edges: [],
          queryRuns: [],
          citations: [],
          evidenceSummaries: [],
          warnings: [],
          routeDecision: { route: 'generated_sql' },
          evidenceRoles: [],
          allowedSqlContext: {
            relations: [{
              relation: 'order_items', name: 'order_items', columns: [],
              source: 'test', columnCompleteness: 'complete',
            }],
            sourceBlockSql: [],
          },
          missingContext: [],
          conflicts: [],
          appliedHints: [],
          retrievalDiagnostics: { strategy: 'sqlite_fts', lanes: [], selectedObjects: 0, selectedEvidence: [] },
        } as never,
        messages: [{ role: 'user', content: 'show order items' }],
      }, (turn) => turns.push(turn as typeof turns[number]), new AbortController().signal);

      expect(calls).toHaveLength(4);
      expect(calls[0]!.map((message) => message.content).join('\n')).toContain('at most 3 tool call');
      expect(calls[3]!.map((message) => message.content).join('\n')).toContain('Tool budget reached');
      expect(turns.find((turn) => turn.kind === 'error')).toBeUndefined();
      const governed = turns.find((turn) => turn.kind === 'tool_result' && turn.id === 'governed_answer');
      // The minimal frozen-plan fixture deliberately has no executable plan
      // body, but the checked ledger receipt proves the fourth reply's SQL was
      // parsed and accepted by the analyst rather than being lost to the
      // wrapper cap before final composition.
      expect((governed?.output as { evidence?: { route?: unknown[] } } | undefined)?.evidence?.route)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ tool: 'identifier_ledger', status: 'checked' }),
        ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('agent configuration freshness', () => {
  it('invalidates the local agent config cache after a settings write', () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-agent-config-freshness-'));
    try {
      const configPath = join(root, 'dql.config.json');
      writeFileSync(configPath, JSON.stringify({ agent: { orchestrator: { mode: 'legacy' } } }));
      expect(__test__.readAgentConfig(root)).toMatchObject({ orchestrator: { mode: 'legacy' } });

      // Different content length makes this deterministic even on filesystems
      // whose mtime resolution is coarser than one millisecond.
      writeFileSync(configPath, JSON.stringify({ agent: { orchestrator: { mode: 'agentic', lanes: ['generated'] } } }));
      expect(__test__.readAgentConfig(root)).toMatchObject({
        orchestrator: { mode: 'agentic', lanes: ['generated'] },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('provider boundary diagnostics', () => {
  it.each([
    ['AUTHENTICATION_FAILED', 'missing API key', 'authentication'],
    ['MODEL_NOT_FOUND', 'requested model not found', 'model_not_found'],
    ['GATEWAY_503', 'gateway returned 503', 'gateway'],
    ['PROVIDER_TIMEOUT', 'provider timed out', 'provider_timeout'],
    ['ADMISSION_DENIED', 'dispatch admission denied', 'admission_denied'],
    ['PROVIDER_DISPATCH_BUDGET', 'provider dispatch budget exhausted', 'dispatch_budget'],
  ])('captures %s at the provider boundary as a redacted diagnostic', (code, message, cause) => {
    const diagnostic = __test__.providerBoundaryDiagnostic({
      providerId: 'openai',
      projectRoot: '/tmp/dql-provider-diagnostic',
      phase: 'generation',
      error: Object.assign(new Error(message), { code }),
    });
    expect(diagnostic).toMatchObject({ version: 1, cause, phase: 'generation' });
    expect(diagnostic.providerFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(diagnostic)).not.toContain('openai');
    expect(JSON.stringify(diagnostic)).not.toContain(message);
  });

  it('records preflight readiness without retaining the endpoint or model', () => {
    const diagnostic = __test__.providerBoundaryDiagnostic({
      providerId: 'ollama',
      projectRoot: '/tmp/dql-provider-diagnostic',
      phase: 'preflight',
      error: new Error('connection refused http://localhost:11434'),
      code: 'NETWORK_FAILURE',
    });
    expect(diagnostic).toMatchObject({ cause: 'network', phase: 'preflight', retryable: true });
    expect(JSON.stringify(diagnostic)).not.toContain('localhost');
  });
});

describe('lazy schema loading', () => {
  const pack = (overrides: Record<string, unknown> = {}) => ({
    routeDecision: { route: 'generated_sql' },
    questionPlan: { requestedShape: { filters: [] } },
    objects: [],
    allowedSqlContext: { relations: [{ relation: 'analytics.orders' }], sourceBlockSql: [] },
    ...overrides,
  } as never);

  it('does not touch the warehouse for certified questions but verifies generated relation columns', () => {
    expect(__test__.shouldLoadSchemaContext(pack({ routeDecision: { route: 'certified' } }), true)).toBe(false);
    expect(__test__.shouldLoadSchemaContext(pack(), false)).toBe(true);
  });

  it('verifies semantic relation columns and loads schema for unresolved filters or empty context', () => {
    expect(__test__.shouldLoadSchemaContext(pack({ objects: [{ objectType: 'metric' }] }), true)).toBe(true);
    expect(__test__.shouldLoadSchemaContext(pack({
      questionPlan: { requestedShape: { filters: ['enterprise'] } },
    }), true)).toBe(true);
    expect(__test__.shouldLoadSchemaContext(pack({
      allowedSqlContext: { relations: [], sourceBlockSql: [] },
    }), false)).toBe(true);
    expect(__test__.shouldLoadSchemaContext(pack({
      objects: [{ objectType: 'metric' }],
      allowedSqlContext: { relations: [], sourceBlockSql: [{ name: 'trusted_block', sql: 'select 1' }] },
    }), true)).toBe(false);
  });

  it('uses live source search only when indexed retrieval is thin', () => {
    expect(__test__.shouldSearchProjectFiles(pack({ routeDecision: { route: 'certified' } }))).toBe(false);
    expect(__test__.shouldSearchProjectFiles(pack({
      objects: [{ objectType: 'metric' }, { objectType: 'semantic_model' }],
    }))).toBe(false);
    expect(__test__.shouldSearchProjectFiles(pack({
      objects: [],
      allowedSqlContext: { relations: [], sourceBlockSql: [] },
    }))).toBe(true);
  });

  it('renders bounded source matches as advisory context', () => {
    expect(__test__.renderProjectSourceSearch({
      matches: [{ path: 'semantic/metrics.yml', line: 4, text: 'name: net_revenue' }],
    })).toContain('semantic/metrics.yml:4');
  });
});

describe('governed answer formatting', () => {
  it('formats the terminal cascade lane for CLI and agent traces', () => {
    expect(__test__.formatCascadeOutcome({
      terminalLane: 'semantic',
      routeTier: 'semantic_metric',
      label: 'Lane 2 semantic DQL artifact was terminal',
      outcome: { lane: 'semantic', routeTier: 'semantic_metric' },
    })).toBe('Lane 2 semantic · Semantic metric');

    expect(__test__.formatCascadeOutcome({
      terminalLane: 'generated',
      routeTier: 'generated_sql',
      label: 'Lane 3 generated DQL artifact was terminal',
      outcome: { lane: 'generated', routeTier: 'generated_sql', hasSqlPreview: true, executionStatus: 'executed' },
    })).toBe('Lane 3 generated · Generated SQL');
  });
});

describe('drilldown classification', () => {
  // A drilldown INHERITS the prior turn's filters and dimensions, so the bar has
  // to be a reference to that turn. Firing on a bare `by`/`for`/`only`/`where`
  // made nearly every new analytical question a drilldown of whatever came
  // before, which silently applied stale filters to it.
  it('does not classify a new analytical question as a drilldown', () => {
    for (const question of [
      'Show revenue by region',
      'Revenue for enterprise accounts',
      'List customers where status is active',
      'Compare margin across channels',
    ]) {
      expect(__test__.isDrilldownFollowUp(question, []), question).toBe(false);
    }
  });

  it('classifies an explicit drill or deictic reference as a drilldown', () => {
    for (const question of [
      'break that down by region',
      'why did it drop',
      'show the drivers of the decline',
      'slice this by segment',
      'show me their orders',
    ]) {
      expect(__test__.isDrilldownFollowUp(question, []), question).toBe(true);
    }
  });

  // A pre-existing guard keeps definition questions ("what is/what are …") out
  // of the drilldown lane, so a drill noun phrased that way stays contextual.
  it('leaves definition-shaped questions out of the drilldown lane', () => {
    expect(__test__.isDrilldownFollowUp('what are the drivers', [])).toBe(false);
    expect(__test__.isDrilldownFollowUp('what is net revenue', [])).toBe(false);
  });

  // Evidence beats vocabulary: reusing the prior RESULT's own column names is a
  // reference to that result whatever words the question uses.
  it('treats reuse of the prior result shape as a drilldown', () => {
    const priorTerms = ['customer', 'beverage', 'revenue'];
    expect(__test__.isDrilldownFollowUp('who are the customers by region', priorTerms)).toBe(true);
    // The same phrasing with no shared shape is a new question.
    expect(__test__.isDrilldownFollowUp('who are the customers by region', ['shipment', 'warehouse'])).toBe(false);
  });
});

describe('conversation context follow-up routing', () => {
  it('AGT-021 carries every prior semantic metric for "other metrics" follow-ups', () => {
    const metrics = [
      'percent_dod_eu_core_ccu_acm_qty',
      'percent_dod_eu_core_ccu_bcm',
      'percent_dod_eu_core_ccu_bcm_qty',
      'percent_dod_legacy_acm_qty',
      'percent_dod_legacy_bcm',
    ];
    const question = 'what about other metrics?';
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: question }],
      conversationContext: {
        conversationStateVersion: 1,
        activeTurnId: 'turn_metrics',
        turns: [{
          id: 'turn_metrics',
          question: 'show all five metrics for Capital One',
          dqlArtifact: {
            kind: 'semantic_block',
            name: 'capital_one_metrics',
            source: 'block "capital_one_metrics" { type = "semantic" metrics = [] dimensions = [] }',
            metrics,
            dimensions: [],
          },
          result: {
            columns: ['metric_time__day', ...metrics],
            measureColumns: metrics,
          },
        }],
      },
    } as AgentRunRequest, question);

    expect(followUp?.kind).toBe('generic');
    expect(followUp?.priorMeasures).toEqual(metrics);
    expect(followUp?.priorDqlArtifact?.metrics).toEqual(metrics);
  });

  it('AGT-012 binds an explicitly named prior product as a typed drilldown member', () => {
    const question = 'who are the customer from flame impala';
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: question }],
      conversationContext: {
        conversationStateVersion: 1,
        activeTurnId: 'turn_products',
        turns: [{
          id: 'turn_products',
          question: 'what are the top most product revenue by region?',
          result: {
            columns: ['product_name', 'region', 'revenue'],
            dimensionValues: {
              product_name: ['flame impala', 'vanilla ice'],
              region: ['Philadelphia'],
            },
            measureColumns: ['revenue'],
          },
        }],
      },
    } as AgentRunRequest, question);

    expect(followUp).toMatchObject({
      kind: 'drilldown',
      filters: ['flame impala'],
      dimensions: expect.arrayContaining(['customer', 'product']),
      priorResultValues: { product_name: ['flame impala'] },
      memberBindings: [{
        dimension: 'product',
        values: ['flame impala'],
        source: 'prior_result',
        confidence: 'exact',
        sourceTurnId: 'turn_products',
      }],
      resolvedReferences: ['product: flame impala'],
    });
  });

  it('AGT-012 does not resolve a member from a generic question word inside an unrelated value', () => {
    const question = 'who are the customer from flame impala';
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: question }],
      conversationContext: {
        conversationStateVersion: 1,
        activeTurnId: 'turn_products',
        turns: [{
          id: 'turn_products',
          question: 'what are the top most product revenue by region?',
          result: {
            columns: ['product_name', 'region', 'revenue'],
            dimensionValues: {
              product_name: ['nutellaphone who dis?', 'vanilla ice'],
              region: ['Philadelphia'],
            },
            measureColumns: ['revenue'],
          },
        }],
      },
    } as AgentRunRequest, question);

    expect(followUp?.memberBindings).toBeUndefined();
    expect(followUp?.filters ?? []).not.toContain('nutellaphone who dis?');
    expect(followUp?.priorResultValues).toEqual({
      product_name: ['nutellaphone who dis?', 'vanilla ice'],
      region: ['Philadelphia'],
    });
  });

  it('resolves a shortened named member and drops stale block shape for a relative comparison', () => {
    const question = 'Who are the other customers who paid less tax than Melissa?';
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: question }],
      conversationContext: {
        conversationStateVersion: 1,
        activeTurnId: 'turn_beverage',
        turns: [
          {
            id: 'turn_beverage',
            question: 'Who are the top beverage customers?',
            answerSummary: 'Melissa Lopez leads beverage revenue.',
            sourceCertifiedBlock: 'top_beverage_customers',
            requestedFilters: ['beverage'],
            requestedDimensions: ['customer'],
            requestedMeasures: ['beverage_revenue'],
            topN: 10,
            result: {
              columns: ['customer_name', 'beverage_revenue'],
              dimensionValues: { customer_name: ['Melissa Lopez', 'Joy Lam'] },
              measureColumns: ['beverage_revenue'],
            },
          },
        ],
      },
    } as AgentRunRequest, question);

    expect(followUp).toMatchObject({
      kind: 'drilldown',
      filters: ['Melissa Lopez'],
      dimensions: ['customer'],
      priorResultValues: { customer_name: ['Melissa Lopez'] },
      resolvedReferences: ['customer: Melissa Lopez'],
    });
    expect(followUp?.sourceBlockName).toBeUndefined();
    expect(followUp?.sourceQuestion).toBeUndefined();
    expect(followUp?.priorResultColumns).toBeUndefined();
    expect(followUp?.priorDqlArtifact).toBeUndefined();
    expect(followUp?.priorMeasures).toBeUndefined();
    expect(followUp?.priorLimit).toBeUndefined();
    expect(followUp?.filters).not.toContain('beverage');
    expect(followUp?.filters).not.toContain('Joy Lam');
  });

  it('does not guess a shortened member when multiple prior values share it', () => {
    const question = 'Show orders for Melissa';
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: question }],
      conversationContext: {
        resultColumns: ['customer_name', 'orders'],
        resultDimensionValues: { customer_name: ['Melissa Lopez', 'Melissa Moore'] },
      },
    } as AgentRunRequest, question);

    expect(followUp?.priorResultValues).toEqual({
      customer_name: ['Melissa Lopez', 'Melissa Moore'],
    });
    expect(followUp?.filters).toBeUndefined();
  });

  it('resolves "these categories" to prior result values and dimensions', () => {
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: 'who are the top 5 customers for these categories?' }],
      conversationContext: {
        sourceCertifiedBlock: 'food_vs_drink_revenue',
        sourceQuestion: 'Revenue by food vs drink',
        sourceAnswerSummary: 'Food and Drink revenue split.',
        resultColumns: ['category', 'revenue'],
        resultDimensionValues: { category: ['Food', 'Drink'] },
        priorMeasures: ['revenue'],
      },
    } as AgentRunRequest, 'who are the top 5 customers for these categories?');

    expect(followUp).toMatchObject({
      kind: 'drilldown',
      sourceBlockName: 'food_vs_drink_revenue',
      filters: ['Food', 'Drink'],
      dimensions: ['category'],
      priorResultColumns: ['category', 'revenue'],
      priorResultValues: { category: ['Food', 'Drink'] },
      priorMeasures: ['revenue'],
    });
  });

  it('resolves bare "those" when prior values have one clear dimension', () => {
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: 'who are the top 5 customers for those?' }],
      conversationContext: {
        sourceCertifiedBlock: 'food_vs_drink_revenue',
        sourceQuestion: 'Revenue by food vs drink',
        sourceAnswerSummary: 'Food and Drink revenue split.',
        resultColumns: ['category', 'revenue'],
        resultDimensionValues: { category: ['Food', 'Drink'] },
        priorMeasures: ['revenue'],
      },
    } as AgentRunRequest, 'who are the top 5 customers for those?');

    expect(followUp).toMatchObject({
      kind: 'drilldown',
      filters: ['Food', 'Drink'],
      dimensions: ['category'],
      priorResultValues: { category: ['Food', 'Drink'] },
    });
  });

  it('resolves "they" to customers before catalog search in a value follow-up', () => {
    const question = 'what product they bought for this amount?';
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: question }],
      conversationContext: {
        sourceQuestion: 'Who are the customers with the least revenue by product?',
        resultColumns: ['customer_name', 'product_name', 'revenue'],
        resultDimensionValues: {
          customer_name: ['Adele Ace'],
          product_name: ['Vanilla Ice'],
        },
        priorMeasures: ['revenue'],
      },
    } as AgentRunRequest, question);

    expect(followUp?.kind).toBe('drilldown');
    expect(followUp?.filters).toEqual(expect.arrayContaining(['Adele Ace']));
    expect(followUp?.dimensions).toEqual(expect.arrayContaining(['customer', 'product']));
    expect(followUp?.resolvedReferences).toEqual(expect.arrayContaining(['customer: Adele Ace']));
    expect(followUp?.priorMeasures).toEqual(['revenue']);
  });

  it('AGT-031 resolves singular people pronouns to one prior customer for attribute lookup', () => {
    const question = 'what region he belongs to?';
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: question }],
      conversationContext: {
        conversationStateVersion: 1,
        activeTurnId: 'turn_customer',
        turns: [{
          id: 'turn_customer',
          question: 'Who are the top customers for each product who have highest revenue?',
          result: {
            columns: ['product_name', 'customer_name', 'revenue'],
            dimensionValues: {
              product_name: ['doctor stew'],
              customer_name: ['Jessica Richard'],
            },
            measureColumns: ['revenue'],
          },
        }],
      },
    } as AgentRunRequest, question);

    expect(followUp).toMatchObject({
      kind: 'drilldown',
      filters: ['Jessica Richard'],
      dimensions: expect.arrayContaining(['customer', 'region']),
      memberBindings: [{
        dimension: 'customer',
        values: ['Jessica Richard'],
        source: 'prior_result',
        confidence: 'deictic',
        sourceTurnId: 'turn_customer',
      }],
      resolvedReferences: ['customer: Jessica Richard'],
    });
  });

  it('asks which product was meant instead of binding the first prior row', () => {
    // The prior answer showed TWO products. "this product" does not identify
    // one of them, and silently filtering on whichever sorted first invents an
    // intent the user never expressed — the reported dead-end follow-up.
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: 'who are the customers for this product?' }],
      conversationContext: {
        sourceQuestion: 'Top products by revenue',
        sourceAnswerSummary: 'Revenue is concentrated in top drink products.',
        resultColumns: ['product_name', 'category', 'revenue', 'units'],
        resultDimensionValues: {
          product_name: ['for richer or pourover', 'vanilla ice'],
          category: ['Drink'],
        },
        priorMeasures: ['revenue'],
      },
    } as AgentRunRequest, 'who are the customers for this product?');

    expect(followUp?.filters).toBeUndefined();
    expect(followUp).toMatchObject({
      dimensions: ['product'],
      deicticChoices: {
        dimension: 'product',
        values: ['for richer or pourover', 'vanilla ice'],
      },
      priorResultColumns: ['product_name', 'category', 'revenue', 'units'],
      priorMeasures: ['revenue'],
    });
  });

  it('still binds a singular reference when the prior result named exactly one', () => {
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: 'who are the customers for this product?' }],
      conversationContext: {
        sourceQuestion: 'Best selling product',
        resultColumns: ['product_name', 'revenue'],
        resultDimensionValues: { product_name: ['vanilla ice'] },
        priorMeasures: ['revenue'],
      },
    } as AgentRunRequest, 'who are the customers for this product?');

    expect(followUp).toMatchObject({
      kind: 'drilldown',
      filters: ['vanilla ice'],
      dimensions: ['product'],
    });
    expect(followUp?.deicticChoices).toBeUndefined();
  });

  it('does not turn ordinary "the customers" wording into prior-result member filters', () => {
    const question = 'who are the customers have top region';
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: question }],
      conversationContext: {
        sourceQuestion: 'who are the top revenue customers?',
        sourceAnswerSummary: 'Melissa Lopez and Joy Lam lead beverage revenue.',
        resultColumns: ['customer_name', 'beverage_revenue'],
        resultDimensionValues: {
          customer_name: ['Melissa Lopez', 'Joy Lam'],
        },
        priorMeasures: ['beverage_revenue'],
      },
    } as AgentRunRequest, question);

    expect(followUp).toMatchObject({
      kind: 'drilldown',
      dimensions: ['region'],
      priorResultValues: {
        customer_name: ['Melissa Lopez', 'Joy Lam'],
      },
    });
    expect(followUp?.filters).toBeUndefined();
    expect(followUp?.memberBindings).toBeUndefined();
    expect(followUp?.resolvedReferences).toBeUndefined();

    const plan = buildAnalysisQuestionPlan(question, followUp);
    expect(plan.requestedShape.filters).toEqual([]);
    expect(plan.requestedShape.memberBindings).toEqual([]);
    expect(plan.requestedShape.dimensions).toEqual(expect.arrayContaining(['customer', 'region']));
  });

  it('still carries prior members when the question explicitly says "these customers"', () => {
    const question = 'which regions have these customers';
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: question }],
      conversationContext: {
        sourceQuestion: 'who are the top revenue customers?',
        resultColumns: ['customer_name', 'beverage_revenue'],
        resultDimensionValues: {
          customer_name: ['Melissa Lopez', 'Joy Lam'],
        },
        priorMeasures: ['beverage_revenue'],
      },
    } as AgentRunRequest, question);

    expect(followUp).toMatchObject({
      kind: 'drilldown',
      filters: ['Melissa Lopez', 'Joy Lam'],
      memberBindings: [{
        dimension: 'customer',
        values: ['Melissa Lopez', 'Joy Lam'],
        source: 'prior_result',
        confidence: 'deictic',
      }],
    });
  });

  it('resolves misspelled category follow-up over prior customers', () => {
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: 'what are the product catagories for these customers' }],
      conversationContext: {
        sourceQuestion: 'Top products by revenue with customers',
        sourceAnswerSummary: 'Product/customer revenue view.',
        resultColumns: ['product_name', 'category', 'customer_name', 'revenue', 'units'],
        resultDimensionValues: {
          product_name: ['for richer or pourover', 'vanilla ice'],
          category: ['Drink'],
          customer_name: ['Mr. Matthew Meyer', 'Aaron Gardner'],
        },
        priorMeasures: ['revenue'],
      },
    } as AgentRunRequest, 'what are the product catagories for these customers');

    expect(followUp).toMatchObject({
      kind: 'drilldown',
      filters: ['Mr. Matthew Meyer', 'Aaron Gardner'],
      priorResultColumns: ['product_name', 'category', 'customer_name', 'revenue', 'units'],
      priorResultValues: {
        product_name: ['for richer or pourover', 'vanilla ice'],
        category: ['Drink'],
        customer_name: ['Mr. Matthew Meyer', 'Aaron Gardner'],
      },
      priorMeasures: ['revenue'],
    });
    expect(followUp?.dimensions).toEqual(expect.arrayContaining(['customer']));
  });

  it('resolves follow-ups from structured conversation turns without legacy flat fields', () => {
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: 'what are the product categories for these customers' }],
      conversationContext: {
        conversationStateVersion: 1,
        activeTurnId: 'turn_customers',
        turns: [
          {
            id: 'turn_products',
            question: 'Top products by revenue',
            answerSummary: 'Top product is for richer or pourover.',
            result: {
              columns: ['product_name', 'category', 'revenue'],
              dimensionValues: {
                product_name: ['for richer or pourover'],
                category: ['Drink'],
              },
              measureColumns: ['revenue'],
            },
            sourceSql: 'SELECT product_name, category, revenue FROM analytics.product_revenue ORDER BY revenue DESC',
          },
          {
            id: 'turn_customers',
            question: 'who are the customers for this product?',
            answerSummary: 'Customers for for richer or pourover.',
            result: {
              columns: ['customer_name', 'product_name', 'revenue'],
              dimensionValues: {
                customer_name: ['Mr. Matthew Meyer', 'Aaron Gardner'],
                product_name: ['for richer or pourover'],
              },
              measureColumns: ['revenue'],
            },
          },
        ],
      },
    } as AgentRunRequest, 'what are the product categories for these customers');

    expect(followUp).toMatchObject({
      kind: 'drilldown',
      sourceTurnId: 'turn_customers',
      sourceQuestion: 'who are the customers for this product?',
      filters: ['Mr. Matthew Meyer', 'Aaron Gardner'],
      dimensions: expect.arrayContaining(['customer']),
      priorResultColumns: ['customer_name', 'product_name', 'revenue'],
      priorResultValues: {
        customer_name: ['Mr. Matthew Meyer', 'Aaron Gardner'],
        product_name: ['for richer or pourover'],
      },
      priorMeasures: ['revenue'],
    });
  });

  it('carries a named prior result ref with schema, row count, and source SQL', () => {
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: 'can you include product details with previous results and give final' }],
      conversationContext: {
        conversationStateVersion: 1,
        activeTurnId: 'turn_products',
        turns: [
          {
            id: 'turn_products',
            question: 'give me product and supply info',
            answerSummary: 'Product to supply breakdown.',
            result: {
              columns: ['product_id', 'supply_id', 'supply_name', 'supply_cost'],
              rowCount: 65,
              dimensionValues: {
                product_id: ['BEV-001', 'JAF-001'],
                supply_id: ['SUP-005', 'SUP-009'],
              },
              measureColumns: ['supply_cost'],
            },
            sourceSql: 'SELECT product_id, supply_id, supply_name, supply_cost FROM analytics.product_supplies ORDER BY supply_cost DESC LIMIT 10',
            dqlArtifact: {
              kind: 'sql_block',
              name: 'product_supply_breakdown',
              source: 'block "product_supply_breakdown" {\n  type = "custom"\n  query = """SELECT product_id, supply_id, supply_name, supply_cost FROM analytics.product_supplies ORDER BY supply_cost DESC LIMIT 10"""\n}',
              orderBy: [{ name: 'supply_cost', direction: 'desc' }],
              limit: 10,
            },
          },
        ],
      },
    } as AgentRunRequest, 'can you include product details with previous results and give final');

    expect(followUp).toMatchObject({
      kind: 'generic',
      priorResultRef: {
        id: 'turn_products',
        question: 'give me product and supply info',
        columns: ['product_id', 'supply_id', 'supply_name', 'supply_cost'],
        rowCount: 65,
        sourceSql: 'SELECT product_id, supply_id, supply_name, supply_cost FROM analytics.product_supplies ORDER BY supply_cost DESC LIMIT 10',
      },
      priorDqlArtifact: {
        kind: 'sql_block',
        name: 'product_supply_breakdown',
        source: expect.stringContaining('block "product_supply_breakdown"'),
        orderBy: [{ name: 'supply_cost', direction: 'desc' }],
        limit: 10,
      },
    });

    const rewritten = __test__.rewriteFollowUpQuestion('can you include product details with previous results and give final', followUp);
    expect(rewritten).toBe('can you include product details with previous results and give final');
    expect(rewritten).not.toContain('Prior result ref');
    expect(rewritten).not.toContain('source_sql');
    expect(rewritten).not.toContain('Prior DQL artifact');
  });

  it('can bind a follow-up to a semantically recalled older result instead of an unrelated active turn', () => {
    const question = 'can you include product details with previous results and give final';
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: question }],
      conversationContext: {
        conversationStateVersion: 1,
        activeTurnId: 'turn_signups',
        turns: [
          {
            id: 'turn_signups',
            question: 'how many signups last quarter',
            answerSummary: 'There were 412 signups.',
            result: {
              columns: ['quarter', 'signups'],
              dimensionValues: { quarter: ['Q2'] },
              measureColumns: ['signups'],
              rowCount: 1,
            },
          },
        ],
        serverSnapshot: {
          threadId: 'thread_products',
          recentTurns: [
            {
              id: 'turn_signups',
              question: 'how many signups last quarter',
              answerSummary: 'There were 412 signups.',
              resultColumns: ['quarter', 'signups'],
              resultRowCount: 1,
              resultDimensionValues: { quarter: ['Q2'] },
            },
          ],
          recalledTurns: [
            {
              id: 'turn_supply',
              question: 'give me product and supply info',
              answerSummary: 'Product to supply breakdown.',
              resultColumns: ['product_id', 'supply_id', 'supply_name', 'supply_cost'],
              resultRowCount: 65,
              resultDimensionValues: {
                product_id: ['BEV-001', 'JAF-001'],
                supply_id: ['SUP-005', 'SUP-009'],
              },
              sourceSql: 'SELECT product_id, supply_id, supply_name, supply_cost FROM analytics.product_supplies',
              dqlArtifact: {
                kind: 'sql_block',
                name: 'product_supply_breakdown',
                source: 'block "product_supply_breakdown" {\n  type = "custom"\n}',
              },
            },
          ],
        },
      },
    } as AgentRunRequest, question);

    expect(followUp).toMatchObject({
      kind: 'generic',
      sourceTurnId: 'turn_supply',
      sourceQuestion: 'give me product and supply info',
      priorResultColumns: ['product_id', 'supply_id', 'supply_name', 'supply_cost'],
      priorResultValues: {
        product_id: ['BEV-001', 'JAF-001'],
        supply_id: ['SUP-005', 'SUP-009'],
      },
      priorResultRef: {
        id: 'turn_supply',
        rowCount: 65,
        sourceSql: 'SELECT product_id, supply_id, supply_name, supply_cost FROM analytics.product_supplies',
      },
      priorDqlArtifact: {
        kind: 'sql_block',
        name: 'product_supply_breakdown',
      },
    });
  });

  it('resolves above-order references to prior customer rows', () => {
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: 'what the are the products and sub catogories for the above orders' }],
      conversationContext: {
        conversationStateVersion: 1,
        activeTurnId: 'turn_customers',
        turns: [
          {
            id: 'turn_customers',
            question: 'top customers by lifetime spend',
            answerSummary: 'Top customers are Matthew Meyer and Aaron Gardner.',
            result: {
              columns: ['customer_name', 'orders', 'lifetime_spend'],
              dimensionValues: {
                customer_name: ['Mr. Matthew Meyer', 'Aaron Gardner'],
              },
              measureColumns: ['lifetime_spend', 'orders'],
            },
          },
        ],
      },
    } as AgentRunRequest, 'what the are the products and sub catogories for the above orders');

    expect(followUp).toMatchObject({
      kind: 'drilldown',
      sourceTurnId: 'turn_customers',
      filters: ['Mr. Matthew Meyer', 'Aaron Gardner'],
      dimensions: expect.arrayContaining(['customer']),
      priorResultColumns: ['customer_name', 'orders', 'lifetime_spend'],
      priorResultValues: {
        customer_name: ['Mr. Matthew Meyer', 'Aaron Gardner'],
      },
      priorMeasures: ['lifetime_spend', 'orders'],
    });
  });

  it('treats combine-previous-results requests as generic follow-ups', () => {
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: "let's combine these results with two previous outputs and give final" }],
      conversationContext: {
        conversationStateVersion: 1,
        activeTurnId: 'turn_products',
        turns: [
          {
            id: 'turn_products',
            question: 'top products by revenue',
            answerSummary: 'Top products by revenue.',
            result: {
              columns: ['product_name', 'category', 'revenue'],
              dimensionValues: {
                product_name: ['for richer or pourover'],
                category: ['Drink'],
              },
              measureColumns: ['revenue'],
            },
          },
        ],
      },
    } as AgentRunRequest, "let's combine these results with two previous outputs and give final");

    expect(followUp).toMatchObject({
      kind: 'generic',
      sourceTurnId: 'turn_products',
      priorResultColumns: ['product_name', 'category', 'revenue'],
      priorResultValues: {
        product_name: ['for richer or pourover'],
        category: ['Drink'],
      },
      priorMeasures: ['revenue'],
    });
  });

  it('converts regex drilldown carry to contextual when the conversation snapshot says topic shift', () => {
    const guarded = __test__.applyTopicShiftGuard({
      kind: 'drilldown',
      sourceQuestion: 'Top products by revenue',
      filters: ['BEV-001'],
      dimensions: ['product'],
      priorResultValues: { product_id: ['BEV-001'] },
      priorMeasures: ['revenue'],
    }, { threadId: 't1', recentTurns: [], topicRelation: 'shift' } as any);

    expect(guarded).toMatchObject({
      kind: 'contextual',
      sourceQuestion: 'Top products by revenue',
    });
    expect(guarded?.filters).toBeUndefined();
    expect(guarded?.dimensions).toBeUndefined();
    expect(guarded?.priorResultValues).toBeUndefined();
    expect(guarded?.priorMeasures).toBeUndefined();
  });

  it('does not invent filters when deictic words have no prior result values', () => {
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: 'who are the top 5 customers for these categories?' }],
      conversationContext: {
        sourceCertifiedBlock: 'food_vs_drink_revenue',
        resultColumns: ['category', 'revenue'],
      },
    } as AgentRunRequest, 'who are the top 5 customers for these categories?');

    expect(followUp?.kind).toBe('drilldown');
    expect(followUp?.filters).toBeUndefined();
    expect(followUp?.dimensions).toBeUndefined();
    expect(followUp?.priorMeasures).toEqual(['revenue']);
  });
});

describe('always-on contextual carry (no regex match)', () => {
  const priorContext = {
    sourceCertifiedBlock: 'food_vs_drink_revenue',
    sourceQuestion: 'Revenue by food vs drink',
    sourceAnswerSummary: 'Food and Drink revenue split.',
    resultColumns: ['category', 'revenue'],
    resultDimensionValues: { category: ['Food', 'Drink'] },
    priorMeasures: ['revenue'],
  };

  it('carries prior-turn context as advisory "contextual" for a topic-shift question', () => {
    const question = 'how many new signups did we get last quarter?';
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: question }],
      conversationContext: priorContext,
    } as AgentRunRequest, question);

    expect(followUp?.kind).toBe('contextual');
    expect(followUp?.sourceBlockName).toBe('food_vs_drink_revenue');
    expect(followUp?.priorResultColumns).toEqual(['category', 'revenue']);
    expect(followUp?.priorResultValues).toEqual({ category: ['Food', 'Drink'] });
    // Advisory carry must never FORCE prior filters/dimensions onto a new topic.
    expect(followUp?.filters).toBeUndefined();
    expect(followUp?.dimensions).toBeUndefined();
  });

  it('carries context for a definition-style question that fails both regexes', () => {
    const question = 'what is our monthly recurring revenue?';
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: question }],
      conversationContext: priorContext,
    } as AgentRunRequest, question);

    expect(followUp?.kind).toBe('contextual');
    expect(followUp?.filters).toBeUndefined();
  });

  it('still returns undefined when there is no useful prior context (turn one stays cold)', () => {
    const question = 'how many new signups did we get last quarter?';
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: question }],
      conversationContext: { activeSurface: 'notebook' },
    } as AgentRunRequest, question);

    expect(followUp).toBeUndefined();
  });

  it('messages-only fallback carries the prior certified block as contextual', () => {
    const question = 'how many new signups did we get last quarter?';
    const followUp = __test__.inferFollowUpContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [
        { role: 'user', content: 'revenue by category' },
        { role: 'assistant', content: 'Answered from certified block food_vs_drink_revenue. Food 240877, Drink 396567.' },
        { role: 'user', content: question },
      ],
    } as AgentRunRequest, question);

    expect(followUp?.kind).toBe('contextual');
    expect(followUp?.sourceBlockName).toBe('food_vs_drink_revenue');
    expect(followUp?.filters).toBeUndefined();
    expect(followUp?.dimensions).toBeUndefined();
  });

  it('keeps classifying real drilldown follow-ups as drilldown (regexes still classify)', () => {
    const question = 'who are the top 5 customers for these categories?';
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: question }],
      conversationContext: priorContext,
    } as AgentRunRequest, question);

    expect(followUp?.kind).toBe('drilldown');
  });
});

describe('certified fit confirmation bridge', () => {
  it('asks the provider for strict fit JSON with requested shape and block context', async () => {
    const calls: AgentMessage[][] = [];
    const provider: AgentProvider = {
      name: 'openai',
      async available() {
        return true;
      },
      async generate(messages) {
        calls.push(messages);
        return '{"allow":true,"confidence":"high","reason":"block covers product usage"}';
      },
    };
    const confirm = __test__.createCertifiedFitConfirmation(provider);

    const result = await confirm({
      question: 'Show usage by product',
      questionPlan: {
        requestedShape: {
          dimensions: ['product'],
          measures: ['usage'],
          requiredOutputs: ['product', 'usage'],
          filters: [],
          followUpReferences: [],
          ambiguities: [],
        },
      } as any,
      block: {
        objectKey: 'dql:block:Legacy Product Usage',
        objectType: 'dql_block',
        name: 'Legacy Product Usage',
        status: 'certified',
        description: 'Legacy certified usage metric by product.',
        payload: {
          grain: 'product',
          dimensions: ['product'],
          llmContext: 'Use for usage by product.',
        },
      },
      fit: {
        kind: 'exact',
        confidence: 'medium',
        reasons: ['block contract was safely inferred from available metadata'],
        missingOutputs: [],
        missingDimensions: [],
        unsupportedFilters: [],
        topNAction: 'none',
        inferredContract: true,
      },
    });

    expect(result).toEqual({
      allow: true,
      confidence: 'high',
      reason: 'block covers product usage',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]?.content).toContain('strict governed analytics routing judge');
    expect(calls[0]?.[1]?.content).toContain('"requestedShape"');
    expect(calls[0]?.[1]?.content).toContain('"Legacy Product Usage"');
  });

  it('rejects malformed fit confirmation output', () => {
    expect(__test__.parseCertifiedFitConfirmation('not json')).toMatchObject({
      allow: false,
      confidence: 'low',
    });
  });
});

describe('App copilot context: the app\'s own drafts', () => {
  const appContext = {
    app: { id: 'growth', name: 'Growth Review', domain: 'growth', audience: 'CFO' },
    dashboards: [{ id: 'overview', title: 'Growth Overview', tiles: [{}, {}] }],
    drafts: [{
      name: 'customer-tax-view',
      path: 'apps/growth/drafts/customer-tax-view.dql',
      status: 'review',
      description: 'Tax paid per customer; join is declared but not certified.',
      question: 'Can you complete customers tax view',
      sql: 'SELECT c.customer_name, SUM(o.tax_paid)\nFROM customers c JOIN orders o USING (customer_id)',
    }],
  };
  const envelope = (workspaceContext: Record<string, unknown>) => JSON.stringify({ mode: 'agent_run', workspaceContext }, null, 2);

  it('renders the drafts the manifest never indexes, with their SQL and review standing', () => {
    const out = renderAppContextForPrompt(appContext) ?? '';
    expect(out).toContain('Growth Review');
    expect(out).toContain('customer-tax-view');
    expect(out).toContain('SUM(o.tax_paid)');
    expect(out).toMatch(/REVIEW-REQUIRED/);
    expect(out).toMatch(/never present one as a certified result/i);
  });

  it('carries the app context once, not twice', () => {
    // It also travels inside the serialized run envelope; rendering it as prose
    // must strip it from the JSON rather than shipping both copies.
    const req = { upstream: { sql: envelope({ surface: 'app_builder', appContext }) } } as unknown as AgentRunRequest;
    const out = renderExtraContext(req) ?? '';
    expect(out.match(/customer-tax-view/g)?.length).toBe(1);
    expect(out).toContain('"surface": "app_builder"');
  });

  it('leaves a non-app run envelope untouched', () => {
    const req = { upstream: { sql: envelope({ surface: 'modeling', domain: 'commerce' }) } } as unknown as AgentRunRequest;
    const out = renderExtraContext(req) ?? '';
    expect(out).toContain('"surface": "modeling"');
    expect(out).not.toMatch(/REVIEW-REQUIRED/);
  });

  it('ignores an envelope with no app and never throws on malformed input', () => {
    expect(renderAppContextForPrompt(undefined)).toBeUndefined();
    expect(renderAppContextForPrompt({})).toBeUndefined();
    expect(renderAppContextForPrompt({ app: {} })).toBeUndefined();
    const req = { upstream: { sql: '{ not json' } } as unknown as AgentRunRequest;
    expect(() => renderExtraContext(req)).not.toThrow();
  });
});
