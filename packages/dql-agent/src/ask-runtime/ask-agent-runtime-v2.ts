/**
 * Ask Agent Runtime V2
 *
 * V1 made a deterministic interpretation/coverage check the authority for a
 * natural-language Ask.  That is safe, but it is the wrong authority for an
 * open-ended business question: an incomplete certified or semantic candidate
 * is an observation for the agent, not proof that a safe generated route does
 * not exist.  V2 keeps the existing execution guards and moves only business
 * interpretation and route progression behind one bounded tool kernel.
 *
 * This module is intentionally host-neutral.  The CLI adapts its existing
 * answer-loop, MetricFlow and analyst-loop tools to this contract; no provider
 * payload, SQL, result row, credential, file path, or hidden reasoning is
 * persisted here.
 */

import { createHash } from 'node:crypto';
import { classifyConversationalTurn, type IntentDecision } from '../intent-controller.js';
import type { AgentRouter, AgentRunRequest } from '../agent-run-engine.js';
import { buildAnalyticalRequirementSet, evidenceCandidateRoles, selectRoleBalancedMeaningCandidates } from '../analytical-orchestration.js';
import type { EvidenceCandidateRoleV1 } from '../analytical-orchestration.js';
import type { ContextSourceCoverageV1, ResearchEvidenceLedgerV3 } from '../analytical-orchestration.js';
import type { AgentEvidenceCandidate, AgentRetrievalEvidence } from '../meaning-resolution.js';

/** Explicit operator rollout control.  Browser/MCP request bodies never set it. */
export type AskRuntimeModeV2 = 'legacy_v1' | 'shadow_v2' | 'authoritative_v2';

/** V2 has one turn owner; classification is an LLM/tool-runtime responsibility. */
export type AskTurnClassV2 =
  | 'analytics'
  | 'definition'
  | 'business_context'
  | 'prior_result'
  | 'general'
  | 'clarification_response'
  | 'research';

export type AskToolNameV2 =
  | 'inspect_ask_context'
  | 'inspect_conversation_result'
  | 'inspect_business_context'
  | 'inspect_certified_candidates'
  | 'run_certified'
  | 'inspect_semantic_candidates'
  | 'compile_and_run_semantic'
  | 'describe_metric'
  | 'inspect_relational_context'
  | 'describe_relation'
  | 'compile_and_run_dql'
  | 'validate_and_run_sql'
  | 'search_values'
  | 'request_clarification'
  | 'finish_answer';

export const ASK_V2_CANONICAL_TOOLS: readonly AskToolNameV2[] = [
  'inspect_ask_context',
  'inspect_conversation_result',
  'inspect_business_context',
  'inspect_certified_candidates',
  'run_certified',
  'inspect_semantic_candidates',
  'compile_and_run_semantic',
  'describe_metric',
  'inspect_relational_context',
  'describe_relation',
  'compile_and_run_dql',
  'validate_and_run_sql',
  'search_values',
  'request_clarification',
  'finish_answer',
];

/** Opaque proof that a candidate belongs to this immutable retrieval snapshot. */
export interface AskEvidenceHandleV1 {
  version: 1;
  id: string;
  role: EvidenceCandidateRoleV1;
  source: 'certified' | 'semantic' | 'governed_relational' | 'dbt_manifest' | 'runtime_schema' | 'vector' | 'conversation' | 'business';
  snapshotId?: string;
}

/**
 * A relationship path is atomic evidence.  A planner may select a handle, but
 * it must never splice together edges from separate paths or mint a new join
 * from their display names.  The host keeps the physical edge payload in its
 * request-scoped workspace; this persisted projection deliberately contains
 * identities only.
 */
export interface AskRelationshipPathHandleV1 {
  version: 1;
  id: string;
  edgeIds: string[];
  /**
   * Snapshot-qualified relation/column cards covered by this exact path. The
   * model may choose the path handle, but it cannot splice a new join from
   * labels or cards that were not admitted with the path.
   */
  candidateIds?: string[];
  snapshotId?: string;
}

/**
 * A certified artifact is captured while the retrieval lease is current.  The
 * executable payload stays server-only, but its revision proof is part of the
 * request-scoped capability and is checked again immediately before freeze.
 * It deliberately has no JSON representation.
 */
export interface AskCertifiedArtifactHandleV1 {
  version: 1;
  artifact: unknown;
  revisionFingerprint: string;
  /** Host-owned recheck against the same local project/snapshot. */
  isCurrent(): boolean;
}

/**
 * Canonical semantic compiler identifiers which an Ask V2 host may advertise
 * for one immutable semantic capability.  These are deliberately adapter
 * identifiers, not candidate IDs, display labels, MetricFlow field names, or
 * provider-authored aliases.
 */
export type AskSemanticEngineV1 = 'native' | 'metricflow-cli' | 'dbt-cloud';

/**
 * Redacted, host-owned semantic runtime selection for one immutable Ask
 * workspace.  The controller never chooses this value: it is resolved from
 * the project's configured preference and target-bound adapter readiness
 * before a semantic capability is offered as executable.
 *
 * `selectedEngine` is optional for backwards-readable receipts/workspaces
 * created before this additive contract.  New hosts set it only when the
 * selected project runtime is actually available for the candidate.
 */
export interface AskSemanticRuntimeSelectionV1 {
  version: 1;
  preference: 'auto' | AskSemanticEngineV1;
  selectedEngine?: AskSemanticEngineV1;
  readiness: 'ready' | 'unavailable';
}

/**
 * Host-captured semantic capability. The provider sees the opaque candidate
 * ID and safe card only; immediately before compilation the runtime resolves
 * that ID through this immutable mapping to the adapter's authored name.
 */
export interface AskSemanticCapabilityHandleV1 {
  version: 1;
  candidateId: string;
  runtimeName: string;
  /**
   * Host-observed ready engines for this exact captured capability. This is
   * retained for diagnostics/backwards readers; it is never model-facing
   * routing input.
   */
  engines: readonly AskSemanticEngineV1[];
  /**
   * The one project-selected, target-bound engine for this capability. The
   * V2 compiler uses this server-owned value exclusively. A missing value
   * means semantic execution is unavailable before freeze.
   */
  selectedEngine?: AskSemanticEngineV1;
  roles: Array<'metric' | 'dimension' | 'time_dimension' | 'filter_dimension'>;
  /**
   * Stable fingerprint of the complete compiler-authority projection of the
   * retained candidate. The host and provider both recompute this before an
   * opaque ID is resolved, so two cards with the same ID cannot silently bind
   * different MetricFlow/dbt time, dimension, or model contracts.
   */
  fingerprint: string;
  isCurrent(): boolean;
}

/**
 * Server-only execution handle for a Research child whose analytical tuple was
 * already frozen by the root snapshot.  It deliberately carries neither SQL
 * nor a provider prompt: the host callback executes the exact pre-authorized
 * certified/semantic capability and returns its own V2 state/receipt.  A
 * provider may select only a handle the workspace advertised; it cannot mint
 * one, alter its bindings, or cause a second planning dispatch.
 */
export interface AskFrozenResearchChildHandleV1 {
  version: 1;
  id: string;
  snapshotId: string;
  sourceFingerprint: string;
  tier: Extract<AskExecutionTierV2, 'certified' | 'semantic'>;
  candidateIds: string[];
  /**
   * The host-frozen execution binding. This is intentionally an opaque,
   * content-free receipt rather than a provider-authored plan: parameters,
   * trust, and the artifact/capability fingerprint were fixed before the root
   * Research planner saw this child ID.
   */
  binding: {
    version: 1;
    parameters: Record<string, string | number | boolean | null>;
    trustState: 'certified' | 'governed';
    planFingerprint: string;
    /** Present for a certified artifact frozen from its captured source. */
    artifactRevisionFingerprint?: string;
    /** Present for one or more immutable semantic compiler capabilities. */
    capabilityFingerprints?: string[];
  };
  /** Re-check captured artifact/capability freshness immediately before use. */
  isCurrent(): boolean;
  /** The active root is supplied by the V2 handler, never captured from a pre-router request. */
  execute(root: AskAgentStateV4): Promise<{
    state: AskAgentStateV4;
    /** AgentAnswer stays in the CLI adapter; this host bridge remains neutral. */
    answer: unknown;
  }>;
}

/**
 * The host, not a provider inspection flag, owns whether a tier can already
 * satisfy the full requested tuple.  `available` is useful retrieval context;
 * only `complete` blocks a lower-tier execution before a plan is frozen.
 */
export interface AskTierStateV1 {
  version: 1;
  status: 'complete' | 'available' | 'unavailable' | 'ineligible' | 'ambiguous';
  candidateIds: string[];
  /** Atomic path handles selected for a governed relational execution. */
  relationshipPathIds?: string[];
  reasonCode: string;
  safeNextTools?: AskToolNameV2[];
  /**
   * Host-issued, stable choices for a material ambiguity. A provider may only
   * reference these opaque IDs; it cannot manufacture alternatives or labels.
   * Distinct result fingerprints prove that choosing an option changes the
   * answer rather than merely restating the same business meaning.
   */
  clarificationChoices?: AskClarificationChoiceV1[];
}

export interface AskClarificationChoiceV1 {
  version: 1;
  id: string;
  label: string;
  candidateIds: string[];
  resultFingerprint: string;
}

/**
 * Ephemeral host bridge between retrieval and the provider/tool adapter.
 *
 * This is intentionally a function-bearing, server-only value: JSON ingress
 * cannot hydrate it, it is never persisted, and the raw context pack remains
 * inside the local runtime.  Its stable handle fields allow the adapter to
 * reject a stale pack before it exposes any metadata to a provider.
 */
export interface AskAgentRuntimeWorkspaceBridgeV2 {
  version: 2;
  snapshotId?: string;
  sourceFingerprint?: string;
  /**
   * Host-owned execution readiness for the captured certified artifacts.
   *
   * Presence in a context pack is never execution authority. The local host
   * supplies this only when it can invoke its snapshot-bound certified
   * executor for this request; omitted bridges fail closed for the engine's
   * zero-provider shortcut. The provider adapter additionally verifies its
   * own execution callback before exposing Tier 1 as complete.
   */
  isCertifiedExecutionAvailable?(): boolean;
  /** Optional so a persisted V4 receipt written before this additive field remains readable. */
  relationshipPathHandles?: AskRelationshipPathHandleV1[];
  getContextPack(): unknown;
  /**
   * Server-only snapshot workspace for the V2 tool adapter.  Unlike the
   * context-pack accessor this is an explicit, bounded projection: it carries
   * the exact admitted cards and any immutable executable artifacts captured
   * during retrieval.  A tool adapter must never replace it with a KG search.
   */
  getToolWorkspace?(): AskAgentToolWorkspaceV2 | undefined;
}

/**
 * Ephemeral, immutable-at-request workspace consumed by canonical V2 tools.
 * The host may retain executable artifacts and physical path facts here, but
 * this value is neither JSON ingress nor a persisted receipt.  Provider-facing
 * code must project only safe cards from it.
 */
export interface AskAgentToolWorkspaceV2 {
  version: 1;
  snapshotId?: string;
  sourceFingerprint?: string;
  /** Up to 128 retained candidates from the one retrieval snapshot. */
  candidates: AgentEvidenceCandidate[];
  /** Atomic relationship paths; raw edges are host-only and never re-searched. */
  relationshipPathHandles: AskRelationshipPathHandleV1[];
  /**
   * Snapshot-captured certified block nodes keyed by candidate identity. The
   * value is deliberately unknown here so the runtime stays host-neutral.
   */
  certifiedArtifacts?: ReadonlyMap<string, AskCertifiedArtifactHandleV1 | unknown>;
  /** Host-only opaque-ID -> compiler-name capability mapping. */
  semanticCapabilities?: ReadonlyMap<string, AskSemanticCapabilityHandleV1>;
  /** Server-selected semantic runtime; safe to receipt, never provider-selected. */
  semanticRuntime?: AskSemanticRuntimeSelectionV1;
  /**
   * Snapshot-declared fiscal binding. It stays server-only so a controller
   * cannot invent a calendar, date role, or fiscal-period field from prose.
   * New workspaces include all three identities when a fiscal question is
   * eligible for semantic execution; old persisted workspaces simply remain
   * unable to satisfy a fiscal invocation.
   */
  fiscalCalendar?: {
    id: string;
    fiscalPeriodFieldId: string;
    dateRoleId?: string;
  };
  /**
   * Canonical semantic candidate IDs that collided while the host captured
   * this retrieval snapshot. A collision is not recoverable by choosing the
   * last card or falling back to a legacy ID: the affected capability is
   * deliberately withheld until a fresh, unambiguous snapshot is available.
   * This remains server-only alongside `semanticCapabilities`.
   */
  semanticCapabilityCollisionIds?: readonly string[];
  /**
   * Candidate identities whose own certified-output contract proved the full
   * requested tuple during this immutable retrieval pass.  This is separate
   * from artifact presence: an admitted block can be useful context without
   * being allowed to freeze the certified tier for this question.
   */
  certifiedCompleteCandidateIds?: readonly string[];
  /**
   * Subset of `certifiedCompleteCandidateIds` for which the retrieval snapshot
   * proved a direct certified-question contract: one exact authored example,
   * block title, or approved alias. This remains distinct from tuple
   * completeness and is retained for diagnostics/legacy consumers. An
   * authoritative V2 implicit ranking may alternatively use one uniquely
   * complete snapshot fit, but only with an independently proven immutable
   * primary sort and row-bound execution contract.
   */
  exactCertifiedQuestionCandidateIds?: readonly string[];
  /**
   * Server-owned execution capability for a certified block that has no
   * authored outer SQL LIMIT. When true, the host binds the question-derived
   * overall row limit into the frozen invocation and enforces it at the
   * read-only SQL boundary before result normalisation. This is intentionally
   * not inferred from provider-visible cards or persisted client state.
   */
  certifiedHostEnforcesInvocationRowLimit?: boolean;
  /**
   * Host-computed tuple state for the current request.  The provider may
   * inspect this, but cannot upgrade `available` to `complete` or mint a
   * state for an unadmitted candidate.
   */
  tierStates?: Partial<Record<AskExecutionTierV2, AskTierStateV1>>;
  /** Safe, bounded business/context projection for the contextual tools. */
  businessContext?: {
    available: boolean;
    objectCount: number;
    cards?: Array<{ id: string; name: string; description?: string; kind?: string }>;
  };
  /**
   * Explicit-Research-only, root-frozen structural lineage program. It is a
   * host callback rather than a provider tool: the provider can choose the
   * lineage branch, but cannot select a graph, widen a snapshot, or turn the
   * structural walk into SQL/provider work.
   */
  runDedicatedLineageProgram?: (input: {
    snapshotId?: string;
    targetCandidateIds: string[];
    relationshipPathIds: string[];
  }) => {
    status: 'completed' | 'missing' | 'ambiguous' | 'stale' | 'truncated' | 'unavailable';
    evidenceHandleIds: string[];
    validatorEvidenceHandleIds?: string[];
    counterEvidenceHandleIds?: string[];
    receiptFingerprint?: string;
  };
  /**
   * Optional root-frozen analytical children for explicit Research.  They are
   * not a fallback path: each one was separately authorized by the host and
   * must remain on this exact snapshot.  A missing/mismatched handle is a
   * typed branch failure, never a reason to rerun retrieval or call a planner.
   */
  frozenResearchChildren?: ReadonlyMap<string, AskFrozenResearchChildHandleV1>;
}

/** Host-validated continuity; raw browser rows are never an authority. */
export interface AskConversationContextV2 {
  version: 2;
  sourceTurnId?: string;
  priorPlanId?: string;
  resultFingerprint?: string;
  selectedMemberId?: string;
  selectedMemberBinding?: string;
  clarificationId?: string;
  availableResultHandleIds: string[];
  /**
   * Members an ambiguous prior-result reference could have meant, when the
   * host found candidates but could not choose between them. The analyst
   * offers these in a clarification instead of guessing; they are display
   * labels the user already saw, never new identity.
   */
  ambiguousMemberLabels?: string[];
}

/** Agent proposal is identifiers and an intended next tool only, never SQL/trust. */
export interface AskCandidatePlanV1 {
  version: 1;
  turnClass: AskTurnClassV2;
  candidateIds: string[];
  intendedTool?: AskToolNameV2;
  requestedExpansion?: boolean;
  requirementFingerprint: string;
}

export type AskToolObservationOutcomeV1 =
  | 'eligible'
  | 'executed'
  | 'ineligible'
  | 'unavailable'
  | 'ambiguous'
  | 'needs_input'
  | 'denied'
  | 'error';

/** Redacted, typed outcome supplied back to the same agent after every tool call. */
export interface AskToolObservationV1 {
  version: 1;
  tool: AskToolNameV2;
  outcome: AskToolObservationOutcomeV1;
  tier?: AskExecutionTierV2;
  reasonCode: string;
  candidateIds: string[];
  /** Atomic selected relationship path handles, when this is a DQL execution. */
  relationshipPathIds?: string[];
  planId?: string;
  frozen?: boolean;
  /**
   * Set only by the local host after it has minted an execution capability
   * (or bound an immutable certified artifact).  This is the freeze point:
   * compiler and warehouse failures which follow cannot reopen routing.
   */
  executionAuthorized?: boolean;
  /** The one permitted post-freeze retry, bound to the existing plan. */
  samePlanRepair?: boolean;
  retryable?: boolean;
  safeAction?: string;
  /** Wall-clock duration of the physical tool/host boundary, never prompt text. */
  durationMs?: number;
  /** Content-free correlations for input/output payloads where the host has one. */
  inputFingerprint?: string;
  outputFingerprint?: string;
  /** The component that produced this observation or final incident. */
  origin?: 'retrieval' | 'agent_control' | 'tool' | 'validation' | 'freeze' | 'execution' | 'provider' | 'narration';
  /** Redacted provider classification. Model names, URLs, and responses stay out. */
  provider?: {
    phase: 'preflight' | 'classification' | 'meaning_resolution' | 'planning' | 'generation' | 'repair' | 'narration' | 'agent_control' | 'tool_followup' | 'unknown';
    cause: 'authentication' | 'model_not_found' | 'rate_limited' | 'gateway' | 'network' | 'provider_timeout' | 'run_deadline' | 'admission_denied' | 'dispatch_budget' | 'cancelled' | 'unknown';
    retryable: boolean;
    safeAction: string;
  };
}

export type AskExecutionTierV2 = 'certified' | 'semantic' | 'governed_relational' | 'exploratory_sql';

/** A safe plan becomes immutable only after an execution tool reports executable. */
export interface ResolvedAnalyticalPlanV3 {
  version: 3;
  id: string;
  snapshotId?: string;
  tier: AskExecutionTierV2;
  candidateIds: string[];
  frozen: boolean;
  reviewRequired: boolean;
  /** Immutable selected targets/bindings, deliberately not raw SQL/DQL. */
  bindingFingerprint?: string;
  /** Bound relationship paths for governed-relational execution. */
  relationshipPathIds?: string[];
  /** Redacted warehouse/connection identity when the host has one. */
  targetFingerprint?: string;
  fingerprint: string;
}

/** Every tier interaction is durable even when it did not freeze a plan. */
export interface AskCascadeTierAttemptV2 {
  version: 2;
  tier: AskExecutionTierV2;
  outcome: AskToolObservationOutcomeV1;
  reasonCode: string;
  candidateIds: string[];
  frozen: boolean;
  durationMs?: number;
}

/**
 * Count-only projection of the immutable retrieval workspace.  It separates a
 * source that was empty/unavailable from a card that was simply outside the
 * bounded workspace, so a trace never calls a pruned card "not modeled".
 */
export interface AskContextCoverageV2 {
  version: 2;
  source: AskEvidenceHandleV1['source'];
  status: 'available' | 'empty' | 'stale' | 'unavailable' | 'errored' | 'skipped';
  admittedCandidateCount: number;
  excludedCandidateCount: number;
  reasonCodes: string[];
}

/** Typed terminal result of the V2 tool runtime, independent of V1 prose. */
export type AskAgentTerminalOutcomeKindV2 =
  | 'finish_answer'
  | 'clarification'
  | 'gap'
  | 'provider_failure'
  | 'execution_failure'
  | 'denied'
  | 'budget_exhausted';

export interface AskAgentTerminalOutcomeV2 {
  version: 2;
  kind: AskAgentTerminalOutcomeKindV2;
  reasonCode: string;
  safeAction?: string;
  origin: NonNullable<AskToolObservationV1['origin']>;
}

/**
 * Server-minted proof that an authoritative V2 tool run froze and executed
 * one immutable plan. This is an internal runner-to-host handoff only: it is
 * never accepted from browser/MCP input and it deliberately contains no SQL,
 * result rows, credentials, or provider content.
 */
export interface AskV2ExecutionReceipt {
  version: 1;
  mode: 'authoritative_v2';
  /**
   * Opaque ID minted by the engine for this one physical run.  A receipt with
   * the right-looking plan fields is not sufficient: the engine also checks
   * its process-local attestation before it can suppress the legacy gate.
   */
  capabilityId?: string;
  /** The engine run to which this receipt is bound. */
  runId?: string;
  snapshotId: string;
  sourceFingerprint?: string;
  /** Digest of the server-retained candidate universe, never a provider hint. */
  retainedCandidateFingerprint?: string;
  planId: string;
  planFingerprint?: string;
  tier: AskExecutionTierV2;
  candidateIds: string[];
  /** Fingerprint of the exact canonical execution result returned to the engine. */
  resultFingerprint?: string;
  frozen: true;
  executed: true;
}

/**
 * A process-local capability issued by `AgentRunEngine` after immutable
 * retrieval. It is not parsed from HTTP/MCP input and is intentionally useful
 * only to the runner that received this request object.  The capability's
 * opaque attestation is kept in a module-private WeakMap below, so copying
 * receipt-shaped JSON cannot make a terminal V2 execution authoritative.
 */
export interface AskV2ExecutionCapabilityV1 {
  version: 1;
  id: string;
  runId: string;
  snapshotId: string;
  sourceFingerprint?: string;
  retainedCandidateFingerprint: string;
  exactCertifiedCandidateId?: string;
}

type AskV2ExecutionReceiptAttestationV1 = {
  capability: AskV2ExecutionCapabilityV1;
  snapshotId: string;
  sourceFingerprint?: string;
  retainedCandidateIds: string[];
  planId: string;
  planFingerprint: string;
  tier: AskExecutionTierV2;
  candidateIds: string[];
  resultFingerprint: string;
};

/**
 * This registry is deliberately process-local and keyed by object identity.
 * It is the final server-owned boundary between a runner return value and the
 * engine's generic gate bypass. Persisted receipts remain readable, but they
 * cannot be replayed as live execution authority in a later run.
 */
const askV2ExecutionReceiptAttestations = new WeakMap<object, AskV2ExecutionReceiptAttestationV1>();

function stableAskV2Json(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableAskV2Json).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableAskV2Json(record[key])}`).join(',')}}`;
}

function askV2Fingerprint(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableAskV2Json(value)).digest('hex')}`;
}

function sortedAskV2Strings(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? [])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim()))].sort();
}

/**
 * Fingerprint only the snapshot-local facts the semantic compiler can consume.
 * Retrieval rank, descriptions, lane membership, and display prose are
 * deliberately absent: they do not change a compiler authority. Conversely,
 * the full analytical capability stays present, including its model-qualified
 * time dimensions, joins, outputs, and parameter contract. This is used both
 * when the host captures capabilities and when the provider resolves an
 * opaque ID, so exact duplicate cards are safe while divergent duplicates are
 * withheld before compiler execution.
 */
export function askV2SemanticCandidateAuthorityFingerprint(candidate: AgentEvidenceCandidate): string {
  return askV2Fingerprint({
    candidateId: candidate.qualifiedId ?? candidate.id,
    kind: candidate.kind,
    semanticObjectType: candidate.semanticObjectType ?? null,
    trustTier: candidate.trustTier,
    semanticRuntimeName: candidate.semanticRuntimeName ?? candidate.name,
    semanticModel: candidate.semanticModel ?? null,
    domain: candidate.domain ?? null,
    dataType: candidate.dataType ?? null,
    aggregation: candidate.aggregation ?? null,
    primaryEntity: candidate.primaryEntity ?? null,
    aliases: sortedAskV2Strings(candidate.aliases),
    dimensions: sortedAskV2Strings(candidate.dimensions),
    timeGrains: sortedAskV2Strings(candidate.timeGrains),
    requiredParameters: sortedAskV2Strings(candidate.requiredParameters),
    sourceObjects: sortedAskV2Strings(candidate.sourceObjects),
    analyticalCapability: candidate.analyticalCapability ?? null,
    sameSnapshotRoleExtension: candidate.sameSnapshotRoleExtension ?? null,
  });
}

/**
 * Return only the semantic object roles that can be bound directly by a
 * compiler.  A semantic model, saved query, and other context/container card
 * may be useful retrieval evidence, but it is never an executable field just
 * because its display/runtime name resembles one.  Keep this classification
 * deliberately structural: the V2 host captures a capability only from an
 * exact object type (or the legacy qualified-ID segment where old snapshots
 * omitted that type), never from a trust tier or a fuzzy name.
 */
export function askV2ExecutableSemanticRoles(
  candidate: AgentEvidenceCandidate,
): AskSemanticCapabilityHandleV1['roles'] | undefined {
  const objectType = candidate.semanticObjectType;
  if (objectType === 'model' || objectType === 'saved_query') return undefined;

  const semanticMember = candidate.kind === 'semantic_member';
  const canonicalSegments = (candidate.qualifiedId ?? candidate.id)
    .split(/[:/]/)
    .map((segment) => segment.trim().toLowerCase());
  const legacyObjectType = canonicalSegments.find((segment) => (
    segment === 'metric' || segment === 'measure' || segment === 'dimension' || segment === 'entity'
  ));
  const metric = candidate.kind === 'semantic_metric'
    || (semanticMember && (objectType === 'metric' || objectType === 'measure'
      || legacyObjectType === 'metric' || legacyObjectType === 'measure'));
  if (metric) return ['metric'];

  const entity = semanticMember && (objectType === 'entity' || legacyObjectType === 'entity');
  const dimension = semanticMember && (objectType === 'dimension' || legacyObjectType === 'dimension');
  if (!entity && !dimension) return undefined;

  const roles: AskSemanticCapabilityHandleV1['roles'] = ['dimension', 'filter_dimension'];
  // An entity key is a bindable grouping/filter field, but it is not a time
  // axis merely because a container card accidentally advertises grains.
  if (!entity && (candidate.timeGrains?.length ?? 0) > 0) roles.splice(1, 0, 'time_dimension');
  return roles;
}

/** Stable digest of the admitted immutable candidate closure. */
export function askV2RetainedCandidateFingerprint(candidateIds: readonly string[]): string {
  return askV2Fingerprint([...new Set(candidateIds.filter((id) => typeof id === 'string' && id.trim()))].sort());
}

/**
 * Return the canonical execution-result identity without retaining the result
 * in a receipt. Existing connector fingerprints win; the fallback covers
 * host-faithful test/local result envelopes that predate that field.
 */
export function askV2ExecutionResultFingerprint(result: unknown): string | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const record = result as Record<string, unknown>;
  const explicit = typeof record.resultFingerprint === 'string' && record.resultFingerprint.trim()
    ? record.resultFingerprint.trim()
    : undefined;
  if (explicit) return explicit;
  const executionReceipt = record.executionReceipt;
  if (executionReceipt && typeof executionReceipt === 'object' && !Array.isArray(executionReceipt)) {
    const receiptFingerprint = (executionReceipt as { resultFingerprint?: unknown }).resultFingerprint;
    if (typeof receiptFingerprint === 'string' && receiptFingerprint.trim()) return receiptFingerprint.trim();
  }
  const hasRows = Array.isArray(record.rows);
  const hasColumns = Array.isArray(record.columns);
  const hasRowCount = typeof record.rowCount === 'number' && Number.isFinite(record.rowCount);
  if (!hasRows && !hasColumns && !hasRowCount) return undefined;
  return askV2Fingerprint({
    columns: hasColumns ? record.columns : [],
    rows: hasRows ? record.rows : [],
    rowCount: hasRowCount ? Math.max(0, Math.trunc(record.rowCount as number)) : (record.rows as unknown[] | undefined)?.length ?? 0,
  });
}

/** Mint one server-owned capability for an authoritative V2 run. */
export function createAskV2ExecutionCapabilityV1(input: {
  id: string;
  runId: string;
  state: AskAgentStateV4;
}): AskV2ExecutionCapabilityV1 | undefined {
  const { state } = input;
  if (state.mode !== 'authoritative_v2' || !state.snapshotId || !input.id.trim() || !input.runId.trim()) return undefined;
  const capability: AskV2ExecutionCapabilityV1 = {
    version: 1,
    id: input.id,
    runId: input.runId,
    snapshotId: state.snapshotId,
    ...(state.sourceFingerprint ? { sourceFingerprint: state.sourceFingerprint } : {}),
    retainedCandidateFingerprint: askV2RetainedCandidateFingerprint(state.retainedCandidateIds),
    ...(state.exactCertifiedCandidateId ? { exactCertifiedCandidateId: state.exactCertifiedCandidateId } : {}),
  };
  return Object.freeze(capability);
}

function hasExecutedFrozenAskV2Plan(state: AskAgentStateV4): state is AskAgentStateV4 & { resolvedPlan: ResolvedAnalyticalPlanV3 } {
  const plan = state.resolvedPlan;
  return state.mode === 'authoritative_v2'
    && state.terminalOutcome?.kind === 'finish_answer'
    && state.terminalOutcome.origin === 'execution'
    && Boolean(plan?.frozen)
    && Boolean(plan?.id)
    && Boolean(plan?.fingerprint)
    && Boolean(plan?.candidateIds.length)
    && plan!.candidateIds.every((id) => state.retainedCandidateIds.includes(id))
    && state.observations.some((observation) => (
      observation.outcome === 'executed'
      && observation.origin === 'execution'
      && observation.planId === plan!.id
      && (observation.tool === 'run_certified'
        || observation.tool === 'compile_and_run_semantic'
        || observation.tool === 'compile_and_run_dql'
        || observation.tool === 'validate_and_run_sql')
    ));
}

/**
 * Mint the only receipt accepted by the engine's V2 terminal boundary. This
 * is called after a real tool execution advances the cloned provider state.
 * It rejects pre-freeze, non-executed, stale-snapshot, or mismatched-result
 * states before an attestation is ever registered.
 */
export function mintAskV2ExecutionReceiptV1(input: {
  state: AskAgentStateV4 | undefined;
  capability: AskV2ExecutionCapabilityV1 | undefined;
  result: unknown;
}): AskV2ExecutionReceipt | undefined {
  const { state, capability } = input;
  if (!state || !capability || !hasExecutedFrozenAskV2Plan(state)) return undefined;
  const plan = state.resolvedPlan;
  const resultFingerprint = askV2ExecutionResultFingerprint(input.result);
  if (!resultFingerprint
    || state.snapshotId !== capability.snapshotId
    || state.sourceFingerprint !== capability.sourceFingerprint
    || askV2RetainedCandidateFingerprint(state.retainedCandidateIds) !== capability.retainedCandidateFingerprint
    || plan.snapshotId !== undefined && plan.snapshotId !== capability.snapshotId
    || (capability.exactCertifiedCandidateId !== undefined
      && plan.tier === 'certified'
      && (plan.candidateIds.length !== 1 || plan.candidateIds[0] !== capability.exactCertifiedCandidateId))) return undefined;
  const receipt: AskV2ExecutionReceipt = {
    version: 1,
    mode: 'authoritative_v2',
    capabilityId: capability.id,
    runId: capability.runId,
    snapshotId: capability.snapshotId,
    ...(capability.sourceFingerprint ? { sourceFingerprint: capability.sourceFingerprint } : {}),
    retainedCandidateFingerprint: capability.retainedCandidateFingerprint,
    planId: plan.id,
    planFingerprint: plan.fingerprint,
    tier: plan.tier,
    candidateIds: [...plan.candidateIds],
    resultFingerprint,
    frozen: true,
    executed: true,
  };
  askV2ExecutionReceiptAttestations.set(receipt, {
    capability,
    snapshotId: capability.snapshotId,
    ...(capability.sourceFingerprint ? { sourceFingerprint: capability.sourceFingerprint } : {}),
    retainedCandidateIds: [...state.retainedCandidateIds],
    planId: plan.id,
    planFingerprint: plan.fingerprint,
    tier: plan.tier,
    candidateIds: [...plan.candidateIds],
    resultFingerprint,
  });
  return Object.freeze(receipt);
}

/**
 * Verify a live receipt at the engine boundary. A persisted, copied, forged,
 * stale, legacy, or pre-freeze receipt has no WeakMap attestation and cannot
 * skip the generic evaluator.
 */
export function isAskV2ExecutionReceiptAuthorizedV1(input: {
  receipt: AskV2ExecutionReceipt | undefined;
  capability: AskV2ExecutionCapabilityV1 | undefined;
  state: AskAgentStateV4 | undefined;
  result: unknown;
  runId: string;
}): boolean {
  const { receipt, capability, state } = input;
  if (!receipt || !capability || !state
    || state.mode !== 'authoritative_v2'
    || receipt.version !== 1
    || receipt.mode !== 'authoritative_v2'
    || receipt.frozen !== true
    || receipt.executed !== true
    || receipt.capabilityId !== capability.id
    || receipt.runId !== input.runId
    || capability.runId !== input.runId
    || receipt.snapshotId !== capability.snapshotId
    || receipt.sourceFingerprint !== capability.sourceFingerprint
    || receipt.retainedCandidateFingerprint !== capability.retainedCandidateFingerprint
    || state.snapshotId !== capability.snapshotId
    || state.sourceFingerprint !== capability.sourceFingerprint
    || askV2RetainedCandidateFingerprint(state.retainedCandidateIds) !== capability.retainedCandidateFingerprint
    || !receipt.planId.trim()
    || !receipt.planFingerprint?.trim()
    || !receipt.resultFingerprint?.trim()
    || receipt.candidateIds.length === 0
    || new Set(receipt.candidateIds).size !== receipt.candidateIds.length
    || !receipt.candidateIds.every((id) => state.retainedCandidateIds.includes(id))
    || (capability.exactCertifiedCandidateId !== undefined
      && receipt.tier === 'certified'
      && (receipt.candidateIds.length !== 1 || receipt.candidateIds[0] !== capability.exactCertifiedCandidateId))) return false;
  const attestation = askV2ExecutionReceiptAttestations.get(receipt);
  const resultFingerprint = askV2ExecutionResultFingerprint(input.result);
  return Boolean(attestation
    && attestation.capability === capability
    && attestation.snapshotId === receipt.snapshotId
    && attestation.sourceFingerprint === receipt.sourceFingerprint
    && askV2RetainedCandidateFingerprint(attestation.retainedCandidateIds) === receipt.retainedCandidateFingerprint
    && attestation.planId === receipt.planId
    && attestation.planFingerprint === receipt.planFingerprint
    && attestation.tier === receipt.tier
    && JSON.stringify(attestation.candidateIds) === JSON.stringify(receipt.candidateIds)
    && attestation.resultFingerprint === receipt.resultFingerprint
    && resultFingerprint === receipt.resultFingerprint);
}

/** The one durable server-side state record for a V2 Ask. */
export interface AskAgentStateV4 {
  version: 4;
  mode: AskRuntimeModeV2;
  turnClass: AskTurnClassV2;
  snapshotId?: string;
  sourceFingerprint?: string;
  retainedCandidateIds: string[];
  initialCandidateIds: string[];
  expansionCandidateIds: string[];
  /** Additive count-only source state; V4 readers written before V2 omit it. */
  contextCoverage?: AskContextCoverageV2[];
  /** Bounded-workspace exclusions are never a source-absence claim. */
  excludedCandidateCount?: number;
  exclusionReasonCodes?: string[];
  relationshipPathHandles: AskRelationshipPathHandleV1[];
  conversation: AskConversationContextV2;
  observations: AskToolObservationV1[];
  /**
   * Ephemeral host-owned tier truth carried with the live state.  It is
   * additive/optional so receipts produced before V2 remain readable.  The
   * durable trace records its outcomes through observations and tier attempts.
   */
  tierStates?: Partial<Record<AskExecutionTierV2, AskTierStateV1>>;
  /** Additive redacted host runtime choice used for semantic V2 execution. */
  semanticRuntime?: AskSemanticRuntimeSelectionV1;
  /** Optional so a persisted V4 receipt written before this additive field remains readable. */
  tierAttempts?: AskCascadeTierAttemptV2[];
  /**
   * Live, pre-freeze controller commitment.  An inspection may set this only
   * after the host has proved that the tier has an executable capability in
   * the immutable workspace.  It narrows the *next* model turn to that
   * tier's execution tool; it is not a frozen plan and never bypasses the
   * earlier-complete-tier guard.
   */
  controllerTier?: AskExecutionTierV2;
  /**
   * A narrowly-scoped priority exception for an explicit, snapshot-qualified
   * semantic or DQL artifact reference.  It is host-derived from an admitted
   * canonical ID; ordinary natural-language relevance never populates it.
   * Keeping this on the state makes a reload repeat the same Tier 1 decision
   * instead of trusting a stale lower-tier controller commitment.
   */
  explicitQualifiedArtifactReference?: {
    version: 1;
    tier: Extract<AskExecutionTierV2, 'semantic' | 'governed_relational'>;
    candidateId: string;
  };
  candidatePlan?: AskCandidatePlanV1;
  /**
   * Host-proven Tier 1 shortcut for an ordinary Ask.  This is set only when
   * the immutable retrieval workspace captured one admitted certified
   * artifact whose output contract already proves the complete tuple.  It is
   * deliberately an opaque candidate ID rather than a plan or a provider
   * instruction: the host still mints the execution capability and rechecks
   * artifact freshness immediately before execution.
   *
   * Exact certified fits are a contractual zero-provider path.  Leaving this
   * fact implicit forced the authoritative V2 agent loop to ask a model to
   * rediscover an already-proven block, which could exhaust the dispatch
   * budget before any Tier 1 execution occurred.
   */
  exactCertifiedCandidateId?: string;
  resolvedPlan?: ResolvedAnalyticalPlanV3;
  /** Actual V2 Research branch receipts; V3 projections remain readable. */
  researchLedgerV4?: ResearchEvidenceLedgerV4;
  terminal?: 'completed' | 'clarification' | 'denied' | 'budget_exhausted' | 'error';
  terminalOutcome?: AskAgentTerminalOutcomeV2;
}

/** Egress default for a remote provider; the local provider may use bounded rows. */
export interface ProviderResultEgressPolicyV2 {
  version: 2;
  transport: 'local' | 'remote';
  maximumRows: number;
  maximumColumns: number;
  maximumCells: number;
  allowRows: boolean;
  allowedKinds: Array<'facts' | 'aggregates' | 'schema' | 'fingerprints' | 'bounded_rows'>;
}

/** Provider egress is a host policy, not something the LLM may request. */
export function defaultProviderResultEgressPolicyV2(input: {
  transport: 'local' | 'remote';
  /** Remote rows require an explicit project setting and retain the same cap. */
  allowRemoteRows?: boolean;
}): ProviderResultEgressPolicyV2 {
  const allowRows = input.transport === 'local' || input.allowRemoteRows === true;
  return {
    version: 2,
    transport: input.transport,
    maximumRows: 20,
    maximumColumns: 20,
    maximumCells: 400,
    allowRows,
    allowedKinds: allowRows
      ? ['facts', 'aggregates', 'schema', 'fingerprints', 'bounded_rows']
      : ['facts', 'aggregates', 'schema', 'fingerprints'],
  };
}

/** Additive V8 receipt.  Existing V1-V7 readers stay untouched. */
export interface AgentRunDiagnosticReceiptV8 {
  version: 8;
  mode: AskRuntimeModeV2;
  turnClass: AskTurnClassV2;
  snapshotId?: string;
  retainedCandidateCount: number;
  initialCandidateCount: number;
  expansionCount: number;
  /** Objective is the typed turn class, never the user question or prompt. */
  objective: AskTurnClassV2;
  /** Count-only context story; no names, definitions, values, or raw rows. */
  contextCoverage: AskContextCoverageV2[];
  excludedCandidateCount: number;
  exclusionReasonCodes: string[];
  observations: AskToolObservationV1[];
  tierAttempts: AskCascadeTierAttemptV2[];
  /**
   * Server-owned current controller progression for an unfrozen V2 run.
   * This is deliberately not inferred from the first eligible inspection:
   * an earlier semantic card may already have become unavailable while the
   * controller has advanced to governed relational or exploratory SQL.
   */
  controllerTier?: AskExecutionTierV2;
  /** Redacted host-selected semantic runtime/readiness, never model input. */
  semanticRuntime?: AskSemanticRuntimeSelectionV1;
  planFrozen: boolean;
  terminalOutcome?: AskAgentTerminalOutcomeV2;
  /** Engine-owned final result facts; no result values or narration text. */
  outcome: {
    connectionAttempted: boolean;
    executionAttempts: number;
    factCount: number;
    narration: 'fact_bound' | 'deterministic_fallback' | 'not_retained' | 'not_applicable';
  };
  /**
   * Canonical physical/accounted activity for compact trace projections.
   * Provider dispatches are supplied by the server egress wrapper when it is
   * available; the kernel never infers a physical send from a planner stage.
   */
  activity: {
    providerDispatches: number;
    toolCalls: number;
    executionAttempts: number;
    repairs: number;
  };
  /** Compact timing only; content and raw provider data never enter the receipt. */
  toolDurationMs: number;
  finalStopReason: string;
}

/** V4 adds branch/tool facts without reinterpreting V1-V3 research receipts. */
export interface ResearchEvidenceLedgerV4 {
  version: 4;
  rootQuestionFingerprint: string;
  snapshotId?: string;
  branches: Array<{
    id: string;
    verdict: 'supported' | 'contradicted' | 'inconclusive' | 'failed' | 'skipped';
    evidenceHandleIds: string[];
    /** Evidence that a deterministic result/receipt validator actually checked. */
    validatorEvidenceHandleIds?: string[];
    /** Independent evidence that qualifies a branch; never inferred from rows. */
    counterEvidenceHandleIds?: string[];
    /** Opaque child receipt correlation; no SQL, rows, or provider response. */
    childReceiptFingerprint?: string;
    lineageProgram?: 'dedicated' | 'not_run';
  }>;
  limitedScope: boolean;
}

/**
 * An explicit Research controller supplies these only after it has run a
 * branch.  A generic tool observation is not a hypothesis and must never be
 * converted into one merely to make an empty ledger look complete.
 */
export interface AskV2ResearchBranchReceiptInput {
  id: string;
  verdict: ResearchEvidenceLedgerV4['branches'][number]['verdict'];
  evidenceHandleIds: string[];
  validatorEvidenceHandleIds?: string[];
  counterEvidenceHandleIds?: string[];
  childReceiptFingerprint?: string;
  lineageProgram?: 'dedicated' | 'not_run';
}

/**
 * Build a V4 ledger from the V2 tool boundary itself.  In particular lineage
 * is represented by its own atomic relationship handles; it is never inferred
 * from (or reused as) an analytical result branch.
 */
export function recordAskV2ResearchLedger(
  state: AskAgentStateV4,
  branchReceipts?: readonly AskV2ResearchBranchReceiptInput[],
): ResearchEvidenceLedgerV4 | undefined {
  if (state.turnClass !== 'research') return undefined;
  // Keep old persisted ledgers readable. New V2 ledgers are written only from
  // actual branch receipts, never inferred from an unrelated root tool trace.
  if (!branchReceipts) return state.researchLedgerV4;
  const branches = branchReceipts.slice(0, ASK_V2_BUDGETS.research.branches).map((branch) => ({
    id: branch.id,
    verdict: branch.verdict,
    evidenceHandleIds: [...new Set(branch.evidenceHandleIds)].slice(0, 24),
    ...(branch.validatorEvidenceHandleIds?.length
      ? { validatorEvidenceHandleIds: [...new Set(branch.validatorEvidenceHandleIds)].slice(0, 24) }
      : {}),
    ...(branch.counterEvidenceHandleIds?.length
      ? { counterEvidenceHandleIds: [...new Set(branch.counterEvidenceHandleIds)].slice(0, 24) }
      : {}),
    ...(branch.childReceiptFingerprint ? { childReceiptFingerprint: branch.childReceiptFingerprint } : {}),
    lineageProgram: branch.lineageProgram ?? 'not_run',
  }));
  const ledger: ResearchEvidenceLedgerV4 = {
    version: 4,
    rootQuestionFingerprint: `sha256:${createHash('sha256').update(`${state.snapshotId ?? ''}|${state.sourceFingerprint ?? ''}|research`).digest('hex')}`,
    ...(state.snapshotId ? { snapshotId: state.snapshotId } : {}),
    branches,
    limitedScope: branches.length < 3,
  };
  state.researchLedgerV4 = ledger;
  return ledger;
}

/**
 * Project the existing mixed V3 Research ledger into the V2 tool-runtime
 * reader contract.  This is deliberately a projection, not a second research
 * planner: it retains opaque receipt/fact identities and the dedicated local
 * lineage marker while excluding question text, SQL, rows, prompts, and
 * provider material.
 */
export function projectResearchEvidenceLedgerV4(ledger: ResearchEvidenceLedgerV3): ResearchEvidenceLedgerV4 {
  return {
    version: 4,
    rootQuestionFingerprint: ledger.rootQuestionFingerprint,
    ...(ledger.snapshotId ? { snapshotId: ledger.snapshotId } : {}),
    branches: ledger.entries.slice(0, ASK_V2_BUDGETS.research.branches).map((entry) => ({
      id: entry.id,
      verdict: entry.verdict,
      evidenceHandleIds: [...new Set([
        ...entry.factIds,
        ...entry.counterEvidenceFactIds,
        ...entry.receiptFingerprints,
      ])].slice(0, 24),
      ...(entry.receiptFingerprints.length ? { validatorEvidenceHandleIds: [...new Set(entry.receiptFingerprints)].slice(0, 24) } : {}),
      ...(entry.counterEvidenceFactIds.length ? { counterEvidenceHandleIds: [...new Set(entry.counterEvidenceFactIds)].slice(0, 24) } : {}),
      lineageProgram: entry.evidenceKind === 'lineage_graph' ? 'dedicated' : 'not_run',
    })),
    limitedScope: ledger.limitedScope,
  };
}

export const ASK_V2_BUDGETS = {
  ask: {
    durationMs: 45_000,
    // The cold discovery ladder costs five dispatches before any retry is
    // possible (two tier inspections, two tier attempts, one finish); six
    // left zero room to apply a taught refusal's admitted identifiers.
    providerDispatches: 10,
    toolCalls: 8,
    expansions: 2,
    executions: 2,
    repairs: 1,
    valueSearches: 1,
    clarifications: 1,
  },
  contextual: { durationMs: 15_000, providerDispatches: 2, toolCalls: 4 },
  research: { durationMs: 120_000, providerDispatches: 12, toolCalls: 24, branches: 6, repairs: 2 },
} as const;

export interface AskToolKernelV2 {
  readonly state: AskAgentStateV4;
  observe(observation: AskToolObservationV1): AskToolObservationV1;
  /**
   * Server-owned current tool availability for the next model transport.
   * This constrains repeated discovery after a tier has enough compatible
   * evidence, but never executes a query on the model's behalf.
   */
  toolPolicy(): {
    allowedToolNames: AskToolNameV2[];
    instruction?: string;
    terminalActionToolNames?: AskToolNameV2[];
  };
  canCall(tool: AskToolNameV2, input?: {
    repair?: boolean;
    expansion?: boolean;
    /**
     * Host-only zero-provider shortcut for one uniquely exact, current,
     * executable Tier 1 artifact. This is never part of a model tool schema:
     * callers must still bind the state-owned exact candidate below.
     */
    directExactCertifiedExecution?: boolean;
    /** Snapshot-qualified selected IDs for post-freeze same-plan comparison. */
    candidateIds?: readonly string[];
    relationshipPathIds?: readonly string[];
    /** Stable selected-target/binding proof; never raw program or SQL. */
    bindingFingerprint?: string;
  }): { ok: boolean; reasonCode?: string; safeNextTools?: AskToolNameV2[] };
  diagnosticReceipt(
    finalStopReason?: string,
    outcome?: AgentRunDiagnosticReceiptV8['outcome'],
    activity?: Partial<AgentRunDiagnosticReceiptV8['activity']>,
  ): AgentRunDiagnosticReceiptV8;
}

/**
 * A state may cross the package/CLI boundary several times during one Ask.
 * Keep the active kernel process-local, while also deriving counters from the
 * persisted observations so a reloaded receipt remains truthful.
 */
const activeToolKernels = new WeakMap<AskAgentStateV4, AskToolKernelV2>();

const ASK_V2_INSPECTION_TOOLS = new Set<AskToolNameV2>([
  'inspect_ask_context',
  'inspect_conversation_result',
  'inspect_business_context',
  'inspect_certified_candidates',
  'inspect_semantic_candidates',
  'inspect_relational_context',
  // Describing an admitted relation or metric is retrieval over evidence the
  // snapshot already contains. It cannot execute, cannot widen the snapshot,
  // and is the move that turns a guessed identifier into a real one — so it
  // is an inspection in every sense that matters to the kernel.
  'describe_relation',
  'describe_metric',
]);

/**
 * A rejected immutable inspection tells the controller which already-issued
 * action to take.  It cannot discover new snapshot evidence, so it must not
 * consume the logical V2 tool budget (including after receipt reload).
 */
function askV2ObservationConsumesToolBudget(
  observation: AskToolObservationV1,
  priorObservations: readonly AskToolObservationV1[] = [],
): boolean {
  if (observation.executionAuthorized) return false;
  if (observation.reasonCode === 'ASK_V2_REDUNDANT_INSPECTION') return false;
  if (observation.reasonCode === 'SEMANTIC_TIME_BINDING_COMPLETED') return false;
  if (ASK_V2_INSPECTION_TOOLS.has(observation.tool)
    && observation.reasonCode === 'ASK_V2_TOOL_PROGRESSION_REQUIRED') return false;
  // The FIRST refusal that hands back a real vocabulary is the moment the
  // controller learns what this snapshot admits — it is the teaching turn, not
  // wasted work, and charging it means a controller that corrects itself
  // perfectly still runs out of budget. Every later repeat of the same lesson
  // is charged normally, so this cannot become a way to retry forever.
  if (ASK_V2_TEACHING_REFUSAL_REASON_CODES.has(observation.reasonCode)
    && !priorObservations.some((prior) => ASK_V2_TEACHING_REFUSAL_REASON_CODES.has(prior.reasonCode))) {
    return false;
  }
  return true;
}

/**
 * Refusals whose payload names the admitted identifiers (see the lane's
 * teaching contracts). They tell a controller precisely how to succeed next
 * turn, which only helps if it still has a turn left.
 */
const ASK_V2_TEACHING_REFUSAL_REASON_CODES = new Set<string>([
  'EXPLORATORY_OUTPUT_IDENTIFIER_NOT_ADMITTED',
  'GOVERNED_RELATIONAL_IDENTIFIER_OR_PATH_NOT_ADMITTED',
  'SEMANTIC_IDENTIFIER_NOT_ADMITTED_TO_SNAPSHOT',
  'SEMANTIC_FILTERS_INVALID',
]);

function initialKernelCounters(state: AskAgentStateV4): {
  toolCalls: number;
  executionAttempts: number;
  repairs: number;
  expansions: number;
  valueSearches: number;
  clarifications: number;
} {
  const executionTools = new Set<AskToolNameV2>([
    'run_certified', 'compile_and_run_semantic', 'compile_and_run_dql', 'validate_and_run_sql',
  ]);
  const initial = {
    toolCalls: 0,
    executionAttempts: 0,
    repairs: 0,
    expansions: 0,
    valueSearches: 0,
    clarifications: 0,
  };
  const authorizedAttempts = new Set<string>();
  // Budget rules that depend on what came before must see the same prefix a
  // live run saw, so a reloaded receipt counts exactly what the turn counted.
  const seenObservations: AskToolObservationV1[] = [];
  for (const observation of state.observations) {
    // The host authorization observation is internal to the one tool call;
    // it must not consume a second LLM tool budget after a process reload.
    // A rejected immutable re-inspection carries no new retrieval or
    // execution evidence. It must not consume the logical tool budget on a
    // reload; live transport policy already prevents it from becoming a
    // second discovery round.
    if (askV2ObservationConsumesToolBudget(observation, seenObservations)) initial.toolCalls += 1;
    seenObservations.push(observation);
    if (executionTools.has(observation.tool)) {
      const attemptKey = `${observation.tool}:${observation.planId ?? observation.inputFingerprint ?? observation.reasonCode}:${observation.samePlanRepair === true ? 'repair' : 'initial'}`;
      if (observation.executionAuthorized) {
        if (!authorizedAttempts.has(attemptKey)) {
          authorizedAttempts.add(attemptKey);
          initial.executionAttempts += 1;
          if (observation.samePlanRepair) initial.repairs += 1;
        }
      } else if (!authorizedAttempts.size && (observation.outcome === 'executed' || observation.outcome === 'error')) {
        // Old V4 persisted observations predate authorization evidence.
        initial.executionAttempts += 1;
        if (observation.retryable) initial.repairs += 1;
      }
    }
    if (observation.tool === 'inspect_ask_context' && observation.reasonCode === 'same_snapshot_extension') initial.expansions += 1;
    if (observation.tool === 'search_values') initial.valueSearches += 1;
    if (observation.tool === 'request_clarification' && observation.outcome === 'needs_input') initial.clarifications += 1;
  }
  return initial;
}

/**
 * Tool-kernel safety is deliberately deterministic: it does not decide business
 * meaning, but it prevents a model from skipping a complete earlier tier,
 * widening a snapshot, recursively asking itself, or retrying indefinitely.
 */
export function createAskToolKernelV2(state: AskAgentStateV4): AskToolKernelV2 {
  const active = activeToolKernels.get(state);
  if (active) return active;
  const initial = initialKernelCounters(state);
  let toolCalls = initial.toolCalls;
  let executionAttempts = initial.executionAttempts;
  let repairs = initial.repairs;
  let expansions = initial.expansions;
  let valueSearches = initial.valueSearches;
  let clarifications = initial.clarifications;
  const priority: AskExecutionTierV2[] = ['certified', 'semantic', 'governed_relational', 'exploratory_sql'];
  const executionToolTier: Partial<Record<AskToolNameV2, AskExecutionTierV2>> = {
    run_certified: 'certified',
    compile_and_run_semantic: 'semantic',
    compile_and_run_dql: 'governed_relational',
    validate_and_run_sql: 'exploratory_sql',
  };
  const inspectionToolTier: Partial<Record<AskToolNameV2, AskExecutionTierV2>> = {
    inspect_certified_candidates: 'certified',
    inspect_semantic_candidates: 'semantic',
    inspect_relational_context: 'governed_relational',
  };
  const issuedMaterialClarificationChoices = (): readonly AskClarificationChoiceV1[] => {
    const ambiguous = state.tierStates?.semantic;
    if (ambiguous?.status !== 'ambiguous') return [];
    const tierCandidateIds = new Set(ambiguous.candidateIds);
    const retained = new Set(state.retainedCandidateIds);
    const choices = (ambiguous.clarificationChoices ?? []).filter((choice) => (
      choice.version === 1
      && Boolean(choice.id.trim())
      && Boolean(choice.label.trim())
      && Boolean(choice.resultFingerprint.trim())
      && choice.candidateIds.length > 0
      && choice.candidateIds.every((id) => retained.has(id) && tierCandidateIds.has(id))
    ));
    const uniqueIds = new Set(choices.map((choice) => choice.id));
    const uniqueResults = new Set(choices.map((choice) => choice.resultFingerprint));
    return choices.length >= 2 && uniqueIds.size === choices.length && uniqueResults.size === choices.length
      ? choices
      : [];
  };
  const maxTools = state.turnClass === 'research' ? ASK_V2_BUDGETS.research.toolCalls : ASK_V2_BUDGETS.ask.toolCalls;
  const maxExecutions = state.turnClass === 'research' ? 1 : ASK_V2_BUDGETS.ask.executions;

  const explicitlyBypassesTierPriority = (
    tier: AskExecutionTierV2,
    candidateIds?: readonly string[],
  ): boolean => {
    const reference = state.explicitQualifiedArtifactReference;
    return Boolean(reference
      && reference.tier === tier
      // The first tool-policy check happens before the provider tool's opaque
      // arguments are available. Authorization repeats this with selected IDs
      // and rejects a lower-tier tool that tries to use any other candidate.
      && (!candidateIds || candidateIds.includes(reference.candidateId)));
  };

  const priorTierComplete = (
    tier: AskExecutionTierV2,
    candidateIds?: readonly string[],
  ): AskExecutionTierV2 | undefined => {
    if (explicitlyBypassesTierPriority(tier, candidateIds)) return undefined;
    const index = priority.indexOf(tier);
    const hostComplete = priority.slice(0, index).find((earlier) => state.tierStates?.[earlier]?.status === 'complete');
    if (hostComplete) return hostComplete;
    // An execution that has frozen a real result remains complete even if a
    // host did not materialize the additive tier-state field (old reader or
    // persisted V4 state).  An inspection alone never has this authority.
    return state.observations.find((observation) => {
      // A physical tool invocation is not a completed tier merely because it
      // passed local argument validation.  The host owns `complete` before an
      // execution, and a fallback observation becomes complete only after the
      // executor returned a validated result.  Treating `eligible` as complete
      // here previously let a presentation-only observation block a genuine
      // lower-tier fallback.
      if (observation.outcome !== 'executed') return false;
      return executionToolTier[observation.tool] !== undefined
        && observation.tier !== undefined
        && priority.indexOf(observation.tier) < index;
    })?.tier;
  };

  const earlierTierInspected = (tier: AskExecutionTierV2): boolean => {
    const index = priority.indexOf(tier);
    return priority.slice(0, index).every((earlier) => {
      if (earlier === 'governed_relational' && hasInitialRelationshipClosure()) return true;
      return state.observations.some((observation) =>
        inspectionToolTier[observation.tool] === earlier
        || executionToolTier[observation.tool] === earlier,
      );
    });
  };

  const hasToolObservation = (tool: AskToolNameV2): boolean => state.observations.some((observation) => observation.tool === tool);
  /** Whether a bounded same-snapshot card expansion is still available. */
  const expansionsRemain = (): boolean => expansions < ASK_V2_BUDGETS.ask.expansions;
  /**
   * The initial provider package already contains the immutable role-balanced
   * cards and atomic relationship-path handles. `inspect_ask_context` may
   * render that package for a controller, but it is not an admission gate:
   * requiring a second inspection before every action both hid retrieval from
   * direct canonical-tool callers and spent a physical dispatch that must be
   * reserved for execution/narration. The DQL tool still validates every
   * selected path/candidate against this snapshot closure before it can
   * authorize or execute anything.
   */
  const hasInitialRelationshipClosure = (): boolean => (
    (state.relationshipPathHandles?.length ?? 0) > 0
  );
  const relationalContextInspected = (): boolean => (
    hasToolObservation('inspect_relational_context') || hasInitialRelationshipClosure()
  );
  const hasExecutedTool = (): boolean => state.observations.some((observation) => (
    observation.outcome === 'executed' && executionToolTier[observation.tool] !== undefined
  ));
  const analyticalTurn = (): boolean => state.turnClass === 'analytics' || state.turnClass === 'prior_result' || state.turnClass === 'research';
  /**
   * A refusal that means "you named something this snapshot does not admit".
   *
   * These are the only refusals a controller can act on by LEARNING rather
   * than by choosing a different tier: the tier was right, the vocabulary was
   * wrong. Treating them like any other denial is what produced the recorded
   * dead end — the policy kept offering exactly the two run tools that had
   * just refused the same invented identifiers, so every remaining dispatch
   * was spent re-guessing until the budget died.
   */
  const ASK_V2_VOCABULARY_GAP_REASON_CODES = new Set<string>([
    'EXPLORATORY_OUTPUT_IDENTIFIER_NOT_ADMITTED',
    'EXPLORATORY_SQL_VALIDATION_FAILED',
    'GOVERNED_RELATIONAL_IDENTIFIER_OR_PATH_NOT_ADMITTED',
    'SEMANTIC_IDENTIFIER_NOT_ADMITTED_TO_SNAPSHOT',
    'CERTIFIED_CANDIDATE_NOT_ADMITTED_TO_SNAPSHOT',
  ]);
  const lastVocabularyGapIndex = (): number => {
    for (let index = state.observations.length - 1; index >= 0; index -= 1) {
      const observation = state.observations[index]!;
      if (ASK_V2_VOCABULARY_GAP_REASON_CODES.has(observation.reasonCode)) return index;
    }
    return -1;
  };
  /** Discovery that can actually close a vocabulary gap, not mere re-reading. */
  const VOCABULARY_RECOVERY_TOOLS = new Set<AskToolNameV2>([
    'describe_relation',
    'describe_metric',
    'inspect_ask_context',
  ]);
  const vocabularyRecoveryAttempted = (): boolean => {
    const gapIndex = lastVocabularyGapIndex();
    if (gapIndex < 0) return false;
    return state.observations
      .slice(gapIndex + 1)
      .some((observation) => VOCABULARY_RECOVERY_TOOLS.has(observation.tool));
  };
  /**
   * Reopen discovery after a vocabulary gap.
   *
   * The controller keeps every execution tool the tier ladder allows, and
   * additionally regains the three moves that can turn a guess into a real
   * identifier. Once it has actually tried one of them, `finish_answer` is
   * added too: a controller that looked and found nothing usable must be able
   * to say so as a typed gap instead of spending the budget on refusals.
   */
  const withVocabularyRecovery = (policy: {
    allowedToolNames: AskToolNameV2[];
    instruction?: string;
    terminalActionToolNames?: AskToolNameV2[];
  }): {
    allowedToolNames: AskToolNameV2[];
    instruction?: string;
    terminalActionToolNames?: AskToolNameV2[];
  } => {
    if (lastVocabularyGapIndex() < 0) return policy;
    const recovered = vocabularyRecoveryAttempted();
    const added: AskToolNameV2[] = [
      'describe_relation',
      'describe_metric',
      ...(!hasToolObservation('inspect_ask_context') || expansionsRemain() ? ['inspect_ask_context' as const] : []),
      ...(recovered ? ['finish_answer' as const] : []),
    ];
    const allowedToolNames = [...new Set([...policy.allowedToolNames, ...added])];
    return {
      ...policy,
      allowedToolNames,
      instruction: [
        policy.instruction,
        'An identifier you sent was not admitted. Call describe_relation on an admitted relation to see its real columns'
        + ' (or describe_metric for a metric\'s compatible dimensions), then re-send the execution tool using those exact names.'
        + (recovered
          ? ' If nothing admitted can express the question, call finish_answer and name precisely what is missing.'
          : ''),
      ].filter(Boolean).join(' '),
      // The recovery inspectors are deliberately NOT terminal actions: a
      // transport forcing a final action must still force a real execution or
      // a typed finish, never another look.
      ...(policy.terminalActionToolNames?.length
        ? { terminalActionToolNames: recovered
          ? [...new Set([...policy.terminalActionToolNames, 'finish_answer' as const])]
          : policy.terminalActionToolNames }
        : {}),
    };
  };
  const toolPolicy = (): {
    allowedToolNames: AskToolNameV2[];
    instruction?: string;
    terminalActionToolNames?: AskToolNameV2[];
  } => {
    const all = [...ASK_V2_CANONICAL_TOOLS];
    // A frozen execution-target mismatch is a host terminal, not a request
    // for the controller to choose another compiler, route, or repair. Keep
    // the live policy empty as well as denying calls below so text and native
    // transports cannot turn it into a cross-engine retry.
    if (state.terminalOutcome?.kind === 'execution_failure') {
      return {
        allowedToolNames: [],
        instruction: 'The frozen execution target did not match the compiler result. Do not call another tool or choose another route.',
      };
    }
    if (hasExecutedTool()) {
      return {
        allowedToolNames: ['finish_answer'],
        instruction: 'A validated execution result is available. Call finish_answer now; do not inspect more context or choose another tier.',
        // Executing a validated plan is not itself the conversational
        // terminal.  The provider must pass through this host control so the
        // result/narration boundary is explicit and durable.  Native and text
        // transports use this to discard post-execution prose and reserve one
        // bounded controller action for `finish_answer`.
        terminalActionToolNames: ['finish_answer'],
      };
    }
    if (!analyticalTurn()) {
      const noClarification = all.filter((tool) => tool !== 'request_clarification');
      const contextual = state.turnClass === 'definition' || state.turnClass === 'business_context';
      const businessContextInspected = state.observations.some((observation) => (
        observation.tool === 'inspect_business_context' && observation.outcome === 'eligible'
      ));
      if (contextual && businessContextInspected) {
        return {
          allowedToolNames: ['finish_answer'],
          instruction: 'Retrieved business context is available. Call finish_answer with the host-issued evidence IDs; do not answer in prose outside the tool.',
          // A contextual answer has the same explicit host completion
          // boundary as a validated execution result.  Without this marker,
          // bounded native/text tool loops treat the second provider send as
          // an ordinary prose composition turn instead of exposing the only
          // evidence-bound finish control.
          terminalActionToolNames: ['finish_answer'],
        };
      }
      return { allowedToolNames: noClarification };
    }

    const certifiedInspected = hasToolObservation('inspect_certified_candidates');
    const semanticInspected = hasToolObservation('inspect_semantic_candidates');
    const relationalInspected = relationalContextInspected();
    const certifiedState = state.tierStates?.certified;
    const semanticState = state.tierStates?.semantic;
    const relationalState = state.tierStates?.governed_relational;
    const relationalAvailable = relationalState?.status === 'available'
      || relationalState?.status === 'complete'
      || (!relationalState && hasInitialRelationshipClosure());
    const certifiedPriorityBypassed = explicitlyBypassesTierPriority('semantic')
      || explicitlyBypassesTierPriority('governed_relational');

    const committedTier = state.resolvedPlan?.frozen ? undefined : state.controllerTier;
    const committedExecutionTool = committedTier === 'certified'
      ? 'run_certified' as const
      : committedTier === 'semantic'
        ? 'compile_and_run_semantic' as const
        : committedTier === 'governed_relational'
          ? 'compile_and_run_dql' as const
          : committedTier === 'exploratory_sql'
            ? 'validate_and_run_sql' as const
            : undefined;

    // A host semantic validator can return a precise, repairable binding
    // observation (for example an omitted time axis with no unique admitted
    // completion). Keep the controller on that same capability-bound tool
    // rather than silently advancing to relational/SQL or re-inspecting an
    // immutable snapshot. Only host-issued actions may narrow this policy.
    const semanticRecoveryTools = (semanticState?.safeNextTools ?? [])
      .filter((tool): tool is AskToolNameV2 => tool === 'compile_and_run_semantic' || tool === 'request_clarification');
    if (certifiedInspected && semanticInspected && semanticRecoveryTools.length > 0
      && (certifiedState?.status !== 'complete' || certifiedPriorityBypassed)) {
      return {
        allowedToolNames: semanticRecoveryTools,
        instruction: semanticRecoveryTools.includes('request_clarification')
          ? 'The host issued a material semantic ambiguity. Request the stable clarification now; do not infer a time axis or change tiers.'
          : 'The semantic binding was incomplete or unavailable before freeze. Correct the same admitted semantic tool arguments, or return a typed gap; do not change tiers or repeat inspection.',
        terminalActionToolNames: semanticRecoveryTools,
      };
    }

    if (certifiedState?.status === 'complete' && !certifiedPriorityBypassed) {
      if (!certifiedInspected) {
        return {
          allowedToolNames: ['inspect_certified_candidates'],
          instruction: 'The immutable snapshot proves one or more complete certified artifacts. Inspect those artifacts now so the controller can choose the bound certified candidate; do not inspect or commit a lower tier.',
          terminalActionToolNames: ['inspect_certified_candidates'],
        };
      }
      return {
        allowedToolNames: ['run_certified'],
        instruction: 'The immutable snapshot proves one or more complete certified artifacts. Run one inspected certified candidate before any lower tier.',
        terminalActionToolNames: ['run_certified'],
      };
    }
    // An eligible inspection with an executable host capability is the
    // controller's route choice, not an invitation to re-inspect immutable
    // evidence from another tier.  Keep the LLM in control of bindings and
    // execution, but require the one chosen tier's tool now.  A host-proven
    // complete earlier tier still wins above, and canCall repeats that guard
    // before any capability is minted.
    if (committedExecutionTool) {
      const committedState = state.tierStates?.[committedTier!];
      const recovery = (committedState?.safeNextTools ?? [])
        .filter((tool): tool is AskToolNameV2 => tool === committedExecutionTool || tool === 'request_clarification');
      if (committedState?.status === 'ambiguous' && issuedMaterialClarificationChoices().length >= 2) {
        return {
          allowedToolNames: ['request_clarification'],
          instruction: 'The selected tier has a host-issued material ambiguity. Request the stable clarification now; do not inspect or change tiers.',
          terminalActionToolNames: ['request_clarification'],
        };
      }
      if (recovery.length > 0) {
        return withVocabularyRecovery({
          allowedToolNames: recovery,
          instruction: recovery.includes('request_clarification')
            ? 'The selected tier requires the host-issued material clarification. Do not inspect another tier.'
            : `Correct the same selected ${committedTier} tool arguments now. Do not inspect another tier or answer in prose.`,
          terminalActionToolNames: recovery,
        });
      }
      if (committedState?.status !== 'unavailable' && committedState?.status !== 'ineligible' && committedState?.status !== 'ambiguous') {
        return withVocabularyRecovery({
          allowedToolNames: [committedExecutionTool],
          instruction: `The controller selected the eligible ${committedTier} tier from the immutable snapshot. Call ${committedExecutionTool} now with admitted IDs; do not inspect another tier or answer in prose.`,
          terminalActionToolNames: [committedExecutionTool],
        });
      }
    }
    // A semantic inspection gives the model all metric/time compatibility
    // cards it needs. It must now establish whether a certified block is
    // complete instead of spending provider turns on unrelated context.
    if (semanticInspected && !certifiedInspected && !certifiedPriorityBypassed) {
      return {
        allowedToolNames: ['inspect_certified_candidates'],
        instruction: 'Semantic candidates are inspected. Inspect certified candidates next to enforce tier priority before compiling semantic SQL.',
      };
    }
    // Once the certified tier is inspected and not complete, compatible
    // semantic evidence is sufficient for the next action. This is a control
    // boundary, not deterministic execution: only the LLM may supply the
    // selected metric/dimension/time IDs to compile_and_run_semantic.
    if (certifiedInspected && semanticInspected && (semanticState?.status === 'available' || semanticState?.status === 'complete')) {
      // The model may determine from the inspected cards that the requested
      // tuple spans a certified relationship closure rather than the semantic
      // layer.  The initial snapshot already exposed that closure, so retain
      // DQL/SQL as model-controlled alternatives when it is present.  They
      // remain fully capability-bound by their own tools; this never upgrades
      // semantic availability into a route decision or skips tier safety.
      const relationalAlternatives = hasInitialRelationshipClosure()
        ? ['compile_and_run_dql', 'validate_and_run_sql'] as AskToolNameV2[]
        : [];
      return withVocabularyRecovery({
        allowedToolNames: ['compile_and_run_semantic', ...relationalAlternatives],
        instruction: relationalAlternatives.length
          ? 'Certified is not complete. Execute the highest compatible tier now: use compile_and_run_semantic when the selected metric/dimensions are compatible; otherwise use admitted path-bound compile_and_run_dql, or review-required SQL only when DQL cannot prove the tuple. Do not repeat inspection.'
          : 'Certified is not complete and compatible semantic evidence is inspected. Call compile_and_run_semantic now with admitted IDs; do not repeat inspection.',
        terminalActionToolNames: ['compile_and_run_semantic', ...relationalAlternatives],
      });
    }
    if (certifiedInspected && semanticInspected && semanticState?.status === 'ambiguous'
      && issuedMaterialClarificationChoices().length >= 2) {
      return {
        allowedToolNames: ['request_clarification'],
        instruction: 'The compatible semantic meanings remain materially ambiguous. Request one stable clarification instead of inspecting more context.',
        terminalActionToolNames: ['request_clarification'],
      };
    }
    if (certifiedInspected && semanticInspected && semanticState?.status === 'ambiguous' && !relationalInspected) {
      return {
        allowedToolNames: ['inspect_relational_context'],
        instruction: 'Semantic candidates are not backed by a host-issued material choice set. Inspect governed relational context rather than asking an unsupported clarification.',
      };
    }
    if (certifiedInspected && semanticInspected && semanticState?.status === 'ambiguous'
      && relationalInspected && relationalAvailable) {
      return withVocabularyRecovery({
        allowedToolNames: ['compile_and_run_dql', 'validate_and_run_sql'],
        instruction: 'Semantic meanings remain unresolved without a host-issued material clarification. Execute the admitted governed relational plan when it proves the tuple, otherwise validate one review-required SQL proposal.',
        terminalActionToolNames: ['compile_and_run_dql', 'validate_and_run_sql'],
      });
    }
    if (certifiedInspected && !semanticInspected) {
      return {
        // The inspection has already established that no certified candidate
        // is complete. Prefer semantic inspection next, but leave the
        // snapshot-bound certified validation tool visible so an LLM that
        // asks why the context-only block cannot run receives the precise
        // tuple-not-proven observation rather than a generic controller
        // denial. That tool cannot execute because its own immutable
        // completeness check remains authoritative.
        allowedToolNames: ['inspect_semantic_candidates', 'run_certified'],
        instruction: 'No complete certified tier was proven. Inspect semantic candidates next before relational or SQL exploration. A certified run is allowed only to record its snapshot tuple validation.',
      };
    }
    if (certifiedInspected && semanticInspected && (semanticState?.status === 'unavailable' || semanticState?.status === 'ineligible') && !relationalInspected) {
      return {
        allowedToolNames: ['inspect_relational_context'],
        instruction: 'Certified and semantic tiers cannot execute from this snapshot. Inspect admitted governed relational context next.',
      };
    }
    if (certifiedInspected && semanticInspected && (semanticState?.status === 'unavailable' || semanticState?.status === 'ineligible') && relationalInspected) {
      if (relationalState?.status === 'complete') {
        return withVocabularyRecovery({
          allowedToolNames: ['compile_and_run_dql'],
          instruction: 'Certified and semantic tiers cannot execute and the host proves a complete governed relational tuple. Compile admitted DQL next.',
          terminalActionToolNames: ['compile_and_run_dql'],
        });
      }
      if (relationalState?.status === 'available') {
        // Availability means the snapshot has relationship evidence, not
        // that one governed DQL program proves the requested tuple. The
        // controller may choose a path-bound DQL program, or safely validate
        // exploratory SQL against the same admitted closure. Only a complete
        // earlier tier can forbid that lower route.
        return withVocabularyRecovery({
          allowedToolNames: ['compile_and_run_dql', 'validate_and_run_sql'],
          instruction: 'Certified and semantic tiers cannot execute. Governed relational evidence is available but not complete for this request: choose admitted DQL when it proves the tuple, otherwise validate one review-required SQL proposal against the admitted closure.',
          terminalActionToolNames: ['compile_and_run_dql', 'validate_and_run_sql'],
        });
      }
      if (relationalAvailable) {
        return withVocabularyRecovery({
          allowedToolNames: ['compile_and_run_dql', 'validate_and_run_sql'],
          instruction: 'Certified and semantic tiers cannot execute. The immutable initial snapshot already supplied an admitted relationship closure: execute path-bound DQL when it proves the tuple, otherwise validate one review-required SQL proposal.',
          terminalActionToolNames: ['compile_and_run_dql', 'validate_and_run_sql'],
        });
      }
      if (relationalState?.status === 'unavailable' || relationalState?.status === 'ineligible') {
        return withVocabularyRecovery({
          allowedToolNames: ['validate_and_run_sql'],
          instruction: 'Earlier governed tiers are unavailable or ineligible. Validate one read-only SQL proposal against the admitted exploratory closure.',
          terminalActionToolNames: ['validate_and_run_sql'],
        });
      }
    }
    // Snapshot retrieval is immutable. Do not let an analytical controller
    // spend its executable reserve re-reading context/business/conversation
    // cards that cannot have changed. The remaining tier inspectors are the
    // only meaningful discovery actions until a compiler/validator tool is
    // required by the branches above.
    const remainingInspectors = [
      // The initial role-balanced package is already in the first provider
      // prompt. This optional one-time tool is retained for controllers that
      // need to render its safe cards/handles explicitly (and for a precise
      // snapshot-mismatch diagnostic), but it is never a prerequisite for
      // acting on those admitted cards.
      !hasToolObservation('inspect_ask_context') ? 'inspect_ask_context' : undefined,
      !certifiedInspected ? 'inspect_certified_candidates' : undefined,
      !semanticInspected ? 'inspect_semantic_candidates' : undefined,
      !relationalInspected ? 'inspect_relational_context' : undefined,
    ].filter((tool): tool is AskToolNameV2 => Boolean(tool));
    if (remainingInspectors.length) {
      return {
        allowedToolNames: [...remainingInspectors, 'describe_relation', 'describe_metric'],
        instruction: 'Inspect only the remaining analytical tier evidence from this immutable snapshot. Do not repeat context or business inspection; after the required tier evidence is available, execute or return a typed clarification/denial.',
      };
    }
    return withVocabularyRecovery({
      // An analytical turn cannot finish as ungrounded prose before a tool
      // produces a validated result or a typed clarification/gap.
      allowedToolNames: all.filter((tool) => tool !== 'finish_answer' && tool !== 'request_clarification'
        && tool !== 'inspect_ask_context' && tool !== 'inspect_business_context'
        && tool !== 'inspect_conversation_result'),
    });
  };

  const controllerTier = (): AskExecutionTierV2 | undefined => {
    if (state.resolvedPlan?.frozen) return state.resolvedPlan.tier;
    if (state.controllerTier) return state.controllerTier;
    // The compact trace must describe the controller's last real execution
    // decision, including a pre-freeze compiler/validation failure.  Falling
    // through to the *next* policy action made a failed semantic invocation
    // look like governed relational work even though that tool never ran.
    const attempted = state.observations.slice().reverse().find((observation) => (
      executionToolTier[observation.tool] !== undefined
    ));
    if (attempted?.tier) return attempted.tier;
    const policy = toolPolicy();
    const names = policy.terminalActionToolNames?.length
      ? policy.terminalActionToolNames
      : policy.allowedToolNames;
    return names.map((name) => executionToolTier[name] ?? inspectionToolTier[name]).find(Boolean);
  };

  const kernel: AskToolKernelV2 = {
    state,
    canCall(tool, input = {}) {
      if (state.terminalOutcome?.kind === 'execution_failure') {
        return { ok: false, reasonCode: state.terminalOutcome.reasonCode };
      }
      const inspectionTools = ASK_V2_INSPECTION_TOOLS;
      // Immutable retrieval means a repeated inspector cannot reveal a new
      // candidate, coverage state, or relationship path. Reject it before
      // normal policy/budget handling so the next controller prompt receives
      // the current executable safe action instead of treating repetition as
      // evidence that the data is missing. A bounded same-snapshot extension
      // is the sole exception.
      const repeatedInitialContext = tool === 'inspect_ask_context'
        && input.expansion !== true
        && hasToolObservation('inspect_ask_context');
      const emptyOrExhaustedExpansion = tool === 'inspect_ask_context'
        && input.expansion === true
        && (expansions >= ASK_V2_BUDGETS.ask.expansions
          || state.expansionCandidateIds.slice(expansions * 12, (expansions + 1) * 12).length === 0);
      const repeatedImmutableInspection = inspectionTools.has(tool)
        && tool !== 'inspect_ask_context'
        && hasToolObservation(tool);
      if (repeatedInitialContext || emptyOrExhaustedExpansion || repeatedImmutableInspection) {
        const progress = toolPolicy();
        return {
          ok: false,
          reasonCode: 'ASK_V2_REDUNDANT_INSPECTION',
          safeNextTools: progress.terminalActionToolNames?.length
            ? progress.terminalActionToolNames
            : progress.allowedToolNames,
        };
      }
      if (toolCalls >= maxTools) return { ok: false, reasonCode: 'ASK_TOOL_BUDGET_EXHAUSTED' };
      const progress = toolPolicy();
      const tier = executionToolTier[tool];
      // Tier-truth materialization records snapshot provenance, not a model
      // tool call.  A uniquely exact Tier 1 artifact may therefore enter its
      // one real host invocation without manufacturing an
      // `inspect_certified_candidates` or `run_certified` observation first.
      // Keep this exception capability-like: it is available only to the
      // server-owned fast path, only for the exact state-owned candidate, and
      // only while the immutable workspace still proves exactly that one
      // complete certified tuple.  Ordinary provider calls continue through
      // the inspector-first policy below.
      const directExactCertifiedExecution = tool === 'run_certified'
        && input.directExactCertifiedExecution === true
        && state.tierStates?.certified?.status === 'complete'
        && state.exactCertifiedCandidateId !== undefined
        && state.tierStates.certified.candidateIds.length === 1
        && state.tierStates.certified.candidateIds[0] === state.exactCertifiedCandidateId
        && input.candidateIds?.length === 1
        && input.candidateIds[0] === state.exactCertifiedCandidateId;
      if (tier) {
        if (state.turnClass === 'definition' || state.turnClass === 'business_context' || state.turnClass === 'general') {
          return { ok: false, reasonCode: 'CONTEXTUAL_TURN_EXECUTION_NOT_ALLOWED' };
        }
        const earlier = priorTierComplete(tier, input.candidateIds);
        if (earlier) {
          const safeNextTools = earlier === 'certified'
            ? ['run_certified'] as AskToolNameV2[]
            : earlier === 'semantic'
              ? ['compile_and_run_semantic'] as AskToolNameV2[]
              : ['compile_and_run_dql'] as AskToolNameV2[];
          return { ok: false, reasonCode: 'EARLIER_COMPLETE_TIER_REQUIRED', safeNextTools };
        }
        // A frozen plan is stronger than the pre-freeze inspection protocol:
        // no later route may replace it, even if that later route was never
        // inspected. Report an already-complete earlier tier first because it
        // is the actionable reason for a lower-tier request; a higher-tier
        // replacement remains a post-freeze route-change denial.
        if (state.resolvedPlan?.frozen && state.resolvedPlan.tier !== tier) {
          return { ok: false, reasonCode: 'POST_FREEZE_ROUTE_CHANGE_DENIED' };
        }
        // Once the host has authorized a plan, the only permissible second
        // attempt is the explicitly-marked same-plan repair below.  Do not
        // let an identical ordinary tool call look like a fresh pre-freeze
        // execution attempt: that would silently bypass the repair budget.
        if (state.resolvedPlan?.frozen && state.resolvedPlan.tier === tier && !input.repair) {
          return { ok: false, reasonCode: 'POST_FREEZE_REPAIR_REQUIRED' };
        }
        // A same-plan repair is bound to the frozen tool/plan. It must not
        // re-run pre-freeze inspection just because the original evidence was
        // compacted after execution; the repair and execution ceilings below
        // remain the authority.
        if (state.resolvedPlan?.frozen && state.resolvedPlan.tier === tier && input.repair) {
          const frozen = state.resolvedPlan;
          const requestedCandidateIds = input.candidateIds
            ? [...new Set(input.candidateIds)].filter((id) => state.retainedCandidateIds.includes(id)).sort()
            : undefined;
          const frozenCandidateIds = [...frozen.candidateIds].sort();
          const requestedPathIds = input.relationshipPathIds ? [...new Set(input.relationshipPathIds)].sort() : undefined;
          const frozenPathIds = [...(frozen.relationshipPathIds ?? [])].sort();
          const sameCandidates = !requestedCandidateIds
            || (requestedCandidateIds.length === frozenCandidateIds.length && requestedCandidateIds.every((id, index) => id === frozenCandidateIds[index]));
          const samePaths = !requestedPathIds
            || (requestedPathIds.length === frozenPathIds.length && requestedPathIds.every((id, index) => id === frozenPathIds[index]));
          const sameBindings = !input.bindingFingerprint
            || !frozen.bindingFingerprint
            || input.bindingFingerprint === frozen.bindingFingerprint;
          if (!sameCandidates || !samePaths || !sameBindings) {
            return { ok: false, reasonCode: 'POST_FREEZE_PLAN_MUTATION_DENIED' };
          }
          if (repairs >= (state.turnClass === 'research' ? ASK_V2_BUDGETS.research.repairs : ASK_V2_BUDGETS.ask.repairs)) {
            return { ok: false, reasonCode: 'ASK_REPAIR_BUDGET_EXHAUSTED' };
          }
          if (executionAttempts >= maxExecutions) return { ok: false, reasonCode: 'ASK_EXECUTION_BUDGET_EXHAUSTED' };
          return { ok: true };
        }
        // A live controller commitment is created only by the matching
        // host-backed inspection.  It may let that tier execute without
        // burning later-tier discovery turns, while the earlier-complete
        // guard above remains authoritative.
        if (!earlierTierInspected(tier) && state.controllerTier !== tier) {
          return { ok: false, reasonCode: 'EARLIER_TIER_INSPECTION_REQUIRED' };
        }
        if (executionAttempts >= maxExecutions) return { ok: false, reasonCode: 'ASK_EXECUTION_BUDGET_EXHAUSTED' };
        if (input.repair && repairs >= (state.turnClass === 'research' ? ASK_V2_BUDGETS.research.repairs : ASK_V2_BUDGETS.ask.repairs)) {
          return { ok: false, reasonCode: 'ASK_REPAIR_BUDGET_EXHAUSTED' };
        }
      }
      // Keep tier/freeze denials above as the primary reason. Once ordinary
      // safety permits a call, the live policy may still narrow discovery to
      // the next LLM-controlled action (for example semantic compilation).
      if (!progress.allowedToolNames.includes(tool) && !directExactCertifiedExecution) {
        // A raw/text controller can still submit an admitted semantic handle
        // after the inspector has reported a host-unavailable or ineligible
        // semantic tier. Let the canonical semantic tool return its precise
        // pre-freeze capability/argument diagnostic, but never promote that
        // call into a committed route or an execution authorization. Native
        // tool surfaces remain narrowed to the actual next safe action.
        const semanticValidationProbe = tool === 'compile_and_run_semantic'
          && input.candidateIds?.length
          && (state.tierStates?.semantic?.status === 'unavailable' || state.tierStates?.semantic?.status === 'ineligible');
        if (semanticValidationProbe) return { ok: true };
        // An out-of-snapshot relationship handle is a local validation
        // incident, not an alternate lower-tier execution route. Let the DQL
        // tool consume that malformed request so it can return the precise
        // `...PATH_NOT_ADMITTED` observation; it cannot reach a compiler or
        // executor. This keeps a hostile or stale text-tool request
        // diagnosable while the native tool surface remains narrowed to the
        // safe next action.
        const malformedRelationshipPathRequest = tool === 'compile_and_run_dql'
          && input.relationshipPathIds?.some((id) => !(state.relationshipPathHandles ?? []).some((path) => path.id === id));
        if (malformedRelationshipPathRequest) return { ok: true };
        return {
          ok: false,
          reasonCode: tool === 'request_clarification'
            ? 'ASK_V2_CLARIFICATION_NOT_MATERIALLY_AMBIGUOUS'
            : hasExecutedTool() ? 'ASK_V2_TERMINAL_NARRATION_REQUIRED' : 'ASK_V2_TOOL_PROGRESSION_REQUIRED',
          safeNextTools: progress.allowedToolNames,
        };
      }
      if (input.expansion && expansions >= ASK_V2_BUDGETS.ask.expansions) return { ok: false, reasonCode: 'ASK_EXPANSION_BUDGET_EXHAUSTED' };
      if (tool === 'search_values' && valueSearches >= ASK_V2_BUDGETS.ask.valueSearches) return { ok: false, reasonCode: 'ASK_VALUE_SEARCH_BUDGET_EXHAUSTED' };
      if (tool === 'request_clarification' && clarifications >= ASK_V2_BUDGETS.ask.clarifications) return { ok: false, reasonCode: 'ASK_CLARIFICATION_ALREADY_REQUESTED' };
      return { ok: true };
    },
    toolPolicy,
    observe(observation) {
      // A host authorization/freeze is evidence within one canonical tool
      // call. Keep it out of the provider-tool budget while retaining it in
      // the durable receipt before compiler/warehouse work begins.
      // A host-only semantic argument completion is emitted inside the same
      // physical tool call before authorization. Preserve it in V8 without
      // double-charging the provider tool budget.
      if (askV2ObservationConsumesToolBudget(observation, state.observations)) toolCalls += 1;
      const executionTier = executionToolTier[observation.tool];
      const tier = executionTier ?? inspectionToolTier[observation.tool] ?? observation.tier;
      if (tier) {
        // A compiler/compatibility miss is not a warehouse execution. Counting
        // it here would consume the exploratory attempt before the agent had
        // actually reached a runnable later tier.
        if (executionTier && observation.executionAuthorized) {
          executionAttempts += 1;
          if (observation.samePlanRepair) repairs += 1;
        } else if (executionTier && !state.observations.some((item) => item.executionAuthorized)
          && (observation.outcome === 'executed' || observation.outcome === 'error')) {
          // Backward-compatible reader behavior for a pre-authorization V4
          // receipt. New runs count the minted capability instead.
          executionAttempts += 1;
          if (observation.retryable) repairs += 1;
        }
        // Freeze at host authorization/capability minting, before a compiler
        // or executor is called.  A failure after this point is terminal
        // unless the same frozen plan receives its one permitted repair.
        if (executionTier && observation.executionAuthorized && observation.outcome === 'eligible' && !state.resolvedPlan?.frozen) {
          const ids = [...new Set(observation.candidateIds)].filter((id) => state.retainedCandidateIds.includes(id));
          state.resolvedPlan = {
            version: 3,
            id: observation.planId ?? `ask-v2:${tier}:${state.snapshotId ?? 'snapshot'}`,
            snapshotId: state.snapshotId,
            tier,
            candidateIds: ids,
            frozen: true,
            reviewRequired: tier === 'exploratory_sql',
            ...(observation.inputFingerprint ? { bindingFingerprint: observation.inputFingerprint } : {}),
            ...(observation.relationshipPathIds?.length
              ? { relationshipPathIds: [...new Set(observation.relationshipPathIds)].sort() }
              : {}),
            ...(observation.outputFingerprint ? { targetFingerprint: observation.outputFingerprint } : {}),
            fingerprint: observation.inputFingerprint
              ?? `sha256:${createHash('sha256').update([tier, state.snapshotId ?? '', ...ids].join('|')).digest('hex')}`,
          };
        }
        // Execution is a host-backed proof that the selected tuple was
        // complete.  Compiler/availability misses remain observations and
        // intentionally allow the same agent to continue down the cascade.
        if (executionTier && observation.outcome === 'executed') {
          state.tierStates = {
            ...state.tierStates,
            [tier]: {
              version: 1,
              status: 'complete',
              candidateIds: [...new Set(observation.candidateIds)].filter((id) => state.retainedCandidateIds.includes(id)),
              reasonCode: observation.reasonCode,
            },
          };
        }
        const tierAttempts = state.tierAttempts ?? (state.tierAttempts = []);
        tierAttempts.push({
          version: 2,
          tier,
          outcome: observation.outcome,
          reasonCode: observation.reasonCode,
          candidateIds: [...new Set(observation.candidateIds)].filter((id) => state.retainedCandidateIds.includes(id)),
          frozen: state.resolvedPlan?.frozen === true && state.resolvedPlan.tier === tier,
          ...(typeof observation.durationMs === 'number' ? { durationMs: observation.durationMs } : {}),
        });
      }
      if (observation.tool === 'search_values') valueSearches += 1;
      if (observation.tool === 'request_clarification' && observation.outcome === 'needs_input') clarifications += 1;
      if (observation.tool === 'inspect_ask_context' && observation.reasonCode === 'same_snapshot_extension') expansions += 1;
      state.observations.push({ ...observation, ...(tier ? { tier } : {}) });
      if (observation.outcome === 'denied') state.terminal = 'denied';
      if (observation.outcome === 'needs_input') state.terminal = 'clarification';
      return state.observations.at(-1)!;
    },
    diagnosticReceipt(finalStopReason = state.terminal ?? 'in_progress', outcome = {
      connectionAttempted: false,
      executionAttempts: 0,
      factCount: 0,
      narration: 'not_retained',
    }, activity) {
      const count = (value: number | undefined, fallback: number): number => (
        typeof value === 'number' && Number.isFinite(value)
          ? Math.max(0, Math.floor(value))
          : fallback
      );
      return {
        version: 8,
        mode: state.mode,
        turnClass: state.turnClass,
        snapshotId: state.snapshotId,
        retainedCandidateCount: state.retainedCandidateIds.length,
        initialCandidateCount: state.initialCandidateIds.length,
        expansionCount: expansions,
        objective: state.turnClass,
        contextCoverage: state.contextCoverage ?? [],
        excludedCandidateCount: state.excludedCandidateCount ?? 0,
        exclusionReasonCodes: state.exclusionReasonCodes ?? [],
        observations: state.observations,
        tierAttempts: state.tierAttempts ?? [],
        ...(controllerTier() ? { controllerTier: controllerTier() } : {}),
        ...(state.semanticRuntime ? { semanticRuntime: state.semanticRuntime } : {}),
        planFrozen: state.resolvedPlan?.frozen === true,
        ...(state.terminalOutcome ? { terminalOutcome: state.terminalOutcome } : {}),
        outcome,
        activity: {
          // A kernel receipt has no authority to claim that a provider send
          // occurred. The local server supplies this from physical egress
          // receipts when it persists a live run.
          providerDispatches: count(activity?.providerDispatches, 0),
          toolCalls: count(activity?.toolCalls, toolCalls),
          executionAttempts: count(activity?.executionAttempts, outcome.executionAttempts),
          repairs: count(activity?.repairs, repairs),
        },
        toolDurationMs: state.observations.reduce((total, observation) => total + Math.max(0, observation.durationMs ?? 0), 0),
        finalStopReason,
      };
    },
  };
  activeToolKernels.set(state, kernel);
  return kernel;
}

/** Record a live host/tool observation against the shared V2 kernel. */
export function observeAskAgentV2Tool(state: AskAgentStateV4 | undefined, observation: AskToolObservationV1): AskToolObservationV1 | undefined {
  if (!state) return undefined;
  return createAskToolKernelV2(state).observe(observation);
}

/** Record the host's tuple-completeness verdict without treating cards as SQL authority. */
export function setAskV2TierState(
  state: AskAgentStateV4 | undefined,
  tier: AskExecutionTierV2,
  next: Omit<AskTierStateV1, 'version'>,
): AskTierStateV1 | undefined {
  if (!state) return undefined;
  const allowed = new Set(state.retainedCandidateIds);
  const value: AskTierStateV1 = {
    version: 1,
    ...next,
    candidateIds: [...new Set(next.candidateIds)].filter((id) => allowed.has(id)),
    ...(next.safeNextTools?.length ? { safeNextTools: [...new Set(next.safeNextTools)] } : {}),
    ...(next.clarificationChoices?.length
      ? {
          clarificationChoices: next.clarificationChoices.map((choice) => ({
            version: 1,
            id: choice.id,
            label: choice.label,
            candidateIds: [...new Set(choice.candidateIds)].filter((id) => allowed.has(id)),
            resultFingerprint: choice.resultFingerprint,
          })),
        }
      : {}),
  };
  state.tierStates = { ...state.tierStates, [tier]: value };
  return value;
}

/** Seal a V2 terminal without converting it into a legacy business verdict. */
export function finishAskAgentV2Turn(
  state: AskAgentStateV4 | undefined,
  outcome: AskAgentTerminalOutcomeV2,
): void {
  if (!state) return;
  state.terminalOutcome = outcome;
  state.terminal = outcome.kind === 'finish_answer'
    ? 'completed'
    : outcome.kind === 'clarification'
      ? 'clarification'
      : outcome.kind === 'denied'
        ? 'denied'
        : outcome.kind === 'budget_exhausted'
          ? 'budget_exhausted'
          : 'error';
}

/** A stale bridge must never become a second retrieval or a prompt source. */
export function askAgentV2WorkspaceMatches(
  state: AskAgentStateV4 | undefined,
  bridge: AskAgentRuntimeWorkspaceBridgeV2 | undefined,
): boolean {
  // Identity is optional only for older V2 state that did not persist it.  If
  // the state has an identity, a bridge which omits it is *not* a match: using
  // that bridge would silently replace the immutable retrieval snapshot.
  const snapshotMatches = !state?.snapshotId
    || (typeof bridge?.snapshotId === 'string' && bridge.snapshotId === state.snapshotId);
  const sourceMatches = !state?.sourceFingerprint
    || (typeof bridge?.sourceFingerprint === 'string' && bridge.sourceFingerprint === state.sourceFingerprint);
  return Boolean(
    state
    && bridge?.version === 2
    && typeof bridge.getContextPack === 'function'
    && snapshotMatches
    && sourceMatches,
  );
}

/**
 * Materialize Tier 1 tuple completeness from the immutable server workspace
 * before the first V2 tool policy is calculated.  The old fast-path-only
 * behavior exposed this truth only when there was one certified candidate,
 * allowing a semantic inspector to commit a lower tier while two complete
 * certified artifacts were present.  The workspace is the authority here;
 * provider cards and persisted controller state never create completeness.
 *
 * `certifiedExecutionAvailable` is deliberately host-provided rather than
 * inferred from an artifact card. A complete fit with no authorized local
 * executor is a pre-freeze unavailable observation, not a Tier 1 priority
 * trap. The provider adapter passes its actual execution callback; the engine
 * uses the bridge's host readiness hook for the zero-provider shortcut.
 */
export function materializeAskV2WorkspaceTierTruth(
  state: AskAgentStateV4 | undefined,
  bridge: AskAgentRuntimeWorkspaceBridgeV2 | undefined,
  reference?: {
    question?: string;
    selectedEvidenceId?: string;
    certifiedExecutionAvailable?: boolean;
  },
): AskAgentToolWorkspaceV2 | undefined {
  if (!state || !askAgentV2WorkspaceMatches(state, bridge)) return undefined;
  const workspace = bridge?.getToolWorkspace?.();
  if (!workspace || workspace.version !== 1
    || (state.snapshotId !== undefined && workspace.snapshotId !== state.snapshotId)
    || (state.sourceFingerprint !== undefined && workspace.sourceFingerprint !== state.sourceFingerprint)) return undefined;

  const retained = new Set(state.retainedCandidateIds);
  const candidatesById = new Map(
    workspace.candidates
      .map((candidate) => [candidate.qualifiedId ?? candidate.id, candidate] as const)
      .filter(([candidateId]) => retained.has(candidateId)),
  );
  const certifiedCandidateIds = [...candidatesById.entries()]
    .filter(([, candidate]) => candidate.kind === 'certified_block' && candidate.trustTier === 'certified')
    .map(([candidateId]) => candidateId);
  const completeFitCandidateIds = [...new Set(workspace.certifiedCompleteCandidateIds ?? [])]
    .filter((candidateId) => {
      const candidate = candidatesById.get(candidateId);
      return candidate?.kind === 'certified_block'
        && candidate.trustTier === 'certified';
    });
  const currentCompleteCandidateIds: string[] = [];
  let sawStaleArtifact = false;
  let sawUnboundArtifact = false;
  for (const candidateId of completeFitCandidateIds) {
    const value = workspace.certifiedArtifacts?.get(candidateId);
    if (!value || typeof value !== 'object') {
      sawUnboundArtifact = true;
      continue;
    }
    const handle = value as Partial<AskCertifiedArtifactHandleV1>;
    if (handle.version !== 1
      || typeof handle.revisionFingerprint !== 'string'
      || typeof handle.isCurrent !== 'function'
      || handle.artifact === undefined) {
      sawUnboundArtifact = true;
      continue;
    }
    try {
      if (!handle.isCurrent()) {
        sawStaleArtifact = true;
        continue;
      }
    } catch {
      sawStaleArtifact = true;
      continue;
    }
    currentCompleteCandidateIds.push(candidateId);
  }
  let bridgeCertifiedExecutionAvailable = false;
  if (reference?.certifiedExecutionAvailable !== undefined) {
    bridgeCertifiedExecutionAvailable = reference.certifiedExecutionAvailable === true;
  } else {
    try {
      bridgeCertifiedExecutionAvailable = bridge?.isCertifiedExecutionAvailable?.() === true;
    } catch {
      bridgeCertifiedExecutionAvailable = false;
    }
  }

  if (!state.resolvedPlan?.frozen) {
    if (bridgeCertifiedExecutionAvailable && currentCompleteCandidateIds.length > 0) {
      setAskV2TierState(state, 'certified', {
        status: 'complete',
        candidateIds: currentCompleteCandidateIds,
        reasonCode: workspace.tierStates?.certified?.reasonCode ?? 'CERTIFIED_COMPLETE_FOR_REQUEST',
        safeNextTools: ['run_certified'],
      });
    } else {
      const unavailable = completeFitCandidateIds.length > 0;
      const reasonCode = !bridgeCertifiedExecutionAvailable
        ? 'CERTIFIED_EXECUTOR_UNAVAILABLE'
        : sawStaleArtifact
          ? 'CERTIFIED_ARTIFACT_STALE'
          : sawUnboundArtifact
            ? 'CERTIFIED_ARTIFACT_NOT_BOUND_TO_SNAPSHOT'
            : certifiedCandidateIds.length > 0
              ? 'CERTIFIED_TUPLE_NOT_PROVEN_BY_SNAPSHOT'
              : 'CERTIFIED_CANDIDATES_EMPTY';
      setAskV2TierState(state, 'certified', {
        status: unavailable || sawStaleArtifact || sawUnboundArtifact || certifiedCandidateIds.length === 0
          ? 'unavailable'
          : 'ineligible',
        candidateIds: completeFitCandidateIds.length > 0 ? completeFitCandidateIds : certifiedCandidateIds,
        reasonCode,
      });
      // A persisted fast-path/plan/controller commitment is only an
      // optimization before freeze. Do not carry it into a workspace that no
      // longer has a current, executable certified artifact; doing so traps
      // semantic fallback behind stale Tier 1 evidence.
      delete state.exactCertifiedCandidateId;
      if (state.candidatePlan?.intendedTool === 'run_certified') delete state.candidatePlan;
      if (state.resolvedPlan?.tier === 'certified' && !state.resolvedPlan.frozen) delete state.resolvedPlan;
      if (state.controllerTier === 'certified') delete state.controllerTier;
    }
  }

  const exactReferences = new Set<string>();
  const addReference = (value: unknown): void => {
    if (typeof value !== 'string' || !value.trim()) return;
    const normalized = value.trim();
    if (candidatesById.has(normalized)) exactReferences.add(normalized);
  };
  addReference(reference?.selectedEvidenceId);
  const question = reference?.question ?? '';
  for (const candidate of candidatesById.values()) {
    // A textual bypass requires the exact canonical qualified ID, never a
    // display name, runtime name, alias, or an unqualified legacy ID.
    if (candidate.qualifiedId && question.includes(candidate.qualifiedId)) {
      exactReferences.add(candidate.qualifiedId);
    }
  }
  const explicitReferences: Array<NonNullable<AskAgentStateV4['explicitQualifiedArtifactReference']>> = [];
  for (const referenceId of exactReferences) {
    const candidate = candidatesById.get(referenceId);
    if (!candidate) continue;
    const candidateId = candidate.qualifiedId ?? candidate.id;
    if (candidate.qualifiedId !== candidateId) continue;
    if (askV2ExecutableSemanticRoles(candidate)) {
      explicitReferences.push({ version: 1, tier: 'semantic', candidateId });
      continue;
    }
    // Only a real DQL modeling artifact receives the Tier 1 exception.
    // dbt/schema/relationship cards remain retrieval context, not an
    // explicit executable DQL program.
    if (candidate.kind === 'dql_modeling') {
      explicitReferences.push({ version: 1, tier: 'governed_relational', candidateId });
    }
  }
  const explicit = explicitReferences.length === 1 ? explicitReferences[0] : undefined;
  if (!state.resolvedPlan?.frozen) {
    if (explicit) {
      state.explicitQualifiedArtifactReference = explicit;
    } else {
      delete state.explicitQualifiedArtifactReference;
      // Reloaded V4 state can retain a lower controller tier from a time when
      // Tier 1 completeness was not materialized.  Clear that pre-freeze
      // commitment so the next policy forces the certified inspection.
      if (currentCompleteCandidateIds.length > 0
        && bridgeCertifiedExecutionAvailable
        && state.controllerTier
        && state.controllerTier !== 'certified') {
        delete state.controllerTier;
      }
    }
  }
  return workspace;
}

export interface AskAgentRuntimeV2 extends AgentRouter {
  readonly mode: AskRuntimeModeV2;
}

export interface AskAgentRuntimeOptionsV2 {
  mode?: AskRuntimeModeV2;
  /** The sole V2 retrieval boundary for an ordinary natural-language turn. */
  getEvidence?: (request: AgentRunRequest) => AgentRetrievalEvidence | undefined | Promise<AgentRetrievalEvidence | undefined>;
  /** Explicit V1 rollback / shadow comparison only; V2 never uses it after serving. */
  legacyRouter: AgentRouter;
}

/**
 * Retrieval-first V2 ingress.  It deliberately does not prove a business
 * tuple or choose a compiler.  That choice is made by the bounded provider
 * tool runtime after it sees the immutable candidate workspace.
 */
export function createAskAgentRuntimeV2(options: AskAgentRuntimeOptionsV2): AskAgentRuntimeV2 {
  // Serving defaults to shadow until an operator explicitly enables the
  // canary.  V2 can observe an Ask in shadow, but it must never replace the
  // established answer path merely because a runtime was constructed.
  const mode = options.mode ?? 'shadow_v2';
  return {
    mode,
    async decide(request): Promise<IntentDecision> {
      if (!isAskRequestV2(request) || mode === 'legacy_v1') return options.legacyRouter.decide(request);

      const conversationalKind = classifyConversationalTurn(request.question, Boolean(request.history?.length || request.conversationContext));
      if (conversationalKind) {
        return {
          action: 'converse',
          category: 'conversational',
          conversationalKind,
          confidence: 1,
          followsUp: Boolean(request.history?.length),
          reason: 'This turn does not require analytical execution.',
          askAgentV2Decision: { version: 2, mode, state: emptyState(mode, 'general', request) },
        };
      }

      const turnClass = classifyTurnV2(request);
      const evidence = await options.getEvidence?.(request);
      const state = createState(mode, turnClass, request, evidence);
      applyHostCertifiedFastPath(state, request);
      const v2Decision = { version: 2 as const, mode, state };

      if (mode === 'shadow_v2') {
        const legacy = await options.legacyRouter.decide(request);
        return { ...legacy, askAgentV2Decision: v2Decision };
      }

      if (request.selectedResultBindingGap) {
        state.terminal = 'clarification';
        return {
          action: 'clarify',
          confidence: 1,
          followsUp: true,
          source: 'heuristic',
          reason: 'The selected prior result could not be rebound, so one specific member selection is required.',
          clarifyingQuestion: request.selectedResultBindingGap.message,
          requiresClarification: true,
          // The members the reference could have meant, when the host resolved
          // candidates but could not choose between them.
          ...(request.selectedResultBindingGap.options?.length
            ? { clarificationOptions: request.selectedResultBindingGap.options }
            : {}),
          askAgentV2Decision: v2Decision,
        };
      }

      // Explicit Research is the only ingress that changes branch budgets.
      if (turnClass === 'research') {
        return {
          action: 'investigate',
          confidence: 0.9,
          followsUp: Boolean(request.history?.length),
          source: 'heuristic',
          reason: 'Research was explicitly requested; the same immutable snapshot enters the bounded research tool runtime.',
          askAgentV2Decision: v2Decision,
          retrievalEvidence: retrievalProjection(evidence),
        };
      }

      // The key V2 cutover: zero candidate/coverage verdicts become context
      // for the agent, never a router-owned analytical coverage terminal.  The
      // bounded V2 tool runtime receives the same snapshot and performs the
      // certified -> semantic -> relational -> exploratory progression.
      return {
        action: 'answer',
        confidence: evidence ? 0.82 : 0.5,
        followsUp: Boolean(request.history?.length),
        source: 'llm',
        reason: evidence
          ? 'Retrieved an immutable role-balanced context workspace; the bounded Ask agent will choose and validate the next tool.'
          : 'No retrieval snapshot is currently available; the Ask agent may provide a general answer or report a typed availability observation.',
        askAgentV2Decision: v2Decision,
        retrievalEvidence: retrievalProjection(evidence),
      };
    },
  };
}

function createState(
  mode: AskRuntimeModeV2,
  turnClass: AskTurnClassV2,
  request: AgentRunRequest,
  evidence: AgentRetrievalEvidence | undefined,
): AskAgentStateV4 {
  const retained = (evidence?.candidates ?? []).slice(0, 128);
  const requirements = buildAnalyticalRequirementSet({ question: request.question, parsedIntent: evidence?.parsedIntent });
  const initial = selectRoleBalancedMeaningCandidates({ candidates: retained, requirements, maxCandidates: 24 });
  const initialIds = initial.map(stableCandidateId);
  const retainedIds = retained.map(stableCandidateId);
  const contextCoverage = contextCoverageForWorkspace(evidence, retained);
  return {
    version: 4,
    mode,
    turnClass,
    snapshotId: evidence?.snapshotId,
    sourceFingerprint: evidence?.sourceFingerprint,
    retainedCandidateIds: retainedIds,
    initialCandidateIds: initialIds,
    expansionCandidateIds: retainedIds.filter((id) => !initialIds.includes(id)).slice(0, 24),
    contextCoverage,
    excludedCandidateCount: Math.max(0, (evidence?.candidates.length ?? 0) - retained.length),
    exclusionReasonCodes: (evidence?.candidates.length ?? 0) > retained.length
      ? ['WORKSPACE_CANDIDATE_CAP']
      : [],
    relationshipPathHandles: (evidence?.relationshipPathHandles ?? [])
      .slice(0, 8)
      .map((path) => ({
        version: 1,
        id: path.id,
        edgeIds: path.edgeIds.slice(0, 12),
        ...(path.candidateIds?.length ? { candidateIds: path.candidateIds.slice(0, 24) } : {}),
        ...(evidence?.snapshotId ? { snapshotId: evidence.snapshotId } : {}),
      })),
    conversation: {
      version: 2,
      sourceTurnId: request.trustedTaskAnchor?.sourceTurnId,
      selectedMemberId: request.selectedResultBinding?.canonicalColumn,
      selectedMemberBinding: request.selectedResultBinding?.value,
      clarificationId: request.selectedEvidenceId,
      availableResultHandleIds: request.priorResultMemberBinding?.values.map((value, index) => `member:${index}:${fingerprint(value)}`) ?? [],
      ...(request.selectedResultBindingGap?.options?.length
        ? { ambiguousMemberLabels: request.selectedResultBindingGap.options.map((option) => option.label).slice(0, 8) }
        : {}),
    },
    observations: evidence ? [] : [{
      version: 1,
      tool: 'inspect_ask_context',
      outcome: 'unavailable',
      reasonCode: 'RETRIEVAL_SNAPSHOT_UNAVAILABLE',
      candidateIds: [],
      safeAction: 'refresh_metadata_or_answer_general_question',
    }],
    tierAttempts: [],
  };
}

/**
 * Promote exactly one host-proven certified artifact into the V2 Tier 1 fast
 * path.  This is not a second meaning resolver: completeness, admission, and
 * artifact capture are all supplied by the same immutable retrieval workspace
 * that the normal V2 tools consume.  Multiple candidates remain a provider
 * tool-runtime choice, and a missing/stale workspace never becomes a mutable
 * catalog lookup.
 */
function applyHostCertifiedFastPath(state: AskAgentStateV4, request: AgentRunRequest): void {
  const bridge = request.askAgentV2Workspace;
  const workspace = materializeAskV2WorkspaceTierTruth(state, bridge, {
    question: request.question,
    selectedEvidenceId: request.selectedEvidenceId,
    certifiedExecutionAvailable: (() => {
      try {
        return bridge?.isCertifiedExecutionAvailable?.() === true;
      } catch {
        return false;
      }
    })(),
  });
  if (state.mode !== 'authoritative_v2' || state.turnClass === 'research' || !workspace) return;
  const retained = new Set(state.retainedCandidateIds);
  const certifiedTier = state.tierStates?.certified;
  const complete = certifiedTier?.status === 'complete'
    ? [...new Set(certifiedTier.candidateIds)]
      .filter((candidateId) => retained.has(candidateId))
    : [];
  // A provider-free route is safe only for a unique immutable candidate.  Do
  // not choose between two valid blocks on the model's behalf or by ranking.
  if (complete.length !== 1) return;
  const candidateId = complete[0]!;
  state.exactCertifiedCandidateId = candidateId;
  state.candidatePlan = {
    version: 1,
    turnClass: state.turnClass,
    candidateIds: [candidateId],
    intendedTool: 'run_certified',
    requirementFingerprint: fingerprint([
      state.snapshotId ?? '',
      state.sourceFingerprint ?? '',
      'certified',
      candidateId,
    ].join('|')),
  };
  // Exact Tier 1 evidence must be visible to the compact workspace too. This
  // avoids a role-balanced card cap hiding the only provider-free execution
  // candidate while retaining all server-side candidates for normal fallback.
  state.initialCandidateIds = [candidateId, ...state.initialCandidateIds.filter((id) => id !== candidateId)].slice(0, 24);
  state.expansionCandidateIds = state.retainedCandidateIds
    .filter((id) => !state.initialCandidateIds.includes(id))
    .slice(0, 24);
  setAskV2TierState(state, 'certified', {
    status: 'complete',
    candidateIds: [candidateId],
    reasonCode: certifiedTier?.reasonCode ?? 'CERTIFIED_COMPLETE_FOR_REQUEST',
    safeNextTools: ['run_certified'],
  });
}

/**
 * Release a certified tier claim that turned out to be unprovable in flight.
 *
 * The fast path narrows the tool policy to `run_certified` and nothing else.
 * When the downstream admission/proof then refuses that one tool, the policy
 * used to have no exit: the turn looped run_certified → denied → finish
 * denied until the deadline, and the user saw a fabricated "validation"
 * message. The bridge now avoids taking an unprovable claim at all; this
 * release is the in-flight defense for anything the bridge could not know.
 */
export function releaseAskV2CertifiedTierLock(state: AskAgentStateV4, reasonCode: string): void {
  state.exactCertifiedCandidateId = undefined;
  if (state.candidatePlan?.intendedTool === 'run_certified') state.candidatePlan = undefined;
  if (state.controllerTier === 'certified') state.controllerTier = undefined;
  setAskV2TierState(state, 'certified', {
    status: 'available',
    candidateIds: state.tierStates?.certified?.candidateIds ?? [],
    reasonCode,
  });
}

/** Build a safe source-level explanation without persisting source contents. */
function contextCoverageForWorkspace(
  evidence: AgentRetrievalEvidence | undefined,
  retained: AgentEvidenceCandidate[],
): AskContextCoverageV2[] {
  if (!evidence) {
    return [{
      version: 2,
      source: 'business',
      status: 'unavailable',
      admittedCandidateCount: 0,
      excludedCandidateCount: 0,
      reasonCodes: ['RETRIEVAL_SNAPSHOT_UNAVAILABLE'],
    }];
  }

  const fullBySource = new Map<AskEvidenceHandleV1['source'], number>();
  const retainedBySource = new Map<AskEvidenceHandleV1['source'], number>();
  for (const candidate of evidence.candidates) {
    const source = sourceForCandidate(candidate);
    fullBySource.set(source, (fullBySource.get(source) ?? 0) + 1);
  }
  for (const candidate of retained) {
    const source = sourceForCandidate(candidate);
    retainedBySource.set(source, (retainedBySource.get(source) ?? 0) + 1);
  }

  const reported = new Map<AskEvidenceHandleV1['source'], ContextSourceCoverageV1>();
  for (const coverage of evidence.diagnostics?.sourceCoverage ?? []) {
    const source = coverage.source as AskEvidenceHandleV1['source'];
    reported.set(source, coverage);
  }
  const sources = new Set<AskEvidenceHandleV1['source']>([
    ...fullBySource.keys(),
    ...reported.keys(),
  ]);
  return [...sources].sort().map((source) => {
    const declared = reported.get(source);
    const fullCount = fullBySource.get(source) ?? 0;
    const admittedCandidateCount = retainedBySource.get(source) ?? 0;
    return {
      version: 2,
      source,
      status: declared?.status ?? (fullCount > 0 ? 'available' : 'empty'),
      admittedCandidateCount,
      excludedCandidateCount: Math.max(0, fullCount - admittedCandidateCount),
      // A human-readable source reason may contain customer-specific wording.
      // Persist only an allowlisted state code in the durable V2 receipt.
      reasonCodes: [declared ? `SOURCE_${declared.status.toUpperCase()}` : 'CANDIDATE_WORKSPACE'],
    };
  });
}

function emptyState(mode: AskRuntimeModeV2, turnClass: AskTurnClassV2, request: AgentRunRequest): AskAgentStateV4 {
  return createState(mode, turnClass, request, undefined);
}

function retrievalProjection(evidence: AgentRetrievalEvidence | undefined): IntentDecision['retrievalEvidence'] | undefined {
  if (!evidence) return undefined;
  return {
    snapshotId: evidence.snapshotId,
    sourceFingerprint: evidence.sourceFingerprint,
    continuityFingerprint: evidence.continuityFingerprint,
    candidateCount: Math.min(128, evidence.candidates.length),
    candidateIds: evidence.candidates.slice(0, 128).map(stableCandidateId),
    candidateTraceMetadata: evidence.candidates.slice(0, 128).flatMap((candidate) => {
      const roles = evidenceCandidateRoles(candidate);
      const role = roles[0];
      return role ? [{ candidateId: stableCandidateId(candidate), role, source: traceSourceForCandidate(candidate) }] : [];
    }),
  };
}

function sourceForCandidate(candidate: AgentEvidenceCandidate): AskEvidenceHandleV1['source'] {
  if (candidate.kind === 'certified_block') return 'certified';
  if (candidate.kind === 'semantic_metric' || candidate.kind === 'semantic_member') return 'semantic';
  if (candidate.kind === 'dql_modeling') return 'governed_relational';
  if (candidate.kind === 'dbt_model' || candidate.kind === 'dbt_source') return 'dbt_manifest';
  if (candidate.kind === 'sql_column' || candidate.kind === 'sql_table') return 'runtime_schema';
  return 'business';
}

/** Existing trace readers have a narrower source vocabulary than V2 handles. */
function traceSourceForCandidate(candidate: AgentEvidenceCandidate):
  | 'certified'
  | 'semantic'
  | 'governed_relational'
  | 'dbt_manifest'
  | 'runtime_schema'
  | 'vector'
  | 'conversation'
  | 'exploratory' {
  const source = sourceForCandidate(candidate);
  return source === 'business' ? 'exploratory' : source;
}

function stableCandidateId(candidate: AgentEvidenceCandidate): string {
  return candidate.qualifiedId ?? candidate.id;
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function classifyTurnV2(request: AgentRunRequest): AskTurnClassV2 {
  if (request.requestedMode === 'research') return 'research';
  if (request.selectedEvidenceId || request.clarificationSourceQuestion) return 'clarification_response';
  // An AMBIGUOUS prior-result reference is still a prior-result turn. The host
  // resolves candidates it cannot choose between into this gap; classifying
  // the turn as fresh analytics would frame the clarification as a brand-new
  // question and lose the very result it is asking about.
  if (request.selectedResultBinding || request.priorResultMemberBinding || request.selectedResultBindingGap) {
    return 'prior_result';
  }
  const question = request.question.toLowerCase();
  // "What is revenue for each customer?" is a grouped analytical request,
  // not a metadata definition. Definition routing stays warehouse-free only
  // when the wording has no aggregate, grouping, ranking, or entity shape.
  const analyticalShape = /\b(top|bottom|highest|lowest|total|count|sum|average|avg|revenue|sales|orders?|customers?|products?|regions?|by|per|each|every|for each|group(?:ed)?|trend|compare|rank)\b/.test(question);
  if (/\b(what is|define|definition|meaning of|explain)\b/.test(question)
    && /\b(metric|measure|dimension|model|block|revenue|customer)\b/.test(question)
    && !analyticalShape) return 'definition';
  if (/\b(why|business context|background|how does|tell me about)\b/.test(question) && !/\b(top|by |revenue|count|sum|average|sales|customer|product|region)\b/.test(question)) return 'business_context';
  if (/^(hi|hello|thanks|thank you|what can you do)\b/.test(question.trim())) return 'general';
  return 'analytics';
}

function isAskRequestV2(request: AgentRunRequest): boolean {
  return request.requestedMode === undefined
    || request.requestedMode === 'auto'
    || request.requestedMode === 'ask'
    || request.requestedMode === 'research';
}
