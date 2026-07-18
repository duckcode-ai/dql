/**
 * Executable evaluation gates for the agent run loop.
 *
 * A gate runs *after* a route executor and returns the authoritative evaluations
 * for that step. Unlike the executors' inline (descriptive) evaluations, gate
 * evaluations are the contract the engine loop reads to decide whether to accept,
 * repair, or escalate a step:
 *
 *   - `passed: false` + `suggestedRepair` marks an actionable failure.
 *   - `repairAction.kind: "retry"` re-runs the same route with the hint.
 *   - `repairAction.kind: "escalate"` switches to `repairAction.route`.
 *   - severity `blocking` keeps the run blocked if the failure survives the loop;
 *     severity `warning` lets the run finish as review-required instead.
 *
 * Gates read the evidence the executors already attach to their artifacts/results
 * (governed answer payloads, certifier verdicts, app-build sessions, research
 * grounding), so they stay pure and offline-testable.
 */

import type {
  AgentRunEvaluation,
  AgentRunGate,
  AgentRunGateContext,
  AgentRunGates,
  AgentRouteExecutorResult,
} from "./agent-run-engine.js";
import { validateAnswerResultShape } from "./answer-shape.js";
import { buildAnalysisQuestionPlan } from "./metadata/analysis-planner.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function primaryArtifactPayload(result: AgentRouteExecutorResult): Record<string, unknown> | undefined {
  const artifact = result.artifacts?.[0];
  return artifact ? asRecord(artifact.payload) : undefined;
}

function baseEvaluations(result: AgentRouteExecutorResult): AgentRunEvaluation[] {
  return (result.evaluations ?? []).map((evaluation) => ({ ...evaluation }));
}

/** Replace (or append) an evaluation by id, keeping order stable. */
function upsert(evaluations: AgentRunEvaluation[], next: AgentRunEvaluation): AgentRunEvaluation[] {
  const index = evaluations.findIndex((evaluation) => evaluation.id === next.id);
  if (index >= 0) {
    const copy = [...evaluations];
    copy[index] = next;
    return copy;
  }
  return [...evaluations, next];
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

// ── Semantic-correctness (grain/cardinality) — catches wrong-but-runnable SQL ──
// A scalar question ("total revenue", "how many orders") that returns many rows is
// almost always a missing aggregation or a fan-out join. This is the classic
// "confidently wrong" failure the liveness-only gates never caught.
const SCALAR_INTENT_RE = /\b(how much|how many|what (?:is|was)\b|total\b|overall\b|sum of|count of|number of|average|avg)\b/i;
const BREAKDOWN_INTENT_RE = /\b(by |per |each |breakdown|break down|split|top \d+|top \w+ (?:customers|products|accounts|items)|list|rank|which |who |every |across |over time|group|trend|distribution)\b/i;
// Time-series / window phrasings are inherently multi-row even though they read as
// scalar ("monthly total revenue", "running total", "month over month"). Excluding
// them prevents false-positive fan-out flags that would waste a repair on a correct answer.
const TIME_SERIES_INTENT_RE = /\b(monthly|daily|weekly|quarterly|yearly|hourly|annual|annually|per (?:month|day|week|quarter|year|hour)|running total|cumulative|rolling|month over month|year over year|week over week|mom|yoy|wow|over (?:month|year|week|day|quarter)s?|last \d+ (?:days?|weeks?|months?|quarters?|years?)|for the last \d+)\b/i;

function looksLikeScalarQuestion(question: string): boolean {
  return SCALAR_INTENT_RE.test(question)
    && !BREAKDOWN_INTENT_RE.test(question)
    && !TIME_SERIES_INTENT_RE.test(question);
}

function resultRowCount(payload: Record<string, unknown> | undefined): number | undefined {
  const data = asRecord(payload?.result) ?? asRecord(payload?.resultPreview);
  if (!data) return undefined;
  const rows = Array.isArray(data.rows) ? data.rows : undefined;
  const rowCount = typeof data.rowCount === "number" ? data.rowCount : rows?.length;
  return typeof rowCount === "number" ? rowCount : undefined;
}

function contextPackQuestionPlan(payload: Record<string, unknown> | undefined): ReturnType<typeof buildAnalysisQuestionPlan> | undefined {
  const contextPack = asRecord(payload?.contextPack);
  const questionPlan = asRecord(contextPack?.questionPlan);
  const requestedShape = asRecord(questionPlan?.requestedShape);
  if (!requestedShape || !Array.isArray(requestedShape.requiredOutputs)) return undefined;
  return questionPlan as unknown as ReturnType<typeof buildAnalysisQuestionPlan>;
}

/** A grain/cardinality evaluation when a scalar question returned many rows. */
function semanticCorrectnessEvaluation(
  question: string,
  payload: Record<string, unknown> | undefined,
): AgentRunEvaluation | undefined {
  const rowCount = resultRowCount(payload);
  if (rowCount === undefined || rowCount <= 1) return undefined;
  const plan = contextPackQuestionPlan(payload) ?? buildAnalysisQuestionPlan(question);
  // A request with explicit result dimensions is a table/breakdown even when it
  // starts with conversational "what is" wording. Do not burn repair attempts
  // trying to collapse a customer × product answer into one scalar (AGT-001).
  if (plan.requestedShape.dimensions.length > 0) return undefined;
  if (!looksLikeScalarQuestion(question)) return undefined;
  return {
    id: "semantic-cardinality",
    label: "Result grain",
    passed: false,
    severity: "warning",
    message: `This asks for a single value but the query returned ${rowCount} rows — likely a missing aggregation or a fan-out join.`,
    suggestedRepair: "Aggregate to one value (or the requested grain); check joins for row multiplication.",
    repairAction: {
      kind: "retry",
      hint: `Return a single aggregated value — the previous query returned ${rowCount} rows (fan-out or missing GROUP BY).`,
    },
  };
}

function answerShapeEvaluation(
  question: string,
  payload: Record<string, unknown> | undefined,
): AgentRunEvaluation | undefined {
  const result = asRecord(payload?.result) ?? asRecord(payload?.resultPreview);
  if (!result) return undefined;
  const plan = contextPackQuestionPlan(payload) ?? buildAnalysisQuestionPlan(question);
  const validation = validateAnswerResultShape(plan, result);
  const missingOutputs = validation.missingOutputs;
  if (missingOutputs.length > 0) {
    return {
      id: "answer-shape",
      label: "Answer shape",
      passed: false,
      severity: "warning",
      message: `The answer is missing requested output column(s): ${missingOutputs.join(", ")}.`,
      suggestedRepair: `Regenerate the answer at the requested grain and include: ${missingOutputs.join(", ")}.`,
      repairAction: {
        kind: "retry",
        hint: `The previous result missed requested column(s): ${missingOutputs.join(", ")}. Regenerate SQL using governed metadata and include those columns.`,
      },
    };
  }
  if (validation.topN && validation.topNReturned !== undefined) {
    return {
      id: "answer-topn",
      label: "Requested top-N",
      passed: false,
      severity: "warning",
      message: `The user asked for top ${validation.topN}, but the answer returned ${validation.topNReturned} rows.`,
      suggestedRepair: `Limit or trim the answer to top ${validation.topN} at the requested scope.`,
      repairAction: {
        kind: "retry",
        hint: `The previous result returned ${validation.topNReturned} rows but the user asked for top ${validation.topN}. Return exactly the requested top-N unless the question asks for per-group results.`,
      },
    };
  }
  return undefined;
}

function routeAwareAnswerShapeEvaluation(
  context: AgentRunGateContext,
  payload: Record<string, unknown> | undefined,
): AgentRunEvaluation | undefined {
  const shape = answerShapeEvaluation(context.request.question, payload);
  if (!shape || context.route !== "certified_answer") return shape;
  const hint = shape.repairAction?.hint ?? shape.suggestedRepair ?? "Regenerate the answer at the requested shape.";
  return {
    ...shape,
    suggestedRepair: "Use the certified block as governed context and regenerate a review-required answer at the requested shape.",
    repairAction: {
      kind: "escalate",
      route: "generated_answer",
      hint,
    },
  };
}

/**
 * Answer routes (certified + generated). The answer loop performs the one
 * bounded SQL/context repair while it still has the compiler error and evidence
 * ledger. The outer engine must not restart an ordinary lookup or silently turn
 * it into Research; terminal gaps stay visible and the user may explicitly
 * choose Research if that is the work they want.
 */
const answerGate: AgentRunGate = (context: AgentRunGateContext): AgentRunEvaluation[] => {
  const { result } = context;
  let evaluations = baseEvaluations(result);
  const payload = primaryArtifactPayload(result);
  const executionError = nonEmptyString(payload?.executionError)
    ?? evaluations.find((evaluation) => evaluation.id === "execution-error" && !evaluation.passed)?.message;

  if (executionError) {
    evaluations = upsert(evaluations, {
      id: "execution-error",
      label: "Preview execution",
      passed: false,
      severity: "warning",
      message: `The generated SQL failed to execute against the bounded preview: ${executionError}`,
    });
  }

  // A governed refusal (the model declined, or a grounding gap) still carries
  // explanatory PROSE in `answer`/`text` — but that prose is not a real answer.
  // Treat those refusal codes as terminal no-answer states. They are not an
  // instruction to spend another provider call on a different orchestration lane.
  const isTerminalRefusal = result.answerRefusalCode === "model_declined"
    || result.answerRefusalCode === "grounding_gap";
  const hasAnswer = !isTerminalRefusal && (
    nonEmptyString(result.answer)
    ?? nonEmptyString(payload?.answer)
    ?? nonEmptyString(payload?.text)
  );
  const hasGroundingFailure = evaluations.some(
    (evaluation) => !evaluation.passed
      && (evaluation.id === "grounding" || evaluation.id === "grounding-gap" || evaluation.id === "declined-despite-context"),
  );
  if (!hasAnswer && !hasGroundingFailure && result.status !== "blocked") {
    evaluations = upsert(evaluations, {
      id: "grounding",
      label: "Answer grounding",
      passed: false,
      severity: "warning",
      message: "No governed answer could be produced within the bounded lookup path. Refine the business meaning or explicitly start Research for a deeper investigation.",
    });
  }
  const shape = routeAwareAnswerShapeEvaluation(context, payload);
  if (shape) evaluations = upsert(evaluations, shape);
  return evaluations;
};

/**
 * Generated answers get the liveness checks (execution error / grounding) PLUS a
 * semantic-correctness check: a scalar question that returned many rows is repaired.
 */
const generatedAnswerGate: AgentRunGate = (context: AgentRunGateContext): AgentRunEvaluation[] => {
  let evaluations = answerGate(context);
  // Keep the deeper generated-only checks off certified results; answerGate has
  // already run the shared result-shape validation for both answer routes.
  const certified = context.result.artifacts?.[0]?.trustState === "certified";
  if (!certified) {
    const semantic = semanticCorrectnessEvaluation(context.request.question, primaryArtifactPayload(context.result));
    if (semantic) evaluations = upsert(evaluations, semantic);
  }
  return evaluations;
};

/**
 * Research is grounded but inherently exploratory — a thin dossier is a warning, not a
 * repair loop. The semantic-cardinality check is intentionally NOT run here: the research
 * artifact carries a bounded PREVIEW/sample, not a true row count, so a row check would
 * false-flag. That check belongs on the direct generated_answer path.
 */
const researchGate: AgentRunGate = (context: AgentRunGateContext): AgentRunEvaluation[] => {
  const evaluations = baseEvaluations(context.result);
  const grounding = evaluations.find((evaluation) => evaluation.id === "catalog-grounding");
  if (grounding && !grounding.passed) {
    return upsert(evaluations, {
      ...grounding,
      severity: "warning",
      suggestedRepair: undefined,
      repairAction: undefined,
    });
  }
  return evaluations;
};

/** SQL cell: the executable check is that runnable SQL was produced. */
const sqlCellGate: AgentRunGate = ({ result }: AgentRunGateContext): AgentRunEvaluation[] => {
  const evaluations = baseEvaluations(result);
  const payload = primaryArtifactPayload(result);
  const sql = nonEmptyString(payload?.sql)
    ?? nonEmptyString(payload?.proposedSql)
    ?? nonEmptyString(payload?.sqlPreview);
  if (!sql) {
    return upsert(evaluations, {
      id: "sql-produced",
      label: "SQL produced",
      passed: false,
      severity: "warning",
      message: "No runnable SQL was generated for the notebook cell.",
      suggestedRepair: "Regenerate the cell with explicit table and column grounding.",
      repairAction: { kind: "retry", hint: "Generate runnable SELECT/WITH SQL for the cell." },
    });
  }
  return evaluations;
};

/** Block draft: an unready draft is a repairable (reflect-and-revise) review artifact, not a hard block. */
const blockDraftGate: AgentRunGate = ({ result }: AgentRunGateContext): AgentRunEvaluation[] => {
  const evaluations = baseEvaluations(result);
  const payload = primaryArtifactPayload(result);
  const verdict = asRecord(payload?.certifierVerdict);
  const ready = typeof verdict?.ready === "boolean"
    ? verdict.ready
    : evaluations.find((evaluation) => evaluation.id === "certification-boundary")?.passed ?? true;
  if (!ready) {
    return upsert(evaluations, {
      id: "certification-boundary",
      label: "Certification boundary",
      passed: false,
      severity: "warning",
      message: "The draft block has certifier blockers that should be resolved before certification review.",
      suggestedRepair: "Resolve the certifier blockers (grain, invariants, lineage) and re-draft the block.",
      repairAction: { kind: "retry", hint: "Fix the certifier blockers reported on the draft." },
    });
  }
  return evaluations;
};

/** App build: missing certified coverage escalates to creating the gap blocks first. */
const appBuildGate: AgentRunGate = ({ result }: AgentRunGateContext): AgentRunEvaluation[] => {
  const evaluations = baseEvaluations(result);
  const payload = primaryArtifactPayload(result);
  const coverageIssue: AgentRunEvaluation = {
    id: "app-coverage",
    label: "Certified coverage",
    passed: false,
    severity: "blocking",
    message: "No certified app tiles matched the request, so the app cannot be assembled yet.",
    suggestedRepair: "Create certified DQL drafts for the missing tiles, then rebuild the app.",
    repairAction: { kind: "escalate", route: "dql_block_draft", hint: "Draft the missing certified blocks." },
  };
  // Two-phase build: a proposal needs at least one CERTIFIED tile to be a real app —
  // an app must have a certified anchor (commit rejects a certified-less selection),
  // so an AI-generated-only proposal escalates to drafting blocks instead of a dead end.
  const proposal = asRecord(payload?.proposal);
  const proposalTiles = Array.isArray(proposal?.tiles) ? (proposal.tiles as Array<Record<string, unknown>>) : null;
  if (proposalTiles) {
    const hasCertified = proposalTiles.some((tile) => tile.certification === "certified" && !tile.error);
    return hasCertified ? evaluations : upsert(evaluations, coverageIssue);
  }
  const session = asRecord(payload?.session) ?? payload;
  // Prefer the build session's own status; fall back to the executor's app-coverage eval.
  const coverageFailed = session?.status !== undefined
    ? session.status !== "ready" && session.status !== "proposed"
    : evaluations.some((evaluation) => evaluation.id === "app-coverage" && !evaluation.passed);
  if (coverageFailed) {
    return upsert(evaluations, coverageIssue);
  }
  return evaluations;
};

/**
 * The default gate registry the local runtime wires into the engine. Keys are the
 * routes that have a meaningful executable check; routes without a gate fall back
 * to the executor's own evaluations.
 */
export const defaultAgentRunGates: AgentRunGates = {
  certified_answer: answerGate,
  generated_answer: generatedAnswerGate,
  research: researchGate,
  sql_cell: sqlCellGate,
  dql_block_draft: blockDraftGate,
  app_build: appBuildGate,
};
