/**
 * Ask Analyst Runtime V1
 *
 * This is the authoritative entrypoint for an analytical Ask turn.  It owns
 * the typed business frame, bounded mission, same-snapshot evidence workspace,
 * route-neutral program, and durable continuation state.  The existing hybrid
 * router is deliberately used only as a compiler broker: it may select a safe
 * certified/MetricFlow/governed-relational/exploratory compiler for this
 * program, but it must not retrieve a second snapshot or reinterpret the
 * question outside the frame created here.
 *
 * The runtime does not expose or persist prompts, SQL, provider payloads, rows,
 * credentials, or hidden reasoning.  Those remain inside existing local
 * execution boundaries and the advanced local trace respectively.
 */

import { createHash } from 'node:crypto';
import { classifyConversationalTurn, decideAgentAction, type AskAnalystTaskExecutionV1, type IntentDecision } from '../intent-controller.js';
import type { AgentRouter, AgentRunPlan, AgentRunRequest, AgentRunRoute } from '../agent-run-engine.js';
import {
  attributionRequiredRelationshipGapDecision,
  bindAskAnalystProgramMeaningV1,
  compileAskAnalyticalProgramV1,
  recordAskCandidateLifecycleV1,
  relationshipSafetyProofSelectionForCandidateV1,
} from '../router.js';
import {
  mergeMeaningResolutionWithRequirementSeed,
  questionTypeFromText,
  certifiedCandidateDeclaredDimensionOutput,
  certifiedCandidateGrainDimensionOutputs,
  certifiedCandidateExplicitlyCoversMeasures,
  validateMeaningResolution,
  type AgentEvidenceCandidate,
  type AgentRetrievalEvidence,
  type MeaningResolution,
} from '../meaning-resolution.js';
import {
  proveSameSnapshotMetricflowRoleExtensionV1,
  resolveMetricCapabilityDimension,
} from '../analytical-frame.js';
import {
  buildAnalyticalRequirementSet,
  buildAnalyticalRequirementSeedV1,
  withAnalyticalPriorResultMemberBinding,
  buildAnalyticalTaskGraph,
  classifyProviderFailure,
  candidateMatchesCategoricalDimensionRequirement,
  evidenceCandidateRoles,
  inferAnalyticalTurnKind,
  selectRoleBalancedMeaningCandidates,
  selectRoleBalancedWorkspaceCandidates,
  type AnalyticalHypothesisV1,
  type AnalyticalMissionV1,
  type AnalyticalProgram,
  type AnalyticalProgramV2,
  type AnalyticalPlannerCandidateCardV1,
  type AnalyticalPlannerProposalV1,
  type AnalyticalPlannerRequestV1,
  type AnalyticalPlannerTaskProposalV1,
  type AnalyticalPlannerOperationV1,
  type AskPlanningModeV1,
  type ProgramVerificationFeedbackV1,
  type AnalyticalRequirementSetV1,
  type AskAnalystRuntimeModeV1,
  type AskAnalystState,
  type AskAnalystStateV2,
  type BusinessQuestionFrameV4,
  type ContextSourceCoverageV1,
  type EvidenceCandidateRoleV1,
  type EvidenceWorkspaceV1,
  type EvidenceWorkspaceV2,
  type TargetedContextRequestV1,
  type TargetedContextResultV1,
  type ResolvedAnalyticalPlanV2,
} from '../analytical-orchestration.js';

export interface AskAnalystRuntimeOptionsV1 {
  /** Whole-runtime migration switch. Shadow records state but never double-executes. */
  mode?: AskAnalystRuntimeModeV1;
  /** The one retrieval boundary for an authoritative Ask run. */
  getEvidence?: (request: AgentRunRequest) => AgentRetrievalEvidence | undefined | Promise<AgentRetrievalEvidence | undefined>;
  /** Existing safe router/compiler chain. It receives the runtime frame + snapshot. */
  compilerBroker: AgentRouter;
  /**
   * One bounded, candidate-ID-only meaning call.  The runtime invokes this
   * service during framing; the compiler broker is never allowed to invoke it.
   */
  resolveMeaning?: (input: {
    request: AgentRunRequest;
    evidence: AgentRetrievalEvidence;
    candidates: AgentEvidenceCandidate[];
    requirementSeed: ReturnType<typeof buildAnalyticalRequirementSeedV1>;
  }) => Promise<MeaningResolution | undefined>;
  /**
   * The authoritative ordinary-Ask planning boundary. The planner receives a
   * bounded, role-labelled package and may return only candidate IDs plus
   * typed operations/role bindings. It cannot return SQL, trust, joins, or a
   * frozen route. `resolveMeaning` remains a narrow compatibility adapter for
   * hosts that have not yet moved their provider prompt to this contract.
   */
  planAnalytical?: (input: {
    request: AgentRunRequest;
    evidence: AgentRetrievalEvidence;
    candidates: AgentEvidenceCandidate[];
    requirementSeed: ReturnType<typeof buildAnalyticalRequirementSeedV1>;
    plannerRequest: AnalyticalPlannerRequestV1;
    feedback?: import('../analytical-orchestration.js').ProgramVerificationFeedbackV1;
  }) => Promise<AnalyticalPlannerProposalV1 | undefined>;
  /**
   * Host-only compatibility seam for offline fixtures and deliberate local
   * provider-free deployments. When enabled, one uniquely exact semantic
   * measure may bind without a meaning call. It never resolves competing
   * display/entity meanings, filters, joins, or a missing measure.
   */
  allowDeterministicNaturalLanguageBinding?: boolean;
  now?: () => number;
}

export interface AskAnalystRuntimeV1 extends AgentRouter {
  readonly mode: AskAnalystRuntimeModeV1;
}

const MAX_ASK_TASKS = 3;
const MAX_RESEARCH_TASKS = 6;
const MAX_TOOLS = 12;
const MAX_PLANNING_CONTINUATIONS = 2;
/** Initial planner package; never widened or re-ranked during a revision. */
const MAX_INITIAL_PLANNER_CANDIDATES = 16;
/** Verifier-owned additions released only for one targeted revision. */
const MAX_TARGETED_CONTEXT_CANDIDATES = 4;
/** Immutable initial package plus the one bounded targeted extension. */
const MAX_REVISION_SELECTION_CANDIDATES = MAX_INITIAL_PLANNER_CANDIDATES + MAX_TARGETED_CONTEXT_CANDIDATES;
/**
 * Admission-only marker carried on a compact planner card. It deliberately
 * does not assert an alias or selected business meaning: the planner may
 * nominate the card, and the deterministic verifier then proves either an
 * exact/declared match or one unique review-required substitution.
 */
const UNRESOLVED_ROLE_ADMISSION_PREFIX = 'candidate_for_unresolved_role';
/**
 * A qualified ordinary field is never a lexical alias for a business term.
 * When the bounded package retains exactly one safe/reachable field for that
 * term, however, record the host-proven substitution explicitly.  The
 * compiler still receives a review-required plan and revalidates every
 * relationship/semantic capability after the planner binds this card.
 */
const UNIQUE_INFERRED_ROLE_SUBSTITUTION_PREFIX = 'unique_inferred_role_substitution';

/** Build the single authoritative Ask entrypoint. */
export function createAskAnalystRuntimeV1(options: AskAnalystRuntimeOptionsV1): AskAnalystRuntimeV1 {
  const mode = options.mode ?? 'authoritative';
  return {
    mode,
    async decide(request: AgentRunRequest): Promise<IntentDecision> {
      // Non-Ask surfaces intentionally remain on their own entrypoints. Ask
      // includes explicit Research because Research composes bounded child Asks
      // through the same runtime.
      if (!isAskRequest(request) || mode === 'legacy') {
        return options.compilerBroker.decide(request);
      }
      const base = runtimeBaseDecision(request);
      // Deterministic conversation/app classification is intentionally outside
      // the analytical runtime. It never needs retrieval or an LLM meaning
      // call, and returning it here prevents a greeting from becoming a false
      // coverage gap simply because no metadata snapshot was needed.
      if (base.action === 'converse' || base.action === 'compose_app') return base;
      // A plural prior-result reference is an explicit bounded-set operation,
      // not an invitation to rerun the question over all members. The host
      // sets this only after rebuilding its persisted local thread; client
      // input cannot manufacture it. Stop before retrieval/planning when the
      // result's entity/display set was intentionally absent or redacted.
      if (request.selectedResultBindingGap) {
        const requirements = buildAnalyticalRequirementSet({ question: request.question });
        const frame = buildBusinessQuestionFrame(request, requirements);
        const requirementSeed = buildAnalyticalRequirementSeedV1({
          question: request.question,
          requirements,
        });
        const mission = buildMission(request, requirements, frame.kind, requirementSeed);
        const workspace: EvidenceWorkspaceV2 = {
          version: 2,
          sourceCoverage: [],
          workspaceCandidateIds: [],
          plannerCandidateIds: [],
          admittedCandidateIds: [],
          excludedCandidates: [],
          tools: [{
            version: 1,
            id: 'tool:prior_result_binding',
            kind: 'candidate_extension',
            status: 'failed',
            candidateIds: [],
            reasonCode: request.selectedResultBindingGap.code,
          }],
        };
        const program = buildProgram(frame, mission, [], [], requirementSeed, {
          planningMode: 'deterministic_binding',
        });
        const state = transitionState(buildState({
          mode,
          phase: 'framed',
          frame,
          mission,
          workspace,
          program,
        }), 'clarify', {
          planningReceipt: {
            version: 1,
            mode: 'deterministic_binding',
            plannerCalls: 0,
            revisionCalls: 0,
            verification: {
              version: 1,
              status: 'invalid',
              missingRoles: ['member'],
              candidateIds: [],
              reasonCode: request.selectedResultBindingGap.code,
            },
          },
        });
        checkpoint(request, state);
        return {
          ...base,
          action: 'clarify',
          category: 'unclear',
          confidence: 1,
          followsUp: true,
          source: 'heuristic',
          reason: request.selectedResultBindingGap.message,
          requiresClarification: true,
          clarifyingQuestion: request.selectedResultBindingGap.message,
          clarificationOptions: [],
          askAnalystDecision: { version: 1, mode, state },
        };
      }
      // Shadow is observational only. Preserve the legacy router request and
      // its exact execution behavior; record a bounded, non-authoritative
      // runtime proposal without acquiring a second snapshot or provider call.
      if (mode === 'shadow') {
        const requirements = buildAnalyticalRequirementSet({ question: request.question });
        const frame = buildBusinessQuestionFrame(request, requirements);
        const requirementSeed = buildAnalyticalRequirementSeedV1({
          question: request.question,
          requirements,
        });
        const mission = buildMission(request, requirements, frame.kind, requirementSeed);
        const workspace: EvidenceWorkspaceV2 = {
          version: 2,
          sourceCoverage: [],
          workspaceCandidateIds: [],
          plannerCandidateIds: [],
          admittedCandidateIds: [],
          excludedCandidates: [],
          tools: [{
            version: 1,
            id: 'tool:shadow_proposal',
            kind: 'compiler_broker',
            status: 'skipped',
            candidateIds: [],
            reasonCode: 'shadow_preserves_legacy_decision',
          }],
        };
        const program = buildProgram(frame, mission, [], [], requirementSeed);
        const state = transitionState(buildState({ mode, phase: 'framed', frame, mission, workspace, program }), 'program_ready');
        checkpoint(request, state);
        const legacyDecision = await options.compilerBroker.decide(request);
        return {
          ...legacyDecision,
          askAnalystDecision: { version: 1, mode, state },
        };
      }

      const toolReceipts: EvidenceWorkspaceV1['tools'] = [];
      let evidence: AgentRetrievalEvidence | undefined;
      try {
        evidence = options.getEvidence ? await options.getEvidence(request) : undefined;
        toolReceipts.push({
          version: 1,
          id: 'tool:retrieve_snapshot',
          kind: 'retrieve_snapshot',
          status: evidence ? 'completed' : 'skipped',
          candidateIds: stableCandidateIds(evidence?.candidates ?? []),
          reasonCode: evidence ? 'snapshot_acquired' : 'broker_retrieval_required',
        });
      } catch {
        // Retrieval error is an evidence state, not a user ambiguity. The safe
        // compiler broker may still return its existing typed unavailable result.
        toolReceipts.push({
          version: 1,
          id: 'tool:retrieve_snapshot',
          kind: 'retrieve_snapshot',
          status: 'failed',
          candidateIds: [],
          reasonCode: 'snapshot_retrieval_failed',
        });
      }

      const canonicalSelections = evidence
        ? canonicalIdentifierSet(request.question, evidence.candidates)
        : [];
      const parsedIntent = canonicalSelections.length > 0
        ? {
            ...evidence?.parsedIntent,
            measures: [...new Set([
              ...(evidence?.parsedIntent?.measures ?? []),
              ...canonicalSelections.map((candidate) => candidate.name),
            ])],
          }
        : evidence?.parsedIntent;
      // A server-owned child Ask (for example, a bounded Research branch) may
      // carry a typed seed. Public request parsers never hydrate this field.
      // Ordinary Ask still starts from the current question and retrieval
      // refinement only.
      const inferredRequirements = request.hostRequirementSeed?.requirements ?? buildAnalyticalRequirementSet({
        question: request.question,
        parsedIntent,
      });
      // The retrieval/parser frame is useful for admission, but it must not
      // become a hidden execution authority. Rebuild the planner-facing
      // business roles from current-question literals, retaining only
      // question-grounded refinements. This is what lets a bounded planner
      // repair an inherited `owner email`/wrong metric selection with
      // qualified Customer/Revenue/Region cards.
      // A selected prior-result cell has already been validated by the local
      // host. Preserve it as a typed requirement before retrieval/planning:
      // reparsing "Which region does she belong to?" alone must not discard
      // the customer predicate and widen the follow-up to every customer.
      const requirements = withAnalyticalPriorResultMemberBinding(
        requirementsForPlannerVerification(inferredRequirements, request.question, parsedIntent),
        request.priorResultMemberBinding ?? inferredRequirements.priorResultMemberBinding,
      );
      // The deterministic seed preserves user-owned filter/time literals, but
      // it is advisory for business metric/entity/dimension interpretation.
      // A stale inherited rank metric must not evict every differently-named
      // metric from the provider's bounded package before the planner has a
      // chance to correct it with a locally-proven card.  Explicit measures
      // written in this question remain protected from correlated variants.
      const admissionRequirements = requirementsForPlannerAdmission(requirements, request.question);
      const frame = buildBusinessQuestionFrame(request, requirements);
      const requirementSeed = request.hostRequirementSeed ?? buildAnalyticalRequirementSeedV1({
        question: request.question,
        parsedIntent,
        requirements,
        ...(evidence?.fiscalCalendar ? { fiscalCalendar: evidence.fiscalCalendar } : {}),
      });
      const mission = buildMission(request, requirements, frame.kind, requirementSeed);
      // The raw source pool is immutable retrieval backing only.  Before any
      // provider call, own a role-balanced 32-card execution workspace and
      // then release at most 16 of those qualified cards to the planner.  A
      // relevance-only truncation here used to lose product/order evidence
      // while retaining a crowd of correlated revenue variants.
      // A snapshot may carry a qualified MetricFlow child (`location_name`)
      // for a business role the user named (`region`).  Recover that narrow
      // same-snapshot declaration before either bounded admission layer.  It
      // is not a lexical alias: the helper below only derives it from the
      // selected metric's authored capability and keeps the review boundary.
      // That matters under a full 16-card package: without this replacement,
      // `location_name` is relevance-pruned before the planner can bind the
      // requested output even though the safe customer-to-location path is
      // already present.
      const sameSnapshotRoleExtensionAdmission = evidence
        ? sameSnapshotRoleExtensionAdmissionForRequirements({
            candidates: evidence.candidates,
            clarificationCandidates: evidence.clarificationCandidates ?? [],
            requirements: admissionRequirements,
          })
        : { candidates: [], ambiguities: [], rejectedCandidateIds: [] };
      const roleQualifiedSnapshotExtensions = sameSnapshotRoleExtensionAdmission.candidates;
      // An extension wrapper is host-authored capability evidence, not an
      // advisory alias. If a retrieved card carries one for the current role
      // but it no longer proves against a current metric capability, keep it
      // out of both workspace/planner admission. Retaining its raw card would
      // let a stale extension bypass this proof through ordinary lexical role
      // balancing and falsely inflate role coverage.
      const snapshotCandidates = evidence
        ? evidence.candidates.filter((candidate) => !sameSnapshotRoleExtensionAdmission.rejectedCandidateIds
          .includes(stableCandidateId(candidate)))
        : [];
      const admissionSnapshotCandidates = evidence
        ? snapshotCandidatesWithRoleExtensions(snapshotCandidates, roleQualifiedSnapshotExtensions)
        : [];
      const relationshipClosureTargets = evidence
        ? relationshipClosureTargetsForRequirements(admissionSnapshotCandidates, admissionRequirements)
        : undefined;
      const relationshipClosureReceipt: BoundedRelationshipClosureReceiptV1 = evidence
        && (admissionRequirements.dimensions.length > 1 || admissionRequirements.entityTerms.length > 0)
        ? boundedRelationshipClosureReceipt(
          admissionSnapshotCandidates,
          targetRelationshipPathIds(admissionSnapshotCandidates, admissionRequirements),
          relationshipClosureTargets,
        )
        : {
            candidates: [],
            endpointClosureRequired: false,
            endpointClosureComplete: true,
          };
      const requiredRelationshipClosure = relationshipClosureReceipt.candidates;
      // Relationship cards are structural proof, not three independent
      // business choices.  The planner must select one complete, host-owned
      // path card so the 16-card cap cannot retain a downstream location edge
      // and an unrelated bridge while dropping the bound customer edge.  The
      // raw closure stays in the 32-card execution workspace and is expanded
      // there by the existing compiler boundary; this compact card never
      // authorizes a join by itself.
      const relationshipPathPlannerCard = relationshipClosureReceipt.endpointClosureComplete
        ? plannerRelationshipPathCard(requiredRelationshipClosure)
        : undefined;
      const roleBalancedWorkspace = evidence
        ? withExecutionSupportCandidates({
          workspace: selectRoleBalancedWorkspaceCandidates({
              candidates: admissionSnapshotCandidates,
              requirements: admissionRequirements,
            }),
            snapshotCandidates: admissionSnapshotCandidates,
            requirements: admissionRequirements,
            relationshipClosure: requiredRelationshipClosure,
          })
        : [];
      // A provider is useful for unresolved business language, not a required
      // gate in front of a program that the snapshot can already prove.  Keep
      // this deliberately narrow: an exact certified contract or a single
      // qualified physical relation must cover every requested output without
      // a join.  Anything with competing meanings, a missing field, or a
      // relationship composition remains eligible for the bounded planner.
      const structuredContinuationBinding = evidence && request.selectedEvidenceId
        ? deterministicStructuredContinuationBinding({
            request,
            evidence,
            requirements,
            requirementSeed,
            relationshipClosure: requiredRelationshipClosure,
          })
        : undefined;
      const deterministicBinding = structuredContinuationBinding ?? (evidence
        ? deterministicUniqueProgramBinding({
            request,
            evidence,
            requirements,
            requirementSeed,
            allowDeterministicNaturalLanguageBinding: options.allowDeterministicNaturalLanguageBinding === true,
          })
        : undefined);
      // Explicit canonical references are stable identity bindings. Retain the
      // complete compatible set before role-balanced fill so two explicitly
      // named metrics cannot collapse into one provider/clarification choice.
      let workspaceCandidates = ensureWorkspaceCandidatePresence({
        workspace: roleBalancedWorkspace,
        required: [
          ...canonicalSelections,
          ...(deterministicBinding?.candidates ?? []),
          ...requiredRelationshipClosure,
          ...roleQualifiedSnapshotExtensions,
        ],
        requirements: admissionRequirements,
      });
      // Ordinary fallbacks may use a same-entity field without a relationship
      // only when the snapshot proves that entity identity canonically.  Do
      // not let an incidental `customer` token in a field alias, ID, or source
      // object turn an otherwise cross-entity request into a same-entity one.
      const ordinaryRoleEntityContext = canonicalOrdinaryRoleEntityContext({
        candidates: workspaceCandidates,
        requirements: admissionRequirements,
        selectedStructuredEntityBindings: [
          ...canonicalSelections,
          ...(deterministicBinding?.candidates ?? []),
        ],
        // A metric identity is authority only after this Ask has selected it
        // (canonical reference or deterministic binding), or when retrieval
        // proves one exact metric.  Do not union capability entities from
        // every lexical `revenue` candidate: billing revenue and CRM revenue
        // may share a human measure word while requiring different joins.
        selectedMetricBindings: [
          ...canonicalSelections,
          ...(deterministicBinding?.candidates ?? []),
        ],
      });
      const roleBalanced = selectRoleBalancedMeaningCandidates({
        candidates: workspaceCandidates,
        requirements: admissionRequirements,
        maxCandidates: MAX_INITIAL_PLANNER_CANDIDATES,
      });
      // Once a complete bounded relationship closure has a host-owned path
      // card, do not spend planner slots on individual edges.  Keeping both
      // representations would let relevance/card caps split the path again;
      // execution still receives the original edges from `workspaceCandidates`.
      const plannerRoleBalanced = relationshipPathPlannerCard
        ? uniqueCandidates([
            ...roleBalanced.filter((candidate) => !isRelationshipClosureCandidate(candidate)),
            // Filtering raw closure edges out of the initial role-balanced
            // projection must not silently shrink a full 16-card planner
            // package. Backfill only with already-admitted non-relationship
            // workspace cards; the path unit remains the sole relationship
            // representation and no new source or authority is introduced.
            ...workspaceCandidates.filter((candidate) => !isRelationshipClosureCandidate(candidate)),
          ]).slice(0, MAX_INITIAL_PLANNER_CANDIDATES)
        : roleBalanced;
      // The compact planner package has a different job from the broader
      // execution workspace.  After exact identity pins and the one atomic
      // relationship-path card, reserve one qualified card for every
      // unresolved requested role before relevance fillers.  In particular,
      // a role-proven `location_name` must not be displaced by high-scoring
      // context just because `region` did not appear in its physical name.
      let admitted = admitRoleBalancedPlannerCandidates({
        exactPins: [
          ...canonicalSelections,
          ...(deterministicBinding?.candidates ?? []),
          ...plannerRoleBalanced.filter((candidate) => candidate.exactMatch
            && candidateSupportsRequiredRole(candidate, admissionRequirements)),
        ],
        relationshipPath: relationshipPathPlannerCard,
        rawRelationshipClosure: requiredRelationshipClosure,
        relationshipClosureComplete: relationshipClosureReceipt.endpointClosureComplete,
        ordinaryRoleEntityContext,
        roleBalancedCandidates: plannerRoleBalanced,
        workspaceCandidates,
        requirements: admissionRequirements,
        // A server-issued choice is a stable identity handoff, not a second
        // natural-language interpretation. If that selected card is the
        // unresolved categorical role, keep the competing fallback cards out
        // of the planner package on the continuation turn. The compiler still
        // rechecks the chosen qualified identity and all relationship proof.
        structuredSelectedEvidenceId: structuredContinuationBinding && request.selectedEvidenceId
          ? request.selectedEvidenceId
          : undefined,
      });
      // Keep a sole qualified ordinary field distinguishable from a genuine
      // ambiguity before the planner is called.  This does not select an
      // execution route or silently rename the user's business term: it is a
      // typed, same-snapshot substitution receipt that the planner must still
      // bind and the verifier/compiler must still prove.  Without this
      // promotion a lone `location_name` card remained an "alternative" and
      // malformed/legacy planner output could ask targeted retrieval for the
      // already-admitted `region` role.
      admitted = promoteUniqueOrdinaryRoleInferenceCandidates({
        admitted,
        workspaceCandidates,
        requirements: admissionRequirements,
        relationshipClosure: requiredRelationshipClosure,
        relationshipClosureComplete: relationshipClosureReceipt.endpointClosureComplete,
        ordinaryRoleEntityContext,
        relationshipPath: relationshipPathPlannerCard,
      });
      // The original 16-card planner package stays immutable for the entire
      // ordinary Ask turn. A verifier-directed recovery may release <=4
      // *additional* cards for one revision, but it must never make room by
      // evicting a previously visible/selected card from this package.
      let verificationCandidates = admitted;
      // The runtime owns admission, so it must also emit the actual
      // retrieval-to-admission lifecycle. Reusing the projection keeps the
      // full trace and the right-side receipt consistent without making trace
      // code another routing authority.
      // Lifecycle telemetry observes the immutable prequalification pool, not
      // the 32-item workspace. A candidate pruned before workspace admission
      // is still useful diagnostic evidence (for example an explicit metric
      // excluded for a conflicting ranking role), but it must never become a
      // workspace, planner, or execution candidate merely because it was
      // recorded. The workspace/plan caps remain enforced below.
      if (evidence) recordAskCandidateLifecycleV1(request, evidence, evidence.candidates, admitted);
      let workspace = buildEvidenceWorkspace(evidence, workspaceCandidates, admitted, toolReceipts, admissionRequirements);
      let program = buildProgram(frame, mission, admitted, workspaceCandidates, requirementSeed, {
        planningMode: deterministicBinding ? 'deterministic_binding' : canonicalSelections.length > 0 ? 'exact_fast_path' : 'initial_planner',
      });
      const framedState = buildState({
        mode,
        phase: 'framed',
        frame,
        mission,
        workspace,
        program,
      });
      checkpoint(request, framedState);
      const evidenceReadyState = evidence
        ? transitionState(framedState, 'evidence_ready')
        : framedState;
      checkpoint(request, evidenceReadyState);
      let initialState = transitionState(evidenceReadyState, 'program_ready');
      checkpoint(request, initialState);

      // Two qualified display labels can both be executable for the same
      // metric while still producing materially different business answers.
      // For a generic request such as "top names by revenue", compiling both
      // labels as one group-by tuple is neither a smart default nor a missing
      // metadata problem.  Stop before the planner/compiler boundary and
      // persist the server-issued choices so a restart-safe click can bind the
      // selected MetricFlow dimension without reparsing the question.
      //
      // This deliberately examines only the tiny deterministic binding, not
      // the 32-card workspace. A relevance-pruned or unrelated candidate may
      // never manufacture a clarification option.
      const displayKeyAmbiguity = !structuredContinuationBinding
        ? deterministicDisplayKeyAmbiguity({
            question: request.question,
            binding: deterministicBinding,
          })
        : undefined;
      const inferredRoleAmbiguity = !structuredContinuationBinding
        ? sameSnapshotRoleAmbiguityForClarification(sameSnapshotRoleExtensionAdmission.ambiguities)
        : undefined;
      // Ordinary qualified fields (for example Location Name and Country
      // Name) are deliberately admitted as candidates for the unresolved
      // business term `region`, not silently treated as aliases. If more than
      // one safe/reachable field survived the bounded role reservation, stop
      // before provider planning. Otherwise the planner could pick one by
      // relevance and turn a real business ambiguity into a false answer.
      const ordinaryRoleInferenceAmbiguity = !structuredContinuationBinding
        ? ordinaryRoleInferenceAmbiguityForClarification({
            candidates: workspaceCandidates,
            requirements: admissionRequirements,
            relationshipClosure: requiredRelationshipClosure,
            relationshipClosureComplete: relationshipClosureReceipt.endpointClosureComplete,
            ordinaryRoleEntityContext,
          })
        : undefined;
      const ordinaryRoleRelationshipGap = !structuredContinuationBinding
        ? ordinaryRoleRelationshipCoverageGap({
            candidates: workspaceCandidates,
            requirements: admissionRequirements,
            relationshipClosure: requiredRelationshipClosure,
            relationshipClosureComplete: relationshipClosureReceipt.endpointClosureComplete,
            ordinaryRoleEntityContext,
          })
        : undefined;
      if (displayKeyAmbiguity) {
        const clarificationState = transitionState(initialState, 'clarify', {
          planningMode: 'deterministic_binding',
          workspace: {
            ...initialState.workspace,
            tools: [...initialState.workspace.tools, {
              version: 1 as const,
              id: 'tool:planner',
              kind: 'provider_meaning' as const,
              status: 'skipped' as const,
              candidateIds: displayKeyAmbiguity.options.map((option) => option.id),
              reasonCode: 'deterministic_display_key_ambiguity',
            }].slice(0, MAX_TOOLS),
          },
          planningReceipt: {
            version: 1,
            mode: 'deterministic_binding',
            plannerCalls: 0,
            revisionCalls: 0,
            verification: {
              version: 1,
              status: 'ambiguous',
              missingRoles: ['entity_label'],
              candidateIds: displayKeyAmbiguity.options.map((option) => option.id),
              reasonCode: 'deterministic_display_key_ambiguity',
            },
          },
        });
        checkpoint(request, clarificationState);
        return {
          ...base,
          action: 'clarify',
          confidence: 1,
          followsUp: true,
          category: 'unclear',
          source: 'heuristic',
          reason: 'Two executable business display keys would produce different top-revenue results. Choose the intended name once; no query was executed.',
          requiresClarification: true,
          clarifyingQuestion: displayKeyAmbiguity.question,
          clarificationOptions: displayKeyAmbiguity.options,
          meaningResolution: deterministicBinding?.resolution,
          retrievalEvidence: runtimeRetrievalEvidence(evidence, workspaceCandidates),
          askAnalystDecision: { version: 1, mode, state: clarificationState },
        };
      }

      if (inferredRoleAmbiguity) {
        const clarificationState = transitionState(initialState, 'clarify', {
          workspace: {
            ...initialState.workspace,
            tools: [...initialState.workspace.tools, {
              version: 1 as const,
              id: 'tool:planner',
              kind: 'provider_meaning' as const,
              status: 'skipped' as const,
              candidateIds: inferredRoleAmbiguity.options.map((option) => option.id),
              reasonCode: 'same_snapshot_role_extension_ambiguous',
            }].slice(0, MAX_TOOLS),
          },
          planningReceipt: {
            version: 1,
            mode: 'deterministic_binding',
            plannerCalls: 0,
            revisionCalls: 0,
            verification: {
              version: 1,
              status: 'ambiguous',
              missingRoles: ['categorical_dimension'],
              candidateIds: inferredRoleAmbiguity.options.map((option) => option.id),
              reasonCode: 'same_snapshot_role_extension_ambiguous',
            },
          },
        });
        checkpoint(request, clarificationState);
        return {
          ...base,
          action: 'clarify',
          confidence: 1,
          followsUp: true,
          category: 'unclear',
          source: 'heuristic',
          reason: 'More than one safe same-snapshot geography mapping could answer this request. Choose the intended business field once; no query was executed.',
          requiresClarification: true,
          clarifyingQuestion: inferredRoleAmbiguity.question,
          clarificationOptions: inferredRoleAmbiguity.options,
          retrievalEvidence: runtimeRetrievalEvidence(evidence, workspaceCandidates),
          askAnalystDecision: { version: 1, mode, state: clarificationState },
        };
      }

      if (ordinaryRoleInferenceAmbiguity) {
        const clarificationState = transitionState(initialState, 'clarify', {
          workspace: {
            ...initialState.workspace,
            roleCoverage: roleCoverageWithOrdinaryInferenceAmbiguity(
              initialState.workspace.roleCoverage,
              ordinaryRoleInferenceAmbiguity,
            ),
            tools: [...initialState.workspace.tools, {
              version: 1 as const,
              id: 'tool:planner',
              kind: 'provider_meaning' as const,
              status: 'skipped' as const,
              candidateIds: ordinaryRoleInferenceAmbiguity.options.map((option) => option.id),
              reasonCode: 'ordinary_role_inference_ambiguous',
            }].slice(0, MAX_TOOLS),
          },
          planningReceipt: {
            version: 1,
            mode: 'deterministic_binding',
            plannerCalls: 0,
            revisionCalls: 0,
            verification: {
              version: 1,
              status: 'ambiguous',
              missingRoles: [ordinaryRoleInferenceAmbiguity.role],
              candidateIds: ordinaryRoleInferenceAmbiguity.options.map((option) => option.id),
              reasonCode: 'ordinary_role_inference_ambiguous',
            },
          },
        });
        checkpoint(request, clarificationState);
        return {
          ...base,
          action: 'clarify',
          confidence: 1,
          followsUp: true,
          category: 'unclear',
          source: 'heuristic',
          reason: `More than one safe ${ordinaryRoleInferenceAmbiguity.requestedTerm} field can answer this request. Choose the intended business field once; no query was executed.`,
          requiresClarification: true,
          clarifyingQuestion: ordinaryRoleInferenceAmbiguity.question,
          clarificationOptions: ordinaryRoleInferenceAmbiguity.options,
          retrievalEvidence: runtimeRetrievalEvidence(evidence, workspaceCandidates),
          askAnalystDecision: { version: 1, mode, state: clarificationState },
        };
      }

      if (ordinaryRoleRelationshipGap) {
        const message = `The current metadata snapshot has ${ordinaryRoleRelationshipGap.requestedTerm} fields, but no complete safe relationship path from the requested entity to those fields. DQL did not infer a join, call the planner, or execute a query.`;
        const blockedState = transitionState(initialState, 'blocked', {
          workspace: {
            ...initialState.workspace,
            tools: [...initialState.workspace.tools, {
              version: 1 as const,
              id: 'tool:planner',
              kind: 'provider_meaning' as const,
              status: 'skipped' as const,
              candidateIds: ordinaryRoleRelationshipGap.candidateIds,
              reasonCode: 'ordinary_role_relationship_unproven',
            }].slice(0, MAX_TOOLS),
          },
          planningReceipt: {
            version: 1,
            mode: 'deterministic_binding',
            plannerCalls: 0,
            revisionCalls: 0,
            verification: {
              version: 1,
              status: 'invalid',
              missingRoles: ['relationship'],
              candidateIds: ordinaryRoleRelationshipGap.candidateIds,
              reasonCode: 'ordinary_role_relationship_unproven',
            },
          },
        });
        checkpoint(request, blockedState);
        return {
          ...base,
          action: 'block',
          confidence: 1,
          followsUp: false,
          source: 'heuristic',
          category: 'data_lookup',
          reason: message,
          terminalOutcome: {
            kind: 'modeling_gap',
            code: 'ANALYTICAL_MODELING_GAP',
            message,
            candidateIds: ordinaryRoleRelationshipGap.candidateIds,
          },
          askAnalystDecision: { version: 1, mode, state: blockedState },
        };
      }

      // An ordinary Ask accepts at most three independently executable
      // programs. Do not let the lexical ingress graph silently truncate a
      // fourth clause and then present a successful partial answer. Explicit
      // Research is the bounded multi-branch workflow for broader work.
      if (mission.scopeOverflow && mission.mode === 'ask') {
        const scopeState = transitionState(initialState, 'clarify', {
          workspace: {
            ...initialState.workspace,
            tools: [...initialState.workspace.tools, {
              version: 1 as const,
              id: 'tool:planner',
              kind: 'provider_meaning' as const,
              status: 'skipped' as const,
              candidateIds: [],
              reasonCode: 'ordinary_ask_task_scope_exceeded',
            }].slice(0, MAX_TOOLS),
          },
        });
        checkpoint(request, scopeState);
        return {
          ...base,
          action: 'clarify',
          confidence: 1,
          followsUp: true,
          source: 'heuristic',
          reason: 'This request contains more than three independent analytical asks. Narrow it to up to three questions, or choose Research for a broader evidence-led investigation. No query was executed.',
          requiresClarification: true,
          clarifyingQuestion: 'Which up to three analytical questions should I run first, or would you like to use Research?',
          clarificationOptions: [],
          askAnalystDecision: { version: 1, mode, state: scopeState },
        };
      }

      // A declared attribution boundary is a deterministic safety decision.
      // Do not hide it behind an unavailable provider or degrade it into a
      // generic modeling gap: the same snapshot already proves that the
      // requested relationship cannot be inferred or executed.
      const attributionGap = evidence
        ? attributionRequiredRelationshipGapDecision({
            request,
            base,
            evidence,
            requirements,
          })
        : undefined;
      if (attributionGap) {
        const blocked = transitionState(initialState, 'blocked', {
          workspace: {
            ...initialState.workspace,
            tools: [
              ...initialState.workspace.tools,
              {
                version: 1 as const,
                id: 'tool:compiler_broker',
                kind: 'compiler_broker' as const,
                status: 'completed' as const,
                candidateIds: attributionGap.terminalOutcome?.candidateIds ?? [],
                reasonCode: 'attribution_relationship_denied',
              },
            ].slice(0, MAX_TOOLS),
          },
        });
        checkpoint(request, blocked);
        return {
          ...attributionGap,
          askAnalystDecision: { version: 1, mode, state: blocked },
        };
      }

      const providerMeaningRequired = canonicalSelections.length === 0
        && !deterministicBinding;
      let rawResolution: MeaningResolution | undefined;
      let plannerProposal: AnalyticalPlannerProposalV1 | undefined;
      let plannerCalls = 0;
      let plannerRevisionCalls = 0;
      // A transport/provider boundary is distinct from a usable structured
      // proposal. Keep this fact through failure handling so a completed
      // provider span that returns an invalid/empty plan is never relabeled
      // as an unknown provider outage in V6 diagnostics.
      let plannerAttempted = false;
      try {
        if (canonicalSelections.length > 0) {
          rawResolution = canonicalSetResolution(request, requirementSeed, canonicalSelections);
          plannerProposal = plannerProposalForDeterministicBinding(rawResolution, canonicalSelections, mission);
        } else if (deterministicBinding) {
          rawResolution = deterministicBinding.resolution;
          plannerProposal = plannerProposalForDeterministicBinding(rawResolution, deterministicBinding.candidates, mission);
        } else {
          const planned = await resolveRuntimePlanner({
            options,
            request,
            evidence,
            candidates: admitted,
            workspaceCandidates,
            requirementSeed,
            frame,
            mission,
            planningMode: 'initial_planner',
          });
          plannerProposal = planned?.proposal;
          rawResolution = planned?.resolution;
          plannerAttempted = planned?.attempted ?? false;
          plannerCalls = plannerAttempted ? 1 : 0;
        }
      } catch (error) {
        const failed = runtimeMeaningFailureDecision({
          mode,
          initialState,
          providerAttempted: providerMeaningRequired,
          reason: 'The configured AI provider could not complete the bounded analytical planning step. No query was executed.',
          providerError: error,
          planningReceipt: {
            version: 1,
            mode: 'initial_planner',
            plannerCalls: 1,
            revisionCalls: 0,
            verification: plannerVerificationFailure('invalid', 'planning_initial_provider_failed'),
          },
        });
        checkpoint(request, failed.askAnalystDecision!.state);
        return failed;
      }
      let resolution = rawResolution
        ? mergeRuntimePlannerResolution({
            seed: requirementSeed,
            resolution: rawResolution,
            candidates: admitted,
            // A host-proven deterministic semantic binding has the same
            // canonical-ID authority as a verified planner proposal. Do not
            // pass it through the legacy lexical merge: native semantic
            // measures and their executable MetricFlow metrics intentionally
            // have different names (`order_count` -> `Orders`), and that
            // compatibility merge can otherwise discard the selected metric
            // before compiler verification.
            plannerControlled: Boolean(deterministicBinding)
              || (plannerCalls > 0 && Boolean(plannerProposal)),
          })
        : undefined;
      // The planner owns the typed business operation (rank/trend/compare),
      // while the host-owned seed continues to own filters, time, and output
      // literals. `mergeMeaningResolutionWithRequirementSeed` deliberately
      // protects legacy callers from model question-type prose; restoring only
      // the already-schema-validated planner operation here keeps the new
      // runtime contract without broadening that legacy authority.
      if (resolution && plannerProposal) {
        resolution = {
          ...resolution,
          questionType: questionTypeFromPlannerProposal(plannerProposal, requirementSeed.sourceQuestion),
        };
      }
      // Before the planner's role bindings have been verified, this boundary
      // proves package membership and eligibility only.  The lexical/frame
      // seed is deliberately advisory for an ordinary planner call: a parser
      // can omit or misname a business metric/display field, but a planner may
      // correct it only with an admitted, role-proven canonical card below.
      // Applying the seed's metric/dimension terms here would let a stale
      // parser veto that correction before the verifier sees it.
      let validResolution = resolution
        ? validateMeaningResolution(
            resolution,
            admitted,
            requirementSeed.queryIntent.measures,
          )
        : invalidPlannerResolution('The planner did not return a valid selection from the 16-card package.');
      // One continuation budget may repair malformed output and retrieve the
      // one verifier-proven missing role together.  Discover that bounded
      // extension *before* spending the correction call so the two recovery
      // mechanisms cannot consume two planner turns.
      let recoveryAssessment = !validResolution.ok
        ? verifierDirectedMalformedPlannerRecovery({
            proposal: plannerProposal,
            plannerCandidates: admitted,
            requirements,
          })
        : undefined;
      let targetedExtension = evidence && recoveryAssessment?.request
        ? admitTargetedSameSnapshotExtension({
            recovery: recoveryAssessment.request,
            plannerCandidates: admitted,
            workspaceCandidates,
            requirements: admissionRequirements,
          })
        : undefined;
      // A completed provider call with malformed/incomplete structured output
      // is neither a metadata absence nor a provider outage. Give it one
      // bounded correction on the same immutable 16-card package, then feed
      // the corrected typed program through the existing canonical cascade.
      // This is deliberately distinct from verifier-directed *extension*: no
      // hidden candidates are released and no second retrieval loop starts.
      if (!validResolution.ok
        && providerMeaningRequired
        && plannerCalls < MAX_PLANNING_CONTINUATIONS
        && !targetedExtension
        && (!plannerProposal || !plannerProposalReferencesOutsideCandidates(plannerProposal, admitted))) {
        const correctionFeedback: ProgramVerificationFeedbackV1 = {
          ...verificationFeedbackFromInvalidResolution(validResolution, stableCandidateIds(admitted).slice(0, MAX_INITIAL_PLANNER_CANDIDATES)),
          reasonCode: 'planner_output_invalid_retry',
        };
        try {
          const correction = await resolveRuntimePlanner({
            options,
            request,
            evidence,
            candidates: admitted,
            workspaceCandidates,
            requirementSeed,
            frame,
            mission,
            planningMode: 'targeted_revision',
            feedback: correctionFeedback,
          });
          if (correction.attempted) {
            plannerProposal = correction.proposal;
            rawResolution = correction.resolution;
            plannerCalls += 1;
            plannerRevisionCalls = 1;
            plannerAttempted = true;
            resolution = rawResolution
              ? mergeRuntimePlannerResolution({
                  seed: requirementSeed,
                  resolution: rawResolution,
                  candidates: admitted,
                  plannerControlled: Boolean(plannerProposal),
                })
              : undefined;
            if (resolution && plannerProposal) {
              resolution = {
                ...resolution,
                questionType: questionTypeFromPlannerProposal(plannerProposal, requirementSeed.sourceQuestion),
              };
            }
            validResolution = resolution
              ? validateMeaningResolution(
                  resolution,
                  admitted,
                  requirementSeed.queryIntent.measures,
                )
              : invalidPlannerResolution('The bounded planner correction did not return a valid selection from the 16-card package.');
          }
        } catch (error) {
          const failed = runtimeMeaningFailureDecision({
            mode,
            initialState,
            providerAttempted: true,
            reason: 'The configured AI provider could not correct the bounded analytical plan. No query was executed.',
            providerError: error,
            planningReceipt: {
              version: 1,
              mode: 'targeted_revision',
              plannerCalls: plannerCalls + 1,
              revisionCalls: 1,
              verification: correctionFeedback,
            },
          });
          checkpoint(request, failed.askAnalystDecision!.state);
          return failed;
        }
      }
      // Recovery is verifier-directed. The initial planner can mention only a
      // missing role plus normalized search terms and already-admitted related
      // cards; it cannot name a hidden #17+ workspace identity. The verifier
      // proves that exactly one required business role is truly absent, then
      // the host searches the immutable 32-card workspace and admits at most
      // four matching cards for one revision.
      if (!targetedExtension) {
        recoveryAssessment = validResolution.ok
          ? verifierDirectedTargetedRecovery({
              proposal: plannerProposal,
              resolution: validResolution.resolution,
              plannerCandidates: admitted,
              requirements,
              mission,
            })
          : undefined;
      }
      if (recoveryAssessment?.invalidReason) {
        const failed = runtimeMeaningFailureDecision({
          mode,
          initialState,
          reason: recoveryAssessment.invalidReason,
              providerAttempted: plannerAttempted,
              providerReturnedInvalid: providerMeaningRequired,
          securityViolation: recoveryAssessment.securityViolation,
          planningReceipt: {
            version: 1,
            mode: 'initial_planner',
            plannerCalls,
            revisionCalls: 0,
            verification: recoveryAssessment.feedback,
          },
        });
        checkpoint(request, failed.askAnalystDecision!.state);
        return failed;
      }
      if (!targetedExtension && evidence && recoveryAssessment?.request) {
        targetedExtension = admitTargetedSameSnapshotExtension({
          recovery: recoveryAssessment.request,
          plannerCandidates: admitted,
          workspaceCandidates,
          requirements: admissionRequirements,
        });
      }
      if (recoveryAssessment?.request && !targetedExtension) {
        const failed = runtimeMeaningFailureDecision({
          mode,
          initialState,
          reason: 'The immutable metadata snapshot did not contain a qualified safe match for the one missing business role. No query was executed.',
          providerAttempted: plannerAttempted,
          providerReturnedInvalid: false,
          planningReceipt: {
            version: 1,
            mode: 'initial_planner',
            plannerCalls,
            revisionCalls: 0,
            verification: {
              ...recoveryAssessment.feedback,
              reasonCode: 'targeted_context_unavailable',
            },
          },
        });
        checkpoint(request, failed.askAnalystDecision!.state);
        return failed;
      }
      if (targetedExtension) {
        const combinedMalformedPlannerRecovery = !validResolution.ok;
        // Preserve the first accepted proposal as immutable revision context.
        // The target cards below are the only newly released identities; the
        // revision is not a second general 16-card planning pass.
        const priorPlannerProposal = plannerProposal;
        const priorSelectedConceptIds = validResolution.ok
          ? [...validResolution.resolution.selectedConceptIds]
          : [];
        const targetedCandidates = targetedExtension.targetedCandidates;
        // Keep the initial package immutable in the workspace and revision
        // prompt. The verifier/compilers may resolve a revision against this
        // bounded union only: original 16 + <=4 explicitly admitted targets.
        // This union is not a new planner package and is never exposed as a
        // re-ranked 16-card list to the provider.
        verificationCandidates = uniqueCandidates([...admitted, ...targetedCandidates]);
        workspace = buildEvidenceWorkspace(evidence, workspaceCandidates, admitted, [
          ...toolReceipts,
          {
            version: 1,
            id: 'tool:targeted_context',
            kind: 'candidate_extension',
            status: 'completed',
            candidateIds: targetedExtension.candidateIds,
            reasonCode: targetedExtension.reasonCode,
          },
        ], admissionRequirements, targetedExtension.targetedContext);
        program = buildProgram(frame, mission, verificationCandidates, workspaceCandidates, requirementSeed, {
          planningMode: 'targeted_revision',
          plannerProposal,
          targetedContext: targetedExtension.targetedContext,
        });
        initialState = transitionState(initialState, 'program_ready', { workspace, program });
        checkpoint(request, initialState);
        // One role-targeted recovery earns exactly one revision of the
        // bounded plan. The revised planner sees the same immutable snapshot
        // plus at most four newly admitted cards; it cannot expand the
        // workspace or start an unbounded retrieve/plan loop.
        if (providerMeaningRequired) {
          try {
            const revision = await resolveRuntimePlanner({
              options,
              request,
              evidence,
              candidates: verificationCandidates,
              workspaceCandidates,
              requirementSeed,
              frame,
              mission,
              planningMode: 'targeted_revision',
              feedback: {
                ...recoveryAssessment!.feedback,
                candidateIds: targetedExtension.candidateIds,
                reasonCode: combinedMalformedPlannerRecovery
                  ? 'planner_output_invalid_retry_with_targeted_context'
                  : 'verifier_role_targeted_extension_admitted',
              },
              ...(priorPlannerProposal ? { priorProposal: priorPlannerProposal } : {}),
              ...(priorSelectedConceptIds.length ? { priorSelectedConceptIds } : {}),
              ...(targetedCandidates.length ? { targetedCandidates } : {}),
              ...(combinedMalformedPlannerRecovery ? { includeInitialCandidatesWithTargetedContext: true } : {}),
            });
            if (revision.attempted) {
              plannerProposal = revision.proposal;
              rawResolution = revision.resolution;
              plannerCalls += 1;
              plannerRevisionCalls = 1;
              plannerAttempted = true;
            }
          } catch (error) {
            const failed = runtimeMeaningFailureDecision({
              mode,
              initialState,
              providerAttempted: true,
              reason: 'The configured AI provider could not revise the bounded analytical plan. No query was executed.',
              providerError: error,
              planningReceipt: {
                version: 1,
                mode: 'targeted_revision',
                plannerCalls: plannerCalls + 1,
                revisionCalls: 1,
                verification: {
                  ...recoveryAssessment!.feedback,
                  candidateIds: targetedExtension.candidateIds,
                  reasonCode: combinedMalformedPlannerRecovery
                    ? 'planner_output_invalid_retry_with_targeted_context'
                    : 'verifier_role_targeted_extension_admitted',
                },
              },
            });
            checkpoint(request, failed.askAnalystDecision!.state);
            return failed;
          }
        }
        resolution = rawResolution
          ? mergeRuntimePlannerResolution({
              seed: requirementSeed,
              resolution: rawResolution,
              candidates: verificationCandidates,
              plannerControlled: plannerCalls > 0 && Boolean(plannerProposal),
            })
          : undefined;
        if (resolution && plannerProposal) {
          resolution = {
            ...resolution,
            questionType: questionTypeFromPlannerProposal(plannerProposal, requirementSeed.sourceQuestion),
          };
        }
        validResolution = resolution
          ? validateMeaningResolution(
              resolution,
              verificationCandidates,
              requirementSeed.queryIntent.measures,
            )
          : invalidPlannerResolution('The planner revision did not return a valid selection from the bounded recovery package.');
      }
      if (!validResolution.ok) {
        const failed = runtimeMeaningFailureDecision({
          mode,
          initialState,
          reason: validResolution.reason,
          providerAttempted: plannerAttempted,
          providerReturnedInvalid: providerMeaningRequired && plannerAttempted && !plannerProposal,
          providerUnavailable: providerMeaningRequired && !plannerAttempted && !plannerProposal,
          securityViolation: Boolean(plannerProposal && plannerProposalReferencesOutsideCandidates(plannerProposal, verificationCandidates)),
          planningReceipt: {
            version: 1,
            mode: plannerRevisionCalls > 0 ? 'targeted_revision' : 'initial_planner',
            plannerCalls,
            revisionCalls: plannerRevisionCalls,
            verification: verificationFeedbackFromInvalidResolution(validResolution, []),
          },
        });
        checkpoint(request, failed.askAnalystDecision!.state);
        return failed;
      }
      const verifiedPlanner = verifyPlannerInterpretation({
        proposal: plannerProposal,
        resolution: validResolution.resolution,
        candidates: verificationCandidates,
        requirements,
        question: request.question,
        mission,
      });
      if (!verifiedPlanner.ok) {
        const failed = runtimeMeaningFailureDecision({
          mode,
          initialState,
          reason: 'The bounded analytical plan did not pass deterministic role and operation verification. No query was executed.',
          providerAttempted: plannerAttempted,
          providerReturnedInvalid: providerMeaningRequired,
          planningReceipt: {
            version: 1,
            mode: plannerRevisionCalls > 0 ? 'targeted_revision' : 'initial_planner',
            plannerCalls,
            revisionCalls: plannerRevisionCalls,
            verification: verifiedPlanner.feedback,
          },
        });
        checkpoint(request, failed.askAnalystDecision!.state);
        return failed;
      }
      // The planner verifier has already proved these task bindings against
      // the immutable candidate package. Preserve that tuple across the
      // legacy meaning-resolution adapter: otherwise a host-owned inferred
      // dimension or an atomic relationship-path can be present in verified
      // task bindings yet disappear from the compiler-facing program.
      const verifiedPlannerTasks = materializeVerifiedPlannerTaskHandoff({
        tasks: verifiedPlanner.value.tasks,
        admitted: verificationCandidates,
      });
      const verifiedResolution = materializeVerifiedPlannerResolution({
        resolution: validResolution.resolution,
        tasks: verifiedPlannerTasks,
        admitted: verificationCandidates,
      });
      const verifiedMission = missionForVerifiedPlanner(mission, verifiedPlannerTasks);
      if (!verifiedMission) {
        const failed = runtimeMeaningFailureDecision({
          mode,
          initialState,
          reason: 'The bounded analytical plan selected tasks outside the server-derived mission. No query was executed.',
          providerAttempted: plannerAttempted,
          providerReturnedInvalid: providerMeaningRequired,
          planningReceipt: {
            version: 1,
            mode: plannerRevisionCalls > 0 ? 'targeted_revision' : 'initial_planner',
            plannerCalls,
            revisionCalls: plannerRevisionCalls,
            verification: plannerVerificationFailure('invalid', 'planner_task_not_executable_in_ordinary_ask'),
          },
        });
        checkpoint(request, failed.askAnalystDecision!.state);
        return failed;
      }
      // Recompute the compiler-facing requirement tuple from the same
      // materialized task receipt. The earlier verifier result remains the
      // authority for acceptance; this prevents a compatibility resolution
      // that omitted the host-owned inferred dimension from restoring the
      // source phrase (for example `region`) after task verification.
      const verifiedRequirements = requirementsForVerifiedPlanner({
        requirements,
        selectedCandidates: verificationCandidates.filter((candidate) =>
          verifiedResolution.selectedConceptIds.includes(candidate.id)
          || verifiedResolution.selectedConceptIds.includes(stableCandidateId(candidate))),
        tasks: verifiedPlannerTasks,
        operations: new Set(verifiedPlannerTasks.flatMap((task) => task.operations)),
        question: request.question,
      }) ?? verifiedPlanner.value.requirements;
      // Rebuild the compiler-facing seed from the verifier-approved planner
      // tuple.  Filters/member literals and declared temporal constraints stay
      // user-owned, while metric/entity/display/dimension/ranking bindings are
      // now the qualified canonical cards that passed role verification.  This
      // is the only point at which a planner may correct an incomplete parser
      // frame; it never gains join, policy, grain, compiler, or SQL authority.
      const verifiedRequirementSeed = requirementSeedForVerifiedPlanner({
        seed: requirementSeed,
        requirements: verifiedRequirements,
      });
      const frameBoundResolution = evidence
        ? bindAskAnalystProgramMeaningV1({
            request,
            evidence,
            candidates: verificationCandidates,
            requirementSeed: verifiedRequirementSeed,
            resolution: verifiedResolution,
          })
        : verifiedResolution;
      const boundResolutionWithSeed = (Boolean(deterministicBinding) || (plannerCalls > 0 && Boolean(plannerProposal)))
        ? {
            ...frameBoundResolution,
            // Router compatibility code reads this carrier again while it
            // builds the resolved plan. Do not leave the pre-planner seed
            // attached just because a frame-binding adapter returned the
            // original resolution. Exact/direct bindings retain their native
            // query intent because no planner has corrected it.
            hostRequirementSeed: verifiedRequirementSeed,
            queryIntent: {
              ...verifiedRequirementSeed.queryIntent,
              filters: verifiedRequirementSeed.queryIntent.filters.map((filter) => ({ ...filter })),
            },
          }
        : frameBoundResolution;
      // Reapply the verifier-owned task receipt after the compatibility
      // binder. This is intentionally an identity-only handoff: it cannot
      // retrieve, select a new relationship, or change the verified business
      // operation. It simply keeps the compiler/cascade on the exact tuple
      // already accepted by verification.
      const boundResolution = materializeVerifiedPlannerResolution({
        resolution: boundResolutionWithSeed,
        tasks: verifiedPlannerTasks,
        admitted: verificationCandidates,
      });
      const boundValidation = validateMeaningResolution(
        boundResolution,
        verificationCandidates,
        verifiedRequirementSeed.queryIntent.measures,
        { requirements: verifiedRequirements },
      );
      if (!boundValidation.ok) {
        const failed = runtimeMeaningFailureDecision({
          mode,
          initialState,
          reason: boundValidation.reason,
          providerAttempted: plannerAttempted,
          providerReturnedInvalid: providerMeaningRequired,
          planningReceipt: {
            version: 1,
            mode: plannerRevisionCalls > 0 ? 'targeted_revision' : 'initial_planner',
            plannerCalls,
            revisionCalls: plannerRevisionCalls,
            verification: verificationFeedbackFromInvalidResolution(boundValidation, []),
          },
        });
        checkpoint(request, failed.askAnalystDecision!.state);
        return failed;
      }
      const verifiedFrame: BusinessQuestionFrameV4 = {
        ...frame,
        requirements: verifiedRequirements,
        planningMode: plannerRevisionCalls > 0
          ? 'targeted_revision'
          : plannerCalls > 0
            ? 'initial_planner'
            : deterministicBinding
              ? 'deterministic_binding'
              : 'exact_fast_path',
      };
      // Freeze a V2 program only after the planner's typed business
      // interpretation has passed deterministic identity/role validation.
      // The verifier still owns physical/semantic capability, joins, grain,
      // additivity, policy, and compiler eligibility below.
      program = buildProgram(verifiedFrame, verifiedMission, verificationCandidates, workspaceCandidates, verifiedRequirementSeed, {
        planningMode: verifiedFrame.planningMode,
        plannerProposal,
        resolution: boundValidation.resolution,
        verifiedPlannerTasks,
        ...(targetedExtension ? { targetedContext: targetedExtension.targetedContext } : {}),
      });
      initialState = transitionState(initialState, 'program_ready', {
        frame: verifiedFrame,
        mission: verifiedMission,
        workspace,
        program,
        planningMode: verifiedFrame.planningMode,
        plannerRevisionCount: plannerRevisionCalls,
        planningReceipt: {
          version: 1,
          mode: verifiedFrame.planningMode,
          plannerCalls,
          revisionCalls: plannerRevisionCalls,
          verification: verifiedPlanner.value.feedback,
        },
        conversationDelta: {
          version: 2,
          sourceQuestionFingerprint: verifiedFrame.questionFingerprint,
          ...(verifiedFrame.conversation.selectedStableId ? { selectedStableId: verifiedFrame.conversation.selectedStableId } : {}),
          partialFrame: {
            kind: verifiedFrame.kind,
            requirements: verifiedRequirements,
            planningMode: verifiedFrame.planningMode,
          },
          programId: program.id,
        },
      });
      checkpoint(request, initialState);
      // Each accepted planner task gets its own verified requirements, program,
      // compiler decision and frozen execution step.  Do this before returning
      // any plan so a later task cannot disappear behind a successful task-1.
      const compiledTasks = compileVerifiedAskTasks({
        base,
        request,
        evidence,
        workspaceCandidates,
        admitted: verificationCandidates,
        initialState,
        mission: verifiedMission,
        verifiedFrame,
        program,
        verifiedRequirements,
        verifiedRequirementSeed,
        plannerProposal,
        verifiedPlanner: {
          ...verifiedPlanner.value,
          tasks: verifiedPlannerTasks,
        },
        resolution: boundValidation.resolution,
        requirementSeed,
        targetedContext: targetedExtension?.targetedContext,
      });
      if (!compiledTasks.ok) {
        // A task-local compiler state may describe only task-1.  Keep the
        // root mission/program in the durable receipt when *any* accepted
        // ordinary Ask task fails pre-freeze so a compound request is never
        // persisted as a misleading one-task success.
        const failed = transitionState(initialState, compiledTasks.decision.requiresClarification || compiledTasks.decision.action === 'clarify' ? 'clarify' : 'blocked', {
          workspace: workspaceWithPlannerReceipt(initialState.workspace, {
            providerMeaningRequired,
            plannerRevisionCalls,
            candidateIds: boundValidation.resolution.selectedConceptIds,
            deterministicBinding,
            canonicalSelections,
          }),
          planningContinuations: plannerCalls,
          planningMode: verifiedFrame.planningMode,
          plannerRevisionCount: plannerRevisionCalls,
          planningReceipt: {
            version: 1,
            mode: verifiedFrame.planningMode,
            plannerCalls,
            revisionCalls: plannerRevisionCalls,
            verification: verifiedPlanner.value.feedback,
          },
        });
        checkpoint(request, failed);
        return {
          ...compiledTasks.decision,
          askAnalystDecision: { version: 1, mode, state: failed },
        };
      }
      const taskExecutions = compiledTasks.value;
      const compilerDecision = taskExecutions[0]!.compilerDecision;
      const resolvedPlan = taskExecutions[0]!.resolvedPlan;
      const frozenPlan = frozenTaskPlan(
        taskExecutions.map((task) => ({
          taskId: task.taskId,
          program: task.program,
          resolvedPlan: task.resolvedPlan,
          requirements: task.state.frame.requirements,
        })),
        request.question,
        verifiedMission,
      );
      const phase = compilerDecision.requiresClarification || compilerDecision.action === 'clarify'
        ? 'clarify'
        : compilerDecision.terminalOutcome || compilerDecision.action === 'block'
          ? 'blocked'
          : resolvedPlan.planFrozen
            ? 'compiled'
            : 'program_ready';
      const finalState = transitionState(initialState, phase, {
        workspace: {
          ...workspace,
          tools: [
            ...workspace.tools,
            {
              version: 1 as const,
              id: 'tool:planner',
              kind: 'provider_meaning' as const,
              status: providerMeaningRequired ? 'completed' as const : 'skipped' as const,
              candidateIds: boundValidation.resolution.selectedConceptIds,
              reasonCode: providerMeaningRequired
                ? plannerRevisionCalls > 0
                  ? 'planning.revision.completed'
                  : 'planning.initial.completed'
                : deterministicBinding
                  ? deterministicBinding.reasonCode
                  : 'canonical_or_structured_binding',
            },
            {
              version: 1 as const,
              id: 'tool:compiler_broker',
              kind: 'compiler_broker' as const,
              status: 'completed' as const,
              candidateIds: taskExecutions.flatMap((task) => task.meaningResolution.selectedConceptIds),
              reasonCode: taskExecutions.map((task) => task.resolvedPlan.compiler).join(','),
            },
          ].slice(0, MAX_TOOLS),
        },
        resolvedPlan,
        planningContinuations: plannerCalls,
        toolCalls: Math.min(MAX_TOOLS, workspace.tools.length + (canonicalSelections.length > 0 || deterministicBinding ? 1 : 1 + plannerRevisionCalls)),
      });
      checkpoint(request, finalState);

      // Shadow runs deliberately return the broker's exact decision and do not
      // start a second execution. Authoritative runs do the same, but the engine
      // now sees runtime-owned state before planner/executor selection.
      return {
        ...compilerDecision,
        // The broker may retain an older compatibility resolution on its
        // envelope. Publish the runtime-verified, compiler-consumed binding
        // so downstream engine, persistence, and trace consumers see the
        // same canonical metric/entity/dimension tuple.
        meaningResolution: taskExecutions[0]!.meaningResolution,
        askAnalystDecision: {
          version: 1,
          mode,
          state: finalState,
          resolvedPlan,
          frozenPlan,
          taskExecutions,
        },
      };
    },
  };
}

function checkpoint(request: AgentRunRequest, state: AskAnalystState): void {
  try {
    request.askAnalystCheckpoint?.(state);
  } catch {
    // Checkpoint persistence is additive; a write problem may not change the
    // analytical decision/execution boundary.
  }
}

/**
 * A deliberately small deterministic ingress classification. Analytical
 * meaning and compiler choice happen later in this runtime; this only keeps
 * non-data turns out of the data path without asking the legacy router to
 * reinterpret an analytical question.
 */
function runtimeBaseDecision(request: AgentRunRequest): IntentDecision {
  // The analytical planner is deliberately not a fallback for a recap,
  // gratitude, capability question, or explanation of a persisted answer.
  // The legacy engine already performs this classification after routing, but
  // an authoritative Ask must make the same deterministic decision *before*
  // acquiring a planning snapshot.  Otherwise a perfectly ordinary
  // conversational follow-up can become a provider-readiness incident.
  const hasConversation = Boolean(
    request.history?.length
    || (request.conversationContext && Object.keys(request.conversationContext).length > 0),
  );
  const conversationalKind = classifyConversationalTurn(request.question, hasConversation);
  if (conversationalKind) {
    return {
      action: 'converse',
      category: 'conversational',
      conversationalKind,
      confidence: 1,
      followsUp: hasConversation,
      reason: conversationalKind === 'answer_explanation'
        ? 'This asks about the prior answer, so no new analytical plan is needed.'
        : 'This is a conversational turn and does not request a new analytical result.',
    };
  }
  return decideAgentAction({
    question: request.question,
    intent: request.intent ?? 'ad_hoc_ranking',
    signals: request.signals,
    ...(request.history?.length ? { history: request.history } : {}),
  });
}

/**
 * Resolve the one ordinary-Ask planner turn. The provider-facing proposal is
 * intentionally route-neutral; it is immediately converted into the legacy
 * candidate-ID resolution shape only so existing deterministic validators and
 * compiler adapters can consume it without becoming another decision owner.
 */
async function resolveRuntimePlanner(input: {
  options: AskAnalystRuntimeOptionsV1;
  request: AgentRunRequest;
  evidence: AgentRetrievalEvidence | undefined;
  candidates: AgentEvidenceCandidate[];
  /** Immutable 32-card closure used only to prove a same-snapshot extension. */
  workspaceCandidates?: AgentEvidenceCandidate[];
  requirementSeed: ReturnType<typeof buildAnalyticalRequirementSeedV1>;
  frame: BusinessQuestionFrameV4;
  mission: AnalyticalMissionV1;
  planningMode: AskPlanningModeV1;
  feedback?: ProgramVerificationFeedbackV1;
  /** Immutable first proposal carried only into the one targeted revision. */
  priorProposal?: AnalyticalPlannerProposalV1;
  priorSelectedConceptIds?: string[];
  /** Cards newly admitted by the verifier; never more than four. */
  targetedCandidates?: AgentEvidenceCandidate[];
  /**
   * The sole continuation may repair malformed planner output *and* admit one
   * verifier-proven missing role. In that combined case the planner needs the
   * original package plus the at-most-four newly admitted cards; this is a
   * bounded union, never a second reranked retrieval package.
   */
  includeInitialCandidatesWithTargetedContext?: boolean;
}): Promise<{ proposal?: AnalyticalPlannerProposalV1; resolution?: MeaningResolution; attempted: boolean }> {
  // A selectedEvidenceId is client ingress, not meaning authority. The only
  // zero-call structured path is deterministicStructuredContinuationBinding,
  // which proves the server-issued clarification, thread, source turn, and
  // current/equivalent snapshot before we arrive here. Never turn a raw ID
  // into a selected metric/dimension merely because it happens to be present
  // in the current candidate package.
  if (!input.evidence || input.candidates.length === 0) return { attempted: false };
  const plannerRequest = buildPlannerRequest({
    request: input.request,
    evidence: input.evidence,
    frame: input.frame,
    mission: input.mission,
    candidates: input.candidates,
    planningMode: input.planningMode,
    ...(input.feedback ? { feedback: input.feedback } : {}),
    ...(input.priorProposal ? { priorProposal: input.priorProposal } : {}),
    ...(input.priorSelectedConceptIds?.length ? { priorSelectedConceptIds: input.priorSelectedConceptIds } : {}),
    ...(input.targetedCandidates?.length ? { targetedCandidates: input.targetedCandidates } : {}),
    ...(input.includeInitialCandidatesWithTargetedContext ? { includeInitialCandidatesWithTargetedContext: true } : {}),
  });
  // `plannerRequest` is the provider contract, but preserve that boundary for
  // compatibility hosts that still inspect `candidates` on the callback. A
  // targeted revision receives only its <=4 additions; immutable original
  // selections travel as prior proposal/IDs, never as a re-ranked package.
  const providerVisibleCandidates = input.planningMode === 'targeted_revision' && input.targetedCandidates?.length
    ? input.includeInitialCandidatesWithTargetedContext
      ? input.candidates.slice(0, MAX_REVISION_SELECTION_CANDIDATES)
      : input.targetedCandidates.slice(0, MAX_TARGETED_CONTEXT_CANDIDATES)
    : input.candidates.slice(0, MAX_INITIAL_PLANNER_CANDIDATES);
  if (input.options.planAnalytical) {
    const providerProposal = await input.options.planAnalytical({
      request: input.request,
      evidence: input.evidence,
      candidates: providerVisibleCandidates,
      requirementSeed: input.requirementSeed,
      plannerRequest,
      ...(input.feedback ? { feedback: input.feedback } : {}),
    });
    if (!providerProposal) return { attempted: true };
    const proposal = normalizePlannerProposalCandidateIdentities(providerProposal, input.candidates);
    // `targeted_revision` also carries the single malformed-output
    // correction above. That correction intentionally reuses the original
    // package and has no prior semantic proposal to preserve. A real
    // same-snapshot extension still must preserve the prior selected meaning
    // and may expose only its verifier-admitted cards.
    const isMalformedOutputCorrection = input.feedback?.reasonCode === 'planner_output_invalid_retry'
      || input.feedback?.reasonCode === 'planner_output_invalid_retry_with_targeted_context';
    if (input.planningMode === 'targeted_revision'
      && !isMalformedOutputCorrection
      && (!input.priorProposal
        || !input.priorSelectedConceptIds?.length
        || !input.feedback
        || !input.targetedCandidates?.length
        || !targetedRevisionPreservesPriorMeaning({
          proposal,
          priorProposal: input.priorProposal,
          priorSelectedConceptIds: input.priorSelectedConceptIds,
          targetedCandidateIds: stableCandidateIds(input.targetedCandidates),
          missingRole: input.feedback.missingRoles[0],
        }))) {
      // Keep the returned proposal so the normal runtime failure receipt can
      // identify the planning/revision boundary, but never manufacture a
      // resolution from a revision that attempted to replace unrelated
      // meaning or use a non-targeted card.
      return { proposal, attempted: true };
    }
    const resolution = meaningResolutionFromPlannerProposal({
      proposal,
      request: input.request,
      requirementSeed: input.requirementSeed,
      candidates: input.candidates,
      // Initial planners may select only the 16 supplied cards. A same-
      // snapshot card outside that package must be requested through the
      // typed recovery object and admitted by the verifier before revision.
      knownCandidates: input.candidates,
    });
    // Keep a syntactically valid proposal even when its selected IDs cannot
    // yet be verified from the 16-card package. The verifier may consume its
    // one typed recovery request; dropping the proposal here would turn a
    // legal same-snapshot recovery into a false provider/coverage failure.
    return { proposal, ...(resolution ? { resolution } : {}), attempted: true };
  }
  if (!input.options.resolveMeaning) return { attempted: false };
  // Compatibility hosts retain their existing narrow candidate-ID prompt.
  // Adapt the response into the same proposal shape so all authoritative
  // runtime receipts/state use one planner contract even during rollout.
  const resolution = await input.options.resolveMeaning({
    request: input.request,
    evidence: input.evidence,
    candidates: input.candidates,
    requirementSeed: input.requirementSeed,
  });
  if (!resolution) return { attempted: true };
  return {
    proposal: plannerProposalFromMeaningResolution(resolution, input.candidates),
    resolution,
    attempted: true,
  };
}

const ALLOWED_PLANNER_OPERATIONS = new Set<AnalyticalPlannerOperationV1>([
  'aggregate', 'rank', 'group', 'filter', 'trend', 'compare', 'project',
]);

function buildPlannerRequest(input: {
  request: AgentRunRequest;
  evidence: AgentRetrievalEvidence;
  frame: BusinessQuestionFrameV4;
  mission: AnalyticalMissionV1;
  candidates: AgentEvidenceCandidate[];
  planningMode: AskPlanningModeV1;
  feedback?: ProgramVerificationFeedbackV1;
  priorProposal?: AnalyticalPlannerProposalV1;
  priorSelectedConceptIds?: string[];
  targetedCandidates?: AgentEvidenceCandidate[];
  includeInitialCandidatesWithTargetedContext?: boolean;
}): AnalyticalPlannerRequestV1 {
  const releasedCandidates = input.planningMode === 'targeted_revision' && input.targetedCandidates?.length
    ? input.includeInitialCandidatesWithTargetedContext
      ? input.candidates.slice(0, MAX_REVISION_SELECTION_CANDIDATES)
      : input.targetedCandidates.slice(0, MAX_TARGETED_CONTEXT_CANDIDATES)
    : input.candidates.slice(0, MAX_INITIAL_PLANNER_CANDIDATES);
  return {
    version: 1,
    planningMode: input.planningMode,
    question: input.request.question,
    questionFingerprint: input.frame.questionFingerprint,
    frame: {
      kind: input.frame.kind,
      // A validated selected-result predicate is a local execution boundary,
      // not provider context. The planner still sees the typed customer
      // entity/display role needed to choose a region path, but it neither
      // receives the selected literal nor has to bind it as a member card.
      requirements: plannerSafeRequirements(input.frame.requirements),
      conversation: input.frame.conversation,
      planningMode: input.frame.planningMode,
    },
    advisoryHints: [
      ...(input.evidence.parsedIntent?.measures ?? []).slice(0, 4),
      ...(input.evidence.parsedIntent?.dimensions ?? []).slice(0, 4),
    ].filter((value, index, values) => values.indexOf(value) === index),
    sourceCoverage: sourceCoverageFromEvidence(input.evidence).map((coverage) => ({
      source: coverage.source,
      status: coverage.status,
    })),
    taskOptions: input.mission.tasks.slice(0, MAX_ASK_TASKS).map((task) => ({
      id: task.id,
      kind: task.kind,
      question: task.question,
    })),
    ...(input.priorProposal ? {
      priorProposal: {
        version: input.priorProposal.version,
        selectedConceptIds: uniqueStableIds(input.priorProposal.selectedConceptIds).slice(0, MAX_INITIAL_PLANNER_CANDIDATES),
        tasks: input.priorProposal.tasks.slice(0, MAX_ASK_TASKS).map((task) => ({
          version: task.version,
          taskId: task.taskId,
          ...(task.coveredTaskIds ? { coveredTaskIds: uniqueStableIds(task.coveredTaskIds).slice(0, MAX_ASK_TASKS) } : {}),
          selectedConceptIds: uniqueStableIds(task.selectedConceptIds).slice(0, MAX_INITIAL_PLANNER_CANDIDATES),
          roleBindings: Object.fromEntries(Object.entries(task.roleBindings).map(([role, ids]) => [role, uniqueStableIds(ids ?? []).slice(0, MAX_INITIAL_PLANNER_CANDIDATES)])) as Partial<Record<EvidenceCandidateRoleV1, string[]>>,
          operations: [...task.operations],
        })),
      },
    } : {}),
    ...(input.priorSelectedConceptIds?.length ? { priorSelectedConceptIds: uniqueStableIds(input.priorSelectedConceptIds).slice(0, MAX_INITIAL_PLANNER_CANDIDATES) } : {}),
    ...(input.feedback ? { verificationFeedback: input.feedback } : {}),
    ...(input.targetedCandidates?.length ? {
      targetedCandidates: input.targetedCandidates.slice(0, MAX_TARGETED_CONTEXT_CANDIDATES).map(toPlannerCandidateCard),
    } : {}),
    candidates: releasedCandidates.map(toPlannerCandidateCard),
    deadlineMs: 45_000,
  };
}

function plannerSafeRequirements(requirements: AnalyticalRequirementSetV1): AnalyticalRequirementSetV1 {
  const binding = requirements.priorResultMemberBinding;
  if (!binding) return requirements;
  const bindingValues = new Set(binding.values.map(normalizePlannerAdmissionText).filter(Boolean));
  const { priorResultMemberBinding: _binding, ...safe } = requirements;
  return {
    ...safe,
    memberTerms: safe.memberTerms.filter((term) => !bindingValues.has(normalizePlannerAdmissionText(term))),
  };
}

function toPlannerCandidateCard(candidate: AgentEvidenceCandidate): AnalyticalPlannerCandidateCardV1 {
  const unresolvedRoles = candidateUnresolvedRoleAdmissions(candidate)
    .map((admission) => admission.role)
    .filter((role, index, roles) => roles.indexOf(role) === index);
  return {
      version: 1,
      id: stableCandidateId(candidate),
      ...(candidate.qualifiedId ? { qualifiedId: candidate.qualifiedId } : {}),
      label: candidate.name.slice(0, 160),
      ...(candidate.aliases?.length ? { aliases: candidate.aliases.slice(0, 8).map((alias) => alias.slice(0, 120)) } : {}),
      roles: evidenceCandidateRoles(candidate),
      source: sourceForPlannerCandidate(candidate),
      trustTier: candidate.trustTier === 'certified' ? 'certified'
        : candidate.trustTier === 'semantic' ? 'semantic'
          : candidate.trustTier === 'governed_sql' ? 'governed'
            : 'exploratory',
      exactMatch: candidate.exactMatch === true,
      ...(unresolvedRoles.length ? {
        admissionReasonCode: 'candidate_for_unresolved_role' as const,
        unresolvedRoles,
      } : {}),
      ...(candidate.relationshipEvidence?.length ? { relationHints: candidate.relationshipEvidence.slice(0, 3) } : {}),
      ...(candidate.relationshipProofClass ? { relationshipProofClass: candidate.relationshipProofClass } : {}),
  };
}

/**
 * A targeted revision is a repair of one verifier-proven missing role, not a
 * new interpretation pass. The provider sees the first selected bindings as
 * immutable context and may add only one of the <=4 released target cards.
 * This check is deliberately before `meaningResolutionFromPlannerProposal`,
 * so an otherwise-known card cannot be laundered through the legacy resolver.
 */
function targetedRevisionPreservesPriorMeaning(input: {
  proposal: AnalyticalPlannerProposalV1;
  priorProposal: AnalyticalPlannerProposalV1;
  priorSelectedConceptIds: string[];
  targetedCandidateIds: string[];
  missingRole: EvidenceCandidateRoleV1 | undefined;
}): boolean {
  const missingRole = input.missingRole;
  if (!missingRole || input.targetedCandidateIds.length === 0 || input.targetedCandidateIds.length > 4) return false;
  const priorIds = new Set(uniqueStableIds(input.priorSelectedConceptIds));
  const targetIds = new Set(uniqueStableIds(input.targetedCandidateIds));
  const allowedIds = new Set([...priorIds, ...targetIds]);
  const allRevisionIds = uniqueStableIds([
    ...input.proposal.selectedConceptIds,
    ...input.proposal.tasks.flatMap((task) => [
      ...task.selectedConceptIds,
      ...Object.values(task.roleBindings).flatMap((ids) => ids ?? []),
    ]),
  ]);
  if (allRevisionIds.some((id) => !allowedIds.has(id)) || [...priorIds].some((id) => !allRevisionIds.includes(id))) return false;
  if (input.proposal.tasks.length !== input.priorProposal.tasks.length) return false;
  const revisionByTask = new Map(input.proposal.tasks.map((task) => [task.taskId, task]));
  for (const priorTask of input.priorProposal.tasks) {
    const revisionTask = revisionByTask.get(priorTask.taskId);
    if (!revisionTask || !samePlannerOperationSet(revisionTask.operations, priorTask.operations)) return false;
    const priorCovered = uniqueStableIds(priorTask.coveredTaskIds?.length ? priorTask.coveredTaskIds : [priorTask.taskId]);
    const revisionCovered = uniqueStableIds(revisionTask.coveredTaskIds?.length ? revisionTask.coveredTaskIds : [revisionTask.taskId]);
    if (!sameStringSet([...priorCovered].sort(), [...revisionCovered].sort())) return false;
    for (const role of Object.keys(priorTask.roleBindings) as EvidenceCandidateRoleV1[]) {
      if (role === missingRole) continue;
      const priorBound = new Set(uniqueStableIds(priorTask.roleBindings[role] ?? []));
      const revisedBound = new Set(uniqueStableIds(revisionTask.roleBindings[role] ?? []));
      if ([...priorBound].some((id) => !revisedBound.has(id))) return false;
      // An unrelated role must not absorb a target card as a backdoor change.
      if ([...revisedBound].some((id) => targetIds.has(id) && !priorBound.has(id))) return false;
    }
    const missingBound = uniqueStableIds(revisionTask.roleBindings[missingRole] ?? []);
    if (missingBound.some((id) => !allowedIds.has(id))) return false;
  }
  return input.proposal.tasks.some((task) =>
    (task.roleBindings[missingRole] ?? []).some((id) => targetIds.has(id)));
}

function samePlannerOperationSet(
  left: readonly AnalyticalPlannerOperationV1[],
  right: readonly AnalyticalPlannerOperationV1[],
): boolean {
  return sameStringSet([...new Set(left)].sort(), [...new Set(right)].sort());
}

function sourceForPlannerCandidate(candidate: AgentEvidenceCandidate): ContextSourceCoverageV1['source'] {
  if (candidate.kind === 'certified_block') return 'certified';
  if (candidate.kind === 'semantic_metric' || candidate.kind === 'semantic_member' || candidate.trustTier === 'semantic') return 'semantic';
  if (candidate.kind === 'dql_modeling' || (candidate.relationshipEvidence?.length ?? 0) > 0) return 'governed_relational';
  if (candidate.kind === 'dbt_model' || candidate.kind === 'dbt_source') return 'dbt_manifest';
  if (candidate.kind === 'sql_table' || candidate.kind === 'sql_column') return 'runtime_schema';
  return 'conversation';
}

function plannerProposalFromMeaningResolution(
  resolution: MeaningResolution,
  candidates: AgentEvidenceCandidate[],
): AnalyticalPlannerProposalV1 {
  const selected = [...new Set(resolution.selectedConceptIds)].filter(Boolean);
  return {
    version: 1,
    selectedConceptIds: selected,
    confidence: resolution.confidence,
    ...(resolution.missingInformation.length ? { missingInformation: [...resolution.missingInformation] } : {}),
    tasks: [{
      version: 1,
      taskId: 'task-1',
      selectedConceptIds: selected,
      roleBindings: roleBindingsForCandidates(selected, candidates),
      operations: operationsForQuestionType(resolution.questionType),
    }],
  };
}

/**
 * A complete deterministic identity binding may legitimately avoid a planner
 * call, but it may not turn a compound Ask into a one-task program.  Carry the
 * same canonical selection through every already-accepted mission task so the
 * verifier/compiler can freeze and execute each task independently.  This is
 * a route-neutral fast path; each task still receives its own compiler proof.
 */
function plannerProposalForDeterministicBinding(
  resolution: MeaningResolution,
  candidates: AgentEvidenceCandidate[],
  mission: AnalyticalMissionV1,
): AnalyticalPlannerProposalV1 | undefined {
  if (mission.tasks.length <= 1) return undefined;
  const selected = [...new Set(resolution.selectedConceptIds)].filter(Boolean);
  if (selected.length === 0) return undefined;
  return {
    version: 1,
    selectedConceptIds: selected,
    confidence: resolution.confidence,
    ...(resolution.missingInformation.length ? { missingInformation: [...resolution.missingInformation] } : {}),
    tasks: mission.tasks.map((task) => ({
      version: 1,
      taskId: task.id,
      selectedConceptIds: selected,
      roleBindings: roleBindingsForCandidates(selected, candidates),
      operations: operationsForQuestionType(questionTypeFromText(task.question)),
    })),
  };
}

function meaningResolutionFromPlannerProposal(input: {
  proposal: AnalyticalPlannerProposalV1;
  request: AgentRunRequest;
  requirementSeed: ReturnType<typeof buildAnalyticalRequirementSeedV1>;
  candidates: AgentEvidenceCandidate[];
  knownCandidates?: AgentEvidenceCandidate[];
}): MeaningResolution | undefined {
  const proposal = input.proposal;
  if (!proposal || proposal.version !== 1 || !Array.isArray(proposal.tasks) || proposal.tasks.length === 0 || proposal.tasks.length > MAX_ASK_TASKS) return undefined;
  const knownCandidates = input.knownCandidates?.length ? input.knownCandidates : input.candidates;
  const candidateIds = new Set(knownCandidates.map((candidate) => candidate.id));
  const qualifiedIds = new Set(knownCandidates.map((candidate) => stableCandidateId(candidate)));
  const selected = [...new Set([
    ...(Array.isArray(proposal.selectedConceptIds) ? proposal.selectedConceptIds : []),
    ...proposal.tasks.flatMap((task) => Array.isArray(task.selectedConceptIds) ? task.selectedConceptIds : []),
    ...proposal.tasks.flatMap((task) => Object.values(task.roleBindings ?? {}).flatMap((ids) => Array.isArray(ids) ? ids : [])),
  ])];
  if (selected.length === 0 || selected.some((id) => typeof id !== 'string' || (!candidateIds.has(id) && !qualifiedIds.has(id)))) return undefined;
  for (const task of proposal.tasks) {
    if (!task || task.version !== 1 || typeof task.taskId !== 'string' || !task.taskId.trim()) return undefined;
    if (!Array.isArray(task.operations) || task.operations.length === 0 || task.operations.some((operation) => !ALLOWED_PLANNER_OPERATIONS.has(operation))) return undefined;
    if (!task.roleBindings || typeof task.roleBindings !== 'object' || Array.isArray(task.roleBindings)) return undefined;
    for (const [role, ids] of Object.entries(task.roleBindings)) {
      if (!isEvidenceCandidateRole(role) || !Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || (!candidateIds.has(id) && !qualifiedIds.has(id)))) return undefined;
    }
  }
  const selectedCandidates = knownCandidates.filter((candidate) => selected.includes(candidate.id) || selected.includes(stableCandidateId(candidate)));
  const primary = selectedCandidates.find((candidate) => evidenceCandidateRoles(candidate).includes('metric')) ?? selectedCandidates[0];
  if (!primary) return undefined;
  return {
    interpretedQuestion: input.requirementSeed.sourceQuestion,
    // Operations are the planner's business interpretation. The verifier
    // validates all selected IDs and preserves requirement seed filters/time
    // safety, but it must not throw away a valid requested rank/trend/compare
    // operation and revert to a lexical question-type guess.
    questionType: questionTypeFromPlannerProposal(proposal, input.requirementSeed.sourceQuestion),
    selectedConceptIds: selectedCandidates.map((candidate) => candidate.id),
    recommendedExecutionId: primary.id,
    queryIntent: { ...input.requirementSeed.queryIntent, filters: input.requirementSeed.queryIntent.filters.map((filter) => ({ ...filter })) },
    rejectedCandidates: [],
    confidence: proposal.confidence ?? 'medium',
    missingInformation: proposal.missingInformation ?? [],
    recommendedRoute: primary.kind === 'certified_block' ? 'certified'
      : primary.kind === 'semantic_metric' ? 'semantic'
        : primary.kind === 'dql_modeling' ? 'governed_sql'
          : 'exploratory',
    hostRequirementSeed: input.requirementSeed,
  };
}

function questionTypeFromPlannerProposal(
  proposal: AnalyticalPlannerProposalV1,
  sourceQuestion: string,
): MeaningResolution['questionType'] {
  const operations = new Set(proposal.tasks.flatMap((task) => task.operations));
  if (operations.has('rank')) return 'ranking';
  if (operations.has('trend')) return 'trend';
  if (operations.has('compare')) return 'comparison';
  return questionTypeFromText(sourceQuestion);
}

/**
 * The planner is allowed to interpret the business operation and candidate
 * roles, but never to mint identity or execution authority. This verifier is
 * the hand-off point: it accepts only card IDs that were already admitted,
 * proves the advertised role from local evidence, and carries the accepted
 * operation/assumptions into the immutable program. User-owned filters,
 * fiscal/time bindings, and output terms are preserved rather than inferred
 * from a planner response.
 */
interface VerifiedPlannerInterpretationV1 {
  tasks: AnalyticalProgramV2['planner']['tasks'];
  requirements: AnalyticalRequirementSetV1;
  feedback: ProgramVerificationFeedbackV1;
}

interface VerifierDirectedTargetedRecoveryV1 {
  request?: TargetedContextRequestV1;
  feedback: ProgramVerificationFeedbackV1;
  invalidReason?: string;
  securityViolation?: boolean;
}

/**
 * A malformed planner response has no trusted role bindings to inspect, but
 * the host can still see whether the immutable initial package lacks exactly
 * one required role.  That gives the one continuation permission to repair
 * the response and admit one same-snapshot card together.  It never accepts
 * a planner-supplied hidden ID or turns a multi-role absence into a retry.
 */
function verifierDirectedMalformedPlannerRecovery(input: {
  proposal?: AnalyticalPlannerProposalV1;
  plannerCandidates: AgentEvidenceCandidate[];
  requirements: AnalyticalRequirementSetV1;
}): VerifierDirectedTargetedRecoveryV1 | undefined {
  if (input.proposal && plannerProposalReferencesOutsideCandidates(input.proposal, input.plannerCandidates)) {
    return undefined;
  }
  const missingRoles = requiredRoles(input.requirements).filter((role) => !input.plannerCandidates.some((candidate) => {
    if (!candidateCanBindPlannerRole(candidate, role)) return false;
    if (role === 'relationship') return evidenceCandidateRoles(candidate).includes('relationship');
    if (role === 'time_dimension') return candidateCanBindPlannerRole(candidate, role);
    const requiredTerms = plannerRequiredTermsForRole(input.requirements, role);
    return requiredTerms.length === 0
      ? evidenceCandidateRoles(candidate).includes(role)
      : requiredTerms.some((term) => {
          if (candidateMatchesPlannerRequirementTerm(candidate, term)) return true;
          // A sole safe ordinary field has already been admitted as a typed
          // inferred substitution. It is not a reason to launch targeted
          // retrieval for the same role just because its physical label does
          // not literally contain the user term (for example region ->
          // location_name). The bounded planner correction below receives
          // this exact card and must still bind it.
          return role === 'categorical_dimension'
            && candidateHasUniqueInferredRoleSubstitution(candidate, { role, terms: [term] });
        });
  }));
  if (missingRoles.length !== 1) return undefined;
  const missingRole = missingRoles[0]!;
  return {
    request: {
      version: 1,
      missingRoles: [missingRole],
      searchTerms: targetedSearchTermsForRole(input.requirements, missingRole),
    },
    feedback: {
      version: 1,
      status: 'needs_targeted_context',
      missingRoles: [missingRole],
      candidateIds: stableCandidateIds(input.plannerCandidates).slice(0, MAX_INITIAL_PLANNER_CANDIDATES),
      reasonCode: 'malformed_planner_output_role_targeted_extension_required',
    },
  };
}

function verifyPlannerInterpretation(input: {
  proposal?: AnalyticalPlannerProposalV1;
  resolution: MeaningResolution;
  candidates: AgentEvidenceCandidate[];
  requirements: AnalyticalRequirementSetV1;
  question: string;
  mission: AnalyticalMissionV1;
}): { ok: true; value: VerifiedPlannerInterpretationV1 } | { ok: false; feedback: ProgramVerificationFeedbackV1 } {
  const selectedIds = new Set(input.resolution.selectedConceptIds);
  const selectedCandidates = input.candidates.filter((candidate) =>
    selectedIds.has(candidate.id) || selectedIds.has(stableCandidateId(candidate)));
  if (selectedCandidates.length === 0) {
    return { ok: false, feedback: plannerVerificationFailure('invalid', 'planner_selected_no_admitted_candidates') };
  }
  const proposal = input.proposal ?? plannerProposalFromMeaningResolution(input.resolution, input.candidates);
  if (!proposal.tasks.length || proposal.tasks.length > MAX_ASK_TASKS) {
    return { ok: false, feedback: plannerVerificationFailure('invalid', 'planner_task_count_invalid') };
  }
  // `splitAnalyticalTasks` is only a bounded pre-planning source of possible
  // task questions.  It must not dictate how many programs the planner
  // accepts: compatible clauses (for example revenue and order count by the
  // same region) can be one semantic program, while truly independent asks
  // can become two or three frozen children.  The verifier still permits only
  // these server-derived task IDs and later requires one receipt per accepted
  // task, so this does not let a provider invent an execution graph.
  const executableTaskIds = new Set(input.mission.tasks.map((task) => task.id));
  if (input.mission.mode === 'ask' && proposal.tasks.some((task) => !executableTaskIds.has(task.taskId))) {
    return { ok: false, feedback: plannerVerificationFailure('invalid', 'planner_task_not_executable_in_ordinary_ask') };
  }
  const tasks = normalizePlannerTasks(proposal, selectedCandidates, input.mission.tasks);
  if (!plannerTasksCoverMission(tasks, input.mission, input.requirements, selectedCandidates)) {
    return { ok: false, feedback: plannerVerificationFailure('invalid', 'planner_task_coverage_incomplete') };
  }
  // Exact canonical and server-issued deterministic bindings are already
  // proven by a separate host path. The strict per-role requirement applies
  // to an ordinary provider planner proposal; do not reinterpret an exact
  // semantic capability set as an incomplete free-text plan.
  const missingBusinessRoles = input.proposal
    ? missingRequiredPlannerBusinessRoles({
        tasks,
        mission: input.mission,
        requirements: input.requirements,
        selectedCandidates,
        plannerCandidates: input.candidates,
      })
    : [];
  if (missingBusinessRoles.length > 0) {
    return {
      ok: false,
      feedback: {
        version: 1,
        status: missingBusinessRoles.length === 1 ? 'needs_targeted_context' : 'invalid',
        missingRoles: missingBusinessRoles,
        candidateIds: stableCandidateIds(selectedCandidates).slice(0, 16),
        reasonCode: missingBusinessRoles.length === 1
          ? 'planner_missing_required_business_role'
          : 'planner_missing_multiple_required_business_roles',
      },
    };
  }
  for (const task of tasks) {
    if ((task.coveredTaskIds?.length ?? 1) > input.mission.taskLimit) {
      return { ok: false, feedback: plannerVerificationFailure('invalid', 'planner_task_coverage_limit_exceeded') };
    }
    if (task.selectedConceptIds.some((id) => !selectedIds.has(id)
      && !selectedCandidates.some((candidate) => candidate.id === id || stableCandidateId(candidate) === id))) {
      return { ok: false, feedback: plannerVerificationFailure('invalid', 'planner_selected_id_not_in_verified_selection') };
    }
    for (const [role, ids] of Object.entries(task.roleBindings)) {
      if (!isEvidenceCandidateRole(role)) {
        return { ok: false, feedback: plannerVerificationFailure('invalid', 'planner_role_invalid') };
      }
      for (const id of ids ?? []) {
        const candidate = selectedCandidates.find((item) => item.id === id || stableCandidateId(item) === id);
        if (!candidate || !candidateCanBindPlannerRole(candidate, role)) {
          return { ok: false, feedback: plannerVerificationFailure('invalid', 'planner_role_binding_unproven') };
        }
      }
    }
    if (task.operations.length === 0 || task.operations.some((operation) => !ALLOWED_PLANNER_OPERATIONS.has(operation))) {
      return { ok: false, feedback: plannerVerificationFailure('invalid', 'planner_operation_invalid') };
    }
  }
  const operations = new Set(tasks.flatMap((task) => task.operations));
  const requirements = requirementsForVerifiedPlanner({
    requirements: input.requirements,
    selectedCandidates,
    tasks,
    operations,
    question: input.question,
  });
  if (!requirements) {
    return { ok: false, feedback: plannerVerificationFailure('invalid', 'planner_operation_conflicts_with_request') };
  }
  return {
    ok: true,
    value: {
      tasks,
      requirements,
      feedback: {
        version: 1,
        status: 'valid',
        missingRoles: [],
        candidateIds: stableCandidateIds(selectedCandidates).slice(0, 16),
        reasonCode: 'planner_business_interpretation_verified',
      },
    },
  };
}

/**
 * A time role is the one role whose canonical binding may live on a semantic
 * metric rather than on a separately retrieved dimension card. MetricFlow
 * capability metadata declares the metric's authored time children; allowing
 * that narrow binding here does not let the planner invent a date field or a
 * grain. The later compiler still resolves the exact child, validates its
 * supported grain, and applies calendar policy.
 */
function candidateCanBindPlannerRole(candidate: AgentEvidenceCandidate, role: EvidenceCandidateRoleV1): boolean {
  if (evidenceCandidateRoles(candidate).includes(role)) return true;
  return role === 'time_dimension'
    && candidate.kind === 'semantic_metric'
    && (candidate.analyticalCapability?.timeDimensions.length ?? 0) > 0;
}

/**
 * The verifier, not the planner, decides whether a targeted extension is
 * legal. The planner can only help with a normalized term for a role it has
 * demonstrably not bound. This prevents an LLM from using a recovery payload
 * as an out-of-package identity channel.
 */
function verifierDirectedTargetedRecovery(input: {
  proposal?: AnalyticalPlannerProposalV1;
  resolution: MeaningResolution;
  plannerCandidates: AgentEvidenceCandidate[];
  requirements: AnalyticalRequirementSetV1;
  mission: AnalyticalMissionV1;
}): VerifierDirectedTargetedRecoveryV1 | undefined {
  const plannerControlled = Boolean(input.proposal);
  const proposal = input.proposal ?? plannerProposalFromMeaningResolution(input.resolution, input.plannerCandidates);
  const selectedIds = new Set(input.resolution.selectedConceptIds);
  const selectedCandidates = input.plannerCandidates.filter((candidate) =>
    selectedIds.has(candidate.id) || selectedIds.has(stableCandidateId(candidate)));
  const tasks = normalizePlannerTasks(proposal, selectedCandidates, input.mission.tasks);
  const missingRoles = plannerControlled
    ? missingRequiredPlannerBusinessRoles({
        tasks,
        mission: input.mission,
        requirements: input.requirements,
        selectedCandidates,
        plannerCandidates: input.plannerCandidates,
      })
    : [];
  const feedback = (roles: EvidenceCandidateRoleV1[], reasonCode: string): ProgramVerificationFeedbackV1 => ({
    version: 1,
    status: roles.length === 1 ? 'needs_targeted_context' : 'invalid',
    missingRoles: roles,
    candidateIds: stableCandidateIds(selectedCandidates).slice(0, 16),
    reasonCode,
  });
  const requested = proposal.recovery;
  if (requested) {
    const candidateIds = [...(requested.candidateIds ?? []), ...(requested.relatedCandidateIds ?? [])];
    const referencesOutsidePlanner = candidateIds.some((id) => !input.plannerCandidates.some((candidate) => candidateMatchesStableIdentity(candidate, id)));
    if (referencesOutsidePlanner) {
      return {
        feedback: feedback([], 'planner_recovery_referenced_unadmitted_candidate'),
        invalidReason: 'The planner recovery request referenced a candidate outside its supplied package. No query was executed.',
        securityViolation: true,
      };
    }
    if (requested.missingRoles.length !== 1 || !requested.missingRoles.every(isEvidenceCandidateRole)) {
      return {
        feedback: feedback([], 'planner_recovery_role_invalid'),
        invalidReason: 'The planner recovery request did not name exactly one valid missing role. No query was executed.',
      };
    }
    const requestedRole = requested.missingRoles[0]!;
    if (missingRoles.length !== 1 || missingRoles[0] !== requestedRole) {
      return {
        feedback: feedback(missingRoles, 'planner_recovery_role_not_verifier_missing'),
        invalidReason: 'The planner requested recovery for a role that the verifier did not prove missing. No query was executed.',
      };
    }
    return {
      request: {
        version: 1,
        missingRoles: [requestedRole],
        ...(requested.searchTerms?.length ? { searchTerms: requested.searchTerms.map(normalizePlannerAdmissionText).filter(Boolean).slice(0, 4) } : {}),
        ...(requested.relatedCandidateIds?.length ? { relatedCandidateIds: [...requested.relatedCandidateIds].slice(0, 4) } : {}),
        ...(requested.candidateIds?.length ? { candidateIds: [...requested.candidateIds].slice(0, 4) } : {}),
        ...(requested.relationshipPathIds?.length ? { relationshipPathIds: [...requested.relationshipPathIds].slice(0, 3) } : {}),
      },
      feedback: feedback([requestedRole], 'verifier_role_targeted_extension_required'),
    };
  }
  if (missingRoles.length === 1) {
    const missingRole = missingRoles[0]!;
    return {
      request: {
        version: 1,
        missingRoles: [missingRole],
        searchTerms: targetedSearchTermsForRole(input.requirements, missingRole),
      },
      feedback: feedback([missingRole], 'verifier_role_targeted_extension_required'),
    };
  }
  return missingRoles.length > 1
    ? { feedback: feedback(missingRoles, 'planner_missing_multiple_required_business_roles') }
    : undefined;
}

/**
 * A single frozen program must explicitly bind every requested business role.
 * Capability metadata may prove an authored time child of an already selected
 * metric, but it may not let an unselected display/category/member card leak
 * in from the 32-card execution closure.
 */
function missingRequiredPlannerBusinessRoles(input: {
  tasks: AnalyticalProgramV2['planner']['tasks'];
  mission: AnalyticalMissionV1;
  requirements: AnalyticalRequirementSetV1;
  selectedCandidates: AgentEvidenceCandidate[];
  /** The immutable planner package, including unresolved-role reservations. */
  plannerCandidates: AgentEvidenceCandidate[];
}): EvidenceCandidateRoleV1[] {
  if (input.mission.mode !== 'ask') return [];
  const missionById = new Map(input.mission.tasks.map((task) => [task.id, task]));
  const missing = new Set<EvidenceCandidateRoleV1>();
  for (const task of input.tasks) {
    // A merged compatible task must prove each source clause, while ordinary
    // multi-task Ask proves one frozen tuple per task. In neither case may a
    // selected Region card silently stand in for requested Region *and*
    // Product Category just because both use the categorical role.
    const coveredTaskIds = task.coveredTaskIds?.length ? task.coveredTaskIds : [task.taskId];
    const selectedForTask = input.selectedCandidates.filter((candidate) =>
      task.selectedConceptIds.includes(candidate.id) || task.selectedConceptIds.includes(stableCandidateId(candidate)));
    for (const taskId of coveredTaskIds) {
      const missionTask = missionById.get(taskId);
      if (!missionTask) {
        missing.add('context');
        continue;
      }
      const taskRequirements = requirementsForPlannerVerification(input.requirements, missionTask.question);
      for (const role of requiredRoles(taskRequirements)) {
        if (role === 'relationship' && !selectedBusinessCardsRequireRelationship(task, selectedForTask)) continue;
        if (!plannerTaskRoleCoversExplicitRequirements({
          role,
          task,
          candidates: selectedForTask,
          plannerCandidates: input.plannerCandidates,
          requirements: taskRequirements,
        })) missing.add(role);
      }
    }
  }
  return [...missing];
}

/**
 * Role presence alone is not enough. A request for "revenue by region and
 * product category" needs two separately proved categorical bindings; a
 * metric/card from the execution closure may not fill missing business roles
 * after freeze. This helper validates only current-question explicit terms;
 * parser-only hints remain advisory and may be corrected by the planner.
 */
function plannerTaskRoleCoversExplicitRequirements(input: {
  role: EvidenceCandidateRoleV1;
  task: AnalyticalProgramV2['planner']['tasks'][number];
  candidates: AgentEvidenceCandidate[];
  plannerCandidates: AgentEvidenceCandidate[];
  requirements: AnalyticalRequirementSetV1;
}): boolean {
  const ids = new Set(input.task.roleBindings[input.role] ?? []);
  const bound = input.candidates.filter((candidate) =>
    (ids.has(candidate.id) || ids.has(stableCandidateId(candidate)))
    && evidenceCandidateRoles(candidate).includes(input.role));
  if (input.role === 'time_dimension') {
    if (bound.length > 0) return true;
    return input.candidates.some((candidate) =>
      ids.has(candidate.id)
      && candidate.kind === 'semantic_metric'
      && (candidate.analyticalCapability?.timeDimensions.length ?? 0) > 0);
  }
  if (bound.length === 0) return false;
  const requiredTerms = plannerRequiredTermsForRole(input.requirements, input.role);
  // A relationship is structural evidence rather than a phrase match. Its
  // safe path/cardinality validation remains with the compiler broker.
  if (input.role === 'relationship' || requiredTerms.length === 0) return true;
  return requiredTerms.every((term) => {
    if (bound.some((candidate) => candidateMatchesPlannerRequirementTerm(candidate, term))) return true;
    // An ordinary qualified field can be offered to the planner for an
    // unresolved business term (for example `locations.location_name` for
    // “region”), but it never becomes an alias merely by admission. The
    // selected field is valid only when it was the *sole* role-compatible
    // candidate retained for that exact term. Two candidates remain a real
    // ambiguity and are handled as a clarification below.
    if (input.role !== 'categorical_dimension') return false;
    const slot: PlannerAdmissionSlotV1 = { role: input.role, terms: [term] };
    const selectedInferred = bound.filter((candidate) => candidateHasUniqueInferredRoleSubstitution(candidate, slot));
    const admittedInferred = input.plannerCandidates.filter((candidate) => candidateHasUniqueInferredRoleSubstitution(candidate, slot));
    return selectedInferred.length === 1
      && admittedInferred.length === 1
      && stableCandidateId(selectedInferred[0]!) === stableCandidateId(admittedInferred[0]!);
  });
}

function plannerRequiredTermsForRole(
  requirements: AnalyticalRequirementSetV1,
  role: EvidenceCandidateRoleV1,
): string[] {
  switch (role) {
    case 'metric':
      return uniqueStrings([...(requirements.ranking?.metricTerms ?? []), ...requirements.measures]);
    case 'entity_key':
      return [...requirements.entityTerms];
    case 'entity_label':
      return [...requirements.entityDisplayTerms];
    case 'categorical_dimension':
      return categoricalTermsForRuntime(requirements);
    case 'member':
      return [...requirements.memberTerms];
    case 'time_dimension':
    case 'relationship':
    case 'context':
      return [];
  }
}

function candidateMatchesPlannerRequirementTerm(candidate: AgentEvidenceCandidate, term: string): boolean {
  const identity = candidateIdentityTerms(candidate);
  const normalized = normalizePlannerAdmissionText(term);
  if (!normalized) return false;
  if (identity.includes(normalized)) return true;
  const tokens = normalized.split(' ').filter((token) => token.length > 2);
  return tokens.length > 0 && tokens.every((token) => identity.includes(token));
}

function selectedBusinessCardsRequireRelationship(
  task: AnalyticalProgramV2['planner']['tasks'][number],
  selectedCandidates: AgentEvidenceCandidate[],
): boolean {
  const selectedIds = new Set(task.selectedConceptIds);
  const metrics = selectedCandidates.filter((candidate) =>
    selectedIds.has(candidate.id) || selectedIds.has(stableCandidateId(candidate)))
    .filter((candidate) => candidate.kind === 'semantic_metric' && candidate.analyticalCapability);
  if (metrics.length === 0) return true;
  const boundDimensionIds = new Set([
    ...(task.roleBindings.entity_key ?? []),
    ...(task.roleBindings.entity_label ?? []),
    ...(task.roleBindings.categorical_dimension ?? []),
  ]);
  if (boundDimensionIds.size === 0) return false;
  const entityIds = new Set<string>();
  for (const metric of metrics) {
    const capability = metric.analyticalCapability!;
    for (const dimension of capability.dimensions) {
      if (boundDimensionIds.has(dimension.dimensionId)) entityIds.add(dimension.entityId);
    }
  }
  // If capability metadata names every selected business dimension and they
  // share one entity, no join/relationship card is needed. Missing capability
  // proof stays conservative and requires a relationship card.
  const allBoundHaveEntity = [...boundDimensionIds].every((id) => [...entityIds].length > 0
    && metrics.some((metric) => metric.analyticalCapability?.dimensions.some((dimension) =>
      dimension.dimensionId === id)));
  return !allBoundHaveEntity || entityIds.size > 1;
}

/**
 * Ordinary Ask cannot turn a subset of independent ingress clauses into a
 * partial success. A one-program merge is legal only when the proposal states
 * every covered server task and its selected, role-proven cards satisfy the
 * whole framed tuple. The provider never gets to omit a task silently.
 */
function plannerTasksCoverMission(
  tasks: AnalyticalProgramV2['planner']['tasks'],
  mission: AnalyticalMissionV1,
  requirements: AnalyticalRequirementSetV1,
  selectedCandidates: AgentEvidenceCandidate[],
): boolean {
  const missionIds = new Set(mission.tasks.map((task) => task.id));
  const coveredIds = new Set<string>();
  for (const task of tasks) {
    const coverage = uniqueStableIds(task.coveredTaskIds?.length ? task.coveredTaskIds : [task.taskId]);
    if (!coverage.includes(task.taskId) || coverage.some((id) => !missionIds.has(id))) return false;
    if (coverage.length > 1 && !plannerTaskCanProveMergedCoverage(task, coverage, mission, requirements, selectedCandidates)) return false;
    for (const taskId of coverage) coveredIds.add(taskId);
  }
  return coveredIds.size === missionIds.size && [...missionIds].every((id) => coveredIds.has(id));
}

function plannerTaskCanProveMergedCoverage(
  task: AnalyticalProgramV2['planner']['tasks'][number],
  coveredTaskIds: string[],
  mission: AnalyticalMissionV1,
  requirements: AnalyticalRequirementSetV1,
  selectedCandidates: AgentEvidenceCandidate[],
): boolean {
  // A merge is not a narration shortcut: one route-neutral program must have
  // a real analytical operation and a role-proven tuple covering the complete
  // parent frame. Compiler/grain/join validation still happens later.
  if (!task.operations.some((operation) => operation === 'aggregate' || operation === 'project' || operation === 'group')) return false;
  const coveredQuestions = coveredTaskIds
    .map((id) => mission.tasks.find((candidate) => candidate.id === id)?.question)
    .filter((question): question is string => Boolean(question));
  if (coveredQuestions.length !== coveredTaskIds.length
    || !compatibleMergedTaskShapes(coveredQuestions)) return false;
  const selectedIds = new Set(task.selectedConceptIds);
  const taskCandidates = selectedCandidates.filter((candidate) =>
    selectedIds.has(candidate.id) || selectedIds.has(stableCandidateId(candidate)));
  return requiredRoles(requirements).every((role) => {
    const bound = task.roleBindings[role] ?? [];
    return bound.some((id) => taskCandidates.some((candidate) =>
      (candidate.id === id || stableCandidateId(candidate) === id)
      && evidenceCandidateRoles(candidate).includes(role)))
      || taskCandidates.some((candidate) => evidenceCandidateRoles(candidate).includes(role));
  });
}

/**
 * A merged ordinary-Ask program may union compatible measures, but it cannot
 * blur a different grouping, ranking entity/limit, filter/member literal, or
 * time/calendar/grain. This is deliberately deterministic and conservative:
 * if per-clause parsing cannot prove one analytical shape, every clause must
 * remain its own frozen task instead of producing a partial or mixed result.
 */
function compatibleMergedTaskShapes(questions: string[]): boolean {
  const shapes = questions.map((question) => mergedTaskShape(buildAnalyticalRequirementSet({ question }), question));
  const anchor = shapes[0];
  return Boolean(anchor) && shapes.slice(1).every((shape) =>
    sameStringSet(shape.dimensions, anchor.dimensions)
    && sameStringSet(shape.entityTerms, anchor.entityTerms)
    && sameStringSet(shape.entityDisplayTerms, anchor.entityDisplayTerms)
    && sameStringSet(shape.memberTerms, anchor.memberTerms)
    && sameStringSet(shape.outputTerms, anchor.outputTerms)
    && shape.grain === anchor.grain
    && sameFilters(shape.filters, anchor.filters)
    && sameRankingShape(shape.ranking, anchor.ranking)
    && sameTimeShape(shape.time, anchor.time));
}

function mergedTaskShape(requirements: AnalyticalRequirementSetV1, question = ''): {
  dimensions: string[];
  entityTerms: string[];
  entityDisplayTerms: string[];
  memberTerms: string[];
  outputTerms: string[];
  grain?: AnalyticalRequirementSetV1['grain'];
  filters: Array<{ field: string; value: string }>;
  ranking?: { metricTerms: string[]; entityTerms: string[]; direction: string; limit: number };
  time?: { role: string; grain?: string; fiscalPeriod?: string };
} {
  const seed = buildAnalyticalRequirementSeedV1({ question, requirements });
  return {
    dimensions: normalizedShapeTerms(requirements.dimensions),
    entityTerms: normalizedShapeTerms(requirements.entityTerms),
    entityDisplayTerms: normalizedShapeTerms(requirements.entityDisplayTerms),
    memberTerms: normalizedShapeTerms(requirements.memberTerms),
    outputTerms: normalizedShapeTerms(requirements.outputTerms ?? []),
    ...(requirements.grain ? { grain: requirements.grain } : {}),
    filters: seed.queryIntent.filters.map((filter) => ({
      field: normalizePlannerAdmissionText(filter.field),
      value: normalizePlannerAdmissionText(filter.value),
    })).sort((left, right) => `${left.field}:${left.value}`.localeCompare(`${right.field}:${right.value}`)),
    ...(requirements.ranking ? {
      ranking: {
        metricTerms: normalizedShapeTerms(requirements.ranking.metricTerms),
        entityTerms: normalizedShapeTerms(requirements.ranking.entityTerms),
        direction: requirements.ranking.direction,
        limit: requirements.ranking.limit,
      },
    } : {}),
    ...(requirements.time ? {
      time: {
        role: requirements.time.role,
        ...(requirements.time.grain ? { grain: requirements.time.grain } : {}),
        ...(requirements.time.fiscalPeriod ? { fiscalPeriod: requirements.time.fiscalPeriod } : {}),
      },
    } : {}),
  };
}

function normalizedShapeTerms(terms: readonly string[]): string[] {
  return uniqueStrings(terms.map(normalizePlannerAdmissionText)).sort();
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameFilters(
  left: Array<{ field: string; value: string }>,
  right: Array<{ field: string; value: string }>,
): boolean {
  return left.length === right.length && left.every((value, index) =>
    value.field === right[index]?.field && value.value === right[index]?.value);
}

function sameRankingShape(
  left: { metricTerms: string[]; entityTerms: string[]; direction: string; limit: number } | undefined,
  right: { metricTerms: string[]; entityTerms: string[]; direction: string; limit: number } | undefined,
): boolean {
  return left === undefined || right === undefined
    ? left === right
    : left.direction === right.direction
      && left.limit === right.limit
      && sameStringSet(left.metricTerms, right.metricTerms)
      && sameStringSet(left.entityTerms, right.entityTerms);
}

function sameTimeShape(
  left: { role: string; grain?: string; fiscalPeriod?: string } | undefined,
  right: { role: string; grain?: string; fiscalPeriod?: string } | undefined,
): boolean {
  return left === undefined || right === undefined
    ? left === right
    : left.role === right.role && left.grain === right.grain && left.fiscalPeriod === right.fiscalPeriod;
}

/** Select the planner-accepted subset of the bounded pre-planning mission. */
function missionForVerifiedPlanner(
  mission: AnalyticalMissionV1,
  tasks: AnalyticalProgramV2['planner']['tasks'],
): AnalyticalMissionV1 | undefined {
  const taskIds = tasks.map((task) => task.taskId);
  if (taskIds.length === 0 || taskIds.length > mission.taskLimit || new Set(taskIds).size !== taskIds.length) return undefined;
  const selectedTasks = taskIds.map((taskId) => mission.tasks.find((task) => task.id === taskId));
  if (selectedTasks.some((task) => !task)) return undefined;
  const selectedTaskSet = new Set(taskIds);
  return {
    ...mission,
    tasks: selectedTasks as AnalyticalMissionV1['tasks'],
    hypotheses: mission.hypotheses
      .filter((hypothesis) => selectedTaskSet.has(hypothesis.taskId))
      .map((hypothesis) => ({ ...hypothesis })),
    // `deferredTasks` was a legacy partial-answer carrier. An authoritative
    // ordinary Ask either accepts a task and executes it or rejects it before
    // freeze; do not persist lexical leftovers as a successful plan.
    ...(mission.mode === 'ask' ? { deferredTasks: undefined } : {}),
  };
}

function plannerVerificationFailure(
  status: Extract<ProgramVerificationFeedbackV1['status'], 'invalid' | 'denied'>,
  reasonCode: string,
): ProgramVerificationFeedbackV1 {
  return { version: 1, status, missingRoles: [], candidateIds: [], reasonCode };
}

function requirementsForVerifiedPlanner(input: {
  requirements: AnalyticalRequirementSetV1;
  selectedCandidates: AgentEvidenceCandidate[];
  tasks: AnalyticalProgramV2['planner']['tasks'];
  operations: Set<AnalyticalPlannerOperationV1>;
  question: string;
}): AnalyticalRequirementSetV1 | undefined {
  const candidateById = new Map<string, AgentEvidenceCandidate>();
  for (const candidate of input.selectedCandidates) {
    candidateById.set(candidate.id, candidate);
    candidateById.set(stableCandidateId(candidate), candidate);
  }
  const termsForRole = (role: EvidenceCandidateRoleV1): string[] => {
    const ids = input.tasks.flatMap((task) => task.roleBindings[role] ?? []);
    return uniqueStrings(ids
      .map((id) => candidateById.get(id))
      .filter((candidate): candidate is AgentEvidenceCandidate => Boolean(candidate))
      .map(candidateRequirementTerm));
  };
  const metricTerms = termsForRole('metric');
  const entityKeyTerms = termsForRole('entity_key');
  const entityLabelTerms = termsForRole('entity_label');
  const categoricalTerms = termsForRole('categorical_dimension');
  const timeTerms = termsForRole('time_dimension');
  const memberTerms = termsForRole('member');
  // A host seed can carry parser-derived output words from an earlier turn.
  // Keep only literal outputs the current user actually named; the verified
  // role cards replace the rest. This preserves an explicit output constraint
  // while preventing `legacy spend`/`owner email` from surviving a planner
  // correction merely because they once appeared in a stale seed.
  const explicitOutputTerms = (input.requirements.outputTerms ?? [])
    .filter((term) => questionMentionsRequirementTerm(input.question, term));
  // Measures are already expressed through the metric role and query measure
  // bindings. Repeating one as a generic `output` makes the legacy resolved
  // plan try to bind a semantic metric as a dimension/column projection and
  // falsely block an otherwise complete MetricFlow program.
  const roleBoundTerms = [...metricTerms, ...entityLabelTerms, ...categoricalTerms]
    .map(normalizePlannerAdmissionText)
    .filter(Boolean);
  const projectionOutputTerms = explicitOutputTerms.filter((term) => {
    const normalized = normalizePlannerAdmissionText(term);
    return !roleBoundTerms.includes(normalized);
  });
  // The planner's qualified role bindings are the authoritative analytical
  // interpretation.  The deterministic seed remains a default only when the
  // planner did not bind that role.  In particular, an owner/email/sentiment
  // card cannot replace an entity label because the loop above admits only a
  // candidate whose locally-proven role is entity_label.
  const requirements: AnalyticalRequirementSetV1 = {
    ...input.requirements,
    measures: metricTerms.length > 0 ? metricTerms : [...input.requirements.measures],
    dimensions: uniqueStrings([
      ...(categoricalTerms.length > 0 ? categoricalTerms : input.requirements.dimensions),
      ...(entityLabelTerms.length > 0 ? entityLabelTerms : input.requirements.entityDisplayTerms),
    ]),
    entityTerms: entityKeyTerms.length > 0 ? entityKeyTerms : [...input.requirements.entityTerms],
    entityDisplayTerms: entityLabelTerms.length > 0 ? entityLabelTerms : [...input.requirements.entityDisplayTerms],
    // Member values are a user-owned filter boundary.  A member card can prove
    // a qualified member ID, but must not replace the original literal.
    memberTerms: input.requirements.memberTerms.length > 0
      ? [...input.requirements.memberTerms]
      : memberTerms,
    ...(projectionOutputTerms.length
      ? {
          outputTerms: uniqueStrings([
            ...projectionOutputTerms,
          ]),
        }
      : {}),
    ...(input.requirements.time
      ? { time: { ...input.requirements.time } }
      : timeTerms.length > 0
        ? { time: { role: 'time_axis' as const, requiresDeclaredFiscalCalendar: false } }
        : {}),
  };
  // A planner may affirm an explicit/obvious ranking operation, but cannot
  // change a non-ranking user question into a different ranked result.
  if (input.operations.has('rank') && !requirements.ranking) {
    if (!/\b(top|bottom|highest|lowest|most|least|rank)\b/i.test(input.question)) return undefined;
    const rankingMetricTerms = requirements.measures.length > 0
      ? [...requirements.measures]
      : input.selectedCandidates
        .filter((candidate) => evidenceCandidateRoles(candidate).includes('metric'))
        .map((candidate) => candidate.name)
        .slice(0, 1);
    if (rankingMetricTerms.length === 0) return undefined;
    requirements.ranking = {
      metricTerms: rankingMetricTerms,
      entityTerms: requirements.entityTerms.length > 0
        ? [...requirements.entityTerms]
        : [...requirements.entityDisplayTerms],
      direction: /\b(bottom|lowest|least)\b/i.test(input.question) ? 'bottom' : 'top',
      limit: 10,
      defaultedLimit: true,
    };
  } else if (requirements.ranking) {
    requirements.ranking = {
      ...requirements.ranking,
      metricTerms: requirements.measures.length > 0
        ? [...requirements.measures]
        : [...requirements.ranking.metricTerms],
      entityTerms: requirements.entityTerms.length > 0
        ? [...requirements.entityTerms]
        : requirements.entityDisplayTerms.length > 0
          ? [...requirements.entityDisplayTerms]
          : [...requirements.ranking.entityTerms],
    };
  }
  // A comparison/trend operation must be grounded in the already-framed
  // request. The compiler still decides whether supported grain/additivity
  // exists; this prevents planner prose from inventing a time/comparison ask.
  if (input.operations.has('trend') && !requirements.time && !/\b(over time|trend|monthly|weekly|quarterly|daily|yearly)\b/i.test(input.question)) return undefined;
  if (input.operations.has('compare') && !/\b(compare|versus|vs\.?|difference|change)\b/i.test(input.question)) return undefined;
  return requirements;
}

/**
 * Retrieval admission must reserve cards for what the user actually asked,
 * not let an inherited parser guess become an unreviewed policy decision.
 * Keep all typed terms for search/role balancing, but only retain a ranking
 * measure as an exclusion constraint when that measure is explicitly present
 * in the current question.  The later verifier still rejects a candidate that
 * conflicts with an explicit user ranking measure.
 */
function requirementsForPlannerAdmission(
  requirements: AnalyticalRequirementSetV1,
  question: string,
): AnalyticalRequirementSetV1 {
  const rankingTerms = requirements.ranking?.metricTerms ?? [];
  if (!requirements.ranking || rankingTerms.some((term) => questionMentionsRequirementTerm(question, term))) {
    return requirements;
  }
  return {
    ...requirements,
    // A stale/default ranking seed is advisory until a verified planner
    // binding proves a canonical metric. Removing it here does not remove the
    // user's filter/time literals or authorize a different ranking later.
    ranking: undefined,
  };
}

/**
 * The analytical parser is intentionally advisory for ordinary Ask. Build a
 * small verification shape from the current source question itself before the
 * provider sees cards or before the verifier demands role bindings. This
 * prevents an old retrieval/parser phrase from requiring an unrelated metric,
 * entity display, or dimension, while retaining actual user time/ranking and
 * output literals. Filters themselves remain in the host seed and are never
 * replaced by this helper.
 */
function requirementsForPlannerVerification(
  requirements: AnalyticalRequirementSetV1,
  question: string,
  parsedIntent?: AgentRetrievalEvidence['parsedIntent'],
): AnalyticalRequirementSetV1 {
  // A same-snapshot parser may have recognized a current-question role such
  // as `region` even when a host seed was reconstructed only to carry a
  // selected prior-result binding. Keep that role if it is demonstrably in
  // the current wording; do not revive stale terms from older turns.
  const lexical = buildAnalyticalRequirementSet({ question, parsedIntent });
  const grounded = (terms: readonly string[]) => terms.filter((term) => questionMentionsRequirementTerm(question, term));
  const entityDisplayTerms = uniqueStrings([
    ...lexical.entityDisplayTerms,
    ...requirements.entityDisplayTerms.filter((term) => {
      const normalized = normalizePlannerAdmissionText(term);
      const entityRoot = normalized.replace(/\b(name|id|key|label)\b/g, '').trim();
      return Boolean(entityRoot) && questionMentionsRequirementTerm(question, entityRoot);
    }),
  ]);
  return {
    ...requirements,
    measures: uniqueStrings([...lexical.measures, ...grounded(requirements.measures)]),
    dimensions: uniqueStrings([...lexical.dimensions, ...grounded(requirements.dimensions)]),
    entityTerms: uniqueStrings([...lexical.entityTerms, ...grounded(requirements.entityTerms)]),
    entityDisplayTerms,
    memberTerms: uniqueStrings([...lexical.memberTerms, ...grounded(requirements.memberTerms)]),
    ...(lexical.outputTerms?.length
      ? { outputTerms: [...lexical.outputTerms] }
      : { outputTerms: grounded(requirements.outputTerms ?? []) }),
    ...(lexical.ranking ? { ranking: { ...lexical.ranking } } : { ranking: undefined }),
    ...(lexical.time ? { time: { ...lexical.time } } : { time: undefined }),
    ...(lexical.grain ? { grain: lexical.grain } : {}),
  };
}

function questionMentionsRequirementTerm(question: string, term: string): boolean {
  const normalizedQuestion = normalizePlannerAdmissionText(question);
  const normalizedTerm = normalizePlannerAdmissionText(term);
  if (!normalizedTerm) return false;
  if (normalizedQuestion.includes(normalizedTerm)) return true;
  const tokens = normalizedTerm.split(' ').filter((token) => token.length > 2);
  return tokens.length > 0 && tokens.every((token) => normalizedQuestion.includes(token));
}

function normalizePlannerAdmissionText(value: string): string {
  return value.toLowerCase()
    .replace(/[_./:-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function candidateRequirementTerm(candidate: AgentEvidenceCandidate): string {
  return candidate.name.trim() || candidate.aliases?.find((alias) => alias.trim())?.trim() || stableCandidateId(candidate);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/**
 * Preserve the raw user predicate/time literals while rebuilding the
 * compiler-facing seed from a verified planner interpretation.  This prevents
 * an early parser error from reappearing in the compiler after the planner
 * correctly selected canonical metric/entity/dimension cards.
 */
function requirementSeedForVerifiedPlanner(input: {
  seed: ReturnType<typeof buildAnalyticalRequirementSeedV1>;
  requirements: AnalyticalRequirementSetV1;
  /** The frozen task's question; parent compound prose is trace-only. */
  sourceQuestion?: string;
}): ReturnType<typeof buildAnalyticalRequirementSeedV1> {
  const requirements = input.requirements;
  return {
    ...input.seed,
    ...(input.sourceQuestion ? { sourceQuestion: input.sourceQuestion } : {}),
    requirements,
    queryIntent: {
      ...input.seed.queryIntent,
      measures: [...requirements.measures],
      dimensions: uniqueStrings([
        ...requirements.dimensions,
        ...requirements.entityDisplayTerms,
      ]),
      // Filter field/value pairs are intentionally preserved from the source
      // question. Planner output may bind a member ID later but cannot alter
      // these literals.
      filters: input.seed.queryIntent.filters.map((filter) => ({ ...filter })),
      ...(requirements.time?.grain
        ? { timeGrain: requirements.time.grain }
        : input.seed.queryIntent.timeGrain ? { timeGrain: input.seed.queryIntent.timeGrain } : {}),
      ...(requirements.ranking
        ? {
            order: requirements.ranking.direction === 'bottom' ? 'asc' as const : 'desc' as const,
            limit: requirements.ranking.limit,
          }
        : {}),
    },
  };
}

/**
 * The compiler still uses the established router implementation, whose plan
 * builders read `evidence.parsedIntent` as a compatibility input.  That
 * parser refinement is retrieval evidence, not the business interpretation
 * once the verifier has accepted a planner task.  Project the verified seed
 * into a task-local view of the *same* immutable snapshot before handing it
 * to the compiler.  Candidate membership, source fingerprints, readiness,
 * policies, and relationship proof remain untouched.
 *
 * This is deliberately not a mutation of the stored retrieval evidence: a
 * second task can have a different verified tuple, and no compiler receives a
 * broadened candidate set or a rewritten source snapshot.
 */
function evidenceForVerifiedPlanner(
  evidence: AgentRetrievalEvidence,
  seed: ReturnType<typeof buildAnalyticalRequirementSeedV1>,
): AgentRetrievalEvidence {
  const queryIntent = seed.queryIntent;
  return {
    ...evidence,
    parsedIntent: {
      ...evidence.parsedIntent,
      measures: [...queryIntent.measures],
      dimensions: [...queryIntent.dimensions],
      filters: queryIntent.filters.map((filter) => ({ ...filter })),
      ...(queryIntent.timeRange ? { timeRange: queryIntent.timeRange } : {}),
      ...(queryIntent.timeGrain ? { timeGrain: queryIntent.timeGrain } : {}),
      ...(queryIntent.order ? { order: queryIntent.order } : {}),
      ...(queryIntent.limit !== undefined ? { limit: queryIntent.limit } : {}),
    },
  };
}

/**
 * Compatibility resolution merging protects legacy candidate-only callers by
 * dropping a metric that does not match an inherited lexical seed. That is
 * too early for the authoritative planner path: a locally-proven planner
 * role binding is expressly allowed to repair an incomplete/stale seed.
 *
 * Keep user-owned query literals, but retain the candidate identities for the
 * deterministic verifier. Package membership, role proof, explicit user
 * ranking conflicts, capability, joins, grain, and policy are all checked
 * after this boundary before any compiler can freeze.
 */
function mergeRuntimePlannerResolution(input: {
  seed: ReturnType<typeof buildAnalyticalRequirementSeedV1>;
  resolution: MeaningResolution;
  candidates: AgentEvidenceCandidate[];
  plannerControlled: boolean;
}): MeaningResolution {
  if (!input.plannerControlled) {
    return mergeMeaningResolutionWithRequirementSeed({
      seed: input.seed,
      resolution: input.resolution,
      candidates: input.candidates,
    });
  }
  const selectedConceptIds = [...new Set([
    ...input.resolution.selectedConceptIds,
    ...(input.resolution.recommendedExecutionId ? [input.resolution.recommendedExecutionId] : []),
  ])];
  const selectedMetric = selectedConceptIds.find((id) => input.candidates.some((candidate) =>
    (candidate.id === id || candidate.qualifiedId === id) && candidate.kind === 'semantic_metric'));
  return {
    ...input.resolution,
    interpretedQuestion: input.seed.sourceQuestion,
    selectedConceptIds,
    ...(selectedMetric ? { recommendedExecutionId: selectedMetric } : {}),
    queryIntent: {
      ...input.seed.queryIntent,
      filters: input.seed.queryIntent.filters.map((filter) => ({ ...filter })),
    },
    hostRequirementSeed: input.seed,
  };
}

function invalidPlannerResolution(reason: string): ReturnType<typeof validateMeaningResolution> {
  return { ok: false, reason } as ReturnType<typeof validateMeaningResolution>;
}

function isEvidenceCandidateRole(value: string): value is EvidenceCandidateRoleV1 {
  return value === 'metric' || value === 'entity_key' || value === 'entity_label'
    || value === 'categorical_dimension' || value === 'time_dimension' || value === 'member'
    || value === 'relationship' || value === 'context';
}

function roleBindingsForCandidates(selectedIds: string[], candidates: AgentEvidenceCandidate[]): Partial<Record<EvidenceCandidateRoleV1, string[]>> {
  const bindings: Partial<Record<EvidenceCandidateRoleV1, string[]>> = {};
  for (const candidate of candidates) {
    if (!selectedIds.includes(candidate.id) && !selectedIds.includes(stableCandidateId(candidate))) continue;
    for (const role of evidenceCandidateRoles(candidate)) {
      const values = bindings[role] ?? [];
      values.push(candidate.id);
      bindings[role] = [...new Set(values)];
    }
  }
  return bindings;
}

function operationsForQuestionType(questionType: MeaningResolution['questionType']): AnalyticalPlannerOperationV1[] {
  if (questionType === 'ranking') return ['aggregate', 'rank', 'project'];
  if (questionType === 'trend') return ['aggregate', 'group', 'trend'];
  if (questionType === 'comparison') return ['aggregate', 'group', 'compare'];
  if (questionType === 'diagnosis') return ['aggregate', 'group', 'compare'];
  return ['aggregate', 'project'];
}

function verificationFeedbackFromInvalidResolution(
  validation: ReturnType<typeof validateMeaningResolution>,
  candidateIds: string[],
): ProgramVerificationFeedbackV1 {
  return {
    version: 1,
    // A malformed/empty planner resolution has not identified one missing
    // role, so it is not eligible for targeted same-snapshot recovery.
    // Reporting `needs_targeted_context` with no role/candidate made the V6
    // trace contradict its own `recovery: not_required` receipt.
    status: 'invalid',
    missingRoles: [],
    candidateIds,
    reasonCode: validation.ok ? 'resolution_invalid' : 'planner_resolution_invalid',
  };
}

/** Record a planner boundary even if deterministic compiler verification later
 * stops before a plan can freeze.  Without this receipt a real provider call
 * looked like retrieval-only activity in the trace and hid the actual failure
 * boundary from the user. */
function workspaceWithPlannerReceipt(
  workspace: EvidenceWorkspaceV2,
  input: {
    providerMeaningRequired: boolean;
    plannerRevisionCalls: number;
    candidateIds: string[];
    deterministicBinding?: DeterministicProgramBindingV1;
    canonicalSelections: AgentEvidenceCandidate[];
  },
): EvidenceWorkspaceV2 {
  if (workspace.tools.some((tool) => tool.id === 'tool:planner')) return workspace;
  const reasonCode = input.providerMeaningRequired
    ? input.plannerRevisionCalls > 0
      ? 'planning.revision.completed'
      : 'planning.initial.completed'
    : input.deterministicBinding
      ? input.deterministicBinding.reasonCode
      : input.canonicalSelections.length > 0
        ? 'canonical_identifier_set'
        : 'canonical_or_structured_binding';
  const plannerTool: EvidenceWorkspaceV1['tools'][number] = {
    version: 1,
    id: 'tool:planner',
    kind: 'provider_meaning',
    status: input.providerMeaningRequired ? 'completed' : 'skipped',
    candidateIds: [...new Set(input.candidateIds)].slice(0, 16),
    reasonCode,
  };
  return {
    ...workspace,
    tools: [...workspace.tools, plannerTool].slice(0, MAX_TOOLS),
  };
}

function runtimeMeaningFailureDecision(input: {
  mode: AskAnalystRuntimeModeV1;
  initialState: AskAnalystStateV2;
  reason: string;
  providerAttempted?: boolean;
  providerError?: unknown;
  /** Provider was required but did not return a structured proposal. */
  providerUnavailable?: boolean;
  /** A returned proposal referenced an unavailable or invalid card. */
  providerReturnedInvalid?: boolean;
  /** A planner attempted to mint an identity outside its admitted package. */
  securityViolation?: boolean;
  planningReceipt?: import('../analytical-orchestration.js').AskAnalystPlanningReceiptV1;
}): IntentDecision {
  const state = transitionState(input.initialState, 'blocked', {
    workspace: {
      ...input.initialState.workspace,
      tools: [...input.initialState.workspace.tools, {
        version: 1 as const,
        id: 'tool:planner',
        kind: 'provider_meaning' as const,
        status: input.providerAttempted ? ('failed' as const) : ('skipped' as const),
        candidateIds: [],
        reasonCode: input.providerAttempted
          ? input.planningReceipt?.mode === 'targeted_revision'
            ? 'planning.revision.failed'
            : 'planning.initial.failed'
          : 'planning.unavailable',
      }].slice(0, MAX_TOOLS),
    },
    ...(input.planningReceipt ? {
      planningReceipt: input.planningReceipt,
      planningMode: input.planningReceipt.mode,
      plannerRevisionCount: input.planningReceipt.revisionCalls,
    } : {}),
  });
  const providerFailure = input.providerAttempted && (input.providerError || input.providerUnavailable)
    ? providerFailureDecision(input.providerError ?? new Error('provider returned no structured analytical plan'), 'planning')
    : undefined;
  return {
    action: 'block',
    confidence: 1,
    followsUp: false,
    source: 'heuristic',
    reason: input.reason,
    // A provider transport/configuration failure is not an analytical absence.
    // Preserve the typed provider classifier on the decision for the engine
    // receipt and keep the legacy terminal envelope policy-safe.
    terminalOutcome: providerFailure?.terminalOutcome ?? {
      kind: input.securityViolation ? 'policy_blocked' : 'modeling_gap',
      code: input.securityViolation ? 'ANALYTICAL_POLICY_BLOCKED' : 'ANALYTICAL_MODELING_GAP',
      message: input.reason,
      candidateIds: [],
    },
    ...(providerFailure?.providerFailure ? { providerFailure: providerFailure.providerFailure } : {}),
    askAnalystDecision: { version: 1, mode: input.mode, state },
  };
}

function plannerProposalReferencesOutsideCandidates(
  proposal: AnalyticalPlannerProposalV1,
  candidates: AgentEvidenceCandidate[],
): boolean {
  const allowed = new Set(candidates.flatMap((candidate) => [candidate.id, stableCandidateId(candidate)]));
  const references = [
    ...(Array.isArray(proposal.selectedConceptIds) ? proposal.selectedConceptIds : []),
    ...(Array.isArray(proposal.tasks) ? proposal.tasks : []).flatMap((task) => [
      ...(Array.isArray(task.selectedConceptIds) ? task.selectedConceptIds : []),
      ...Object.values(task.roleBindings ?? {}).flatMap((ids) => Array.isArray(ids) ? ids : []),
    ]),
  ].filter((id): id is string => typeof id === 'string');
  return references.some((id) => !allowed.has(id));
}

function providerFailureDecision(
  error: unknown,
  phase: 'preflight' | 'planning' | 'meaning_resolution' = 'planning',
): {
  terminalOutcome: NonNullable<IntentDecision['terminalOutcome']>;
  providerFailure: ReturnType<typeof classifyProviderFailure>;
} {
  const message = error instanceof Error ? error.message : String(error ?? 'provider failure');
  const code = error && typeof error === 'object' ? String((error as { code?: unknown }).code ?? '') : undefined;
  // The CLI host may have already performed a provider/model readiness check
  // before the planner transport. That redacted diagnostic is authoritative:
  // reclassifying its friendly wrapper as an arbitrary planning failure loses
  // authentication/model/network/gateway/timeout cause and makes a preflight
  // incident look like a SQL or generic provider problem.
  const supplied = error && typeof error === 'object'
    ? (error as { providerDiagnostic?: unknown }).providerDiagnostic
    : undefined;
  const diagnostic = supplied
    && typeof supplied === 'object'
    && (supplied as { version?: unknown }).version === 1
    && typeof (supplied as { cause?: unknown }).cause === 'string'
    && typeof (supplied as { phase?: unknown }).phase === 'string'
    ? supplied as ReturnType<typeof classifyProviderFailure>
    : classifyProviderFailure({
        message,
        code,
        phase: error && typeof error === 'object'
          && (error as { providerPhase?: unknown }).providerPhase === 'preflight'
          ? 'preflight'
          : phase,
      });
  return {
    terminalOutcome: {
      kind: 'policy_blocked',
      code: 'ANALYTICAL_POLICY_BLOCKED',
      message: 'The configured AI provider could not complete the bounded analytical planning step. No query was executed.',
      candidateIds: [],
    },
    providerFailure: diagnostic,
  };
}

/**
 * Canonical identifier references are a zero-call path. This intentionally
 * binds the complete compatible SET (not the first lexical hit), so asking
 * for two MetricFlow metrics never degrades into an LLM clarification.
 */
function canonicalIdentifierSet(question: string, candidates: AgentEvidenceCandidate[]): AgentEvidenceCandidate[] {
  const selected = candidates.filter((candidate) => {
    if (candidate.kind !== 'semantic_metric' || candidate.eligible === false || candidate.compatibility === 'incompatible') return false;
    return canonicalCandidateIdentities(candidate).some((identity) => questionMentionsCanonicalIdentifier(question, identity));
  });
  if (selected.length === 0) return [];
  const models = new Set(selected.map((candidate) => candidate.semanticModel).filter((value): value is string => Boolean(value)));
  // MetricFlow compatibility is evaluated again by the compiler. At this
  // stage reject only a demonstrably conflicting pair of declared models;
  // unknown model provenance is not a reason to erase an explicit ID.
  if (models.size > 1) return [];
  return selected.sort((left, right) => stableCandidateId(left).localeCompare(stableCandidateId(right)));
}

function canonicalCandidateIdentities(candidate: AgentEvidenceCandidate): string[] {
  return [candidate.id, candidate.qualifiedId, candidate.name, ...(candidate.aliases ?? [])]
    .filter((value): value is string => Boolean(value))
    .filter((value) => /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(value));
}

function questionMentionsCanonicalIdentifier(question: string, identity: string): boolean {
  // Do not make ordinary business aliases a zero-call path. Canonical IDs have
  // a namespace/separator or are explicitly marked with @metric(...).
  if (!/[_.:-]/.test(identity) && !new RegExp(`@metric\\(${escapeRegExp(identity)}\\)`, 'i').test(question)) return false;
  return new RegExp(`(^|[^A-Za-z0-9_.:-])${escapeRegExp(identity)}(?=$|[^A-Za-z0-9_.:-])`, 'i').test(question)
    || new RegExp(`@metric\\(${escapeRegExp(identity)}\\)`, 'i').test(question);
}

function canonicalSetResolution(
  request: AgentRunRequest,
  seed: ReturnType<typeof buildAnalyticalRequirementSeedV1>,
  candidates: AgentEvidenceCandidate[],
): MeaningResolution {
  const primary = candidates.find((candidate) => candidate.kind === 'semantic_metric') ?? candidates[0]!;
  return {
    interpretedQuestion: seed.sourceQuestion,
    questionType: questionTypeFromText(seed.sourceQuestion),
    selectedConceptIds: candidates.map((candidate) => candidate.id),
    recommendedExecutionId: primary.id,
    queryIntent: { ...seed.queryIntent, filters: seed.queryIntent.filters.map((filter) => ({ ...filter })) },
    rejectedCandidates: [],
    confidence: 'high',
    missingInformation: [],
    recommendedRoute: primary.kind === 'semantic_metric' ? 'semantic' : 'clarify',
    hostRequirementSeed: seed,
  };
}

interface DeterministicProgramBindingV1 {
  candidates: AgentEvidenceCandidate[];
  resolution: MeaningResolution;
  reasonCode:
    | 'deterministic_certified_binding'
    | 'deterministic_semantic_binding'
    | 'deterministic_structured_continuation_binding'
    | 'deterministic_structured_physical_continuation_binding'
    | 'deterministic_single_relation_physical_binding';
  /** Complete means the immutable snapshot already proves every requested role. */
  complete?: boolean;
}

type ServerIssuedContinuationV1 = {
  optionIds: string[];
  snapshotId: string;
  continuityFingerprint?: string;
};

/**
 * Rehydrate only a server-issued clarification click. The client-provided
 * stable ID is reject-only until the local conversation snapshot proves the
 * active thread, source turn, snapshot, and original offered option. This
 * remains a deterministic identity handoff, not a new retrieval or meaning
 * interpretation path.
 */
function serverIssuedContinuation(request: AgentRunRequest): ServerIssuedContinuationV1 | undefined {
  if (!request.selectedEvidenceId?.trim()) return undefined;
  const context = request.conversationContext;
  const envelope = context?.conversationEnvelope && typeof context.conversationEnvelope === 'object'
    ? context.conversationEnvelope as Record<string, unknown>
    : context?.serverSnapshot && typeof context.serverSnapshot === 'object'
      ? context.serverSnapshot as Record<string, unknown>
      : undefined;
  const pending = envelope?.pendingClarification && typeof envelope.pendingClarification === 'object'
    ? envelope.pendingClarification as Record<string, unknown>
    : undefined;
  const selection = pending?.selection && typeof pending.selection === 'object'
    ? pending.selection as Record<string, unknown>
    : undefined;
  const authority = context?.serverIssuedClarificationSelection
    && typeof context.serverIssuedClarificationSelection === 'object'
    ? context.serverIssuedClarificationSelection as Record<string, unknown>
    : undefined;
  const optionIds = [
    ...(Array.isArray(selection?.optionIds) ? selection.optionIds : []),
    ...(Array.isArray(selection?.ambiguityCandidateIds) ? selection.ambiguityCandidateIds : []),
  ].filter((id): id is string => typeof id === 'string' && Boolean(id.trim()));
  const snapshotId = typeof selection?.snapshotId === 'string' ? selection.snapshotId.trim() : '';
  const continuityFingerprint = typeof selection?.continuityFingerprint === 'string'
    ? selection.continuityFingerprint.trim()
    : '';
  const threadId = typeof envelope?.threadId === 'string' ? envelope.threadId : '';
  const sourceTurnId = typeof pending?.sourceTurnId === 'string' ? pending.sourceTurnId : '';
  const serverIssued = authority?.version === 1
    && authority.threadId === threadId
    && authority.sourceTurnId === sourceTurnId
    && authority.snapshotId === snapshotId
    && (continuityFingerprint === '' || authority.continuityFingerprint === continuityFingerprint)
    && request.threadId === threadId;
  if (!serverIssued || !snapshotId || !optionIds.includes(request.selectedEvidenceId)) return undefined;
  return {
    optionIds: [...new Set(optionIds)],
    snapshotId,
    ...(continuityFingerprint ? { continuityFingerprint } : {}),
  };
}

function candidateMatchesStableIdentity(candidate: AgentEvidenceCandidate, identity: string): boolean {
  return [candidate.id, candidate.qualifiedId, ...(candidate.aliases ?? [])]
    .filter((value): value is string => Boolean(value))
    .some((value) => value === identity);
}

function normalizePlannerCandidateIdentity(
  identity: string,
  candidates: readonly AgentEvidenceCandidate[],
): string {
  const direct = candidates.filter((candidate) => candidateMatchesStableIdentity(candidate, identity));
  if (direct.length === 1) return stableCandidateId(direct[0]!);
  if (direct.length > 1) return identity;
  // A legacy local semantic index may represent *the same full qualified
  // dimension* with either `semantic:dimension:` or
  // `semantic:uncategorized:dimension:`. This is a narrow, explicit
  // same-snapshot protocol equivalence. Do not fall back to a terminal field
  // name: `semantic:dimension:other.location_name` is not evidence that the
  // admitted `locations.location_name` card was selected.
  const equivalent = candidates.filter((candidate) =>
    candidate.kind === 'semantic_member'
    && candidate.semanticObjectType === 'dimension'
    && candidate.eligible !== false
    && candidate.compatibility !== 'incompatible'
    && [candidate.id, candidate.qualifiedId]
      .filter((candidateIdentity): candidateIdentity is string => Boolean(candidateIdentity))
      .some((candidateIdentity) => sameMetricflowDimensionIdentity(candidateIdentity, identity)));
  return equivalent.length === 1 ? stableCandidateId(equivalent[0]!) : identity;
}

function normalizePlannerProposalCandidateIdentities(
  proposal: AnalyticalPlannerProposalV1,
  candidates: readonly AgentEvidenceCandidate[],
): AnalyticalPlannerProposalV1 {
  const normalizeIds = (ids: readonly string[] | undefined): string[] =>
    uniqueStableIds((ids ?? []).map((identity) => normalizePlannerCandidateIdentity(identity, candidates)));
  return {
    ...proposal,
    selectedConceptIds: normalizeIds(proposal.selectedConceptIds),
    tasks: proposal.tasks.map((task) => ({
      ...task,
      selectedConceptIds: normalizeIds(task.selectedConceptIds),
      roleBindings: Object.fromEntries(Object.entries(task.roleBindings ?? {})
        .map(([role, ids]) => [role, normalizeIds(ids)])) as Partial<Record<EvidenceCandidateRoleV1, string[]>>,
    })),
    ...(proposal.recovery ? {
      recovery: {
        ...proposal.recovery,
        ...(proposal.recovery.relatedCandidateIds ? { relatedCandidateIds: normalizeIds(proposal.recovery.relatedCandidateIds) } : {}),
        ...(proposal.recovery.candidateIds ? { candidateIds: normalizeIds(proposal.recovery.candidateIds) } : {}),
        ...(proposal.recovery.relationshipPathIds ? { relationshipPathIds: normalizeIds(proposal.recovery.relationshipPathIds) } : {}),
      },
    } : {}),
  };
}

function deterministicStructuredContinuationBinding(input: {
  request: AgentRunRequest;
  evidence: AgentRetrievalEvidence;
  requirements: AnalyticalRequirementSetV1;
  requirementSeed: ReturnType<typeof buildAnalyticalRequirementSeedV1>;
  /** The host-owned, same-snapshot closure reserved before clarification. */
  relationshipClosure: readonly AgentEvidenceCandidate[];
}): DeterministicProgramBindingV1 | undefined {
  const continuation = serverIssuedContinuation(input.request);
  const selectedId = input.request.selectedEvidenceId?.trim();
  if (!continuation || !selectedId) return undefined;
  // A local process restart may recreate an equivalent SQLite snapshot file
  // with a new handle ID. Preserve the server-issued choice only when its
  // content-addressed candidate/capability proof is unchanged; otherwise keep
  // the existing strict snapshot boundary. The selected identity still has to
  // be present in the CURRENT evidence below, so this never replays a stale
  // or client-invented option into a changed catalog.
  const sameSnapshot = continuation.snapshotId === input.evidence.snapshotId;
  const sameContinuity = Boolean(
    continuation.continuityFingerprint
    && input.evidence.continuityFingerprint
    && continuation.continuityFingerprint === input.evidence.continuityFingerprint,
  );
  if (!sameSnapshot && !sameContinuity) return undefined;
  // A server-issued ordinary-field option is a stable qualified physical
  // identity, not a new language interpretation.  It cannot be replayed by
  // alias: the current snapshot must still expose the exact column identity
  // that the server offered.  The helper below resolves only the remaining
  // retrieved fields and already-proven relationship closure; it never mints
  // a relation, column, or join from the selected label.
  const selectedPhysicalColumn = input.evidence.candidates.find((candidate) =>
    candidate.kind === 'sql_column'
    && Boolean(candidate.qualifiedId?.trim())
    && stableCandidateId(candidate) === selectedId);
  if (selectedPhysicalColumn) {
    return deterministicStructuredPhysicalContinuationBinding({
      ...input,
      selected: selectedPhysicalColumn,
    });
  }
  // A dimension click may not choose a metric. Bind it only when the original
  // request names exactly one metric with one complete authored capability.
  if (input.requirements.measures.length !== 1) return undefined;
  const metricMatches = input.evidence.candidates.filter((candidate) =>
    candidate.kind === 'semantic_metric'
    && candidate.eligible !== false
    && candidate.compatibility !== 'incompatible'
    && candidate.analyticalCapability
    && exactSemanticMetricTermMatch(input.requirements.measures[0]!, candidate));
  if (metricMatches.length !== 1) return undefined;
  const metric = metricMatches[0]!;
  // The server-visible option can retain a display namespace while the
  // capability stores its canonical child ID. First resolve the exact
  // retrieved option identity, then ask the shared capability resolver to
  // prove that it belongs to this metric. This is the same identity-only
  // bridge the legacy compiler adapter uses; it is not a leaf-name lookup.
  const retrieved = input.evidence.candidates.find((candidate) =>
    candidate.kind === 'semantic_member' && candidateMatchesStableIdentity(candidate, selectedId));
  const capabilityIdentities = [
    selectedId,
    retrieved?.qualifiedId,
    ...(retrieved?.aliases ?? []),
  ].filter((identity): identity is string => Boolean(identity));
  const capabilityDimension = capabilityIdentities
    .map((identity) => resolveMetricCapabilityDimension(metric, identity))
    .find((dimension) => Boolean(dimension));
  if (!capabilityDimension) return undefined;
  if (input.requirements.ranking && !capabilityDimension.supportedRoles.includes('rank_entity')) return undefined;
  if (!input.requirements.ranking
    && !capabilityDimension.supportedRoles.includes('group_by')
    && !capabilityDimension.supportedRoles.includes('filter')) return undefined;
  // A capability child can be represented by a normalized retrieval card or
  // may exist only as the server-issued authored child. Both are safe only
  // after the exact option/snapshot/capability proof above.
  // A structured clarification can choose the sole MetricFlow-native
  // geographic grouping that was presented for an unresolved business word
  // such as `region`. Preserve that authored substitution on the stable
  // selection rather than reparsing the word on the next turn. The resolved
  // plan will then carry its existing visible review-required boundary.
  const inferredRoleExtension = soleGeographicMetricflowExtension(
    metric,
    capabilityDimension,
    categoricalTermsForRuntime(input.requirements).map(normalizeStableTerm).filter(Boolean),
  );
  const selected: AgentEvidenceCandidate = retrieved
    ? {
        ...retrieved,
        id: selectedId,
        qualifiedId: capabilityDimension.dimensionId,
        ...(!retrieved.sameSnapshotRoleExtension && inferredRoleExtension
          ? { sameSnapshotRoleExtension: inferredRoleExtension }
          : {}),
      }
    : {
        id: selectedId,
        qualifiedId: capabilityDimension.dimensionId,
        kind: 'semantic_member',
        semanticObjectType: 'dimension',
        trustTier: 'semantic',
        name: capabilityDimension.label ?? capabilityDimension.dimensionId.split(/[.:/]/).at(-1) ?? selectedId,
        ...(capabilityDimension.aliases?.length ? { aliases: capabilityDimension.aliases } : {}),
        ...(metric.semanticModel ? { semanticModel: metric.semanticModel } : {}),
        relevanceScore: metric.relevanceScore,
        compatibility: 'compatible',
        eligible: true,
        matchReasons: ['server-issued snapshot capability binding'],
        ...(inferredRoleExtension ? { sameSnapshotRoleExtension: inferredRoleExtension } : {}),
      };
  return {
    candidates: [metric, selected],
    resolution: deterministicResolution({
      request: input.request,
      seed: input.requirementSeed,
      candidates: [metric, selected],
      recommendedExecutionId: metric.id,
      recommendedRoute: 'semantic',
    }),
    reasonCode: 'deterministic_structured_continuation_binding',
  };
}

/**
 * Consume a server-issued ordinary physical-field choice without treating the
 * chosen business label as a raw-SQL authority. The initial clarification
 * already proved that this exact qualified column was one of the safe,
 * reachable alternatives for one unresolved categorical term. On reload we
 * prove it again against the current snapshot, resolve every other required
 * physical field by exact qualified metadata, and require the previously
 * reserved relationship closure to connect the selected relations.
 *
 * This is deliberately narrower than the ordinary single-relation physical
 * fast path: it exists only for an authenticated clarification continuation,
 * never guesses a raw relation/column, and always remains review-required via
 * the unresolved-role admission receipt applied below.
 */
function deterministicStructuredPhysicalContinuationBinding(input: {
  request: AgentRunRequest;
  evidence: AgentRetrievalEvidence;
  requirements: AnalyticalRequirementSetV1;
  requirementSeed: ReturnType<typeof buildAnalyticalRequirementSeedV1>;
  relationshipClosure: readonly AgentEvidenceCandidate[];
  selected: AgentEvidenceCandidate;
}): DeterministicProgramBindingV1 | undefined {
  const selectedId = input.request.selectedEvidenceId?.trim();
  if (!selectedId
    || input.selected.kind !== 'sql_column'
    || input.selected.eligible === false
    || input.selected.compatibility === 'incompatible'
    // The server issued a qualified column ID. Aliases are useful for
    // retrieval, but must never replay a client-provided leaf/alias after a
    // restart into a physical execution program.
    || stableCandidateId(input.selected) !== selectedId
    || !input.selected.qualifiedId?.trim()
    || !evidenceCandidateRoles(input.selected).includes('categorical_dimension')) return undefined;

  const unresolvedTerms = categoricalTermsForRuntime(input.requirements)
    .filter((term) => !candidateMatchesPlannerRequirementTerm(input.selected, term)
      && !candidateMatchesCategoricalDimensionRequirement(input.selected, [term]));
  // One selected option can resolve one explicit ordinary fallback only. A
  // multi-dimensional request must retain its normal planner/clarification
  // path rather than allowing the click to hide a second unknown mapping.
  if (unresolvedTerms.length !== 1) return undefined;

  const relations = input.evidence.candidates.filter((candidate) =>
    (candidate.kind === 'dbt_model' || candidate.kind === 'dbt_source' || candidate.kind === 'sql_table')
    && candidate.eligible !== false
    && candidate.compatibility !== 'incompatible');
  const columns = input.evidence.candidates.filter((candidate) =>
    candidate.kind === 'sql_column'
    && candidate.eligible !== false
    && candidate.compatibility !== 'incompatible');
  if (relations.length === 0 || columns.length === 0) return undefined;

  type PhysicalRequirement = {
    term: string;
    role: 'measure' | 'display' | 'filter' | 'time';
  };
  const requirements: PhysicalRequirement[] = [
    ...input.requirements.measures.map((term) => ({ term, role: 'measure' as const })),
    ...input.requirements.dimensions
      .filter((term) => normalizePlannerAdmissionText(term) !== normalizePlannerAdmissionText(unresolvedTerms[0]!))
      .map((term) => ({ term, role: 'display' as const })),
    ...input.requirements.entityTerms.map((term) => ({ term, role: 'display' as const })),
    ...input.requirements.entityDisplayTerms.map((term) => ({ term, role: 'display' as const })),
    ...(input.requirements.outputTerms ?? []).map((term) => ({ term, role: 'display' as const })),
    ...input.requirementSeed.queryIntent.filters.map((filter) => ({ term: filter.field, role: 'filter' as const })),
    ...(input.requirements.time?.grain ? [{ term: input.requirements.time.grain, role: 'time' as const }] : []),
  ].filter((requirement, index, all) => Boolean(requirement.term.trim())
    && all.findIndex((other) => other.term === requirement.term && other.role === requirement.role) === index);

  const selectedColumns = [input.selected];
  for (const requirement of requirements) {
    const column = uniqueBestPhysicalColumn(requirement.term, requirement.role, columns);
    if (!column) return undefined;
    if (!selectedColumns.some((candidate) => stableCandidateId(candidate) === stableCandidateId(column))) {
      selectedColumns.push(column);
    }
  }

  const relationGroups = new Map<string, AgentEvidenceCandidate[]>();
  for (const relation of relations) {
    const key = physicalRelationKey(relation);
    if (!key) continue;
    const group = relationGroups.get(key) ?? [];
    group.push(relation);
    relationGroups.set(key, group);
  }
  const selectedRelations: AgentEvidenceCandidate[] = [];
  for (const column of selectedColumns) {
    const matchingGroups = [...relationGroups.values()]
      .filter((group) => physicalColumnBelongsToRelation(column, group));
    // If a physical column has two distinct relation homes in this snapshot,
    // choosing one would be a raw relation guess. Return to the existing
    // bounded planner/clarification path instead.
    if (matchingGroups.length !== 1) return undefined;
    const relation = canonicalPhysicalRelation(matchingGroups[0]!);
    if (!relation) return undefined;
    if (!selectedRelations.some((candidate) => physicalRelationKey(candidate) === physicalRelationKey(relation))) {
      selectedRelations.push(relation);
    }
  }
  if (!relationshipClosureConnectsPhysicalRelations(selectedRelations, input.relationshipClosure)) return undefined;

  const candidates = uniqueCandidates([
    ...selectedRelations,
    ...selectedColumns,
  ]);
  return {
    candidates,
    resolution: deterministicResolution({
      request: input.request,
      seed: input.requirementSeed,
      candidates,
      recommendedExecutionId: input.selected.id,
      recommendedRoute: 'exploratory',
    }),
    reasonCode: 'deterministic_structured_physical_continuation_binding',
  };
}

/** Choose one already-qualified representation of the same physical relation. */
function canonicalPhysicalRelation(candidates: readonly AgentEvidenceCandidate[]): AgentEvidenceCandidate | undefined {
  return [...candidates]
    .sort((left, right) => Number(Boolean(right.exactMatch)) - Number(Boolean(left.exactMatch))
      || physicalRelationKindRank(left) - physicalRelationKindRank(right)
      || stableCandidateId(left).localeCompare(stableCandidateId(right)))[0];
}

function physicalRelationKindRank(candidate: AgentEvidenceCandidate): number {
  return candidate.kind === 'dbt_model' ? 0
    : candidate.kind === 'dbt_source' ? 1
      : 2;
}

/**
 * A multi-relation physical continuation is legal only when the same closure
 * already proves a connected path between every selected relation. This reads
 * the canonical safety proof, rather than friendly relationship names or
 * arbitrary evidence IDs, so a selected column cannot smuggle in a join.
 */
function relationshipClosureConnectsPhysicalRelations(
  relations: readonly AgentEvidenceCandidate[],
  closure: readonly AgentEvidenceCandidate[],
): boolean {
  if (relations.length <= 1) return true;
  if (closure.length === 0) return false;
  const graph = new Map<string, Set<string>>();
  const connect = (left: string, right: string): void => {
    if (!left || !right) return;
    const leftEdges = graph.get(left) ?? new Set<string>();
    leftEdges.add(right);
    graph.set(left, leftEdges);
    const rightEdges = graph.get(right) ?? new Set<string>();
    rightEdges.add(left);
    graph.set(right, rightEdges);
  };
  for (const candidate of closure) {
    const selection = relationshipCandidateProofSelection(candidate);
    if (!selection?.relationshipSafety?.length) return false;
    for (const safety of selection.relationshipSafety) {
      const from = normalizePhysicalBindingText(safety.from ?? '');
      const to = normalizePhysicalBindingText(safety.to ?? '');
      if (!from || !to) return false;
      connect(from, to);
    }
  }
  const relationReferences = relations.map((relation) => physicalRelationReferences(relation));
  if (relationReferences.some((references) => references.length === 0)) return false;
  const start = relationReferences[0]!.find((reference) => graph.has(reference));
  if (!start) return false;
  const reachable = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of graph.get(current) ?? []) {
      if (reachable.has(next)) continue;
      reachable.add(next);
      queue.push(next);
    }
  }
  return relationReferences.every((references) => references.some((reference) => reachable.has(reference)));
}

/**
 * Bind only a business program that can be proven without an interpretation
 * call.  This is intentionally smaller than retrieval ranking: a provider is
 * still needed whenever two business meanings compete, a join is required, or
 * one requested output does not have an unambiguous qualified field.
 *
 * The direct physical route is safe because it is limited to one relation. It
 * creates no inferred join; the existing exploratory compiler still owns
 * read-only SQL validation, authorization, result assertions, and the
 * review-required trust state.
 */
function deterministicUniqueProgramBinding(input: {
  request: AgentRunRequest;
  evidence: AgentRetrievalEvidence;
  requirements: AnalyticalRequirementSetV1;
  requirementSeed: ReturnType<typeof buildAnalyticalRequirementSeedV1>;
  allowDeterministicNaturalLanguageBinding?: boolean;
}): DeterministicProgramBindingV1 | undefined {
  const eligible = input.evidence.candidates.filter((candidate) =>
    candidate.eligible !== false && candidate.compatibility !== 'incompatible');

  // A catalog-proven exact certified contract is already an immutable business
  // program. Do not broaden this to a merely relevant block: the compiler will
  // independently validate all declared outputs before it can freeze.
  const exactCertified = eligible.filter((candidate) =>
    candidate.kind === 'certified_block'
    && candidate.exactMatch === true
    && candidate.analyticalFitClass === 'exact'
    // `exactMatch` is retrieval/catalog evidence, not by itself a complete
    // tuple.  In particular, a `top_customers` block that happens to be
    // ranked for the word "revenue" may not answer a bare `show me revenue`.
    // Require the block's own declared measure and requested output roles
    // before this provider-free fast path can nominate a certified compiler.
    && certifiedCandidateProvesRequestedTuple(candidate, input.requirements));
  if (exactCertified.length === 1) {
    const selected = exactCertified[0]!;
    return {
      candidates: [selected],
      resolution: deterministicResolution({
        request: input.request,
        seed: input.requirementSeed,
        candidates: [selected],
        recommendedRoute: 'certified',
      }),
      reasonCode: 'deterministic_certified_binding',
    };
  }

  // A complete exact semantic program is a fast path in every host: it has
  // already bound the explicit metric, every requested display/breakdown role,
  // and the MetricFlow capability identities from one immutable snapshot.
  // Offline hosts may additionally retain the historical single-metric
  // deterministic path, but provider availability may never block the former.
  const semantic = deterministicSemanticProgramBinding({
    request: input.request,
    candidates: eligible,
    requirements: input.requirements,
    requirementSeed: input.requirementSeed,
  });
  // A generic display-key ambiguity is also a deterministic outcome. Retain
  // its tiny selected semantic tuple long enough for the caller to emit
  // server-issued choices; it is never allowed to execute through this path.
  if (semantic && (
    semantic.complete
    || input.allowDeterministicNaturalLanguageBinding
    || Boolean(deterministicDisplayKeyAmbiguity({ question: input.request.question, binding: semantic }))
  )) return semantic;

  return deterministicSingleRelationPhysicalBinding({
    request: input.request,
    candidates: eligible,
    requirements: input.requirements,
    requirementSeed: input.requirementSeed,
  });
}

/**
 * A certified card is allowed to skip the planner only when its own declared
 * output contract proves the current tuple.  This is intentionally stricter
 * than an `exactMatch` retrieval signal: catalog relevance can be exact for a
 * saved "top customers" answer while the requested scalar metric, grouping,
 * or entity display is not declared by that block.
 */
function certifiedCandidateProvesRequestedTuple(
  candidate: AgentEvidenceCandidate,
  requirements: AnalyticalRequirementSetV1,
): boolean {
  if (!certifiedCandidateExplicitlyCoversMeasures(candidate, requirements.measures)) return false;
  const requestedOutputs = [...new Set([
    ...requirements.dimensions,
    ...requirements.entityTerms,
    ...requirements.entityDisplayTerms,
    ...(requirements.outputTerms ?? []),
  ].map(normalizeStableTerm).filter(Boolean))];
  const requestedDeclaredOutputs = requestedOutputs
    .map((requested) => certifiedCandidateDeclaredDimensionOutput(candidate, requested))
    .filter((output): output is string => Boolean(output))
    .map(normalizeStableTerm);
  if (requestedDeclaredOutputs.length !== requestedOutputs.length) return false;

  // A saved answer's grain is part of its certified contract. A merely
  // relevant `top_customers` block cannot answer the scalar request `show me
  // revenue`: its unrequested customer grouping changes the result. This is
  // intentionally a fast-path guard; a later compiler still validates the
  // final frozen tuple before execution.
  // Candidate dimensions include filterable inputs and descriptive profile
  // attributes as well as result-grain fields.  Only a declared output that
  // the block's authored grain proves is grouping-driving may reject this
  // exact path.  A customer profile can include customer_type beside the
  // customer key without becoming a customer-by-type answer; a scalar revenue
  // request remains rejected because customer_name is the grain key.
  const declaredDimensions = certifiedCandidateGrainDimensionOutputs(candidate)
    .map(normalizeStableTerm)
    .filter(Boolean);
  if (declaredDimensions.length > 0
    && !declaredDimensions.every((dimension) => requestedDeclaredOutputs.includes(dimension))) return false;
  return true;
}

function deterministicSemanticProgramBinding(input: {
  request: AgentRunRequest;
  candidates: AgentEvidenceCandidate[];
  requirements: AnalyticalRequirementSetV1;
  requirementSeed: ReturnType<typeof buildAnalyticalRequirementSeedV1>;
}): DeterministicProgramBindingV1 | undefined {
  // A multi-measure request is not a shortcut: compatibility/additivity belong
  // to the semantic compiler and a provider-backed interpretation remains the
  // normal route. This only binds a single, explicitly named business metric.
  if (input.requirements.measures.length !== 1) return undefined;
  const requestedMeasure = input.requirements.measures[0]!;
  const scoredMatches = input.candidates
    .filter((candidate) => candidate.kind === 'semantic_metric'
      && candidate.eligible !== false
      && candidate.compatibility !== 'incompatible')
    .map((candidate) => {
      const directScore = semanticMetricTermMatchScore(requestedMeasure, candidate);
      // An authored semantic measure and its public metric intentionally have
      // different identities in MetricFlow. For example, the user-facing
      // `order count` measure is executed through the unfiltered `Orders`
      // metric. Preserve that narrow exact bridge only when both snapshot
      // identities and the generic metric description prove it. This is not a
      // broad `count` synonym: scoped `Drink Orders` / `Food Orders` metrics
      // cannot qualify because their metric identity is not exactly `orders`.
      const measureBackedScore = directScore > 0
        ? 0
        : nativeSemanticMeasureBackedMetricScore({
            requestedMeasure,
            metric: candidate,
            candidates: input.candidates,
          });
      return { candidate, score: Math.max(directScore, measureBackedScore) };
    })
    .filter((match) => match.score > 0);
  const highestScore = Math.max(0, ...scoredMatches.map((match) => match.score));
  // `product_revenue` may contain the word revenue, but it must not compete
  // with an explicitly named canonical `revenue` metric.  Keep only the
  // strongest same-snapshot business identity; a tie remains a real planner
  // question rather than an unsafe provider-free nomination.
  const matches = scoredMatches
    .filter((match) => match.score === highestScore)
    .map((match) => match.candidate);
  if (matches.length !== 1) return undefined;
  const metric = matches[0]!;
  // The one meaning card is the exact metric, but an immutable frame may need
  // two equally authored display candidates to express a real ambiguity. Keep
  // that tiny same-snapshot role extension with the deterministic binding so
  // frame validation can present the server-issued choices instead of calling
  // a provider merely because relevance pruning kept only one of them.
  const roleExtensions = deterministicSemanticRoleExtensions(metric, input.candidates, input.requirements);
  const complete = semanticExtensionsProveRequestedRoles(metric, roleExtensions, input.requirements);
  return {
    candidates: [metric, ...roleExtensions],
    resolution: deterministicResolution({
      request: input.request,
      seed: input.requirementSeed,
      candidates: [metric, ...roleExtensions],
      recommendedExecutionId: metric.id,
      recommendedRoute: 'semantic',
    }),
    reasonCode: 'deterministic_semantic_binding',
    complete,
  };
}

/**
 * A generic "name(s)" request has no user-owned business entity.  If the
 * deterministic semantic fast path found two or more *selected*, capability-
 * proven display labels, that is a genuine ambiguity rather than a cue to
 * group by every label.  The caller persists these stable IDs as a structured
 * clarification; only `deterministicStructuredContinuationBinding` can later
 * consume one of them.
 */
function deterministicDisplayKeyAmbiguity(input: {
  question: string;
  binding: DeterministicProgramBindingV1 | undefined;
}): {
  question: string;
  options: NonNullable<IntentDecision['clarificationOptions']>;
} | undefined {
  const binding = input.binding;
  if (!binding || binding.reasonCode !== 'deterministic_semantic_binding') return undefined;
  // A person who says "customer names", "account names", or "product names"
  // has supplied an explicit entity constraint. Keep it authoritative; the
  // capability compiler can still reject an invalid tuple later.
  const normalizedQuestion = normalizeStableTerm(input.question);
  if (!/(?:^| )names?(?: |$)/.test(normalizedQuestion)
    || /(?:^| )(?:account|customer|client|product|owner|contact)(?: |$)/.test(normalizedQuestion)) return undefined;
  const metric = binding.candidates.find((candidate) =>
    candidate.kind === 'semantic_metric' && candidate.analyticalCapability);
  if (!metric) return undefined;
  const selectedOptions = binding.candidates
    .filter((candidate) => candidate.kind === 'semantic_member'
      && evidenceCandidateRoles(candidate).includes('entity_label'))
    .flatMap((candidate) => {
      const dimension = [candidate.id, candidate.qualifiedId, ...(candidate.aliases ?? [])]
        .filter((identity): identity is string => Boolean(identity))
        .map((identity) => resolveMetricCapabilityDimension(metric, identity))
        .find((resolved) => Boolean(resolved));
      // A generic top-N display choice is meaningful only when the selected
      // metric itself declares it as a rank entity. This avoids asking about
      // an arbitrary descriptive field that could not execute the requested
      // ranking anyway.
      if (!dimension?.supportedRoles.includes('rank_entity')) return [];
      const label = humanizeCandidateLabel(dimension.label ?? candidate.name);
      return [{
        // Persist the selected metric's authored capability ID. A local
        // registry card can carry a shortened display identity
        // (`...:account_name`) while the immutable MetricFlow contract carries
        // the complete stable child (`...:account_revenue.account_name`). The
        // continuation validator proves that child against the same metric and
        // snapshot before it can be used; no client-provided value gains this
        // authority on its own.
        id: dimension.dimensionId,
        label,
        ...(dimension.entityId ? { description: `Use ${label} as the ranking display key.` } : {}),
        kind: 'semantic_dimension',
      }];
    })
    .filter((option, index, options) => options.findIndex((other) => other.id === option.id) === index)
    .sort((left, right) => left.label.localeCompare(right.label))
    .slice(0, 3);
  if (selectedOptions.length < 2) return undefined;
  const labels = new Set(selectedOptions.map((option) => normalizeStableTerm(option.label)));
  if (labels.size < 2) return undefined;
  return {
    question: 'Which business name should I use for the top-revenue ranking?',
    options: selectedOptions,
  };
}

function humanizeCandidateLabel(value: string): string {
  const words = value
    .split(/[._:/-]+/)
    .filter(Boolean)
    .flatMap((part) => part.replace(/([a-z])([A-Z])/g, '$1 $2').split(/\s+/))
    .filter(Boolean);
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ') || value;
}

function deterministicSemanticRoleExtensions(
  metric: AgentEvidenceCandidate,
  candidates: AgentEvidenceCandidate[],
  requirements: AnalyticalRequirementSetV1,
): AgentEvidenceCandidate[] {
  const entityTerms = [...requirements.entityTerms, ...requirements.entityDisplayTerms]
    .map(normalizeStableTerm)
    .filter(Boolean);
  const categoricalTerms = categoricalTermsForRuntime(requirements)
    .map(normalizeStableTerm)
    .filter(Boolean);
  if (entityTerms.length === 0 && categoricalTerms.length === 0) return [];
  // "top names" deliberately does not decide whether a business means
  // Account Name or Customer Name. Retain each selected metric's authored
  // rank-display candidate so the caller can issue a one-time clarification;
  // never use this generic form to silently group by every display label.
  const genericRankDisplayRequest = Boolean(requirements.ranking)
    && categoricalTerms.some((term) => term === 'name' || term === 'names');
  const dimensions = metric.analyticalCapability?.dimensions ?? [];
  const capabilityDimensionFor = (candidate: AgentEvidenceCandidate) => dimensions.find((dimension) => {
    const canonicalCandidateIds = [candidate.id, candidate.qualifiedId]
      .filter((identity): identity is string => Boolean(identity));
    if (canonicalCandidateIds.some((identity) =>
      sameMetricflowDimensionIdentity(identity, dimension.dimensionId))) return true;
    // Local indexes may retain the old semantic-qualified registry key while
    // MetricFlow declares the newer full child ID. Preserve that narrow
    // compatibility bridge only for an *exact shared semantic-qualified
    // alias*. A plain business alias such as `location` is never membership:
    // billing.location_name and crm.location_name can both carry it.
    const semanticAliases = (candidate.aliases ?? []).filter((identity) =>
      /^semantic:[A-Za-z0-9_.:-]+$/.test(identity));
    return semanticAliases.some((identity) => (dimension.aliases ?? []).some((dimensionAlias) =>
      /^semantic:[A-Za-z0-9_.:-]+$/.test(dimensionAlias)
      && sameMetricflowDimensionIdentity(identity, dimensionAlias)));
  });
  return candidates
    // Older persisted/local index rows may predate the explicit
    // `semanticObjectType` discriminator. Exact capability membership below
    // remains the authority, so accept that compatibility shape rather than
    // making a known same-snapshot dimension disappear from a legal fast path.
    .filter((candidate) => candidate.kind === 'semantic_member'
      && (candidate.semanticObjectType === undefined || candidate.semanticObjectType === 'dimension'))
    .flatMap((candidate) => {
      const dimension = capabilityDimensionFor(candidate);
      if (!dimension) return [];
      const identities = [
        candidate.name,
        ...(candidate.aliases ?? []),
        candidate.sameSnapshotRoleExtension?.requestedTerm ?? '',
        dimension.label ?? '',
        ...(dimension.aliases ?? []),
      ]
        .map(normalizeStableTerm)
        .filter(Boolean);
      // A capability-qualified display identity commonly contains an entity
      // namespace (`customers.customer_name`).  Exact capability membership
      // above already proves that this card belongs to the selected metric;
      // use normalized phrase containment here so the requested `customer`
      // role does not disappear merely because it is not the final token.
      const matches = (terms: readonly string[]) => terms.some((term) => identities.some((identity) =>
        identity === term || identity.includes(term) || term.includes(identity)));
      const geographicExtension = soleGeographicMetricflowExtension(metric, dimension, categoricalTerms);
      if (genericRankDisplayRequest
        && evidenceCandidateRoles(candidate).includes('entity_label')
        && dimension.supportedRoles.includes('rank_entity')) return [candidate];
      // Ranking applies to the requested entity/display key; a product
      // breakdown remains a group-by capability, not a second rank entity.
      // A numeric/order identifier can share the requested entity namespace
      // (`orders.customer_order_number`) but is not a person-readable
      // customer display. Do not let phrase containment turn it into the
      // answer's entity label. An explicit request for that identifier still
      // flows through the categorical-dimension branch below.
      if (matches(entityTerms) && evidenceCandidateRoles(candidate).includes('entity_label')) {
        return !requirements.ranking || dimension.supportedRoles.includes('rank_entity')
          ? [candidate]
          : [];
      }
      if (matches(categoricalTerms)) return dimension.supportedRoles.includes('group_by') ? [candidate] : [];
      if (geographicExtension) {
        // The extension is derived from the *selected metric's* authored
        // capability and only when it exposes one geographic grouping.  It
        // is not a lexical location->region synonym and cannot authorize a
        // relationship or an arbitrary geographic field.
        // Materialize the capability's exact executable identity on the
        // internally-derived extension. The source card remains the same
        // admitted snapshot card (`id` is deliberately unchanged), but its
        // qualified identity must equal the authored MetricFlow child for the
        // router's same-snapshot extension proof. Without this bridge an
        // older local index's display alias (`semantic:dimension:`) is
        // selected correctly yet discarded as an unresolved raw `region`.
        return [{
          ...candidate,
          qualifiedId: dimension.dimensionId,
          aliases: [...new Set([
            ...(candidate.aliases ?? []),
            ...(candidate.qualifiedId ? [candidate.qualifiedId] : []),
          ])],
          sameSnapshotRoleExtension: geographicExtension,
        }];
      }
      // Do not fall back to broad entity phrase matching here. That was the
      // path that reintroduced `customer_order_number` after the explicit
      // entity-label check above. Only a separately requested categorical
      // dimension may use the generic group/filter capability.
      return [];
    })
    .sort((left, right) => stableCandidateId(left).localeCompare(stableCandidateId(right)))
    .slice(0, 2);
}

/**
 * The local semantic index has historically emitted both the executable
 * `semantic:dimension:` identity and the persisted display
 * `semantic:uncategorized:dimension:` identity. They are a narrow protocol
 * alias only when the remainder of the qualified identifier is identical.
 * Do not reduce this to a leaf-name comparison: that would let a same-named
 * dimension from a different model become a MetricFlow capability binding.
 */
function sameMetricflowDimensionIdentity(left: string, right: string): boolean {
  const canonical = (value: string) => value.trim().replace(
    /^semantic:uncategorized:dimension:/,
    'semantic:dimension:',
  );
  return canonical(left) === canonical(right);
}

/**
 * The retriever normally materializes this extension.  A compact local index
 * can already contain the same qualified `location_name` card without the
 * extension marker, however.  Recover the marker only for the sole
 * MetricFlow-native geographic grouping of the exact selected metric.
 */
function soleGeographicMetricflowExtension(
  metric: AgentEvidenceCandidate,
  dimension: NonNullable<AgentEvidenceCandidate['analyticalCapability']>['dimensions'][number],
  categoricalTerms: string[],
): AgentEvidenceCandidate['sameSnapshotRoleExtension'] | undefined {
  const requestedRegion = categoricalTerms.some((term) => term === 'region' || term === 'geography' || term === 'geographic');
  if (!requestedRegion) return undefined;
  const capability = metric.analyticalCapability;
  if (!capability?.executionCapabilities.some((execution) => execution.route === 'semantic')) return undefined;
  const geographic = capability.dimensions.filter((candidate) => candidate.supportedRoles.includes('group_by')
    && /\b(?:region|geograph(?:y|ic)|location|country|state|province|city|territory)\b/i.test([
      candidate.dimensionId,
      candidate.entityId,
      candidate.label ?? '',
      ...(candidate.aliases ?? []),
    ].join(' ')));
  if (geographic.length !== 1 || geographic[0]!.dimensionId !== dimension.dimensionId) return undefined;
  return {
    version: 1,
    role: 'categorical_dimension',
    requestedTerm: 'region',
    metricId: metric.qualifiedId ?? metric.id,
    dimensionId: dimension.dimensionId,
    basis: 'sole_metricflow_grouping_dimension',
  };
}

function semanticExtensionsProveRequestedRoles(
  metric: AgentEvidenceCandidate,
  extensions: AgentEvidenceCandidate[],
  requirements: AnalyticalRequirementSetV1,
): boolean {
  if (!metric.analyticalCapability) return false;
  const extensionIdentity = extensions.map(candidateIdentityTerms);
  const covers = (terms: readonly string[]) => terms.every((term) => {
    const normalized = normalizeStableTerm(term);
    return extensionIdentity.some((identity) => identity.includes(normalized) || normalized.includes(identity));
  });
  const entityTerms = requirements.entityDisplayTerms.length > 0
    ? requirements.entityDisplayTerms
    : requirements.entityTerms;
  return covers(entityTerms) && covers(categoricalTermsForRuntime(requirements));
}

function normalizeStableTerm(value: string): string {
  return value.toLowerCase()
    .replace(/[_./:-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function exactSemanticMetricTermMatch(term: string, candidate: AgentEvidenceCandidate): boolean {
  return semanticMetricTermMatchScore(term, candidate) > 0;
}

function semanticMetricTermMatchScore(term: string, candidate: AgentEvidenceCandidate): number {
  const normalize = (value: string): string[] => value.toLowerCase()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.endsWith('s') && token.length > 3 ? token.slice(0, -1) : token);
  const requested = normalize(term);
  if (requested.length === 0) return 0;
  const identities = [candidate.name, ...(candidate.aliases ?? [])];
  let best = 0;
  for (const identity of identities) {
    const candidateTokens = normalize(identity);
    // An approved alias can be a complete business metric label (for example
    // `Revenue`), so preserve exact phrase equality before looking at an
    // identifier leaf.  Do not treat a semantic-model prefix as a metric
    // match: `account_revenue.bcm_run_rate` must never compete with the
    // explicit metric `revenue` merely because its model happens to contain
    // that word.
    if (candidateTokens.length === requested.length
      && candidateTokens.every((token, index) => token === requested[index])) {
      best = Math.max(best, 2);
      continue;
    }
    const leaf = identity.split(/[.:/]/).filter(Boolean).at(-1) ?? '';
    const leafTokens = normalize(leaf);
    if (leafTokens.length > 0 && requested.every((token) => leafTokens.includes(token))) best = Math.max(best, 1);
  }
  return best;
}

/**
 * MetricFlow stores a simple aggregate in two authored forms: a semantic
 * measure (for example `orders.order_count`) and an executable metric (for
 * example `orders.orders`). A natural-language phrase such as "order count"
 * must not degrade to the generic aggregation "count", because several
 * filtered metrics can share the same backing measure. This bridge is legal
 * only when a current-snapshot measure exactly matches the phrase, the metric
 * capability references that exact measure, and the metric itself is the
 * generic singular/plural subject with an authored generic-count definition.
 */
function nativeSemanticMeasureBackedMetricScore(input: {
  requestedMeasure: string;
  metric: AgentEvidenceCandidate;
  candidates: AgentEvidenceCandidate[];
}): number {
  const subject = explicitCountMeasureSubject(input.requestedMeasure);
  if (!subject || !metricHasGenericCountSubject(input.metric, subject)) return 0;
  const exactMeasures = input.candidates.filter((candidate) =>
    candidate.kind === 'semantic_member'
    && candidate.semanticObjectType === 'measure'
    && semanticMeasureMatchesExplicitCountTerm(candidate, input.requestedMeasure));
  if (exactMeasures.length === 0) return 0;
  const capabilityMeasureIds = input.metric.analyticalCapability?.measureIds ?? [];
  const referencedMeasureIds = new Set(exactMeasures.flatMap(semanticMeasureIdentityVariants));
  return capabilityMeasureIds.some((identity) => referencedMeasureIds.has(canonicalSemanticMeasureIdentity(identity)))
    ? 3
    : 0;
}

function explicitCountMeasureSubject(term: string): string | undefined {
  const tokens = normalizedIdentityTokens(term);
  if (tokens.length !== 2 || tokens[1] !== 'count') return undefined;
  return singularIdentityToken(tokens[0]!);
}

function semanticMeasureMatchesExplicitCountTerm(
  candidate: AgentEvidenceCandidate,
  requestedMeasure: string,
): boolean {
  const requested = normalizedIdentityTokens(requestedMeasure);
  if (requested.length !== 2 || requested[1] !== 'count') return false;
  return semanticMeasureIdentityVariants(candidate).some((identity) => {
    const tokens = normalizedIdentityTokens(identity.split(/[.:/]/).at(-1) ?? identity);
    return tokens.length === requested.length
      && tokens.every((token, index) => singularIdentityToken(token) === singularIdentityToken(requested[index]!));
  });
}

function semanticMeasureIdentityVariants(candidate: AgentEvidenceCandidate): string[] {
  return [candidate.id, candidate.qualifiedId, candidate.name, ...(candidate.aliases ?? [])]
    .filter((identity): identity is string => Boolean(identity))
    .map(canonicalSemanticMeasureIdentity);
}

function canonicalSemanticMeasureIdentity(identity: string): string {
  return identity.trim().toLowerCase()
    .replace(/^semantic:(?:uncategorized:)?measure:/, '')
    .replace(/^semantic:measure:/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function metricHasGenericCountSubject(candidate: AgentEvidenceCandidate, subject: string): boolean {
  const metricIdentityMatches = [candidate.name, candidate.qualifiedId, candidate.id, ...(candidate.aliases ?? [])]
    .filter((identity): identity is string => Boolean(identity))
    .some((identity) => {
      const leaf = identity.split(/[.:/]/).at(-1) ?? identity;
      const tokens = normalizedIdentityTokens(leaf);
      return tokens.length === 1 && singularIdentityToken(tokens[0]!) === subject;
    });
  if (!metricIdentityMatches) return false;
  // A definition is an authored semantic fact. Require the simple generic
  // count wording rather than treating a metric that merely happens to end in
  // `orders` as unfiltered. This keeps the fast path closed if an index loses
  // the distinction between a generic metric and a scoped counterpart.
  const definition = normalizeStableTerm(candidate.definition ?? '');
  if (!definition) return false;
  const singular = singularIdentityToken(subject);
  return definition === `count of ${singular}`
    || definition === `count of ${singular}s`;
}

function normalizedIdentityTokens(value: string): string[] {
  return value.toLowerCase()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function singularIdentityToken(value: string): string {
  return value.endsWith('s') && value.length > 3 ? value.slice(0, -1) : value;
}

function deterministicSingleRelationPhysicalBinding(input: {
  request: AgentRunRequest;
  candidates: AgentEvidenceCandidate[];
  requirements: AnalyticalRequirementSetV1;
  requirementSeed: ReturnType<typeof buildAnalyticalRequirementSeedV1>;
}): DeterministicProgramBindingV1 | undefined {
  const relations = input.candidates.filter((candidate) =>
    candidate.kind === 'dbt_model' || candidate.kind === 'dbt_source' || candidate.kind === 'sql_table');
  const columns = input.candidates.filter((candidate) => candidate.kind === 'sql_column');
  if (relations.length === 0 || columns.length === 0) return undefined;

  const termRequirements: Array<{ term: string; role: 'measure' | 'display' | 'filter' | 'time' }> = [
    ...input.requirements.measures.map((term) => ({ term, role: 'measure' as const })),
    ...input.requirements.dimensions.map((term) => ({ term, role: 'display' as const })),
    ...input.requirements.entityTerms.map((term) => ({ term, role: 'display' as const })),
    ...input.requirements.entityDisplayTerms.map((term) => ({ term, role: 'display' as const })),
    ...(input.requirements.outputTerms ?? []).map((term) => ({ term, role: 'display' as const })),
    ...input.requirementSeed.queryIntent.filters.map((filter) => ({ term: filter.field, role: 'filter' as const })),
    ...(input.requirements.time?.grain ? [{ term: input.requirements.time.grain, role: 'time' as const }] : []),
  ].filter((requirement, index, all) =>
    Boolean(requirement.term.trim())
    && all.findIndex((other) => other.term === requirement.term && other.role === requirement.role) === index);
  // Do not turn a generic conversation or a row selection with no concrete
  // field requirement into a physical program. A lookup/projection follow-up
  // (for example, "which region does this customer belong to?") is still a
  // valid analytical request even though it has no aggregation measure. It is
  // safe only when every projected/filter field is uniquely qualified on one
  // relation; the exploratory compiler remains the authority for read-only
  // SQL validation, authorization, and review-required trust.
  if (termRequirements.length === 0) return undefined;

  const groupedRelations = new Map<string, AgentEvidenceCandidate[]>();
  for (const relation of relations) {
    const key = physicalRelationKey(relation);
    const group = groupedRelations.get(key) ?? [];
    group.push(relation);
    groupedRelations.set(key, group);
  }
  const completePrograms: Array<{ relation: AgentEvidenceCandidate; selected: AgentEvidenceCandidate[]; primary: AgentEvidenceCandidate }> = [];
  for (const relationGroup of groupedRelations.values()) {
    const relation = relationGroup[0]!;
    const relationColumns = columns.filter((column) => physicalColumnBelongsToRelation(column, relationGroup));
    if (relationColumns.length === 0) continue;
    const selected: AgentEvidenceCandidate[] = [];
    let complete = true;
    for (const requirement of termRequirements) {
      const column = uniqueBestPhysicalColumn(requirement.term, requirement.role, relationColumns);
      if (!column) {
        complete = false;
        break;
      }
      selected.push(column);
    }
    if (!complete) continue;
    let primary = input.requirements.measures.length > 0
      ? uniqueBestPhysicalColumn(input.requirements.measures[0]!, 'measure', relationColumns)
      : undefined;
    if (!primary) {
      for (const requirement of termRequirements) {
        if (requirement.role !== 'display') continue;
        const display = uniqueBestPhysicalColumn(requirement.term, 'display', relationColumns);
        if (display) {
          primary = display;
          break;
        }
      }
    }
    if (!primary) continue;
    completePrograms.push({
      relation,
      selected: [relation, ...selected].filter((candidate, index, values) =>
        values.findIndex((value) => stableCandidateId(value) === stableCandidateId(candidate)) === index),
      primary,
    });
  }
  // Multiple independently complete relations are material ambiguity. Do not
  // break the tie from lexical relevance; let the bounded planner decide.
  if (completePrograms.length !== 1) return undefined;
  const program = completePrograms[0]!;
  return {
    candidates: program.selected,
    resolution: deterministicResolution({
      request: input.request,
      seed: input.requirementSeed,
      candidates: program.selected,
      recommendedExecutionId: program.primary.id,
      recommendedRoute: 'exploratory',
    }),
    reasonCode: 'deterministic_single_relation_physical_binding',
  };
}

function deterministicResolution(input: {
  request: AgentRunRequest;
  seed: ReturnType<typeof buildAnalyticalRequirementSeedV1>;
  candidates: AgentEvidenceCandidate[];
  recommendedRoute: MeaningResolution['recommendedRoute'];
  recommendedExecutionId?: string;
}): MeaningResolution {
  const primary = input.candidates.find((candidate) => candidate.id === input.recommendedExecutionId)
    ?? input.candidates.find((candidate) => candidate.kind === 'semantic_metric')
    ?? input.candidates[0]!;
  return {
    interpretedQuestion: input.seed.sourceQuestion,
    questionType: questionTypeFromText(input.seed.sourceQuestion),
    selectedConceptIds: input.candidates.map((candidate) => candidate.id),
    recommendedExecutionId: input.recommendedExecutionId ?? primary.id,
    queryIntent: { ...input.seed.queryIntent, filters: input.seed.queryIntent.filters.map((filter) => ({ ...filter })) },
    rejectedCandidates: [],
    confidence: 'high',
    missingInformation: [],
    recommendedRoute: input.recommendedRoute,
    hostRequirementSeed: input.seed,
  };
}

function physicalRelationKey(candidate: AgentEvidenceCandidate): string {
  return physicalRelationReferences(candidate)[0] ?? normalizePhysicalBindingText(candidate.name);
}

function physicalRelationReferences(candidate: AgentEvidenceCandidate): string[] {
  const references = new Set<string>();
  for (const source of candidate.sourceObjects ?? []) {
    const normalized = normalizePhysicalBindingText(source);
    if (normalized) references.add(normalized);
  }
  for (const identity of [candidate.id, candidate.qualifiedId]) {
    if (!identity) continue;
    const leaf = identity.split(':').at(-1) ?? identity;
    const relationLeaf = candidate.kind === 'sql_column' && leaf.includes('.')
      ? leaf.slice(0, leaf.lastIndexOf('.'))
      : leaf;
    const normalized = normalizePhysicalBindingText(relationLeaf);
    if (normalized) references.add(normalized);
    // Manifest model IDs commonly retain a package namespace
    // (`model.package.dim_customers`) while runtime column IDs use only the
    // relation leaf (`dim_customers.column`). Keep that leaf as a second
    // identity solely for same-relation membership; it is never a selectable
    // business identifier.
    if (candidate.kind !== 'sql_column' && relationLeaf.includes('.')) {
      const terminalRelation = normalizePhysicalBindingText(relationLeaf.slice(relationLeaf.lastIndexOf('.') + 1));
      if (terminalRelation) references.add(terminalRelation);
    }
  }
  return [...references];
}

function physicalColumnBelongsToRelation(column: AgentEvidenceCandidate, relations: AgentEvidenceCandidate[]): boolean {
  const columnReferences = new Set(physicalRelationReferences(column));
  return relations.some((relation) => physicalRelationReferences(relation).some((reference) => columnReferences.has(reference)));
}

function uniqueBestPhysicalColumn(
  term: string,
  role: 'measure' | 'display' | 'filter' | 'time',
  candidates: AgentEvidenceCandidate[],
): AgentEvidenceCandidate | undefined {
  const scored = candidates
    .map((candidate) => ({ candidate, score: physicalColumnTermScore(term, role, candidate) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || stableCandidateId(left.candidate).localeCompare(stableCandidateId(right.candidate)));
  const first = scored[0];
  if (!first || (scored[1] && scored[1].score === first.score)) return undefined;
  return first.candidate;
}

function physicalColumnTermScore(
  term: string,
  role: 'measure' | 'display' | 'filter' | 'time',
  candidate: AgentEvidenceCandidate,
): number {
  const required = physicalBindingTokens(term);
  if (required.length === 0) return 0;
  const names = [candidate.name, ...(candidate.aliases ?? [])]
    .map(normalizePhysicalBindingText)
    .filter(Boolean);
  const candidateTokens = new Set(names.flatMap(physicalBindingTokens));
  if (!required.every((token) => candidateTokens.has(token))) return 0;
  let score = required.length * 10;
  const normalizedTerm = normalizePhysicalBindingText(term);
  if (names.some((name) => name === normalizedTerm)) score += 20;
  const identity = names.join(' ');
  if (role === 'display') {
    if (/\b(?:name|label|display|title)\b/.test(identity)) score += 8;
    if (/\b(?:id|key|owner|email|sentiment)\b/.test(identity)) score -= 8;
  }
  if (role === 'measure' && /\b(?:count|amount|revenue|spend|cost|margin|rate|total)\b/.test(identity)) score += 4;
  if (role === 'time' && /\b(?:date|time|month|week|quarter|year|period)\b/.test(identity)) score += 8;
  return score;
}

function normalizePhysicalBindingText(value: string): string {
  return value.toLowerCase()
    .replace(/[_./:-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function physicalBindingTokens(value: string): string[] {
  const ignored = new Set(['a', 'an', 'and', 'by', 'each', 'for', 'from', 'in', 'of', 'per', 'the', 'to', 'with']);
  return normalizePhysicalBindingText(value)
    .split(' ')
    .map((token) => token.endsWith('s') && token.length > 3 ? token.slice(0, -1) : token)
    .filter((token) => token.length > 1 && !ignored.has(token));
}

function frozenTaskPlan(
  taskExecutions: Array<{
    taskId: string;
    program: AnalyticalProgram;
    resolvedPlan: ResolvedAnalyticalPlanV2;
    requirements: AnalyticalRequirementSetV1;
  }>,
  question: string,
  mission: AnalyticalMissionV1,
): AgentRunPlan {
  const compilerList = [...new Set(taskExecutions.map((task) => task.resolvedPlan.compiler))];
  return {
    source: 'deterministic',
    rationale: `AskAnalystRuntimeV1 froze ${taskExecutions.length} independently verified task program${taskExecutions.length === 1 ? '' : 's'} for ${compilerList.join(', ')}.`,
    steps: taskExecutions.map((taskExecution, index) => {
      const route: AgentRunRoute = taskExecution.resolvedPlan.compiler === 'certified'
        ? 'certified_answer'
        : taskExecution.resolvedPlan.compiler === 'metricflow'
          ? 'semantic_answer'
          : taskExecution.resolvedPlan.compiler === 'governed_relational' || taskExecution.resolvedPlan.compiler === 'exploratory_sql'
            ? 'generated_answer'
            : 'blocked';
      const task = mission.tasks.find((candidate) => candidate.id === taskExecution.taskId);
      return {
        id: `program:${taskExecution.program.id}:task:${taskExecution.taskId}`,
        askAnalystTaskId: taskExecution.taskId,
        route,
        goal: task?.question ?? (index === 0 ? question : `${question} (task ${index + 1})`),
        successCriteria: [
          'Execute only this task\'s compiler-selected immutable analytical program.',
          ...taskExecution.program.outputs.assertions.map((assertion) => `Assert ${assertion.replaceAll('_', ' ')}.`),
          ...(taskExecution.requirements.ranking?.defaultedLimit ? ['Disclose the assumed top-10 limit.'] : []),
        ],
      };
    }),
  };
}

/**
 * Compile every accepted ordinary Ask task before freezing the first one.
 * This is deliberately all-or-nothing: a compound request either has one
 * independently verified/frozen program per accepted task, or remains a
 * pre-freeze typed gap.  It never reports task-1 as a complete answer while
 * silently dropping task-2.
 */
function compileVerifiedAskTasks(input: {
  base: IntentDecision;
  request: AgentRunRequest;
  evidence: AgentRetrievalEvidence | undefined;
  workspaceCandidates: AgentEvidenceCandidate[];
  admitted: AgentEvidenceCandidate[];
  initialState: AskAnalystStateV2;
  mission: AnalyticalMissionV1;
  verifiedFrame: BusinessQuestionFrameV4;
  program: AnalyticalProgramV2;
  verifiedRequirements: AnalyticalRequirementSetV1;
  verifiedRequirementSeed: ReturnType<typeof buildAnalyticalRequirementSeedV1>;
  plannerProposal: AnalyticalPlannerProposalV1 | undefined;
  verifiedPlanner: VerifiedPlannerInterpretationV1;
  resolution: MeaningResolution;
  requirementSeed: ReturnType<typeof buildAnalyticalRequirementSeedV1>;
  targetedContext?: TargetedContextResultV1;
}): { ok: true; value: AskAnalystTaskExecutionV1[] } | { ok: false; decision: IntentDecision; state?: AskAnalystStateV2 } {
  if (!input.evidence) {
    return {
      ok: false,
      decision: {
        action: 'block', confidence: 1, followsUp: false, source: 'heuristic',
        reason: 'The immutable evidence snapshot is unavailable for compiler verification.',
        terminalOutcome: {
          kind: 'modeling_gap',
          code: 'ANALYTICAL_MODELING_GAP',
          message: 'The immutable evidence snapshot is unavailable for compiler verification.',
          candidateIds: [],
        },
      },
    };
  }
  // Preserve the established one-task compiler bridge exactly. The task
  // compiler decomposition below is only necessary when a planner accepted
  // multiple independently executable tasks.
  if (input.verifiedPlanner.tasks.length === 1) {
    const task = input.verifiedPlanner.tasks[0]!;
    const missionTask = input.mission.tasks.find((candidate) => candidate.id === task.taskId);
    if (!missionTask) return taskCompilationFailure(input, `task:${task.taskId}:mission_unverified`);
    const taskRequirementSeed = requirementSeedForVerifiedPlanner({
      seed: input.verifiedRequirementSeed,
      requirements: input.verifiedRequirements,
      sourceQuestion: missionTask.question,
    });
    const taskRequest: AgentRunRequest = {
      ...input.request,
      question: missionTask.question,
      askAnalystTaskChild: {
        version: 1,
        taskId: task.taskId,
        question: missionTask.question,
        instructions: ['Compile only this verified frozen Ask task.'],
      },
    };
    const taskMission: AnalyticalMissionV1 = {
      ...input.mission,
      tasks: [missionTask],
      hypotheses: input.mission.hypotheses.filter((hypothesis) => hypothesis.taskId === missionTask.id),
    };
    const taskFrame: BusinessQuestionFrameV4 = {
      ...input.verifiedFrame,
      // The parent question remains on the outer run/trace. Every frozen
      // compiler child carries its own source fingerprint for continuation
      // and result binding.
      questionFingerprint: fingerprint(missionTask.question),
    };
    const taskProgram = buildProgram(taskFrame, taskMission, input.admitted, input.workspaceCandidates, taskRequirementSeed, {
      planningMode: taskFrame.planningMode,
      plannerProposal: input.plannerProposal,
      resolution: input.resolution,
      verifiedPlannerTasks: [task],
      ...(input.targetedContext ? { targetedContext: input.targetedContext } : {}),
    });
    const taskState = transitionState(input.initialState, 'program_ready', {
      frame: taskFrame,
      mission: taskMission,
      program: taskProgram,
      conversationDelta: {
        version: 2,
        sourceQuestionFingerprint: taskFrame.questionFingerprint,
        ...(taskFrame.conversation.selectedStableId ? { selectedStableId: taskFrame.conversation.selectedStableId } : {}),
        partialFrame: {
          kind: taskFrame.kind,
          requirements: taskFrame.requirements,
          planningMode: taskFrame.planningMode,
        },
        programId: taskProgram.id,
      },
    });
    const compilerEvidence = evidenceForVerifiedPlanner(input.evidence, taskRequirementSeed);
    const tierReadiness = tierReadinessFromEvidence(compilerEvidence, taskRequest, input.resolution);
    const compilerDecision = compileAskAnalyticalProgramV1({
      base: input.base,
      request: {
        ...taskRequest,
        askAnalystState: taskState,
        askAnalystProgram: taskProgram,
        askAnalystMeaningResolution: input.resolution,
        askAnalystTierReadiness: tierReadiness,
        hostRequirementSeed: taskRequirementSeed,
        askAnalystEvidence: compilerEvidence,
      },
      evidence: compilerEvidence,
      program: taskProgram,
      // The router receives only the verified business-meaning tuple. The
      // 32-card execution closure remains available separately for safe
      // relationship and physical fallback, but must never make correlated
      // metrics/dimensions part of the selected semantic meaning.
      candidates: meaningCandidatesForProgram(taskProgram, input.admitted),
      executionCandidates: executionCandidatesForProgram(taskProgram, input.workspaceCandidates),
      resolution: input.resolution,
      requirements: input.verifiedRequirements,
      mode: 'authoritative',
    });
    const resolvedPlan = resolvedPlanFromDecision(taskProgram.id, compilerDecision, {
      reviewRequired: hasSelectedInferredRoleSubstitution(input.resolution, input.admitted),
    });
    if (!resolvedPlan?.planFrozen || compilerDecision.action === 'clarify' || compilerDecision.terminalOutcome) {
      return {
        ok: false,
        decision: compilerDecision,
        state: transitionState(taskState, compilerDecision.action === 'clarify' ? 'clarify' : 'blocked', {
          ...(resolvedPlan ? { resolvedPlan } : {}),
        }),
      };
    }
    return {
      ok: true,
      value: [{
        version: 1,
        taskId: task.taskId,
        state: transitionState(taskState, 'compiled', { resolvedPlan }),
        program: taskProgram,
        meaningResolution: input.resolution,
        requirementSeed: taskRequirementSeed,
        tierReadiness,
        compilerDecision,
        resolvedPlan,
      }],
    };
  }
  const taskExecutions: AskAnalystTaskExecutionV1[] = [];
  for (const verifiedTask of input.verifiedPlanner.tasks) {
    const missionTask = input.mission.tasks.find((task) => task.id === verifiedTask.taskId);
    if (!missionTask) {
      return {
        ok: false,
        decision: {
          action: 'block', confidence: 1, followsUp: false, source: 'heuristic',
          reason: 'The planner proposed a task outside the bounded ordinary Ask mission.',
          terminalOutcome: {
            kind: 'policy_blocked',
            code: 'ANALYTICAL_POLICY_BLOCKED',
            message: 'The planner proposed a task outside the bounded ordinary Ask mission.',
            candidateIds: [],
          },
        },
      };
    }
    const taskSelectionIds = uniqueStableIds([
      ...verifiedTask.selectedConceptIds,
      ...Object.values(verifiedTask.roleBindings).flatMap((ids) => ids ?? []),
    ]);
    const taskCandidates = input.admitted.filter((candidate) =>
      taskSelectionIds.includes(candidate.id) || taskSelectionIds.includes(stableCandidateId(candidate)));
    const taskRequirements = requirementsForVerifiedPlanner({
      requirements: input.verifiedFrame.requirements,
      selectedCandidates: taskCandidates,
      tasks: [verifiedTask],
      operations: new Set(verifiedTask.operations),
      question: missionTask.question,
    });
    if (!taskRequirements) {
      return taskCompilationFailure(input, `task:${verifiedTask.taskId}:requirements_unverified`);
    }
    const taskRequirementSeed = requirementSeedForVerifiedPlanner({
      seed: input.requirementSeed,
      requirements: taskRequirements,
      sourceQuestion: missionTask.question,
    });
    const taskRequest: AgentRunRequest = {
      ...input.request,
      question: missionTask.question,
      askAnalystTaskChild: {
        version: 1,
        taskId: missionTask.id,
        question: missionTask.question,
        instructions: ['Compile only this verified frozen Ask task.'],
      },
    };
    const taskCompilerEvidence = evidenceForVerifiedPlanner(input.evidence, taskRequirementSeed);
    const taskMetricId = (verifiedTask.roleBindings.metric ?? []).find((id) => taskSelectionIds.includes(id));
    const taskResolution: MeaningResolution = {
      ...input.resolution,
      selectedConceptIds: taskSelectionIds,
      ...(taskMetricId ? { recommendedExecutionId: taskMetricId } : {}),
      queryIntent: {
        ...taskRequirementSeed.queryIntent,
        filters: taskRequirementSeed.queryIntent.filters.map((filter) => ({ ...filter })),
      },
      hostRequirementSeed: taskRequirementSeed,
    };
    const bound = bindAskAnalystProgramMeaningV1({
      request: taskRequest,
      evidence: input.evidence,
      candidates: input.admitted,
      requirementSeed: taskRequirementSeed,
      resolution: taskResolution,
    });
    const validation = validateMeaningResolution(
      bound,
      input.admitted,
      taskRequirementSeed.queryIntent.measures,
      { requirements: taskRequirements },
    );
    if (!validation.ok) return taskCompilationFailure(input, `task:${verifiedTask.taskId}:meaning_unverified`);
    const taskMission: AnalyticalMissionV1 = {
      ...input.mission,
      tasks: [missionTask],
      hypotheses: input.mission.hypotheses.filter((hypothesis) => hypothesis.taskId === missionTask.id),
    };
    const taskFrame: BusinessQuestionFrameV4 = {
      ...input.verifiedFrame,
      questionFingerprint: fingerprint(missionTask.question),
      requirements: taskRequirements,
    };
    const taskProgram = buildProgram(taskFrame, taskMission, input.admitted, input.workspaceCandidates, taskRequirementSeed, {
      planningMode: taskFrame.planningMode,
      plannerProposal: input.plannerProposal,
      resolution: validation.resolution,
      verifiedPlannerTasks: [verifiedTask],
      ...(input.targetedContext ? { targetedContext: input.targetedContext } : {}),
    });
    const taskState = transitionState(input.initialState, 'program_ready', {
      frame: taskFrame,
      mission: taskMission,
      program: taskProgram,
      conversationDelta: {
        version: 2,
        sourceQuestionFingerprint: taskFrame.questionFingerprint,
        ...(taskFrame.conversation.selectedStableId ? { selectedStableId: taskFrame.conversation.selectedStableId } : {}),
        partialFrame: {
          kind: taskFrame.kind,
          requirements: taskRequirements,
          planningMode: taskFrame.planningMode,
        },
        programId: taskProgram.id,
      },
    });
    const tierReadiness = tierReadinessFromEvidence(taskCompilerEvidence, taskRequest, validation.resolution);
    const compilerDecision = compileAskAnalyticalProgramV1({
      base: input.base,
      request: {
        ...taskRequest,
        askAnalystState: taskState,
        askAnalystProgram: taskProgram,
        askAnalystMeaningResolution: validation.resolution,
        askAnalystTierReadiness: tierReadiness,
        hostRequirementSeed: taskRequirementSeed,
        askAnalystEvidence: taskCompilerEvidence,
      },
      evidence: taskCompilerEvidence,
      program: taskProgram,
      candidates: meaningCandidatesForProgram(taskProgram, input.admitted),
      executionCandidates: executionCandidatesForProgram(taskProgram, input.workspaceCandidates),
      resolution: validation.resolution,
      requirements: taskRequirements,
      mode: 'authoritative',
    });
    const resolvedPlan = resolvedPlanFromDecision(taskProgram.id, compilerDecision, {
      reviewRequired: hasSelectedInferredRoleSubstitution(validation.resolution, input.admitted),
    });
    if (!resolvedPlan?.planFrozen || compilerDecision.action === 'clarify' || compilerDecision.terminalOutcome) {
      return {
        ok: false,
        decision: compilerDecision,
        state: transitionState(taskState, compilerDecision.action === 'clarify' ? 'clarify' : 'blocked', {
          ...(resolvedPlan ? { resolvedPlan } : {}),
        }),
      };
    }
    taskExecutions.push({
      version: 1,
      taskId: missionTask.id,
      state: transitionState(taskState, 'compiled', { resolvedPlan }),
      program: taskProgram,
      meaningResolution: validation.resolution,
      requirementSeed: taskRequirementSeed,
      tierReadiness,
      compilerDecision,
      resolvedPlan,
    });
  }
  return taskExecutions.length === input.mission.tasks.length
    ? { ok: true, value: taskExecutions }
    : taskCompilationFailure(input, 'ordinary_ask_task_execution_incomplete');
}

function taskCompilationFailure(
  input: Pick<Parameters<typeof compileVerifiedAskTasks>[0], 'base'>,
  reasonCode: string,
): { ok: false; decision: IntentDecision } {
  const message = `The bounded Ask plan could not verify every accepted task before execution (${reasonCode}). No partial result was run.`;
  return {
    ok: false,
    decision: {
      ...input.base,
      action: 'block',
      confidence: 1,
      followsUp: false,
      source: 'heuristic',
      reason: message,
      terminalOutcome: {
        kind: 'modeling_gap',
        code: 'ANALYTICAL_MODELING_GAP',
        message,
        candidateIds: [],
      },
      analyticalCascadeDecision: undefined,
      resolvedAnalyticalPlan: undefined,
    },
  };
}

function tierReadinessFromEvidence(
  evidence: AgentRetrievalEvidence | undefined,
  request: AgentRunRequest,
  resolution?: MeaningResolution,
): NonNullable<AgentRunRequest['askAnalystTierReadiness']> {
  const diagnostic = evidence?.diagnostics;
  const sourceCoverage = evidence?.diagnostics?.sourceCoverage ?? [];
  const sourceStatus = (source: ContextSourceCoverageV1['source']): 'ready' | 'unavailable' | 'unknown' => {
    const status = sourceCoverage.find((coverage) => coverage.source === source)?.status;
    return status === 'errored' || status === 'unavailable' || status === 'stale' ? 'unavailable'
      : status ? 'ready' : 'unknown';
  };
  const reportedSemanticReadiness = diagnostic?.tierReadiness?.semanticCompiler ?? sourceStatus('semantic');
  const candidateReadiness = diagnostic?.tierReadiness?.semanticCandidateReadiness ?? [];
  const selectedSemanticCandidates = resolution
    ? evidence?.candidates.filter((candidate) =>
        candidate.kind === 'semantic_metric'
        && resolution.selectedConceptIds.some((id) => id === candidate.id || id === candidate.qualifiedId)) ?? []
    : [];
  const selectedCandidateStatuses = selectedSemanticCandidates.flatMap((candidate) => {
    const identities = [candidate.id, candidate.qualifiedId].filter((id): id is string => Boolean(id));
    return candidateReadiness
      .filter((item) => identities.includes(item.candidateId))
      .map((item) => item.status);
  });
  // Readiness is tied to the frozen execution metric(s), not to the broad
  // retrieval package. A native-compatible card elsewhere in the snapshot
  // cannot make an external-only selected metric appear compiler-ready.
  const semanticCompiler = selectedCandidateStatuses.includes('unavailable')
    ? 'unavailable'
    : selectedSemanticCandidates.length > 0
      && selectedCandidateStatuses.length === selectedSemanticCandidates.length
      && selectedCandidateStatuses.every((status) => status === 'ready')
        ? 'ready'
        : reportedSemanticReadiness;
  return {
    connector: diagnostic?.tierReadiness?.connector
      ?? (request.executionTarget ? 'ready' : 'unknown'),
    activeTarget: diagnostic?.tierReadiness?.activeTarget
      ?? (request.executionTarget ? 'ready' : 'unknown'),
    semanticCompiler,
    ...(candidateReadiness.length > 0 ? { semanticCandidateReadiness: candidateReadiness } : {}),
    physicalSchema: diagnostic?.tierReadiness?.physicalSchema
      ?? (sourceStatus('runtime_schema') === 'unknown' ? sourceStatus('dbt_manifest') : sourceStatus('runtime_schema')),
    ...(diagnostic?.tierReadiness?.targetFingerprint ? { targetFingerprint: diagnostic.tierReadiness.targetFingerprint } : {}),
  };
}

/**
 * Compiler closure is an immutable subset of the retrieval snapshot.  Keeping
 * it here rather than in the broker prevents an adapter from accidentally
 * gaining a candidate the runtime did not freeze into the program.
 */
function executionCandidatesForProgram(
  program: AnalyticalProgram,
  candidates: AgentEvidenceCandidate[],
): AgentEvidenceCandidate[] {
  const allowed = new Set(program.executionCandidateIds ?? program.candidateIds);
  return candidates.filter((candidate) =>
    allowed.has(candidate.id) || allowed.has(candidate.qualifiedId ?? candidate.id));
}

/**
 * Compiler meaning authority is narrower than compiler execution context.
 * The latter may contain up to 32 qualified cards for a pre-freeze physical
 * closure; it may not add a correlated metric or an identifier-shaped
 * attribute to the already verified business tuple.
 */
function meaningCandidatesForProgram(
  program: AnalyticalProgram,
  candidates: AgentEvidenceCandidate[],
): AgentEvidenceCandidate[] {
  const selected = new Set(program.candidateIds);
  return candidates.filter((candidate) =>
    selected.has(candidate.id) || selected.has(candidate.qualifiedId ?? candidate.id));
}

function candidateMatchesFilterValue(candidate: AgentEvidenceCandidate, value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return [candidate.id, candidate.qualifiedId, candidate.name, ...(candidate.aliases ?? [])]
    .filter((identity): identity is string => Boolean(identity))
    .some((identity) => identity.trim().toLowerCase() === normalized);
}

function stableCandidateId(candidate: AgentEvidenceCandidate): string {
  return candidate.qualifiedId ?? candidate.id;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isAskRequest(request: AgentRunRequest): boolean {
  return request.requestedMode === undefined
    || request.requestedMode === 'auto'
    || request.requestedMode === 'ask'
    || request.requestedMode === 'research';
}

function buildBusinessQuestionFrame(
  request: AgentRunRequest,
  requirements: AnalyticalRequirementSetV1,
): BusinessQuestionFrameV4 {
  // Research is an explicit user-selected workflow. Ordinary Ask may use
  // investigative language, but it remains a bounded Ask program rather than
  // silently changing its budget, trace, and execution contract to Research.
  const inferredKind = inferAnalyticalTurnKind(request.question);
  const kind = request.requestedMode === 'research'
    ? 'research'
    : inferredKind === 'research'
      ? 'diagnosis'
      : inferredKind;
  // Keep a raw client selection out of durable conversation state until the
  // persisted server-owned clarification authority proves it. This avoids
  // receipts and follow-up state falsely presenting a forged ID as a trusted
  // structured continuation.
  const trustedContinuation = serverIssuedContinuation(request);
  const persistedConversationBinding = request.conversationBinding === 'structured_clarification'
    && !trustedContinuation
    ? undefined
    : request.conversationBinding;
  const defaultedTop = requirements.ranking?.defaultedLimit
    ? { limit: requirements.ranking.limit }
    : undefined;
  return {
    version: 4,
    planningMode: 'initial_planner',
    questionFingerprint: fingerprint(request.question),
    kind,
    requirements,
    ...(defaultedTop ? { defaultedTop } : {}),
    conversation: {
      binding: trustedContinuation ? 'structured_clarification' : persistedConversationBinding ?? (
        request.selectedResultBinding
          ? 'prior_result'
          : 'none'),
      ...(request.clarificationSourceQuestion ? { sourceTurnId: fingerprint(request.clarificationSourceQuestion) } : {}),
      ...(trustedContinuation && request.selectedEvidenceId ? { selectedStableId: request.selectedEvidenceId } : {}),
    },
  };
}

function buildMission(
  request: AgentRunRequest,
  requirements: AnalyticalRequirementSetV1,
  kind: BusinessQuestionFrameV4['kind'],
  requirementSeed: ReturnType<typeof buildAnalyticalRequirementSeedV1>,
): AnalyticalMissionV1 {
  const research = request.requestedMode === 'research';
  const graph = buildAnalyticalTaskGraph({
    question: request.question,
    mode: research ? 'research' : 'ask',
    metrics: requirements.measures,
    dimensions: requirements.dimensions,
    // Field/value bindings are part of the request program before any compiler
    // is selected. A compiler may map qualified IDs, but may not invent a
    // missing predicate from prose or an empty member card.
    filters: requirementSeed.queryIntent.filters.map((filter) => ({ ...filter })),
    maxTasks: research ? MAX_RESEARCH_TASKS : MAX_ASK_TASKS,
  });
  // Every accepted ordinary-Ask task is compiled into its own immutable
  // program before any one of them executes.  This prevents the prior
  // task-1-only path from returning a partial success for a compound question.
  const executableTasks = graph.tasks;
  const hypothesisKinds = research
    ? ['direct_answer', 'trend', 'comparison', 'contributor', 'counter_evidence'] as const
    : ['direct_answer'] as const;
  const hypotheses: AnalyticalHypothesisV1[] = hypothesisKinds
    .slice(0, research ? MAX_RESEARCH_TASKS : 1)
    .map((hypothesisKind, index) => ({
      version: 1,
      id: `hypothesis-${index + 1}`,
      kind: hypothesisKind,
      taskId: executableTasks[Math.min(index, Math.max(0, executableTasks.length - 1))]?.id ?? 'task-1',
      status: 'planned',
      requiredRoles: requiredRoles(requirements),
    }));
  return {
    version: 1,
    mode: research ? 'research' : 'ask',
    taskLimit: research ? MAX_RESEARCH_TASKS : MAX_ASK_TASKS,
    planningContinuationLimit: MAX_PLANNING_CONTINUATIONS,
    tasks: executableTasks,
    ...(graph.partial ? { scopeOverflow: true } : {}),
    hypotheses,
  };
}

function buildEvidenceWorkspace(
  evidence: AgentRetrievalEvidence | undefined,
  workspaceCandidates: AgentEvidenceCandidate[],
  admitted: AgentEvidenceCandidate[],
  tools: EvidenceWorkspaceV1['tools'],
  requirements: AnalyticalRequirementSetV1,
  targetedContext?: TargetedContextResultV1,
): EvidenceWorkspaceV2 {
  const admittedIds = stableCandidateIds(admitted);
  const admittedSet = new Set(admittedIds);
  const workspaceIds = new Set(stableCandidateIds(workspaceCandidates));
  const seen = new Set<string>();
  const excludedCandidates: EvidenceWorkspaceV1['excludedCandidates'] = [];
  for (const candidate of evidence?.candidates ?? []) {
    const id = candidate.qualifiedId ?? candidate.id;
    if (seen.has(id)) {
      excludedCandidates.push({ id, reasonCode: 'duplicate' });
      continue;
    }
    seen.add(id);
    if (admittedSet.has(id)) continue;
    excludedCandidates.push({
      id,
      reasonCode: candidate.eligible === false
        ? 'incompatible'
        : candidate.compatibility === 'incompatible'
          ? 'incompatible'
          : workspaceIds.has(id)
            ? 'role_cap'
            : 'not_admitted',
    });
  }
  return {
    version: 2,
    ...(evidence?.snapshotId ? { snapshotId: evidence.snapshotId } : {}),
    ...(evidence?.sourceFingerprint ? { sourceFingerprint: evidence.sourceFingerprint } : {}),
    sourceCoverage: sourceCoverageFromEvidence(evidence),
    // Persist both bounded layers so a restart/trace can distinguish a card
    // that was eligible compiler context from one intentionally shown to the
    // planner. The raw 80-card search pool is never serialized here.
    workspaceCandidateIds: stableCandidateIds(workspaceCandidates).slice(0, 32),
    plannerCandidateIds: admittedIds.slice(0, 16),
    admittedCandidateIds: admittedIds.slice(0, 16),
    roleCoverage: roleCoverageForAdmittedCandidates(requirements, admitted),
    excludedCandidates: excludedCandidates.slice(0, 32),
    tools: tools.slice(0, MAX_TOOLS),
    ...(targetedContext ? { targetedContext } : {}),
  };
}

function sourceCoverageFromEvidence(evidence: AgentRetrievalEvidence | undefined): ContextSourceCoverageV1[] {
  if (!evidence) return [];
  if (evidence.diagnostics?.sourceCoverage?.length) {
    return evidence.diagnostics.sourceCoverage.map((coverage) => ({
      ...coverage,
      version: 1,
      candidateIds: [...new Set(coverage.candidateIds)].slice(0, 32),
    }));
  }
  const sourceFor = (candidate: AgentEvidenceCandidate): ContextSourceCoverageV1['source'] | undefined =>
    candidate.kind === 'certified_block' ? 'certified'
      : candidate.kind === 'semantic_metric' || candidate.kind === 'semantic_member' || candidate.trustTier === 'semantic' ? 'semantic'
        : candidate.kind === 'dql_modeling' || (candidate.relationshipEvidence?.length ?? 0) > 0 ? 'governed_relational'
          : candidate.kind === 'dbt_model' || candidate.kind === 'dbt_source' ? 'dbt_manifest'
            : candidate.kind === 'sql_table' || candidate.kind === 'sql_column' ? 'runtime_schema'
              : undefined;
  const grouped = new Map<ContextSourceCoverageV1['source'], string[]>();
  for (const candidate of evidence.candidates) {
    const source = sourceFor(candidate);
    if (!source) continue;
    const values = grouped.get(source) ?? [];
    values.push(candidate.qualifiedId ?? candidate.id);
    grouped.set(source, values);
  }
  return [...grouped.entries()].map(([source, candidateIds]) => ({
    version: 1,
    source,
    status: candidateIds.length ? 'available' : 'empty',
    candidateIds: [...new Set(candidateIds)].slice(0, 32),
  }));
}

const PHYSICAL_EXECUTION_KINDS = new Set<AgentEvidenceCandidate['kind']>([
  'dbt_model', 'dbt_source', 'sql_table', 'sql_column', 'dql_modeling',
]);

function candidateIdentityTerms(candidate: AgentEvidenceCandidate): string {
  return [
    candidate.id,
    candidate.qualifiedId,
    candidate.name,
    ...(candidate.aliases ?? []),
    candidate.sameSnapshotRoleExtension?.requestedTerm,
    ...(candidate.sourceObjects ?? []),
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase()
    .replace(/[_./:-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function requirementIdentityTerms(requirements: AnalyticalRequirementSetV1): string[] {
  const requested = [
    ...requirements.measures,
    ...requirements.entityTerms,
    ...requirements.entityDisplayTerms,
    ...categoricalTermsForRuntime(requirements),
  ].flatMap((term) => term.toLowerCase().replace(/[_./:-]+/g, ' ').split(/\s+/));
  // A customer/product analytical request usually needs the authored bridge
  // relations even when `order` was not spoken. This is retrieval admission,
  // not a join inference: the existing relationship compiler still demands a
  // certified path before it can freeze either relational or exploratory SQL.
  if (requirements.entityTerms.some((term) => /customer|client|account/.test(term))
    && categoricalTermsForRuntime(requirements).some((term) => /product/.test(term))) {
    requested.push('order', 'orders', 'order item', 'order items');
  }
  return [...new Set(requested.map((term) => term.trim()).filter((term) => term.length > 2))];
}

function categoricalTermsForRuntime(requirements: AnalyticalRequirementSetV1): string[] {
  return requirements.dimensions.filter((term) => !requirements.entityTerms.some((entity) =>
    term === entity || term === `${entity} name`));
}

type SameSnapshotRoleExtensionAdmissionV1 = {
  candidates: AgentEvidenceCandidate[];
  ambiguities: Array<{ requestedTerm: string; candidates: AgentEvidenceCandidate[] }>;
  /** Same-snapshot wrappers for a requested role that failed current proof. */
  rejectedCandidateIds: string[];
};

/**
 * Recover only a snapshot-authored, metric-capability extension before the
 * bounded role selector runs. A physical `location_name` does not become a
 * `region` synonym here: the selected metric must declare exactly one safe
 * geographic MetricFlow grouping. When more than one such grouping exists,
 * preserve the unresolved business term and let the caller clarify instead
 * of silently aliasing a geography field.
 */
function sameSnapshotRoleExtensionAdmissionForRequirements(input: {
  candidates: AgentEvidenceCandidate[];
  clarificationCandidates: AgentEvidenceCandidate[];
  requirements: AnalyticalRequirementSetV1;
}): SameSnapshotRoleExtensionAdmissionV1 {
  const requestedTerms = [...new Set(categoricalTermsForRuntime(input.requirements)
    .map(normalizeStableTerm)
    .filter(Boolean))];
  if (requestedTerms.length === 0) return { candidates: [], ambiguities: [], rejectedCandidateIds: [] };
  const metricTerms = input.requirements.ranking?.metricTerms.length
    ? input.requirements.ranking.metricTerms
    : input.requirements.measures;
  const metrics = metricTerms.length === 0
    ? []
    : input.candidates.filter((candidate) => candidate.kind === 'semantic_metric'
      && candidate.eligible !== false
      && candidate.compatibility !== 'incompatible'
      && Boolean(candidate.analyticalCapability)
      && metricTerms.some((term) => candidateMatchesPlannerRequirementTerm(candidate, term)));
  const declaredExtensions = input.clarificationCandidates.filter((candidate) =>
    metrics.some((metric) => Boolean(proveSameSnapshotMetricflowRoleExtensionV1({
      candidate,
      metricCandidate: metric,
    }))));
  const rejectedCandidateIds = input.candidates
    .filter((candidate) => {
      const requestedTerm = normalizeStableTerm(candidate.sameSnapshotRoleExtension?.requestedTerm ?? '');
      return requestedTerm.length > 0
        && requestedTerms.includes(requestedTerm)
        && !metrics.some((metric) => Boolean(proveSameSnapshotMetricflowRoleExtensionV1({
          candidate,
          metricCandidate: metric,
        })));
    })
    .map(stableCandidateId);
  const admitted: AgentEvidenceCandidate[] = [];
  const ambiguities: SameSnapshotRoleExtensionAdmissionV1['ambiguities'] = [];
  for (const requestedTerm of requestedTerms) {
    // A direct qualified business dimension remains authoritative. This
    // recovery path exists only for a role that raw admission cannot prove.
    const direct = input.candidates.some((candidate) =>
      evidenceCandidateRoles(candidate).includes('categorical_dimension')
      && candidateMatchesPlannerRequirementTerm(candidate, requestedTerm));
    if (direct) continue;
    const recovered = metrics.flatMap((metric) =>
      deterministicSemanticRoleExtensions(metric, input.candidates, input.requirements)
        .filter((candidate) => Boolean(proveSameSnapshotMetricflowRoleExtensionV1({
          candidate,
          metricCandidate: metric,
        }))))
      .filter((candidate) => normalizeStableTerm(candidate.sameSnapshotRoleExtension?.requestedTerm ?? '') === requestedTerm);
    const candidates = uniqueCandidates([
      ...declaredExtensions.filter((candidate) =>
        normalizeStableTerm(candidate.sameSnapshotRoleExtension?.requestedTerm ?? '') === requestedTerm),
      ...recovered,
    ]).sort((left, right) => Number(Boolean(right.exactMatch)) - Number(Boolean(left.exactMatch))
      || right.relevanceScore - left.relevanceScore
      || stableCandidateId(left).localeCompare(stableCandidateId(right)));
    if (candidates.length === 1) {
      admitted.push(candidates[0]!);
    } else if (candidates.length > 1) {
      ambiguities.push({ requestedTerm, candidates: candidates.slice(0, 3) });
    }
  }
  return {
    candidates: uniqueCandidates(admitted),
    ambiguities,
    rejectedCandidateIds: [...new Set(rejectedCandidateIds)],
  };
}

/**
 * Replace a raw same-snapshot card with its qualified extension rather than
 * appending both. The role selector deduplicates by source ID, so appending
 * would otherwise reintroduce the unqualified raw card and lose the authored
 * `requestedTerm` declaration before the 32-card workspace is built.
 */
function snapshotCandidatesWithRoleExtensions(
  candidates: AgentEvidenceCandidate[],
  extensions: AgentEvidenceCandidate[],
): AgentEvidenceCandidate[] {
  const bySourceId = new Map(extensions.map((candidate) => [candidate.id, candidate] as const));
  const knownSourceIds = new Set(candidates.map((candidate) => candidate.id));
  return uniqueCandidates([
    ...candidates.map((candidate) => bySourceId.get(candidate.id) ?? candidate),
    ...extensions.filter((candidate) => !knownSourceIds.has(candidate.id)),
  ]);
}

function sameSnapshotRoleAmbiguityForClarification(
  ambiguities: SameSnapshotRoleExtensionAdmissionV1['ambiguities'],
): {
  question: string;
  options: NonNullable<IntentDecision['clarificationOptions']>;
} | undefined {
  const ambiguity = ambiguities[0];
  if (!ambiguity || ambiguity.candidates.length < 2) return undefined;
  const options = ambiguity.candidates.map((candidate) => ({
    id: stableCandidateId(candidate),
    label: humanizeCandidateLabel(candidate.name),
    description: `Use ${humanizeCandidateLabel(candidate.name)} as the ${ambiguity.requestedTerm} grouping.`,
    kind: 'semantic_dimension' as const,
  }));
  const labels = new Set(options.map((option) => normalizeStableTerm(option.label)));
  if (labels.size < 2) return undefined;
  return {
    question: `Which geographic field should I use for “${ambiguity.requestedTerm}”?`,
    options,
  };
}

type OrdinaryRoleInferenceAmbiguityV1 = {
  role: EvidenceCandidateRoleV1;
  requestedTerm: string;
  options: NonNullable<IntentDecision['clarificationOptions']>;
  question: string;
};

type OrdinaryRoleInferenceGroupV1 = {
  role: EvidenceCandidateRoleV1;
  requestedTerm: string;
  candidates: AgentEvidenceCandidate[];
};

/**
 * Ordinary qualified fallbacks have deliberately weaker authority than an
 * authored semantic alias.  Group their admission receipts once so the
 * ambiguity, sole-substitution, verifier, and observability paths cannot
 * disagree about the exact same bounded candidate set.
 */
function ordinaryRoleInferenceGroups(input: {
  /** The qualified 32-card execution workspace, before planner truncation. */
  candidates: readonly AgentEvidenceCandidate[];
  requirements: AnalyticalRequirementSetV1;
  relationshipClosure: readonly AgentEvidenceCandidate[];
  /** Canonical metric-primary endpoint proof, not candidate-local reachability. */
  relationshipClosureComplete: boolean;
  /** Canonical entity/relation context derived from this same snapshot. */
  ordinaryRoleEntityContext: OrdinaryRoleEntityContextV1;
}): OrdinaryRoleInferenceGroupV1[] {
  const groups: OrdinaryRoleInferenceGroupV1[] = [];
  for (const slot of plannerAdmissionSlots(input.requirements)) {
    // The contract is intentionally narrow. Other unresolved roles retain
    // their existing verifier/clarification behavior; categorical fallbacks
    // are the only ordinary fields that can otherwise become a silent
    // business synonym such as region -> country/location.
    if (slot.role !== 'categorical_dimension') continue;
    const requestedTerm = slot.terms[0];
    if (!requestedTerm) continue;
    // A literal/declared match is the normal governed path. Do not create an
    // ordinary-inference ambiguity beside a field the snapshot already
    // explicitly models for the requested business term.
    if (input.candidates.some((candidate) =>
      candidateServesPlannerAdmissionSlot(candidate, slot)
      || candidateMatchesCategoricalDimensionRequirement(candidate, slot.terms))) continue;
    const candidates = input.candidates
      .filter((candidate) => !candidate.sameSnapshotRoleExtension
        && candidateCanResolveUnresolvedPlannerSlot(candidate, slot, input.ordinaryRoleEntityContext)
        && ordinaryRoleCandidateIsSafeAndReachable(
          candidate,
          input.relationshipClosure,
          input.ordinaryRoleEntityContext,
          input.relationshipClosureComplete,
        ))
      .filter((candidate, index, values) =>
        values.findIndex((item) => stableCandidateId(item) === stableCandidateId(candidate)) === index)
      .sort((left, right) => stableCandidateId(left).localeCompare(stableCandidateId(right)));
    if (candidates.length > 0) {
      groups.push({
        role: slot.role,
        requestedTerm,
        candidates,
      });
    }
  }
  return groups.sort((left, right) => left.requestedTerm.localeCompare(right.requestedTerm));
}

/**
 * Mark exactly-one ordinary candidates as explicit inferred substitutions.
 * This is a local receipt, not an alias: only planner-bound selections pass
 * verification and all resulting plans remain review-required.
 */
function promoteUniqueOrdinaryRoleInferenceCandidates(input: {
  admitted: AgentEvidenceCandidate[];
  workspaceCandidates: readonly AgentEvidenceCandidate[];
  requirements: AnalyticalRequirementSetV1;
  relationshipClosure: readonly AgentEvidenceCandidate[];
  relationshipClosureComplete: boolean;
  ordinaryRoleEntityContext: OrdinaryRoleEntityContextV1;
  /** The already-proven compact closure, if this inferred field is cross-entity. */
  relationshipPath?: AgentEvidenceCandidate;
}): AgentEvidenceCandidate[] {
  const substitutions = ordinaryRoleInferenceGroups({
    candidates: input.workspaceCandidates,
    requirements: input.requirements,
    relationshipClosure: input.relationshipClosure,
    relationshipClosureComplete: input.relationshipClosureComplete,
    ordinaryRoleEntityContext: input.ordinaryRoleEntityContext,
  })
    .filter((group) => group.candidates.length === 1);
  if (substitutions.length === 0) return input.admitted;

  // The role-balanced package may have reserved the ordinary candidate, but
  // older/live snapshots can still present the raw relationship edges and
  // enough context cards to cap it out.  Materialize the one host-proven
  // candidate rather than asking a later verifier to recover an already
  // qualified role.  When it needs a cross-entity bridge, use the one atomic
  // path card and remove only its raw closure edges from the planner package;
  // execution continues to hydrate those canonical edges from the workspace.
  let selected = [...input.admitted];
  const needsRelationshipPath = substitutions.some((substitution) =>
    ordinaryRoleCandidateRequiresRelationship(substitution.candidates[0]!, input.ordinaryRoleEntityContext));
  if (needsRelationshipPath && input.relationshipPath) {
    const closureIds = new Set(input.relationshipClosure.map(stableCandidateId));
    const firstClosureIndex = selected.findIndex((candidate) => closureIds.has(stableCandidateId(candidate)));
    const hasPath = selected.some((candidate) => candidateMatchesStableIdentity(candidate, stableCandidateId(input.relationshipPath!)));
    if (!hasPath) {
      selected = selected.filter((candidate) => !closureIds.has(stableCandidateId(candidate)));
      const insertionIndex = firstClosureIndex < 0 ? selected.length : Math.min(firstClosureIndex, selected.length);
      selected.splice(insertionIndex, 0, input.relationshipPath);
    }
  }

  const addHostOwnedCandidate = (candidate: AgentEvidenceCandidate): void => {
    const existingIndex = selected.findIndex((item) => stableCandidateId(item) === stableCandidateId(candidate));
    if (existingIndex >= 0) {
      selected[existingIndex] = candidate;
      return;
    }
    if (selected.length < MAX_INITIAL_PLANNER_CANDIDATES) {
      selected.push(candidate);
      return;
    }
    // Exact pins, required-role cards, and the host-owned relationship path
    // are not relevance fillers. Replace only a trailing non-required card;
    // if none exists, keep the immutable package rather than evicting a
    // proved business requirement.
    for (let index = selected.length - 1; index >= 0; index -= 1) {
      const current = selected[index]!;
      if (current.exactMatch
        || candidateSupportsRequiredRole(current, input.requirements)
        || current.id.startsWith('dql:relationship_path:')) continue;
      selected[index] = candidate;
      return;
    }
  };

  for (const substitution of substitutions) {
    const ordinaryCandidate = substitution.candidates[0]!;
    addHostOwnedCandidate(markCandidateForUniqueInferredRoleSubstitution(ordinaryCandidate, {
      role: substitution.role,
      terms: [substitution.requestedTerm],
    }));
  }
  return uniqueCandidates(selected).slice(0, MAX_INITIAL_PLANNER_CANDIDATES);
}

/**
 * The ordinary fallback lane deliberately has less authority than a declared
 * semantic alias. It can reserve qualified, reachable fields for a planner,
 * but it cannot choose between two such fields. This gate runs only after the
 * 16-card admission has made the competing alternatives explicit and before a
 * provider, cascade, or connection can observe them.
 */
function ordinaryRoleInferenceAmbiguityForClarification(input: {
  candidates: readonly AgentEvidenceCandidate[];
  requirements: AnalyticalRequirementSetV1;
  relationshipClosure: readonly AgentEvidenceCandidate[];
  relationshipClosureComplete: boolean;
  ordinaryRoleEntityContext: OrdinaryRoleEntityContextV1;
}): OrdinaryRoleInferenceAmbiguityV1 | undefined {
  const ambiguity = ordinaryRoleInferenceGroups(input)
    .filter((group) => group.candidates.length >= 2)
    [0];
  if (!ambiguity) return undefined;
  const sortedCandidates = [...ambiguity.candidates]
    .sort((left, right) => stableCandidateId(left).localeCompare(stableCandidateId(right)));
  const labelCounts = new Map<string, number>();
  for (const candidate of sortedCandidates) {
    const normalized = normalizeStableTerm(humanizeCandidateLabel(candidate.name));
    labelCounts.set(normalized, (labelCounts.get(normalized) ?? 0) + 1);
  }
  const options = sortedCandidates.map((candidate) => {
    const baseLabel = humanizeCandidateLabel(candidate.name);
    const duplicate = (labelCounts.get(normalizeStableTerm(baseLabel)) ?? 0) > 1;
    // UI labels are presentation only. When two snapshot columns share a
    // leaf name, append the already-qualified stable identifier so the user
    // can make an informed server-issued selection without inventing a new
    // identifier or relying on opaque position/order.
    const label = duplicate
      ? `${baseLabel} (${safeClarificationCandidateQualifier(candidate)})`
      : baseLabel;
    return {
      id: stableCandidateId(candidate),
      label,
      description: `Use ${label} as the ${ambiguity.requestedTerm} grouping.`,
      kind: candidate.kind === 'sql_column' ? 'sql_column' as const : 'semantic_dimension' as const,
    };
  });
  // Stable IDs are continuation authority, but labels must also be visually
  // unambiguous. A duplicate label would force the user back into prose and
  // defeat the typed selected-evidence binding on restart.
  if (new Set(options.map((option) => normalizeStableTerm(option.label))).size < 2) return undefined;
  return {
    role: ambiguity.role,
    requestedTerm: ambiguity.requestedTerm,
    question: `Which geographic field should I use for “${ambiguity.requestedTerm}”?`,
    options,
  };
}

type OrdinaryRoleRelationshipCoverageGapV1 = {
  role: EvidenceCandidateRoleV1;
  requestedTerm: string;
  candidateIds: string[];
};

/**
 * An ordinary fallback is never a license to infer a cross-entity join. If
 * retrieval found qualified geographic fields but every bridge from the
 * requested entity is denied, stale, unsafe, or incomplete, surface that
 * typed coverage gap before the planner sees an apparent choice. This keeps
 * a missing safe path distinct from a genuine choice between two safe fields.
 */
function ordinaryRoleRelationshipCoverageGap(input: {
  candidates: readonly AgentEvidenceCandidate[];
  requirements: AnalyticalRequirementSetV1;
  relationshipClosure: readonly AgentEvidenceCandidate[];
  relationshipClosureComplete: boolean;
  ordinaryRoleEntityContext: OrdinaryRoleEntityContextV1;
}): OrdinaryRoleRelationshipCoverageGapV1 | undefined {
  for (const slot of plannerAdmissionSlots(input.requirements)) {
    if (slot.role !== 'categorical_dimension') continue;
    const requestedTerm = slot.terms[0];
    if (!requestedTerm) continue;
    // A literal/declared field follows the normal verified cascade. This gate
    // is only for ordinary candidate-for-unresolved-role admission.
    if (input.candidates.some((candidate) =>
      candidateServesPlannerAdmissionSlot(candidate, slot)
      || candidateMatchesCategoricalDimensionRequirement(candidate, slot.terms))) continue;
    const ordinaryCandidates = input.candidates
      .filter((candidate) => !candidate.sameSnapshotRoleExtension
        && candidateCanResolveUnresolvedPlannerSlot(candidate, slot, input.ordinaryRoleEntityContext))
      .filter((candidate, index, values) =>
        values.findIndex((item) => stableCandidateId(item) === stableCandidateId(candidate)) === index);
    const crossEntityCandidates = ordinaryCandidates.filter((candidate) =>
      ordinaryRoleCandidateRequiresRelationship(candidate, input.ordinaryRoleEntityContext));
    if (crossEntityCandidates.length === 0) continue;
    // A same-entity field is already a safe ordinary candidate without a
    // bridge; likewise, one cross-entity candidate with a complete canonical
    // closure remains eligible for normal unique/ambiguity handling.
    if (ordinaryCandidates.some((candidate) => ordinaryRoleCandidateIsSafeAndReachable(
      candidate,
      input.relationshipClosure,
      input.ordinaryRoleEntityContext,
      input.relationshipClosureComplete,
    ))) continue;
    return {
      role: slot.role,
      requestedTerm,
      candidateIds: crossEntityCandidates
        .map(stableCandidateId)
        .sort()
        .slice(0, 8),
    };
  }
  return undefined;
}

function safeClarificationCandidateQualifier(candidate: AgentEvidenceCandidate): string {
  const stableId = stableCandidateId(candidate).trim();
  const terminal = stableId.split(/[:/]/).at(-1)?.trim();
  return terminal && terminal !== candidate.name ? terminal : stableId;
}

type MetricCapabilityDimensionV1 = NonNullable<AgentEvidenceCandidate['analyticalCapability']>['dimensions'][number];

/**
 * Canonical same-snapshot entity proof used by the ordinary fallback lane.
 * Textual retrieval identity is intentionally absent: `customer` in a name,
 * alias, ID, or source-object substring is not proof that a field belongs to
 * the bound customer entity.  We admit same-entity fallbacks only from exact
 * metric capability entity IDs, candidate primary entities, or structured
 * canonical relation references.
 */
type OrdinaryRoleEntityContextV1 = {
  hasRequestedEntity: boolean;
  /**
   * More than one metric identity could satisfy the requested measure and no
   * exact/structured choice selected one. An ordinary field may not bypass
   * the closure gate in that state merely because one relation leaf matches.
   */
  metricIdentityAmbiguous: boolean;
  requestedEntityIds: ReadonlySet<string>;
  requestedSourceRelations: ReadonlySet<string>;
  candidateEntityIds: ReadonlyMap<string, ReadonlySet<string>>;
  /** Exact authored display dimensions for the bound entity, never token overlap. */
  requestedEntityDisplayCandidateIds: ReadonlySet<string>;
  /** Canonical closure endpoints indexed by structured source relation. */
  endpointIdsBySourceRelation: ReadonlyMap<string, ReadonlySet<string>>;
};

function canonicalEntityIdentity(value: string | undefined): string | undefined {
  const normalized = normalizePlannerAdmissionText(value ?? '');
  return normalized || undefined;
}

function canonicalIdentifierLeaf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const namespaceLeaf = value.split(':').filter(Boolean).at(-1) ?? value;
  const objectLeaf = namespaceLeaf.split(/[./]/).filter(Boolean).at(-1) ?? namespaceLeaf;
  return canonicalEntityIdentity(objectLeaf);
}

function canonicalSourceRelationReference(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const match = /^(?:dbt|runtime|sql):(model|source|relation|table|column):(.+)$/i.exec(raw);
  if (!match) return undefined;
  const kind = match[1]!.toLowerCase();
  let relation = match[2]!.trim();
  if (kind === 'column') {
    const separator = relation.lastIndexOf('.');
    if (separator <= 0) return undefined;
    relation = relation.slice(0, separator);
  }
  // Preserve every source-authored namespace segment. A terminal relation is
  // not globally unique: `pkg_a.customer` and `pkg_b.customer` must never be
  // treated as the same relation merely because both end in `customer`.
  // Segments are normalized for comparison, while `::` keeps their structured
  // boundaries intact in the local receipt.
  const segments = relation.split('.').map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) return undefined;
  const normalized = segments.map((segment, index) => {
    const tokens = normalizedIdentityTokens(segment)
      .map((token) => index === segments.length - 1 ? singularIdentityToken(token) : token);
    return tokens.join(' ');
  }).filter(Boolean);
  return normalized.length === segments.length ? normalized.join('::') : undefined;
}

function canonicalSourceRelationLeaf(reference: string): string | undefined {
  const leaf = reference.split('::').at(-1)?.trim();
  return leaf || undefined;
}

function canonicalSourceRelationPhrase(reference: string): string {
  return normalizePlannerAdmissionText(reference.replaceAll('::', ' '));
}

function canonicalSourceRelationReferences(candidate: AgentEvidenceCandidate): Set<string> {
  const values = [
    ...(candidate.sourceObjects ?? []),
    ...(PHYSICAL_EXECUTION_KINDS.has(candidate.kind) ? [candidate.id, candidate.qualifiedId ?? ''] : []),
  ];
  return new Set(values
    .map(canonicalSourceRelationReference)
    .filter((value): value is string => Boolean(value)));
}

function intrinsicCanonicalEntityIds(candidate: AgentEvidenceCandidate): Set<string> {
  const ids = new Set<string>();
  const add = (value: string | undefined) => {
    const normalized = canonicalEntityIdentity(value);
    if (normalized) ids.add(normalized);
  };
  add(candidate.primaryEntity);
  for (const endpointId of candidate.relationshipEndpointIds ?? []) add(endpointId);
  if (candidate.semanticObjectType === 'entity') add(candidate.qualifiedId ?? candidate.id);
  return ids;
}

function candidateMatchesCapabilityDimensionExactly(
  candidate: AgentEvidenceCandidate,
  dimension: MetricCapabilityDimensionV1,
): boolean {
  const dimensionId = canonicalEntityIdentity(dimension.dimensionId);
  if (!dimensionId) return false;
  return [
    candidate.id,
    candidate.qualifiedId,
    ...(candidate.dimensions ?? []),
    candidate.sameSnapshotRoleExtension?.dimensionId,
  ].some((identity) => canonicalEntityIdentity(identity) === dimensionId);
}

function capabilityDimensionMatchesRequestedEntityTerm(
  dimension: MetricCapabilityDimensionV1,
  requestedTerms: ReadonlySet<string>,
): boolean {
  const identities = [
    canonicalIdentifierLeaf(dimension.dimensionId),
    canonicalEntityIdentity(dimension.label),
    ...(dimension.aliases ?? []).map(canonicalEntityIdentity),
  ].filter((identity): identity is string => Boolean(identity));
  return identities.some((identity) => requestedTerms.has(identity));
}

function capabilityDimensionMatchesRequestedEntityDisplayTerm(
  dimension: MetricCapabilityDimensionV1,
  requestedTerms: ReadonlySet<string>,
): boolean {
  const identities = [
    canonicalIdentifierLeaf(dimension.dimensionId),
    canonicalEntityIdentity(dimension.label),
    ...(dimension.aliases ?? []).map(canonicalEntityIdentity),
  ].filter((identity): identity is string => Boolean(identity));
  return identities.some((identity) => requestedTerms.has(identity));
}

function metricMatchesOrdinaryEntityRequirements(
  candidate: AgentEvidenceCandidate,
  requirements: AnalyticalRequirementSetV1,
): boolean {
  if (candidate.kind !== 'semantic_metric' || !candidate.analyticalCapability) return false;
  const metricTerms = requirements.ranking?.metricTerms.length
    ? requirements.ranking.metricTerms
    : requirements.measures;
  return metricTerms.some((term) => candidateMatchesPlannerRequirementTerm(candidate, term));
}

type OrdinaryMetricBindingSelectionV1 = {
  metrics: AgentEvidenceCandidate[];
  ambiguous: boolean;
};

/**
 * Choose the metric authority used only for the ordinary-role same-entity
 * proof. This does not choose an execution route. It prevents a retrieval
 * pool containing `billing.revenue` and `crm.revenue` from making both
 * customer entities look selected because they share the word "revenue".
 */
function ordinaryMetricBindingsForEntityContext(input: {
  candidates: readonly AgentEvidenceCandidate[];
  requirements: AnalyticalRequirementSetV1;
  selectedMetricBindings?: readonly AgentEvidenceCandidate[];
}): OrdinaryMetricBindingSelectionV1 {
  const matching = input.candidates.filter((candidate) =>
    metricMatchesOrdinaryEntityRequirements(candidate, input.requirements));
  const selected = uniqueCandidates((input.selectedMetricBindings ?? [])
    .filter((candidate) => candidate.kind === 'semantic_metric'
      && candidate.eligible !== false
      && candidate.compatibility !== 'incompatible'
      && metricMatchesOrdinaryEntityRequirements(candidate, input.requirements)));
  // A structured/canonical selection is explicit Ask authority. Multiple
  // selected metrics remain legal only if their capability mappings later
  // resolve to the same requested entity; that comparison happens below.
  if (selected.length > 0) {
    return { metrics: selected, ambiguous: false };
  }
  const exact = matching.filter((candidate) => candidate.exactMatch === true);
  if (exact.length === 1) return { metrics: exact, ambiguous: false };
  if (exact.length > 1) return { metrics: [], ambiguous: true };
  if (matching.length === 1) return { metrics: matching, ambiguous: false };
  return { metrics: [], ambiguous: matching.length > 1 };
}

function canonicalOrdinaryRoleEntityContext(input: {
  candidates: readonly AgentEvidenceCandidate[];
  requirements: AnalyticalRequirementSetV1;
  /** Only server-selected structured entity cards may add an entity outside a metric capability. */
  selectedStructuredEntityBindings?: readonly AgentEvidenceCandidate[];
  /** Explicit/canonical Ask metric selections may identify the bound metric. */
  selectedMetricBindings?: readonly AgentEvidenceCandidate[];
}): OrdinaryRoleEntityContextV1 {
  const requestedEntityTerms = input.requirements.entityTerms.length > 0
    ? input.requirements.entityTerms
    : input.requirements.entityDisplayTerms;
  if (requestedEntityTerms.length === 0) {
    return {
      hasRequestedEntity: false,
      metricIdentityAmbiguous: false,
      requestedEntityIds: new Set(),
      requestedSourceRelations: new Set(),
      candidateEntityIds: new Map(),
      requestedEntityDisplayCandidateIds: new Set(),
      endpointIdsBySourceRelation: new Map(),
    };
  }
  const normalizedRequestedTerms = new Set(requestedEntityTerms
    .map(canonicalEntityIdentity)
    .filter((term): term is string => Boolean(term)));
  const requestedRelationTerms = new Set([...normalizedRequestedTerms]
    .map((term) => normalizedIdentityTokens(term).map(singularIdentityToken).join(' '))
    .filter(Boolean));
  const candidateEntityIds = new Map<string, Set<string>>();
  const candidateSourceRelations = new Map<string, Set<string>>();
  const addCandidateEntityId = (candidate: AgentEvidenceCandidate, value: string | undefined): void => {
    const normalized = canonicalEntityIdentity(value);
    if (!normalized) return;
    const ids = candidateEntityIds.get(stableCandidateId(candidate)) ?? new Set<string>();
    ids.add(normalized);
    candidateEntityIds.set(stableCandidateId(candidate), ids);
  };
  for (const candidate of input.candidates) {
    for (const entityId of intrinsicCanonicalEntityIds(candidate)) addCandidateEntityId(candidate, entityId);
    candidateSourceRelations.set(stableCandidateId(candidate), canonicalSourceRelationReferences(candidate));
  }

  const sourceRelationsByLeaf = new Map<string, Set<string>>();
  const allSourceRelations = new Set<string>();
  for (const sourceRelations of candidateSourceRelations.values()) {
    for (const relation of sourceRelations) {
      allSourceRelations.add(relation);
      const leaf = canonicalSourceRelationLeaf(relation);
      if (!leaf) continue;
      const identities = sourceRelationsByLeaf.get(leaf) ?? new Set<string>();
      identities.add(relation);
      sourceRelationsByLeaf.set(leaf, identities);
    }
  }

  const metricBindingSelection = ordinaryMetricBindingsForEntityContext(input);
  const boundMetricCandidates = metricBindingSelection.metrics;
  const requestedEntityIds = new Set<string>();
  const metricBoundEntityIds = new Set<string>();
  for (const metric of boundMetricCandidates) {
    const matchedEntityIds = new Set<string>();
    for (const dimension of metric.analyticalCapability!.dimensions) {
      if (capabilityDimensionMatchesRequestedEntityTerm(dimension, normalizedRequestedTerms)) {
        const entityId = canonicalEntityIdentity(dimension.entityId);
        if (entityId) matchedEntityIds.add(entityId);
      }
      for (const candidate of input.candidates) {
        if (candidateMatchesCapabilityDimensionExactly(candidate, dimension)) {
          addCandidateEntityId(candidate, dimension.entityId);
        }
      }
    }
    // A metric capability is the authoritative entity binding, but two
    // capability children with the same human `customer` label are still
    // distinct entities (`billing.customer` vs `crm.customer`). Do not turn
    // that unresolved business ambiguity into two requested entities by leaf
    // text; an explicit structured entity selection is required instead.
    if (matchedEntityIds.size === 1) {
      metricBoundEntityIds.add([...matchedEntityIds][0]!);
    }
  }
  // Multiple explicitly selected metrics can share one business entity. That
  // remains a canonical same-entity fact. Different capability entities do
  // not: retain the ambiguity/closure gate instead of treating both as the
  // user's requested customer.
  const metricIdentityAmbiguous = metricBindingSelection.ambiguous || metricBoundEntityIds.size > 1;
  if (!metricIdentityAmbiguous && metricBoundEntityIds.size === 1) {
    requestedEntityIds.add([...metricBoundEntityIds][0]!);
  }

  // A server-issued structured entity card is also canonical authority. Do
  // not inspect arbitrary retrieved entity IDs, names, aliases, or leaves:
  // `billing.customer` and `crm.customer` are not interchangeable merely
  // because both expose the terminal text `customer`.
  for (const selected of input.selectedStructuredEntityBindings ?? []) {
    if (selected.semanticObjectType !== 'entity') continue;
    const entityId = canonicalEntityIdentity(selected.primaryEntity ?? selected.qualifiedId ?? selected.id);
    if (entityId) {
      requestedEntityIds.add(entityId);
    }
  }

  // An entity display key must be an exact authored capability dimension of
  // the already-bound entity. Do not use broad textual matching here: a field
  // like `customer_notes.location_name` has both words but is not the
  // customer's display key and must still pass the cross-entity closure gate.
  const normalizedRequestedDisplayTerms = new Set((input.requirements.entityDisplayTerms.length > 0
    ? input.requirements.entityDisplayTerms
    : input.requirements.entityTerms)
    .map(canonicalEntityIdentity)
    .filter((term): term is string => Boolean(term)));
  const requestedEntityDisplayCandidateIds = new Set<string>();
  for (const metric of boundMetricCandidates) {
    for (const dimension of metric.analyticalCapability!.dimensions) {
      const dimensionEntityId = canonicalEntityIdentity(dimension.entityId);
      if (!dimensionEntityId || !requestedEntityIds.has(dimensionEntityId)
        || !capabilityDimensionMatchesRequestedEntityDisplayTerm(dimension, normalizedRequestedDisplayTerms)) continue;
      for (const candidate of input.candidates) {
        if (candidateMatchesCapabilityDimensionExactly(candidate, dimension)) {
          requestedEntityDisplayCandidateIds.add(stableCandidateId(candidate));
        }
      }
    }
  }

  const requestedSourceRelations = new Set<string>();
  for (const requestedRelationTerm of requestedRelationTerms) {
    const fullMatches = [...allSourceRelations]
      .filter((relation) => canonicalSourceRelationPhrase(relation) === requestedRelationTerm);
    if (fullMatches.length === 1) {
      requestedSourceRelations.add(fullMatches[0]!);
      continue;
    }
    // A user/business term has only a relation leaf. It may identify that
    // leaf only when the same immutable snapshot proves there is one full
    // structured relation with it. Namespace collisions intentionally remain
    // unresolved and therefore require a safe closure or a clarification.
    const leafMatches = sourceRelationsByLeaf.get(requestedRelationTerm);
    if (leafMatches?.size === 1) requestedSourceRelations.add([...leafMatches][0]!);
  }
  for (const candidate of input.candidates) {
    const sourceRelations = candidateSourceRelations.get(stableCandidateId(candidate)) ?? new Set<string>();
    const entityIds = candidateEntityIds.get(stableCandidateId(candidate)) ?? new Set<string>();
    if ([...entityIds].some((entityId) => requestedEntityIds.has(entityId))) {
      for (const relation of sourceRelations) requestedSourceRelations.add(relation);
    }
  }

  // A physical field may not carry a semantic primaryEntity. If a structured
  // source relation is already mapped by another same-snapshot field/model to
  // a canonical entity, inherit only that exact relation mapping—not words.
  const entityIdsBySourceRelation = new Map<string, Set<string>>();
  for (const candidate of input.candidates) {
    const entityIds = candidateEntityIds.get(stableCandidateId(candidate)) ?? new Set<string>();
    if (entityIds.size === 0) continue;
    for (const relation of candidateSourceRelations.get(stableCandidateId(candidate)) ?? []) {
      const mapped = entityIdsBySourceRelation.get(relation) ?? new Set<string>();
      for (const entityId of entityIds) mapped.add(entityId);
      entityIdsBySourceRelation.set(relation, mapped);
    }
  }
  for (const candidate of input.candidates) {
    for (const relation of candidateSourceRelations.get(stableCandidateId(candidate)) ?? []) {
      for (const entityId of entityIdsBySourceRelation.get(relation) ?? []) {
        addCandidateEntityId(candidate, entityId);
      }
    }
  }
  // Physical-only Ask snapshots do not always retain a semantic entity ID.
  // Relationship proof endpoints still carry a structured runtime/dbt relation
  // identity, so index those exact endpoints by relation. This preserves a
  // canonical customer-table -> order-table -> location-table closure without
  // falling back to candidate-name or alias token matching.
  const endpointIdsBySourceRelation = new Map<string, Set<string>>();
  for (const relationship of input.candidates) {
    const proof = relationshipCandidateProofSelection(relationship);
    if (!proof) continue;
    for (const safety of proof.relationshipSafety) {
      for (const endpoint of [safety.from, safety.to]) {
        const relation = canonicalSourceRelationReference(endpoint);
        const endpointId = canonicalEntityIdentity(endpoint);
        if (!relation || !endpointId) continue;
        const endpointIds = endpointIdsBySourceRelation.get(relation) ?? new Set<string>();
        endpointIds.add(endpointId);
        endpointIdsBySourceRelation.set(relation, endpointIds);
      }
    }
  }
  return {
    hasRequestedEntity: true,
    metricIdentityAmbiguous,
    requestedEntityIds,
    requestedSourceRelations,
    candidateEntityIds,
    requestedEntityDisplayCandidateIds,
    endpointIdsBySourceRelation,
  };
}

function ordinaryRoleCandidateRequiresRelationship(
  candidate: AgentEvidenceCandidate,
  context: OrdinaryRoleEntityContextV1,
): boolean {
  // No requested/bound entity means there is no cross-entity predicate to
  // prove at this admission boundary. The later compiler still owns any join
  // required by a selected metric or program.
  if (!context.hasRequestedEntity) return false;
  // A lexical measure match is not a metric binding. Until a single exact or
  // structured metric identity wins, a field cannot claim same-entity merely
  // from its own source relation; the later planner/compiler may resolve a
  // safe full closure, but ordinary inference must not collapse it here.
  if (context.metricIdentityAmbiguous) return true;
  const candidateEntityIds = context.candidateEntityIds.get(stableCandidateId(candidate)) ?? new Set<string>();
  if ([...candidateEntityIds].some((entityId) => context.requestedEntityIds.has(entityId))) return false;
  const candidateSourceRelations = canonicalSourceRelationReferences(candidate);
  if ([...candidateSourceRelations].some((relation) => context.requestedSourceRelations.has(relation))) return false;
  // Unknown canonical identity is cross-entity by default. A raw token such
  // as `customer` in `customer_notes`, an alias, or a source substring is not
  // enough to elide the canonical closure requirement.
  return true;
}

function ordinaryRoleClosureConnectsCandidate(
  candidate: AgentEvidenceCandidate,
  closure: readonly AgentEvidenceCandidate[],
  context: OrdinaryRoleEntityContextV1,
): boolean {
  if (!context.hasRequestedEntity || closure.length === 0) return false;
  const starts = new Set(context.requestedEntityIds);
  for (const relation of context.requestedSourceRelations) {
    for (const endpointId of context.endpointIdsBySourceRelation.get(relation) ?? []) starts.add(endpointId);
  }
  const targets = new Set(context.candidateEntityIds.get(stableCandidateId(candidate)) ?? []);
  for (const relation of canonicalSourceRelationReferences(candidate)) {
    for (const endpointId of context.endpointIdsBySourceRelation.get(relation) ?? []) targets.add(endpointId);
  }
  if (starts.size === 0 || targets.size === 0) return false;
  const graph = new Map<string, Set<string>>();
  const connect = (from: string, to: string): void => {
    const fromNeighbors = graph.get(from) ?? new Set<string>();
    fromNeighbors.add(to);
    graph.set(from, fromNeighbors);
    const toNeighbors = graph.get(to) ?? new Set<string>();
    toNeighbors.add(from);
    graph.set(to, toNeighbors);
  };
  for (const relationship of closure) {
    // `boundedRelationshipClosure` already applied this canonical proof gate.
    // Keep the defensive check here so a future caller cannot turn a raw
    // relationship card into ordinary-role admission evidence.
    if (relationshipCandidateHasUnsafeFanout(relationship)) return false;
    const proof = relationshipCandidateProofSelection(relationship);
    if (!proof?.relationshipSafety.length) return false;
    for (const safety of proof.relationshipSafety) {
      const from = normalizePlannerAdmissionText(safety.from ?? '');
      const to = normalizePlannerAdmissionText(safety.to ?? '');
      if (!from || !to) return false;
      connect(from, to);
    }
  }
  const pending = [...starts];
  const visited = new Set(pending);
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (targets.has(current)) return true;
    for (const next of graph.get(current) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        pending.push(next);
      }
    }
  }
  return false;
}

/**
 * A role-reserved fallback can be offered only when it was already qualified
 * and either belongs to the requested entity itself or is connected to that
 * entity by a complete, canonical same-snapshot closure. An empty closure is
 * therefore safe only for same-entity requests; it is not proof that a
 * cross-entity relation was unnecessary. This is admission evidence, not a
 * join authorization: compiler/cascade safety still owns execution after a
 * choice.
 */
function ordinaryRoleCandidateIsSafeAndReachable(
  candidate: AgentEvidenceCandidate,
  closure: readonly AgentEvidenceCandidate[],
  context: OrdinaryRoleEntityContextV1,
  relationshipClosureComplete: boolean,
): boolean {
  if (candidate.eligible === false || candidate.compatibility === 'incompatible') return false;
  if (!evidenceCandidateRoles(candidate).includes('categorical_dimension')) return false;
  if (!ordinaryRoleCandidateRequiresRelationship(candidate, context)) return true;
  if (!relationshipClosureComplete) return false;
  return ordinaryRoleClosureConnectsCandidate(candidate, closure, context);
}

type PlannerAdmissionSlotV1 = {
  role: EvidenceCandidateRoleV1;
  terms: string[];
};

type UnresolvedRoleAdmissionV1 = {
  role: EvidenceCandidateRoleV1;
  term: string;
};

function unresolvedRoleAdmissionMarker(input: UnresolvedRoleAdmissionV1): string {
  const term = normalizePlannerAdmissionText(input.term) || 'unspecified';
  return `${UNRESOLVED_ROLE_ADMISSION_PREFIX}:${input.role}:${term}`;
}

/**
 * A host-owned receipt for the one safe ordinary fallback that remained after
 * the role-balanced package was assembled.  It is deliberately distinct from
 * the admission marker above: the latter means "show alternatives to the
 * planner", while this one means "the package contained exactly one safe
 * candidate for this role".  It is still an inferred business mapping and is
 * therefore review-required after verification; it is not a metadata alias.
 */
function uniqueInferredRoleSubstitutionMarker(input: UnresolvedRoleAdmissionV1): string {
  const term = normalizePlannerAdmissionText(input.term) || 'unspecified';
  return `${UNIQUE_INFERRED_ROLE_SUBSTITUTION_PREFIX}:${input.role}:${term}`;
}

/**
 * The marker is deliberately a compact, host-owned admission receipt rather
 * than a candidate alias. It may travel to the planner card, but no consumer
 * may treat it as a semantic equivalence without the verifier below proving a
 * unique selected substitution.
 */
function candidateUnresolvedRoleAdmissions(candidate: Pick<AgentEvidenceCandidate, 'matchReasons'>): UnresolvedRoleAdmissionV1[] {
  const prefix = `${UNRESOLVED_ROLE_ADMISSION_PREFIX}:`;
  return (candidate.matchReasons ?? []).flatMap((reason) => {
    if (!reason.startsWith(prefix)) return [];
    const [, role, ...termParts] = reason.split(':');
    const term = termParts.join(':').trim();
    return isEvidenceCandidateRole(role) && term
      ? [{ role, term }]
      : [];
  });
}

function candidateUniqueInferredRoleSubstitutions(
  candidate: Pick<AgentEvidenceCandidate, 'matchReasons'>,
): UnresolvedRoleAdmissionV1[] {
  const prefix = `${UNIQUE_INFERRED_ROLE_SUBSTITUTION_PREFIX}:`;
  return (candidate.matchReasons ?? []).flatMap((reason) => {
    if (!reason.startsWith(prefix)) return [];
    const [, role, ...termParts] = reason.split(':');
    const term = termParts.join(':').trim();
    return isEvidenceCandidateRole(role) && term
      ? [{ role, term }]
      : [];
  });
}

function candidateHasUnresolvedRoleAdmission(
  candidate: Pick<AgentEvidenceCandidate, 'matchReasons'>,
  slot: PlannerAdmissionSlotV1,
): boolean {
  const expectedTerms = new Set(slot.terms.map(normalizePlannerAdmissionText).filter(Boolean));
  return candidateUnresolvedRoleAdmissions(candidate).some((admission) =>
    admission.role === slot.role
    && (expectedTerms.size === 0 || expectedTerms.has(normalizePlannerAdmissionText(admission.term))));
}

function candidateHasUniqueInferredRoleSubstitution(
  candidate: Pick<AgentEvidenceCandidate, 'matchReasons'>,
  slot: PlannerAdmissionSlotV1,
): boolean {
  const expectedTerms = new Set(slot.terms.map(normalizePlannerAdmissionText).filter(Boolean));
  return candidateUniqueInferredRoleSubstitutions(candidate).some((substitution) =>
    substitution.role === slot.role
    && (expectedTerms.size === 0 || expectedTerms.has(normalizePlannerAdmissionText(substitution.term))));
}

function markCandidateForUnresolvedRoleAdmission(
  candidate: AgentEvidenceCandidate,
  slot: PlannerAdmissionSlotV1,
): AgentEvidenceCandidate {
  const markers = slot.terms.length
    ? slot.terms.map((term) => unresolvedRoleAdmissionMarker({ role: slot.role, term }))
    : [unresolvedRoleAdmissionMarker({ role: slot.role, term: 'unspecified' })];
  return {
    ...candidate,
    matchReasons: uniqueStrings([...candidate.matchReasons, ...markers]),
  };
}

function markCandidateForUniqueInferredRoleSubstitution(
  candidate: AgentEvidenceCandidate,
  slot: PlannerAdmissionSlotV1,
): AgentEvidenceCandidate {
  const markers = slot.terms.length
    ? slot.terms.map((term) => uniqueInferredRoleSubstitutionMarker({ role: slot.role, term }))
    : [uniqueInferredRoleSubstitutionMarker({ role: slot.role, term: 'unspecified' })];
  return {
    ...candidate,
    matchReasons: uniqueStrings([...candidate.matchReasons, ...markers]),
  };
}

/**
 * A role-compatible candidate can be shown to the planner when the snapshot
 * does not have a literal/declared match for the user's business term. This
 * is intentionally weaker than `candidateServesPlannerAdmissionSlot`: it
 * only reserves a qualified field for interpretation, it never supplies a
 * hidden synonym. In particular semantic models/entities cannot impersonate
 * categorical fields just because older indexes use `semantic_member` for
 * several object classes.
 */
function candidateCanResolveUnresolvedPlannerSlot(
  candidate: AgentEvidenceCandidate,
  slot: PlannerAdmissionSlotV1,
  ordinaryRoleEntityContext?: OrdinaryRoleEntityContextV1,
): boolean {
  if (!stableCandidateId(candidate).trim()
    || candidate.eligible === false
    || candidate.compatibility === 'incompatible'
    || !evidenceCandidateRoles(candidate).includes(slot.role)) return false;
  if (slot.role !== 'categorical_dimension') return true;
  // A selected entity display key is commonly represented as a semantic
  // dimension too (`customer_name`). Keep it out of an unrelated ordinary
  // breakdown only when the metric capability proves it is the exact display
  // field of the bound entity. A coincidental `customer` and `name` token in
  // an arbitrary field is not display-key proof and must remain subject to
  // the canonical cross-entity closure gate.
  if (ordinaryRoleEntityContext?.requestedEntityDisplayCandidateIds.has(stableCandidateId(candidate))
    && !candidateServesPlannerAdmissionSlot(candidate, slot)) return false;
  return candidate.semanticObjectType === 'dimension'
    || (candidate.kind === 'semantic_member' && candidate.semanticObjectType === undefined)
    || candidate.kind === 'sql_column';
}

function candidateTermOverlapScore(candidate: AgentEvidenceCandidate, terms: readonly string[]): number {
  const identity = candidateIdentityTerms(candidate);
  return terms.reduce((score, term) => {
    const tokens = normalizePlannerAdmissionText(term).split(' ').filter((token) => token.length > 2);
    return score + tokens.filter((token) => identity.includes(token)).length;
  }, 0);
}

function candidateRetrievalPriority(candidate: AgentEvidenceCandidate): number {
  const lanePriority: Record<NonNullable<AgentEvidenceCandidate['retrievalLanes']>[number]['lane'], number> = {
    exact: 5,
    lexical: 4,
    vector: 3,
    graph: 2,
    conversation: 1,
  };
  return Math.max(0, ...(candidate.retrievalLanes ?? []).map((lane) =>
    lanePriority[lane.lane] * 1_000 - Math.min(999, lane.rank ?? 999)));
}

/**
 * Reachability is a tie-breaker only. It keeps an ordinary qualified
 * `locations.location_name` field ahead of unrelated dimensions when the
 * existing bounded customer-to-location proof already reaches it; it neither
 * mints a relationship nor authorizes a join.
 */
function candidateRelationshipReachabilityScore(
  candidate: AgentEvidenceCandidate,
  closure: readonly AgentEvidenceCandidate[],
): number {
  const identity = candidateIdentityTerms(candidate);
  const endpoints = closure.flatMap((relationship) => [
    ...(relationship.relationshipEndpointIds ?? []),
    ...(relationshipCandidateProofSelection(relationship)?.relationshipSafety ?? [])
      .flatMap((safety) => [safety.from ?? '', safety.to ?? '']),
  ]).map(normalizePlannerAdmissionText).filter(Boolean);
  return endpoints.reduce((score, endpoint) => {
    const tokens = endpoint.split(' ').filter((token) => token.length > 2);
    return score + (tokens.some((token) => identity.includes(token)) ? 1 : 0);
  }, 0);
}

function compareUnresolvedRoleAdmissionCandidates(
  slot: PlannerAdmissionSlotV1,
  closure: readonly AgentEvidenceCandidate[],
): (left: AgentEvidenceCandidate, right: AgentEvidenceCandidate) => number {
  const exactOrDeclared = (candidate: AgentEvidenceCandidate): number => {
    if (candidateServesPlannerAdmissionSlot(candidate, slot)) return 2;
    if (slot.role === 'categorical_dimension'
      && candidateMatchesCategoricalDimensionRequirement(candidate, slot.terms)) return 1;
    return 0;
  };
  return (left, right) => exactOrDeclared(right) - exactOrDeclared(left)
    || candidateTermOverlapScore(right, slot.terms) - candidateTermOverlapScore(left, slot.terms)
    || candidateRetrievalPriority(right) - candidateRetrievalPriority(left)
    || candidateRelationshipReachabilityScore(right, closure) - candidateRelationshipReachabilityScore(left, closure)
    || right.relevanceScore - left.relevanceScore
    || stableCandidateId(left).localeCompare(stableCandidateId(right));
}

/**
 * Express each explicit business term as an admission slot. `region` and
 * `product category` are both categorical dimensions, but they must not
 * compete for one generic categorical role reservation.
 */
function plannerAdmissionSlots(requirements: AnalyticalRequirementSetV1): PlannerAdmissionSlotV1[] {
  const slots: PlannerAdmissionSlotV1[] = [];
  const addTerms = (role: EvidenceCandidateRoleV1, terms: readonly string[]) => {
    for (const term of [...new Set(terms.map((value) => value.trim()).filter(Boolean))]) {
      slots.push({ role, terms: [term] });
    }
  };
  addTerms('metric', requirements.ranking?.metricTerms.length
    ? requirements.ranking.metricTerms
    : requirements.measures);
  addTerms('entity_key', requirements.entityTerms);
  addTerms('entity_label', requirements.entityDisplayTerms.length
    ? requirements.entityDisplayTerms
    : requirements.entityTerms);
  addTerms('categorical_dimension', categoricalTermsForRuntime(requirements));
  if (requirements.time) slots.push({ role: 'time_dimension', terms: [] });
  if (requirements.memberTerms.length && !requirements.priorResultMemberBinding) addTerms('member', requirements.memberTerms);
  if (requirements.dimensions.length > 1 || requirements.entityTerms.length > 0) {
    slots.push({ role: 'relationship', terms: [] });
  }
  return slots;
}

function candidateServesPlannerAdmissionSlot(
  candidate: AgentEvidenceCandidate,
  slot: PlannerAdmissionSlotV1,
): boolean {
  if (!evidenceCandidateRoles(candidate).includes(slot.role)) return false;
  if (slot.role === 'relationship' || slot.role === 'time_dimension') return true;
  return slot.terms.some((term) => candidateMatchesPlannerRequirementTerm(candidate, term));
}

/**
 * Keep planner admission role-balanced even after protected exact identities
 * and an atomic relationship-path card are inserted. This is intentionally a
 * projection of the immutable workspace, not a second retrieval or route.
 */
function admitRoleBalancedPlannerCandidates(input: {
  exactPins: AgentEvidenceCandidate[];
  relationshipPath?: AgentEvidenceCandidate;
  rawRelationshipClosure: AgentEvidenceCandidate[];
  relationshipClosureComplete: boolean;
  ordinaryRoleEntityContext: OrdinaryRoleEntityContextV1;
  roleBalancedCandidates: AgentEvidenceCandidate[];
  workspaceCandidates: AgentEvidenceCandidate[];
  requirements: AnalyticalRequirementSetV1;
  /** A server-issued categorical choice suppresses only its competing fallback cards. */
  structuredSelectedEvidenceId?: string;
}): AgentEvidenceCandidate[] {
  const selected: AgentEvidenceCandidate[] = [];
  const add = (candidate: AgentEvidenceCandidate | undefined): void => {
    if (!candidate) return;
    const existingIndex = selected.findIndex((item) => stableCandidateId(item) === stableCandidateId(candidate));
    if (existingIndex >= 0) {
      // The role-reservation receipt is host-owned admission context. A
      // later relevance-fill pass reuses the original snapshot card, but it
      // must not erase that receipt and make the planner/trace claim the
      // raw field was a declared business alias.
      if (candidateUnresolvedRoleAdmissions(selected[existingIndex]!).length > 0
        && candidateUnresolvedRoleAdmissions(candidate).length === 0) return;
      selected[existingIndex] = candidate;
      return;
    }
    if (selected.length >= MAX_INITIAL_PLANNER_CANDIDATES) return;
    selected.push(candidate);
  };
  for (const candidate of input.exactPins) add(candidate);
  if (input.relationshipPath) add(input.relationshipPath);
  else for (const candidate of input.rawRelationshipClosure) add(candidate);

  const closureIds = new Set(input.rawRelationshipClosure.map(stableCandidateId));
  const plannerCandidates = uniqueCandidates([
    ...input.roleBalancedCandidates,
    ...input.workspaceCandidates,
  ]).filter((candidate) => !input.relationshipPath || !closureIds.has(stableCandidateId(candidate)));
  const candidateCanBeReservedForSlot = (
    candidate: AgentEvidenceCandidate,
    slot: PlannerAdmissionSlotV1,
  ): boolean => candidateCanResolveUnresolvedPlannerSlot(candidate, slot, input.ordinaryRoleEntityContext)
    && (slot.role !== 'categorical_dimension'
      || ordinaryRoleCandidateIsSafeAndReachable(
        candidate,
        input.rawRelationshipClosure,
        input.ordinaryRoleEntityContext,
        input.relationshipClosureComplete,
      ));
  // A final relevance fill must not reintroduce a qualified field that the
  // role reservation deliberately rejected for lack of a complete safe
  // cross-entity closure. It may remain execution-context evidence, but it
  // is neither a planner choice nor an inferred business mapping.
  const unsafeOrdinaryFallbackIds = new Set(plannerCandidates
    .filter((candidate) => !plannerAdmissionSlots(input.requirements).some((slot) =>
      candidateServesPlannerAdmissionSlot(candidate, slot)
      || candidateMatchesCategoricalDimensionRequirement(candidate, slot.terms)))
    .filter((candidate) => plannerAdmissionSlots(input.requirements).some((slot) =>
      slot.role === 'categorical_dimension'
      && candidateCanResolveUnresolvedPlannerSlot(candidate, slot, input.ordinaryRoleEntityContext)
      && !ordinaryRoleCandidateIsSafeAndReachable(
        candidate,
        input.rawRelationshipClosure,
        input.ordinaryRoleEntityContext,
        input.relationshipClosureComplete,
      )))
    .map(stableCandidateId));
  const suppressedByStructuredSelection = new Set<string>();
  for (const slot of plannerAdmissionSlots(input.requirements)) {
    if (selected.some((candidate) => candidateServesPlannerAdmissionSlot(candidate, slot))) continue;
    const selectedContinuationCandidate = input.structuredSelectedEvidenceId
      ? plannerCandidates.find((candidate) =>
          candidateMatchesStableIdentity(candidate, input.structuredSelectedEvidenceId!)
          && candidateCanBeReservedForSlot(candidate, slot)
          && !candidateServesPlannerAdmissionSlot(candidate, slot))
      : undefined;
    if (selectedContinuationCandidate) {
      add(markCandidateForUnresolvedRoleAdmission(selectedContinuationCandidate, slot));
      for (const candidate of plannerCandidates) {
        if (stableCandidateId(candidate) !== stableCandidateId(selectedContinuationCandidate)
          && candidateCanBeReservedForSlot(candidate, slot)
          && !candidateServesPlannerAdmissionSlot(candidate, slot)) {
          suppressedByStructuredSelection.add(stableCandidateId(candidate));
        }
      }
      continue;
    }
    // A literal or snapshot-declared term match remains the primary path.
    // When that has no qualified card, reserve up to two *role-compatible*
    // fields for the planner. The marker makes their uncertainty explicit;
    // it does not turn a physical location field into a `region` alias.
    const unresolved = plannerCandidates
      .filter((candidate) => candidateCanBeReservedForSlot(candidate, slot))
      .sort(compareUnresolvedRoleAdmissionCandidates(slot, input.rawRelationshipClosure))
      .slice(0, 2);
    for (const candidate of unresolved) {
      add(markCandidateForUnresolvedRoleAdmission(candidate, slot));
    }
  }
  for (const candidate of plannerCandidates) {
    if (!suppressedByStructuredSelection.has(stableCandidateId(candidate))
      && !unsafeOrdinaryFallbackIds.has(stableCandidateId(candidate))) add(candidate);
  }
  return selected;
}

function roleCoverageForAdmittedCandidates(
  requirements: AnalyticalRequirementSetV1,
  admitted: AgentEvidenceCandidate[],
): NonNullable<EvidenceWorkspaceV2['roleCoverage']> {
  const grouped = new Map<EvidenceCandidateRoleV1, PlannerAdmissionSlotV1[]>();
  for (const slot of plannerAdmissionSlots(requirements)) {
    const existing = grouped.get(slot.role) ?? [];
    existing.push(slot);
    grouped.set(slot.role, existing);
  }
  return [...grouped.entries()]
    .map(([role, slots]) => {
      const provenCount = admitted.filter((candidate) =>
        slots.some((slot) => candidateServesPlannerAdmissionSlot(candidate, slot))).length;
      const inferredCount = admitted.filter((candidate) =>
        slots.some((slot) => candidateHasUniqueInferredRoleSubstitution(candidate, slot))).length;
      const alternativeCount = admitted.filter((candidate) =>
        slots.some((slot) => candidateHasUnresolvedRoleAdmission(candidate, slot))
          && !slots.some((slot) => candidateHasUniqueInferredRoleSubstitution(candidate, slot))).length;
      return {
        role,
        candidateCount: provenCount + inferredCount + alternativeCount,
        // A candidate-for-unresolved-role receipt explicitly records an
        // alternative, not a fact that the user’s business term was modeled.
        // A sole candidate is different: it remains an inferred mapping, but
        // it is an executable choice for the planner and must not be reported
        // as unresolved alternatives in the trace.
        state: provenCount === 0 && inferredCount === 0 && alternativeCount > 0
          ? 'alternatives' as const
          : 'proven' as const,
      };
    })
    .sort((left, right) => left.role.localeCompare(right.role));
}

/**
 * Clarification alternatives may intentionally live in the qualified
 * workspace rather than the capped planner package.  Record their real count
 * in the persisted receipt so a role-cap exclusion is never misreported as
 * one inferred/executable field or a metadata absence.
 */
function roleCoverageWithOrdinaryInferenceAmbiguity(
  coverage: EvidenceWorkspaceV2['roleCoverage'] | undefined,
  ambiguity: OrdinaryRoleInferenceAmbiguityV1,
): NonNullable<EvidenceWorkspaceV2['roleCoverage']> {
  const retained = (coverage ?? []).filter((item) => item.role !== ambiguity.role);
  return [
    ...retained,
    {
      role: ambiguity.role,
      candidateCount: ambiguity.options.length,
      state: 'alternatives' as const,
    },
  ].sort((left, right) => left.role.localeCompare(right.role));
}

function candidateSupportsRequiredRole(candidate: AgentEvidenceCandidate, requirements: AnalyticalRequirementSetV1): boolean {
  const identity = candidateIdentityTerms(candidate);
  const matches = (terms: readonly string[]) => terms.some((term) => {
    const normalized = term.toLowerCase().replace(/[_./:-]+/g, ' ').trim();
    return normalized.length > 0 && (identity.includes(normalized) || normalized.includes(identity));
  });
  const roles = evidenceCandidateRoles(candidate);
  return (roles.includes('metric') && matches(requirements.ranking?.metricTerms.length ? requirements.ranking.metricTerms : requirements.measures))
    || (roles.includes('entity_key') && matches(requirements.entityTerms))
    || (roles.includes('entity_label') && matches([...requirements.entityTerms, ...requirements.entityDisplayTerms]))
    || (roles.includes('categorical_dimension') && matches(categoricalTermsForRuntime(requirements)))
    || (roles.includes('time_dimension') && Boolean(requirements.time))
    || (roles.includes('member') && matches(requirements.memberTerms))
    || (roles.includes('relationship') && (requirements.dimensions.length > 1 || requirements.entityTerms.length > 0));
}

/**
 * Preserve a small target-scoped physical closure in the 32-card workspace.
 * It never selects a business meaning or authorizes a join; it only prevents
 * `customers` from being the sole exploratory relation when the same snapshot
 * already contains `orders`, `order_items`, and `products` required to test a
 * customer/product revenue question.
 */
function withExecutionSupportCandidates(input: {
  workspace: AgentEvidenceCandidate[];
  snapshotCandidates: AgentEvidenceCandidate[];
  requirements: AnalyticalRequirementSetV1;
  relationshipClosure?: AgentEvidenceCandidate[];
}): AgentEvidenceCandidate[] {
  // A capability-proven inferred role may use a different physical label
  // (`location_name` for the requested `region`). Its model/entity remains
  // compiler-only context, but must survive the 32-card workspace cap so the
  // frozen semantic/relational compiler can validate the complete path.
  const inferredRoleSupportTerms = input.workspace
    .filter((candidate) => Boolean(candidate.sameSnapshotRoleExtension)
      || candidateUniqueInferredRoleSubstitutions(candidate).length > 0)
    .flatMap((candidate) => [
      candidate.id,
      candidate.qualifiedId,
      candidate.name,
      ...(candidate.aliases ?? []),
      ...(candidate.sourceObjects ?? []),
      candidate.sameSnapshotRoleExtension?.dimensionId,
      candidate.sameSnapshotRoleExtension?.metricId,
    ])
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => normalizePlannerAdmissionText(value).split(' '))
    .filter((value) => value.length > 2);
  const terms = uniqueStrings([
    ...requirementIdentityTerms(input.requirements),
    ...inferredRoleSupportTerms,
  ]);
  const support = input.snapshotCandidates
    .filter((candidate) => PHYSICAL_EXECUTION_KINDS.has(candidate.kind)
      && candidate.eligible !== false
      && candidate.compatibility !== 'incompatible')
    .filter((candidate) => {
      const identity = candidateIdentityTerms(candidate);
      return terms.some((term) => identity.includes(term));
    })
    .sort((left, right) => Number(Boolean(right.exactMatch)) - Number(Boolean(left.exactMatch))
      || right.relevanceScore - left.relevanceScore
      || stableCandidateId(left).localeCompare(stableCandidateId(right)))
    .slice(0, 8);
  // Relationship cards are evidence, not join authority.  Keep only the
  // smallest proven closure (<=3 paths / <=4 key edges), and discard explicit
  // unsafe fanout before it reaches a planner or compiler.  The compiler still
  // performs final cardinality/authorization validation at freeze time.
  const requiresRelationshipClosure = input.requirements.dimensions.length > 1
    || input.requirements.entityTerms.length > 0;
  const relationshipClosure = requiresRelationshipClosure
    ? input.relationshipClosure ?? boundedRelationshipClosure(
      input.snapshotCandidates,
      targetRelationshipPathIds(input.snapshotCandidates, input.requirements),
    )
    : [];
  const permittedRelationshipIds = new Set(relationshipClosure.map(stableCandidateId));
  const retainRelationship = (candidate: AgentEvidenceCandidate) => !requiresRelationshipClosure
    || !isRelationshipClosureCandidate(candidate)
    || permittedRelationshipIds.has(stableCandidateId(candidate));
  const critical = input.workspace
    .filter(retainRelationship)
    .filter((candidate) => candidate.exactMatch || candidateSupportsRequiredRole(candidate, input.requirements));
  const ordered = [...critical, ...relationshipClosure, ...support.filter(retainRelationship), ...input.workspace.filter(retainRelationship)];
  return uniqueCandidates(ordered).slice(0, 32);
}

function isRelationshipClosureCandidate(candidate: AgentEvidenceCandidate): boolean {
  return evidenceCandidateRoles(candidate).includes('relationship')
    && (candidate.relationshipEvidence?.length ?? 0) > 0;
}

function relationshipCandidatePathIds(candidate: AgentEvidenceCandidate): string[] {
  return relationshipCandidateProofSelection(candidate)?.relationshipEvidence ?? [];
}

function relationshipCandidateEdgeCount(candidate: AgentEvidenceCandidate): number {
  const provedEdges = (relationshipCandidateProofSelection(candidate)?.relationshipSafety ?? [])
    .reduce((count, safety) => count + Math.max(1, safety.keys.length), 0);
  return Math.max(1, provedEdges || relationshipCandidatePathIds(candidate).length);
}

function relationshipCandidateHasUnsafeFanout(candidate: AgentEvidenceCandidate): boolean {
  return (candidate.relationshipSafety ?? []).some((safety) => /unsafe|unbounded|many[ _-]*to[ _-]*many/i.test(safety.fanout ?? ''));
}

function relationshipCandidateProofSelection(candidate: AgentEvidenceCandidate) {
  return relationshipSafetyProofSelectionForCandidateV1(candidate);
}

function relationshipCandidateProofClass(candidate: AgentEvidenceCandidate): 'governed' | 'exploratory' | undefined {
  return relationshipCandidateProofSelection(candidate)?.proofClass;
}

function relationshipCandidateSupportsPathId(candidate: AgentEvidenceCandidate, pathId: string): boolean {
  const normalizedPathId = normalizePlannerAdmissionText(pathId);
  if (!normalizedPathId) return false;
  const selection = relationshipCandidateProofSelection(candidate);
  if (!selection) return false;
  return (candidate.relationshipEvidence ?? []).some((evidenceId) =>
    normalizePlannerAdmissionText(evidenceId) === normalizedPathId)
    || selection.relationshipEvidence.some((evidenceId) =>
      normalizePlannerAdmissionText(evidenceId) === normalizedPathId);
}

function relationshipCandidateEndpointPairs(candidate: AgentEvidenceCandidate): Array<readonly [string, string]> {
  return (relationshipCandidateProofSelection(candidate)?.relationshipSafety ?? [])
    .map((safety) => [
      normalizePlannerAdmissionText(safety.from ?? ''),
      normalizePlannerAdmissionText(safety.to ?? ''),
    ] as const)
    .filter(([from, to]) => Boolean(from && to));
}

function relationshipPathCardinality(candidates: AgentEvidenceCandidate[]): {
  pathCount: number;
  edgeCount: number;
} {
  return {
    pathCount: new Set(candidates.flatMap(relationshipCandidatePathIds)).size,
    edgeCount: candidates.reduce((total, candidate) => total + relationshipCandidateEdgeCount(candidate), 0),
  };
}

/**
 * Find the smallest same-snapshot connector from a metric primary entity to a
 * requested cross-entity output. Existing closure cards are zero-cost
 * traversal; only newly added cards count against the bounded closure. If the
 * endpoint graph is incomplete, return no bridge and leave the compiler to
 * reject the incomplete path rather than inferring a relationship from names.
 */
function safeRelationshipBridgeCandidates(input: {
  selected: AgentEvidenceCandidate[];
  ordered: AgentEvidenceCandidate[];
  primaryEntityId: string;
  targetEntityId: string;
}): AgentEvidenceCandidate[] | undefined {
  const start = normalizePlannerAdmissionText(input.primaryEntityId);
  const target = normalizePlannerAdmissionText(input.targetEntityId);
  if (!start || !target || start === target) return [];
  type Edge = { next: string; candidate: AgentEvidenceCandidate; selected: boolean };
  const graph = new Map<string, Edge[]>();
  const connect = (from: string, to: string, candidate: AgentEvidenceCandidate, selected: boolean): void => {
    const add = (left: string, right: string) => {
      const edges = graph.get(left) ?? [];
      edges.push({ next: right, candidate, selected });
      graph.set(left, edges);
    };
    add(from, to);
    add(to, from);
  };
  const selectedIds = new Set(input.selected.map(stableCandidateId));
  for (const candidate of input.ordered) {
    const selected = selectedIds.has(stableCandidateId(candidate));
    for (const [from, to] of relationshipCandidateEndpointPairs(candidate)) {
      connect(from, to, candidate, selected);
    }
  }
  if (!graph.has(start) || !graph.has(target)) return undefined;
  type SearchState = { node: string; additions: AgentEvidenceCandidate[] };
  const queue: SearchState[] = [{ node: start, additions: [] }];
  const bestCost = new Map<string, number>([[start, 0]]);
  while (queue.length > 0) {
    queue.sort((left, right) => left.additions.length - right.additions.length
      || left.additions.map(stableCandidateId).join('|').localeCompare(right.additions.map(stableCandidateId).join('|'))
      || left.node.localeCompare(right.node));
    const current = queue.shift()!;
    if (current.node === target) return current.additions;
    for (const edge of graph.get(current.node) ?? []) {
      const additions = edge.selected || current.additions.some((candidate) => stableCandidateId(candidate) === stableCandidateId(edge.candidate))
        ? current.additions
        : [...current.additions, edge.candidate];
      const cost = additions.length;
      if (cost > 3) continue;
      const priorCost = bestCost.get(edge.next);
      if (priorCost !== undefined && priorCost <= cost) continue;
      bestCost.set(edge.next, cost);
      queue.push({ node: edge.next, additions });
    }
  }
  return undefined;
}

/**
 * Present a complete safe relationship closure as one planner card. The card
 * is a host-authored grouping of already-qualified evidence; it is never an
 * independently inferred join and execution still hydrates the original
 * relationship candidates from the immutable 32-card workspace.
 */
function plannerRelationshipPathCard(closure: AgentEvidenceCandidate[]): AgentEvidenceCandidate | undefined {
  if (closure.length === 0) return undefined;
  const { pathCount, edgeCount } = relationshipPathCardinality(closure);
  const proofSelections = closure.map(relationshipCandidateProofSelection);
  const proofClasses = proofSelections.map((selection) => selection?.proofClass);
  if (pathCount === 0 || pathCount > 3 || edgeCount > 4
    || closure.some(relationshipCandidateHasUnsafeFanout)
    || proofClasses.some((proofClass) => !proofClass)) return undefined;
  const relationshipProofClass = proofClasses.every((proofClass) => proofClass === 'governed')
    ? 'governed' as const
    : 'exploratory' as const;
  // Planner context carries only the canonical edge IDs and exact matched
  // proof subset.  Raw execution candidates remain in the immutable workspace
  // and are revalidated by the compiler after the planner selects this card.
  const pathIds: string[] = [];
  const relationshipSafety = [] as NonNullable<AgentEvidenceCandidate['relationshipSafety']>;
  const seenCanonicalPathIds = new Set<string>();
  for (const selection of proofSelections) {
    if (!selection) return undefined;
    for (const safety of selection.relationshipSafety) {
      const canonicalPathId = safety.id.trim();
      const canonicalIdentity = canonicalPathId.toLowerCase();
      if (!canonicalIdentity || seenCanonicalPathIds.has(canonicalIdentity)) return undefined;
      seenCanonicalPathIds.add(canonicalIdentity);
      pathIds.push(canonicalPathId);
      relationshipSafety.push(safety);
    }
  }
  pathIds.sort();
  const relationshipEndpointIds = uniqueStrings(closure.flatMap((candidate) => candidate.relationshipEndpointIds ?? []));
  const id = `dql:relationship_path:${fingerprint(pathIds.join('|')).slice(0, 24)}`;
  return {
    id,
    qualifiedId: id,
    kind: 'dql_modeling',
    trustTier: relationshipProofClass === 'governed' ? 'governed_sql' : 'exploratory',
    name: `${relationshipProofClass === 'governed' ? 'Safe' : 'Review-required'} relationship path (${pathIds.length} ${pathIds.length === 1 ? 'edge' : 'edges'})`,
    aliases: [relationshipProofClass === 'governed' ? 'safe relationship path' : 'review-required relationship path'],
    definition: relationshipProofClass === 'governed'
      ? 'Host-owned bounded governed relationship closure. The compiler revalidates every supplied edge from the same snapshot.'
      : 'Host-owned bounded exploratory relationship closure. It remains review-required and the compiler revalidates every supplied edge from the same snapshot.',
    relevanceScore: Math.max(...closure.map((candidate) => candidate.relevanceScore)),
    matchReasons: ['host-owned complete safe relationship closure'],
    compatibility: 'compatible',
    eligible: true,
    relationshipEvidence: pathIds,
    relationshipProofClass,
    ...(relationshipEndpointIds.length ? { relationshipEndpointIds } : {}),
    ...(relationshipSafety.length ? { relationshipSafety } : {}),
  };
}

/**
 * Extract only snapshot-authored relationship paths needed by the requested
 * entity/display/categorical roles. This is an admission reservation, not a
 * join inference: the frozen compiler still validates cardinality, fanout,
 * authorization, and the complete execution relation graph.
 */
function targetRelationshipPathIds(
  candidates: AgentEvidenceCandidate[],
  requirements: AnalyticalRequirementSetV1,
): Set<string> {
  const terms = uniqueStrings([
    ...requirements.entityTerms,
    ...requirements.entityDisplayTerms,
    ...categoricalTermsForRuntime(requirements),
  ].map(normalizePlannerAdmissionText)).filter(Boolean);
  const paths = new Set<string>();
  for (const candidate of candidates) {
    const capability = candidate.analyticalCapability;
    if (!capability) continue;
    for (const dimension of capability.dimensions) {
      const identities = [
        dimension.dimensionId,
        dimension.entityId,
        dimension.label ?? '',
        ...(dimension.aliases ?? []),
      ].map(normalizePlannerAdmissionText).filter(Boolean);
      if (!terms.some((term) => identities.some((identity) =>
        runtimeRequirementMatchesDimension(term, identity)))) continue;
      for (const path of dimension.relationshipPathIds ?? []) {
        if (path.trim()) paths.add(path);
      }
    }
  }
  return paths;
}

interface RelationshipClosureTargets {
  primaryEntityId: string;
  targetEntityIds: string[];
}

/**
 * The metric capability supplies the only safe starting entity for a
 * relationship closure. Use the highest-ranked qualified metric that serves
 * the current measure, then retain only its requested cross-entity targets.
 * This is admission evidence, not a planner-selected route or inferred join:
 * the compiler still validates every path after the planner selects it.
 */
function relationshipClosureTargetsForRequirements(
  candidates: AgentEvidenceCandidate[],
  requirements: AnalyticalRequirementSetV1,
): RelationshipClosureTargets | undefined {
  const metricTerms = requirements.ranking?.metricTerms.length
    ? requirements.ranking.metricTerms
    : requirements.measures;
  if (metricTerms.length === 0) return undefined;
  const metric = candidates
    .filter((candidate) => candidate.kind === 'semantic_metric'
      && candidate.eligible !== false
      && candidate.compatibility !== 'incompatible'
      && Boolean(candidate.analyticalCapability?.primaryEntityId)
      && metricTerms.some((term) => candidateMatchesPlannerRequirementTerm(candidate, term)))
    .sort((left, right) => Number(Boolean(right.exactMatch)) - Number(Boolean(left.exactMatch))
      || right.relevanceScore - left.relevanceScore
      || stableCandidateId(left).localeCompare(stableCandidateId(right)))[0];
  const capability = metric?.analyticalCapability;
  if (!capability?.primaryEntityId) return undefined;
  const terms = uniqueStrings([
    ...requirements.entityTerms,
    ...requirements.entityDisplayTerms,
    ...categoricalTermsForRuntime(requirements),
  ].map(normalizePlannerAdmissionText)).filter(Boolean);
  const targetEntityIds = uniqueStrings(capability.dimensions
    .filter((dimension) => {
      const identities = [
        dimension.dimensionId,
        dimension.entityId,
        dimension.label ?? '',
        ...(dimension.aliases ?? []),
      ].map(normalizePlannerAdmissionText).filter(Boolean);
      return terms.some((term) => identities.some((identity) =>
        runtimeRequirementMatchesDimension(term, identity)));
    })
    .map((dimension) => dimension.entityId)
    .filter((entityId) => normalizePlannerAdmissionText(entityId) !== normalizePlannerAdmissionText(capability.primaryEntityId)));
  return targetEntityIds.length > 0
    ? { primaryEntityId: capability.primaryEntityId, targetEntityIds }
    : undefined;
}

function runtimeRequirementMatchesDimension(term: string, identity: string): boolean {
  if (!term || !identity) return false;
  if (identity.includes(term) || term.includes(identity)) return true;
  // Region is a business role rather than a universal physical column name.
  // Permit the already-existing narrow geographic vocabulary only while
  // reserving authored capability relationship paths; it never names a join
  // or changes the selected dimension authority.
  const geographicTerm = /^(?:region|geography|geographic)$/.test(term);
  return geographicTerm
    && /\b(?:region|geograph(?:y|ic)|location|country|state|province|city|territory)\b/.test(identity);
}

type BoundedRelationshipClosureReceiptV1 = {
  /** The selected metric has one or more output entities beyond its primary entity. */
  endpointClosureRequired: boolean;
  /**
   * Every requested output entity is connected to the metric primary entity
   * by the bounded canonical-safe relationship closure.
   */
  endpointClosureComplete: boolean;
  candidates: AgentEvidenceCandidate[];
};

function boundedRelationshipClosure(
  candidates: AgentEvidenceCandidate[],
  requiredPathIds: ReadonlySet<string> = new Set(),
  targets?: RelationshipClosureTargets,
): AgentEvidenceCandidate[] {
  return boundedRelationshipClosureReceipt(candidates, requiredPathIds, targets).candidates;
}

function boundedRelationshipClosureReceipt(
  candidates: AgentEvidenceCandidate[],
  requiredPathIds: ReadonlySet<string> = new Set(),
  targets?: RelationshipClosureTargets,
): BoundedRelationshipClosureReceiptV1 {
  const selected: AgentEvidenceCandidate[] = [];
  const selectedPaths = new Set<string>();
  let selectedEdges = 0;
  const ordered = candidates
    .filter((candidate) => candidate.eligible !== false
      && candidate.compatibility !== 'incompatible'
      && isRelationshipClosureCandidate(candidate)
      && !relationshipCandidateHasUnsafeFanout(candidate)
      // Reuse the router/compiler's exact same-snapshot relationship proof
      // contract. A friendly relation name or a `fanout: safe` string alone
      // cannot become an atomic planner path.
      && relationshipCandidateProofClass(candidate) !== undefined)
    .sort((left, right) => Number(Boolean(right.exactMatch)) - Number(Boolean(left.exactMatch))
      || right.relevanceScore - left.relevanceScore
      || stableCandidateId(left).localeCompare(stableCandidateId(right)));
  const addIfBounded = (candidate: AgentEvidenceCandidate): boolean => {
    const paths = relationshipCandidatePathIds(candidate);
    const newPaths = paths.filter((path) => !selectedPaths.has(path));
    const edgeCount = relationshipCandidateEdgeCount(candidate);
    if (selected.length >= 3 || selectedPaths.size + newPaths.length > 3 || selectedEdges + edgeCount > 4) return false;
    selected.push(candidate);
    for (const path of paths) selectedPaths.add(path);
    selectedEdges += edgeCount;
    return true;
  };
  // First cover every authored path that connects the bound entity/display
  // predicate to the requested output role. Relevance may fill the remaining
  // budget only after this minimal safe closure is retained.
  const pending = new Set(requiredPathIds);
  while (pending.size > 0) {
    const next = ordered
      .filter((candidate) => !selected.includes(candidate))
      .map((candidate) => {
        // Capability metadata may use an approved alias while the planner
        // card serializes the safety proof's canonical ID.  Match required
        // paths against the raw same-snapshot aliases, but count/cardinality
        // only from the canonical proof selection above.
        const coveredPaths = [...pending].filter((path) => relationshipCandidateSupportsPathId(candidate, path));
        return { candidate, coveredPaths, coverage: coveredPaths.length };
      })
      .filter((entry) => entry.coverage > 0)
      .sort((left, right) => right.coverage - left.coverage
        || Number(Boolean(right.candidate.exactMatch)) - Number(Boolean(left.candidate.exactMatch))
        || right.candidate.relevanceScore - left.candidate.relevanceScore
        || stableCandidateId(left.candidate).localeCompare(stableCandidateId(right.candidate)))[0];
    if (!next || !addIfBounded(next.candidate)) break;
    for (const path of next.coveredPaths) pending.delete(path);
  }
  // A role-targeted endpoint graph takes precedence over generic relationship
  // relevance.  When the metric starts at order items and the Ask needs a
  // bound customer plus a location, the missing order-items -> order bridge is
  // structural proof, not a lower-ranked optional card.  Conversely, do not
  // fill an incomplete endpoint closure with an unrelated high-relevance path:
  // that would recreate the old role-cap split under a different ordering.
  const canUseEndpointProof = Boolean(
    targets && ordered.some((candidate) => relationshipCandidateEndpointPairs(candidate).length > 0),
  );
  // A target requirement is incomplete until canonical endpoint proof shows
  // every target is reachable from the metric primary entity.  In particular,
  // a candidate-local customer -> location edge cannot prove an orders ->
  // customer -> location analytical route just because the local endpoints
  // happen to connect to each other.
  const endpointClosureRequired = Boolean(targets);
  let endpointClosureComplete = !endpointClosureRequired;
  if (targets && canUseEndpointProof) {
    for (const targetEntityId of [...new Set(targets.targetEntityIds)].sort()) {
      const bridge = safeRelationshipBridgeCandidates({
        selected,
        ordered,
        primaryEntityId: targets.primaryEntityId,
        targetEntityId,
      });
      if (!bridge) {
        endpointClosureComplete = false;
        continue;
      }
      for (const candidate of bridge) {
        if (selected.includes(candidate)) continue;
        if (!addIfBounded(candidate)) {
          endpointClosureComplete = false;
          break;
        }
      }
    }
    endpointClosureComplete = targets.targetEntityIds.every((targetEntityId) => {
      const bridge = safeRelationshipBridgeCandidates({
        selected,
        ordered,
        primaryEntityId: targets.primaryEntityId,
        targetEntityId,
      });
      return bridge !== undefined && bridge.length === 0;
    });
  }
  // Preserve the conservative relevance fallback only when there are no
  // endpoint requirements, or after the requested endpoint closure is
  // already complete. An endpoint requirement without canonical endpoint
  // proof is incomplete, not an invitation to fill the path with a
  // relevance-ranked relationship card.
  if (endpointClosureComplete) {
    for (const candidate of ordered) {
      if (selected.includes(candidate)) continue;
      addIfBounded(candidate);
    }
  }
  return {
    candidates: selected,
    endpointClosureRequired,
    endpointClosureComplete,
  };
}

function ensureWorkspaceCandidatePresence(input: {
  workspace: AgentEvidenceCandidate[];
  required: AgentEvidenceCandidate[];
  requirements: AnalyticalRequirementSetV1;
}): AgentEvidenceCandidate[] {
  const critical = input.workspace.filter((candidate) => candidate.exactMatch || candidateSupportsRequiredRole(candidate, input.requirements));
  return uniqueCandidates([...input.required, ...critical, ...input.workspace]).slice(0, 32);
}

function uniqueCandidates(candidates: AgentEvidenceCandidate[]): AgentEvidenceCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const id = stableCandidateId(candidate);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function candidateMatchesRequiredExtensionRole(candidate: AgentEvidenceCandidate, requirements: AnalyticalRequirementSetV1): boolean {
  // Extension is intentionally narrower than normal role balancing: it must
  // solve a concrete unadmitted role rather than supply another metric or
  // generic context card.  This prevents an LLM from using extension as a
  // hidden second retrieval loop.
  const roles = evidenceCandidateRoles(candidate);
  if (roles.includes('categorical_dimension') && categoricalTermsForRuntime(requirements).length > 0) {
    const identity = candidateIdentityTerms(candidate);
    if (categoricalTermsForRuntime(requirements).some((term) => identity.includes(term.toLowerCase()))) return true;
  }
  if (roles.includes('entity_label') && requirements.entityDisplayTerms.length > 0) return candidateSupportsRequiredRole(candidate, requirements);
  if (roles.includes('member') && requirements.memberTerms.length > 0) return candidateSupportsRequiredRole(candidate, requirements);
  if (roles.includes('relationship') && (requirements.dimensions.length > 1 || requirements.entityTerms.length > 0)) return true;
  return false;
}

function admitTargetedSameSnapshotExtension(input: {
  recovery: TargetedContextRequestV1;
  plannerCandidates: AgentEvidenceCandidate[];
  workspaceCandidates: AgentEvidenceCandidate[];
  requirements: AnalyticalRequirementSetV1;
}): {
  /** Newly admitted cards only; never a replacement planner package. */
  targetedCandidates: AgentEvidenceCandidate[];
  candidateIds: string[];
  reasonCode: string;
  targetedContext: TargetedContextResultV1;
} | undefined {
  const recovery = input.recovery;
  // One role, <=4 cards, <=3 existing relationship paths: this is a bounded
  // same-snapshot extension, not an LLM-driven rerank or second retrieval.
  // The planner never sees the remaining workspace identities. It may only
  // supply normalized search terms and references to cards already in its
  // 16-card package; the verifier performs the actual workspace lookup.
  if (recovery.version !== 1
    || recovery.missingRoles.length !== 1
    || (recovery.searchTerms?.length ?? 0) > 4
    || (recovery.relatedCandidateIds?.length ?? 0) > 4
    || (recovery.candidateIds?.length ?? 0) > 4
    || (recovery.relationshipPathIds?.length ?? 0) > 3
    || !recovery.missingRoles.every(isEvidenceCandidateRole)) return undefined;
  const plannerIds = new Set(input.plannerCandidates.map(stableCandidateId));
  const requestedIds = [...new Set((recovery.candidateIds ?? []).filter((id): id is string => typeof id === 'string' && Boolean(id.trim())))];
  const relatedIds = [...new Set((recovery.relatedCandidateIds ?? []).filter((id): id is string => typeof id === 'string' && Boolean(id.trim())))];
  // A legacy persisted proposal may still carry `candidateIds`, but no
  // public/provider proposal may use it to point at card 17+. Restrict both
  // ID carriers to the exact planner package before any same-snapshot search.
  if ([...requestedIds, ...relatedIds].some((id) => !input.plannerCandidates.some((candidate) => candidateMatchesStableIdentity(candidate, id)))) return undefined;
  const requestedRole = recovery.missingRoles[0]!;
  // If the planner supplied terms, treat them as the bounded recovery search
  // it requested.  Silently appending broad host terms would turn an
  // unmatched request into an accidental second interpretation pass.  The
  // verifier supplies deterministic role terms only when the planner did not
  // supply any terms at all.
  const searchTerms = uniqueStrings((recovery.searchTerms?.length
    ? recovery.searchTerms
    : targetedSearchTermsForRole(input.requirements, requestedRole))
    .map(normalizePlannerAdmissionText)).slice(0, 4);
  const additions = input.workspaceCandidates
    .filter((candidate) => !plannerIds.has(stableCandidateId(candidate)))
    .filter((candidate) => candidateSupportsTargetedRole(candidate, requestedRole, input.requirements))
    .filter((candidate) => candidateMatchesTargetedSearchTerms(candidate, searchTerms))
    .sort((left, right) => targetedCandidateScore(right, searchTerms) - targetedCandidateScore(left, searchTerms)
      || Number(Boolean(right.exactMatch)) - Number(Boolean(left.exactMatch))
      || right.relevanceScore - left.relevanceScore
      || stableCandidateId(left).localeCompare(stableCandidateId(right)));
  const uniqueAdditions = uniqueCandidates(additions).slice(0, 4);
  if (uniqueAdditions.length === 0) return undefined;
  const availablePaths = new Set(input.workspaceCandidates.flatMap((candidate) => candidate.relationshipEvidence ?? []));
  const relationshipPathIds = [...new Set(recovery.relationshipPathIds ?? [])].slice(0, 3);
  if (relationshipPathIds.some((path) => !availablePaths.has(path))) return undefined;
  // The initial 16-card package is immutable. A revision does not receive a
  // replacement 16-card ranking, because that would evict prior selections
  // when all slots are full. Instead it receives these <=4 cards as a typed
  // addition alongside the immutable prior proposal/selected IDs. The host
  // validates the resulting bounded 16+4 union, while the provider never
  // receives that union as a fresh candidate package.
  return {
    targetedCandidates: uniqueAdditions,
    candidateIds: uniqueAdditions.map(stableCandidateId),
    reasonCode: 'same_snapshot_role_targeted_extension',
    targetedContext: {
      version: 1,
      status: 'admitted',
      candidateIds: uniqueAdditions.map(stableCandidateId),
      relationshipPathIds,
      reasonCode: 'same_snapshot_role_targeted_extension',
    },
  };
}

function targetedSearchTermsForRole(
  requirements: AnalyticalRequirementSetV1,
  role: EvidenceCandidateRoleV1,
): string[] {
  const candidates = role === 'metric'
    ? [...(requirements.ranking?.metricTerms ?? []), ...requirements.measures]
    : role === 'entity_key'
      ? requirements.entityTerms
      : role === 'entity_label'
        ? [...requirements.entityDisplayTerms, ...requirements.entityTerms]
        : role === 'categorical_dimension'
          ? categoricalTermsForRuntime(requirements)
          : role === 'time_dimension'
            ? [requirements.time?.role ?? 'time', requirements.time?.grain ?? '']
            : role === 'member'
              ? requirements.memberTerms
              : role === 'relationship'
                ? [...requirements.entityTerms, ...categoricalTermsForRuntime(requirements), 'relationship']
                : [];
  return uniqueStrings(candidates.map(normalizePlannerAdmissionText)).slice(0, 4);
}

function candidateMatchesTargetedSearchTerms(candidate: AgentEvidenceCandidate, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const identity = candidateIdentityTerms(candidate);
  return terms.some((term) => {
    const normalized = normalizePlannerAdmissionText(term);
    if (!normalized) return false;
    if (identity.includes(normalized)) return true;
    const tokens = normalized.split(' ').filter((token) => token.length > 2);
    return tokens.length > 0 && tokens.every((token) => identity.includes(token));
  });
}

function targetedCandidateScore(candidate: AgentEvidenceCandidate, terms: string[]): number {
  const identity = candidateIdentityTerms(candidate);
  return terms.reduce((score, term) => {
    const normalized = normalizePlannerAdmissionText(term);
    if (!normalized) return score;
    if (identity.includes(normalized)) return score + 4;
    const tokens = normalized.split(' ').filter((token) => token.length > 2);
    return score + (tokens.filter((token) => identity.includes(token)).length / Math.max(1, tokens.length));
  }, 0);
}

function candidateSupportsTargetedRole(
  candidate: AgentEvidenceCandidate,
  role: EvidenceCandidateRoleV1,
  requirements: AnalyticalRequirementSetV1,
): boolean {
  if (!evidenceCandidateRoles(candidate).includes(role)) return false;
  // A role-only extension must still be materially relevant to the original
  // typed request. This prevents a hidden owner/email/sentiment card from
  // satisfying a requested customer or product display label.
  return role === 'relationship'
    ? candidateMatchesRequiredExtensionRole(candidate, requirements)
    : candidateSupportsRequiredRole(candidate, requirements);
}

function buildProgram(
  frame: BusinessQuestionFrameV4,
  mission: AnalyticalMissionV1,
  admitted: AgentEvidenceCandidate[],
  snapshotCandidates: AgentEvidenceCandidate[],
  requirementSeed: ReturnType<typeof buildAnalyticalRequirementSeedV1>,
  options: {
    planningMode?: AskPlanningModeV1;
    plannerProposal?: AnalyticalPlannerProposalV1;
    /** Already role/operation-verified planner interpretation. */
    verifiedPlannerTasks?: AnalyticalProgramV2['planner']['tasks'];
    resolution?: MeaningResolution;
    targetedContext?: TargetedContextResultV1;
  } = {},
): AnalyticalProgramV2 {
  // Build task receipts before candidate selection. A verifier-approved task
  // is the authoritative typed handoff, while a MeaningResolution is a
  // compatibility carrier that may have a narrower selectedConceptIds list.
  // Unioning the already-verified task bindings prevents a selected inferred
  // output or complete relationship path from vanishing before cascade.
  const fallbackSelectedCandidateIds = options.resolution?.selectedConceptIds?.length
    ? options.resolution.selectedConceptIds
    : stableCandidateIds(admitted);
  let plannerTasks = options.verifiedPlannerTasks
    ?? normalizePlannerTasks(options.plannerProposal, admitted.filter((candidate) =>
      fallbackSelectedCandidateIds.includes(candidate.id) || fallbackSelectedCandidateIds.includes(stableCandidateId(candidate))), mission.tasks);
  plannerTasks = materializeVerifiedPlannerTaskHandoff({ tasks: plannerTasks, admitted });
  const selectedCandidateIds = uniqueStableIds([
    ...fallbackSelectedCandidateIds,
    ...plannerTaskSelectionIds(plannerTasks),
  ]);
  // A normal planner selection is bounded by its 16-card package. A single
  // verifier-directed recovery can retain those original selections and add
  // up to four cards, so the frozen meaning tuple may contain at most 20
  // identities. This does not widen the planner package: `plannerCandidateIds`
  // below remains the immutable original 16 and targeted cards are recorded
  // separately in `targetedContext`.
  const candidateIds = uniqueStableIds(selectedCandidateIds).slice(0, MAX_REVISION_SELECTION_CANDIDATES);
  // `snapshotCandidates` is already the runtime-owned qualified workspace,
  // never the raw retrieval pool.  Freeze exactly this closure.  Compiler
  // adapters may hydrate definitions from it but cannot union in arbitrary
  // snapshot candidates after meaning is verified.
  const executionCandidateIds = stableCandidateIds(snapshotCandidates).slice(0, 32);
  const roles = new Set<EvidenceCandidateRoleV1>(requiredRoles(frame.requirements));
  const selectedCandidates = admitted.filter((candidate) => candidateIds.includes(candidate.id) || candidateIds.includes(stableCandidateId(candidate)));
  const boundRelationshipIds = uniqueStableIds(plannerTasks
    .flatMap((task) => task.roleBindings.relationship ?? []));
  const selectedRelationshipCandidates = uniqueCandidates([
    ...admitted,
    ...snapshotCandidates,
  ].filter((candidate) => {
    if (!evidenceCandidateRoles(candidate).includes('relationship')) return false;
    const selectedByConcept = candidateIds.includes(candidate.id)
      || candidateIds.includes(stableCandidateId(candidate));
    const selectedByRelationshipBinding = boundRelationshipIds.some((id) =>
      candidateMatchesStableIdentity(candidate, id)
      || relationshipCandidateSupportsPathId(candidate, id));
    return selectedByConcept || selectedByRelationshipBinding;
  }));
  // A compact relationship-path card is the authoritative planner unit for a
  // complete bounded closure. Its canonical proof IDs must survive into the
  // frozen program even when a raw relationship card retained in the broader
  // workspace uses only a legacy alias. This is receipt completeness, not a
  // new join authority: the path card exists only after canonical proof
  // validation and the compiler revalidates its hydrated raw edges.
  const relationshipRequirements = uniqueStableIds([
    ...selectedRelationshipCandidates.flatMap((candidate) => relationshipCandidatePathIds(candidate)),
  ]).sort();
  const plannerOperations = new Set(inputPlannerOperations(options.plannerProposal));
  for (const candidate of selectedCandidates) {
    for (const role of evidenceCandidateRoles(candidate)) roles.add(role);
  }
  const fingerprintInput = {
    frame: frame.questionFingerprint,
    taskIds: mission.tasks.map((task) => task.id),
    candidateIds,
    executionCandidateIds,
    requiredRoles: [...roles].sort(),
    measures: frame.requirements.measures,
    dimensions: frame.requirements.dimensions,
    entityDisplayTerms: frame.requirements.entityDisplayTerms,
    timeGrain: frame.requirements.time?.grain,
    limit: frame.requirements.ranking?.limit,
    filters: requirementSeed.queryIntent.filters.map((filter) => ({
      field: filter.field,
      operator: 'equals',
      value: filter.value,
    })),
    fiscalPeriod: frame.requirements.time?.fiscalPeriod,
    relationships: relationshipRequirements,
    // Identity, capability, policy, and compiler choice remain deterministic,
    // but the accepted planner interpretation is part of the immutable
    // program. A different operation/role binding/assumption must not reuse
    // the old frozen program fingerprint.
    planner: {
      mode: options.planningMode ?? frame.planningMode,
      tasks: plannerTasks.map((task) => ({
        taskId: task.taskId,
        ...(task.coveredTaskIds ? { coveredTaskIds: [...task.coveredTaskIds].sort() } : {}),
        selectedConceptIds: [...task.selectedConceptIds].sort(),
        roleBindings: Object.fromEntries(Object.entries(task.roleBindings)
          .map(([role, ids]) => [role, [...(ids ?? [])].sort()])),
        operations: [...task.operations].sort(),
        preferredCompiler: task.preferredCompiler,
        assumptions: [...task.assumptions].sort(),
      })),
      missingInformation: [...new Set(options.plannerProposal?.missingInformation ?? [])].sort(),
    },
  };
  return {
    version: 2,
    id: `program:${fingerprint(JSON.stringify(fingerprintInput)).slice(0, 24)}`,
    frameFingerprint: frame.questionFingerprint,
    taskIds: fingerprintInput.taskIds,
    candidateIds,
    executionCandidateIds,
    plannerCandidateIds: stableCandidateIds(admitted).slice(0, MAX_INITIAL_PLANNER_CANDIDATES),
    workspaceCandidateIds: executionCandidateIds,
    requiredRoles: fingerprintInput.requiredRoles as EvidenceCandidateRoleV1[],
    filters: requirementSeed.queryIntent.filters.map((filter) => ({
      fieldTerms: [filter.field],
      // `value` is the immutable literal/member binding. `memberIds` is kept
      // for qualified semantic-member IDs when one was admitted, but a raw
      // business value must never be relabeled as an identifier.
      memberIds: selectedCandidates
        .filter((candidate) => candidate.kind === 'semantic_member'
          && candidateMatchesFilterValue(candidate, filter.value))
        .map(stableCandidateId),
      value: filter.value,
      operator: 'equals' as const,
    })),
    ...(frame.requirements.ranking || plannerOperations.has('rank') ? {
      ranking: {
        metricTerms: [...(frame.requirements.ranking?.metricTerms ?? frame.requirements.measures)],
        direction: frame.requirements.ranking?.direction === 'bottom' ? 'asc' as const : 'desc' as const,
        limit: frame.requirements.ranking?.limit ?? 10,
        ...(frame.requirements.ranking?.defaultedLimit ? { defaultedLimit: true } : {}),
      },
    } : {}),
    ...(frame.requirements.time ? {
      time: {
        roleTerms: frame.requirements.time.role === 'time_axis' ? ['time_axis'] : ['time_filter'],
        ...(frame.requirements.time.fiscalPeriod ? { fiscalPeriodTerms: [frame.requirements.time.fiscalPeriod] } : { fiscalPeriodTerms: [] }),
        ...(frame.requirements.time.grain ? { grain: frame.requirements.time.grain } : {}),
      },
    } : {}),
    comparison: {
      kind: frame.kind === 'comparison' || plannerOperations.has('compare') ? 'segment' : 'none',
      terms: frame.kind === 'comparison' || plannerOperations.has('compare') ? [...frame.requirements.dimensions] : [],
    },
    relationshipRequirements,
    outputs: {
      measures: [...frame.requirements.measures],
      dimensions: [...frame.requirements.dimensions],
      entityDisplayTerms: [...frame.requirements.entityDisplayTerms],
      ...(frame.requirements.time?.grain ? { timeGrain: frame.requirements.time.grain } : {}),
      ...(frame.requirements.ranking ? { limit: frame.requirements.ranking.limit } : {}),
      assertions: [
        'all_requested_measures',
        'all_requested_dimensions',
        'safe_relationship_closure',
        'result_contract',
      ],
    },
    planner: {
      version: 1,
      tasks: plannerTasks,
      ...(options.plannerProposal?.confidence ? { confidence: options.plannerProposal.confidence } : {}),
      missingInformation: [...new Set(options.plannerProposal?.missingInformation ?? [])].slice(0, 8),
    },
  };
}

function inputPlannerOperations(proposal: AnalyticalPlannerProposalV1 | undefined): AnalyticalPlannerOperationV1[] {
  return proposal?.tasks.flatMap((task) => task.operations) ?? [];
}

function uniqueStableIds(values: readonly string[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())))];
}

function normalizePlannerTasks(
  proposal: AnalyticalPlannerProposalV1 | undefined,
  selectedCandidates: AgentEvidenceCandidate[],
  missionTasks: Array<Pick<AnalyticalMissionV1['tasks'][number], 'id' | 'question'>>,
): AnalyticalProgramV2['planner']['tasks'] {
  const fallback = {
    taskId: missionTasks[0]?.id ?? 'task-1',
    selectedConceptIds: stableCandidateIds(selectedCandidates),
    roleBindings: roleBindingsForCandidates(stableCandidateIds(selectedCandidates), selectedCandidates),
    operations: operationsForQuestionType(questionTypeFromText(missionTasks[0]?.question ?? '')),
    assumptions: [],
  };
  if (!proposal?.tasks?.length) return [fallback];
  return proposal.tasks.slice(0, MAX_ASK_TASKS).map((task, index) => ({
    taskId: task.taskId || missionTasks[index]?.id || `task-${index + 1}`,
    ...(task.coveredTaskIds ? { coveredTaskIds: uniqueStableIds(task.coveredTaskIds) } : {}),
    // A targeted revision may retain all 16 original bindings and add up to
    // four cards for its one missing role. Initial proposals still cannot
    // exceed 16 because their known candidate set contains only that package.
    selectedConceptIds: uniqueStableIds(task.selectedConceptIds).slice(0, MAX_REVISION_SELECTION_CANDIDATES),
    roleBindings: Object.fromEntries(Object.entries(task.roleBindings ?? {}).map(([role, ids]) => [role, uniqueStableIds(ids).slice(0, MAX_REVISION_SELECTION_CANDIDATES)])) as Partial<Record<EvidenceCandidateRoleV1, string[]>>,
    operations: [...new Set(task.operations)].filter((operation) => ALLOWED_PLANNER_OPERATIONS.has(operation)).slice(0, 7),
    ...(task.preferredCompiler ? { preferredCompiler: task.preferredCompiler } : {}),
    assumptions: [...new Set(task.assumptions ?? [])].filter((assumption) => assumption.trim().length > 0).slice(0, 8),
  }));
}

/**
 * A verified task carries the complete typed program tuple. Keep every task
 * selection and role binding in one deterministic list so callers do not
 * accidentally treat MeaningResolution.selectedConceptIds as a second, less
 * complete source of truth.
 */
function plannerTaskSelectionIds(tasks: AnalyticalProgramV2['planner']['tasks']): string[] {
  return uniqueStableIds(tasks.flatMap((task) => [
    ...task.selectedConceptIds,
    ...Object.values(task.roleBindings).flatMap((ids) => ids ?? []),
  ]));
}

function canonicalPlannerCandidateId(
  identity: string,
  candidates: readonly AgentEvidenceCandidate[],
): string {
  const matches = candidates.filter((candidate) => candidateMatchesStableIdentity(candidate, identity));
  // A planner task already passed identity verification. Retain an unknown
  // value rather than guessing between aliases; the normal validator will
  // reject it if it is not a supplied stable identity.
  return matches.length === 1 ? stableCandidateId(matches[0]!) : identity;
}

/**
 * Planner cards deliberately expose snapshot-stable/qualified IDs, while the
 * legacy MeaningResolution validator keys its authority map by candidate.id.
 * Keep that representation boundary explicit: immutable planner programs may
 * retain the qualified card identity, but the resolution that flows through
 * the verifier/compiler must use the one admitted candidate's authoritative
 * ID.  This is an identity conversion only; ambiguous aliases remain
 * unchanged and are rejected by the normal validator.
 */
function resolvedPlannerCandidateAuthorityId(
  identity: string,
  candidates: readonly AgentEvidenceCandidate[],
): string {
  const matches = candidates.filter((candidate) => candidateMatchesStableIdentity(candidate, identity));
  return matches.length === 1 ? matches[0]!.id : identity;
}

function normalizedRelationshipPathId(value: string): string {
  return normalizePlannerAdmissionText(value);
}

/**
 * Translate a verifier-approved set of individual canonical edge IDs into
 * the one host-owned relationship-path card only when it contains *all* of
 * that card's canonical proof edges. The raw edges remain execution context;
 * this prevents an incomplete or unrelated edge from being smuggled into the
 * frozen planner program.
 */
function materializeVerifiedPlannerTaskHandoff(input: {
  tasks: AnalyticalProgramV2['planner']['tasks'];
  admitted: readonly AgentEvidenceCandidate[];
}): AnalyticalProgramV2['planner']['tasks'] {
  const pathCards = input.admitted.filter((candidate) =>
    candidate.id.startsWith('dql:relationship_path:')
    && relationshipCandidatePathIds(candidate).length > 0);
  return input.tasks.map((task) => {
    const roleBindings = Object.fromEntries(Object.entries(task.roleBindings).map(([role, ids]) => [
      role,
      uniqueStableIds((ids ?? []).map((id) => canonicalPlannerCandidateId(id, input.admitted))),
    ])) as Partial<Record<EvidenceCandidateRoleV1, string[]>>;
    const relationshipBindings = roleBindings.relationship ?? [];
    const selectedPathCards = pathCards.filter((path) => {
      if (relationshipBindings.some((id) => candidateMatchesStableIdentity(path, id))) return true;
      const canonicalEdges = relationshipCandidatePathIds(path);
      return canonicalEdges.length > 0
        && canonicalEdges.every((edge) => relationshipBindings.some((id) =>
          normalizedRelationshipPathId(id) === normalizedRelationshipPathId(edge)));
    });
    if (selectedPathCards.length > 0) {
      const coveredEdgeIds = new Set(selectedPathCards
        .flatMap((path) => relationshipCandidatePathIds(path))
        .map(normalizedRelationshipPathId));
      roleBindings.relationship = uniqueStableIds([
        ...relationshipBindings.filter((id) => !coveredEdgeIds.has(normalizedRelationshipPathId(id))),
        ...selectedPathCards.map(stableCandidateId),
      ]);
    }
    const selectedConceptIds = uniqueStableIds([
      ...task.selectedConceptIds.map((id) => canonicalPlannerCandidateId(id, input.admitted))
        .filter((id) => !selectedPathCards.some((path) =>
          relationshipCandidatePathIds(path).some((edge) =>
            normalizedRelationshipPathId(edge) === normalizedRelationshipPathId(id)))),
      ...Object.values(roleBindings).flatMap((ids) => ids ?? []),
    ]);
    return {
      ...task,
      selectedConceptIds,
      roleBindings,
    };
  });
}

/**
 * The compatibility meaning carrier is allowed to be narrower than the
 * planner task; the frozen compiler program is not. This identity-only union
 * is applied after task verification and again after legacy frame binding.
 */
function materializeVerifiedPlannerResolution(input: {
  resolution: MeaningResolution;
  tasks: AnalyticalProgramV2['planner']['tasks'];
  admitted: readonly AgentEvidenceCandidate[];
}): MeaningResolution {
  const selectedConceptIds = uniqueStableIds([
    ...input.resolution.selectedConceptIds.map((id) => resolvedPlannerCandidateAuthorityId(id, input.admitted)),
    ...plannerTaskSelectionIds(input.tasks).map((id) => resolvedPlannerCandidateAuthorityId(id, input.admitted)),
  ]);
  return selectedConceptIds.length === input.resolution.selectedConceptIds.length
    && selectedConceptIds.every((id, index) => id === input.resolution.selectedConceptIds[index])
    ? input.resolution
    : { ...input.resolution, selectedConceptIds };
}

function requiredRoles(requirements: AnalyticalRequirementSetV1): EvidenceCandidateRoleV1[] {
  const roles = new Set<EvidenceCandidateRoleV1>();
  if (requirements.measures.length || requirements.ranking?.metricTerms.length) roles.add('metric');
  if (requirements.entityTerms.length) roles.add('entity_key');
  if (requirements.entityDisplayTerms.length) roles.add('entity_label');
  if (requirements.dimensions.length) roles.add('categorical_dimension');
  if (requirements.time) roles.add('time_dimension');
  // A prior-result member is already an immutable host predicate. Requiring a
  // separate member card would make a safe browser-selected follow-up fail
  // before the planner could choose its customer/location path.
  if (requirements.memberTerms.length && !requirements.priorResultMemberBinding) roles.add('member');
  if (requirements.dimensions.length > 1 || requirements.entityTerms.length) roles.add('relationship');
  return [...roles];
}

function hasSelectedInferredRoleSubstitution(
  resolution: MeaningResolution,
  candidates: AgentEvidenceCandidate[],
): boolean {
  const selected = new Set(resolution.selectedConceptIds);
  return candidates.some((candidate) =>
    (selected.has(candidate.id) || selected.has(stableCandidateId(candidate)))
    && (candidate.sameSnapshotRoleExtension?.basis === 'sole_metricflow_grouping_dimension'
      || candidateUnresolvedRoleAdmissions(candidate).length > 0));
}

function resolvedPlanFromDecision(
  programId: string,
  decision: IntentDecision,
  options: { reviewRequired?: boolean } = {},
): ResolvedAnalyticalPlanV2 | undefined {
  const plan = decision.resolvedAnalyticalPlan;
  const cascade = decision.analyticalCascadeDecision;
  const capability = plan?.capability;
  const compiler = capability === 'certified_execution' ? 'certified'
    : capability === 'semantic_execution' ? 'metricflow'
      : capability === 'governed_relational' ? 'governed_relational'
        : capability === 'bounded_exploration' ? 'exploratory_sql'
          : 'none';
  const selectedTier = cascade?.selectedTier;
  if (!plan && !selectedTier) return undefined;
  return {
    version: 2,
    programId,
    compiler,
    ...(selectedTier ? { selectedTier } : {}),
    planFrozen: cascade?.planFrozen ?? plan?.capability !== 'blocked',
    // A host-proven sole MetricFlow grouping substitution is safe enough to
    // execute, but it is still an inferred business mapping. Preserve its
    // visible review boundary even when the resulting compiler is semantic.
    reviewRequired: compiler === 'exploratory_sql' || options.reviewRequired === true,
    ...(plan?.fingerprint ? { planFingerprint: plan.fingerprint } : {}),
  };
}

function buildState(input: {
  mode: AskAnalystRuntimeModeV1;
  phase: AskAnalystState['phase'];
  frame: BusinessQuestionFrameV4;
  mission: AnalyticalMissionV1;
  workspace: EvidenceWorkspaceV2;
  program: AnalyticalProgramV2;
  resolvedPlan?: ResolvedAnalyticalPlanV2;
}): AskAnalystStateV2 {
  return {
    version: 2,
    mode: input.mode,
    phase: input.phase,
    frame: input.frame,
    mission: input.mission,
    workspace: input.workspace,
    program: input.program,
    ...(input.resolvedPlan ? { resolvedPlan: input.resolvedPlan } : {}),
    conversationDelta: {
      version: 2,
      sourceQuestionFingerprint: input.frame.questionFingerprint,
      ...(input.frame.conversation.selectedStableId ? { selectedStableId: input.frame.conversation.selectedStableId } : {}),
      partialFrame: {
        kind: input.frame.kind,
        requirements: input.frame.requirements,
        planningMode: input.frame.planningMode,
      },
      programId: input.program.id,
    },
    planningMode: input.frame.planningMode,
    plannerRevisionCount: 0,
    planningContinuations: 0,
    toolCalls: input.workspace.tools.length,
    executionAttempts: 0,
    repairAttempts: 0,
  };
}

/**
 * The runtime deliberately has a small, closed state graph.  It prevents a
 * later adapter from presenting an execution as though it happened before a
 * frame/program was created, while allowing blocked/clarified outcomes from
 * any pre-freeze state.  The durable object is still JSON-only.
 */
function transitionState(
  state: AskAnalystState,
  next: AskAnalystState['phase'],
  patch: Partial<Omit<AskAnalystStateV2, 'version' | 'mode' | 'phase'>> = {},
): AskAnalystStateV2 {
  const allowed: Record<AskAnalystState['phase'], AskAnalystState['phase'][]> = {
    framed: ['framed', 'evidence_ready', 'program_ready', 'clarify', 'blocked'],
    evidence_ready: ['evidence_ready', 'program_ready', 'clarify', 'blocked'],
    program_ready: ['program_ready', 'compiled', 'clarify', 'blocked'],
    compiled: ['compiled', 'executed', 'blocked'],
    executed: ['executed'],
    clarify: ['clarify', 'program_ready', 'blocked'],
    blocked: ['blocked'],
  };
  if (!allowed[state.phase].includes(next)) {
    throw new Error(`Invalid AskAnalystRuntimeV1 transition: ${state.phase} -> ${next}`);
  }
  return { ...state, ...patch, version: 2, phase: next } as AskAnalystStateV2;
}

function stableCandidateIds(candidates: AgentEvidenceCandidate[]): string[] {
  return [...new Set(candidates.map((candidate) => candidate.qualifiedId ?? candidate.id).filter(Boolean))].slice(0, 32);
}

/**
 * The clarification continuation contract needs only opaque snapshot identity
 * and bounded stable candidate IDs. It intentionally never projects labels,
 * definitions, member values, provider payloads, SQL, or result rows.
 */
function runtimeRetrievalEvidence(
  evidence: AgentRetrievalEvidence | undefined,
  workspaceCandidates: AgentEvidenceCandidate[],
): NonNullable<IntentDecision['retrievalEvidence']> {
  return {
    ...(evidence?.snapshotId ? { snapshotId: evidence.snapshotId } : {}),
    ...(evidence?.sourceFingerprint ? { sourceFingerprint: evidence.sourceFingerprint } : {}),
    ...(evidence?.continuityFingerprint ? { continuityFingerprint: evidence.continuityFingerprint } : {}),
    candidateCount: workspaceCandidates.length,
    candidateIds: stableCandidateIds(workspaceCandidates),
  };
}

function fingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
