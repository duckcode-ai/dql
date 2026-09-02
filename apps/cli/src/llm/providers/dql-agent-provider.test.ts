import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  attachAskTraceObserverV1,
  createAgenticSqlExecutionCapability,
  dqlToolNamesForSurface,
  scopeContextPackToExploratoryCandidateClosure,
  type AskTraceObserverV1,
  type AgentMessage,
  type AgentProvider,
  type AgentEvidenceCandidate,
  type AskAgentStateV4,
  type AskFrozenResearchChildHandleV1,
  type AskAgentRuntimeWorkspaceBridgeV2,
  type AskAgentToolWorkspaceV2,
  type AskSemanticCapabilityHandleV1,
  askV2SemanticCandidateAuthorityFingerprint,
  askV2ExecutableSemanticRoles,
  createAskToolKernelV2,
  type AgentRunBudget,
  type ProviderToolLoopOptions,
  OpenAIProvider,
  ClaudeProvider,
} from '@duckcodeailabs/dql-agent';
import {
  agentRunProviderDispatchBudgetForMode,
  RunScopedProviderDispatchEvidence,
  askV2RelationshipPathHandleId,
  assertAskV2BoundRelationshipPathsForSql,
  captureAskV2SemanticCapabilities,
} from '../../local-runtime.js';

// Vitest may be launched from the repository root, a package root, or an
// ephemeral Codex worktree.  Provider integration fixtures are package-owned;
// anchor them to this test module instead of `process.cwd()` so a caller's
// workspace discovery cannot accidentally select a stale `.claude/worktrees`
// directory or a missing root-level `test/` tree.
const providerFixtureRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../test/fixtures/jaffle-supply-chain',
);

function req(messages: Array<{ role: 'user' | 'assistant'; content: string }>): AgentRunRequest {
  return { provider: 'ollama', messages, projectRoot: '/tmp/x' } as AgentRunRequest;
}

function askV2State(candidates: AgentEvidenceCandidate[], turnClass: AskAgentStateV4['turnClass'] = 'analytics'): AskAgentStateV4 {
  const ids = candidates.map((candidate) => candidate.qualifiedId ?? candidate.id);
  return {
    version: 4,
    mode: 'authoritative_v2',
    turnClass,
    snapshotId: 'snapshot:v2-test',
    sourceFingerprint: 'sha256:v2-test',
    retainedCandidateIds: ids,
    initialCandidateIds: ids.slice(0, 24),
    expansionCandidateIds: [],
    relationshipPathHandles: [],
    conversation: { version: 2, availableResultHandleIds: [] },
    observations: [],
    tierAttempts: [],
  };
}

function askV2Workspace(candidates: AgentEvidenceCandidate[], options: {
  paths?: AskAgentStateV4['relationshipPathHandles'];
  certifiedArtifacts?: ReadonlyMap<string, unknown>;
  certifiedCompleteCandidateIds?: readonly string[];
  certifiedExecutionAvailable?: boolean;
  contextPack?: unknown;
  tierStates?: AskAgentToolWorkspaceV2['tierStates'];
  semanticCapabilities?: AskAgentToolWorkspaceV2['semanticCapabilities'];
  semanticCapabilityCollisionIds?: AskAgentToolWorkspaceV2['semanticCapabilityCollisionIds'];
  semanticRuntime?: AskAgentToolWorkspaceV2['semanticRuntime'];
  fiscalCalendar?: AskAgentToolWorkspaceV2['fiscalCalendar'];
  businessContext?: AskAgentToolWorkspaceV2['businessContext'];
  runDedicatedLineageProgram?: NonNullable<AskAgentToolWorkspaceV2['runDedicatedLineageProgram']>;
  frozenResearchChildren?: AskAgentToolWorkspaceV2['frozenResearchChildren'];
} = {}): AskAgentRuntimeWorkspaceBridgeV2 {
  const semanticCapabilities = options.semanticCapabilities ?? new Map(
    candidates
      .flatMap((candidate) => {
        const id = candidate.qualifiedId ?? candidate.id;
        const roles = askV2ExecutableSemanticRoles(candidate);
        if (!roles) return [];
        return [[id, {
          version: 1 as const,
          candidateId: id,
          runtimeName: candidate.name,
          engines: ['native'] as const,
          roles,
          fingerprint: askV2SemanticCandidateAuthorityFingerprint(candidate),
          isCurrent: () => true,
        }]];
      }),
  );
  return {
    version: 2,
    snapshotId: 'snapshot:v2-test',
    sourceFingerprint: 'sha256:v2-test',
    ...(options.certifiedExecutionAvailable === undefined
      ? {}
      : { isCertifiedExecutionAvailable: () => options.certifiedExecutionAvailable === true }),
    getContextPack: () => options.contextPack ?? {},
    getToolWorkspace: () => ({
      version: 1,
      snapshotId: 'snapshot:v2-test',
      sourceFingerprint: 'sha256:v2-test',
      candidates,
      relationshipPathHandles: options.paths ?? [],
      certifiedArtifacts: options.certifiedArtifacts,
      semanticCapabilities,
      semanticRuntime: options.semanticRuntime,
      fiscalCalendar: options.fiscalCalendar,
      semanticCapabilityCollisionIds: options.semanticCapabilityCollisionIds,
      certifiedCompleteCandidateIds: options.certifiedCompleteCandidateIds,
      tierStates: options.tierStates,
      runDedicatedLineageProgram: options.runDedicatedLineageProgram,
      frozenResearchChildren: options.frozenResearchChildren,
      businessContext: options.businessContext ?? { available: false, objectCount: 0 },
    }),
  };
}

function textToolProvider(responses: string[]): AgentProvider {
  let index = 0;
  return {
    name: 'ollama',
    available: async () => true,
    generate: async () => responses[index++] ?? 'Research branch completed without an executable result.',
  };
}

function v2RunnerContextPack(question: string) {
  return {
    id: 'pack:v2-provider-dispatch',
    question,
    focusObjectKey: null,
    mode: 'question',
    questionPlan: buildAnalysisQuestionPlan(question),
    objects: [],
    skills: [],
    knowledgeLens: { snapshotId: 'snapshot:v2-test' },
    edges: [],
    queryRuns: [],
    citations: [],
    evidenceSummaries: [],
    warnings: [],
    routeDecision: { route: 'generated_sql' },
    evidenceRoles: [],
    allowedSqlContext: { relations: [], sourceBlockSql: [] },
    missingContext: [],
    conflicts: [],
    appliedHints: [],
    retrievalDiagnostics: { strategy: 'sqlite_fts', lanes: [], selectedObjects: 0, selectedEvidence: [] },
  };
}

function v2NarrationTestBudget(input: {
  discoveryOpen: () => boolean;
  narrationOpen: () => boolean;
}): AgentRunBudget {
  const controller = new AbortController();
  return {
    startedAtMs: 0,
    hardDeadlineMs: 45_000,
    hardSignal: controller.signal,
    mode: 'ask',
    elapsedMs: () => 0,
    remainingMs: () => 45_000,
    softTargetMs: () => 15_000,
    mayStartDiscovery: () => input.discoveryOpen(),
    narrationSoftTargetMs: () => 38_000,
    mayStartNarration: () => input.narrationOpen(),
  };
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

  it('AGT-054 enables the bounded agentic tool lane for a server-owned V2 Ask even when project config is legacy', () => {
    const ordinary = __test__.orchestratorPolicyForRequest({
      ...req([{ role: 'user', content: 'top customers by revenue' }]),
      askAgentRuntimeMode: 'authoritative_v2',
      orchestrationMode: 'ask',
    });
    expect(ordinary.mode).toBe('agentic');
    expect(ordinary.lanes).toEqual(new Set(['ask_v2']));
    expect(ordinary.maxIterations).toBe(8);

    const research = __test__.orchestratorPolicyForRequest({
      ...req([{ role: 'user', content: 'research revenue drivers' }]),
      askAgentRuntimeMode: 'authoritative_v2',
      orchestrationMode: 'research',
    });
    expect(research.lanes).toEqual(new Set(['research']));
    expect(research.maxIterations).toBe(24);
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

describe('authoritative Ask V2 snapshot tool controller', () => {
  it.each([
    ['compiler', false, true],
    ['generated-SQL executor', true, false],
  ])('does not commit semantic when the host is missing its %s', async (_missing, hasCompiler, hasExecutor) => {
    const metric: AgentEvidenceCandidate = {
      id: 'semantic:metric:orders.revenue', qualifiedId: 'semantic:metric:orders.revenue', kind: 'semantic_metric',
      semanticObjectType: 'metric', trustTier: 'semantic', name: 'orders.revenue', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const compile = vi.fn(async (selection: { filters?: Array<{ values?: unknown[] }> }) => ({ sql: `select 1 as revenue /* ${(selection.filters ?? []).flatMap((f) => f.values ?? []).join(' ')} */`, engine: 'native' as const }));
    const execute = vi.fn(async () => ({ columns: ['revenue'], rows: [{ revenue: 1 }], rowCount: 1 }));
    const state = askV2State([metric]);

    await __test__.createAskV2LaneHandler(state, { maxToolCalls: 8, maxProviderDispatches: 3 })({
      question: 'show revenue',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
      ]),
      askAgentV2Workspace: askV2Workspace([metric]),
      ...(hasCompiler ? { semanticQueryCompiler: compile } : {}),
      ...(hasExecutor ? { executeGeneratedSql: execute } : {}),
    } as never);

    expect(state.controllerTier).toBeUndefined();
    expect(state.tierStates?.semantic).toMatchObject({
      status: 'unavailable',
      reasonCode: 'SEMANTIC_EXECUTION_UNAVAILABLE',
      candidateIds: [metric.qualifiedId],
    });
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'inspect_semantic_candidates',
        outcome: 'unavailable',
        reasonCode: 'SEMANTIC_EXECUTION_UNAVAILABLE',
      }),
    ]));
    expect(compile).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['missing executor', (): boolean => true, false],
    ['stale artifact', (): boolean => false, true],
  ] as const)('continues from a %s certified fit to a runnable semantic capability before freeze', async (label, currentArtifact, provideCertifiedExecutor) => {
    const certified: AgentEvidenceCandidate = {
      id: 'block:top-customers', qualifiedId: 'block:top-customers', kind: 'certified_block',
      trustTier: 'certified', name: 'top customers', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const metric: AgentEvidenceCandidate = {
      id: 'semantic:metric:orders.revenue', qualifiedId: 'semantic:metric:orders.revenue', kind: 'semantic_metric',
      semanticObjectType: 'metric', trustTier: 'semantic', name: 'orders.revenue', relevanceScore: 0.9, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const compile = vi.fn(async (selection: { filters?: Array<{ values?: unknown[] }> }) => ({ sql: `select 1 as revenue /* ${(selection.filters ?? []).flatMap((f) => f.values ?? []).join(' ')} */`, engine: 'native' as const }));
    const execute = vi.fn(async () => ({ columns: ['revenue'], rows: [{ revenue: 1 }], rowCount: 1 }));
    const executeCertifiedBlock = vi.fn(async () => ({ columns: ['customer'], rows: [{ customer: 'Ada' }], rowCount: 1 }));
    const state = askV2State([certified, metric]);

    const answer = await __test__.createAskV2LaneHandler(state, { maxToolCalls: 8, maxProviderDispatches: 6 })({
      question: 'show revenue',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"run_certified","input":{"candidateId":"block:top-customers"}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        '```json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["semantic:metric:orders.revenue"]}}\n```',
        '```json\n{"tool":"finish_answer","input":{"answer":"Revenue is available."}}\n```',
      ]),
      askAgentV2Workspace: askV2Workspace([certified, metric], {
        certifiedArtifacts: new Map([['block:top-customers', {
          version: 1,
          artifact: { kind: 'block', nodeId: 'block:top-customers', name: 'top customers' },
          revisionFingerprint: 'sha256:top-customers',
          isCurrent: currentArtifact,
        }]]),
        certifiedCompleteCandidateIds: ['block:top-customers'],
      }),
      ...(provideCertifiedExecutor ? { executeCertifiedBlock } : {}),
      semanticQueryCompiler: compile,
      executeGeneratedSql: execute,
    } as never);

    expect(label).toBeDefined();
    expect(executeCertifiedBlock).not.toHaveBeenCalled();
    expect(compile).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(answer.result?.answerTier).toBe('semantic_metric');
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'inspect_certified_candidates',
        outcome: 'unavailable',
        reasonCode: provideCertifiedExecutor ? 'CERTIFIED_ARTIFACT_STALE' : 'CERTIFIED_EXECUTOR_UNAVAILABLE',
      }),
      expect.objectContaining({
        tool: 'run_certified',
        outcome: 'unavailable',
        reasonCode: provideCertifiedExecutor ? 'CERTIFIED_ARTIFACT_STALE' : 'CERTIFIED_EXECUTOR_UNAVAILABLE',
      }),
    ]));
  });

  it('does not expose or terminally accept clarification without host-issued material choices', async () => {
    const metric: AgentEvidenceCandidate = {
      id: 'semantic:metric:orders.revenue', qualifiedId: 'semantic:metric:orders.revenue', kind: 'semantic_metric',
      semanticObjectType: 'metric', trustTier: 'semantic', name: 'orders.revenue', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const state = askV2State([metric]);
    await __test__.createAskV2LaneHandler(state, { maxToolCalls: 8, maxProviderDispatches: 3 })({
      question: 'show revenue',
      provider: textToolProvider([
        '```json\n{"tool":"request_clarification","input":{"message":"Which revenue?","options":[{"id":"invented","label":"Invented"},{"id":"also-invented","label":"Also invented"}]}}\n```',
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        'No executable result.',
      ]),
      askAgentV2Workspace: askV2Workspace([metric]),
    } as never);

    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'request_clarification',
        outcome: 'ineligible',
        reasonCode: 'ASK_V2_CLARIFICATION_NOT_MATERIALLY_AMBIGUOUS',
      }),
    ]));
    expect(state.terminal).not.toBe('clarification');
  });

  it('rejects empty, partial, and invented clarification choices before accepting the exact host-issued set', async () => {
    const first: AgentEvidenceCandidate = {
      id: 'semantic:metric:orders.revenue', qualifiedId: 'semantic:metric:orders.revenue', kind: 'semantic_metric',
      semanticObjectType: 'metric', trustTier: 'semantic', name: 'orders.revenue', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const second: AgentEvidenceCandidate = {
      id: 'semantic:metric:orders.gross_revenue', qualifiedId: 'semantic:metric:orders.gross_revenue', kind: 'semantic_metric',
      semanticObjectType: 'metric', trustTier: 'semantic', name: 'orders.gross_revenue', relevanceScore: 0.9, matchReasons: ['related'], compatibility: 'compatible',
    };
    const state = askV2State([first, second]);
    const choices = [
      { version: 1 as const, id: 'choice:net', label: 'Net revenue', candidateIds: [first.qualifiedId!], resultFingerprint: 'sha256:net' },
      { version: 1 as const, id: 'choice:gross', label: 'Gross revenue', candidateIds: [second.qualifiedId!], resultFingerprint: 'sha256:gross' },
    ];
    const compile = vi.fn(async (selection: { filters?: Array<{ values?: unknown[] }> }) => ({ sql: `select 1 as revenue /* ${(selection.filters ?? []).flatMap((f) => f.values ?? []).join(' ')} */`, engine: 'native' as const }));
    const execute = vi.fn(async () => ({ columns: ['revenue'], rows: [{ revenue: 1 }], rowCount: 1 }));
    const answer = await __test__.createAskV2LaneHandler(state, { maxToolCalls: 8, maxProviderDispatches: 5 })({
      question: 'show revenue',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"request_clarification","input":{"message":"Which revenue?","options":[{"id":"choice:net","label":"Net revenue"}]}}\n```',
        '```json\n{"tool":"request_clarification","input":{"message":"Which revenue?","options":[{"id":"choice:net","label":"Net revenue"},{"id":"invented","label":"Invented"}]}}\n```',
        '```json\n{"tool":"request_clarification","input":{"message":"Which revenue?","options":[{"id":"choice:net","label":"Changed label"},{"id":"choice:gross","label":"Changed label"}]}}\n```',
      ]),
      askAgentV2Workspace: askV2Workspace([first, second], {
        tierStates: {
          certified: { version: 1, status: 'unavailable', candidateIds: [], reasonCode: 'CERTIFIED_CANDIDATES_EMPTY' },
          semantic: { version: 1, status: 'ambiguous', candidateIds: [first.qualifiedId!, second.qualifiedId!], reasonCode: 'SEMANTIC_MEANINGS_AMBIGUOUS', clarificationChoices: choices },
        },
      }),
      semanticQueryCompiler: compile,
      executeGeneratedSql: execute,
    } as never);

    expect(state.observations.filter((observation) => (
      observation.tool === 'request_clarification'
      && observation.reasonCode === 'ASK_V2_CLARIFICATION_OPTIONS_INVALID'
    ))).toHaveLength(2);
    expect(answer.clarificationOptions).toEqual([
      { id: 'choice:net', label: 'Net revenue' },
      { id: 'choice:gross', label: 'Gross revenue' },
    ]);
    expect(state.terminal).toBe('clarification');
  });

  it('re-dispatches a prose-only semantic controller turn to the required compiler action', async () => {
    const metric: AgentEvidenceCandidate = {
      id: 'semantic:metric:orders.revenue', qualifiedId: 'semantic:metric:orders.revenue', kind: 'semantic_metric',
      semanticObjectType: 'metric', trustTier: 'semantic', name: 'orders.revenue', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const compile = vi.fn(async (selection: { filters?: Array<{ values?: unknown[] }> }) => ({ sql: `select 1 as revenue /* ${(selection.filters ?? []).flatMap((f) => f.values ?? []).join(' ')} */`, engine: 'native' as const }));
    const execute = vi.fn(async () => ({ columns: ['revenue'], rows: [{ revenue: 1 }], rowCount: 1 }));
    const calls: AgentMessage[][] = [];
    let index = 0;
    const provider: AgentProvider = {
      name: 'ollama',
      available: async () => true,
      generate: async (messages) => {
        calls.push(messages);
        return [
          '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
          '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
          'I can answer without running MetricFlow.',
          '```json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["semantic:metric:orders.revenue"]}}\n```',
          '```json\n{"tool":"finish_answer","input":{"answer":"Revenue is ready."}}\n```',
        ][index++] ?? '';
      },
    };
    const state = askV2State([metric]);
    const answer = await __test__.createAskV2LaneHandler(state, { maxToolCalls: 8, maxProviderDispatches: 6 })({
      question: 'show revenue',
      provider,
      askAgentV2Workspace: askV2Workspace([metric]),
      semanticQueryCompiler: compile,
      executeGeneratedSql: execute,
    } as never);

    expect(compile).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(answer.result?.answerTier).toBe('semantic_metric');
    expect(calls).toHaveLength(5);
    const finalPrompt = calls[3]!.map((message) => message.content).join('\n');
    expect(finalPrompt).toContain('Controller progression required');
    expect(finalPrompt).not.toContain('I can answer without running MetricFlow.');
    expect(answer.text).toBe('Revenue is ready.');
  });

  it.each([
    ['OpenAI', () => new OpenAIProvider({ apiKey: 'test', baseUrl: 'https://example.test/v1', model: 'gpt-test' })],
    ['Claude', () => new ClaudeProvider({ apiKey: 'test', baseUrl: 'https://example.test/anthropic', model: 'claude-test' })],
  ])('%s preserves a native final-action budget stop as ASK_TOOL_BUDGET_EXHAUSTED in the V2 lane', async (kind, createProvider) => {
    const candidate: AgentEvidenceCandidate = {
      id: 'block:top-customers', qualifiedId: 'block:top-customers', kind: 'certified_block',
      trustTier: 'certified', name: 'top customers', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    vi.stubGlobal('fetch', vi.fn(async () => kind === 'OpenAI'
      ? new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'wrong', type: 'function', function: { name: 'invented_tool', arguments: '{}' } }] } }] }), { status: 200 })
      : new Response(JSON.stringify({ content: [{ type: 'tool_use', id: 'wrong', name: 'invented_tool', input: {} }] }), { status: 200 })));
    try {
      const state = askV2State([candidate]);
      // This is host-owned tuple state, not a provider claim. It deliberately
      // narrows the first physical native send to `run_certified`.
      state.tierStates = {
        certified: { version: 1, status: 'complete', candidateIds: [candidate.qualifiedId!], reasonCode: 'CERTIFIED_COMPLETE_FOR_REQUEST' },
      };
      const answer = await __test__.createAskV2LaneHandler(state, { maxToolCalls: 8, maxProviderDispatches: 1 })({
        question: 'who are the top customers',
        provider: createProvider(),
        askAgentV2Workspace: askV2Workspace([candidate], {
          certifiedArtifacts: new Map([['block:top-customers', {
            version: 1,
            artifact: { kind: 'block', nodeId: 'block:top-customers', name: 'top customers' },
            revisionFingerprint: 'sha256:top-customers',
            isCurrent: () => true,
          }]]),
          certifiedCompleteCandidateIds: ['block:top-customers'],
          certifiedExecutionAvailable: true,
        }),
        executeCertifiedBlock: vi.fn(async () => ({ columns: ['customer'], rows: [{ customer: 'Ada' }], rowCount: 1 })),
      } as never);

      expect(answer.kind).toBe('no_answer');
      expect(state.observations).toEqual(expect.arrayContaining([
        expect.objectContaining({ tool: 'finish_answer', outcome: 'error', reasonCode: 'ASK_TOOL_BUDGET_EXHAUSTED', origin: 'agent_control' }),
      ]));
      expect(state.terminalOutcome).toMatchObject({ kind: 'budget_exhausted', reasonCode: 'ASK_TOOL_BUDGET_EXHAUSTED', origin: 'agent_control' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('requires a host finish after the snapshot-bound certified artifact executes and discards provider prose', async () => {
    const candidate: AgentEvidenceCandidate = {
      id: 'block:top-customers', qualifiedId: 'block:top-customers', kind: 'certified_block',
      trustTier: 'certified', name: 'top customers', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const executeCertifiedBlock = vi.fn(async () => ({ columns: ['customer'], rows: [{ customer: 'Ada' }], rowCount: 1 }));
    const state = askV2State([candidate]);
    const calls: AgentMessage[][] = [];
    let call = 0;
    const result = await __test__.createAskV2LaneHandler(state, { maxToolCalls: 8, maxProviderDispatches: 4 })({
      question: 'who are the top customers',
      provider: {
        name: 'ollama',
        available: async () => true,
        generate: async (messages: AgentMessage[]) => {
          calls.push(messages);
          return [
            '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
            '```json\n{"tool":"run_certified","input":{"candidateId":"block:top-customers"}}\n```',
            'The certified result is complete.',
            '```json\n{"tool":"finish_answer","input":{"answer":"The certified result is ready."}}\n```',
          ][call++] ?? '';
        },
      },
      askAgentV2Workspace: askV2Workspace([candidate], {
        certifiedArtifacts: new Map([['block:top-customers', {
          version: 1,
          artifact: { kind: 'block', nodeId: 'block:top-customers', name: 'top customers' },
          revisionFingerprint: 'sha256:top-customers',
          isCurrent: () => true,
        }]]),
        certifiedCompleteCandidateIds: ['block:top-customers'],
      }),
      executeCertifiedBlock,
    } as never);

    expect(executeCertifiedBlock).toHaveBeenCalledOnce();
    expect(result.result?.answerTier).toBe('certified_block');
    expect(result.text).toBe('The certified result is ready.');
    expect(calls).toHaveLength(4);
    expect(calls[3]!.map((message) => message.content).join('\n')).toContain('Controller progression required');
    expect(calls[3]!.map((message) => message.content).join('\n')).not.toContain('The certified result is complete.');
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'run_certified', outcome: 'executed', candidateIds: ['block:top-customers'] }),
      expect.objectContaining({ tool: 'finish_answer', outcome: 'eligible', reasonCode: 'ASK_V2_RESULT_NARRATED' }),
    ]));
  });

  it('preserves a validated certified result with deterministic facts when the final provider dispatch fails', async () => {
    const candidate: AgentEvidenceCandidate = {
      id: 'block:top-customers', qualifiedId: 'block:top-customers', kind: 'certified_block',
      trustTier: 'certified', name: 'top customers', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const state = askV2State([candidate]);
    let call = 0;
    const result = await __test__.createAskV2LaneHandler(state, { maxToolCalls: 8, maxProviderDispatches: 4 })({
      question: 'who are the top customers',
      provider: {
        name: 'ollama',
        available: async () => true,
        generate: async () => {
          const next = call++;
          if (next === 0) return '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```';
          if (next === 1) return '```json\n{"tool":"run_certified","input":{"candidateId":"block:top-customers"}}\n```';
          throw new Error('narration transport unavailable');
        },
      },
      askAgentV2Workspace: askV2Workspace([candidate], {
        certifiedArtifacts: new Map([['block:top-customers', {
          version: 1,
          artifact: { kind: 'block', nodeId: 'block:top-customers', name: 'top customers' },
          revisionFingerprint: 'sha256:top-customers',
          isCurrent: () => true,
        }]]),
        certifiedCompleteCandidateIds: ['block:top-customers'],
      }),
      executeCertifiedBlock: vi.fn(async () => ({ columns: ['customer'], rows: [{ customer: 'Ada' }], rowCount: 1 })),
    } as never);

    expect(result.kind).toBe('certified');
    expect(result.certification).toBe('certified');
    expect(result.result).toMatchObject({ rowCount: 1, answerTier: 'certified_block' });
    expect(result.text).toContain('validated certified query completed with 1 row');
    expect(result.askAgentV2Outcome).toMatchObject({
      kind: 'finish_answer',
      reasonCode: 'ASK_V2_RESULT_PRESERVED_AFTER_NARRATION_FAILURE',
      origin: 'narration',
    });
    expect(state.terminalOutcome).toMatchObject({
      kind: 'finish_answer',
      reasonCode: 'ASK_V2_RESULT_PRESERVED_AFTER_NARRATION_FAILURE',
    });
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'finish_answer', outcome: 'error', reasonCode: 'ASK_V2_PROVIDER_AGENT_CONTROL_FAILED', origin: 'provider' }),
    ]));
  });

  it('preserves a validated text-protocol result with a deadline-specific V8 narration receipt', async () => {
    const candidate: AgentEvidenceCandidate = {
      id: 'block:top-customers', qualifiedId: 'block:top-customers', kind: 'certified_block',
      trustTier: 'certified', name: 'top customers', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const state = askV2State([candidate]);
    let call = 0;
    const result = await __test__.createAskV2LaneHandler(state, { maxToolCalls: 8, maxProviderDispatches: 4 })({
      question: 'who are the top customers',
      provider: {
        name: 'ollama',
        available: async () => true,
        generate: async () => {
          const next = call++;
          if (next === 0) return '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```';
          if (next === 1) return '```json\n{"tool":"run_certified","input":{"candidateId":"block:top-customers"}}\n```';
          throw Object.assign(new Error('The run soft target elapsed before narration could begin.'), {
            code: 'RUN_SOFT_TARGET_EXCEEDED',
          });
        },
      },
      askAgentV2Workspace: askV2Workspace([candidate], {
        certifiedArtifacts: new Map([['block:top-customers', {
          version: 1,
          artifact: { kind: 'block', nodeId: 'block:top-customers', name: 'top customers' },
          revisionFingerprint: 'sha256:top-customers',
          isCurrent: () => true,
        }]]),
        certifiedCompleteCandidateIds: ['block:top-customers'],
      }),
      executeCertifiedBlock: vi.fn(async () => ({ columns: ['customer'], rows: [{ customer: 'Ada' }], rowCount: 1 })),
    } as never);

    expect(result.kind).toBe('certified');
    expect(result.result).toMatchObject({ rowCount: 1, answerTier: 'certified_block' });
    expect(result.text).toContain('validated certified query completed with 1 row');
    expect(result.askAgentV2Outcome).toMatchObject({
      kind: 'finish_answer',
      reasonCode: 'ASK_V2_RESULT_PRESERVED_AFTER_NARRATION_DEADLINE',
      origin: 'narration',
      safeAction: 'review_validated_result',
    });
    expect(state.terminalOutcome).toMatchObject({
      kind: 'finish_answer',
      reasonCode: 'ASK_V2_RESULT_PRESERVED_AFTER_NARRATION_DEADLINE',
      origin: 'narration',
    });
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'finish_answer',
        outcome: 'error',
        reasonCode: 'RUN_SOFT_TARGET_EXCEEDED',
        origin: 'narration',
        provider: expect.objectContaining({ phase: 'narration', cause: 'run_deadline', safeAction: 'review_validated_result' }),
      }),
    ]));
  });

  it.each([
    ['OpenAI', () => new OpenAIProvider({ apiKey: 'test', baseUrl: 'https://example.test/v1', model: 'gpt-test' })],
    ['Claude', () => new ClaudeProvider({ apiKey: 'test', baseUrl: 'https://example.test/anthropic', model: 'claude-test' })],
  ])('%s preserves a validated certified result when the final native narration turn exhausts its dispatch budget', async (kind, createProvider) => {
    const candidate: AgentEvidenceCandidate = {
      id: 'block:top-customers', qualifiedId: 'block:top-customers', kind: 'certified_block',
      trustTier: 'certified', name: 'top customers', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    let send = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      send += 1;
      if (send === 1) {
        return kind === 'OpenAI'
          ? new Response(JSON.stringify({ choices: [{ message: {
            content: null,
            tool_calls: [{ id: 'certified_1', type: 'function', function: { name: 'run_certified', arguments: '{"candidateId":"block:top-customers"}' } }],
          } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
          : new Response(JSON.stringify({ content: [{
            type: 'tool_use', id: 'certified_1', name: 'run_certified', input: { candidateId: 'block:top-customers' },
          }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return kind === 'OpenAI'
        ? new Response(JSON.stringify({ choices: [{ message: { content: 'The query is complete.', tool_calls: [] } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify({ content: [{ type: 'text', text: 'The query is complete.' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    try {
      const state = askV2State([candidate]);
      // Match the live host boundary: a complete certified tier becomes
      // executable only after its snapshot-bound candidate inspection has
      // been recorded.  The native provider should therefore spend its first
      // physical send on the execution and reserve the second for finish.
      state.observations.push({
        version: 1,
        tool: 'inspect_certified_candidates',
        outcome: 'eligible',
        reasonCode: 'CERTIFIED_COMPLETE_FOR_REQUEST',
        candidateIds: [candidate.qualifiedId!],
        tier: 'certified',
        origin: 'retrieval',
      });
      state.tierStates = {
        certified: { version: 1, status: 'complete', candidateIds: [candidate.qualifiedId!], reasonCode: 'CERTIFIED_COMPLETE_FOR_REQUEST' },
      };
      const result = await __test__.createAskV2LaneHandler(state, { maxToolCalls: 8, maxProviderDispatches: 2 })({
        question: 'who are the top customers',
        provider: createProvider(),
        askAgentV2Workspace: askV2Workspace([candidate], {
          certifiedArtifacts: new Map([['block:top-customers', {
            version: 1,
            artifact: { kind: 'block', nodeId: 'block:top-customers', name: 'top customers' },
            revisionFingerprint: 'sha256:top-customers',
            isCurrent: () => true,
          }]]),
          certifiedCompleteCandidateIds: ['block:top-customers'],
        }),
        executeCertifiedBlock: vi.fn(async () => ({ columns: ['customer'], rows: [{ customer: 'Ada' }], rowCount: 1 })),
      } as never);

      expect(send).toBe(2);
      expect(result.kind).toBe('certified');
      expect(result.result).toMatchObject({ rowCount: 1, answerTier: 'certified_block' });
      expect(result.text).toContain('validated certified query completed with 1 row');
      expect(result.askAgentV2Outcome).toMatchObject({
        kind: 'finish_answer',
        reasonCode: 'ASK_V2_RESULT_PRESERVED_AFTER_NARRATION_FAILURE',
      });
      expect(state.observations).toEqual(expect.arrayContaining([
        expect.objectContaining({ tool: 'finish_answer', outcome: 'error', reasonCode: 'ASK_PROVIDER_DISPATCH_BUDGET_EXHAUSTED', origin: 'provider' }),
      ]));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails closed when a certified artifact changes after the snapshot capture and before freeze', async () => {
    const candidate: AgentEvidenceCandidate = {
      id: 'block:top-customers', qualifiedId: 'block:top-customers', kind: 'certified_block',
      trustTier: 'certified', name: 'top customers', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const executeCertifiedBlock = vi.fn();
    let currentReads = 0;
    const state = askV2State([candidate]);
    await __test__.createAskV2LaneHandler(state)({
      question: 'who are the top customers',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        // The host rechecks this callback immediately before calling the
        // executor; this transition models a concurrent artifact mutation.
        '```json\n{"tool":"run_certified","input":{"candidateId":"block:top-customers"}}\n```',
        'no result',
      ]),
      askAgentV2Workspace: askV2Workspace([candidate], {
        certifiedArtifacts: new Map([['block:top-customers', {
          version: 1,
          artifact: { kind: 'block', nodeId: 'block:top-customers', name: 'top customers' },
          revisionFingerprint: 'sha256:top-customers',
          // The first read validates the immutable artifact during
          // inspection; the second is the pre-tool availability guard. Make
          // the third, immediately-before-freeze recheck fail so this test
          // exercises the race it names rather than an earlier unavailable
          // capability state.
          isCurrent: () => ++currentReads < 3,
        }]]),
        certifiedCompleteCandidateIds: ['block:top-customers'],
      }),
      executeCertifiedBlock,
    } as never);

    expect(executeCertifiedBlock).not.toHaveBeenCalled();
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'run_certified', outcome: 'unavailable', reasonCode: 'CERTIFIED_ARTIFACT_STALE' }),
    ]));
  });

  it('does not let an admitted but context-only certified block freeze tier one', async () => {
    const candidate: AgentEvidenceCandidate = {
      id: 'block:customer-profile', qualifiedId: 'block:customer-profile', kind: 'certified_block',
      trustTier: 'certified', name: 'customer profile', relevanceScore: 1, matchReasons: ['related'], compatibility: 'compatible',
    };
    const executeCertifiedBlock = vi.fn();
    const state = askV2State([candidate]);
    await __test__.createAskV2LaneHandler(state)({
      question: 'top customers by product revenue',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"run_certified","input":{"candidateId":"block:customer-profile"}}\n```',
        'no result',
      ]),
      askAgentV2Workspace: askV2Workspace([candidate], {
        certifiedArtifacts: new Map([['block:customer-profile', { kind: 'block', nodeId: 'block:customer-profile', name: 'customer profile' }]]),
        certifiedCompleteCandidateIds: [],
      }),
      executeCertifiedBlock,
    } as never);

    expect(executeCertifiedBlock).not.toHaveBeenCalled();
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'run_certified', outcome: 'ineligible', reasonCode: 'CERTIFIED_TUPLE_NOT_PROVEN_BY_SNAPSHOT' }),
    ]));
  });

  it('preserves the admitted canonical semantic metric ID and does not consume a V1 plan', async () => {
    const metric: AgentEvidenceCandidate = {
      id: 'semantic:metric:account_revenue.revenue',
      qualifiedId: 'semantic:metric:account_revenue.revenue',
      kind: 'semantic_metric',
      semanticObjectType: 'metric',
      trustTier: 'semantic',
      name: 'account_revenue.revenue',
      relevanceScore: 1,
      matchReasons: ['exact'],
      compatibility: 'compatible',
    };
    const state = askV2State([metric]);
    const compile = vi.fn(async (selection: { metrics: string[] }) => {
      expect(selection.metrics).toEqual(['account_revenue.revenue']);
      return { sql: 'select 1 as revenue', engine: 'native' as const };
    });
    const result = await __test__.createAskV2LaneHandler(state)({
      question: 'show revenue',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        '```json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["semantic:metric:account_revenue.revenue"]}}\n```',
        'semantic result finished',
      ]),
      askAgentV2Workspace: askV2Workspace([metric]),
      semanticQueryCompiler: compile,
      executeGeneratedSql: async () => ({ columns: ['revenue'], rows: [{ revenue: 1 }], rowCount: 1 }),
      // If the V2 controller accidentally read a V1 plan this deliberately
      // incompatible field would become visible in the assertion above.
      resolvedAnalyticalPlan: { planId: 'legacy-plan' } as never,
    } as never);

    expect(compile).toHaveBeenCalledOnce();
    expect(result.result?.answerTier).toBe('semantic_metric');
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'compile_and_run_semantic', outcome: 'executed', candidateIds: ['semantic:metric:account_revenue.revenue'] }),
    ]));
  });

  it('normalizes declared semantic time/filter bindings before freezing the compiler plan', async () => {
    const metric: AgentEvidenceCandidate = {
      id: 'semantic:metric:orders.revenue', qualifiedId: 'semantic:metric:orders.revenue', kind: 'semantic_metric', semanticObjectType: 'metric',
      trustTier: 'semantic', name: 'orders.revenue', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const orderedAt: AgentEvidenceCandidate = {
      id: 'semantic:dimension:orders.ordered_at', qualifiedId: 'semantic:dimension:orders.ordered_at', kind: 'semantic_member',
      trustTier: 'semantic', name: 'orders.ordered_at', timeGrains: ['day', 'month'], relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const category: AgentEvidenceCandidate = {
      id: 'semantic:dimension:products.category', qualifiedId: 'semantic:dimension:products.category', kind: 'semantic_member',
      trustTier: 'semantic', name: 'products.category', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const compile = vi.fn(async (selection: Record<string, unknown>) => {
      expect(selection).toMatchObject({
        metrics: ['orders.revenue'],
        timeDimension: { name: 'orders.ordered_at', granularity: 'month' },
        filters: [{ dimension: 'products.category', operator: '=', values: ['beverage'] }],
      });
      return { sql: 'select 1 as revenue', engine: 'native' as const };
    });
    const state = askV2State([metric, orderedAt, category]);
    await __test__.createAskV2LaneHandler(state)({
      question: 'show beverage revenue by month',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        '```json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["semantic:metric:orders.revenue"],"timeDimensionId":"semantic:dimension:orders.ordered_at","timeGrain":"MONTH","filters":[{"dimensionId":"semantic:dimension:products.category","value":"beverage"}]}}\n```',
        'semantic result finished',
      ]),
      askAgentV2Workspace: askV2Workspace([metric, orderedAt, category]),
      semanticQueryCompiler: compile,
      executeGeneratedSql: async () => ({ columns: ['revenue'], rows: [{ revenue: 1 }], rowCount: 1 }),
    } as never);

    expect(compile).toHaveBeenCalledOnce();
    expect(state.resolvedPlan).toMatchObject({ frozen: true, tier: 'semantic' });
  });

  it('AGT-047 completes an omitted explicit month binding from one admitted metric-compatible time capability', async () => {
    const metricId = 'semantic:metric:order_item.revenue';
    const timeId = 'semantic:commerce:dimension:order_item.metric_time';
    const metric: AgentEvidenceCandidate = {
      id: metricId, qualifiedId: metricId, kind: 'semantic_metric', semanticObjectType: 'metric', trustTier: 'semantic',
      name: 'revenue', semanticRuntimeName: 'revenue', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
      analyticalCapability: {
        executionCapabilities: [{ route: 'semantic', adapterId: 'metricflow' }],
        timeDimensions: [{ dimensionId: timeId }],
      } as never,
    };
    const metricTime: AgentEvidenceCandidate = {
      id: timeId, qualifiedId: timeId, kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'metric_time', semanticRuntimeName: 'metric_time', timeGrains: ['day', 'month'],
      relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const candidates = [metric, metricTime];
    const captured = captureAskV2SemanticCapabilities({
      candidates,
      snapshotId: 'snapshot:semantic-month-completion-text',
      isCurrent: () => true,
    });
    const compile = vi.fn(async (selection: Record<string, unknown>) => {
      expect(selection).toMatchObject({
        metrics: ['revenue'],
        timeDimension: { name: 'metric_time', granularity: 'month' },
        engine: 'metricflow-cli',
      });
      return { sql: 'select 1 as revenue', engine: 'metricflow-cli' as const };
    });
    const execute = vi.fn(async () => ({
      columns: ['metric_time', 'revenue'],
      rows: [{ metric_time: '2026-01-01', revenue: 1 }],
      rowCount: 1,
    }));
    const state = askV2State(candidates);
    const answer = await __test__.createAskV2LaneHandler(state)({
      question: 'Show revenue by month using the revenue semantic metric',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        // The real failure shape: the controller selects the exact metric but
        // omits the required axis/grain. The host can complete only this one
        // uniquely compatible, snapshot-admitted time binding.
        `\`\`\`json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["${metricId}"]}}\n\`\`\``,
        '```json\n{"tool":"finish_answer","input":{"answer":"Revenue is grouped by month."}}\n```',
      ]),
      askAgentV2Workspace: askV2Workspace(candidates, {
        semanticCapabilities: captured.capabilities,
        semanticCapabilityCollisionIds: captured.collisionIds,
      }),
      semanticQueryCompiler: compile,
      executeGeneratedSql: execute,
    } as never);

    expect(compile).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(answer.result).toMatchObject({ rowCount: 1, answerTier: 'semantic_metric' });
    expect(state.resolvedPlan).toMatchObject({ frozen: true, tier: 'semantic', candidateIds: [metricId, timeId] });
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'compile_and_run_semantic',
        outcome: 'eligible',
        reasonCode: 'SEMANTIC_TIME_BINDING_COMPLETED',
        candidateIds: [metricId, timeId],
        origin: 'validation',
        inputFingerprint: expect.stringMatching(/^sha256:/),
        outputFingerprint: expect.stringMatching(/^sha256:/),
      }),
      expect.objectContaining({ tool: 'compile_and_run_semantic', outcome: 'executed', reasonCode: 'SEMANTIC_RESULT_VALIDATED' }),
    ]));
    expect(answer.askAgentV2Outcome).toMatchObject({ kind: 'finish_answer' });
  });

  it('AGT-047 fills an omitted grain from the immutable question only after the controller selected one admitted axis', async () => {
    const metricId = 'semantic:metric:orders.revenue';
    const timeId = 'semantic:dimension:orders.metric_time';
    const metric: AgentEvidenceCandidate = {
      id: metricId, qualifiedId: metricId, kind: 'semantic_metric', semanticObjectType: 'metric', trustTier: 'semantic',
      name: 'revenue', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
      analyticalCapability: { timeDimensions: [{ dimensionId: timeId }] } as never,
    };
    const metricTime: AgentEvidenceCandidate = {
      id: timeId, qualifiedId: timeId, kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'metric_time', timeGrains: ['day', 'month'], relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const compile = vi.fn(async (selection: Record<string, unknown>) => {
      expect(selection.timeDimension).toEqual({ name: 'metric_time', granularity: 'month' });
      return { sql: 'select 1 as revenue', engine: 'native' as const };
    });
    const state = askV2State([metric, metricTime]);
    await __test__.createAskV2LaneHandler(state)({
      question: 'Show revenue by month',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        `\`\`\`json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["${metricId}"],"timeDimensionId":"${timeId}"}}\n\`\`\``,
        '```json\n{"tool":"finish_answer","input":{"answer":"Revenue is grouped by month."}}\n```',
      ]),
      askAgentV2Workspace: askV2Workspace([metric, metricTime]),
      semanticQueryCompiler: compile,
      executeGeneratedSql: async () => ({ columns: ['revenue'], rows: [{ revenue: 1 }], rowCount: 1 }),
    } as never);

    expect(compile).toHaveBeenCalledOnce();
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'compile_and_run_semantic', outcome: 'eligible', reasonCode: 'SEMANTIC_TIME_BINDING_COMPLETED',
        candidateIds: [metricId, timeId],
      }),
    ]));
  });

  it('AGT-047 rejects an omitted controller grain when the selected axis does not declare the immutable request grain', async () => {
    const metricId = 'semantic:metric:orders.revenue';
    const timeId = 'semantic:dimension:orders.metric_time';
    const metric: AgentEvidenceCandidate = {
      id: metricId, qualifiedId: metricId, kind: 'semantic_metric', semanticObjectType: 'metric', trustTier: 'semantic',
      name: 'revenue', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
      analyticalCapability: { timeDimensions: [{ dimensionId: timeId }] } as never,
    };
    const metricTime: AgentEvidenceCandidate = {
      id: timeId, qualifiedId: timeId, kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'metric_time', timeGrains: ['month'], relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const compile = vi.fn();
    const state = askV2State([metric, metricTime]);
    await __test__.createAskV2LaneHandler(state)({
      question: 'Show revenue by quarter',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        `\`\`\`json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["${metricId}"],"timeDimensionId":"${timeId}"}}\n\`\`\``,
        'No executable result.',
      ]),
      askAgentV2Workspace: askV2Workspace([metric, metricTime]),
      semanticQueryCompiler: compile,
      executeGeneratedSql: vi.fn(),
    } as never);

    expect(compile).not.toHaveBeenCalled();
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'compile_and_run_semantic', outcome: 'ineligible', reasonCode: 'SEMANTIC_TIME_GRAIN_NOT_DECLARED' }),
    ]));
  });

  it('AGT-047 rejects a controller grain that conflicts with the immutable user request before compiler authorization', async () => {
    const metricId = 'semantic:metric:orders.revenue';
    const timeId = 'semantic:dimension:orders.metric_time';
    const metric: AgentEvidenceCandidate = {
      id: metricId, qualifiedId: metricId, kind: 'semantic_metric', semanticObjectType: 'metric', trustTier: 'semantic',
      name: 'revenue', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
      analyticalCapability: { timeDimensions: [{ dimensionId: timeId }] } as never,
    };
    const metricTime: AgentEvidenceCandidate = {
      id: timeId, qualifiedId: timeId, kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'metric_time', timeGrains: ['month', 'quarter'], relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const compile = vi.fn();
    const state = askV2State([metric, metricTime]);
    await __test__.createAskV2LaneHandler(state)({
      question: 'Show revenue by month',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        `\`\`\`json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["${metricId}"],"timeDimensionId":"${timeId}","timeGrain":"quarter"}}\n\`\`\``,
        'No executable result.',
      ]),
      askAgentV2Workspace: askV2Workspace([metric, metricTime]),
      semanticQueryCompiler: compile,
      executeGeneratedSql: vi.fn(),
    } as never);

    expect(compile).not.toHaveBeenCalled();
    expect(state.resolvedPlan).toBeUndefined();
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'compile_and_run_semantic', outcome: 'ineligible', reasonCode: 'SEMANTIC_TIME_GRAIN_MISMATCH' }),
    ]));
  });

  it('AGT-047 requires declared metric-to-time compatibility before completing a fully omitted time binding', async () => {
    const metricId = 'semantic:metric:orders.revenue';
    const timeId = 'semantic:dimension:orders.metric_time';
    const metric: AgentEvidenceCandidate = {
      id: metricId, qualifiedId: metricId, kind: 'semantic_metric', semanticObjectType: 'metric', trustTier: 'semantic',
      name: 'revenue', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
      // No timeDimensions declaration: the legacy explicit-axis path remains
      // available, but the host may not choose an omitted axis for it.
    };
    const metricTime: AgentEvidenceCandidate = {
      id: timeId, qualifiedId: timeId, kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'metric_time', timeGrains: ['month'], relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const compile = vi.fn();
    const state = askV2State([metric, metricTime]);
    await __test__.createAskV2LaneHandler(state)({
      question: 'Show revenue by month',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        `\`\`\`json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["${metricId}"]}}\n\`\`\``,
        'No executable result.',
      ]),
      askAgentV2Workspace: askV2Workspace([metric, metricTime]),
      semanticQueryCompiler: compile,
      executeGeneratedSql: vi.fn(),
    } as never);

    expect(compile).not.toHaveBeenCalled();
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'compile_and_run_semantic', outcome: 'ineligible',
        reasonCode: 'SEMANTIC_TIME_DIMENSION_COMPATIBILITY_UNDECLARED', safeAction: 'use:compile_and_run_semantic',
      }),
    ]));
  });

  it('AGT-047 does not repeat a persisted host time completion after reload', async () => {
    const metricId = 'semantic:metric:orders.revenue';
    const timeId = 'semantic:dimension:orders.metric_time';
    const metric: AgentEvidenceCandidate = {
      id: metricId, qualifiedId: metricId, kind: 'semantic_metric', semanticObjectType: 'metric', trustTier: 'semantic',
      name: 'revenue', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
      analyticalCapability: { timeDimensions: [{ dimensionId: timeId }] } as never,
    };
    const metricTime: AgentEvidenceCandidate = {
      id: timeId, qualifiedId: timeId, kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'metric_time', timeGrains: ['month'], relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const state = askV2State([metric, metricTime]);
    // A process reload receives this durable host-only normalization receipt.
    // It must not charge a tool call, nor make the one correction available a
    // second time for the same immutable snapshot/question.
    state.observations.push({
      version: 1,
      tool: 'compile_and_run_semantic',
      tier: 'semantic',
      outcome: 'eligible',
      reasonCode: 'SEMANTIC_TIME_BINDING_COMPLETED',
      candidateIds: [metricId, timeId],
      inputFingerprint: 'sha256:before-time-binding',
      outputFingerprint: 'sha256:after-time-binding',
      origin: 'validation',
    });
    const compile = vi.fn();
    await __test__.createAskV2LaneHandler(state)({
      question: 'Show revenue by month',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        `\`\`\`json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["${metricId}"]}}\n\`\`\``,
        'No executable result.',
      ]),
      askAgentV2Workspace: askV2Workspace([metric, metricTime]),
      semanticQueryCompiler: compile,
      executeGeneratedSql: vi.fn(),
    } as never);

    expect(compile).not.toHaveBeenCalled();
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'compile_and_run_semantic', outcome: 'unavailable',
        reasonCode: 'SEMANTIC_TIME_BINDING_COMPLETION_EXHAUSTED',
      }),
    ]));
  });

  it('AGT-047 rejects supplied semantic time arguments for FY periods without the snapshot-declared fiscal calendar binding', async () => {
    const metricId = 'semantic:metric:orders.revenue';
    const timeId = 'semantic:dimension:orders.metric_time';
    const fiscalId = 'semantic:dimension:orders.fiscal_period';
    const metric: AgentEvidenceCandidate = {
      id: metricId, qualifiedId: metricId, kind: 'semantic_metric', semanticObjectType: 'metric', trustTier: 'semantic',
      name: 'revenue', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
      analyticalCapability: { timeDimensions: [{ dimensionId: timeId }] } as never,
    };
    const metricTime: AgentEvidenceCandidate = {
      id: timeId, qualifiedId: timeId, kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'metric_time', timeGrains: ['month'], relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const fiscalPeriod: AgentEvidenceCandidate = {
      id: fiscalId, qualifiedId: fiscalId, kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'fiscal_period', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const compile = vi.fn();
    const state = askV2State([metric, metricTime, fiscalPeriod]);
    await __test__.createAskV2LaneHandler(state)({
      question: 'Show revenue by month for FY26',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        `\`\`\`json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["${metricId}"],"timeDimensionId":"${timeId}","timeGrain":"month","filters":[{"dimensionId":"${fiscalId}","value":"FY26"}]}}\n\`\`\``,
        'No executable result.',
      ]),
      askAgentV2Workspace: askV2Workspace([metric, metricTime, fiscalPeriod]),
      semanticQueryCompiler: compile,
      executeGeneratedSql: vi.fn(),
    } as never);

    expect(compile).not.toHaveBeenCalled();
    expect(state.resolvedPlan).toBeUndefined();
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'compile_and_run_semantic', outcome: 'unavailable', reasonCode: 'SEMANTIC_FISCAL_CALENDAR_REQUIRED' }),
    ]));
  });

  it('AGT-047 compiles a fiscal semantic request only with the declared calendar role and exact fiscal-period filter', async () => {
    const metricId = 'semantic:metric:orders.revenue';
    const timeId = 'semantic:dimension:orders.metric_time';
    const fiscalId = 'semantic:dimension:orders.fiscal_period';
    const metric: AgentEvidenceCandidate = {
      id: metricId, qualifiedId: metricId, kind: 'semantic_metric', semanticObjectType: 'metric', trustTier: 'semantic',
      name: 'revenue', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
      analyticalCapability: { timeDimensions: [{ dimensionId: timeId }] } as never,
    };
    const metricTime: AgentEvidenceCandidate = {
      id: timeId, qualifiedId: timeId, kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'metric_time', timeGrains: ['month'], relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const fiscalPeriod: AgentEvidenceCandidate = {
      id: fiscalId, qualifiedId: fiscalId, kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'fiscal_period', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const compile = vi.fn(async (selection: Record<string, unknown>) => {
      expect(selection).toMatchObject({
        timeDimension: { name: 'metric_time', granularity: 'month' },
        filters: [{ dimension: 'fiscal_period', operator: '=', values: ['FY26'] }],
      });
      return { sql: 'select 1 as revenue', engine: 'native' as const };
    });
    const state = askV2State([metric, metricTime, fiscalPeriod]);
    await __test__.createAskV2LaneHandler(state)({
      question: 'Show revenue by month for FY26',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        `\`\`\`json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["${metricId}"],"timeDimensionId":"${timeId}","timeGrain":"month","filters":[{"dimensionId":"${fiscalId}","value":"FY26"}]}}\n\`\`\``,
        '```json\n{"tool":"finish_answer","input":{"answer":"Revenue is grouped by fiscal month."}}\n```',
      ]),
      askAgentV2Workspace: askV2Workspace([metric, metricTime, fiscalPeriod], {
        fiscalCalendar: { id: 'semantic:calendar:fiscal', dateRoleId: timeId, fiscalPeriodFieldId: fiscalId },
      }),
      semanticQueryCompiler: compile,
      executeGeneratedSql: async () => ({ columns: ['revenue'], rows: [{ revenue: 1 }], rowCount: 1 }),
    } as never);

    expect(compile).toHaveBeenCalledOnce();
    expect(state.resolvedPlan).toMatchObject({ frozen: true, tier: 'semantic' });
  });

  it.each([
    [
      'a contradictory runtime-name duplicate for the same fiscal field',
      [
        { dimensionId: 'semantic:dimension:orders.fiscal_period', value: 'FY26' },
        { dimensionId: 'fiscal_period', value: 'FY27' },
      ],
    ],
    [
      'an identical legacy-alias duplicate for the same fiscal field',
      [
        { dimensionId: 'semantic:dimension:orders.fiscal_period', value: 'FY26' },
        { dimensionId: 'semantic:legacy:orders.fiscal_period', value: 'FY26' },
      ],
    ],
    [
      'a single fiscal-period value that conflicts with the immutable FY token',
      [{ dimensionId: 'semantic:dimension:orders.fiscal_period', value: 'FY27' }],
    ],
  ])('AGT-047 rejects %s before fiscal semantic compilation', async (_case, filters) => {
    const metricId = 'semantic:metric:orders.revenue';
    const timeId = 'semantic:dimension:orders.metric_time';
    const fiscalId = 'semantic:dimension:orders.fiscal_period';
    const metric: AgentEvidenceCandidate = {
      id: metricId, qualifiedId: metricId, kind: 'semantic_metric', semanticObjectType: 'metric', trustTier: 'semantic',
      name: 'revenue', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
      analyticalCapability: { timeDimensions: [{ dimensionId: timeId }] } as never,
    };
    const metricTime: AgentEvidenceCandidate = {
      id: timeId, qualifiedId: timeId, kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'metric_time', timeGrains: ['month'], relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const fiscalPeriod: AgentEvidenceCandidate = {
      id: fiscalId, qualifiedId: fiscalId, aliases: ['semantic:legacy:orders.fiscal_period'],
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'fiscal_period', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const compile = vi.fn();
    const state = askV2State([metric, metricTime, fiscalPeriod]);
    await __test__.createAskV2LaneHandler(state)({
      question: 'Show revenue by month for FY26',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        `\`\`\`json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["${metricId}"],"timeDimensionId":"${timeId}","timeGrain":"month","filters":${JSON.stringify(filters)}}}\n\`\`\``,
        'No executable result.',
      ]),
      askAgentV2Workspace: askV2Workspace([metric, metricTime, fiscalPeriod], {
        fiscalCalendar: { id: 'semantic:calendar:fiscal', dateRoleId: timeId, fiscalPeriodFieldId: fiscalId },
      }),
      semanticQueryCompiler: compile,
      executeGeneratedSql: vi.fn(),
    } as never);

    expect(compile).not.toHaveBeenCalled();
    expect(state.resolvedPlan).toBeUndefined();
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'compile_and_run_semantic', outcome: 'ineligible',
        reasonCode: 'SEMANTIC_FISCAL_FILTER_INVALID', origin: 'validation',
      }),
    ]));
  });

  it('AGT-047 maps only unique snapshot-bound MetricFlow runtime names to canonical IDs before validating month', async () => {
    const metric: AgentEvidenceCandidate = {
      id: 'semantic:metric:order_item.revenue', qualifiedId: 'semantic:metric:order_item.revenue',
      kind: 'semantic_metric', semanticObjectType: 'metric', trustTier: 'semantic', name: 'revenue',
      relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
      // The semantic registry proves that this revenue metric's metric_time
      // axis belongs to order_item; raw `metric_time` is not independently
      // sufficient to choose among the four model-owned axes below.
      analyticalCapability: {
        timeDimensions: [{ dimensionId: 'semantic:commerce:dimension:order_item.metric_time' }],
      } as never,
    };
    // The retrieval package can also expose a generic measure named revenue.
    // A raw runtime-name tool argument must prefer the concrete metric, not
    // create an ambiguous or accidental semantic selection.
    const genericRevenue: AgentEvidenceCandidate = {
      id: 'semantic:uncategorized:measure:revenue', qualifiedId: 'semantic:uncategorized:measure:revenue',
      kind: 'semantic_member', semanticObjectType: 'measure', trustTier: 'semantic', name: 'revenue',
      relevanceScore: 0.8, matchReasons: ['related'], compatibility: 'compatible',
    };
    const metricTime = (model: 'customers' | 'orders' | 'locations' | 'order_item'): AgentEvidenceCandidate => ({
      id: `semantic:commerce:dimension:${model}.metric_time`,
      qualifiedId: `semantic:commerce:dimension:${model}.metric_time`,
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      trustTier: 'semantic',
      name: 'metric_time',
      semanticRuntimeName: 'metric_time',
      semanticModel: model,
      sourceObjects: [model],
      // The old snapshots may carry this only as an alias. It is safe to read
      // only when it resolves uniquely after the metric's compatibility
      // contract has reduced the admitted capability set.
      aliases: ['semantic:uncategorized:dimension:metric_time'],
      timeGrains: ['day', 'month'],
      relevanceScore: 1,
      matchReasons: ['exact'],
      compatibility: 'compatible',
    });
    const metricTimes = [
      metricTime('customers'),
      metricTime('orders'),
      metricTime('locations'),
      metricTime('order_item'),
    ];
    const compile = vi.fn(async (selection: Record<string, unknown>) => {
      expect(selection).toMatchObject({
        metrics: ['revenue'],
        timeDimension: { name: 'metric_time', granularity: 'month' },
      });
      return { sql: 'select 1 as revenue', engine: 'native' as const };
    });
    const execute = vi.fn(async () => ({ columns: ['revenue'], rows: [{ revenue: 1 }], rowCount: 1 }));
    const candidates = [metric, genericRevenue, ...metricTimes];
    const captured = captureAskV2SemanticCapabilities({
      candidates,
      snapshotId: 'snapshot:metric-time-capabilities',
      isCurrent: () => true,
    });
    const state = askV2State(candidates);
    const answer = await __test__.createAskV2LaneHandler(state)({
      question: 'Show revenue by month using the revenue semantic metric',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        // Native/text providers sometimes reflect the compiler-safe name in
        // their tool call. The adapter may map only this exact capability
        // name; it still freezes and receipts opaque snapshot IDs.
        '```json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["revenue"],"timeDimensionId":"metric_time","timeGrain":"month","engine":"native"}}\n```',
        'semantic result finished',
      ]),
      askAgentV2Workspace: askV2Workspace(candidates, {
        semanticCapabilities: captured.capabilities,
        semanticCapabilityCollisionIds: captured.collisionIds,
      }),
      semanticQueryCompiler: compile,
      executeGeneratedSql: execute,
    } as never);

    expect(compile).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(captured.collisionIds).toEqual([]);
    expect([...captured.capabilities.keys()].filter((id) => id.endsWith('.metric_time'))).toEqual([
      'semantic:commerce:dimension:customers.metric_time',
      'semantic:commerce:dimension:orders.metric_time',
      'semantic:commerce:dimension:locations.metric_time',
      'semantic:commerce:dimension:order_item.metric_time',
    ]);
    expect(answer.result?.answerTier).toBe('semantic_metric');
    expect(state.resolvedPlan).toMatchObject({ frozen: true, tier: 'semantic' });
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'compile_and_run_semantic',
        outcome: 'executed',
        candidateIds: [
          'semantic:metric:order_item.revenue',
          'semantic:commerce:dimension:order_item.metric_time',
        ],
      }),
    ]));
  });

  it('AGT-047 binds the unique host-advertised semantic engine when a text controller omits engine', async () => {
    const metricId = 'semantic:metric:order_item.revenue';
    const timeId = 'semantic:uncategorized:dimension:order_item.metric_time';
    const metric: AgentEvidenceCandidate = {
      id: metricId, qualifiedId: metricId, kind: 'semantic_metric', semanticObjectType: 'metric', trustTier: 'semantic',
      name: 'revenue', semanticRuntimeName: 'revenue', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
      analyticalCapability: {
        executionCapabilities: [{ route: 'semantic', adapterId: 'metricflow' }],
        timeDimensions: [{ dimensionId: timeId }],
      } as never,
    };
    const metricTime: AgentEvidenceCandidate = {
      id: timeId, qualifiedId: timeId, kind: 'semantic_member', trustTier: 'semantic',
      name: 'metric_time', semanticRuntimeName: 'metric_time', timeGrains: ['day', 'month'],
      relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const candidates = [metric, metricTime];
    const captured = captureAskV2SemanticCapabilities({
      candidates,
      snapshotId: 'snapshot:semantic-engine-text',
      isCurrent: () => true,
      semanticRuntime: { version: 1, preference: 'auto', selectedEngine: 'metricflow-cli', readiness: 'ready' },
    });
    expect(captured.capabilities.get(metricId)?.engines).toEqual(['metricflow-cli']);
    expect(captured.capabilities.get(metricId)?.selectedEngine).toBe('metricflow-cli');
    const compile = vi.fn(async (selection: Record<string, unknown>) => {
      expect(selection).toMatchObject({
        metrics: ['revenue'],
        timeDimension: { name: 'metric_time', granularity: 'month' },
        engine: 'metricflow-cli',
      });
      return { sql: 'select 1 as revenue', engine: 'metricflow-cli' as const };
    });
    const execute = vi.fn(async () => ({ columns: ['metric_time', 'revenue'], rows: [{ metric_time: '2026-01-01', revenue: 1 }], rowCount: 1 }));
    const state = askV2State(candidates);
    const answer = await __test__.createAskV2LaneHandler(state)({
      question: 'Show revenue by month using the revenue semantic metric',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        // The host must bind metricflow-cli from the immutable capability;
        // the controller need not guess from a runtime name or display label.
        `\`\`\`json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["${metricId}"],"timeDimensionId":"${timeId}","timeGrain":"month"}}\n\`\`\``,
        '```json\n{"tool":"finish_answer","input":{"answer":"Revenue is grouped by month."}}\n```',
      ]),
      askAgentV2Workspace: askV2Workspace(candidates, {
        semanticCapabilities: captured.capabilities,
        semanticCapabilityCollisionIds: captured.collisionIds,
        semanticRuntime: { version: 1, preference: 'auto', selectedEngine: 'metricflow-cli', readiness: 'ready' },
      }),
      semanticQueryCompiler: compile,
      executeGeneratedSql: execute,
    } as never);

    expect(compile).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(answer.result?.answerTier).toBe('semantic_metric');
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'compile_and_run_semantic', outcome: 'executed', reasonCode: 'SEMANTIC_RESULT_VALIDATED' }),
    ]));
  });

  it('AGT-047 ignores a legacy runtime-name engine argument and executes the host-selected semantic capability once', async () => {
    const metricId = 'semantic:metric:order_item.revenue';
    const timeId = 'semantic:uncategorized:dimension:order_item.metric_time';
    const metric: AgentEvidenceCandidate = {
      id: metricId, qualifiedId: metricId, kind: 'semantic_metric', semanticObjectType: 'metric', trustTier: 'semantic',
      name: 'revenue', semanticRuntimeName: 'revenue', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
      analyticalCapability: {
        executionCapabilities: [{ route: 'semantic', adapterId: 'metricflow' }],
        timeDimensions: [{ dimensionId: timeId }],
      } as never,
    };
    const metricTime: AgentEvidenceCandidate = {
      id: timeId, qualifiedId: timeId, kind: 'semantic_member', trustTier: 'semantic',
      name: 'metric_time', semanticRuntimeName: 'metric_time', timeGrains: ['day', 'month'],
      relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const candidates = [metric, metricTime];
    const captured = captureAskV2SemanticCapabilities({
      candidates,
      snapshotId: 'snapshot:semantic-engine-retry',
      isCurrent: () => true,
    });
    const compile = vi.fn(async (selection: Record<string, unknown>) => {
      // The controller's raw runtime name `metric_time` cannot select the
      // adapter. The first and only execution uses the immutable host choice.
      expect(selection.engine).toBe('metricflow-cli');
      return { sql: 'select 1 as revenue', engine: 'metricflow-cli' as const };
    });
    const execute = vi.fn(async () => ({ columns: ['metric_time', 'revenue'], rows: [{ metric_time: '2026-01-01', revenue: 1 }], rowCount: 1 }));
    const state = askV2State(candidates);
    const answer = await __test__.createAskV2LaneHandler(state)({
      question: 'Show revenue by month using the revenue semantic metric',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        `\`\`\`json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["${metricId}"],"timeDimensionId":"${timeId}","timeGrain":"month","engine":"metric_time"}}\n\`\`\``,
        '```json\n{"tool":"finish_answer","input":{"answer":"Revenue is grouped by month."}}\n```',
      ]),
      askAgentV2Workspace: askV2Workspace(candidates, {
        semanticCapabilities: captured.capabilities,
        semanticCapabilityCollisionIds: captured.collisionIds,
      }),
      semanticQueryCompiler: compile,
      executeGeneratedSql: execute,
    } as never);

    expect(compile).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(answer.result?.answerTier).toBe('semantic_metric');
    expect(state.observations.filter((observation) => observation.tool === 'compile_and_run_semantic' && observation.outcome === 'executed')).toHaveLength(1);
    expect(state.observations.some((observation) => observation.reasonCode === 'SEMANTIC_ENGINE_INVALID')).toBe(false);
    expect(state.semanticRuntime).toMatchObject({ selectedEngine: 'metricflow-cli', readiness: 'ready' });
  });

  it('AGT-047 refuses a compiler result from a different frozen semantic engine before execution', async () => {
    const metricId = 'semantic:metric:order_item.revenue';
    const timeId = 'semantic:uncategorized:dimension:order_item.metric_time';
    const metric: AgentEvidenceCandidate = {
      id: metricId, qualifiedId: metricId, kind: 'semantic_metric', semanticObjectType: 'metric', trustTier: 'semantic',
      name: 'revenue', semanticRuntimeName: 'revenue', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
      analyticalCapability: {
        executionCapabilities: [{ route: 'semantic', adapterId: 'native' }],
        timeDimensions: [{ dimensionId: timeId }],
      } as never,
    };
    const metricTime: AgentEvidenceCandidate = {
      id: timeId, qualifiedId: timeId, kind: 'semantic_member', trustTier: 'semantic',
      name: 'metric_time', semanticRuntimeName: 'metric_time', timeGrains: ['day', 'month'],
      relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const candidates = [metric, metricTime];
    const captured = captureAskV2SemanticCapabilities({
      candidates,
      snapshotId: 'snapshot:semantic-engine-target-mismatch',
      isCurrent: () => true,
      semanticRuntime: { version: 1, preference: 'native', selectedEngine: 'native', readiness: 'ready' },
    });
    const compile = vi.fn(async (selection: Record<string, unknown>) => {
      expect(selection.engine).toBe('native');
      // A compiler result is still untrusted with respect to the frozen host
      // target. It must not route execution across engines.
      return { sql: 'select 1 as revenue', engine: 'metricflow-cli' as const };
    });
    const execute = vi.fn(async () => ({ columns: ['revenue'], rows: [{ revenue: 1 }], rowCount: 1 }));
    const state = askV2State(candidates);
    const answer = await __test__.createAskV2LaneHandler(state)({
      question: 'Show revenue by month using the revenue semantic metric',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        `\`\`\`json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["${metricId}"],"timeDimensionId":"${timeId}","timeGrain":"month"}}\n\`\`\``,
      ]),
      askAgentV2Workspace: askV2Workspace(candidates, {
        semanticCapabilities: captured.capabilities,
        semanticCapabilityCollisionIds: captured.collisionIds,
        semanticRuntime: { version: 1, preference: 'native', selectedEngine: 'native', readiness: 'ready' },
      }),
      semanticQueryCompiler: compile,
      executeGeneratedSql: execute,
    } as never);

    expect(compile).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(state.resolvedPlan).toMatchObject({ frozen: true, tier: 'semantic' });
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'compile_and_run_semantic',
        outcome: 'error',
        reasonCode: 'SEMANTIC_EXECUTION_TARGET_MISMATCH',
        origin: 'execution',
      }),
    ]));
    expect(state.terminalOutcome).toMatchObject({
      kind: 'execution_failure',
      reasonCode: 'SEMANTIC_EXECUTION_TARGET_MISMATCH',
      origin: 'execution',
      safeAction: 'inspect_execution_target',
    });
    const v8 = createAskToolKernelV2(state).diagnosticReceipt();
    expect(v8.terminalOutcome).toMatchObject({
      kind: 'execution_failure',
      reasonCode: 'SEMANTIC_EXECUTION_TARGET_MISMATCH',
      origin: 'execution',
      safeAction: 'inspect_execution_target',
    });
    expect(v8.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'compile_and_run_semantic',
        outcome: 'error',
        reasonCode: 'SEMANTIC_EXECUTION_TARGET_MISMATCH',
        origin: 'execution',
      }),
    ]));
    expect(answer.askAgentV2Outcome).toMatchObject({
      kind: 'execution_failure',
      reasonCode: 'SEMANTIC_EXECUTION_TARGET_MISMATCH',
      origin: 'execution',
      safeAction: 'inspect_execution_target',
    });
    expect(answer.text).toContain('did not match the frozen execution target');
  });

  it('AGT-047 keeps a multi-engine legacy capability pre-freeze unavailable when no host selection was captured', async () => {
    const metricId = 'semantic:metric:order_item.revenue';
    const timeId = 'semantic:uncategorized:dimension:order_item.metric_time';
    const metric: AgentEvidenceCandidate = {
      id: metricId, qualifiedId: metricId, kind: 'semantic_metric', semanticObjectType: 'metric', trustTier: 'semantic',
      name: 'revenue', semanticRuntimeName: 'revenue', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
      analyticalCapability: {
        executionCapabilities: [
          { route: 'semantic', adapterId: 'native' },
          { route: 'semantic', adapterId: 'metricflow' },
        ],
        timeDimensions: [{ dimensionId: timeId }],
      } as never,
    };
    const metricTime: AgentEvidenceCandidate = {
      id: timeId, qualifiedId: timeId, kind: 'semantic_member', trustTier: 'semantic',
      name: 'metric_time', semanticRuntimeName: 'metric_time', timeGrains: ['day', 'month'],
      relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const candidates = [metric, metricTime];
    const captured = captureAskV2SemanticCapabilities({ candidates, snapshotId: 'snapshot:semantic-engine-ambiguous', isCurrent: () => true });
    expect(captured.capabilities.get(metricId)?.engines).toEqual(['metricflow-cli', 'native']);
    const compile = vi.fn();
    const state = askV2State(candidates);
    const answer = await __test__.createAskV2LaneHandler(state)({
      question: 'Show revenue by month using the revenue semantic metric',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        `\`\`\`json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["${metricId}"],"timeDimensionId":"${timeId}","timeGrain":"month"}}\n\`\`\``,
      ]),
      askAgentV2Workspace: askV2Workspace(candidates, {
        semanticCapabilities: captured.capabilities,
        semanticCapabilityCollisionIds: captured.collisionIds,
      }),
      semanticQueryCompiler: compile,
      executeGeneratedSql: async () => ({ columns: [], rows: [], rowCount: 0 }),
    } as never);

    expect(compile).not.toHaveBeenCalled();
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'compile_and_run_semantic', outcome: 'ineligible', reasonCode: 'SEMANTIC_ENGINE_UNAVAILABLE',
        origin: 'validation',
      }),
    ]));
    expect(answer.askAgentV2Outcome).toMatchObject({ reasonCode: 'SEMANTIC_ENGINE_UNAVAILABLE', origin: 'validation' });
  });

  it('AGT-047 refuses semantic model and saved-query name collisions before compilation', async () => {
    const containers: AgentEvidenceCandidate[] = [
      {
        id: 'semantic:commerce:model:revenue', qualifiedId: 'semantic:commerce:model:revenue',
        kind: 'semantic_member', semanticObjectType: 'model', trustTier: 'semantic',
        name: 'revenue', semanticRuntimeName: 'revenue', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
      },
      {
        id: 'semantic:commerce:saved_query:revenue', qualifiedId: 'semantic:commerce:saved_query:revenue',
        kind: 'semantic_member', semanticObjectType: 'saved_query', trustTier: 'semantic',
        name: 'revenue', semanticRuntimeName: 'revenue', relevanceScore: 0.9, matchReasons: ['related'], compatibility: 'compatible',
      },
    ];
    const compile = vi.fn();
    const state = askV2State(containers);
    await __test__.createAskV2LaneHandler(state)({
      question: 'show revenue',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        '```json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["semantic:commerce:model:revenue"]}}\n```',
      ]),
      askAgentV2Workspace: askV2Workspace(containers),
      semanticQueryCompiler: compile,
      executeGeneratedSql: vi.fn(),
    } as never);

    expect(compile).not.toHaveBeenCalled();
    expect(state.resolvedPlan).toBeUndefined();
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'inspect_semantic_candidates', outcome: 'unavailable', reasonCode: 'SEMANTIC_CANDIDATES_EMPTY',
      }),
      expect.objectContaining({
        tool: 'compile_and_run_semantic', outcome: 'ineligible', reasonCode: 'SEMANTIC_IDENTIFIER_NOT_ADMITTED_TO_SNAPSHOT',
      }),
    ]));
  });

  it('AGT-047 records target-unavailable MetricFlow-only metrics as pre-freeze ineligible and permits a lower-tier inspection', async () => {
    const metricId = 'semantic:metric:metricflow_revenue';
    const metric: AgentEvidenceCandidate = {
      id: metricId, qualifiedId: metricId, kind: 'semantic_metric', semanticObjectType: 'metric', trustTier: 'semantic',
      name: 'metricflow_revenue', semanticRuntimeName: 'metricflow_revenue', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
      analyticalCapability: { executionCapabilities: [{ route: 'semantic', adapterId: 'metricflow' }] } as never,
    };
    const relational: AgentEvidenceCandidate = {
      id: 'model:orders', qualifiedId: 'model:orders', kind: 'dbt_model', trustTier: 'governed_sql',
      name: 'orders', relevanceScore: 0.8, matchReasons: ['related'], compatibility: 'compatible',
    };
    const captured = captureAskV2SemanticCapabilities({
      candidates: [metric, relational], snapshotId: 'snapshot:metricflow-unavailable', isCurrent: () => true,
      semanticRuntime: { version: 1, preference: 'metricflow-cli', selectedEngine: 'metricflow-cli', readiness: 'unavailable' },
      semanticCandidateReadiness: [{ candidateId: metricId, status: 'unavailable', engines: [] }],
    });
    const compile = vi.fn();
    const state = askV2State([metric, relational]);
    await __test__.createAskV2LaneHandler(state)({
      question: 'show metricflow revenue',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        `\`\`\`json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["${metricId}"]}}\n\`\`\``,
        '```json\n{"tool":"inspect_relational_context","input":{}}\n```',
      ]),
      askAgentV2Workspace: askV2Workspace([metric, relational], {
        semanticCapabilities: captured.capabilities,
        semanticCapabilityCollisionIds: captured.collisionIds,
        semanticRuntime: { version: 1, preference: 'metricflow-cli', selectedEngine: 'metricflow-cli', readiness: 'unavailable' },
      }),
      semanticQueryCompiler: compile,
      executeGeneratedSql: vi.fn(),
    } as never);

    expect(compile).not.toHaveBeenCalled();
    expect(state.resolvedPlan).toBeUndefined();
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'compile_and_run_semantic', outcome: 'ineligible', reasonCode: 'SEMANTIC_ENGINE_UNAVAILABLE', origin: 'validation',
      }),
      expect.objectContaining({ tool: 'inspect_relational_context', origin: 'retrieval' }),
    ]));
  });

  it('AGT-047 executes the one target-ready native engine when MetricFlow is advertised but unavailable', async () => {
    const metricId = 'semantic:metric:mixed_revenue';
    const metric: AgentEvidenceCandidate = {
      id: metricId, qualifiedId: metricId, kind: 'semantic_metric', semanticObjectType: 'metric', trustTier: 'semantic',
      name: 'mixed_revenue', semanticRuntimeName: 'mixed_revenue', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
      analyticalCapability: {
        executionCapabilities: [
          { route: 'semantic', adapterId: 'native' },
          { route: 'semantic', adapterId: 'metricflow' },
        ],
      } as never,
    };
    const captured = captureAskV2SemanticCapabilities({
      candidates: [metric], snapshotId: 'snapshot:mixed-semantic-readiness', isCurrent: () => true,
      semanticCandidateReadiness: [{ candidateId: metricId, status: 'ready', engines: ['native'] }],
    });
    const compile = vi.fn(async (selection: Record<string, unknown>) => {
      expect(selection).toMatchObject({ metrics: ['mixed_revenue'], engine: 'native' });
      return { sql: 'select 1 as revenue', engine: 'native' as const };
    });
    const state = askV2State([metric]);
    await __test__.createAskV2LaneHandler(state)({
      question: 'show mixed revenue',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        `\`\`\`json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["${metricId}"]}}\n\`\`\``,
        '```json\n{"tool":"finish_answer","input":{"answer":"Revenue is available."}}\n```',
      ]),
      askAgentV2Workspace: askV2Workspace([metric], {
        semanticCapabilities: captured.capabilities,
        semanticCapabilityCollisionIds: captured.collisionIds,
      }),
      semanticQueryCompiler: compile,
      executeGeneratedSql: async () => ({ columns: ['revenue'], rows: [{ revenue: 1 }], rowCount: 1 }),
    } as never);

    expect(compile).toHaveBeenCalledOnce();
    expect(captured.capabilities.get(metricId)?.engines).toEqual(['native']);
    expect(state.resolvedPlan).toMatchObject({ frozen: true, tier: 'semantic' });
  });

  it('AGT-047 retains a post-freeze semantic execution failure when a legacy engine argument is ignored', async () => {
    const metricId = 'semantic:metric:metricflow_revenue';
    const metric: AgentEvidenceCandidate = {
      id: metricId, qualifiedId: metricId, kind: 'semantic_metric', semanticObjectType: 'metric', trustTier: 'semantic',
      name: 'metricflow_revenue', semanticRuntimeName: 'metricflow_revenue', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
      analyticalCapability: { executionCapabilities: [{ route: 'semantic', adapterId: 'native' }] } as never,
    };
    const captured = captureAskV2SemanticCapabilities({ candidates: [metric], snapshotId: 'snapshot:semantic-failure-precedence', isCurrent: () => true });
    const state = askV2State([metric]);
    const answer = await __test__.createAskV2LaneHandler(state)({
      question: 'show revenue',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        `\`\`\`json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["${metricId}"],"engine":"metricflow_revenue"}}\n\`\`\``,
        `\`\`\`json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["${metricId}"]}}\n\`\`\``,
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
      ]),
      askAgentV2Workspace: askV2Workspace([metric], {
        semanticCapabilities: captured.capabilities,
        semanticCapabilityCollisionIds: captured.collisionIds,
      }),
      semanticQueryCompiler: async () => ({ sql: 'select 1 as revenue', engine: 'native' as const }),
      executeGeneratedSql: async () => { throw new Error('connection lost'); },
    } as never);

    expect(state.resolvedPlan).toMatchObject({ frozen: true, tier: 'semantic' });
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'compile_and_run_semantic', outcome: 'error', reasonCode: 'SEMANTIC_EXECUTION_FAILED', origin: 'execution' }),
    ]));
    expect(state.observations.some((observation) => observation.reasonCode === 'SEMANTIC_ENGINE_INVALID')).toBe(false);
    expect(answer.askAgentV2Outcome).toMatchObject({ kind: 'execution_failure', reasonCode: 'SEMANTIC_EXECUTION_FAILED', origin: 'execution' });
    expect(state.terminalOutcome).toMatchObject({ kind: 'execution_failure', reasonCode: 'SEMANTIC_EXECUTION_FAILED' });
  });

  it.each([
    ['OpenAI', () => new OpenAIProvider({ apiKey: 'test', baseUrl: 'https://example.test/v1', model: 'gpt-test' })],
    ['Claude', () => new ClaudeProvider({ apiKey: 'test', baseUrl: 'https://example.test/anthropic', model: 'claude-test' })],
  ])('AGT-047 keeps semantic engine host-owned for the %s native tool protocol', async (kind, createProvider) => {
    const metricId = 'semantic:metric:order_item.revenue';
    const timeId = 'semantic:uncategorized:dimension:order_item.metric_time';
    const metric: AgentEvidenceCandidate = {
      id: metricId, qualifiedId: metricId, kind: 'semantic_metric', semanticObjectType: 'metric', trustTier: 'semantic',
      name: 'revenue', semanticRuntimeName: 'revenue', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
      analyticalCapability: {
        executionCapabilities: [{ route: 'semantic', adapterId: 'metricflow' }],
        timeDimensions: [{ dimensionId: timeId }],
      } as never,
    };
    const metricTime: AgentEvidenceCandidate = {
      id: timeId, qualifiedId: timeId, kind: 'semantic_member', trustTier: 'semantic',
      name: 'metric_time', semanticRuntimeName: 'metric_time', timeGrains: ['day', 'month'],
      relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const candidates = [metric, metricTime];
    const captured = captureAskV2SemanticCapabilities({
      candidates,
      snapshotId: `snapshot:semantic-engine-${kind}`,
      isCurrent: () => true,
    });
    let send = 0;
    const advertisedEngineProperties: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      send += 1;
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        tools?: Array<{ function?: { name?: string; parameters?: { properties?: { engine?: { enum?: unknown } } } }; name?: string; input_schema?: { properties?: { engine?: { enum?: unknown } } } }>;
      };
      const semanticTool = (body.tools ?? []).find((tool) => tool.function?.name === 'compile_and_run_semantic' || tool.name === 'compile_and_run_semantic');
      if (semanticTool) {
        advertisedEngineProperties.push(
          semanticTool.function?.parameters?.properties?.engine
          ?? semanticTool.input_schema?.properties?.engine,
        );
      }
      const input = send === 1
        ? {}
        : send === 2
          ? {}
          : send === 3
            // The controller selected the exact admitted axis but omitted its
            // grain. The immutable user request supplies month; a stale
            // engine field still cannot change the host-selected adapter.
            ? { metricIds: [metricId], timeDimensionId: timeId, engine: 'metric_time' }
            : { answer: 'Revenue is grouped by month.' };
      const name = send === 1
        ? 'inspect_certified_candidates'
        : send === 2
          ? 'inspect_semantic_candidates'
          : send === 3
            ? 'compile_and_run_semantic'
            : 'finish_answer';
      const block = kind === 'OpenAI'
        ? { id: `tool_${send}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }
        : { type: 'tool_use', id: `tool_${send}`, name, input };
      return kind === 'OpenAI'
        ? new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [block] } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify({ content: [block] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    try {
      const compile = vi.fn(async (selection: Record<string, unknown>) => {
        expect(selection).toMatchObject({
          engine: 'metricflow-cli',
          timeDimension: { name: 'metric_time', granularity: 'month' },
        });
        return { sql: 'select 1 as revenue', engine: 'metricflow-cli' as const };
      });
      const execute = vi.fn(async () => ({ columns: ['metric_time', 'revenue'], rows: [{ metric_time: '2026-01-01', revenue: 1 }], rowCount: 1 }));
      const state = askV2State(candidates);
      const answer = await __test__.createAskV2LaneHandler(state)({
        question: 'Show revenue by month using the revenue semantic metric',
        provider: createProvider(),
        askAgentV2Workspace: askV2Workspace(candidates, {
          semanticCapabilities: captured.capabilities,
          semanticCapabilityCollisionIds: captured.collisionIds,
        }),
        semanticQueryCompiler: compile,
        executeGeneratedSql: execute,
      } as never);

      expect(send).toBe(4);
      expect(compile).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledOnce();
      expect(answer.result?.answerTier).toBe('semantic_metric');
      expect(state.observations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          tool: 'compile_and_run_semantic',
          outcome: 'eligible',
          reasonCode: 'SEMANTIC_TIME_BINDING_COMPLETED',
          candidateIds: [metricId, timeId],
        }),
      ]));
      expect(advertisedEngineProperties.length).toBeGreaterThan(0);
      expect(advertisedEngineProperties.every((property) => property === undefined)).toBe(true);
      expect(state.semanticRuntime).toMatchObject({ selectedEngine: 'metricflow-cli', readiness: 'ready' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('AGT-047 returns typed ambiguity instead of choosing among two metric-compatible metric_time axes', async () => {
    const firstTimeId = 'semantic:commerce:dimension:order_item.metric_time';
    const secondTimeId = 'semantic:commerce:dimension:orders.metric_time';
    const metric: AgentEvidenceCandidate = {
      id: 'semantic:metric:order_item.revenue',
      qualifiedId: 'semantic:metric:order_item.revenue',
      kind: 'semantic_metric',
      semanticObjectType: 'metric',
      trustTier: 'semantic',
      name: 'revenue',
      relevanceScore: 1,
      matchReasons: ['exact'],
      compatibility: 'compatible',
      analyticalCapability: {
        timeDimensions: [{ dimensionId: firstTimeId }, { dimensionId: secondTimeId }],
      } as never,
    };
    const metricTime = (id: string, model: string): AgentEvidenceCandidate => ({
      id,
      qualifiedId: id,
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      trustTier: 'semantic',
      name: 'metric_time',
      semanticRuntimeName: 'metric_time',
      semanticModel: model,
      sourceObjects: [model],
      aliases: ['semantic:uncategorized:dimension:metric_time'],
      timeGrains: ['day', 'month'],
      relevanceScore: 1,
      matchReasons: ['exact'],
      compatibility: 'compatible',
    });
    const candidates = [metric, metricTime(firstTimeId, 'order_item'), metricTime(secondTimeId, 'orders')];
    const captured = captureAskV2SemanticCapabilities({
      candidates,
      snapshotId: 'snapshot:metric-time-ambiguity',
      isCurrent: () => true,
    });
    const compile = vi.fn();
    const state = askV2State(candidates);
    await __test__.createAskV2LaneHandler(state)({
      question: 'Show revenue by month',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        '```json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["semantic:metric:order_item.revenue"],"timeDimensionId":"metric_time","timeGrain":"month"}}\n```',
        'No executable result.',
      ]),
      askAgentV2Workspace: askV2Workspace(candidates, {
        semanticCapabilities: captured.capabilities,
        semanticCapabilityCollisionIds: captured.collisionIds,
      }),
      semanticQueryCompiler: compile,
      executeGeneratedSql: vi.fn(),
    } as never);

    expect(compile).not.toHaveBeenCalled();
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'compile_and_run_semantic',
        outcome: 'ambiguous',
        reasonCode: 'SEMANTIC_TIME_DIMENSION_AMBIGUOUS',
      }),
    ]));
  });

  it('AGT-047 does not complete an omitted time axis when the selected metric has two admitted month-capable axes', async () => {
    const firstTimeId = 'semantic:commerce:dimension:order_item.metric_time';
    const secondTimeId = 'semantic:commerce:dimension:orders.metric_time';
    const metric: AgentEvidenceCandidate = {
      id: 'semantic:metric:order_item.revenue', qualifiedId: 'semantic:metric:order_item.revenue',
      kind: 'semantic_metric', semanticObjectType: 'metric', trustTier: 'semantic', name: 'revenue',
      relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
      analyticalCapability: {
        timeDimensions: [{ dimensionId: firstTimeId }, { dimensionId: secondTimeId }],
      } as never,
    };
    const time = (id: string, model: string): AgentEvidenceCandidate => ({
      id, qualifiedId: id, kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'metric_time', semanticRuntimeName: 'metric_time', semanticModel: model, timeGrains: ['day', 'month'],
      relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    });
    const candidates = [metric, time(firstTimeId, 'order_item'), time(secondTimeId, 'orders')];
    const captured = captureAskV2SemanticCapabilities({
      candidates,
      snapshotId: 'snapshot:semantic-month-completion-ambiguous',
      isCurrent: () => true,
    });
    const compile = vi.fn();
    const state = askV2State(candidates);
    const answer = await __test__.createAskV2LaneHandler(state)({
      question: 'Show revenue by month',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        '```json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["semantic:metric:order_item.revenue"]}}\n```',
        'No executable result.',
      ]),
      askAgentV2Workspace: askV2Workspace(candidates, {
        semanticCapabilities: captured.capabilities,
        semanticCapabilityCollisionIds: captured.collisionIds,
      }),
      semanticQueryCompiler: compile,
      executeGeneratedSql: vi.fn(),
    } as never);

    expect(compile).not.toHaveBeenCalled();
    expect(state.resolvedPlan).toBeUndefined();
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'compile_and_run_semantic',
        outcome: 'ambiguous',
        reasonCode: 'SEMANTIC_TIME_DIMENSION_AMBIGUOUS',
        safeAction: 'use:compile_and_run_semantic',
      }),
    ]));
    expect(answer.askAgentV2Outcome).toMatchObject({
      kind: 'gap',
      reasonCode: 'SEMANTIC_TIME_DIMENSION_AMBIGUOUS',
      origin: 'validation',
    });
  });

  it('keeps a canonical semantic metric bound to its own runtime name when another card reuses its legacy ID', async () => {
    const first: AgentEvidenceCandidate = {
      id: 'legacy:metric:revenue_a', qualifiedId: 'semantic:metric:revenue_a',
      kind: 'semantic_metric', semanticObjectType: 'metric', trustTier: 'semantic', name: 'Revenue A', semanticRuntimeName: 'runtime_revenue_a',
      relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const second: AgentEvidenceCandidate = {
      // A legacy lookup collision must not make this card replace the first
      // canonical capability. Their compiler runtime names are intentionally
      // distinct so a rebinding would be observable.
      id: first.qualifiedId!, qualifiedId: 'semantic:metric:revenue_b',
      kind: 'semantic_metric', semanticObjectType: 'metric', trustTier: 'semantic', name: 'Revenue B', semanticRuntimeName: 'runtime_revenue_b',
      relevanceScore: 0.9, matchReasons: ['related'], compatibility: 'compatible',
    };
    const captured = captureAskV2SemanticCapabilities({
      candidates: [first, second],
      snapshotId: 'snapshot:v2-test',
      isCurrent: () => true,
    });
    const compile = vi.fn(async (selection: { metrics: string[] }) => {
      expect(selection.metrics).toEqual(['runtime_revenue_a']);
      return { sql: 'select 1 as revenue_a', engine: 'native' as const };
    });
    const execute = vi.fn(async () => ({ columns: ['revenue_a'], rows: [{ revenue_a: 1 }], rowCount: 1 }));
    const state = askV2State([first, second]);
    await __test__.createAskV2LaneHandler(state)({
      question: 'show revenue a',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        '```json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["semantic:metric:revenue_a"]}}\n```',
        'semantic result finished',
      ]),
      askAgentV2Workspace: askV2Workspace([first, second], {
        semanticCapabilities: captured.capabilities,
      }),
      semanticQueryCompiler: compile,
      executeGeneratedSql: execute,
    } as never);

    expect(compile).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(state.resolvedPlan).toMatchObject({ frozen: true, tier: 'semantic', candidateIds: [first.qualifiedId] });
  });

  it('rejects a mismatched semantic capability handle instead of rebinding an opaque ID through a legacy collision', async () => {
    const first: AgentEvidenceCandidate = {
      id: 'legacy:metric:revenue_a', qualifiedId: 'semantic:metric:revenue_a',
      kind: 'semantic_metric', semanticObjectType: 'metric', trustTier: 'semantic', name: 'runtime_revenue_a',
      relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const second: AgentEvidenceCandidate = {
      // The legacy ID is deliberately the first candidate's canonical V2 ID.
      id: first.qualifiedId!, qualifiedId: 'semantic:metric:revenue_b',
      kind: 'semantic_metric', semanticObjectType: 'metric', trustTier: 'semantic', name: 'runtime_revenue_b',
      relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const secondHandle: AskSemanticCapabilityHandleV1 = {
      version: 1,
      candidateId: second.qualifiedId!,
      runtimeName: 'runtime_revenue_b',
      engines: ['native'],
      roles: ['metric'],
      fingerprint: 'semantic-capability:revenue-b',
      isCurrent: () => true,
    };
    const compile = vi.fn();
    const state = askV2State([first, second]);
    await __test__.createAskV2LaneHandler(state)({
      question: 'show revenue a',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        '```json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["semantic:metric:revenue_a"]}}\n```',
        'no result',
      ]),
      askAgentV2Workspace: askV2Workspace([first, second], {
        // Simulates a hostile/stale host map. The provider must reject this
        // even if a map entry exists under the requested opaque key.
        semanticCapabilities: new Map([[first.qualifiedId!, secondHandle]]),
      }),
      semanticQueryCompiler: compile,
      executeGeneratedSql: vi.fn(),
    } as never);

    expect(compile).not.toHaveBeenCalled();
    expect(state.resolvedPlan).toBeUndefined();
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'compile_and_run_semantic',
        outcome: 'ineligible',
        reasonCode: 'SEMANTIC_CAPABILITY_NOT_BOUND_OR_STALE',
      }),
    ]));
  });

  it('withholds duplicate canonical IDs with divergent compiler authority instead of compiling an arbitrary handle', async () => {
    const sharedId = 'semantic:metric:duplicate_revenue';
    const first: AgentEvidenceCandidate = {
      id: 'legacy:metric:duplicate-one', qualifiedId: sharedId,
      kind: 'semantic_metric', semanticObjectType: 'metric', trustTier: 'semantic', name: 'runtime_revenue',
      semanticRuntimeName: 'runtime_revenue', semanticModel: 'order_item', timeGrains: ['day', 'month'],
      sourceObjects: ['order_item'],
      analyticalCapability: {
        semanticModelId: 'semantic:commerce:model:order_item',
        timeDimensions: [{ dimensionId: 'semantic:commerce:dimension:order_item.metric_time' }],
      } as never,
      relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const second: AgentEvidenceCandidate = {
      id: 'legacy:metric:duplicate-two', qualifiedId: sharedId,
      // All short identity fields agree. Only the time-capability contract
      // differs, which must still fail closed: compiling the retained first
      // card while resolving this second card would be an authority split.
      kind: 'semantic_metric', semanticObjectType: 'metric', trustTier: 'semantic', name: 'runtime_revenue',
      semanticRuntimeName: 'runtime_revenue', semanticModel: 'order_item', timeGrains: ['day', 'month'],
      sourceObjects: ['order_item'],
      analyticalCapability: {
        semanticModelId: 'semantic:commerce:model:order_item',
        timeDimensions: [{ dimensionId: 'semantic:commerce:dimension:orders.metric_time' }],
      } as never,
      relevanceScore: 0.9, matchReasons: ['related'], compatibility: 'compatible',
    };
    const captured = captureAskV2SemanticCapabilities({
      candidates: [first, second],
      snapshotId: 'snapshot:divergent-duplicate-semantic-authority',
      isCurrent: () => true,
    });
    const compile = vi.fn();
    const state = askV2State([first, second]);
    await __test__.createAskV2LaneHandler(state)({
      question: 'show duplicate revenue',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        `\`\`\`json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["${sharedId}"]}}\n\`\`\``,
        'no result',
      ]),
      askAgentV2Workspace: askV2Workspace([first, second], {
        semanticCapabilities: captured.capabilities,
        semanticCapabilityCollisionIds: captured.collisionIds,
      }),
      semanticQueryCompiler: compile,
      executeGeneratedSql: vi.fn(),
    } as never);

    expect(compile).not.toHaveBeenCalled();
    expect(captured.collisionIds).toEqual([sharedId]);
    expect(captured.capabilities.has(sharedId)).toBe(false);
    expect(state.resolvedPlan).toBeUndefined();
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'compile_and_run_semantic',
        outcome: 'unavailable',
        reasonCode: 'SEMANTIC_CAPABILITY_ID_COLLISION',
      }),
    ]));
  });

  it('keeps malformed or undeclared semantic time/filter bindings pre-freeze and ineligible', async () => {
    const metric: AgentEvidenceCandidate = {
      id: 'semantic:metric:orders.revenue', qualifiedId: 'semantic:metric:orders.revenue', kind: 'semantic_metric', semanticObjectType: 'metric',
      trustTier: 'semantic', name: 'orders.revenue', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const orderedAt: AgentEvidenceCandidate = {
      id: 'semantic:dimension:orders.ordered_at', qualifiedId: 'semantic:dimension:orders.ordered_at', kind: 'semantic_member',
      trustTier: 'semantic', name: 'orders.ordered_at', timeGrains: ['day', 'month'], relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const compile = vi.fn();
    const state = askV2State([metric, orderedAt]);
    await __test__.createAskV2LaneHandler(state)({
      question: 'show revenue by quarter',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        '```json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["semantic:metric:orders.revenue"],"timeDimensionId":"semantic:dimension:orders.ordered_at","timeGrain":"quarter","filters":[{"dimensionId":"semantic:dimension:orders.ordered_at","value":{"invalid":true}}]}}\n```',
        'no result',
      ]),
      askAgentV2Workspace: askV2Workspace([metric, orderedAt]),
      semanticQueryCompiler: compile,
      executeGeneratedSql: vi.fn(),
    } as never);

    expect(compile).not.toHaveBeenCalled();
    expect(state.resolvedPlan).toBeUndefined();
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'compile_and_run_semantic', outcome: 'ineligible', reasonCode: 'SEMANTIC_FILTERS_INVALID', origin: 'validation' }),
    ]));
    expect(state.tierStates?.semantic).toMatchObject({ status: 'ineligible', reasonCode: 'SEMANTIC_FILTERS_INVALID' });
  });

  it('rejects an unsupported declared semantic grain before freeze', async () => {
    const metric: AgentEvidenceCandidate = {
      id: 'semantic:metric:orders.revenue', qualifiedId: 'semantic:metric:orders.revenue', kind: 'semantic_metric', semanticObjectType: 'metric',
      trustTier: 'semantic', name: 'orders.revenue', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const orderedAt: AgentEvidenceCandidate = {
      id: 'semantic:dimension:orders.ordered_at', qualifiedId: 'semantic:dimension:orders.ordered_at', kind: 'semantic_member',
      trustTier: 'semantic', name: 'orders.ordered_at', timeGrains: ['day', 'month'], relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const state = askV2State([metric, orderedAt]);
    await __test__.createAskV2LaneHandler(state)({
      question: 'show revenue by quarter',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        '```json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["semantic:metric:orders.revenue"],"timeDimensionId":"semantic:dimension:orders.ordered_at","timeGrain":"quarter"}}\n```',
        'no result',
      ]),
      askAgentV2Workspace: askV2Workspace([metric, orderedAt]),
      semanticQueryCompiler: vi.fn(),
      executeGeneratedSql: vi.fn(),
    } as never);

    expect(state.resolvedPlan).toBeUndefined();
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'compile_and_run_semantic', outcome: 'ineligible', reasonCode: 'SEMANTIC_TIME_GRAIN_NOT_DECLARED', origin: 'validation' }),
    ]));
  });

  it('AGT-047 rejects a generic inspection loop and still reserves execution plus narration after the immutable snapshot', async () => {
    const metricTimeId = 'semantic:dimension:orders.metric_time';
    const metric: AgentEvidenceCandidate = {
      id: 'semantic:metric:orders.revenue', qualifiedId: 'semantic:metric:orders.revenue',
      kind: 'semantic_metric', semanticObjectType: 'metric', trustTier: 'semantic', name: 'orders.revenue',
      relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
      analyticalCapability: { timeDimensions: [{ dimensionId: metricTimeId }] } as never,
    };
    // This progression test is about redundant inspection, not guessing a
    // missing time axis.  Give the host one admitted axis that explicitly
    // proves the request's month grain, so its bounded completion can remain
    // snapshot-bound while the controller still has to execute it.
    const metricTime: AgentEvidenceCandidate = {
      id: metricTimeId, qualifiedId: metricTimeId,
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic', name: 'metric_time',
      timeGrains: ['month'], relevanceScore: 0.9, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const state = askV2State([metric, metricTime]);
    const compile = vi.fn(async (selection: { metrics: string[] }) => {
      expect(selection.metrics).toEqual(['orders.revenue']);
      return { sql: 'select 1 as revenue', engine: 'native' as const };
    });
    const execute = vi.fn(async () => ({ columns: ['revenue'], rows: [{ revenue: 1 }], rowCount: 1 }));
    const answer = await __test__.createAskV2LaneHandler(state, { maxToolCalls: 8, maxProviderDispatches: 6 })({
      question: 'Show revenue by month using the revenue semantic metric',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_ask_context","input":{}}\n```',
        // Generic business context is not new analytical evidence. The host
        // rejects it and keeps the next controller action focused on tiers.
        '```json\n{"tool":"inspect_business_context","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["semantic:metric:orders.revenue"],"engine":"native"}}\n```',
        '```json\n{"tool":"finish_answer","input":{"answer":"Revenue result is ready."}}\n```',
      ]),
      askAgentV2Workspace: askV2Workspace([metric, metricTime]),
      semanticQueryCompiler: compile,
      executeGeneratedSql: execute,
    } as never);

    expect(compile).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(answer.result?.answerTier).toBe('semantic_metric');
    expect(state.resolvedPlan).toMatchObject({ frozen: true, tier: 'semantic' });
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'inspect_business_context', outcome: 'denied', reasonCode: 'ASK_V2_TOOL_PROGRESSION_REQUIRED' }),
      // Once the semantic inspector exposes one host-executable capability,
      // a later certified inspector is an off-route, zero-budget observation;
      // the next live controller turn still receives only semantic compile.
      expect.objectContaining({ tool: 'inspect_certified_candidates', outcome: 'denied', reasonCode: 'ASK_V2_TOOL_PROGRESSION_REQUIRED' }),
      expect.objectContaining({ tool: 'compile_and_run_semantic', outcome: 'executed', reasonCode: 'SEMANTIC_RESULT_VALIDATED' }),
      expect.objectContaining({ tool: 'finish_answer', outcome: 'eligible', reasonCode: 'ASK_V2_RESULT_NARRATED' }),
    ]));
  });

  it('AGT-047 turns a rejected premature finish into the reserved semantic execution action', async () => {
    const metric: AgentEvidenceCandidate = {
      id: 'semantic:metric:orders.revenue', qualifiedId: 'semantic:metric:orders.revenue',
      kind: 'semantic_metric', semanticObjectType: 'metric', trustTier: 'semantic', name: 'orders.revenue',
      relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const state = askV2State([metric]);
    const compile = vi.fn(async (selection: { filters?: Array<{ values?: unknown[] }> }) => ({ sql: `select 1 as revenue /* ${(selection.filters ?? []).flatMap((f) => f.values ?? []).join(' ')} */`, engine: 'native' as const }));
    const execute = vi.fn(async () => ({ columns: ['revenue'], rows: [{ revenue: 1 }], rowCount: 1 }));
    const answer = await __test__.createAskV2LaneHandler(state, { maxToolCalls: 8, maxProviderDispatches: 6 })({
      question: 'Show revenue using the revenue semantic metric',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_ask_context","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        // This is a live-policy violation, not a completed answer. The
        // following reserved controller send must receive semantic execution.
        '```json\n{"tool":"finish_answer","input":{"answer":"too early"}}\n```',
        '```json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["semantic:metric:orders.revenue"],"engine":"native"}}\n```',
        '```json\n{"tool":"finish_answer","input":{"answer":"Revenue result is ready."}}\n```',
      ]),
      askAgentV2Workspace: askV2Workspace([metric]),
      semanticQueryCompiler: compile,
      executeGeneratedSql: execute,
    } as never);

    expect(compile).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(answer.result?.answerTier).toBe('semantic_metric');
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'finish_answer', outcome: 'denied', reasonCode: 'ASK_V2_TOOL_PROGRESSION_REQUIRED' }),
      expect.objectContaining({ tool: 'compile_and_run_semantic', outcome: 'executed', reasonCode: 'SEMANTIC_RESULT_VALIDATED' }),
    ]));
  });

  it('AGT-047 reports a precise provider invalid-tool terminal after one constrained semantic-action retry', async () => {
    const metric: AgentEvidenceCandidate = {
      id: 'semantic:metric:orders.revenue', qualifiedId: 'semantic:metric:orders.revenue',
      kind: 'semantic_metric', semanticObjectType: 'metric', trustTier: 'semantic', name: 'orders.revenue',
      relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const state = askV2State([metric]);
    const dispatchedMessages: AgentMessage[][] = [];
    const responses = [
      '```json\n{"tool":"inspect_ask_context","input":{}}\n```',
      '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
      'I have enough context but will not call a tool.',
      'I still will not call the required semantic tool.',
    ];
    let responseIndex = 0;
    const answer = await __test__.createAskV2LaneHandler(state, { maxToolCalls: 8, maxProviderDispatches: 6 })({
      question: 'Show revenue by month using the revenue semantic metric',
      provider: {
        name: 'ollama',
        available: async () => true,
        generate: async (messages: AgentMessage[]) => {
          dispatchedMessages.push(messages);
          return responses[responseIndex++] ?? '';
        },
      },
      askAgentV2Workspace: askV2Workspace([metric]),
      semanticQueryCompiler: vi.fn(),
      executeGeneratedSql: vi.fn(),
    } as never);

    expect(state.controllerTier).toBe('semantic');
    expect(dispatchedMessages).toHaveLength(4);
    expect(dispatchedMessages[2]?.at(-1)?.content).toContain('compile_and_run_semantic');
    expect(dispatchedMessages[3]?.at(-1)?.content).toContain('Controller progression required');
    expect(answer.askAgentV2Outcome).toMatchObject({
      kind: 'provider_failure',
      reasonCode: 'ASK_V2_INVALID_TOOL_RESPONSE',
      origin: 'provider',
    });
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'finish_answer', outcome: 'error', reasonCode: 'ASK_V2_INVALID_TOOL_RESPONSE' }),
    ]));
    expect(answer.refusalCode).toBe('provider_error');
    expect(answer.text).toContain('AI provider could not complete');
  });

  it('rejects invented IDs and preserves the snapshot-bound failure instead of re-searching', async () => {
    const metric: AgentEvidenceCandidate = {
      id: 'semantic:metric:orders.revenue', qualifiedId: 'semantic:metric:orders.revenue',
      kind: 'semantic_metric', semanticObjectType: 'metric', trustTier: 'semantic', name: 'orders.revenue',
      relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const compile = vi.fn();
    const state = askV2State([metric]);
    await __test__.createAskV2LaneHandler(state)({
      question: 'show revenue',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        '```json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["semantic:metric:invented"]}}\n```',
        'no result',
      ]),
      askAgentV2Workspace: askV2Workspace([metric]),
      semanticQueryCompiler: compile,
      executeGeneratedSql: async () => ({ columns: [], rows: [], rowCount: 0 }),
    } as never);

    expect(compile).not.toHaveBeenCalled();
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'compile_and_run_semantic', outcome: 'ineligible', reasonCode: 'SEMANTIC_IDENTIFIER_NOT_ADMITTED_TO_SNAPSHOT' }),
    ]));
  });

  it('rejects a workspace from another snapshot before exposing cards or calling a compiler', async () => {
    const metric: AgentEvidenceCandidate = {
      id: 'semantic:metric:orders.revenue', qualifiedId: 'semantic:metric:orders.revenue',
      kind: 'semantic_metric', semanticObjectType: 'metric', trustTier: 'semantic', name: 'orders.revenue',
      relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const compile = vi.fn();
    const state = askV2State([metric]);
    await __test__.createAskV2LaneHandler(state)({
      question: 'show revenue',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_ask_context","input":{}}\n```',
        'no result',
      ]),
      askAgentV2Workspace: {
        version: 2,
        snapshotId: 'snapshot:other',
        sourceFingerprint: 'sha256:v2-test',
        getContextPack: () => ({}),
        getToolWorkspace: () => ({
          version: 1, snapshotId: 'snapshot:other', sourceFingerprint: 'sha256:v2-test', candidates: [metric], relationshipPathHandles: [],
        }),
      },
      semanticQueryCompiler: compile,
    } as never);

    expect(compile).not.toHaveBeenCalled();
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'inspect_ask_context', outcome: 'unavailable', reasonCode: 'V2_WORKSPACE_SNAPSHOT_MISMATCH' }),
    ]));
  });

  it('walks the tier ladder before a SQL-first tool request, at the host\'s expense not the analyst\'s', async () => {
    const column: AgentEvidenceCandidate = {
      id: 'sql:column:orders.revenue', qualifiedId: 'sql:column:orders.revenue', kind: 'sql_column',
      trustTier: 'exploratory', name: 'revenue', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const state = askV2State([column]);
    await __test__.createAskV2LaneHandler(state)({
      question: 'show revenue',
      provider: textToolProvider([
        '```json\n{"tool":"validate_and_run_sql","input":{"sql":"select revenue from orders","expectedOutputIds":["sql:column:orders.revenue"]}}\n```',
        'no result',
      ]),
      askAgentV2Workspace: askV2Workspace([column]),
    } as never);

    // The invariant is that no tier is SKIPPED, not that the analyst pays for
    // discovering it. Certified, semantic and relational are all host-owned
    // evidence here, so the host inspects them itself and the SQL request is
    // then judged on its own merits. Before this, the analyst spent three of
    // its own dispatches learning what the host already knew, and on a cold
    // large repo that was the entire budget.
    const ladder = state.observations.map((observation) => observation.tool);
    expect(ladder.slice(0, 3)).toEqual([
      'inspect_certified_candidates',
      'inspect_semantic_candidates',
      'inspect_relational_context',
    ]);
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'validate_and_run_sql' }),
    ]));
    // And it is never ADMITTED on a snapshot whose SQL does not validate.
    expect(state.observations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'validate_and_run_sql', outcome: 'executed' }),
    ]));
  });

  it('AGT-050 freezes at the host authorization boundary before a connection failure and permits one same-plan repair only', async () => {
    const column: AgentEvidenceCandidate = {
      id: 'sql:column:orders.revenue', qualifiedId: 'sql:column:orders.revenue', kind: 'sql_column',
      trustTier: 'exploratory', name: 'revenue', sourceObjects: ['analytics.orders'], relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const state = askV2State([column]);
    const prepareAskV2ExploratorySqlExecution = vi.fn(async (request: { repair?: boolean; planFingerprint: string }) => ({
      capability: { version: 1, candidateSqlFingerprint: `sql:${request.planFingerprint}` },
      freeze: {
        version: 1 as const,
        selectedTier: 'exploratory_sql' as const,
        planId: 'ask-v2:exploratory:host-freeze',
        planFingerprint: request.planFingerprint,
        snapshotId: 'snapshot:v2-test',
        targetFingerprint: 'target:host-test',
        sqlFingerprint: `sql:${request.planFingerprint}`,
        candidateIds: ['sql:column:orders.revenue'],
        authorization: 'capability_minted' as const,
      },
    }));
    const executeAgenticGeneratedSql = vi.fn(async () => {
      throw Object.assign(new Error('connection lost'), { code: 'connection_failed' });
    });
    const contextPack = {
      id: 'ctx:host-freeze', question: 'show revenue', focusObjectKey: null, mode: 'question', trustLabel: 'mixed',
      objects: [], edges: [], queryRuns: [], citations: [], evidenceSummaries: [], warnings: [], evidenceRoles: [],
      routeDecision: { route: 'generated_sql', intent: 'analytics', reason: 'test', trustLabel: 'mixed', reviewStatus: 'draft_ready', selectedEvidence: [], missingContext: [], followUps: [] },
      allowedSqlContext: { relations: [{ relation: 'analytics.orders', name: 'orders', source: 'test', columns: [{ name: 'revenue' }] }], sourceBlockSql: [] },
      missingContext: [], conflicts: [], retrievalDiagnostics: { strategy: 'sqlite_fts', selectedObjects: 0, selectedEvidence: [], topRejected: [], certifiedCandidateFits: [], candidateConflicts: [] },
      freshness: { catalogPath: '.dql/cache/metadata.sqlite', builtAt: null, fingerprint: null },
    };
    await __test__.createAskV2LaneHandler(state, { maxToolCalls: 8, maxProviderDispatches: 9 })({
      question: 'show revenue',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_relational_context","input":{}}\n```',
        '```json\n{"tool":"validate_and_run_sql","input":{"sql":"select revenue from analytics.orders","expectedOutputIds":["sql:column:orders.revenue"]}}\n```',
        // A cross-tier replacement is terminally denied after the first
        // authorization, before a second compiler or connection can run.
        '```json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["sql:column:orders.revenue"]}}\n```',
        '```json\n{"tool":"validate_and_run_sql","input":{"sql":"select revenue from analytics.orders","expectedOutputIds":["sql:column:orders.revenue"],"repair":true}}\n```',
        // The same frozen repair may run once, but its next failure remains
        // terminal. A third proposal cannot obtain a capability.
        '```json\n{"tool":"validate_and_run_sql","input":{"sql":"select revenue from analytics.orders","expectedOutputIds":["sql:column:orders.revenue"],"repair":true}}\n```',
        'no answer',
      ]),
      contextPack,
      askAgentV2Workspace: askV2Workspace([column], { contextPack }),
      prepareAskV2ExploratorySqlExecution,
      executeAgenticGeneratedSql,
    } as never);

    expect(state.observations.map((observation) => `${observation.tool}:${observation.outcome}:${observation.reasonCode}`)).toEqual(expect.arrayContaining([
      'validate_and_run_sql:eligible:ASK_V2_EXECUTION_AUTHORIZED',
      'validate_and_run_sql:error:EXPLORATORY_EXECUTION_FAILED',
    ]));
    expect(prepareAskV2ExploratorySqlExecution).toHaveBeenCalledTimes(2);
    expect(executeAgenticGeneratedSql).toHaveBeenCalledTimes(2);
    expect(state.resolvedPlan).toMatchObject({
      frozen: true,
      tier: 'exploratory_sql',
      candidateIds: ['sql:column:orders.revenue'],
    });
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'validate_and_run_sql', outcome: 'eligible', executionAuthorized: true, samePlanRepair: false }),
      expect.objectContaining({ tool: 'validate_and_run_sql', outcome: 'error', reasonCode: 'EXPLORATORY_EXECUTION_FAILED' }),
      expect.objectContaining({ tool: 'compile_and_run_semantic', outcome: 'denied', reasonCode: 'POST_FREEZE_ROUTE_CHANGE_DENIED' }),
      expect.objectContaining({ tool: 'validate_and_run_sql', outcome: 'eligible', executionAuthorized: true, samePlanRepair: true }),
      expect.objectContaining({ tool: 'validate_and_run_sql', outcome: 'denied', reasonCode: 'ASK_REPAIR_BUDGET_EXHAUSTED' }),
    ]));
  });

  it('executes governed relational DQL from admitted IDs and atomic paths without a V1 compilation', async () => {
    const relation: AgentEvidenceCandidate = {
      id: 'dbt:model:orders', qualifiedId: 'dbt:model:orders', kind: 'dbt_model', trustTier: 'governed_sql',
      name: 'orders', sourceObjects: ['analytics.orders'], relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const path = {
      version: 1 as const,
      id: 'relationship-path:orders-customers',
      edgeIds: ['edge:orders.customer_id', 'edge:customers.customer_id'],
      candidateIds: ['dbt:model:orders'],
      snapshotId: 'snapshot:v2-test',
    };
    const executeAskV2DqlArtifact = vi.fn(async (request: { artifact: { source: string }; relationshipPathIds: string[] }) => {
      expect(request.artifact.source).toBe('from orders | summarize order_count = count()');
      expect(request.relationshipPathIds).toEqual(['relationship-path:orders-customers']);
      return { columns: ['order_count'], rows: [{ order_count: 1 }], rowCount: 1 };
    });
    const authorizeAskV2DqlArtifact = vi.fn(async (request: { relationshipPathIds: string[] }) => {
      expect(request.relationshipPathIds).toEqual(['relationship-path:orders-customers']);
      return { planId: 'ask-v2:governed:orders-customers', targetFingerprint: 'target:orders-customers' };
    });
    const state = askV2State([relation]);
    state.relationshipPathHandles = [path];
    const result = await __test__.createAskV2LaneHandler(state)({
      question: 'show order count by customer',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_ask_context","input":{}}\n```',
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        '```json\n{"tool":"compile_and_run_dql","input":{"dqlProgram":"from orders | summarize order_count = count()","measureIds":["dbt:model:orders"],"expectedOutputIds":["dbt:model:orders"],"relationshipPathIds":["relationship-path:orders-customers"]}}\n```',
        '```json\n{"tool":"finish_answer","input":{"answer":"Order count is ready."}}\n```',
      ]),
      askAgentV2Workspace: askV2Workspace([relation], { paths: [path] }),
      authorizeAskV2DqlArtifact,
      executeAskV2DqlArtifact,
      // Absence is deliberate: authoritative V2 does not read a router
      // compilation produced by the V1 deterministic cascade.
    } as never);

    expect(executeAskV2DqlArtifact).toHaveBeenCalledOnce();
    expect(authorizeAskV2DqlArtifact).toHaveBeenCalledOnce();
    expect(result.result?.answerTier).toBe('governed_relational');
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'compile_and_run_dql', outcome: 'executed', candidateIds: ['dbt:model:orders'] }),
    ]));
  });

  it('AGT-047 commits governed relational execution when the controller inspects an admitted customer/revenue/region relation', async () => {
    // This is a governed, pre-joined relation. It intentionally has no
    // relationship path: the test proves that a relational inspector, rather
    // than a semantic card or preloaded path handle, creates the V2 route
    // commitment and exposes only DQL execution next.
    const customerRevenueRegion: AgentEvidenceCandidate = {
      id: 'dbt:model:customer_revenue_by_region', qualifiedId: 'dbt:model:customer_revenue_by_region',
      kind: 'dbt_model', trustTier: 'governed_sql', name: 'customer_revenue_by_region',
      sourceObjects: ['analytics.customer_revenue_by_region'], relevanceScore: 1,
      matchReasons: ['customer revenue region'], compatibility: 'compatible',
    };
    const state = askV2State([customerRevenueRegion]);
    const authorize = vi.fn(async (request: { candidateIds: string[]; relationshipPathIds: string[] }) => {
      expect(request.candidateIds).toEqual(['dbt:model:customer_revenue_by_region']);
      expect(request.relationshipPathIds).toEqual([]);
      return { planId: 'ask-v2:governed:customer-revenue-region', targetFingerprint: 'target:customer-revenue-region' };
    });
    const execute = vi.fn(async () => ({
      columns: ['customer_name', 'region', 'revenue'],
      rows: [{ customer_name: 'Melissa Davis', region: 'West', revenue: 1411 }],
      rowCount: 1,
    }));

    const answer = await __test__.createAskV2LaneHandler(state, { maxToolCalls: 8, maxProviderDispatches: 6 })({
      question: 'who are the top customers by revenue by region?',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_ask_context","input":{}}\n```',
        // This inspector owns the route choice; no semantic/certified
        // inspection is allowed after it becomes executable.
        '```json\n{"tool":"inspect_relational_context","input":{}}\n```',
        '```json\n{"tool":"compile_and_run_dql","input":{"dqlProgram":"from customer_revenue_by_region | summarize revenue = sum(revenue) by customer_name, region | order by revenue desc","measureIds":["dbt:model:customer_revenue_by_region"],"expectedOutputIds":["dbt:model:customer_revenue_by_region"]}}\n```',
        '```json\n{"tool":"finish_answer","input":{"answer":"Top customers by revenue and region are ready."}}\n```',
      ]),
      askAgentV2Workspace: askV2Workspace([customerRevenueRegion]),
      authorizeAskV2DqlArtifact: authorize,
      executeAskV2DqlArtifact: execute,
    } as never);

    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'inspect_relational_context', outcome: 'eligible' }),
      expect.objectContaining({
        tool: 'compile_and_run_dql', outcome: 'executed', reasonCode: 'GOVERNED_RELATIONAL_RESULT_VALIDATED',
        candidateIds: ['dbt:model:customer_revenue_by_region'],
      }),
    ]));
    expect(authorize).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(answer.result).toMatchObject({ answerTier: 'governed_relational', rowCount: 1 });
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'inspect_ask_context', outcome: 'eligible', reasonCode: 'initial_snapshot_context' }),
      expect.objectContaining({ tool: 'compile_and_run_dql', outcome: 'executed', reasonCode: 'GOVERNED_RELATIONAL_RESULT_VALIDATED' }),
      expect.objectContaining({ tool: 'finish_answer', outcome: 'eligible', reasonCode: 'ASK_V2_RESULT_NARRATED' }),
    ]));
  });

  it('rejects a governed relational path that was not admitted with the snapshot', async () => {
    const relation: AgentEvidenceCandidate = {
      id: 'dbt:model:orders', qualifiedId: 'dbt:model:orders', kind: 'dbt_model', trustTier: 'governed_sql',
      name: 'orders', sourceObjects: ['analytics.orders'], relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const path = { version: 1 as const, id: 'relationship-path:orders-customers', edgeIds: ['edge:orders.customer_id', 'edge:customers.customer_id'], candidateIds: ['dbt:model:orders'], snapshotId: 'snapshot:v2-test' };
    const executeAskV2DqlArtifact = vi.fn();
    const authorizeAskV2DqlArtifact = vi.fn();
    const state = askV2State([relation]);
    state.relationshipPathHandles = [path];
    await __test__.createAskV2LaneHandler(state)({
      question: 'show order count by customer',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_relational_context","input":{}}\n```',
        '```json\n{"tool":"compile_and_run_dql","input":{"dqlProgram":"from orders | summarize order_count = count()","measureIds":["dbt:model:orders"],"expectedOutputIds":["dbt:model:orders"],"relationshipPathIds":["relationship-path:invented"]}}\n```',
        'no result',
      ]),
      askAgentV2Workspace: askV2Workspace([relation], { paths: [path] }),
      authorizeAskV2DqlArtifact,
      executeAskV2DqlArtifact,
    } as never);

    expect(authorizeAskV2DqlArtifact).not.toHaveBeenCalled();
    expect(executeAskV2DqlArtifact).not.toHaveBeenCalled();
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'compile_and_run_dql', outcome: 'ineligible', reasonCode: 'GOVERNED_RELATIONAL_IDENTIFIER_OR_PATH_NOT_ADMITTED' }),
    ]));
  });

  it('permits one syntax-only governed-DQL repair and rejects widened or changed logical semantics before host execution', async () => {
    const relation: AgentEvidenceCandidate = {
      id: 'dbt:model:orders', qualifiedId: 'dbt:model:orders', kind: 'dbt_model', trustTier: 'governed_sql',
      name: 'orders', sourceObjects: ['analytics.orders'], relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const physicalPath = {
      leftRelation: 'analytics.orders',
      leftColumn: 'customer_id',
      rightRelation: 'analytics.customers',
      rightColumn: 'customer_id',
    };
    const admittedPathId = askV2RelationshipPathHandleId(physicalPath);
    const admittedPath = {
      version: 1 as const,
      id: admittedPathId,
      edgeIds: ['edge:orders.customer_id', 'edge:customers.customer_id'],
      candidateIds: ['dbt:model:orders'],
      snapshotId: 'snapshot:v2-test',
    };
    const widenedPath = {
      version: 1 as const,
      id: 'relationship-path:orders-products',
      edgeIds: ['edge:orders.product_id', 'edge:products.product_id'],
      candidateIds: ['dbt:model:orders'],
      snapshotId: 'snapshot:v2-test',
    };
    const executedPrograms: string[] = [];
    const authorizeAskV2DqlArtifact = vi.fn(async () => ({
      planId: 'ask-v2:governed:orders',
      targetFingerprint: 'target:orders',
    }));
    const executeAskV2DqlArtifact = vi.fn(async (request: { artifact: { source: string } }) => {
      executedPrograms.push(request.artifact.source);
      // The production V2 host validates the compiled physical query against
      // the frozen path closure. Model that boundary here rather than treating
      // matching opaque IDs alone as proof that a repaired program is safe.
      assertAskV2BoundRelationshipPathsForSql({
        sql: `
          SELECT orders.order_id
          FROM analytics.orders AS orders
          JOIN analytics.customers AS customers
            ON orders.customer_id = customers.customer_id
        `,
        relationshipPathIds: [admittedPathId],
        paths: [physicalPath],
      });
      if (executedPrograms.length === 1) {
        throw Object.assign(new Error('The first DQL program did not compile.'), {
          code: 'dql_syntax_invalid',
          stage: 'validation',
        });
      }
      return { columns: ['order_count'], rows: [{ order_count: 1 }], rowCount: 1 };
    });
    const state = askV2State([relation]);
    state.relationshipPathHandles = [admittedPath, widenedPath];

    const result = await __test__.createAskV2LaneHandler(state, {
      maxToolCalls: 8,
      // Four tool proposals and the final evidence-bound narration each consume
      // a controller send. Keep the provider ceiling above that test
      // choreography; the tool ceiling remains the contract under test.
      maxProviderDispatches: 10,
    })({
      question: 'show order count by customer',
      // The tier ladder is no longer scripted here: certified, semantic and
      // relational are host-owned evidence the host now inspects itself before
      // the first dispatch, so an analyst that repeated them would simply be
      // told they are redundant. What this test is about starts below.
      provider: textToolProvider([
        `\`\`\`json\n{"tool":"compile_and_run_dql","input":{"dqlProgram":"from orders | summarize order_count = count()","measureIds":["dbt:model:orders"],"expectedOutputIds":["dbt:model:orders"],"relationshipPathIds":["${admittedPathId}"]}}\n\`\`\``,
        // This attempt widens the immutable relationship closure. It must be
        // denied before the host is asked to mint a second capability.
        `\`\`\`json\n{"tool":"compile_and_run_dql","input":{"dqlProgram":"from orders | join products on orders.product_id = products.product_id | summarize order_count = count()","measureIds":["dbt:model:orders"],"expectedOutputIds":["dbt:model:orders"],"relationshipPathIds":["${admittedPathId}","relationship-path:orders-products"],"repair":true}}\n\`\`\``,
        // Same IDs/path do not make a changed filter a same-plan repair.
        `\`\`\`json\n{"tool":"compile_and_run_dql","input":{"dqlProgram":"from orders | where order_id is not null | summarize order_count = count()","measureIds":["dbt:model:orders"],"expectedOutputIds":["dbt:model:orders"],"relationshipPathIds":["${admittedPathId}"],"repair":true}}\n\`\`\``,
        // Nor can a repair change the aggregation/output contract.
        `\`\`\`json\n{"tool":"compile_and_run_dql","input":{"dqlProgram":"from orders | summarize order_count = sum(order_id)","measureIds":["dbt:model:orders"],"expectedOutputIds":["dbt:model:orders"],"relationshipPathIds":["${admittedPathId}"],"repair":true}}\n\`\`\``,
        // Parser/casing/whitespace presentation may change while the full
        // normalized logical program remains identical.
        `\`\`\`json\n{"tool":"compile_and_run_dql","input":{"dqlProgram":"FROM orders|SUMMARIZE order_count=count();","measureIds":["dbt:model:orders"],"expectedOutputIds":["dbt:model:orders"],"relationshipPathIds":["${admittedPathId}"],"repair":true}}\n\`\`\``,
        'governed result finished',
      ]),
      askAgentV2Workspace: askV2Workspace([relation], { paths: [admittedPath, widenedPath] }),
      authorizeAskV2DqlArtifact,
      executeAskV2DqlArtifact,
    } as never);

    expect(result.result?.answerTier).toBe('governed_relational');
    expect(executedPrograms).toEqual([
      'from orders | summarize order_count = count()',
      'FROM orders|SUMMARIZE order_count=count();',
    ]);
    // The widened path and changed logical program are rejected by the kernel
    // before a second host capability can be minted. Only the syntax/casing
    // repair retains the frozen plan.
    expect(authorizeAskV2DqlArtifact).toHaveBeenCalledTimes(2);
    expect(executeAskV2DqlArtifact).toHaveBeenCalledTimes(2);
    expect(state.observations.filter((observation) =>
      observation.tool === 'compile_and_run_dql'
      && observation.outcome === 'denied'
      && observation.reasonCode === 'POST_FREEZE_PLAN_MUTATION_DENIED')).toHaveLength(3);
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'compile_and_run_dql', outcome: 'error', reasonCode: 'GOVERNED_RELATIONAL_EXECUTION_FAILED' }),
      expect.objectContaining({ tool: 'compile_and_run_dql', outcome: 'denied', reasonCode: 'POST_FREEZE_PLAN_MUTATION_DENIED' }),
      expect.objectContaining({ tool: 'compile_and_run_dql', outcome: 'eligible', samePlanRepair: true, relationshipPathIds: [admittedPathId] }),
      expect.objectContaining({ tool: 'compile_and_run_dql', outcome: 'executed', reasonCode: 'GOVERNED_RELATIONAL_RESULT_VALIDATED' }),
    ]));
  });

  it('requires both V2 DQL authorization and execution capabilities before governed relational freeze', async () => {
    const relation: AgentEvidenceCandidate = {
      id: 'dbt:model:orders', qualifiedId: 'dbt:model:orders', kind: 'dbt_model', trustTier: 'governed_sql',
      name: 'orders', sourceObjects: ['analytics.orders'], relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const executeAskV2DqlArtifact = vi.fn();
    const state = askV2State([relation]);
    await __test__.createAskV2LaneHandler(state)({
      question: 'show order count',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_relational_context","input":{}}\n```',
        '```json\n{"tool":"compile_and_run_dql","input":{"dqlProgram":"from orders | summarize order_count = count()","measureIds":["dbt:model:orders"],"expectedOutputIds":["dbt:model:orders"]}}\n```',
        'no result',
      ]),
      askAgentV2Workspace: askV2Workspace([relation], {
        tierStates: {
          governed_relational: {
            version: 1,
            status: 'available',
            candidateIds: ['dbt:model:orders'],
            reasonCode: 'GOVERNED_RELATIONAL_CONTEXT_AVAILABLE',
          },
        },
      }),
      executeAskV2DqlArtifact,
    } as never);

    expect(executeAskV2DqlArtifact).not.toHaveBeenCalled();
    expect(state.resolvedPlan).toBeUndefined();
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'compile_and_run_dql', outcome: 'ineligible', reasonCode: 'GOVERNED_RELATIONAL_EXECUTION_UNAVAILABLE' }),
    ]));
  });

  it('runs an explicit Research plan as independent V2 branches and keeps lineage dedicated', async () => {
    const relation: AgentEvidenceCandidate = {
      id: 'dbt:model:orders', qualifiedId: 'dbt:model:orders', kind: 'dbt_model', trustTier: 'exploratory',
      name: 'orders', sourceObjects: ['analytics.orders'], relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const paths = [{ version: 1 as const, id: 'relationship-path:orders-customers', edgeIds: ['edge:orders.customer_id', 'edge:customers.customer_id'], candidateIds: ['dbt:model:orders'], snapshotId: 'snapshot:v2-test' }];
    const state = askV2State([relation], 'research');
    state.relationshipPathHandles = paths;
    const answer = await __test__.createAskV2ResearchLaneHandler(state)({
      question: 'Research order and customer behaviour',
      provider: textToolProvider([
        JSON.stringify({ hypotheses: [
          { kind: 'analytical', question: 'show order count' },
          { kind: 'lineage', question: 'inspect order customer lineage' },
          { kind: 'analytical', question: 'show customers' },
        ] }),
        'No executable result was selected.',
        'No executable result was selected.',
      ]),
      askAgentV2Workspace: askV2Workspace([relation], { paths }),
    } as never);

    expect(answer.askAgentV2Outcome).toMatchObject({ kind: 'finish_answer' });
    expect(state.researchLedgerV4).toMatchObject({ version: 4, limitedScope: false });
    expect(state.researchLedgerV4?.branches).toEqual(expect.arrayContaining([
      expect.objectContaining({ lineageProgram: 'dedicated', evidenceHandleIds: ['relationship-path:orders-customers'] }),
    ]));
  });

  it('does not promote an execution-only Research branch without a deterministic result receipt or facts', () => {
    const relation: AgentEvidenceCandidate = {
      id: 'dbt:model:orders', qualifiedId: 'dbt:model:orders', kind: 'dbt_model', trustTier: 'exploratory',
      name: 'orders', sourceObjects: ['analytics.orders'], relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const child = askV2State([relation]);
    child.observations.push({
      version: 1,
      tool: 'validate_and_run_sql',
      outcome: 'executed',
      reasonCode: 'EXPLORATORY_RESULT_VALIDATED',
      candidateIds: ['dbt:model:orders'],
      origin: 'execution',
    });
    const branch = __test__.askV2ResearchAnalyticalBranchReceipt({
      id: 'research:branch:1',
      child,
      answer: {
        kind: 'uncertified',
        text: 'A transport said it executed.',
        answer: 'A transport said it executed.',
        citations: [],
        considered: [],
        result: { columns: ['order_id'], rows: [{ order_id: '1' }], rowCount: 1 },
        askAgentV2Outcome: { version: 2, kind: 'finish_answer', reasonCode: 'ASK_V2_VALIDATED_RESULT', origin: 'execution' },
      } as never,
    });

    expect(branch.verdict).toBe('inconclusive');
    expect(branch.validatorEvidenceHandleIds).toBeUndefined();
  });

  it('records a supported Research branch only after receipt validation', () => {
    const relation: AgentEvidenceCandidate = {
      id: 'dbt:model:orders', qualifiedId: 'dbt:model:orders', kind: 'dbt_model', trustTier: 'exploratory',
      name: 'orders', sourceObjects: ['analytics.orders'], relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const child = askV2State([relation]);
    child.observations.push({
      version: 1,
      tool: 'validate_and_run_sql',
      outcome: 'executed',
      reasonCode: 'EXPLORATORY_RESULT_VALIDATED',
      candidateIds: ['dbt:model:orders'],
      origin: 'execution',
    });
    const fingerprint = 'a'.repeat(64);
    const branch = __test__.askV2ResearchAnalyticalBranchReceipt({
      id: 'research:branch:1',
      child,
      answer: {
        kind: 'uncertified', text: 'Validated result.', answer: 'Validated result.', citations: [], considered: [],
        result: {
          columns: ['order_id'], rows: [{ order_id: '1' }], rowCount: 1, resultFingerprint: fingerprint,
          executionReceipt: {
            sourceFingerprint: 'b'.repeat(64),
            compiledSqlFingerprint: 'c'.repeat(64),
            parameterFingerprint: 'd'.repeat(64),
            resultFingerprint: fingerprint,
          },
        },
        askAgentV2Outcome: { version: 2, kind: 'finish_answer', reasonCode: 'ASK_V2_VALIDATED_RESULT', origin: 'execution' },
      } as never,
    });

    expect(branch).toMatchObject({
      verdict: 'supported',
      validatorEvidenceHandleIds: [`receipt:${fingerprint}`],
    });
  });

  it('runs the root-frozen dedicated lineage program and persists only its sanitized structural receipt handles', async () => {
    const relation: AgentEvidenceCandidate = {
      id: 'dbt:model:orders', qualifiedId: 'dbt:model:orders', kind: 'dbt_model', trustTier: 'exploratory',
      name: 'orders', sourceObjects: ['analytics.orders'], relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const state = askV2State([relation], 'research');
    const lineageProgram = vi.fn(() => ({
      status: 'completed' as const,
      evidenceHandleIds: ['lineage:structural-fingerprint'],
      validatorEvidenceHandleIds: ['lineage-validator:structural-fingerprint'],
      receiptFingerprint: 'sha256:lineage-receipt',
    }));
    await __test__.createAskV2ResearchLaneHandler(state)({
      question: 'Research the lineage of orders',
      provider: textToolProvider([
        JSON.stringify({ hypotheses: [{ kind: 'lineage', question: 'inspect orders lineage' }] }),
      ]),
      askAgentV2Workspace: askV2Workspace([relation], { runDedicatedLineageProgram: lineageProgram }),
    } as never);

    expect(lineageProgram).toHaveBeenCalledWith(expect.objectContaining({
      snapshotId: 'snapshot:v2-test',
      targetCandidateIds: ['dbt:model:orders'],
    }));
    expect(state.researchLedgerV4?.branches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        lineageProgram: 'dedicated',
        evidenceHandleIds: ['lineage:structural-fingerprint'],
        validatorEvidenceHandleIds: ['lineage-validator:structural-fingerprint'],
        childReceiptFingerprint: 'sha256:lineage-receipt',
      }),
    ]));
  });

  it('runs root-frozen V2 certified and semantic Research children with zero child provider egress', async () => {
    const semantic: AgentEvidenceCandidate = {
      id: 'semantic:metric:revenue', qualifiedId: 'semantic:metric:revenue', kind: 'semantic_metric', semanticObjectType: 'metric',
      trustTier: 'semantic', name: 'revenue', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const certified: AgentEvidenceCandidate = {
      id: 'block:top-customers', qualifiedId: 'block:top-customers', kind: 'certified_block',
      trustTier: 'certified', name: 'top customers', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const relation: AgentEvidenceCandidate = {
      id: 'dbt:model:orders', qualifiedId: 'dbt:model:orders', kind: 'dbt_model',
      trustTier: 'governed_sql', name: 'orders', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const state = askV2State([semantic, certified, relation], 'research');
    const receipt = (seed: string) => ({
      sourceFingerprint: `${seed}`.repeat(64).slice(0, 64),
      compiledSqlFingerprint: `${seed === 'a' ? 'b' : 'd'}`.repeat(64).slice(0, 64),
      parameterFingerprint: `${seed === 'a' ? 'c' : 'e'}`.repeat(64).slice(0, 64),
      resultFingerprint: `${seed === 'a' ? 'f' : '9'}`.repeat(64).slice(0, 64),
    });
    const frozenChild = (id: string, tier: 'semantic' | 'certified', candidate: AgentEvidenceCandidate, seed: string) => {
      const child = askV2State([semantic, certified, relation]);
      const executionReceipt = receipt(seed);
      const candidateId = candidate.qualifiedId ?? candidate.id;
      child.resolvedPlan = {
        version: 3,
        id: `ask-v2:${tier}:${seed}`,
        snapshotId: 'snapshot:v2-test',
        tier,
        candidateIds: [candidateId],
        frozen: true,
        reviewRequired: tier !== 'certified',
        fingerprint: `plan:${seed}`,
      };
      child.observations.push({
        version: 1,
        tool: tier === 'certified' ? 'run_certified' : 'compile_and_run_semantic',
        tier,
        outcome: 'executed',
        reasonCode: `${tier.toUpperCase()}_RESULT_VALIDATED`,
        candidateIds: [candidateId],
        origin: 'execution',
      });
      const execute = vi.fn(async () => ({
        state: child,
        answer: {
          kind: tier === 'certified' ? 'certified' : 'uncertified',
          text: `${tier} result`, answer: `${tier} result`, citations: [], considered: [],
          result: {
            columns: ['value'], rows: [{ value: 1 }], rowCount: 1,
            resultFingerprint: executionReceipt.resultFingerprint,
            executionReceipt,
          },
          askAgentV2Outcome: { version: 2, kind: 'finish_answer', reasonCode: 'ASK_V2_VALIDATED_RESULT', origin: 'execution' },
        },
      }));
      const handle = {
          version: 1 as const,
          id,
          snapshotId: 'snapshot:v2-test',
          sourceFingerprint: 'sha256:v2-test',
          tier,
          candidateIds: [candidateId],
          binding: {
            version: 1 as const,
            parameters: {},
            trustState: (tier === 'certified' ? 'certified' : 'governed') as 'certified' | 'governed',
            planFingerprint: `plan:${seed}`,
            ...(tier === 'certified'
              ? { artifactRevisionFingerprint: `artifact:${seed}` }
              : { capabilityFingerprints: [`capability:${seed}`] }),
          },
          isCurrent: () => true,
          execute,
      } satisfies AskFrozenResearchChildHandleV1;
      return {
        handle,
        execute,
      };
    };
    const frozenSemantic = frozenChild('research:frozen:semantic', 'semantic', semantic, 'a');
    const frozenCertified = frozenChild('research:frozen:certified', 'certified', certified, 'd');
    const lineageProgram = vi.fn(() => ({
      status: 'completed' as const,
      evidenceHandleIds: ['lineage:orders'],
      validatorEvidenceHandleIds: ['lineage-validator:orders'],
      receiptFingerprint: 'sha256:lineage',
    }));
    let providerCalls = 0;
    const provider: AgentProvider = {
      name: 'ollama',
      available: async () => true,
      generate: async () => {
        providerCalls += 1;
        if (providerCalls > 1) throw new Error('a frozen Research child must not dispatch a provider');
        return JSON.stringify({ hypotheses: [
          { kind: 'analytical', question: 'validate revenue', frozenChildId: 'research:frozen:semantic' },
          { kind: 'lineage', question: 'inspect orders lineage' },
          { kind: 'analytical', question: 'validate top customers', frozenChildId: 'research:frozen:certified' },
        ] });
      },
    };
    const answer = await __test__.createAskV2ResearchLaneHandler(state)({
      question: 'Research revenue and customers',
      provider,
      askAgentV2Workspace: askV2Workspace([semantic, certified, relation], {
        frozenResearchChildren: new Map([
          [frozenSemantic.handle.id, frozenSemantic.handle],
          [frozenCertified.handle.id, frozenCertified.handle],
        ]),
        runDedicatedLineageProgram: lineageProgram,
      }),
    } as never);

    // The one root plan is the only provider request. Both analytical
    // children execute their immutable host capabilities, while lineage stays
    // structural and receives no analytical result reuse.
    expect(providerCalls).toBe(1);
    expect(frozenSemantic.execute).toHaveBeenCalledOnce();
    expect(frozenCertified.execute).toHaveBeenCalledOnce();
    expect(lineageProgram).toHaveBeenCalledWith(expect.objectContaining({
      snapshotId: 'snapshot:v2-test',
      targetCandidateIds: ['dbt:model:orders'],
    }));
    expect(state.researchLedgerV4).toMatchObject({ version: 4, limitedScope: false });
    expect(state.researchLedgerV4?.branches).toEqual(expect.arrayContaining([
      expect.objectContaining({ verdict: 'supported', lineageProgram: 'not_run' }),
      expect.objectContaining({ verdict: 'inconclusive', lineageProgram: 'dedicated', evidenceHandleIds: ['lineage:orders'] }),
    ]));
    expect(answer.text).toContain('Findings');
    expect(answer.text).toContain('Counter-evidence');
    expect(answer.text).toContain('Limitations');
  });
});

describe('provider runner — analyst physical dispatch budget', () => {
  it.each([
    ['text', () => {
      let calls = 0;
      return {
        get calls() { return calls; },
        requestTools: (): string[] => [],
        provider: {
          name: 'ollama' as const,
          available: async () => true,
          generate: async () => [
            '```json\\n{"tool":"inspect_business_context","input":{}}\\n```',
            '```json\\n{"tool":"finish_answer","input":{"answer":"Revenue is recognized income after eligible customer orders are fulfilled.","evidenceIds":["context:revenue-definition"]}}\\n```',
          ][calls++] ?? '',
        } satisfies AgentProvider,
        cleanup: (): void => undefined,
      };
    }],
    ['OpenAI', () => {
      let calls = 0;
      const requestTools: string[][] = [];
      vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
        calls += 1;
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          tools?: Array<{ function?: { name?: string } }>;
        };
        requestTools.push((body.tools ?? []).flatMap((tool) => tool.function?.name ? [tool.function.name] : []));
        const tool = calls === 1
          ? { id: 'context_1', type: 'function', function: { name: 'inspect_business_context', arguments: '{}' } }
          : {
              id: 'finish_1',
              type: 'function',
              function: {
                name: 'finish_answer',
                arguments: '{"answer":"Revenue is recognized income after eligible customer orders are fulfilled.","evidenceIds":["context:revenue-definition"]}',
              },
            };
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [tool] } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }));
      return {
        get calls() { return calls; },
        requestTools: (): string[] => requestTools.at(-1) ?? [],
        provider: new OpenAIProvider({ apiKey: 'test', baseUrl: 'https://example.test/v1', model: 'gpt-test' }),
        cleanup: (): void => { vi.unstubAllGlobals(); },
      };
    }],
    ['Claude', () => {
      let calls = 0;
      const requestTools: string[][] = [];
      vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
        calls += 1;
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          tools?: Array<{ name?: string }>;
        };
        requestTools.push((body.tools ?? []).flatMap((tool) => tool.name ? [tool.name] : []));
        const block = calls === 1
          ? { type: 'tool_use', id: 'context_1', name: 'inspect_business_context', input: {} }
          : {
              type: 'tool_use',
              id: 'finish_1',
              name: 'finish_answer',
              input: {
                answer: 'Revenue is recognized income after eligible customer orders are fulfilled.',
                evidenceIds: ['context:revenue-definition'],
              },
            };
        return new Response(JSON.stringify({ content: [block] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }));
      return {
        get calls() { return calls; },
        requestTools: (): string[] => requestTools.at(-1) ?? [],
        provider: new ClaudeProvider({ apiKey: 'test', baseUrl: 'https://example.test/anthropic', model: 'claude-test' }),
        cleanup: (): void => { vi.unstubAllGlobals(); },
      };
    }],
  ])('runs the evidence-bound business-context finish control in two sends (%s)', async (_transport, createTransport) => {
    const transport = createTransport();
    try {
      const state = askV2State([], 'business_context');
      const answer = await __test__.createAskV2LaneHandler(state, {
        maxToolCalls: 4,
        maxProviderDispatches: 2,
      })({
        question: 'What does revenue mean for this project?',
        provider: transport.provider,
        askAgentV2Workspace: askV2Workspace([], {
          businessContext: {
            available: true,
            objectCount: 1,
            cards: [{
              id: 'context:revenue-definition',
              name: 'Revenue definition',
              description: 'Recognized income after eligible customer orders are fulfilled.',
              kind: 'definition',
            }],
          },
        }),
      } as never);

      expect(transport.calls).toBe(2);
      if (_transport !== 'text') {
        expect(transport.requestTools()).toEqual(['finish_answer']);
      }
      expect(state.observations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          tool: 'inspect_business_context',
          outcome: 'eligible',
          candidateIds: ['context:revenue-definition'],
        }),
        expect.objectContaining({
          tool: 'finish_answer',
          outcome: 'eligible',
          reasonCode: 'ASK_V2_CONTEXTUAL_ANSWER',
          candidateIds: ['context:revenue-definition'],
        }),
      ]));
      expect(answer).toMatchObject({
        kind: 'uncertified',
        sourceTier: 'business_context',
        certification: 'governed',
        reviewStatus: 'governed',
        askAgentV2Outcome: {
          kind: 'finish_answer',
          reasonCode: 'ASK_V2_CONTEXTUAL_ANSWER',
        },
      });
      expect(answer.text).toContain('Revenue is recognized income');
    } finally {
      transport.cleanup();
    }
  });

  it.each([
    ['text', () => {
      let send = 0;
      return {
        provider: {
          name: 'ollama' as const,
          available: async () => true,
          generate: async () => [
            '```json\\n{"tool":"inspect_certified_candidates","input":{}}\\n```',
            '```json\\n{"tool":"run_certified","input":{"candidateId":"block:top-customers"}}\\n```',
            '```json\\n{"tool":"finish_answer","input":{"answer":"The certified result is ready."}}\\n```',
          ][send++] ?? '',
        } satisfies AgentProvider,
        cleanup: (): void => undefined,
      };
    }],
    ['OpenAI', () => {
      let send = 0;
      vi.stubGlobal('fetch', vi.fn(async () => {
        send += 1;
        const tool = send === 1
          ? { id: 'inspect_1', type: 'function', function: { name: 'inspect_certified_candidates', arguments: '{}' } }
          : send === 2
            ? { id: 'certified_1', type: 'function', function: { name: 'run_certified', arguments: '{"candidateId":"block:top-customers"}' } }
            : { id: 'finish_1', type: 'function', function: { name: 'finish_answer', arguments: '{"answer":"The certified result is ready."}' } };
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [tool] } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }));
      return {
        provider: new OpenAIProvider({ apiKey: 'test', baseUrl: 'https://example.test/v1', model: 'gpt-test' }),
        cleanup: (): void => { vi.unstubAllGlobals(); },
      };
    }],
    ['Claude', () => {
      let send = 0;
      vi.stubGlobal('fetch', vi.fn(async () => {
        send += 1;
        const block = send === 1
          ? { type: 'tool_use', id: 'inspect_1', name: 'inspect_certified_candidates', input: {} }
          : send === 2
            ? { type: 'tool_use', id: 'certified_1', name: 'run_certified', input: { candidateId: 'block:top-customers' } }
            : { type: 'tool_use', id: 'finish_1', name: 'finish_answer', input: { answer: 'The certified result is ready.' } };
        return new Response(JSON.stringify({ content: [block] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }));
      return {
        provider: new ClaudeProvider({ apiKey: 'test', baseUrl: 'https://example.test/anthropic', model: 'claude-test' }),
        cleanup: (): void => { vi.unstubAllGlobals(); },
      };
    }],
  ])('admits the required post-result finish control as narration after discovery closes (%s)', async (_transport, createTransport) => {
    const root = mkdtempSync(join(tmpdir(), 'dql-v2-narration-phase-'));
    const transport = createTransport();
    try {
      cpSync(providerFixtureRoot, root, { recursive: true });
      const question = 'who are the top customers';
      const candidate: AgentEvidenceCandidate = {
        id: 'block:top-customers',
        qualifiedId: 'block:top-customers',
        kind: 'certified_block',
        trustTier: 'certified',
        name: 'top customers',
        relevanceScore: 1,
        matchReasons: ['exact'],
        compatibility: 'compatible',
      };
      const state = askV2State([candidate]);
      const workspace = askV2Workspace([candidate], {
        contextPack: v2RunnerContextPack(question),
        certifiedArtifacts: new Map([['block:top-customers', {
          version: 1,
          artifact: { kind: 'block', nodeId: 'block:top-customers', name: 'top customers' },
          revisionFingerprint: 'sha256:top-customers',
          isCurrent: () => true,
        }]]),
        certifiedCompleteCandidateIds: ['block:top-customers'],
        certifiedExecutionAvailable: true,
      });
      let discoveryOpen = true;
      const budget = v2NarrationTestBudget({
        discoveryOpen: () => discoveryOpen,
        narrationOpen: () => true,
      });
      const ledger = new RunScopedProviderDispatchEvidence(
        agentRunProviderDispatchBudgetForMode('ask'),
        budget,
      );
      const manifest = buildManifest({ projectRoot: root, dbtManifestPath: join(root, 'target', 'manifest.json') });
      const executeCertifiedBlock = vi.fn(async () => {
        // The final provider send must now be admitted through narration. If
        // it remained a tool follow-up, this closed discovery window would
        // reject it before the raw text/OpenAI/Claude provider is entered.
        discoveryOpen = false;
        return { columns: ['customer'], rows: [{ customer: 'Ada' }], rowCount: 1 };
      });
      const turns: Array<{ kind: string; [key: string]: unknown }> = [];

      await createDqlAgentProviderRunner('ollama', transport.provider).run({
        provider: 'ollama',
        projectRoot: root,
        agentRunId: `v2-narration-phase-${String(_transport).toLowerCase()}`,
        askAgentRuntimeMode: 'authoritative_v2',
        askAgentV2State: state,
        askAgentV2Workspace: workspace,
        providerPreflightRequired: false,
        providerDispatchEvidenceSink: ledger,
        projectSnapshot: { snapshotId: 'snapshot:v2-test', manifest },
        messages: [{ role: 'user', content: question }],
        executeCertifiedBlock,
      }, (turn) => turns.push(turn as typeof turns[number]), new AbortController().signal);

      expect(executeCertifiedBlock).toHaveBeenCalledOnce();
      expect(ledger.snapshot().providerEgressReceipts.map((receipt) => receipt.dispatchPhase)).toEqual([
        'agent_control',
        'tool_followup',
        'narration',
      ]);
      expect(ledger.snapshot().providerEgressReceipts.at(-1)).toMatchObject({
        dispatchPhase: 'narration',
        purpose: 'answer_generation',
      });
      expect(turns).toContainEqual(expect.objectContaining({
        kind: 'tool_result',
        id: 'governed_answer',
        output: expect.objectContaining({ certification: 'certified', result: expect.objectContaining({ rowCount: 1 }) }),
      }));
    } finally {
      transport.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['text', () => {
      let rawCalls = 0;
      return {
        get rawCalls() { return rawCalls; },
        provider: {
          name: 'ollama' as const,
          available: async () => true,
          generate: async () => {
            rawCalls += 1;
            return rawCalls === 1
              ? '```json\\n{"tool":"inspect_certified_candidates","input":{}}\\n```'
              : rawCalls === 2
                ? '```json\\n{"tool":"run_certified","input":{"candidateId":"block:top-customers"}}\\n```'
                : 'The narration deadline must reject before this provider call.';
          },
        } satisfies AgentProvider,
        cleanup: (): void => undefined,
      };
    }],
    ['OpenAI', () => {
      let rawCalls = 0;
      vi.stubGlobal('fetch', vi.fn(async () => {
        rawCalls += 1;
        const tool = rawCalls === 1
          ? { id: 'inspect_1', type: 'function', function: { name: 'inspect_certified_candidates', arguments: '{}' } }
          : { id: 'certified_1', type: 'function', function: { name: 'run_certified', arguments: '{"candidateId":"block:top-customers"}' } };
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [tool] } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }));
      return {
        get rawCalls() { return rawCalls; },
        provider: new OpenAIProvider({ apiKey: 'test', baseUrl: 'https://example.test/v1', model: 'gpt-test' }),
        cleanup: (): void => { vi.unstubAllGlobals(); },
      };
    }],
    ['Claude', () => {
      let rawCalls = 0;
      vi.stubGlobal('fetch', vi.fn(async () => {
        rawCalls += 1;
        const block = rawCalls === 1
          ? { type: 'tool_use', id: 'inspect_1', name: 'inspect_certified_candidates', input: {} }
          : { type: 'tool_use', id: 'certified_1', name: 'run_certified', input: { candidateId: 'block:top-customers' } };
        return new Response(JSON.stringify({ content: [block] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }));
      return {
        get rawCalls() { return rawCalls; },
        provider: new ClaudeProvider({ apiKey: 'test', baseUrl: 'https://example.test/anthropic', model: 'claude-test' }),
        cleanup: (): void => { vi.unstubAllGlobals(); },
      };
    }],
  ])('preserves a validated V2 result when the dedicated narration allowance has elapsed (%s)', async (_transport, createTransport) => {
    const root = mkdtempSync(join(tmpdir(), 'dql-v2-narration-deadline-'));
    const transport = createTransport();
    try {
      cpSync(providerFixtureRoot, root, { recursive: true });
      const question = 'who are the top customers';
      const candidate: AgentEvidenceCandidate = {
        id: 'block:top-customers', qualifiedId: 'block:top-customers', kind: 'certified_block',
        trustTier: 'certified', name: 'top customers', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
      };
      const state = askV2State([candidate]);
      const workspace = askV2Workspace([candidate], {
        contextPack: v2RunnerContextPack(question),
        certifiedArtifacts: new Map([['block:top-customers', {
          version: 1,
          artifact: { kind: 'block', nodeId: 'block:top-customers', name: 'top customers' },
          revisionFingerprint: 'sha256:top-customers',
          isCurrent: () => true,
        }]]),
        certifiedCompleteCandidateIds: ['block:top-customers'],
        certifiedExecutionAvailable: true,
      });
      let narrationOpen = true;
      const ledger = new RunScopedProviderDispatchEvidence(
        agentRunProviderDispatchBudgetForMode('ask'),
        v2NarrationTestBudget({ discoveryOpen: () => true, narrationOpen: () => narrationOpen }),
      );
      const manifest = buildManifest({ projectRoot: root, dbtManifestPath: join(root, 'target', 'manifest.json') });
      const turns: Array<{ kind: string; [key: string]: unknown }> = [];

      await createDqlAgentProviderRunner('ollama', transport.provider).run({
        provider: 'ollama',
        projectRoot: root,
        agentRunId: 'v2-narration-deadline',
        askAgentRuntimeMode: 'authoritative_v2',
        askAgentV2State: state,
        askAgentV2Workspace: workspace,
        providerPreflightRequired: false,
        providerDispatchEvidenceSink: ledger,
        projectSnapshot: { snapshotId: 'snapshot:v2-test', manifest },
        messages: [{ role: 'user', content: question }],
        executeCertifiedBlock: async () => {
          narrationOpen = false;
          return { columns: ['customer'], rows: [{ customer: 'Ada' }], rowCount: 1 };
        },
      }, (turn) => turns.push(turn as typeof turns[number]), new AbortController().signal);

      // The wrapper rejects the third physical send before raw-provider entry;
      // the result stays published with deterministic fact narration.
      expect(transport.rawCalls).toBe(2);
      expect(ledger.snapshot().providerEgressReceipts.map((receipt) => receipt.dispatchPhase)).toEqual([
        'agent_control',
        'tool_followup',
      ]);
      expect(state.observations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          tool: 'finish_answer',
          outcome: 'error',
          reasonCode: 'RUN_SOFT_TARGET_EXCEEDED',
          origin: 'narration',
          provider: expect.objectContaining({ phase: 'narration', cause: 'run_deadline' }),
        }),
      ]));
      expect(turns).toContainEqual(expect.objectContaining({
        kind: 'tool_result',
        id: 'governed_answer',
        output: expect.objectContaining({
          certification: 'certified',
          result: expect.objectContaining({ rowCount: 1 }),
          askAgentV2Outcome: expect.objectContaining({ reasonCode: 'ASK_V2_RESULT_PRESERVED_AFTER_NARRATION_DEADLINE' }),
        }),
      }));
    } finally {
      transport.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('records one physical egress receipt before a callback-silent provider is entered', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-provider-callback-silent-'));
    try {
      cpSync(providerFixtureRoot, root, { recursive: true });
      const configPath = join(root, 'dql.config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      config.agent = { orchestrator: { mode: 'agentic', lanes: ['generated'], maxIterations: 8, turnPlanning: true } };
      writeFileSync(configPath, `${JSON.stringify(config)}\n`);
      const manifest = buildManifest({ projectRoot: root, dbtManifestPath: join(root, 'target', 'manifest.json') });
      const ledger = new RunScopedProviderDispatchEvidence(agentRunProviderDispatchBudgetForMode('ask'));
      let rawCalls = 0;
      const provider: AgentProvider = {
        name: 'ollama',
        available: async () => true,
        // Subscription/custom providers are permitted not to invoke the
        // optional callbacks. The wrapper, not this implementation, owns
        // admission and receipt creation at the raw invocation boundary.
        generate: async () => {
          rawCalls += 1;
          return '```json\n{"summary":"No executable data answer was selected."}\n```';
        },
      };
      await createDqlAgentProviderRunner('ollama', provider).run({
        provider: 'ollama',
        projectRoot: root,
        agentRunId: 'callback-silent-provider',
        projectSnapshot: { snapshotId: 'snapshot:callback-silent', manifest },
        providerPreflightRequired: false,
        providerDispatchEvidenceSink: ledger,
        preparedContextPack: {
          id: 'pack:callback-silent', question: 'show order items', focusObjectKey: null, mode: 'question',
          questionPlan: buildAnalysisQuestionPlan('show order items'), objects: [], skills: [],
          knowledgeLens: { snapshotId: 'snapshot:callback-silent' }, edges: [], queryRuns: [], citations: [],
          evidenceSummaries: [], warnings: [], routeDecision: { route: 'generated_sql' }, evidenceRoles: [],
          allowedSqlContext: { relations: [{ relation: 'order_items', name: 'order_items', columns: [], source: 'test', columnCompleteness: 'complete' }], sourceBlockSql: [] },
          missingContext: [], conflicts: [], appliedHints: [],
          retrievalDiagnostics: { strategy: 'sqlite_fts', lanes: [], selectedObjects: 0, selectedEvidence: [] },
        } as never,
        messages: [{ role: 'user', content: 'show order items' }],
      }, () => undefined, new AbortController().signal);

      expect(rawCalls).toBe(1);
      expect(ledger.snapshot().providerEgressReceipts).toEqual([
        expect.objectContaining({ operation: 'generate', attemptIndex: 1, dispatchPhase: 'generation', purpose: 'answer_generation' }),
      ]);
      expect(ledger.snapshot().providerRoundTrips).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not double-count the first built-in dispatch callback after wrapper admission', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-provider-callback-dedup-'));
    try {
      cpSync(providerFixtureRoot, root, { recursive: true });
      const configPath = join(root, 'dql.config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      config.agent = { orchestrator: { mode: 'agentic', lanes: ['generated'], maxIterations: 8, turnPlanning: true } };
      writeFileSync(configPath, `${JSON.stringify(config)}\n`);
      const manifest = buildManifest({ projectRoot: root, dbtManifestPath: join(root, 'target', 'manifest.json') });
      const ledger = new RunScopedProviderDispatchEvidence(agentRunProviderDispatchBudgetForMode('ask'));
      let rawCalls = 0;
      const provider: AgentProvider = {
        name: 'ollama',
        available: async () => true,
        generate: async (messages, options) => {
          rawCalls += 1;
          // This is the actual pre-wire callback shape emitted by built-in
          // HTTP providers. It shares operation/attempt identity with the
          // wrapper's synthetic admission and must not mint a second receipt.
          options?.onProviderDispatch?.({
            provider: 'ollama', operation: 'generate', attemptIndex: 1, envelope: { messages },
          });
          return '```json\n{"summary":"No executable data answer was selected."}\n```';
        },
      };
      await createDqlAgentProviderRunner('ollama', provider).run({
        provider: 'ollama',
        projectRoot: root,
        agentRunId: 'callback-dedup-provider',
        projectSnapshot: { snapshotId: 'snapshot:callback-dedup', manifest },
        providerPreflightRequired: false,
        providerDispatchEvidenceSink: ledger,
        preparedContextPack: {
          id: 'pack:callback-dedup', question: 'show order items', focusObjectKey: null, mode: 'question',
          questionPlan: buildAnalysisQuestionPlan('show order items'), objects: [], skills: [],
          knowledgeLens: { snapshotId: 'snapshot:callback-dedup' }, edges: [], queryRuns: [], citations: [],
          evidenceSummaries: [], warnings: [], routeDecision: { route: 'generated_sql' }, evidenceRoles: [],
          allowedSqlContext: { relations: [{ relation: 'order_items', name: 'order_items', columns: [], source: 'test', columnCompleteness: 'complete' }], sourceBlockSql: [] },
          missingContext: [], conflicts: [], appliedHints: [],
          retrievalDiagnostics: { strategy: 'sqlite_fts', lanes: [], selectedObjects: 0, selectedEvidence: [] },
        } as never,
        messages: [{ role: 'user', content: 'show order items' }],
      }, () => undefined, new AbortController().signal);

      expect(rawCalls).toBe(1);
      expect(ledger.snapshot().providerEgressReceipts).toHaveLength(1);
      expect(ledger.snapshot().providerEgressReceipts[0]).toMatchObject({
        operation: 'generate', attemptIndex: 1, dispatchPhase: 'generation', purpose: 'answer_generation',
      });
      expect(ledger.snapshot().providerRoundTrips).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('records production exploratory messages and replays them across fresh roots', async () => {
    const rootA = mkdtempSync(join(tmpdir(), 'dql-provider-exploratory-a-'));
    const rootB = mkdtempSync(join(tmpdir(), 'dql-provider-exploratory-b-'));
    const cassetteDir = mkdtempSync(join(tmpdir(), 'dql-provider-exploratory-cassette-'));
    const question = 'what is the order count for each customer?';
    const proposal = '```json\n{"summary":"Order count by customer.","sql":"SELECT customer_name AS customer_name, count_lifetime_orders AS count_lifetime_orders FROM jaffle_shop.dev.dim_customers ORDER BY customer_name","outputs":["customer_name","count_lifetime_orders"]}\n```';
    const copiedFixture = providerFixtureRoot;
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
      cpSync(providerFixtureRoot, projectRoot, { recursive: true });
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
      cpSync(providerFixtureRoot, projectRoot, { recursive: true });
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
      cpSync(providerFixtureRoot, root, { recursive: true });
      const configPath = join(root, 'dql.config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      // A stale/local config may still opt in to turn planning. Ordinary Ask
      // must ignore it: candidate-ID meaning owns the plan and the ordinary
      // dispatch cap must remain available for generation/repair.
      config.agent = { orchestrator: { mode: 'agentic', lanes: ['generated'], maxIterations: 8, turnPlanning: true } };
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
      const toolSpans: Array<{ name: string; outcome?: string; safeErrorCode?: string }> = [];
      const trace = {
        enabled: true,
        recordingStatus: 'recording',
        startSpan: (input: { name: string }) => {
          toolSpans.push({ name: input.name });
          return `span-${toolSpans.length}`;
        },
        finishSpan: (spanId: string | undefined, input?: { outcome?: string; payload?: unknown }) => {
          const index = Number(spanId?.replace('span-', '')) - 1;
          const span = toolSpans[index];
          if (!span || !input) return;
          span.outcome = input.outcome;
          const payload = input.payload as { kind?: string; call?: { safeErrorCode?: string } } | undefined;
          span.safeErrorCode = payload?.kind === 'tool' ? payload.call?.safeErrorCode : undefined;
        },
        recordCandidateDecision: () => {},
        recordLink: () => {},
        finalize: () => undefined,
        markPartial: () => {},
        reference: () => undefined,
      } as unknown as AskTraceObserverV1;
      await createDqlAgentProviderRunner('ollama', provider).run(attachAskTraceObserverV1({
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
      }, trace), (turn) => turns.push(turn as typeof turns[number]), new AbortController().signal);

      expect(calls).toHaveLength(4);
      expect(calls.every((messages) => !messages.some((message) => /You are planning an analytics investigation/i.test(message.content)))).toBe(true);
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
      // This is the real text-protocol path used by an agentic Ask: each
      // `get_table_schema` tool executes before the final SQL proposal, and
      // its redacted physical boundary is now carried through the projected
      // answer-loop input rather than being silently dropped.
      expect(toolSpans.filter((span) => span.name === 'tool.call'))
        .toEqual([
          expect.objectContaining({ outcome: 'ok', safeErrorCode: undefined }),
          expect.objectContaining({ outcome: 'ok', safeErrorCode: undefined }),
          expect.objectContaining({ outcome: 'ok', safeErrorCode: undefined }),
        ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retries one transient same-provider ordinary Ask dispatch and preserves its physical receipt lineage', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-provider-runner-transient-retry-'));
    try {
      cpSync(providerFixtureRoot, root, { recursive: true });
      const configPath = join(root, 'dql.config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      config.agent = { orchestrator: { mode: 'agentic', lanes: ['generated'], maxIterations: 8, turnPlanning: true } };
      writeFileSync(configPath, `${JSON.stringify(config)}\n`);
      const manifest = buildManifest({ projectRoot: root, dbtManifestPath: join(root, 'target', 'manifest.json') });
      const preparedContextPack = {
        id: 'pack-transient-retry',
        question: 'show order items',
        focusObjectKey: null,
        mode: 'question',
        questionPlan: buildAnalysisQuestionPlan('show order items'),
        objects: [],
        skills: [],
        knowledgeLens: { snapshotId: 'snapshot-transient-retry' },
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
      } as never;
      const cases = [
        ['HTTP_429', 'HTTP 429 rate limited', 'rate_limited'],
        ['GATEWAY_503', 'gateway returned 503', 'gateway'],
        ['NETWORK_FAILURE', 'network socket reset', 'network'],
      ] as const;

      for (const [code, message, cause] of cases) {
        const calls: Array<{ messages: AgentMessage[]; options?: ProviderToolLoopOptions }> = [];
        const admittedCalls: Array<{ messages: AgentMessage[]; options?: ProviderToolLoopOptions }> = [];
        const spans: Array<{
          id: string;
          name: string;
          start?: { payload?: unknown };
          finish?: { outcome?: string; payload?: unknown };
        }> = [];
        const trace = {
          enabled: true,
          recordingStatus: 'recording',
          startSpan: (input: { name: string; payload?: unknown }) => {
            const id = `span-${spans.length + 1}`;
            spans.push({ id, name: input.name, start: input });
            return id;
          },
          finishSpan: (spanId: string | undefined, input?: { outcome?: string; payload?: unknown }) => {
            const span = spans.find((candidate) => candidate.id === spanId);
            if (span && input) span.finish = input;
          },
          recordCandidateDecision: () => {},
          recordLink: () => {},
          finalize: () => undefined,
          markPartial: () => {},
          reference: () => undefined,
        } as unknown as AskTraceObserverV1;
        const provider: AgentProvider = {
          name: 'ollama',
          available: async () => true,
          generate: async (messages, options) => {
            calls.push({ messages, options });
            options?.onProviderDispatch?.({
              provider: 'ollama', operation: 'generate', attemptIndex: 1, envelope: { messages },
            });
            // A provider method can be entered again while the analyst has no
            // executable handoff, but a throwing dispatch observer means that
            // no wire body was admitted. Count this only after admission.
            admittedCalls.push({ messages, options });
            if (calls.length === 1) {
              throw Object.assign(new Error(message), { code });
            }
            return '```json\n{"summary":"Recovered final SQL.","sql":"SELECT 1 FROM order_items","outputs":["value"]}\n```';
          },
        };
        const turns: Array<{ kind: string; [key: string]: unknown }> = [];
        const dispatchLedger = new RunScopedProviderDispatchEvidence(
          agentRunProviderDispatchBudgetForMode('ask'),
        );

        await createDqlAgentProviderRunner('ollama', provider).run(attachAskTraceObserverV1({
          provider: 'ollama',
          projectRoot: root,
          agentRunId: `transient-retry-${code.toLowerCase()}`,
          projectSnapshot: { snapshotId: 'snapshot-transient-retry', manifest },
          providerPreflightRequired: false,
          resolvedAnalyticalPlan: { planId: 'plan-transient-retry', snapshotId: 'snapshot-transient-retry' } as never,
          generatedProposalTargetFingerprint: 'target-transient-retry',
          preparedContextPack,
          providerDispatchEvidenceSink: dispatchLedger,
          messages: [{ role: 'user', content: 'show order items' }],
        }, trace), (turn) => turns.push(turn as typeof turns[number]), new AbortController().signal);

        expect(admittedCalls).toHaveLength(2);
        expect(admittedCalls[1]?.options).toMatchObject({
          dispatchPhase: 'generation',
          egressPurpose: 'answer_generation',
          retryOfAttemptIndex: 1,
        });
        const attempts = spans.filter((span) => span.name === 'provider.attempt');
        const payload = (span: typeof attempts[number]) => (
          ((span.finish?.payload ?? span.start?.payload) as { attempt?: Record<string, unknown> } | undefined)?.attempt
        );
        const admittedAttempts = attempts.filter((span) => payload(span)?.admission === 'admitted');
        expect(admittedAttempts).toHaveLength(2);
        expect(payload(admittedAttempts[0]!)).toMatchObject({
          phase: 'generation',
          purpose: 'answer_generation',
          physicalAttemptIndex: 1,
          cause,
          retryable: true,
        });
        expect(payload(admittedAttempts[1]!)).toMatchObject({
          phase: 'generation',
          purpose: 'answer_generation',
          physicalAttemptIndex: 2,
          retryOfSpanId: admittedAttempts[0]!.id,
        });
        expect(admittedAttempts[1]!.finish).toMatchObject({ outcome: 'ok' });
        expect(dispatchLedger.snapshot().providerEgressReceipts).toEqual([
          expect.objectContaining({ provider: 'ollama', dispatchPhase: 'generation', purpose: 'answer_generation', attemptIndex: 1 }),
          expect.objectContaining({ provider: 'ollama', dispatchPhase: 'generation', purpose: 'answer_generation', attemptIndex: 1, retryOfAttemptIndex: 1 }),
        ]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('denies a second same-provider transient retry without attempting a third dispatch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-provider-runner-second-retry-'));
    try {
      cpSync(providerFixtureRoot, root, { recursive: true });
      const configPath = join(root, 'dql.config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      config.agent = { orchestrator: { mode: 'agentic', lanes: ['generated'], maxIterations: 8, turnPlanning: true } };
      writeFileSync(configPath, `${JSON.stringify(config)}\n`);
      const manifest = buildManifest({ projectRoot: root, dbtManifestPath: join(root, 'target', 'manifest.json') });
      const calls: Array<{ options?: ProviderToolLoopOptions }> = [];
      const spans: Array<{
        id: string;
        name: string;
        start?: { payload?: unknown };
        finish?: { outcome?: string; payload?: unknown };
      }> = [];
      const trace = {
        enabled: true,
        recordingStatus: 'recording',
        startSpan: (input: { name: string; payload?: unknown }) => {
          const id = `span-${spans.length + 1}`;
          spans.push({ id, name: input.name, start: input });
          return id;
        },
        finishSpan: (spanId: string | undefined, input?: { outcome?: string; payload?: unknown }) => {
          const span = spans.find((candidate) => candidate.id === spanId);
          if (span && input) span.finish = input;
        },
        recordCandidateDecision: () => {},
        recordLink: () => {},
        finalize: () => undefined,
        markPartial: () => {},
        reference: () => undefined,
      } as unknown as AskTraceObserverV1;
      const provider: AgentProvider = {
        name: 'ollama',
        available: async () => true,
        generate: async (_messages, options) => {
          calls.push({ options });
          options?.onProviderDispatch?.({
            provider: 'ollama', operation: 'generate', attemptIndex: 1, envelope: { messages: [] },
          });
          throw Object.assign(new Error('gateway returned 503'), { code: 'GATEWAY_503' });
        },
      };
      const turns: Array<{ kind: string; [key: string]: unknown }> = [];
      const dispatchLedger = new RunScopedProviderDispatchEvidence(
        agentRunProviderDispatchBudgetForMode('ask'),
      );
      await createDqlAgentProviderRunner('ollama', provider).run(attachAskTraceObserverV1({
        provider: 'ollama',
        projectRoot: root,
        agentRunId: 'second-transient-retry',
        projectSnapshot: { snapshotId: 'snapshot-second-retry', manifest },
        providerPreflightRequired: false,
        resolvedAnalyticalPlan: { planId: 'plan-second-retry', snapshotId: 'snapshot-second-retry' } as never,
        generatedProposalTargetFingerprint: 'target-second-retry',
        providerDispatchEvidenceSink: dispatchLedger,
        preparedContextPack: {
          id: 'pack-second-retry', question: 'show order items', focusObjectKey: null, mode: 'question',
          questionPlan: buildAnalysisQuestionPlan('show order items'), objects: [], skills: [],
          knowledgeLens: { snapshotId: 'snapshot-second-retry' }, edges: [], queryRuns: [], citations: [],
          evidenceSummaries: [], warnings: [], routeDecision: { route: 'generated_sql' }, evidenceRoles: [],
          allowedSqlContext: { relations: [{ relation: 'order_items', name: 'order_items', columns: [], source: 'test', columnCompleteness: 'complete' }], sourceBlockSql: [] },
          missingContext: [], conflicts: [], appliedHints: [],
          retrievalDiagnostics: { strategy: 'sqlite_fts', lanes: [], selectedObjects: 0, selectedEvidence: [] },
        } as never,
        messages: [{ role: 'user', content: 'show order items' }],
      }, trace), (turn) => turns.push(turn as typeof turns[number]), new AbortController().signal);

      expect(calls).toHaveLength(2);
      expect(calls[1]?.options).toMatchObject({ retryOfAttemptIndex: 1 });
      expect(spans.filter((span) => span.name === 'provider.attempt')).toHaveLength(2);
      expect(dispatchLedger.snapshot().providerEgressReceipts).toEqual([
        expect.objectContaining({ attemptIndex: 1, dispatchPhase: 'generation', purpose: 'answer_generation' }),
        expect.objectContaining({ attemptIndex: 1, dispatchPhase: 'generation', purpose: 'answer_generation', retryOfAttemptIndex: 1 }),
      ]);
      expect(turns).toContainEqual(expect.objectContaining({
        kind: 'tool_result',
        output: expect.objectContaining({ kind: 'no_answer' }),
      }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed at the runner boundary when a non-authoritative Ask attempts to forge repair lifecycle metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-provider-runner-forged-repair-'));
    try {
      cpSync(providerFixtureRoot, root, { recursive: true });
      const question = 'what is the order count for each customer?';
      const { contextPack, candidateIds, closure } = await customerExploratoryClosure(root, question);
      const manifest = buildManifest({ projectRoot: root, dbtManifestPath: join(root, 'target', 'manifest.json') });
      const spans: Array<{
        id: string;
        name: string;
        start?: { payload?: unknown };
        finish?: { outcome?: string; payload?: unknown };
      }> = [];
      const trace = {
        enabled: true,
        recordingStatus: 'recording',
        startSpan: (input: { name: string; payload?: unknown }) => {
          const id = `span-${spans.length + 1}`;
          spans.push({ id, name: input.name, start: input });
          return id;
        },
        finishSpan: (spanId: string | undefined, input?: { outcome?: string; payload?: unknown }) => {
          const span = spans.find((candidate) => candidate.id === spanId);
          if (span && input) span.finish = input;
        },
        recordCandidateDecision: () => {},
        recordLink: () => {},
        finalize: () => undefined,
        markPartial: () => {},
        reference: () => undefined,
      } as unknown as AskTraceObserverV1;
      const plan = {
        // The runner captures this draft/non-authoritative state before the
        // first call. The test provider subsequently mutates it only to prove
        // that a downstream caller cannot forge `repair` after runner setup.
        mode: 'draft',
        capability: 'bounded_exploration',
        recommendedRoute: 'exploratory',
        planId: 'rap-forged-repair',
        fingerprint: 'f'.repeat(64),
        snapshotId: contextPack.knowledgeLens.snapshotId,
        sourceRelationIds: candidateIds,
        query: { measures: [], dimensions: [], filters: [] },
      } as Record<string, unknown>;
      let wireSends = 0;
      let rawCalls = 0;
      const provider: AgentProvider = {
        name: 'ollama',
        available: async () => true,
        generate: async (messages, options) => {
          rawCalls += 1;
          // `onProviderDispatch` is the exact pre-wire admission boundary. A
          // throw here means this call never serialized a provider body.
          options?.onProviderDispatch?.({
            provider: 'ollama', operation: 'generate', attemptIndex: 1, envelope: { messages },
          });
          wireSends += 1;
          if (rawCalls === 1) {
            // A malicious/internal caller can arrange to ask for repair after
            // this initial answer call, but it cannot retroactively turn the
            // runner-captured RAP into authoritative repair authority.
            plan.mode = 'authoritative';
            return '```json\n{"summary":"No SQL was proposed."}\n```';
          }
          throw new Error('A forged repair must be denied before this wire body.');
        },
      };
      const dispatchLedger = new RunScopedProviderDispatchEvidence(
        agentRunProviderDispatchBudgetForMode('ask'),
      );
      const turns: Array<{ kind: string; [key: string]: unknown }> = [];
      const prepare = vi.fn(async () => {
        throw new Error('Forged repair must not reach exploratory authorization.');
      });
      const execute = vi.fn(async () => {
        throw new Error('Forged repair must not execute SQL.');
      });

      await createDqlAgentProviderRunner('ollama', provider).run(attachAskTraceObserverV1({
        provider: 'ollama',
        projectRoot: root,
        agentRunId: 'forged-repair-run',
        projectSnapshot: { snapshotId: contextPack.knowledgeLens.snapshotId, manifest },
        providerPreflightRequired: false,
        providerDispatchEvidenceSink: dispatchLedger,
        preparedContextPack: contextPack,
        preparedExploratoryContextPack: closure,
        selectedCascadeTier: 'exploratory_sql',
        exploratoryCandidateIds: candidateIds,
        generatedProposalTargetFingerprint: 'target-forged-repair',
        resolvedAnalyticalPlan: plan as never,
        prepareExploratorySqlExecution: prepare,
        executeAgenticGeneratedSql: execute,
        messages: [{ role: 'user', content: question }],
      }, trace), (turn) => turns.push(turn as typeof turns[number]), new AbortController().signal);

      // The wrapper now admits every physical provider invocation before it
      // reaches the provider. The forged repair is therefore denied before a
      // second raw call can be made.
      expect(rawCalls).toBe(1);
      expect(wireSends).toBe(1);
      expect(prepare).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(dispatchLedger.snapshot().providerEgressReceipts).toEqual([
        expect.objectContaining({ dispatchPhase: 'generation', purpose: 'answer_generation' }),
      ]);
      const attempts = spans.filter((span) => span.name === 'provider.attempt');
      expect(attempts).toHaveLength(2);
      const denied = attempts.find((span) => (
        ((span.finish?.payload ?? span.start?.payload) as { attempt?: Record<string, unknown> } | undefined)
          ?.attempt?.admission === 'denied'
      ));
      expect(denied).toMatchObject({
        finish: expect.objectContaining({ outcome: 'denied' }),
      });
      expect(((denied?.finish?.payload ?? denied?.start?.payload) as { attempt?: Record<string, unknown> })?.attempt)
        .toMatchObject({
          phase: 'repair',
          purpose: 'repair_sql',
          admission: 'denied',
          cause: 'admission_denied',
          safeAction: 'inspect_run',
        });
      expect(turns).toContainEqual(expect.objectContaining({
        kind: 'tool_result',
        output: expect.objectContaining({ kind: 'no_answer' }),
      }));
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

  it('keeps physical preflight for a provider-dependent request when the deterministic certified exemption is absent', async () => {
    const spans: Array<{
      id: string;
      name: string;
      finish?: { outcome?: string; reasonCode?: string; payload?: unknown };
    }> = [];
    const trace = {
      enabled: true,
      recordingStatus: 'recording',
      startSpan: (input: { name: string }) => {
        const id = `span-${spans.length + 1}`;
        spans.push({ id, name: input.name });
        return id;
      },
      finishSpan: (spanId: string | undefined, input?: { outcome?: string; reasonCode?: string; payload?: unknown }) => {
        const span = spans.find((candidate) => candidate.id === spanId);
        if (span) span.finish = input;
      },
      recordCandidateDecision: () => {},
      recordLink: () => {},
      finalize: () => undefined,
      markPartial: () => {},
      reference: () => undefined,
    } as unknown as AskTraceObserverV1;
    const unavailable = {
      name: 'ollama' as const,
      available: vi.fn(async () => false),
      generate: vi.fn(async () => 'must not dispatch'),
    } satisfies AgentProvider;
    const turns: Array<{ kind: string; message?: string }> = [];

    const providerDependentRequest = req([{ role: 'user', content: 'show revenue' }]);
    expect(providerDependentRequest.providerPreflightRequired).toBeUndefined();
    await createDqlAgentProviderRunner('ollama', unavailable).run(
      attachAskTraceObserverV1(providerDependentRequest, trace),
      (turn) => turns.push(turn as typeof turns[number]),
      new AbortController().signal,
    );

    expect(unavailable.available).toHaveBeenCalledTimes(1);
    expect(unavailable.generate).not.toHaveBeenCalled();
    expect(spans).toEqual([expect.objectContaining({
      name: 'provider.preflight',
      finish: expect.objectContaining({
        outcome: 'unavailable',
        reasonCode: 'provider_preflight',
        payload: expect.objectContaining({
          kind: 'provider',
          // A bare `available() === false` is a readiness/configuration fact,
          // not proof of a physical network failure. Preserve the unknown
          // cause so operators do not chase an invented transport error.
          attempt: expect.objectContaining({ readiness: 'unavailable', cause: 'unknown', safeAction: 'fix_provider_configuration' }),
        }),
      }),
    })]);
    expect(turns).toContainEqual(expect.objectContaining({ kind: 'error' }));
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
      'show total orders here',
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
      'add region here',
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

  it('does not treat overlapping prior-result words as a binding', () => {
    const priorTerms = ['customer', 'beverage', 'revenue'];
    // A fresh analytical question may share customer/revenue vocabulary with
    // a prior answer without inheriting its rows, measures, or filters.
    expect(__test__.isDrilldownFollowUp('who are the customers by region', priorTerms)).toBe(false);
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

  it('binds plural "those customers" to the latest result-bearing turn, not a later chat recap', () => {
    const question = 'which of those customers has the highest order count?';
    const customers = ['Brittany Barrera', 'Jose Fox', 'Jeffrey Love'];
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: question }],
      conversationContext: {
        conversationStateVersion: 1,
        // A persisted chat-only recap may be the latest presentation turn, but
        // it is never a result-set anchor for a deictic analytical follow-up.
        activeTurnId: 'turn-recap',
        turns: [{
          id: 'turn-customers',
          question: 'who are the top customers?',
          route: 'certified_answer',
          trustLabel: 'certified',
          result: {
            columns: ['customer_name', 'count_lifetime_orders'],
            dimensionValues: { customer_name: customers },
            memberSets: [{
              version: 1,
              entity: 'customer',
              displayColumn: 'customer_name',
              displayValues: customers,
              resultFingerprint: 'a'.repeat(64),
            }],
            measureColumns: ['count_lifetime_orders'],
          },
        }, {
          id: 'turn-recap',
          question: 'what are we reviewing in this chat?',
          route: 'conversation',
          trustLabel: 'not_applicable',
          result: {},
        }],
      },
    } as AgentRunRequest, question);

    expect(followUp).toMatchObject({
      kind: 'drilldown',
      binding: 'prior_result',
      sourceTurnId: 'turn-customers',
      memberBindings: [{
        dimension: 'customer',
        values: customers,
        source: 'prior_result',
        confidence: 'deictic',
        sourceTurnId: 'turn-customers',
      }],
    });
    expect(followUp?.memberBindings?.[0]?.values).not.toEqual([customers[0]]);
  });

  it('returns a typed continuity gap when a plural prior-result member set was not retained', () => {
    const question = 'which of those customers has the highest order count?';
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: question }],
      conversationContext: {
        conversationStateVersion: 1,
        activeTurnId: 'turn-redacted',
        turns: [{
          id: 'turn-redacted',
          question: 'who are the top customers?',
          route: 'certified_answer',
          trustLabel: 'certified',
          result: { columns: ['customer_name', 'count_lifetime_orders'] },
        }],
      },
    } as AgentRunRequest, question);

    expect(followUp).toMatchObject({
      binding: 'prior_result',
      priorResultSetUnavailable: true,
      unresolvedReferences: [expect.stringContaining('did not retain')],
    });
    expect(followUp?.memberBindings).toBeUndefined();
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

    expect(followUp).toBeUndefined();
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

    expect(followUp).toBeUndefined();
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

  // The reported regression, in its exact shape: ten customers on screen, and
  // the display column is a bare `name` — not `customer_name`. Alias lookup
  // found nothing under `customer`, so the pronoun resolved to no dimension,
  // no candidates, and therefore NO clarification either. The turn died as
  // "Not enough context to answer safely" with the answer one tap away.
  it('offers the displayed people as choices when the prior column is a bare name', () => {
    const customers = [
      'Mr. Matthew Meyer', 'Aaron Gardner', 'Angela Moyer', 'Ryan Byrd', 'Ronnie Knight',
      'Brittany Barrera', 'Jose Fox', 'Rodney Gonzalez', 'Jeffrey Love', 'Lori Butler',
    ];
    const question = 'what region he belongs to';
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: question }],
      conversationContext: {
        conversationStateVersion: 1,
        activeTurnId: 'turn_top_customers',
        turns: [{
          id: 'turn_top_customers',
          question: 'who are the top customers',
          result: {
            columns: ['name', 'customer_type', 'count_lifetime_orders', 'lifetime_spend'],
            dimensionValues: { name: customers, customer_type: ['returning'] },
            measureColumns: ['count_lifetime_orders', 'lifetime_spend'],
          },
        }],
      },
    } as AgentRunRequest, question);

    // Ambiguous over ten people: ask, never guess.
    expect(followUp?.filters).toBeUndefined();
    expect(followUp?.memberBindings ?? []).toEqual([]);
    expect(followUp?.deicticChoices).toMatchObject({ dimension: 'name', values: customers });
  });

  // A pronoun must never widen into the whole prior population. Before the
  // fix, a `name`-only result sent "he" down the generic single-dimension
  // fallback, which bound all ten people as a filter with no clarification and
  // no sign anything had been assumed.
  it('never binds every displayed person for a singular pronoun', () => {
    const customers = ['Mr. Matthew Meyer', 'Aaron Gardner', 'Angela Moyer'];
    const question = 'which region he belongs to';
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: question }],
      conversationContext: {
        sourceQuestion: 'who are the top customers',
        resultColumns: ['name', 'lifetime_spend'],
        resultDimensionValues: { name: customers },
      },
    } as AgentRunRequest, question);

    expect(followUp?.filters).toBeUndefined();
    expect(followUp?.memberBindings ?? []).toEqual([]);
    expect(followUp?.deicticChoices?.values).toEqual(customers);
  });

  // The persisted member set already records the business entity for a result
  // whose display column is `name`. Keying prior values only by display column
  // discarded it, so the resolver could not find the customer values it had.
  it('resolves prior member sets by their business entity, not just the display column', () => {
    const customers = ['Mr. Matthew Meyer', 'Aaron Gardner'];
    const question = 'what region he belongs to';
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: question }],
      conversationContext: {
        conversationStateVersion: 1,
        activeTurnId: 'turn_members',
        turns: [{
          id: 'turn_members',
          question: 'who are the top customers',
          result: {
            columns: ['name', 'lifetime_spend'],
            memberSets: [{
              version: 1,
              entity: 'customer',
              displayColumn: 'name',
              displayValues: customers,
            }],
          },
        }],
      },
    } as AgentRunRequest, question);

    // Two candidates under the customer entity: still a question, not a guess.
    expect(followUp?.deicticChoices).toMatchObject({ dimension: 'customer', values: customers });
    expect(followUp?.filters).toBeUndefined();
  });

  // Turn 4 of the reported journey. Naming the member outright is the one case
  // with no ambiguity left to resolve.
  it('binds the named member exactly when the question quotes one of ten displayed people', () => {
    const customers = [
      'Mr. Matthew Meyer', 'Aaron Gardner', 'Angela Moyer', 'Ryan Byrd', 'Ronnie Knight',
      'Brittany Barrera', 'Jose Fox', 'Rodney Gonzalez', 'Jeffrey Love', 'Lori Butler',
    ];
    const question = 'which region "Mr. Matthew Meyer" belongs to';
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: question }],
      conversationContext: {
        conversationStateVersion: 1,
        activeTurnId: 'turn_named',
        turns: [{
          id: 'turn_named',
          question: 'who are the top customers',
          result: {
            columns: ['customer_name', 'lifetime_spend'],
            dimensionValues: { customer_name: customers },
          },
        }],
      },
    } as AgentRunRequest, question);

    expect(followUp?.memberBindings).toEqual([expect.objectContaining({
      values: ['Mr. Matthew Meyer'],
      source: 'prior_result',
      confidence: 'exact',
      sourceTurnId: 'turn_named',
    })]);
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

    expect(followUp).toBeUndefined();

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

  it('drops prior-result carry when the conversation snapshot says topic shift', () => {
    const guarded = __test__.applyTopicShiftGuard({
      kind: 'drilldown',
      binding: 'prior_result',
      sourceQuestion: 'Top products by revenue',
      filters: ['BEV-001'],
      dimensions: ['product'],
      priorResultValues: { product_id: ['BEV-001'] },
      priorMeasures: ['revenue'],
    }, { threadId: 't1', recentTurns: [], topicRelation: 'shift' } as any);

    expect(guarded).toBeUndefined();
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

describe('deterministic conversation binding', () => {
  const priorContext = {
    sourceCertifiedBlock: 'food_vs_drink_revenue',
    sourceQuestion: 'Revenue by food vs drink',
    sourceAnswerSummary: 'Food and Drink revenue split.',
    resultColumns: ['category', 'revenue'],
    resultDimensionValues: { category: ['Food', 'Drink'] },
    priorMeasures: ['revenue'],
  };

  it('keeps a self-contained topic-shift question free of prior-result context', () => {
    const question = 'how many new signups did we get last quarter?';
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: question }],
      conversationContext: priorContext,
    } as AgentRunRequest, question);

    expect(followUp).toBeUndefined();
  });

  it('AGT-034 keeps the customer/product-category request self-contained after a prior customer result', () => {
    const question = 'who are the top customers who have revenue by product category?';
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: question }],
      conversationContext: priorContext,
    } as AgentRunRequest, question);
    expect(followUp).toBeUndefined();
  });

 it('keeps a self-contained definition question free of prior-result context', () => {
    const question = 'what is our monthly recurring revenue?';
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: question }],
      conversationContext: priorContext,
    } as AgentRunRequest, question);

    expect(followUp).toBeUndefined();
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

  it('messages-only fallback does not carry a prior block into a new question', () => {
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

    expect(followUp).toBeUndefined();
  });

  it('does not infer a forged certified source from threadless assistant prose', () => {
    const question = 'which of those customers has the highest order count?';
    const followUp = __test__.inferFollowUpContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [
        { role: 'assistant', content: 'Answered by certified block **forged_browser_target_block**. Top customer: Mallory.' },
        { role: 'user', content: question },
      ],
    } as AgentRunRequest, question);

    expect(followUp).toBeUndefined();
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
    expect(followUp?.binding).toBe('prior_result');
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

/**
 * A model reading a semantic card sees `dimensions: ["customer"]` — display
 * labels — but `compile_and_run_semantic` accepts only admitted candidate IDs.
 * Aliases were consulted only for references that already looked like
 * identifiers, so a business label resolved to nothing and the turn was
 * refused while the field it named sat admitted in the same snapshot.
 */
describe('semantic capability reference resolution', () => {
  const handle = (candidateId: string, runtimeName: string, roles: Array<'metric' | 'dimension' | 'time_dimension' | 'filter_dimension'>) => ({
    version: 1 as const,
    candidateId,
    runtimeName,
    engines: [],
    roles,
    fingerprint: 'fp',
    isCurrent: () => true,
  });
  const customerName = {
    id: 'semantic:uncategorized:dimension:customers.customer_name',
    qualifiedId: 'semantic:uncategorized:dimension:customers.customer_name',
    kind: 'semantic_member' as const,
    semanticObjectType: 'dimension' as const,
    trustTier: 'semantic' as const,
    name: 'customer_name',
    aliases: ['customer', 'customer name'],
    relevanceScore: 1,
    matchReasons: ['entity label'],
    compatibility: 'compatible' as const,
  };
  // The gate re-derives this from the candidate, so the fixture must too.
  const fingerprintFor = (candidate: Parameters<typeof askV2SemanticCandidateAuthorityFingerprint>[0]): string =>
    askV2SemanticCandidateAuthorityFingerprint(candidate);
  const capabilities = new Map([
    [customerName.id, { ...handle(customerName.id, 'customer_name', ['dimension', 'filter_dimension']), fingerprint: fingerprintFor(customerName) }],
  ]);

  it('resolves a business label to the one admitted dimension that declares it', () => {
    expect(__test__.resolveV2SemanticCapabilityReference({
      reference: 'customer',
      role: 'dimension',
      candidates: [customerName],
      capabilities,
    })).toBe(customerName.id);
  });

  it('still resolves the exact identifier and the runtime name', () => {
    for (const reference of [customerName.id, 'customer_name']) {
      expect(__test__.resolveV2SemanticCapabilityReference({
        reference, role: 'dimension', candidates: [customerName], capabilities,
      }), reference).toBe(customerName.id);
    }
  });

  // Widening what can be SAID must never widen what can be RUN.
  it('leaves an ambiguous label unresolved rather than choosing one', () => {
    const other = {
      ...customerName,
      id: 'semantic:uncategorized:dimension:orders.customer_label',
      qualifiedId: 'semantic:uncategorized:dimension:orders.customer_label',
      name: 'customer_label',
    };
    const both = new Map([
      [customerName.id, { ...handle(customerName.id, 'customer_name', ['dimension']), fingerprint: fingerprintFor(customerName) }],
      [other.id, { ...handle(other.id, 'customer_label', ['dimension']), fingerprint: fingerprintFor(other) }],
    ]);
    expect(__test__.resolveV2SemanticCapabilityReference({
      reference: 'customer', role: 'dimension', candidates: [customerName, other], capabilities: both,
    })).toBeUndefined();
  });

  it('never resolves a label to a candidate admitted for a different role', () => {
    expect(__test__.resolveV2SemanticCapabilityReference({
      reference: 'customer', role: 'metric', candidates: [customerName], capabilities,
    })).toBeUndefined();
  });

  // MetricFlow declares a join by naming the same entity `primary` on the
  // model that owns it and `foreign` on the model pointing at it. Both are
  // admitted and both answer to the label, so an idiomatic semantic layer made
  // every breakdown by that entity unanswerable.
  it('prefers the model that owns an entity over one that only references it', () => {
    const owning = {
      ...customerName,
      id: 'semantic:uncategorized:entity:customers.customer',
      qualifiedId: 'semantic:uncategorized:entity:customers.customer',
      semanticObjectType: 'entity' as const,
      name: 'customer',
      aliases: [],
      primaryEntity: 'customer',
    };
    const referencing = {
      ...owning,
      id: 'semantic:uncategorized:entity:orders.customer',
      qualifiedId: 'semantic:uncategorized:entity:orders.customer',
      primaryEntity: 'order',
    };
    const both = new Map([
      [owning.id, { ...handle(owning.id, 'customer', ['dimension']), fingerprint: fingerprintFor(owning) }],
      [referencing.id, { ...handle(referencing.id, 'customer', ['dimension']), fingerprint: fingerprintFor(referencing) }],
    ]);
    expect(__test__.resolveV2SemanticCapabilityReference({
      reference: 'customer', role: 'dimension', candidates: [referencing, owning], capabilities: both,
    })).toBe(owning.id);
  });

  it('stays ambiguous when two models both merely reference the entity', () => {
    const a = {
      ...customerName,
      id: 'semantic:uncategorized:entity:orders.customer',
      qualifiedId: 'semantic:uncategorized:entity:orders.customer',
      semanticObjectType: 'entity' as const,
      name: 'customer',
      aliases: [],
      primaryEntity: 'order',
    };
    const b = { ...a, id: 'semantic:uncategorized:entity:items.customer', qualifiedId: 'semantic:uncategorized:entity:items.customer', primaryEntity: 'item' };
    const both = new Map([
      [a.id, { ...handle(a.id, 'customer', ['dimension']), fingerprint: fingerprintFor(a) }],
      [b.id, { ...handle(b.id, 'customer', ['dimension']), fingerprint: fingerprintFor(b) }],
    ]);
    expect(__test__.resolveV2SemanticCapabilityReference({
      reference: 'customer', role: 'dimension', candidates: [a, b], capabilities: both,
    })).toBeUndefined();
  });

  it('never resolves a label no admitted candidate claims', () => {
    expect(__test__.resolveV2SemanticCapabilityReference({
      reference: 'region', role: 'dimension', candidates: [customerName], capabilities,
    })).toBeUndefined();
  });
});

/**
 * The reported T1 question, end to end through the V2 tool lane: a bounded
 * time window must reach the compiled query as HOST-computed date bounds, the
 * ranking must carry an ORDER BY, and a windowed question with no bound time
 * axis must be refused with the axes that would work — never compiled as an
 * unfiltered all-time query.
 */
describe('V2 semantic time-window enforcement', () => {
  const windowMetric: AgentEvidenceCandidate = {
    id: 'semantic:metric:order_item.revenue', qualifiedId: 'semantic:metric:order_item.revenue', kind: 'semantic_metric',
    semanticObjectType: 'metric', trustTier: 'semantic', name: 'revenue',
    relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
  };
  const customerName: AgentEvidenceCandidate = {
    id: 'semantic:uncategorized:dimension:customers.customer_name', qualifiedId: 'semantic:uncategorized:dimension:customers.customer_name',
    kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic', name: 'customer_name',
    relevanceScore: 0.9, matchReasons: ['entity label'], compatibility: 'compatible',
  };
  const orderedAt: AgentEvidenceCandidate = {
    id: 'semantic:uncategorized:dimension:order_items.ordered_at', qualifiedId: 'semantic:uncategorized:dimension:order_items.ordered_at',
    kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic', name: 'ordered_at',
    timeGrains: ['day', 'week', 'month', 'quarter', 'year'],
    relevanceScore: 0.8, matchReasons: ['time axis'], compatibility: 'compatible',
  };
  const question = 'Can you give me the last two month with high revenue by customer name';

  it('injects host-computed window bounds and honors orderBy', async () => {
    const compile = vi.fn(async (selection: { filters?: Array<{ values?: unknown[] }> }) => ({ sql: `select 1 as revenue /* ${(selection.filters ?? []).flatMap((f) => f.values ?? []).join(' ')} */`, engine: 'native' as const }));
    const execute = vi.fn(async () => ({ columns: ['customer_name', 'revenue'], rows: [{ customer_name: 'Ada', revenue: 1 }], rowCount: 1 }));
    const state = askV2State([windowMetric, customerName, orderedAt]);

    await __test__.createAskV2LaneHandler(state, { maxToolCalls: 8, maxProviderDispatches: 6 })({
      question,
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        '```json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["semantic:metric:order_item.revenue"],"dimensionIds":["semantic:uncategorized:dimension:customers.customer_name"],"timeDimensionId":"semantic:uncategorized:dimension:order_items.ordered_at","timeGrain":"month","orderBy":[{"name":"revenue","direction":"desc"}],"limit":10}}\n```',
        '```json\n{"tool":"finish_answer","input":{"answer":"Done."}}\n```',
      ]),
      askAgentV2Workspace: askV2Workspace([windowMetric, customerName, orderedAt]),
      semanticQueryCompiler: compile,
      executeGeneratedSql: execute,
    } as never);

    expect(compile).toHaveBeenCalledOnce();
    const selection = (compile.mock.calls[0] as unknown[])[0] as {
      filters?: Array<{ dimension: string; operator: string; values: string[] }>;
      orderBy?: Array<{ name: string; direction: string }>;
      limit?: number;
    };
    // The window arrived as two host-owned range filters on the bound axis.
    const rangeFilters = (selection.filters ?? []).filter((f) => f.dimension === 'ordered_at');
    expect(rangeFilters.map((f) => f.operator).sort()).toEqual(['gte', 'lt']);
    for (const filter of rangeFilters) {
      expect(filter.values[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // The ranking is ordered — no more unordered LIMIT row lottery.
    expect(selection.orderBy).toEqual([{ name: 'revenue', direction: 'desc' }]);
    expect(selection.limit).toBe(10);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('completes the window through the sole available axis when the model omits time args', async () => {
    // Superseded refusal: with exactly one available axis the HOST completes
    // the binding rather than refusing — the model omitted time args on a
    // window-only question, which is exactly what the prompt asks of it.
    const compile = vi.fn(async (selection: { filters?: Array<{ values?: unknown[] }> }) => ({ sql: `select 1 as revenue /* ${(selection.filters ?? []).flatMap((f) => f.values ?? []).join(' ')} */`, engine: 'native' as const }));
    const execute = vi.fn(async () => ({ columns: ['revenue'], rows: [{ revenue: 1 }], rowCount: 1 }));
    const state = askV2State([windowMetric, customerName, orderedAt]);

    await __test__.createAskV2LaneHandler(state, { maxToolCalls: 8, maxProviderDispatches: 6 })({
      question,
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        '```json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["semantic:metric:order_item.revenue"],"dimensionIds":["semantic:uncategorized:dimension:customers.customer_name"]}}\n```',
        '```json\n{"tool":"finish_answer","input":{"answer":"Done."}}\n```',
      ]),
      askAgentV2Workspace: askV2Workspace([windowMetric, customerName, orderedAt]),
      semanticQueryCompiler: compile,
      executeGeneratedSql: execute,
    } as never);

    expect(compile).toHaveBeenCalledOnce();
    const selection = (compile.mock.calls[0] as unknown[])[0] as {
      filters?: Array<{ dimension: string; operator: string }>;
    };
    expect((selection.filters ?? []).filter((f) => f.dimension === 'ordered_at').map((f) => f.operator).sort())
      .toEqual(['gte', 'lt']);
  });

  it('refuses a windowed compile when NO time axis exists anywhere', async () => {
    const compile = vi.fn(async (selection: { filters?: Array<{ values?: unknown[] }> }) => ({ sql: `select 1 as revenue /* ${(selection.filters ?? []).flatMap((f) => f.values ?? []).join(' ')} */`, engine: 'native' as const }));
    const state = askV2State([windowMetric, customerName]);

    await __test__.createAskV2LaneHandler(state, { maxToolCalls: 8, maxProviderDispatches: 4 })({
      question,
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        '```json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["semantic:metric:order_item.revenue"],"dimensionIds":["semantic:uncategorized:dimension:customers.customer_name"]}}\n```',
        'no more calls',
      ]),
      askAgentV2Workspace: askV2Workspace([windowMetric, customerName]),
      semanticQueryCompiler: compile,
      executeGeneratedSql: vi.fn(async () => ({ columns: [], rows: [], rowCount: 0 })),
    } as never);

    // The unfiltered all-time query must never compile.
    expect(compile).not.toHaveBeenCalled();
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'compile_and_run_semantic',
        reasonCode: 'SEMANTIC_TIME_WINDOW_UNBOUND',
      }),
    ]));
  });

  it('rejects an orderBy naming a field the call did not select', async () => {
    // A second admitted revenue metric keeps the HOST-FIRST binder out (it
    // never chooses between two meanings), so the scripted model call is the
    // one that reaches the tool — with its illegal orderBy.
    const rivalRevenue: AgentEvidenceCandidate = {
      ...windowMetric,
      id: 'semantic:metric:orders.revenue', qualifiedId: 'semantic:metric:orders.revenue', name: 'revenue',
    };
    const compile = vi.fn(async (selection: { filters?: Array<{ values?: unknown[] }> }) => ({ sql: `select 1 as revenue /* ${(selection.filters ?? []).flatMap((f) => f.values ?? []).join(' ')} */`, engine: 'native' as const }));
    const state = askV2State([windowMetric, rivalRevenue, customerName, orderedAt]);
    await __test__.createAskV2LaneHandler(state, { maxToolCalls: 6, maxProviderDispatches: 4 })({
      question: 'top customers by revenue',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        '```json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["semantic:metric:order_item.revenue"],"orderBy":[{"name":"profit","direction":"desc"}],"limit":10}}\n```',
        'stop',
      ]),
      askAgentV2Workspace: askV2Workspace([windowMetric, rivalRevenue, customerName, orderedAt]),
      semanticQueryCompiler: compile,
      executeGeneratedSql: vi.fn(async () => ({ columns: [], rows: [], rowCount: 0 })),
    } as never);
    expect(compile).not.toHaveBeenCalled();
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ reasonCode: 'SEMANTIC_ORDER_FIELD_NOT_SELECTED' }),
    ]));
  });
});

/**
 * MetricFlow renders a dimension as `entity__name`; model files qualify it as
 * `model.name`. A model that just read MetricFlow-shaped cards echoes those
 * spellings back — refusing them rejected the exact field the snapshot had
 * admitted. The qualifier must still AGREE: `orders__ordered_at` may never
 * resolve to `order_items.ordered_at`.
 */
describe('MetricFlow-shaped reference resolution', () => {
  const customerName = {
    id: 'semantic:uncategorized:dimension:customers.customer_name',
    qualifiedId: 'semantic:uncategorized:dimension:customers.customer_name',
    kind: 'semantic_member' as const,
    semanticObjectType: 'dimension' as const,
    trustTier: 'semantic' as const,
    name: 'customer_name',
    aliases: [],
    relevanceScore: 1,
    matchReasons: ['entity label'],
    compatibility: 'compatible' as const,
  };
  const capabilitiesFor = (...candidates: Array<typeof customerName>) => new Map(candidates.map((candidate) => [candidate.id, {
    version: 1 as const,
    candidateId: candidate.id,
    runtimeName: candidate.name,
    engines: [],
    roles: ['dimension' as const, 'filter_dimension' as const],
    fingerprint: askV2SemanticCandidateAuthorityFingerprint(candidate),
    isCurrent: () => true,
  }]));

  it('resolves entity__name and model.name spellings to the admitted candidate', () => {
    for (const reference of ['customer__customer_name', 'customers.customer_name', 'customer_name']) {
      expect(__test__.resolveV2SemanticCapabilityReference({
        reference, role: 'dimension', candidates: [customerName], capabilities: capabilitiesFor(customerName),
      }), reference).toBe(customerName.id);
    }
  });

  it('never lets a mismatched qualifier grab another model\'s field', () => {
    const ordersOrderedAt = {
      ...customerName,
      id: 'semantic:uncategorized:dimension:order_items.ordered_at',
      qualifiedId: 'semantic:uncategorized:dimension:order_items.ordered_at',
      name: 'ordered_at',
    };
    expect(__test__.resolveV2SemanticCapabilityReference({
      reference: 'products__ordered_at',
      role: 'dimension',
      candidates: [ordersOrderedAt],
      capabilities: capabilitiesFor(ordersOrderedAt),
    })).toBeUndefined();
  });
});

/**
 * A window-only requirement ("last two months …", no grain grouping) needs an
 * axis to FILTER on, not to group by — and the metric declares its own axes.
 * With exactly one compatible axis the HOST completes the binding; demanding
 * the model name an axis the question never mentioned fed the invalid-grain
 * retry loop until the budget died.
 */
describe('host-completed window axis', () => {
  it('applies the window through the sole metric-declared axis with no model time args', async () => {
    const metricWithAxis: AgentEvidenceCandidate = {
      id: 'semantic:metric:order_item.revenue', qualifiedId: 'semantic:metric:order_item.revenue', kind: 'semantic_metric',
      semanticObjectType: 'metric', trustTier: 'semantic', name: 'revenue',
      analyticalCapability: {
        metricId: 'semantic:metric:order_item.revenue',
        semanticModelId: 'semantic:uncategorized:model:order_item',
        measureIds: [], primaryEntityId: 'order_item',
        defaultResultGrainId: 'order_item', resultGrainIds: ['order_item'],
        aggregation: 'sum',
        additivity: { entities: 'additive', time: 'additive' },
        dimensions: [],
        timeDimensions: [{
          dimensionId: 'semantic:uncategorized:dimension:order_items.ordered_at',
          role: 'time', supportedGrains: ['day', 'week', 'month', 'quarter', 'year'],
        }],
        operations: [], supportedOutputKinds: [],
      } as never,
      relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const orderedAtAxis: AgentEvidenceCandidate = {
      id: 'semantic:uncategorized:dimension:order_items.ordered_at', qualifiedId: 'semantic:uncategorized:dimension:order_items.ordered_at',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic', name: 'ordered_at',
      timeGrains: ['day', 'week', 'month', 'quarter', 'year'],
      relevanceScore: 0.5, matchReasons: ['metric-declared time axis'], compatibility: 'compatible',
    };
    const compile = vi.fn(async (selection: { filters?: Array<{ values?: unknown[] }> }) => ({ sql: `select 1 as revenue /* ${(selection.filters ?? []).flatMap((f) => f.values ?? []).join(' ')} */`, engine: 'native' as const }));
    const execute = vi.fn(async () => ({ columns: ['customer_name', 'revenue'], rows: [{ customer_name: 'Ada', revenue: 1 }], rowCount: 1 }));
    const state = askV2State([metricWithAxis, orderedAtAxis]);

    await __test__.createAskV2LaneHandler(state, { maxToolCalls: 8, maxProviderDispatches: 6 })({
      question: 'Can you give me the last two month with high revenue by customer name',
      provider: textToolProvider([
        '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```',
        '```json\n{"tool":"inspect_semantic_candidates","input":{}}\n```',
        '```json\n{"tool":"compile_and_run_semantic","input":{"metricIds":["semantic:metric:order_item.revenue"],"orderBy":[{"name":"revenue","direction":"desc"}],"limit":10}}\n```',
        '```json\n{"tool":"finish_answer","input":{"answer":"Done."}}\n```',
      ]),
      askAgentV2Workspace: askV2Workspace([metricWithAxis, orderedAtAxis]),
      semanticQueryCompiler: compile,
      executeGeneratedSql: execute,
    } as never);

    expect(compile).toHaveBeenCalledOnce();
    const selection = (compile.mock.calls[0] as unknown[])[0] as {
      filters?: Array<{ dimension: string; operator: string; values: string[] }>;
      timeDimension?: unknown;
    };
    // The window applied through the host-completed axis…
    const rangeFilters = (selection.filters ?? []).filter((f) => f.dimension === 'ordered_at');
    expect(rangeFilters.map((f) => f.operator).sort()).toEqual(['gte', 'lt']);
    // …without forcing a time GROUPING the question never asked for.
    expect(selection.timeDimension).toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();
    expect(state.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ reasonCode: 'SEMANTIC_TIME_WINDOW_HOST_COMPLETED' }),
    ]));
  });
});

/**
 * T2 of the reported journey. "can you split by month" names no measure and
 * no entity of its own — it can only be about the answer on screen. Requiring
 * a deictic word dropped the whole conversation and let a certified block
 * claim the turn against an EMPTY plan. A question that brings its own
 * subject keeps today's strictness.
 */
describe('shape-continuation follow-ups', () => {
  it('carries the prior shape for a drill verb with no new subject', () => {
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: 'can you split by month' }],
      conversationContext: {
        conversationStateVersion: 1,
        activeTurnId: 'turn_t1',
        turns: [{
          id: 'turn_t1',
          question: 'Can you give me the last two month with high revenue by customer name',
          requestedMeasures: ['revenue'],
          requestedDimensions: ['customer_name'],
          result: {
            columns: ['customer_name', 'revenue'],
            dimensionValues: { customer_name: ['Ada', 'Grace'] },
            measureColumns: ['revenue'],
          },
        }],
      },
    } as AgentRunRequest, 'can you split by month');

    expect(followUp?.kind).toBe('drilldown');
    expect(followUp?.dimensions).toEqual(expect.arrayContaining(['customer_name', 'month']));
    expect(followUp?.priorMeasures).toEqual(expect.arrayContaining(['revenue']));
  });

  it('keeps a question with its own subject fresh', () => {
    for (const question of ['show revenue by region', 'split shipments by warehouse', 'how many orders per store']) {
      const followUp = __test__.followUpFromConversationContext({
        provider: 'ollama',
        projectRoot: '/tmp/x',
        messages: [{ role: 'user', content: question }],
        conversationContext: {
          sourceQuestion: 'who are the top customers',
          resultColumns: ['customer_name', 'revenue'],
          resultDimensionValues: { customer_name: ['Ada'] },
        },
      } as AgentRunRequest, question);
      expect(followUp?.kind, question).not.toBe('drilldown');
    }
  });
});

/**
 * Host-first semantic execution: when every clause of the question resolves
 * to exactly ONE admitted binding, the host calls its own governed tools and
 * the provider is never dispatched. When ANY clause is ambiguous — the
 * large-repo case that killed the old deterministic planner — the host
 * refuses to guess and the analyst loop decides. Determinism only where no
 * decision exists; intelligence wherever one does.
 */
describe('host-first semantic execution', () => {
  const metric: AgentEvidenceCandidate = {
    id: 'semantic:metric:order_item.revenue', qualifiedId: 'semantic:metric:order_item.revenue', kind: 'semantic_metric',
    semanticObjectType: 'metric', trustTier: 'semantic', name: 'revenue',
    relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
  };
  const customerName: AgentEvidenceCandidate = {
    id: 'semantic:uncategorized:dimension:customers.customer_name', qualifiedId: 'semantic:uncategorized:dimension:customers.customer_name',
    kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic', name: 'customer_name',
    relevanceScore: 0.9, matchReasons: ['entity label'], compatibility: 'compatible',
  };

  it('executes an unambiguous ranking with ZERO provider dispatches', async () => {
    const compile = vi.fn(async (selection: { filters?: Array<{ values?: unknown[] }> }) => ({ sql: `select 1 as revenue /* ${(selection.filters ?? []).flatMap((f) => f.values ?? []).join(' ')} */`, engine: 'native' as const }));
    const execute = vi.fn(async () => ({ columns: ['customer_name', 'revenue'], rows: [{ customer_name: 'Ada', revenue: 9 }], rowCount: 1 }));
    const providerCalls: string[] = [];
    const provider: AgentProvider = {
      name: 'ollama',
      async available() { return true; },
      async generate() { providerCalls.push('generate'); return 'should never be called'; },
    };
    const state = askV2State([metric, customerName]);

    const answer = await __test__.createAskV2LaneHandler(state, { maxToolCalls: 8, maxProviderDispatches: 6 })({
      question: 'who are the top customers by highest revenue',
      provider,
      askAgentV2Workspace: askV2Workspace([metric, customerName]),
      semanticQueryCompiler: compile,
      executeGeneratedSql: execute,
    } as never);

    expect(providerCalls).toEqual([]);
    expect(compile).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(answer.result?.rowCount).toBe(1);
    const selection = (compile.mock.calls[0] as unknown[])[0] as { orderBy?: unknown; limit?: number };
    expect(selection.orderBy).toEqual([{ name: 'revenue', direction: 'desc' }]);
    expect(selection.limit).toBe(10);
  });

  it('restores projected columns and stamps the applied window on a zero-row windowed result', async () => {
    // The adapter loses its header row when zero rows return, which starved
    // the deterministic facts renderer of even the "zero rows" claim. The
    // host composed the selection, so it declares the projected columns and
    // the window it applied — the answer can then say WHAT period was empty.
    const metricWithAxis: AgentEvidenceCandidate = {
      ...metric,
      analyticalCapability: {
        timeDimensions: [{
          dimensionId: 'semantic:uncategorized:dimension:order_item.metric_time',
          role: 'metric_time',
          supportedGrains: ['day', 'month'],
        }],
      } as never,
    };
    const metricTimeAxis: AgentEvidenceCandidate = {
      id: 'semantic:uncategorized:dimension:order_item.metric_time',
      qualifiedId: 'semantic:uncategorized:dimension:order_item.metric_time',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic', name: 'metric_time',
      timeGrains: ['day', 'month'],
      relevanceScore: 0.5, matchReasons: ['declared axis'], compatibility: 'compatible',
    };
    const compile = vi.fn(async (selection: { filters?: Array<{ values?: unknown[] }> }) => ({ sql: `select 1 as revenue /* ${(selection.filters ?? []).flatMap((f) => f.values ?? []).join(' ')} */`, engine: 'native' as const }));
    const execute = vi.fn(async () => ({ columns: [], rows: [], rowCount: 0 }));
    const provider: AgentProvider = {
      name: 'ollama',
      async available() { return true; },
      async generate() { throw new Error('zero-dispatch path must not consult the provider'); },
    };
    const candidates = [metricWithAxis, customerName, metricTimeAxis];
    const state = askV2State(candidates);

    const answer = await __test__.createAskV2LaneHandler(state, { maxToolCalls: 8, maxProviderDispatches: 6 })({
      question: 'top customers by highest revenue for the last two months',
      provider,
      askAgentV2Workspace: askV2Workspace(candidates),
      semanticQueryCompiler: compile,
      executeGeneratedSql: execute,
    } as never);

    expect(compile).toHaveBeenCalledOnce();
    const result = answer.result as (NonNullable<typeof answer.result> & {
      appliedTimeWindow?: { expression: string; startInclusive: string; endExclusive: string };
    }) | undefined;
    expect(result?.rowCount).toBe(0);
    expect(result?.columns).toEqual(['customer_name', 'revenue']);
    expect(result?.appliedTimeWindow?.expression).toBe('last 2 months');
    expect(result?.appliedTimeWindow?.startInclusive).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result?.appliedTimeWindow?.endExclusive).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('binds a clarified prior-result member deterministically and executes with ZERO dispatches', async () => {
    // The user clicked "Mr. Matthew Meyer" in a host-issued clarification.
    // That selection is server truth — asking a provider to transcribe it
    // back into a filter argument is what killed these turns in production
    // (the model answered in prose twice and the loop refused it).
    const compile = vi.fn(async (selection: { filters?: Array<{ values?: unknown[] }> }) => ({ sql: `select 1 as revenue /* ${(selection.filters ?? []).flatMap((f) => f.values ?? []).join(' ')} */`, engine: 'native' as const }));
    const execute = vi.fn(async () => ({ columns: ['revenue'], rows: [{ revenue: 42 }], rowCount: 1 }));
    const provider: AgentProvider = {
      name: 'ollama',
      async available() { return true; },
      async generate() { throw new Error('deterministic member binding must not consult the provider'); },
    };
    const state = askV2State([metric, customerName], 'clarification_response');
    state.conversation = {
      version: 2,
      availableResultHandleIds: [],
      clarificationId: 'member:customer:Mr. Matthew Meyer',
    };

    const answer = await __test__.createAskV2LaneHandler(state, { maxToolCalls: 8, maxProviderDispatches: 6 })({
      question: 'how much his total revenue? (Mr. Matthew Meyer)',
      provider,
      askAgentV2Workspace: askV2Workspace([metric, customerName]),
      semanticQueryCompiler: compile,
      executeGeneratedSql: execute,
    } as never);

    expect(compile).toHaveBeenCalledOnce();
    expect(answer.result?.rowCount).toBe(1);
    const selection = (compile.mock.calls[0] as unknown[])[0] as { filters?: Array<{ dimension: string; operator: string; values: string[] }> };
    expect(selection.filters).toEqual([
      { dimension: 'customer_name', operator: '=', values: ['Mr. Matthew Meyer'] },
    ]);
  });

  it('grounds a free literal through the allowlist probe and binds the canonical spelling', async () => {
    const productType: AgentEvidenceCandidate = {
      id: 'semantic:uncategorized:dimension:products.product_type',
      qualifiedId: 'semantic:uncategorized:dimension:products.product_type',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic', name: 'product_type',
      semanticModel: 'products',
      relevanceScore: 0.7, matchReasons: ['filter term'], compatibility: 'compatible',
    };
    const compile = vi.fn(async (selection: { filters?: Array<{ values?: unknown[] }> }) => ({ sql: `select 1 as revenue /* ${(selection.filters ?? []).flatMap((f) => f.values ?? []).join(' ')} */`, engine: 'native' as const }));
    const execute = vi.fn(async () => ({ columns: ['revenue'], rows: [{ revenue: 7 }], rowCount: 1 }));
    const probe = vi.fn(async (literal: string) => ({
      status: 'matched' as const,
      matches: [{ relation: 'dev.products', column: 'product_type', canonicalValue: literal === 'beverage' ? 'beverage' : 'unexpected' }],
    }));
    const provider: AgentProvider = {
      name: 'ollama',
      async available() { return true; },
      async generate() { throw new Error('probe-grounded binding must not consult the provider'); },
    };
    const candidates = [metric, productType];
    const state = askV2State(candidates);

    const answer = await __test__.createAskV2LaneHandler(state, { maxToolCalls: 8, maxProviderDispatches: 6 })({
      question: 'total revenue on the beverage category',
      provider,
      askAgentV2Workspace: askV2Workspace(candidates),
      semanticQueryCompiler: compile,
      executeGeneratedSql: execute,
      probeAllowlistedLiteral: probe,
    } as never);

    expect(probe).toHaveBeenCalledWith('beverage');
    expect(compile).toHaveBeenCalledOnce();
    expect(answer.result?.rowCount).toBe(1);
    const selection = (compile.mock.calls[0] as unknown[])[0] as { filters?: Array<{ dimension: string; operator: string; values: string[] }> };
    expect(selection.filters).toEqual([
      { dimension: 'product_type', operator: '=', values: ['beverage'] },
    ]);
  });

  it('falls to the analyst when the probe cannot prove the literal', async () => {
    const compile = vi.fn(async (selection: { filters?: Array<{ values?: unknown[] }> }) => ({ sql: `select 1 as revenue /* ${(selection.filters ?? []).flatMap((f) => f.values ?? []).join(' ')} */`, engine: 'native' as const }));
    const generate = vi.fn(async () => '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```');
    const probe = vi.fn(async () => ({ status: 'no_match' as const, matches: [] }));
    const provider: AgentProvider = { name: 'ollama', async available() { return true; }, generate };
    const candidates = [metric, customerName];
    const state = askV2State(candidates);

    await __test__.createAskV2LaneHandler(state, { maxToolCalls: 4, maxProviderDispatches: 2 })({
      question: 'total revenue for customer Ronnie Knight',
      provider,
      askAgentV2Workspace: askV2Workspace(candidates),
      semanticQueryCompiler: compile,
      executeGeneratedSql: vi.fn(async () => ({ columns: [], rows: [], rowCount: 0 })),
      probeAllowlistedLiteral: probe,
    } as never);

    // No proof for the value: the host must NOT invent a filter.
    expect(compile).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalled();
  });

  it('names an unmodeled requested term instead of "not enough context"', async () => {
    // "region" exists nowhere in the governed model. The truthful terminal
    // names the term and the governed alternatives; the generic grounding
    // message reads as a system failure and hides the actual fix.
    const generate = vi.fn(async () => 'The customer belongs to the western region.');
    const provider: AgentProvider = { name: 'ollama', async available() { return true; }, generate };
    const candidates = [metric, customerName];
    const state = askV2State(candidates);

    const answer = await __test__.createAskV2LaneHandler(state, { maxToolCalls: 4, maxProviderDispatches: 2 })({
      question: 'show revenue by region',
      provider,
      askAgentV2Workspace: askV2Workspace(candidates),
      semanticQueryCompiler: vi.fn(async () => ({ sql: 'select 1', engine: 'native' as const })),
      executeGeneratedSql: vi.fn(async () => ({ columns: [], rows: [], rowCount: 0 })),
      // The HOST's whole-catalog lookup proves absence; retention alone is a
      // ranking, not the model, and must never authorize this refusal.
      catalogTermMentioned: async () => false,
    } as never);

    expect(answer.refusalCode).toBe('modeling_gap');
    expect(answer.text).toContain('"region" is not modeled');
    expect(answer.text).toContain('customer_name');
  });

  it('never declares a term unmodeled from retention alone (the 60k-catalog case)', async () => {
    // On the office-scale repo, "customer" was declared unmodeled because no
    // retained card contained it — while the catalog held hundreds of
    // customer models. Catalog-mentioned terms go to the analyst instead.
    const generate = vi.fn(async () => 'The requested grouping could not be resolved.');
    const provider: AgentProvider = { name: 'ollama', async available() { return true; }, generate };
    const candidates = [metric, customerName];
    const state = askV2State(candidates);

    const answer = await __test__.createAskV2LaneHandler(state, { maxToolCalls: 4, maxProviderDispatches: 2 })({
      question: 'show revenue by region',
      provider,
      askAgentV2Workspace: askV2Workspace(candidates),
      semanticQueryCompiler: vi.fn(async () => ({ sql: 'select 1', engine: 'native' as const })),
      executeGeneratedSql: vi.fn(async () => ({ columns: [], rows: [], rowCount: 0 })),
      catalogTermMentioned: async () => true,
    } as never);

    // The catalog says the term exists somewhere: the analyst is consulted
    // and no pre-dispatch modeling-gap refusal is minted.
    expect(generate).toHaveBeenCalled();
    expect(answer.refusalCode).not.toBe('modeling_gap');
  });

  it('falls back to the analyst when the measure is AMBIGUOUS (the large-repo case)', async () => {
    const secondRevenue: AgentEvidenceCandidate = {
      ...metric,
      id: 'semantic:metric:orders.revenue', qualifiedId: 'semantic:metric:orders.revenue', name: 'revenue',
    };
    const compile = vi.fn(async (selection: { filters?: Array<{ values?: unknown[] }> }) => ({ sql: `select 1 as revenue /* ${(selection.filters ?? []).flatMap((f) => f.values ?? []).join(' ')} */`, engine: 'native' as const }));
    const generate = vi.fn(async () => '```json\n{"tool":"inspect_certified_candidates","input":{}}\n```');
    const provider: AgentProvider = { name: 'ollama', async available() { return true; }, generate };
    const state = askV2State([metric, secondRevenue, customerName]);

    await __test__.createAskV2LaneHandler(state, { maxToolCalls: 4, maxProviderDispatches: 2 })({
      question: 'who are the top customers by highest revenue',
      provider,
      askAgentV2Workspace: askV2Workspace([metric, secondRevenue, customerName]),
      semanticQueryCompiler: compile,
      executeGeneratedSql: vi.fn(async () => ({ columns: [], rows: [], rowCount: 0 })),
    } as never);

    // Two admitted metrics claim "revenue": the host must NOT pick one.
    // The provider (the intelligence) is consulted instead.
    expect(generate).toHaveBeenCalled();
    expect(compile).not.toHaveBeenCalled();
  });
});
