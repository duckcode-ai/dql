/**
 * READ-ONLY TYPES FOR PERSISTED RUNS.
 *
 * The authoritative V2 tool kernel is gone; the Ask pipeline serves every
 * turn. Runs persisted by that kernel still carry its V8 receipt and its
 * mode label, and the trace API, the Notebook inspector and the portable
 * export keep reading them. Nothing here executes; nothing new writes it.
 */
import type { EvidenceCandidateRoleV1, ResearchEvidenceLedgerV3 } from '../analytical-orchestration.js';

/** The runtime that produced a run. `authoritative_v2` is only ever read from persisted runs. */
export type AskRuntimeModeV2 = 'authoritative_v2' | 'pipeline_v3';

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
  | 'finish_answer'
  /**
   * The model-facing plan contract. One plan — measures, dimensions,
   * filters, time, ordering, a row bound — whose ids may name a certified
   * block, a semantic metric, or a `<relation>.<column>`; the HOST resolves
   * the tier and dispatches to the handler above, which is where the
   * kernel's gates apply. The kernel never lists it in a policy; the lane
   * projects the handlers' admission onto it.
   */
  | 'propose_plan';

export interface AskEvidenceHandleV1 {
  version: 1;
  id: string;
  role: EvidenceCandidateRoleV1;
  source: 'certified' | 'semantic' | 'governed_relational' | 'dbt_manifest' | 'runtime_schema' | 'vector' | 'conversation' | 'business';
  snapshotId?: string;
}

export type AskSemanticEngineV1 = 'native' | 'metricflow-cli' | 'dbt-cloud';

export interface AskSemanticRuntimeSelectionV1 {
  version: 1;
  preference: 'auto' | AskSemanticEngineV1;
  selectedEngine?: AskSemanticEngineV1;
  readiness: 'ready' | 'unavailable';
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
  /**
   * The HOST performed this inspection itself, before or instead of asking the
   * analyst to spend a turn on it. It is evidence, not an analyst action, so it
   * never consumes the tool budget.
   */
  hostObserved?: boolean;
  /**
   * Minted by the host floor: the plan the HOST composed and authorized after
   * the analyst's turn ended with nothing executed. Lets the kernel re-freeze
   * on a floor authorization when the analyst's frozen plan never reached the
   * warehouse; never set from a model tool call.
   */
  hostFloor?: boolean;
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

export interface AskCascadeTierAttemptV2 {
  version: 2;
  tier: AskExecutionTierV2;
  outcome: AskToolObservationOutcomeV1;
  reasonCode: string;
  candidateIds: string[];
  frozen: boolean;
  durationMs?: number;
}

export interface AskContextCoverageV2 {
  version: 2;
  source: AskEvidenceHandleV1['source'];
  status: 'available' | 'empty' | 'stale' | 'unavailable' | 'errored' | 'skipped';
  admittedCandidateCount: number;
  excludedCandidateCount: number;
  reasonCodes: string[];
}

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

/** The bounded Research ledger reader contract. Additive over V1–V3; still produced by the Research root. */
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

/** At most six receipt-backed hypothesis branches per Research root. */
export const RESEARCH_LEDGER_BRANCH_CAP = 6;

/**
 * Project the mixed V3 Research ledger into the V4 reader contract. A
 * projection, not a second planner: opaque receipt/fact identities and the
 * dedicated lineage marker survive; question text, SQL, rows, prompts and
 * provider material do not.
 */
export function projectResearchEvidenceLedgerV4(ledger: ResearchEvidenceLedgerV3): ResearchEvidenceLedgerV4 {
  return {
    version: 4,
    rootQuestionFingerprint: ledger.rootQuestionFingerprint,
    ...(ledger.snapshotId ? { snapshotId: ledger.snapshotId } : {}),
    branches: ledger.entries.slice(0, RESEARCH_LEDGER_BRANCH_CAP).map((entry) => ({
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
