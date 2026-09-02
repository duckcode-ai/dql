import { describe, expect, it, vi } from 'vitest';
import {
  ASK_V2_CANONICAL_TOOLS,
  askAgentV2WorkspaceMatches,
  createAskAgentRuntimeV2,
  createAskToolKernelV2,
  ASK_V2_DESCRIBE_CALLS_PER_TOOL,
  defaultProviderResultEgressPolicyV2,
  materializeAskV2WorkspaceTierTruth,
  projectResearchEvidenceLedgerV4,
  type AskAgentStateV4,
} from './ask-agent-runtime-v2.js';
import type { AgentEvidenceCandidate, AgentRetrievalEvidence } from '../meaning-resolution.js';
import type { IntentDecision } from '../intent-controller.js';

const revenue: AgentEvidenceCandidate = {
  id: 'semantic:metric:orders.revenue',
  qualifiedId: 'semantic:metric:orders.revenue',
  kind: 'semantic_metric',
  trustTier: 'semantic',
  name: 'orders.revenue',
  aliases: ['revenue'],
  relevanceScore: 1,
  matchReasons: ['exact'],
  compatibility: 'compatible',
  exactMatch: true,
};

const customer: AgentEvidenceCandidate = {
  id: 'sql:column:customers.customer_name',
  qualifiedId: 'sql:column:customers.customer_name',
  kind: 'sql_column',
  trustTier: 'exploratory',
  name: 'customer_name',
  aliases: ['customer', 'customer name'],
  relevanceScore: 0.9,
  matchReasons: ['entity label'],
  compatibility: 'compatible',
};

const region: AgentEvidenceCandidate = {
  id: 'sql:column:customers.region',
  qualifiedId: 'sql:column:customers.region',
  kind: 'sql_column',
  trustTier: 'exploratory',
  name: 'region',
  relevanceScore: 0.8,
  matchReasons: ['dimension'],
  compatibility: 'partial',
};

const evidence = (candidates: AgentEvidenceCandidate[] = [revenue, customer, region]): AgentRetrievalEvidence => ({
  snapshotId: 'snapshot:one',
  sourceFingerprint: 'sha256:source',
  candidates,
  parsedIntent: { measures: ['revenue'], dimensions: ['customer', 'region'], filters: [] },
});

const legacyDecision = (): IntentDecision => ({
  action: 'block', confidence: 1, followsUp: false, reason: 'V1 gate', source: 'heuristic',
  terminalOutcome: {
    kind: 'modeling_gap', code: 'ANALYTICAL_MODELING_GAP', message: 'legacy terminal', candidateIds: [],
  },
});

describe('AskAgentRuntimeV2 prior-result continuity', () => {
  const customers = ['Mr. Matthew Meyer', 'Aaron Gardner', 'Angela Moyer'];
  const ambiguousGap = {
    code: 'PRIOR_RESULT_MEMBER_AMBIGUOUS',
    message: 'The previous answer listed 3 customers. Which one did you mean?',
    options: customers.map((label) => ({ id: `member:customer:${label}`, label, kind: 'member' })),
  };

  // An ambiguous reference to the previous answer is still ABOUT the previous
  // answer. Framing it as fresh analytics would ask the user to choose a
  // member while presenting the turn as a brand-new question.
  it('classifies an ambiguous prior-result reference as a prior-result turn', async () => {
    const getEvidence = vi.fn(async () => evidence());
    const legacyRouter = { decide: vi.fn(async () => legacyDecision()) };
    const runtime = createAskAgentRuntimeV2({ mode: 'authoritative_v2', getEvidence, legacyRouter });

    const decision = await runtime.decide({
      question: 'what region he belongs to',
      requestedMode: 'ask',
      selectedResultBindingGap: ambiguousGap,
    });

    expect(decision.action).toBe('clarify');
    expect(decision.askAgentV2Decision?.state.turnClass).toBe('prior_result');
    // The members must reach the analyst so it can offer them rather than guess.
    expect(decision.clarificationOptions?.map((option) => option.label)).toEqual(customers);
    expect(decision.askAgentV2Decision?.state.conversation.ambiguousMemberLabels).toEqual(customers);
  });

  it('offers no member choices when the host resolved the reference unambiguously', async () => {
    const getEvidence = vi.fn(async () => evidence());
    const legacyRouter = { decide: vi.fn(async () => legacyDecision()) };
    const runtime = createAskAgentRuntimeV2({ mode: 'authoritative_v2', getEvidence, legacyRouter });

    const decision = await runtime.decide({
      question: 'which region "Mr. Matthew Meyer" belongs to',
      requestedMode: 'ask',
      priorResultMemberBinding: { version: 1, displayDimension: 'customer_name', values: ['Mr. Matthew Meyer'] },
    });

    expect(decision.askAgentV2Decision?.state.turnClass).toBe('prior_result');
    expect(decision.askAgentV2Decision?.state.conversation.ambiguousMemberLabels).toBeUndefined();
  });
});

describe('AskAgentRuntimeV2', () => {
  it('AGT-047 keeps a semantic-incomplete question in the agent tool runtime instead of producing a coverage terminal', async () => {
    const getEvidence = vi.fn(async () => evidence());
    const legacyRouter = { decide: vi.fn(async () => legacyDecision()) };
    const runtime = createAskAgentRuntimeV2({ mode: 'authoritative_v2', getEvidence, legacyRouter });

    const decision = await runtime.decide({
      question: 'show top customers by revenue and region',
      requestedMode: 'ask',
    });

    expect(getEvidence).toHaveBeenCalledOnce();
    expect(legacyRouter.decide).not.toHaveBeenCalled();
    expect(decision.action).toBe('answer');
    expect(decision.terminalOutcome).toBeUndefined();
    expect(decision.resolvedAnalyticalPlan).toBeUndefined();
    expect(decision.askAgentV2Decision?.state.snapshotId).toBe('snapshot:one');
    expect(decision.askAgentV2Decision?.state.initialCandidateIds).toContain(revenue.id);
  });

  it('AGT-047 promotes one host-proven exact certified artifact into the zero-provider V2 Tier 1 path', async () => {
    const certified: AgentEvidenceCandidate = {
      id: 'dql:block:customer_profile',
      qualifiedId: 'dql:block:customer_profile',
      kind: 'certified_block',
      trustTier: 'certified',
      name: 'customer_profile',
      relevanceScore: 1,
      matchReasons: ['exact'],
      compatibility: 'compatible',
      exactMatch: true,
    };
    const artifact = {
      version: 1 as const,
      artifact: { kind: 'block', nodeId: 'dql:block:customer_profile', name: 'customer_profile' },
      revisionFingerprint: 'sha256:customer-profile',
      isCurrent: () => true,
    };
    const bridge = {
      version: 2 as const,
      snapshotId: 'snapshot:one',
      sourceFingerprint: 'sha256:source',
      getContextPack: () => ({}),
      isCertifiedExecutionAvailable: () => true,
      getToolWorkspace: () => ({
        version: 1 as const,
        snapshotId: 'snapshot:one',
        sourceFingerprint: 'sha256:source',
        candidates: [certified],
        relationshipPathHandles: [],
        certifiedArtifacts: new Map([[certified.qualifiedId!, artifact]]),
        certifiedCompleteCandidateIds: [certified.qualifiedId!],
        tierStates: {
          certified: {
            version: 1 as const,
            status: 'complete' as const,
            candidateIds: [certified.qualifiedId!],
            reasonCode: 'CERTIFIED_COMPLETE_FOR_REQUEST',
            safeNextTools: ['run_certified' as const],
          },
        },
      }),
    };
    const legacyRouter = { decide: vi.fn(async () => legacyDecision()) };
    const runtime = createAskAgentRuntimeV2({
      mode: 'authoritative_v2',
      getEvidence: async (request) => {
        request.askAgentV2Workspace = bridge;
        return evidence([certified]);
      },
      legacyRouter,
    });

    const decision = await runtime.decide({ question: 'who are the top customers', requestedMode: 'ask' });

    expect(legacyRouter.decide).not.toHaveBeenCalled();
    expect(decision.action).toBe('answer');
    expect(decision.askAgentV2Decision?.state).toMatchObject({
      exactCertifiedCandidateId: certified.qualifiedId,
      candidatePlan: { intendedTool: 'run_certified', candidateIds: [certified.qualifiedId] },
      tierStates: { certified: { status: 'complete', candidateIds: [certified.qualifiedId] } },
    });
    expect(decision.askAgentV2Decision?.state.resolvedPlan).toBeUndefined();

    // Tier-truth materialization is provenance only. It must not fabricate a
    // run_certified observation (which would consume the one actual
    // execution action before the fast path reaches authorization).
    const state = decision.askAgentV2Decision!.state;
    expect(state.observations).toEqual([]);
    const kernel = createAskToolKernelV2(state);
    expect(kernel.canCall('run_certified', {
      candidateIds: [certified.qualifiedId!],
    })).toEqual({
      ok: false,
      reasonCode: 'ASK_V2_TOOL_PROGRESSION_REQUIRED',
      safeNextTools: ['inspect_certified_candidates'],
    });
    // Only the server-owned exact capability may bypass the inspector. It is
    // still one real run_certified lifecycle: authorization is internal and
    // the executed observation is the single tool-budgeted action.
    expect(kernel.canCall('run_certified', {
      candidateIds: [certified.qualifiedId!],
      directExactCertifiedExecution: true,
    })).toEqual({ ok: true });
    kernel.observe({
      version: 1,
      tool: 'run_certified',
      tier: 'certified',
      outcome: 'eligible',
      reasonCode: 'ASK_V2_EXECUTION_AUTHORIZED',
      candidateIds: [certified.qualifiedId!],
      planId: 'ask-v2:certified:customer-profile',
      executionAuthorized: true,
      inputFingerprint: 'sha256:customer-profile',
      origin: 'freeze',
    });
    kernel.observe({
      version: 1,
      tool: 'run_certified',
      tier: 'certified',
      outcome: 'executed',
      reasonCode: 'CERTIFIED_EXECUTED',
      candidateIds: [certified.qualifiedId!],
      planId: 'ask-v2:certified:customer-profile',
      origin: 'execution',
    });
    expect(kernel.diagnosticReceipt(undefined, {
      connectionAttempted: true,
      executionAttempts: 1,
      factCount: 1,
      narration: 'fact_bound',
    }).activity).toMatchObject({ toolCalls: 1, executionAttempts: 1 });
  });

  it('AGT-047 materializes multiple complete certified artifacts before policy and clears a reloaded lower-tier commitment', async () => {
    const first: AgentEvidenceCandidate = {
      id: 'dql:block:customer_profile', qualifiedId: 'dql:block:customer_profile', kind: 'certified_block', trustTier: 'certified',
      name: 'customer_profile', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible', exactMatch: true,
    };
    const second: AgentEvidenceCandidate = {
      id: 'dql:block:customer_revenue', qualifiedId: 'dql:block:customer_revenue', kind: 'certified_block', trustTier: 'certified',
      name: 'customer_revenue', relevanceScore: 0.99, matchReasons: ['exact'], compatibility: 'compatible', exactMatch: true,
    };
    const bridge = {
      version: 2 as const,
      snapshotId: 'snapshot:one',
      sourceFingerprint: 'sha256:source',
      getContextPack: () => ({}),
      isCertifiedExecutionAvailable: () => true,
      getToolWorkspace: () => ({
        version: 1 as const,
        snapshotId: 'snapshot:one',
        sourceFingerprint: 'sha256:source',
        candidates: [first, second, revenue],
        relationshipPathHandles: [],
        certifiedArtifacts: new Map([
          [first.qualifiedId!, {
            version: 1 as const,
            artifact: { kind: 'block', nodeId: first.qualifiedId, name: first.name },
            revisionFingerprint: 'sha256:customer-profile',
            isCurrent: () => true,
          }],
          [second.qualifiedId!, {
            version: 1 as const,
            artifact: { kind: 'block', nodeId: second.qualifiedId, name: second.name },
            revisionFingerprint: 'sha256:customer-revenue',
            isCurrent: () => true,
          }],
        ]),
        certifiedCompleteCandidateIds: [first.qualifiedId!, second.qualifiedId!],
      }),
    };
    const runtime = createAskAgentRuntimeV2({
      mode: 'authoritative_v2',
      getEvidence: async (request) => {
        request.askAgentV2Workspace = bridge;
        return evidence([first, second, revenue]);
      },
      legacyRouter: { decide: async () => legacyDecision() },
    });

    const decision = await runtime.decide({ question: 'show customers by revenue', requestedMode: 'ask' });
    const current = decision.askAgentV2Decision!.state;
    expect(current.exactCertifiedCandidateId).toBeUndefined();
    expect(current.tierStates?.certified).toMatchObject({
      status: 'complete',
      candidateIds: [first.qualifiedId, second.qualifiedId],
    });
    const kernel = createAskToolKernelV2(current);
    expect(kernel.toolPolicy()).toMatchObject({
      allowedToolNames: ['inspect_certified_candidates'],
      terminalActionToolNames: ['inspect_certified_candidates'],
    });
    expect(kernel.canCall('inspect_semantic_candidates')).toEqual({
      ok: false,
      reasonCode: 'ASK_V2_TOOL_PROGRESSION_REQUIRED',
      safeNextTools: ['inspect_certified_candidates'],
    });
    // Simulate a pre-fix persisted/reloaded V4 state. The same immutable
    // workspace clears the stale semantic proposal before policy is read.
    current.controllerTier = 'semantic';
    materializeAskV2WorkspaceTierTruth(current, bridge, { question: 'show customers by revenue' });
    expect(current.controllerTier).toBeUndefined();
    expect(kernel.toolPolicy()).toMatchObject({ allowedToolNames: ['inspect_certified_candidates'] });
  });

  it('AGT-047 permits a lower-tier priority exception only for an explicit admitted qualified artifact reference', () => {
    const certified: AgentEvidenceCandidate = {
      id: 'dql:block:customer_profile', qualifiedId: 'dql:block:customer_profile', kind: 'certified_block', trustTier: 'certified',
      name: 'customer_profile', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const current: AskAgentStateV4 = {
      version: 4, mode: 'authoritative_v2', turnClass: 'analytics', snapshotId: 'snapshot:one', sourceFingerprint: 'sha256:source',
      retainedCandidateIds: [certified.qualifiedId!, revenue.qualifiedId!],
      initialCandidateIds: [certified.qualifiedId!, revenue.qualifiedId!], expansionCandidateIds: [], relationshipPathHandles: [],
      conversation: { version: 2, availableResultHandleIds: [] }, observations: [],
    };
    const bridge = {
      version: 2 as const, snapshotId: 'snapshot:one', sourceFingerprint: 'sha256:source', getContextPack: () => ({}), isCertifiedExecutionAvailable: () => true,
      getToolWorkspace: () => ({
        version: 1 as const, snapshotId: 'snapshot:one', sourceFingerprint: 'sha256:source', candidates: [certified, revenue], relationshipPathHandles: [],
        certifiedArtifacts: new Map([[certified.qualifiedId!, {
          version: 1 as const,
          artifact: { kind: 'block', nodeId: certified.qualifiedId, name: certified.name },
          revisionFingerprint: 'sha256:customer-profile',
          isCurrent: () => true,
        }]]), certifiedCompleteCandidateIds: [certified.qualifiedId!],
      }),
    };

    materializeAskV2WorkspaceTierTruth(current, bridge, { question: `use ${revenue.qualifiedId} instead` });
    expect(current.explicitQualifiedArtifactReference).toEqual({ version: 1, tier: 'semantic', candidateId: revenue.qualifiedId });
    expect(createAskToolKernelV2(current).canCall('inspect_semantic_candidates')).toEqual({ ok: true });
  });

  it('AGT-047 clears a reloaded certified shortcut when the current workspace no longer has a complete fit', () => {
    const certified: AgentEvidenceCandidate = {
      id: 'dql:block:customer_profile', qualifiedId: 'dql:block:customer_profile', kind: 'certified_block', trustTier: 'certified',
      name: 'customer_profile', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const current: AskAgentStateV4 = {
      version: 4, mode: 'authoritative_v2', turnClass: 'analytics', snapshotId: 'snapshot:one', sourceFingerprint: 'sha256:source',
      retainedCandidateIds: [certified.qualifiedId!, revenue.qualifiedId!],
      initialCandidateIds: [certified.qualifiedId!, revenue.qualifiedId!], expansionCandidateIds: [], relationshipPathHandles: [],
      conversation: { version: 2, availableResultHandleIds: [] }, observations: [],
      controllerTier: 'certified', exactCertifiedCandidateId: certified.qualifiedId,
      candidatePlan: { version: 1, turnClass: 'analytics', candidateIds: [certified.qualifiedId!], intendedTool: 'run_certified', requirementFingerprint: 'sha256:old' },
      tierStates: { certified: { version: 1, status: 'complete', candidateIds: [certified.qualifiedId!], reasonCode: 'CERTIFIED_COMPLETE_FOR_REQUEST' } },
    };
    const bridge = {
      version: 2 as const, snapshotId: 'snapshot:one', sourceFingerprint: 'sha256:source', getContextPack: () => ({}), isCertifiedExecutionAvailable: () => true,
      getToolWorkspace: () => ({
        version: 1 as const, snapshotId: 'snapshot:one', sourceFingerprint: 'sha256:source', candidates: [certified, revenue], relationshipPathHandles: [],
        certifiedArtifacts: new Map([[certified.qualifiedId!, {
          version: 1 as const,
          artifact: { kind: 'block', nodeId: certified.qualifiedId, name: certified.name },
          revisionFingerprint: 'sha256:customer-profile',
          isCurrent: () => true,
        }]]),
        // The new current snapshot no longer proves the previous tuple.
        certifiedCompleteCandidateIds: [],
      }),
    };

    materializeAskV2WorkspaceTierTruth(current, bridge, { question: 'show revenue by customer' });

    expect(current.exactCertifiedCandidateId).toBeUndefined();
    expect(current.candidatePlan).toBeUndefined();
    expect(current.controllerTier).toBeUndefined();
    expect(current.tierStates?.certified).toMatchObject({
      status: 'ineligible',
      reasonCode: 'CERTIFIED_TUPLE_NOT_PROVEN_BY_SNAPSHOT',
    });
    const kernel = createAskToolKernelV2(current);
    kernel.observe({ version: 1, tool: 'inspect_certified_candidates', tier: 'certified', outcome: 'ineligible', reasonCode: 'CERTIFIED_TUPLE_NOT_PROVEN_BY_SNAPSHOT', candidateIds: [certified.qualifiedId!] });
    expect(kernel.toolPolicy()).toMatchObject({ allowedToolNames: ['inspect_semantic_candidates', 'run_certified'] });
  });

  it.each([
    ['CERTIFIED_EXECUTOR_UNAVAILABLE', () => true, false],
    ['CERTIFIED_ARTIFACT_STALE', () => false, true],
  ] as const)('AGT-047 lets semantic fallback continue when Tier 1 is %s before freeze', (reasonCode, currentArtifact, hostExecutor) => {
    const certified: AgentEvidenceCandidate = {
      id: 'dql:block:customer_profile', qualifiedId: 'dql:block:customer_profile', kind: 'certified_block', trustTier: 'certified',
      name: 'customer_profile', relevanceScore: 1, matchReasons: ['exact'], compatibility: 'compatible',
    };
    const current: AskAgentStateV4 = {
      version: 4, mode: 'authoritative_v2', turnClass: 'analytics', snapshotId: 'snapshot:one', sourceFingerprint: 'sha256:source',
      retainedCandidateIds: [certified.qualifiedId!, revenue.qualifiedId!],
      initialCandidateIds: [certified.qualifiedId!, revenue.qualifiedId!], expansionCandidateIds: [], relationshipPathHandles: [],
      conversation: { version: 2, availableResultHandleIds: [] }, observations: [],
    };
    const bridge = {
      version: 2 as const, snapshotId: 'snapshot:one', sourceFingerprint: 'sha256:source', getContextPack: () => ({}), isCertifiedExecutionAvailable: () => hostExecutor,
      getToolWorkspace: () => ({
        version: 1 as const, snapshotId: 'snapshot:one', sourceFingerprint: 'sha256:source', candidates: [certified, revenue], relationshipPathHandles: [],
        certifiedArtifacts: new Map([[certified.qualifiedId!, {
          version: 1 as const,
          artifact: { kind: 'block', nodeId: certified.qualifiedId, name: certified.name },
          revisionFingerprint: 'sha256:customer-profile',
          isCurrent: currentArtifact,
        }]]),
        certifiedCompleteCandidateIds: [certified.qualifiedId!],
      }),
    };

    materializeAskV2WorkspaceTierTruth(current, bridge, { question: 'show revenue by customer' });
    expect(current.tierStates?.certified).toMatchObject({ status: 'unavailable', reasonCode });
    const kernel = createAskToolKernelV2(current);
    kernel.observe({ version: 1, tool: 'inspect_certified_candidates', tier: 'certified', outcome: 'unavailable', reasonCode, candidateIds: [certified.qualifiedId!] });
    expect(kernel.toolPolicy()).toMatchObject({ allowedToolNames: ['inspect_semantic_candidates', 'run_certified'] });
  });

  it('CTX-009 keeps up to 128 server candidates while releasing at most 24 initial cards', async () => {
    const many = Array.from({ length: 140 }, (_, index): AgentEvidenceCandidate => ({
      ...customer,
      id: `sql:column:customers.field_${index}`,
      qualifiedId: `sql:column:customers.field_${index}`,
      name: `field_${index}`,
      relevanceScore: 1 - index / 200,
    }));
    const runtime = createAskAgentRuntimeV2({
      mode: 'authoritative_v2',
      getEvidence: async () => evidence([revenue, ...many]),
      legacyRouter: { decide: async () => legacyDecision() },
    });
    const decision = await runtime.decide({ question: 'top customers by revenue', requestedMode: 'ask' });
    expect(decision.askAgentV2Decision?.state.retainedCandidateIds).toHaveLength(128);
    expect(decision.askAgentV2Decision?.state.initialCandidateIds.length).toBeLessThanOrEqual(24);
    expect(decision.askAgentV2Decision?.state.expansionCandidateIds.length).toBeLessThanOrEqual(24);
  });

  it('OBS-017 records source coverage and bounded-workspace exclusions without declaring a pruned card absent', async () => {
    const many = Array.from({ length: 140 }, (_, index): AgentEvidenceCandidate => ({
      ...customer,
      id: `sql:column:customers.field_${index}`,
      qualifiedId: `sql:column:customers.field_${index}`,
      name: `field_${index}`,
      relevanceScore: 1 - index / 200,
    }));
    const runtime = createAskAgentRuntimeV2({
      mode: 'authoritative_v2',
      getEvidence: async () => ({
        ...evidence([revenue, ...many]),
        diagnostics: {
          sourceCoverage: [
            { version: 1, source: 'semantic', status: 'available', candidateIds: [revenue.id] },
            { version: 1, source: 'runtime_schema', status: 'available', candidateIds: many.map((candidate) => candidate.id) },
          ],
        },
      }),
      legacyRouter: { decide: async () => legacyDecision() },
    });
    const decision = await runtime.decide({ question: 'top customers by revenue', requestedMode: 'ask' });
    const state = decision.askAgentV2Decision!.state;
    const receipt = createAskToolKernelV2(state).diagnosticReceipt('in_progress');

    expect(receipt.contextCoverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'semantic', status: 'available', admittedCandidateCount: 1 }),
      expect.objectContaining({ source: 'runtime_schema', status: 'available' }),
    ]));
    expect(receipt.excludedCandidateCount).toBeGreaterThan(0);
    expect(receipt.exclusionReasonCodes).toEqual(['WORKSPACE_CANDIDATE_CAP']);
    expect(JSON.stringify(receipt)).not.toContain('not modeled');
  });

  it('AGT-048 uses V1 only as a shadow comparison and never serves its terminal decision', async () => {
    const legacyRouter = { decide: vi.fn(async () => legacyDecision()) };
    const runtime = createAskAgentRuntimeV2({ mode: 'shadow_v2', getEvidence: async () => evidence(), legacyRouter });
    const decision = await runtime.decide({ question: 'top customers by revenue', requestedMode: 'ask' });
    expect(legacyRouter.decide).toHaveBeenCalledOnce();
    expect(decision.terminalOutcome?.message).toBe('legacy terminal');
    expect(decision.askAgentV2Decision?.mode).toBe('shadow_v2');
  });

  it('AGT-052 enters Research only through explicit Research selection', async () => {
    const runtime = createAskAgentRuntimeV2({ mode: 'authoritative_v2', getEvidence: async () => evidence(), legacyRouter: { decide: async () => legacyDecision() } });
    const ordinary = await runtime.decide({ question: 'why did revenue change?', requestedMode: 'ask' });
    const research = await runtime.decide({ question: 'why did revenue change?', requestedMode: 'research' });
    expect(ordinary.action).toBe('answer');
    expect(research.action).toBe('investigate');
    expect(research.askAgentV2Decision?.state.turnClass).toBe('research');
  });

  it('AGT-051 preserves a selected result binding as typed prior-result context', async () => {
    const runtime = createAskAgentRuntimeV2({ mode: 'authoritative_v2', getEvidence: async () => evidence(), legacyRouter: { decide: async () => legacyDecision() } });
    const decision = await runtime.decide({
      question: 'which region does Melissa Davis belong to?',
      requestedMode: 'ask',
      selectedResultBinding: {
        version: 1,
        sourceRunId: 'run:customers', sourceArtifactId: 'answer:customers', canonicalColumn: 'customer_name',
        value: 'Melissa Davis', rowFingerprint: 'row:melissa', resultFingerprint: 'result:customers',
      },
    });
    expect(decision.askAgentV2Decision?.state.turnClass).toBe('prior_result');
    expect(decision.askAgentV2Decision?.state.conversation.selectedMemberBinding).toBe('Melissa Davis');
  });

  it('AGT-054 defaults to shadow and treats grouped measures as analytics', async () => {
    const legacyRouter = { decide: vi.fn(async () => legacyDecision()) };
    const runtime = createAskAgentRuntimeV2({ getEvidence: async () => evidence(), legacyRouter });
    const decision = await runtime.decide({ question: 'what is revenue for each customer?', requestedMode: 'ask' });
    expect(runtime.mode).toBe('shadow_v2');
    expect(legacyRouter.decide).toHaveBeenCalledOnce();
    expect(decision.askAgentV2Decision?.state.turnClass).toBe('analytics');
  });

  it('CTX-009 fails closed when an identified bridge omits or changes snapshot identity', () => {
    const state = {
      version: 4, mode: 'authoritative_v2', turnClass: 'analytics', snapshotId: 'snapshot:one', sourceFingerprint: 'sha256:source',
      retainedCandidateIds: [], initialCandidateIds: [], expansionCandidateIds: [], relationshipPathHandles: [],
      conversation: { version: 2, availableResultHandleIds: [] }, observations: [],
    } satisfies AskAgentStateV4;
    const getContextPack = () => ({});
    expect(askAgentV2WorkspaceMatches(state, { version: 2, getContextPack })).toBe(false);
    expect(askAgentV2WorkspaceMatches(state, { version: 2, snapshotId: 'snapshot:other', sourceFingerprint: 'sha256:source', getContextPack })).toBe(false);
    expect(askAgentV2WorkspaceMatches(state, { version: 2, snapshotId: 'snapshot:one', sourceFingerprint: 'sha256:other', getContextPack })).toBe(false);
    expect(askAgentV2WorkspaceMatches(state, { version: 2, snapshotId: 'snapshot:one', sourceFingerprint: 'sha256:source', getContextPack })).toBe(true);
  });
});

describe('Ask V2 tool kernel', () => {
  const state = (): AskAgentStateV4 => ({
    version: 4,
    mode: 'authoritative_v2',
    turnClass: 'analytics',
    snapshotId: 'snapshot:one',
    retainedCandidateIds: ['certified:customers', revenue.id, customer.id],
    initialCandidateIds: ['certified:customers', revenue.id, customer.id],
    expansionCandidateIds: [],
    conversation: { version: 2, availableResultHandleIds: [] },
    observations: [],
  });

  it('AGT-047 keeps multiple complete certified artifacts on inspect-then-one-run lifecycle', () => {
    const current = state();
    current.retainedCandidateIds.push('certified:customers:alternate');
    current.initialCandidateIds.push('certified:customers:alternate');
    current.tierStates = {
      certified: {
        version: 1,
        status: 'complete',
        candidateIds: ['certified:customers', 'certified:customers:alternate'],
        reasonCode: 'CERTIFIED_COMPLETE_FOR_REQUEST',
      },
    };
    const kernel = createAskToolKernelV2(current);
    expect(kernel.toolPolicy()).toMatchObject({
      allowedToolNames: ['inspect_certified_candidates'],
      terminalActionToolNames: ['inspect_certified_candidates'],
    });
    // A multi-artifact tier cannot use the direct exact capability.
    expect(kernel.canCall('run_certified', {
      candidateIds: ['certified:customers'],
      directExactCertifiedExecution: true,
    })).toEqual({
      ok: false,
      reasonCode: 'ASK_V2_TOOL_PROGRESSION_REQUIRED',
      safeNextTools: ['inspect_certified_candidates'],
    });
    kernel.observe({
      version: 1,
      tool: 'inspect_certified_candidates',
      tier: 'certified',
      outcome: 'eligible',
      reasonCode: 'CERTIFIED_COMPLETE_FOR_REQUEST',
      candidateIds: ['certified:customers', 'certified:customers:alternate'],
      origin: 'retrieval',
    });
    expect(kernel.canCall('run_certified', { candidateIds: ['certified:customers'] })).toEqual({ ok: true });
  });

  it('AGT-049 advances after a pre-freeze ineligible tier but prevents bypass of a host-complete earlier tier', () => {
    const current = state();
    current.tierStates = {
      semantic: { version: 1, status: 'available', candidateIds: [revenue.id], reasonCode: 'SEMANTIC_CANDIDATES_AVAILABLE' },
    };
    const kernel = createAskToolKernelV2(current);
    kernel.observe({ version: 1, tool: 'inspect_ask_context', outcome: 'eligible', reasonCode: 'initial_snapshot_context', candidateIds: current.initialCandidateIds, origin: 'retrieval' });
    kernel.observe({ version: 1, tool: 'inspect_semantic_candidates', tier: 'semantic', outcome: 'eligible', reasonCode: 'SEMANTIC_CANDIDATES_AVAILABLE', candidateIds: [revenue.id], origin: 'retrieval' });
    kernel.observe({ version: 1, tool: 'inspect_certified_candidates', tier: 'certified', outcome: 'eligible', reasonCode: 'CERTIFIED_CANDIDATES_AVAILABLE', candidateIds: ['certified:customers'], origin: 'retrieval' });
    kernel.observe({ version: 1, tool: 'run_certified', tier: 'certified', outcome: 'ineligible', reasonCode: 'tuple_incomplete', candidateIds: ['certified:customers'] });
    expect(kernel.canCall('compile_and_run_semantic')).toEqual({ ok: true });
    // A provider-visible card count cannot make a tier complete. The host
    // supplies that tuple truth after its own compatibility check.
    current.tierStates = {
      semantic: {
        version: 1,
        status: 'complete',
        candidateIds: [revenue.id],
        reasonCode: 'SEMANTIC_COMPLETE_FOR_REQUEST',
      },
    };
    expect(kernel.canCall('validate_and_run_sql')).toEqual({
      ok: false,
      reasonCode: 'EARLIER_COMPLETE_TIER_REQUIRED',
      safeNextTools: ['compile_and_run_semantic'],
    });
    expect(kernel.state.resolvedPlan).toBeUndefined();
  });

  it('lets the describe tools be called again with different arguments, up to their ceiling', () => {
    // The parameterless inspectors are fixed by the snapshot, so repeating one
    // reveals nothing. describe_relation is not one of those: each call names a
    // different relation or column search. Refusing the second call made the
    // analyst describe one 436-column mart, fail to find its column, and give
    // up — with the only tool that could have corrected it now closed.
    const kernel = createAskToolKernelV2(state());
    for (let call = 0; call < ASK_V2_DESCRIBE_CALLS_PER_TOOL; call += 1) {
      expect(kernel.canCall('describe_relation').ok, `call ${call + 1}`).toBe(true);
      kernel.observe({
        version: 1,
        tool: 'describe_relation',
        outcome: 'eligible',
        reasonCode: 'RELATION_DESCRIBED',
        candidateIds: [customer.id],
        origin: 'retrieval',
      });
    }
    expect(kernel.canCall('describe_relation')).toMatchObject({ ok: false, reasonCode: 'ASK_V2_REDUNDANT_INSPECTION' });
    // A parameterless inspector still gets exactly one call.
    kernel.observe({
      version: 1,
      tool: 'inspect_conversation_result',
      outcome: 'eligible',
      reasonCode: 'trusted_conversation_context',
      candidateIds: [],
      origin: 'retrieval',
    });
    expect(kernel.canCall('inspect_conversation_result')).toMatchObject({ ok: false, reasonCode: 'ASK_V2_REDUNDANT_INSPECTION' });
  });

  it('lets a frozen plan that could not run descend once to review-required SQL, and only once', () => {
    // A freeze must stop the analyst from trading up to a better-looking route
    // after seeing a result. It must not strand a turn whose frozen program
    // will not compile at all: on a 3,373-model warehouse that turn spent every
    // remaining dispatch on guaranteed denials and answered nothing. Exploratory
    // SQL is the LOWEST tier and its answers are labelled review-required, so
    // descending to it cannot launder trust — which is why it is the one route
    // change a freeze allows.
    const kernel = createAskToolKernelV2(state());
    kernel.observe({
      version: 1,
      tool: 'compile_and_run_dql',
      tier: 'governed_relational',
      outcome: 'eligible',
      reasonCode: 'ASK_V2_EXECUTION_AUTHORIZED',
      candidateIds: [customer.id],
      planId: 'ask-v2:governed:test',
      inputFingerprint: 'sha256:frozen-governed-plan',
      executionAuthorized: true,
    });
    expect(kernel.state.resolvedPlan).toMatchObject({ frozen: true, tier: 'governed_relational' });

    // Before the frozen tier has failed, the route is still closed.
    expect(kernel.canCall('validate_and_run_sql', { candidateIds: [customer.id] }))
      .toEqual({ ok: false, reasonCode: 'POST_FREEZE_ROUTE_CHANGE_DENIED' });

    kernel.observe({
      version: 1,
      tool: 'compile_and_run_dql',
      tier: 'governed_relational',
      outcome: 'error',
      reasonCode: 'GOVERNED_RELATIONAL_EXECUTION_FAILED',
      candidateIds: [customer.id],
      planId: 'ask-v2:governed:test',
      origin: 'validation',
    });

    // Now the descent is available, and the policy names it rather than
    // leaving the analyst to discover it by guessing.
    expect(kernel.canCall('validate_and_run_sql', { candidateIds: [customer.id] })).toEqual({ ok: true });
    const policy = kernel.toolPolicy();
    expect(policy.allowedToolNames).toContain('validate_and_run_sql');
    expect(policy.instruction).toContain('review-required SQL');

    // Moving UP after the same failure stays denied: only the lowest tier is
    // reachable, and only downward.
    expect(kernel.canCall('compile_and_run_semantic', { candidateIds: [revenue.id] }))
      .toEqual({ ok: false, reasonCode: 'POST_FREEZE_ROUTE_CHANGE_DENIED' });

    // One descent only. Once exploratory SQL has been authorized, a second
    // route change is refused however that attempt failed.
    kernel.observe({
      version: 1,
      tool: 'validate_and_run_sql',
      tier: 'exploratory_sql',
      outcome: 'eligible',
      reasonCode: 'EXPLORATORY_EXECUTION_AUTHORIZED',
      candidateIds: [customer.id],
      planId: 'ask-v2:exploratory:descent',
      inputFingerprint: 'sha256:descent',
      executionAuthorized: true,
    });
    kernel.observe({
      version: 1,
      tool: 'validate_and_run_sql',
      tier: 'exploratory_sql',
      outcome: 'error',
      reasonCode: 'EXPLORATORY_EXECUTION_FAILED',
      candidateIds: [customer.id],
      planId: 'ask-v2:exploratory:descent',
      origin: 'execution',
    });
    expect(kernel.canCall('compile_and_run_dql', { candidateIds: [customer.id] }).ok).toBe(false);
  });

  it('AGT-050 freezes at host execution authorization: cross-tier replacement and mutation are denied, with exactly one same-plan repair after terminal execution failure', () => {
    const kernel = createAskToolKernelV2(state());
    const bindingFingerprint = 'sha256:frozen-exploratory-plan';
    // This is the host authorization/capability-minting boundary. It happens
    // before a compiler or connection is called and therefore persists the
    // immutable plan even if execution immediately fails.
    kernel.observe({
      version: 1,
      tool: 'validate_and_run_sql',
      tier: 'exploratory_sql',
      outcome: 'eligible',
      reasonCode: 'EXPLORATORY_EXECUTION_AUTHORIZED',
      candidateIds: [customer.id],
      planId: 'ask-v2:exploratory:test',
      inputFingerprint: bindingFingerprint,
      outputFingerprint: 'sha256:targets',
      executionAuthorized: true,
    });
    expect(kernel.state.resolvedPlan).toMatchObject({
      frozen: true,
      tier: 'exploratory_sql',
      candidateIds: [customer.id],
      bindingFingerprint,
    });

    // Neither a semantic re-route nor a changed selected target can use a
    // post-freeze compiler/executor path.
    expect(kernel.canCall('compile_and_run_semantic')).toEqual({ ok: false, reasonCode: 'POST_FREEZE_ROUTE_CHANGE_DENIED' });
    expect(kernel.canCall('validate_and_run_sql', {
      repair: true,
      candidateIds: [revenue.id],
      bindingFingerprint,
    })).toEqual({ ok: false, reasonCode: 'POST_FREEZE_PLAN_MUTATION_DENIED' });

    // A physical compiler/connection/execution error leaves the authorization
    // frozen. The one same-plan repair remains the only continuation.
    kernel.observe({
      version: 1,
      tool: 'validate_and_run_sql',
      tier: 'exploratory_sql',
      outcome: 'error',
      reasonCode: 'WAREHOUSE_CONNECTION_FAILED',
      candidateIds: [customer.id],
      planId: 'ask-v2:exploratory:test',
      inputFingerprint: bindingFingerprint,
      origin: 'execution',
    });
    expect(kernel.state.resolvedPlan?.frozen).toBe(true);
    expect(kernel.canCall('compile_and_run_dql')).toEqual({ ok: false, reasonCode: 'POST_FREEZE_ROUTE_CHANGE_DENIED' });
    expect(kernel.canCall('validate_and_run_sql', {
      repair: true,
      candidateIds: [customer.id],
      bindingFingerprint,
    })).toEqual({ ok: true });

    kernel.observe({
      version: 1,
      tool: 'validate_and_run_sql',
      tier: 'exploratory_sql',
      outcome: 'eligible',
      reasonCode: 'EXPLORATORY_SAME_PLAN_REPAIR_AUTHORIZED',
      candidateIds: [customer.id],
      planId: 'ask-v2:exploratory:test',
      inputFingerprint: bindingFingerprint,
      executionAuthorized: true,
      samePlanRepair: true,
    });
    kernel.observe({
      version: 1,
      tool: 'validate_and_run_sql',
      tier: 'exploratory_sql',
      outcome: 'error',
      reasonCode: 'WAREHOUSE_EXECUTION_FAILED',
      candidateIds: [customer.id],
      planId: 'ask-v2:exploratory:test',
      inputFingerprint: bindingFingerprint,
      origin: 'execution',
    });
    expect(kernel.canCall('validate_and_run_sql', {
      repair: true,
      candidateIds: [customer.id],
      bindingFingerprint,
    })).toEqual({ ok: false, reasonCode: 'ASK_REPAIR_BUDGET_EXHAUSTED' });
    expect(kernel.canCall('compile_and_run_semantic')).toEqual({ ok: false, reasonCode: 'POST_FREEZE_ROUTE_CHANGE_DENIED' });
  });

  it('AGT-049 gives a lower-tier SQL call the exact host-owned certified next step even after all inspections', () => {
    const current = state();
    current.tierStates = {
      certified: {
        version: 1,
        status: 'complete',
        candidateIds: ['certified:customers'],
        reasonCode: 'CERTIFIED_COMPLETE_FOR_REQUEST',
        safeNextTools: ['run_certified'],
      },
      semantic: { version: 1, status: 'available', candidateIds: [revenue.id], reasonCode: 'SEMANTIC_AVAILABLE' },
      governed_relational: { version: 1, status: 'available', candidateIds: [customer.id], reasonCode: 'RELATIONAL_AVAILABLE' },
    };
    const kernel = createAskToolKernelV2(current);
    kernel.observe({ version: 1, tool: 'inspect_certified_candidates', outcome: 'eligible', tier: 'certified', reasonCode: 'CERTIFIED_COMPLETE_FOR_REQUEST', candidateIds: ['certified:customers'] });
    kernel.observe({ version: 1, tool: 'inspect_semantic_candidates', outcome: 'eligible', tier: 'semantic', reasonCode: 'SEMANTIC_AVAILABLE', candidateIds: [revenue.id] });
    kernel.observe({ version: 1, tool: 'inspect_relational_context', outcome: 'eligible', tier: 'governed_relational', reasonCode: 'RELATIONAL_AVAILABLE', candidateIds: [customer.id] });
    expect(kernel.canCall('validate_and_run_sql')).toEqual({
      ok: false,
      reasonCode: 'EARLIER_COMPLETE_TIER_REQUIRED',
      safeNextTools: ['run_certified'],
    });
  });

  it('AGT-049 allows a real fallback after host states say earlier tiers are unavailable or ineligible', () => {
    const current = state();
    current.tierStates = {
      certified: { version: 1, status: 'unavailable', candidateIds: [], reasonCode: 'CERTIFIED_EMPTY' },
      semantic: { version: 1, status: 'ineligible', candidateIds: [revenue.id], reasonCode: 'SEMANTIC_INCOMPATIBLE' },
      governed_relational: { version: 1, status: 'unavailable', candidateIds: [], reasonCode: 'RELATIONAL_EMPTY' },
    };
    const kernel = createAskToolKernelV2(current);
    kernel.observe({ version: 1, tool: 'inspect_ask_context', outcome: 'eligible', reasonCode: 'initial_snapshot_context', candidateIds: current.initialCandidateIds, origin: 'retrieval' });
    kernel.observe({ version: 1, tool: 'inspect_certified_candidates', outcome: 'unavailable', tier: 'certified', reasonCode: 'CERTIFIED_EMPTY', candidateIds: [] });
    kernel.observe({ version: 1, tool: 'inspect_semantic_candidates', outcome: 'ineligible', tier: 'semantic', reasonCode: 'SEMANTIC_INCOMPATIBLE', candidateIds: [revenue.id] });
    kernel.observe({ version: 1, tool: 'inspect_relational_context', outcome: 'unavailable', tier: 'governed_relational', reasonCode: 'RELATIONAL_EMPTY', candidateIds: [] });
    expect(kernel.canCall('validate_and_run_sql')).toEqual({ ok: true });
  });

  it('AGT-047 records the latest semantic execution target after its pre-freeze failure', () => {
    const current = state();
    current.tierStates = {
      certified: { version: 1, status: 'unavailable', candidateIds: [], reasonCode: 'CERTIFIED_EMPTY' },
      semantic: { version: 1, status: 'unavailable', candidateIds: [revenue.id], reasonCode: 'SEMANTIC_EXECUTION_UNAVAILABLE' },
      governed_relational: { version: 1, status: 'unavailable', candidateIds: [], reasonCode: 'GOVERNED_RELATIONAL_EXECUTION_UNAVAILABLE' },
    };
    const kernel = createAskToolKernelV2(current);
    kernel.observe({ version: 1, tool: 'inspect_certified_candidates', outcome: 'unavailable', tier: 'certified', reasonCode: 'CERTIFIED_EMPTY', candidateIds: [] });
    kernel.observe({ version: 1, tool: 'inspect_semantic_candidates', outcome: 'eligible', tier: 'semantic', reasonCode: 'SEMANTIC_CANDIDATES_AVAILABLE', candidateIds: [revenue.id] });
    kernel.observe({ version: 1, tool: 'compile_and_run_semantic', outcome: 'unavailable', tier: 'semantic', reasonCode: 'SEMANTIC_EXECUTION_UNAVAILABLE', candidateIds: [revenue.id], origin: 'validation' });
    kernel.observe({ version: 1, tool: 'inspect_relational_context', outcome: 'unavailable', tier: 'governed_relational', reasonCode: 'GOVERNED_RELATIONAL_EXECUTION_UNAVAILABLE', candidateIds: [] });

    // The next policy action may be exploratory SQL, but no SQL tool ran.
    // The receipt must describe the actual semantic compiler attempt that
    // caused this terminal state instead of mislabeling it as a later tier.
    expect(kernel.diagnosticReceipt()).toMatchObject({ controllerTier: 'semantic', planFrozen: false });
  });

  it('AGT-047 receipts the host-selected semantic runtime without making it a controller binding', () => {
    const current = state();
    current.semanticRuntime = {
      version: 1,
      preference: 'metricflow-cli',
      selectedEngine: 'metricflow-cli',
      readiness: 'ready',
    };
    const kernel = createAskToolKernelV2(current);

    expect(kernel.diagnosticReceipt()).toMatchObject({
      semanticRuntime: {
        preference: 'metricflow-cli',
        selectedEngine: 'metricflow-cli',
        readiness: 'ready',
      },
    });
  });

  it('AGT-047 narrows repeated semantic discovery to the next LLM-controlled semantic execution', () => {
    const current = state();
    current.tierStates = {
      certified: { version: 1, status: 'available', candidateIds: ['certified:customers'], reasonCode: 'CERTIFIED_CANDIDATES_AVAILABLE' },
      semantic: { version: 1, status: 'available', candidateIds: [revenue.id], reasonCode: 'SEMANTIC_CANDIDATES_AVAILABLE' },
    };
    const kernel = createAskToolKernelV2(current);

    kernel.observe({
      version: 1,
      tool: 'inspect_ask_context',
      outcome: 'eligible',
      reasonCode: 'initial_snapshot_context',
      candidateIds: current.initialCandidateIds,
      origin: 'retrieval',
    });

    kernel.observe({
      version: 1,
      tool: 'inspect_semantic_candidates',
      tier: 'semantic',
      outcome: 'eligible',
      reasonCode: 'SEMANTIC_CANDIDATES_AVAILABLE',
      candidateIds: [revenue.id],
      origin: 'retrieval',
    });
    expect(kernel.toolPolicy()).toMatchObject({
      allowedToolNames: ['inspect_certified_candidates'],
    });
    expect(kernel.canCall('inspect_business_context')).toEqual({
      ok: false,
      reasonCode: 'ASK_V2_TOOL_PROGRESSION_REQUIRED',
      safeNextTools: ['inspect_certified_candidates'],
    });

    kernel.observe({
      version: 1,
      tool: 'inspect_certified_candidates',
      tier: 'certified',
      outcome: 'eligible',
      reasonCode: 'CERTIFIED_CANDIDATES_AVAILABLE',
      candidateIds: ['certified:customers'],
      origin: 'retrieval',
    });
    expect(kernel.toolPolicy()).toMatchObject({
      allowedToolNames: ['compile_and_run_semantic'],
      terminalActionToolNames: ['compile_and_run_semantic'],
    });
    expect(kernel.canCall('inspect_relational_context')).toEqual({
      ok: false,
      reasonCode: 'ASK_V2_TOOL_PROGRESSION_REQUIRED',
      safeNextTools: ['compile_and_run_semantic'],
    });
    expect(kernel.canCall('compile_and_run_semantic')).toEqual({ ok: true });
  });

  it('AGT-047 commits one host-executable inspected tier to its execution tool without charging an off-route inspector', () => {
    const current = state();
    current.controllerTier = 'semantic';
    current.tierStates = {
      semantic: { version: 1, status: 'available', candidateIds: [revenue.id], reasonCode: 'SEMANTIC_CANDIDATES_AVAILABLE' },
    };
    const kernel = createAskToolKernelV2(current);

    kernel.observe({
      version: 1,
      tool: 'inspect_semantic_candidates',
      tier: 'semantic',
      outcome: 'eligible',
      reasonCode: 'SEMANTIC_CANDIDATES_AVAILABLE',
      candidateIds: [revenue.id],
      origin: 'retrieval',
    });
    expect(kernel.toolPolicy()).toMatchObject({
      allowedToolNames: ['compile_and_run_semantic'],
      terminalActionToolNames: ['compile_and_run_semantic'],
    });
    expect(kernel.canCall('inspect_certified_candidates')).toEqual({
      ok: false,
      reasonCode: 'ASK_V2_TOOL_PROGRESSION_REQUIRED',
      safeNextTools: ['compile_and_run_semantic'],
    });
    const before = kernel.diagnosticReceipt().activity.toolCalls;
    kernel.observe({
      version: 1,
      tool: 'inspect_certified_candidates',
      outcome: 'denied',
      reasonCode: 'ASK_V2_TOOL_PROGRESSION_REQUIRED',
      candidateIds: [],
      origin: 'validation',
    });
    expect(kernel.diagnosticReceipt().activity.toolCalls).toBe(before);
    expect(kernel.canCall('compile_and_run_semantic')).toEqual({ ok: true });
  });

  it.each([
    ['certified', 'run_certified'],
    ['semantic', 'compile_and_run_semantic'],
    ['governed_relational', 'compile_and_run_dql'],
    ['exploratory_sql', 'validate_and_run_sql'],
  ] as const)('AGT-047 exposes only the committed %s execution tool', (tier, tool) => {
    const current = state();
    current.controllerTier = tier;
    current.tierStates = {
      [tier]: { version: 1, status: 'available', candidateIds: [revenue.id], reasonCode: 'HOST_EXECUTABLE_TIER_AVAILABLE' },
    };
    const kernel = createAskToolKernelV2(current);
    expect(kernel.toolPolicy()).toMatchObject({
      allowedToolNames: [tool],
      terminalActionToolNames: [tool],
    });
  });

  it('AGT-047 requires the host evidence-bound finish control after business context is inspected', () => {
    const current = state();
    current.turnClass = 'business_context';
    const kernel = createAskToolKernelV2(current);

    kernel.observe({
      version: 1,
      tool: 'inspect_business_context',
      outcome: 'eligible',
      reasonCode: 'business_context_inspected',
      candidateIds: ['context:revenue-definition'],
      origin: 'retrieval',
    });

    expect(kernel.toolPolicy()).toMatchObject({
      allowedToolNames: ['finish_answer'],
      terminalActionToolNames: ['finish_answer'],
    });
    expect(kernel.canCall('finish_answer')).toEqual({ ok: true });
  });

  it('AGT-047 rejects immutable inspection loops and exposes the admitted relationship closure as an LLM-selected execution choice', () => {
    const current = state();
    current.relationshipPathHandles = [{
      version: 1,
      id: 'path:orders-customers',
      edgeIds: ['edge:orders.customer_id', 'edge:customers.customer_id'],
      candidateIds: [customer.id],
      snapshotId: current.snapshotId,
    }];
    current.tierStates = {
      certified: { version: 1, status: 'available', candidateIds: ['certified:customers'], reasonCode: 'CERTIFIED_CANDIDATES_AVAILABLE' },
      semantic: { version: 1, status: 'available', candidateIds: [revenue.id], reasonCode: 'SEMANTIC_CANDIDATES_AVAILABLE' },
      governed_relational: { version: 1, status: 'available', candidateIds: [customer.id], reasonCode: 'RELATIONSHIP_PATH_AVAILABLE' },
    };
    const kernel = createAskToolKernelV2(current);
    kernel.observe({
      version: 1,
      tool: 'inspect_ask_context',
      outcome: 'eligible',
      reasonCode: 'initial_snapshot_context',
      candidateIds: current.initialCandidateIds,
      origin: 'retrieval',
    });

    expect(kernel.canCall('inspect_business_context')).toMatchObject({
      ok: false,
      reasonCode: 'ASK_V2_TOOL_PROGRESSION_REQUIRED',
    });
    kernel.observe({ version: 1, tool: 'inspect_semantic_candidates', outcome: 'eligible', tier: 'semantic', reasonCode: 'SEMANTIC_CANDIDATES_AVAILABLE', candidateIds: [revenue.id], origin: 'retrieval' });
    kernel.observe({ version: 1, tool: 'inspect_certified_candidates', outcome: 'eligible', tier: 'certified', reasonCode: 'CERTIFIED_CANDIDATES_AVAILABLE', candidateIds: ['certified:customers'], origin: 'retrieval' });

    expect(kernel.toolPolicy()).toMatchObject({
      terminalActionToolNames: ['compile_and_run_semantic', 'compile_and_run_dql', 'validate_and_run_sql'],
    });
    expect(kernel.canCall('inspect_ask_context')).toMatchObject({
      ok: false,
      reasonCode: 'ASK_V2_REDUNDANT_INSPECTION',
      safeNextTools: ['compile_and_run_semantic', 'compile_and_run_dql', 'validate_and_run_sql'],
    });
    const toolCallsBefore = kernel.diagnosticReceipt().activity.toolCalls;
    kernel.observe({ version: 1, tool: 'inspect_ask_context', outcome: 'ineligible', reasonCode: 'ASK_V2_REDUNDANT_INSPECTION', candidateIds: [], origin: 'validation' });
    expect(kernel.diagnosticReceipt().activity.toolCalls).toBe(toolCallsBefore);
    expect(kernel.canCall('compile_and_run_dql')).toEqual({ ok: true });
  });

  it('AGT-047 keeps host-only semantic time completion out of live and reloaded tool budgets', () => {
    const live = state();
    const liveKernel = createAskToolKernelV2(live);
    liveKernel.observe({
      version: 1,
      tool: 'inspect_semantic_candidates',
      tier: 'semantic',
      outcome: 'eligible',
      reasonCode: 'SEMANTIC_CANDIDATES_AVAILABLE',
      candidateIds: [revenue.id],
      origin: 'retrieval',
    });
    liveKernel.observe({
      version: 1,
      tool: 'compile_and_run_semantic',
      tier: 'semantic',
      outcome: 'eligible',
      reasonCode: 'SEMANTIC_TIME_BINDING_COMPLETED',
      candidateIds: [revenue.id],
      origin: 'validation',
      inputFingerprint: 'sha256:before-time-binding',
      outputFingerprint: 'sha256:after-time-binding',
    });
    const liveToolCalls = liveKernel.diagnosticReceipt().activity.toolCalls;
    expect(liveToolCalls).toBe(1);

    // Receipts cross process boundaries as JSON. A fresh kernel must derive
    // the exact same physical tool count rather than charging its durable
    // host-only completion as a second provider action.
    const reloaded: AskAgentStateV4 = {
      ...live,
      retainedCandidateIds: [...live.retainedCandidateIds],
      initialCandidateIds: [...live.initialCandidateIds],
      expansionCandidateIds: [...live.expansionCandidateIds],
      relationshipPathHandles: [...(live.relationshipPathHandles ?? [])],
      conversation: { ...live.conversation, availableResultHandleIds: [...live.conversation.availableResultHandleIds] },
      observations: live.observations.map((observation) => ({ ...observation, candidateIds: [...observation.candidateIds] })),
    };
    expect(createAskToolKernelV2(reloaded).diagnosticReceipt().activity.toolCalls).toBe(liveToolCalls);
  });

  it('API-017 retains bounded provider egress and exposes no recursive Ask tool', () => {
    expect(ASK_V2_CANONICAL_TOOLS).not.toContain('ask_dql' as never);
    expect(ASK_V2_CANONICAL_TOOLS).not.toContain('answer_question' as never);
    expect(defaultProviderResultEgressPolicyV2({ transport: 'remote' })).toMatchObject({ allowRows: false, maximumCells: 400 });
    expect(defaultProviderResultEgressPolicyV2({ transport: 'local' })).toMatchObject({ allowRows: true, maximumRows: 20, maximumColumns: 20 });
  });

  it('AGT-052 projects mixed Research evidence into V4 without reusing lineage as an analytical result', () => {
    const ledgerV4 = projectResearchEvidenceLedgerV4({
      version: 3,
      rootQuestionFingerprint: 'sha256:research',
      snapshotId: 'snapshot:research',
      entries: [
        {
          version: 3,
          id: 'branch:revenue',
          branchId: 'branch:revenue',
          evidenceKind: 'analytical_result',
          status: 'observed',
          verdict: 'inconclusive',
          factIds: ['fact:revenue:1'],
          counterEvidenceFactIds: [],
          receiptFingerprints: ['result:revenue'],
        },
        {
          version: 3,
          id: 'branch:lineage',
          branchId: 'branch:lineage',
          evidenceKind: 'lineage_graph',
          status: 'observed',
          verdict: 'inconclusive',
          factIds: ['fact:lineage:1'],
          counterEvidenceFactIds: [],
          receiptFingerprints: ['lineage:structural'],
          lineageReceipt: {} as never,
        },
      ],
      factIds: ['fact:revenue:1', 'fact:lineage:1'],
      groundableBranchCount: 3,
      limitedScope: false,
      stoppingReason: 'completed',
    });

    expect(ledgerV4).toMatchObject({ version: 4, limitedScope: false });
    expect(ledgerV4.branches).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'branch:revenue', lineageProgram: 'not_run', evidenceHandleIds: ['fact:revenue:1', 'result:revenue'] }),
      expect.objectContaining({ id: 'branch:lineage', lineageProgram: 'dedicated', evidenceHandleIds: ['fact:lineage:1', 'lineage:structural'] }),
    ]));
  });
});
