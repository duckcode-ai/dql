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

/**
 * Answer routes (certified + generated). The repairable failure is a preview
 * execution error (repair the SQL); a wholly empty answer escalates to research.
 */
const answerGate: AgentRunGate = ({ result }: AgentRunGateContext): AgentRunEvaluation[] => {
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
      suggestedRepair: "Repair the generated SQL using the execution error and re-run the bounded preview.",
      repairAction: { kind: "retry", hint: executionError },
    });
  }

  const hasAnswer = nonEmptyString(result.answer)
    ?? nonEmptyString(payload?.answer)
    ?? nonEmptyString(payload?.text);
  if (!hasAnswer && result.status !== "blocked") {
    evaluations = upsert(evaluations, {
      id: "grounding",
      label: "Answer grounding",
      passed: false,
      severity: "blocking",
      message: "No governed answer could be produced from the available certified context.",
      suggestedRepair: "Investigate the question across governed metrics and lineage instead of answering directly.",
      repairAction: { kind: "escalate", route: "research", hint: "Investigate to ground the answer." },
    });
  }
  return evaluations;
};

/** Research is grounded but inherently exploratory — a thin dossier is a warning, not a repair loop. */
const researchGate: AgentRunGate = ({ result }: AgentRunGateContext): AgentRunEvaluation[] => {
  const evaluations = baseEvaluations(result);
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
  const session = asRecord(payload?.session) ?? payload;
  // Prefer the build session's own status; fall back to the executor's app-coverage eval.
  const coverageFailed = session?.status !== undefined
    ? session.status !== "ready"
    : evaluations.some((evaluation) => evaluation.id === "app-coverage" && !evaluation.passed);
  if (coverageFailed) {
    return upsert(evaluations, {
      id: "app-coverage",
      label: "Certified coverage",
      passed: false,
      severity: "blocking",
      message: "No certified app tiles matched the request, so the app cannot be assembled yet.",
      suggestedRepair: "Create certified DQL drafts for the missing tiles, then rebuild the app.",
      repairAction: { kind: "escalate", route: "dql_block_draft", hint: "Draft the missing certified blocks." },
    });
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
  generated_answer: answerGate,
  research: researchGate,
  sql_cell: sqlCellGate,
  dql_block_draft: blockDraftGate,
  app_build: appBuildGate,
};
