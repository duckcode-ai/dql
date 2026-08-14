import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRunEngine,
  FileAgentRunStore,
  InMemoryAgentRunStore,
  defaultAgentRunStorePath,
  resolveClarificationContinuation,
  selectRoute,
  routeReasoningEffort,
  compareResolvedPlanShadow,
  agentRouteDeadlineMs,
  agentRequestDeadlineMs,
  createAgentRunBudget,
  type AgentRouteExecutorResult,
  type AgentRunEvent,
  type AgentRunPlanner,
  type AgentRunRoute,
} from "./agent-run-engine.js";
import { defaultAgentRunGates } from "./agent-run-gates.js";
import { decideAgentAction, type IntentDecision } from "./intent-controller.js";

describe("routeReasoningEffort", () => {
  it("runs cheap/mechanical routes at low effort", () => {
    expect(routeReasoningEffort("conversation")).toBe("low");
    expect(routeReasoningEffort("clarify")).toBe("low");
    expect(routeReasoningEffort("certified_answer")).toBe("low");
    expect(routeReasoningEffort("blocked")).toBe("low");
  });

  it("runs the heavy authoring/investigation routes at high effort", () => {
    expect(routeReasoningEffort("research")).toBe("high");
    expect(routeReasoningEffort("sql_cell")).toBe("high");
    expect(routeReasoningEffort("dql_block_draft")).toBe("high");
  });

  it("runs a plain generated answer at medium effort — the Auto default (S1 decouple)", () => {
    // A generated answer no longer forces `high`: how hard the model thinks is
    // decoupled from how many verification passes run (that follows the question
    // shape). A user's explicit thinking selection can still raise this to high.
    expect(routeReasoningEffort("generated_answer")).toBe("medium");
  });

  it("runs app assembly at medium effort (gap-fill sub-answers escalate on their own)", () => {
    expect(routeReasoningEffort("app_build")).toBe("medium");
  });
});

describe("compareResolvedPlanShadow (AGT-013 / API-006)", () => {
  const decision = {
    action: 'answer',
    confidence: 0.96,
    reason: 'Resolved governed metric.',
    followsUp: false,
    resolvedAnalyticalPlan: {
      mode: 'shadow',
      planId: 'rap:metric-plan',
      fingerprint: 'metric-plan-fingerprint',
      capability: 'semantic_execution',
    } as IntentDecision['resolvedAnalyticalPlan'],
  } satisfies IntentDecision;

  it("reports parity only for an explicit shadow plan", () => {
    expect(compareResolvedPlanShadow(decision, 'semantic_answer')).toEqual({
      planId: 'rap:metric-plan',
      fingerprint: 'metric-plan-fingerprint',
      plannedRoute: 'semantic_answer',
      actualRoute: 'semantic_answer',
      matches: true,
    });
    expect(compareResolvedPlanShadow(decision, 'generated_answer')).toMatchObject({
      plannedRoute: 'semantic_answer',
      actualRoute: 'generated_answer',
      matches: false,
    });
  });

  it('omits the comparison for an authoritative plan', () => {
    expect(compareResolvedPlanShadow({
      ...decision,
      resolvedAnalyticalPlan: {
        ...decision.resolvedAnalyticalPlan!,
        mode: 'authoritative',
      },
    }, 'semantic_answer')).toBeUndefined();
  });
});

describe("AgentRunEngine", () => {
  it.each([
    ['missing category', { action: 'answer', category: undefined }, 'ad_hoc_ranking', 'ask'],
    ['missing category in auto', { action: 'answer', category: undefined }, 'ad_hoc_ranking', 'auto'],
    ['forged conversational category', { action: 'answer', category: 'conversational' }, 'ad_hoc_ranking', 'ask'],
    ['forged conversational action', { action: 'converse', category: 'conversational' }, 'ad_hoc_ranking', 'ask'],
    ['mismatched clarify intent', { action: 'answer', category: 'unclear' }, 'clarify', 'ask'],
  ] as const)('fails closed for analytical Ask with %s and no RAP', async (_label, forged, intent, requestedMode) => {
    let generatedCalls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => `run-host-analytical-${_label}`,
      now: fixedClock(),
      router: {
        decide: () => ({
          action: forged.action,
          confidence: 0.99,
          reason: 'Injected router decision.',
          followsUp: false,
          source: 'llm',
          ...(forged.category ? { category: forged.category } : {}),
        }),
      },
      executors: {
        generated_answer: () => {
          generatedCalls += 1;
          return { answer: 'A 999', trustState: 'review_required', status: 'needs_review' };
        },
      },
    });

    const run = await engine.run({
      question: 'who are the top customers by revenue',
      requestedMode,
      intent,
    });

    expect(generatedCalls).toBe(0);
    expect(run).toMatchObject({ route: 'blocked', status: 'blocked', trustState: 'blocked' });
    expect(run.answer).toContain('could not freeze an exact analytical plan');
    expect(run.events.some((event) => event.type === 'executor.started' && event.route === 'generated_answer')).toBe(false);
  });

  it.each([
    ['hi', 'greeting'],
    ['explain revenue definition', undefined],
  ] as const)('keeps the no-data turn %j out of analytical execution', async (question, expectedKind) => {
    let generatedCalls = 0;
    let conversationCalls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => `run-host-non-data-${question}`,
      now: fixedClock(),
      router: {
        decide: () => ({
          action: 'answer',
          confidence: 0.99,
          reason: 'Injected analytical route.',
          followsUp: false,
          source: 'llm',
          category: 'data_analysis',
        }),
      },
      executors: {
        generated_answer: () => {
          generatedCalls += 1;
          return { answer: 'must not run' };
        },
        conversation: () => {
          conversationCalls += 1;
          return { answer: 'No warehouse query was needed.', answerKind: 'conversational' };
        },
      },
    });

    const run = await engine.run({ question, requestedMode: 'ask', intent: 'ad_hoc_ranking' });

    expect(generatedCalls).toBe(0);
    expect(conversationCalls).toBe(1);
    expect(run).toMatchObject({ route: 'conversation', status: 'completed', trustState: 'not_applicable' });
    expect(run.routeDecision?.conversationalKind).toBe(expectedKind);
  });

  it('fails closed before the legacy generated-answer executor when analytical Ask has no frozen plan', async () => {
    let generatedCalls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-analytical-no-rap',
      now: fixedClock(),
      router: {
        decide: () => ({
          action: 'answer',
          confidence: 0.8,
          reason: 'Retrieved candidates, but no exact analytical tuple was resolved.',
          followsUp: false,
          source: 'heuristic',
          category: 'data_lookup',
          retrievalEvidence: {
            snapshotId: 'snapshot-jaffle',
            candidateCount: 2,
            candidateIds: ['semantic:metric:orders.revenue', 'dql:block:top_beverage_customers'],
          },
        }),
      },
      executors: {
        generated_answer: () => {
          generatedCalls += 1;
          return { answer: 'Legacy generator chose customers instead of revenue.' };
        },
      },
    });

    const run = await engine.run({
      question: 'who are the top customers by revenue',
      requestedMode: 'ask',
    });

    expect(generatedCalls).toBe(0);
    expect(run.route).toBe('blocked');
    expect(run.status).toBe('blocked');
    expect(run.summary).toContain('exact analytical plan');
    expect(run.summary).not.toBe('Agent run is blocked.');
    expect(run.events.some((event) => event.type === 'executor.started' && event.route === 'generated_answer')).toBe(false);
  });

  it('does not call an injected replanner after an ordinary generated Ask attempt fails', async () => {
    let replanCalls = 0;
    const events: AgentRunEvent[] = [];
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-ordinary-ask-no-replan',
      now: fixedClock(),
      router: {
        decide: () => ({
          action: 'answer',
          confidence: 0.8,
          reason: 'A review-required generated answer is needed.',
          followsUp: false,
          source: 'heuristic',
        }),
      },
      planner: {
        plan: ({ request, routeDecision }) => ({
          source: 'deterministic',
          rationale: routeDecision.reason,
          steps: [{
            id: 'step-1',
            route: 'generated_answer',
            goal: request.question,
            successCriteria: [],
          }],
        }),
        replan: () => {
          replanCalls += 1;
          return { decision: 'repair', repairHint: 'Try another provider plan.' };
        },
      },
      executors: {
        generated_answer: () => ({
          summary: 'The generated attempt needs manual review.',
          evaluations: [{
            id: 'generated-contract',
            label: 'Generated contract',
            passed: false,
            severity: 'blocking',
            message: 'The generated attempt did not satisfy its result contract.',
            suggestedRepair: 'Replan the generated answer.',
          }],
        }),
      },
    });

    const run = await engine.run({ question: 'revenue by customer', requestedMode: 'ask' },
      (event) => events.push(event));

    expect(replanCalls).toBe(0);
    expect(run.steps[0]).toMatchObject({ route: 'generated_answer', attempts: 1, status: 'blocked' });
    expect(events.find((event) => event.type === 'replan.decided')?.payload).toEqual({
      decision: 'accept',
      authority: 'deterministic_fail_closed',
    });
  });

  it('retains the separately budgeted replanner for explicit Research', async () => {
    let replanCalls = 0;
    let executionCalls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-research-replan-separate',
      now: fixedClock(),
      planner: {
        plan: ({ request }) => ({
          source: 'llm',
          rationale: 'Explicit Research plan.',
          steps: [{ id: 'step-1', route: 'research', goal: request.question, successCriteria: [] }],
        }),
        replan: () => {
          replanCalls += 1;
          return { decision: 'repair', repairHint: 'Retry the bounded Research step.' };
        },
      },
      executors: {
        research: () => {
          executionCalls += 1;
          return executionCalls === 1
            ? {
                summary: 'Research evidence is incomplete.',
                evaluations: [{
                  id: 'research-evidence',
                  label: 'Research evidence',
                  passed: false,
                  severity: 'warning',
                  message: 'One bounded Research retry is needed.',
                  suggestedRepair: 'Retry the Research step.',
                }],
              }
            : { summary: 'Research evidence complete.', answer: 'Research complete.' };
        },
      },
    });

    const run = await engine.run({ question: 'diagnose revenue risk', requestedMode: 'research' });

    expect(replanCalls).toBe(1);
    expect(executionCalls).toBe(2);
    expect(run.steps[0]).toMatchObject({ route: 'research', attempts: 2, status: 'repaired' });
  });

  it('does not grant an injected planner or replanner authority after an Ask plan is frozen', async () => {
    let plannerCalls = 0;
    let replanCalls = 0;
    const events: AgentRunEvent[] = [];
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-authoritative-plan-boundary',
      now: fixedClock(),
      router: {
        decide: () => ({
          action: 'answer',
          confidence: 1,
          reason: 'Exact governed semantic binding.',
          followsUp: false,
          resolvedAnalyticalPlan: {
            mode: 'authoritative',
            capability: 'semantic_execution',
            planId: 'resolved-plan:food-revenue',
            fingerprint: 'sha256:food-revenue-plan',
          },
        } as IntentDecision),
      },
      planner: {
        plan: () => {
          plannerCalls += 1;
          throw new Error('injected planner must not run');
        },
        replan: () => {
          replanCalls += 1;
          throw new Error('injected replanner must not run');
        },
      },
      executors: {
        semantic_answer: () => ({
          summary: 'Exact plan execution failed validation.',
          evaluations: [{
            id: 'result-contract',
            label: 'Result contract',
            passed: false,
            severity: 'blocking',
            message: 'The frozen output contract did not validate.',
            suggestedRepair: 'Regenerate the answer.',
          }],
        }),
      },
    });

    const run = await engine.run({ question: 'food revenue', requestedMode: 'ask' }, (event) => events.push(event));

    expect(plannerCalls).toBe(0);
    expect(replanCalls).toBe(0);
    expect(run.route).toBe('semantic_answer');
    expect(run.steps[0]).toMatchObject({ attempts: 1, status: 'blocked' });
    expect(events.map((event) => event.type)).not.toContain('replan.decided');
    expect(events.map((event) => event.type)).not.toContain('repair.attempted');
    const routeEvent = events.find((event) => event.type === 'route.decided');
    expect(routeEvent?.payload).not.toHaveProperty('resolvedPlanShadow');
  });

  it("routes a confident certified match to a completed certified answer run", async () => {
    const store = new InMemoryAgentRunStore();
    const events: AgentRunEvent[] = [];
    const engine = new AgentRunEngine({
      store,
      idGenerator: () => "run-certified",
      now: fixedClock(),
      planner: fixedRoutePlanner("certified_answer"),
      executors: {
        certified_answer: () => ({
          answer: "Revenue is $2.8M.",
          evaluations: [{
            id: "certified-execution",
            label: "Certified execution",
            passed: true,
            severity: "info",
            message: "Executed certified block revenue_total.",
          }],
        }),
      },
    });

    const run = await engine.run({
      question: "what is total revenue?",
      intent: "exact_certified_lookup",
      executionTarget: { target: "connection", connectionName: "reporting" },
    }, (event) => events.push(event));

    expect(run).toMatchObject({
      id: "run-certified",
      route: "certified_answer",
      status: "completed",
      trustState: "certified",
      stopReason: "certified_answer_found",
      answer: "Revenue is $2.8M.",
      executionTarget: { target: "connection", connectionName: "reporting" },
    });
    expect(run.artifacts[0]).toMatchObject({ kind: "answer", trustState: "certified" });
    expect(run.lifecycle).toMatchObject({ state: "terminal", phase: "run.completed" });
    expect(run.diagnosticReceipt).toMatchObject({
      version: 1,
      runId: "run-certified",
      route: "certified_answer",
    });
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "plan.created",
      "step.started",
      "route.decided",
      "executor.started",
      "evaluation.recorded",
      "artifact.created",
      "step.completed",
      "run.completed",
    ]);
    expect(store.get("run-certified")).toMatchObject({
      route: "certified_answer",
      executionTarget: { target: "connection", connectionName: "reporting" },
    });
  });

  it("API-007 records blocked outcomes as run.failed with the precise failure class", async () => {
    const events: AgentRunEvent[] = [];
    const engine = new AgentRunEngine({
      idGenerator: () => "run-provider-failed",
      now: fixedClock(),
      planner: fixedRoutePlanner("generated_answer"),
      executors: {
        generated_answer: () => ({
          status: "blocked",
          trustState: "blocked",
          stopReason: "blocked",
          summary: "The configured AI provider is unavailable.",
          artifacts: [{
            id: "provider-failure",
            kind: "answer",
            title: "AI answer provider failed",
            trustState: "blocked",
            payload: { providerFailure: { code: "AI_PROVIDER_FAILURE" } },
          }],
          evaluations: [{
            id: "ai-provider",
            label: "AI provider",
            passed: false,
            severity: "blocking",
            message: "The configured AI provider is unavailable.",
          }],
          nextActions: [{ id: "retry-after-provider", label: "Retry", route: "generated_answer" }],
        }),
      },
    });

    const run = await engine.run({
      question: "Who are the top customers for BCM?",
      intent: "ad_hoc_ranking",
    }, (event) => events.push(event));

    expect(run.lifecycle).toMatchObject({ state: "terminal", phase: "run.failed" });
    expect(run.diagnosticReceipt?.failure).toMatchObject({
      code: "AI_PROVIDER_FAILURE",
      phase: "run.failed",
    });
    expect(events.at(-1)?.type).toBe("run.failed");
  });

  it("treats a compiler-owned semantic answer as terminal governed output", async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => "run-semantic-route",
      now: fixedClock(),
      planner: fixedRoutePlanner("semantic_answer"),
      executors: {
        semantic_answer: () => ({
          answer: "Revenue was $2.8M by region.",
          answerTier: "semantic_metric",
        }),
      },
    });

    const run = await engine.run({ question: "revenue by region" }, () => {});
    expect(run).toMatchObject({
      route: "semantic_answer",
      status: "completed",
      trustState: "governed",
      stopReason: "governed_semantic_answer",
    });
    expect(run.artifacts[0]).toMatchObject({ title: "Governed semantic answer", trustState: "governed" });
  });

  it("escalates a shape-failed certified answer to generated_answer", async () => {
    const events: AgentRunEvent[] = [];
    const engine = new AgentRunEngine({
      idGenerator: () => "run-certified-shape-repair",
      now: fixedClock(),
      planner: fixedRoutePlanner("certified_answer"),
      gates: defaultAgentRunGates,
      executors: {
        certified_answer: () => ({
          answer: "Food and drink revenue.",
          artifacts: [{
            id: "certified",
            kind: "answer",
            title: "Certified answer",
            trustState: "certified",
            payload: {
              answer: "Food and drink revenue.",
              result: {
                columns: ["category", "revenue"],
                rows: [{ category: "Food", revenue: 10 }],
                rowCount: 1,
              },
            },
          }],
        }),
        generated_answer: () => ({
          answer: "Product revenue.",
          artifacts: [{
            id: "generated",
            kind: "answer",
            title: "Generated answer",
            trustState: "review_required",
            payload: {
              answer: "Product revenue.",
              result: {
                columns: ["product_name", "category", "revenue"],
                rows: [{ product_name: "Classic Jaffle", category: "Food", revenue: 10 }],
                rowCount: 1,
              },
            },
          }],
        }),
      },
    });

    const run = await engine.run({
      question: "show revenue by product with product name, category, and revenue",
      intent: "exact_certified_lookup",
    }, (event) => events.push(event));

    expect(run.route).toBe("generated_answer");
    expect(run.repairAttempts).toBe(0);
    expect(run.escalationAttempts).toBe(1);
    expect(run.budgetUsage?.usage).toMatchObject({
      laneExecutionAttemptsUsed: 0,
      engineEscalationsUsed: 1,
    });
    expect(run.steps.map((step) => step.route)).toEqual(["certified_answer", "generated_answer"]);
    expect(run.steps[0]?.evaluations.some((evaluation) => evaluation.id === "answer-shape" && !evaluation.passed)).toBe(true);
    expect(events.some((event) =>
      event.type === "escalated"
      && Boolean(event.payload)
      && (event.payload as { route?: string }).route === "generated_answer"
    )).toBe(true);
  });

  it("keeps a model_declined Ask terminal after its bounded in-lane repair", async () => {
    const events: AgentRunEvent[] = [];
    let generatedCalls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => "run-declined-escalate",
      now: fixedClock(),
      planner: fixedRoutePlanner("generated_answer"),
      gates: defaultAgentRunGates,
      executors: {
        // Mirrors the real local-runtime answer executor: the answer loop already
        // spent its repair, so this is inspectable but not actionable by the engine.
        generated_answer: () => {
          generatedCalls += 1;
          return {
            answer: "I could not compose a governed query for this from the available tables and metrics.",
            answerRefusalCode: "model_declined",
            status: "needs_review",
            artifacts: [],
            evaluations: [{
              id: "declined-despite-context",
              label: "Answer grounding",
              passed: false,
              severity: "warning",
              message: "Declined despite context.",
            }],
          };
        },
        research: () => ({
          answer: "Investigated the join path across orders, products, and locations and composed a review-required query.",
          artifacts: [{
            id: "research",
            kind: "answer",
            title: "Research",
            trustState: "review_required",
            payload: { answer: "Investigated and composed a review-required query." },
          }],
        }),
      },
    });

    const run = await engine.run({
      question: "average tax by location by product",
      intent: "ad_hoc_analysis",
    }, (event) => events.push(event));

    expect(generatedCalls).toBe(1);
    expect(run.escalationAttempts).toBe(0);
    expect(run.steps.map((step) => step.route)).toEqual(["generated_answer"]);
    expect(run.stopReason).not.toBe("needs_clarification");
    expect(events.some((event) => event.type === "escalated")).toBe(false);
  });

  it("opens research as review-required durable work for investigate requests", async () => {
    const engine = new AgentRunEngine({ idGenerator: () => "run-research", now: fixedClock() });
    const run = await engine.run({
      question: "why is revenue down by segment?",
      intent: "diagnose_change",
      requestedMode: "research",
      signals: { certifiedScore: 0.8, hasRetrieval: true },
    });

    expect(run.route).toBe("research");
    expect(run.status).toBe("needs_review");
    expect(run.trustState).toBe("review_required");
    expect(run.artifacts).toEqual([
      expect.objectContaining({ kind: "research_run", trustState: "review_required" }),
    ]);
    expect(run.nextActions.map((action) => action.id)).toEqual(["create-block", "insert-sql"]);
    expect(run.nextActions[0]).toMatchObject({ label: "Review DQL draft" });
  });

  it("fails closed ordinary generated answers while preserving explicit SQL-cell authoring", async () => {
    const engine = new AgentRunEngine({ idGenerator: () => "run-generated", now: fixedClock() });

    const generated = await engine.run({
      question: "show customer orders",
      intent: "ad_hoc_ranking",
      signals: { metricScore: 0.7, certifiedScore: 0.1, hasRetrieval: true },
    });
    const sqlCell = await engine.run({
      question: "create a SQL notebook cell for customer orders",
      intent: "ad_hoc_ranking",
      signals: { metricScore: 0.7, hasRetrieval: true },
    });

    expect(generated.route).toBe("blocked");
    expect(generated.status).toBe("blocked");
    expect(generated.trustState).toBe("blocked");
    expect(sqlCell.route).toBe("sql_cell");
    expect(sqlCell.artifacts[0]?.kind).toBe("sql_cell");
    expect(sqlCell.stopReason).toBe("artifact_created");
  });

  it("does not let a generated executor self-promote an analytical Ask without a RAP", async () => {
    let executorCalls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => "run-resolved-certified",
      now: fixedClock(),
      executors: {
        generated_answer: () => {
          executorCalls += 1;
          return {
            resolvedRoute: "certified_answer",
            summary: "Answered from certified block revenue_total.",
            answer: "Revenue is $2.8M.",
            status: "completed",
            trustState: "certified",
            stopReason: "certified_answer_found",
            artifacts: [{
              id: "answer:certified",
              kind: "answer",
              title: "Certified answer",
              trustState: "certified",
              payload: { route: { tier: "certified_block", ref: "revenue_total" } },
            }],
          };
        },
      },
    });

    const run = await engine.run({ question: "what is total revenue?", requestedMode: "ask" });

    expect(executorCalls).toBe(0);
    expect(run.route).toBe("blocked");
    expect(run.status).toBe("blocked");
    expect(run.trustState).toBe("blocked");
    expect(run.steps[0]?.route).toBe("blocked");
  });

  it("routes block and app requests to their durable artifact surfaces", async () => {
    const engine = new AgentRunEngine({ idGenerator: () => "run-artifact", now: fixedClock() });

    const block = await engine.run({
      question: "turn this reviewed SQL into a DQL block draft",
      intent: "ad_hoc_ranking",
      signals: { hasRetrieval: true },
    });
    const app = await engine.run({
      question: "build a COO revenue app",
      intent: "ad_hoc_ranking",
      signals: { certifiedScore: 0.9, hasRetrieval: true },
    });

    expect(block).toMatchObject({
      route: "dql_block_draft",
      status: "needs_review",
      trustState: "review_required",
    });
    expect(block.artifacts[0]?.kind).toBe("dql_block_draft");
    expect(app.route).toBe("app_build");
    expect(app.artifacts[0]?.kind).toBe("app_draft");
  });

  it("blocks when a blocking evaluator fails", async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => "run-blocked",
      now: fixedClock(),
      executors: {
        sql_cell: () => ({
          evaluations: [{
            id: "sql-safety",
            label: "SQL safety",
            passed: false,
            severity: "blocking",
            message: "Only read-only SELECT/WITH SQL is allowed.",
          }],
        }),
      },
    });

    const run = await engine.run({
      question: "create sql to delete bad rows",
      requestedMode: "sql",
      intent: "ad_hoc_ranking",
    });

    expect(run.status).toBe("blocked");
    expect(run.trustState).toBe("blocked");
    expect(run.stopReason).toBe("blocked");
    expect(run.artifacts).toHaveLength(1);
    expect(run.artifacts[0]?.payload).toMatchObject({
      diagnosticReceipt: {
        failure: { code: "EXECUTION_BLOCKED" },
      },
    });
  });

  it('discards executor answer prose when a blocking result-contract evaluation fails', async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-invalid-result-discarded',
      now: fixedClock(),
      router: { decide: () => authoritativeDecision('semantic_execution') },
      planner: fixedRoutePlanner('semantic_answer'),
      executors: {
        semantic_answer: () => ({
          answer: 'INVALID_RESULT_MUST_DISCARD',
          summary: 'INVALID_SUMMARY_MUST_DISCARD',
          evaluations: [{
            id: 'result-contract',
            label: 'Result contract',
            passed: false,
            severity: 'blocking',
            message: 'The semantic result did not satisfy the frozen output contract.',
          }],
          artifacts: [{
            id: 'invalid-result-diagnostic',
            kind: 'answer',
            title: 'Invalid result diagnostic',
            trustState: 'blocked',
            payload: { result: { rows: [{ secret: 'INVALID_ROW' }] } },
          }],
        }),
      },
    });

    const run = await engine.run({ question: 'food revenue percentage', requestedMode: 'ask' });

    expect(run).toMatchObject({
      status: 'blocked',
      trustState: 'blocked',
      summary: 'The semantic result did not satisfy the frozen output contract.',
      answer: 'The semantic result did not satisfy the frozen output contract.',
    });
    expect(JSON.stringify({ answer: run.answer, summary: run.summary })).not.toContain('INVALID_');
    expect(run.artifacts).toEqual([expect.objectContaining({ id: 'invalid-result-diagnostic' })]);
  });

  it("API-007 retains only explicitly blocked diagnostic artifacts on terminal runs", async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => "run-blocked-diagnostic",
      now: fixedClock(),
      router: { decide: () => authoritativeDecision('bounded_exploration') },
      executors: {
        generated_answer: () => ({
          status: "blocked",
          trustState: "blocked",
          stopReason: "blocked",
          artifacts: [
            { id: "failure", kind: "answer", title: "Failed analytical run", trustState: "blocked", payload: { code: "PERMISSION_DENIED" } },
            { id: "unsafe", kind: "sql_cell", title: "Untrusted SQL", trustState: "review_required", payload: { sql: "select 1" } },
          ],
        }),
      },
    });

    const run = await engine.run({ question: "revenue today", requestedMode: "ask" });

    expect(run.status).toBe("blocked");
    expect(run.artifacts).toEqual([
      expect.objectContaining({ id: "failure", trustState: "blocked" }),
    ]);
  });

  it("returns a blocked run instead of throwing when an executor fails", async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => "run-error",
      now: fixedClock(),
      executors: {
        research: () => {
          throw new Error("warehouse unavailable");
        },
      },
    });

    const run = await engine.run({
      question: "research churn drivers",
      requestedMode: "research",
      intent: "diagnose_change",
    });

    expect(run.route).toBe("blocked");
    expect(run.status).toBe("blocked");
    expect(run.evaluations[0]).toMatchObject({
      id: "executor-error",
      severity: "blocking",
      message: "warehouse unavailable",
    });
    expect(run.events.at(-1)?.type).toBe("run.failed");
    expect(run.diagnosticReceipt).toMatchObject({
      failure: {
        code: "EXECUTOR_FAILURE",
        phase: "executor.started",
        recoverable: true,
      },
    });
    expect(run.artifacts[0]?.payload).toMatchObject({
      diagnosticReceipt: { failure: { code: "EXECUTOR_FAILURE" } },
    });
  });

  it("persists a bounded timeout even when it occurs during retrieval-first routing", async () => {
    const store = new InMemoryAgentRunStore();
    const controller = new AbortController();
    controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    const engine = new AgentRunEngine({
      idGenerator: () => "run-routing-timeout",
      now: fixedClock(),
      store,
      router: {
        decide: async () => {
          throw controller.signal.reason;
        },
      },
    });

    const run = await engine.run({
      question: "top products by revenue",
      requestedMode: "ask",
      signal: controller.signal,
    });

    expect(run).toMatchObject({
      id: "run-routing-timeout",
      route: "blocked",
      status: "blocked",
      stopReason: "blocked",
    });
    expect(run.summary).toContain("reached its time limit");
    expect(run.summary).toContain("does not prove a cross-model join");
    expect(run.events.at(-1)?.type).toBe("run.failed");
    expect(store.get("run-routing-timeout")?.summary).toContain("reached its time limit");
  });

  it("persists runs to a project-local file store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dql-agent-run-store-"));
    try {
      const path = defaultAgentRunStorePath(dir);
      const store = new FileAgentRunStore({ path });
      const engine = new AgentRunEngine({
        store,
        idGenerator: () => "run-file-store",
        now: fixedClock(),
      });

      const run = await engine.run({
        question: "create a SQL cell for revenue",
        requestedMode: "sql",
      });
      const reloaded = new FileAgentRunStore({ path });

      expect(reloaded.get(run.id)?.route).toBe("sql_cell");
      expect(reloaded.list().map((item) => item.id)).toEqual(["run-file-store"]);
      expect(readFileSync(path, "utf-8")).toContain('"version": 1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("AgentRunEngine loop (plan → build → evaluate → modify)", () => {
  it("repairs a failing gate and accepts the repaired result", async () => {
    const events: AgentRunEvent[] = [];
    let calls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => "run-repair",
      now: fixedClock(),
      gates: defaultAgentRunGates,
      executors: {
        sql_cell: () => {
          calls += 1;
          // First build has no SQL (gate fails → retry); the repair produces SQL.
          const payload = calls === 1 ? {} : { sql: "select 1" };
          return { artifacts: [{ id: `sql:${calls}`, kind: "sql_cell", title: "Cell", trustState: "review_required", payload }] };
        },
      },
    });

    const run = await engine.run({ question: "create a sql cell", requestedMode: "sql" }, (event) => events.push(event));

    expect(calls).toBe(2);
    expect(run.route).toBe("sql_cell");
    expect(run.status).toBe("needs_review");
    expect(run.repairAttempts).toBe(1);
    expect(run.escalationAttempts).toBe(0);
    expect(run.budgetUsage?.usage).toMatchObject({
      laneExecutionAttemptsUsed: 1,
      engineEscalationsUsed: 0,
    });
    expect(run.steps[0]?.attempts).toBe(2);
    expect(run.steps[0]?.status).toBe("repaired");
    expect(events.map((event) => event.type)).toContain("repair.attempted");
  });

  it("prefers machine-facing repairAction hints over planner prose during retry", async () => {
    const events: AgentRunEvent[] = [];
    const seenRepairHints: Array<string | undefined> = [];
    let calls = 0;
    const planner: AgentRunPlanner = {
      plan: ({ request }) => ({
        source: "deterministic",
        rationale: "Test plan",
        steps: [{
          id: "step-1",
          route: "generated_answer",
          goal: request.question,
          successCriteria: [],
        }],
      }),
      replan: () => ({
        decision: "repair",
        repairHint: "planner returned broad prose",
      }),
    };
    const engine = new AgentRunEngine({
      idGenerator: () => "run-machine-repair-hint",
      now: fixedClock(),
      planner,
      executors: {
        generated_answer: ({ repairHint }) => {
          calls += 1;
          seenRepairHints.push(repairHint);
          if (calls === 1) {
            return {
              summary: "Grounding gap.",
              evaluations: [{
                id: "grounding-gap",
                label: "Metadata grounding",
                passed: false,
                severity: "warning",
                message: "A metadata relation was missing from the inspected context.",
                suggestedRepair: "Retry with wider metadata context.",
                repairAction: {
                  kind: "retry",
                  hint: "code=unknown_relation; relation=dev.supplies",
                },
              }],
            };
          }
          return {
            summary: "Repaired answer.",
            answer: "Repaired answer.",
            evaluations: [{
              id: "grounding-gap",
              label: "Metadata grounding",
              passed: true,
              severity: "info",
              message: "Context expanded.",
            }],
          };
        },
      },
    });

    const run = await engine.run({ question: "include product supply details", requestedMode: "app" }, (event) => events.push(event));

    expect(run.repairAttempts).toBe(1);
    expect(seenRepairHints).toEqual([undefined, "code=unknown_relation; relation=dev.supplies"]);
    expect(events.find((event) => event.type === "repair.attempted")?.payload).toMatchObject({
      repairHint: "code=unknown_relation; relation=dev.supplies",
    });
  });

  it("short-circuits after a governed semantic answer but continues after a generated answer (R2.3)", async () => {
    const twoStepPlanner: AgentRunPlanner = {
      plan: ({ request }) => ({
        source: "deterministic",
        rationale: "two-step plan",
        steps: [
          { id: "s1", route: "generated_answer", goal: request.question, successCriteria: [] },
          { id: "s2", route: "research", goal: "dig deeper", successCriteria: [] },
        ],
      }),
      replan: () => ({ decision: "accept" }),
    };
    const cleanAnswer = (answerTier: string) => ({
      answerTier,
      status: "completed" as const,
      trustState: "review_required" as const,
      summary: `${answerTier} answer`,
      artifacts: [{ id: "a", kind: "answer" as const, title: "A", trustState: "review_required" as const, payload: {} }],
    });

    // Governed semantic answer → research step is skipped.
    let semanticResearch = 0;
    const semanticEngine = new AgentRunEngine({
      idGenerator: () => "run-semantic-terminal",
      now: fixedClock(),
      planner: twoStepPlanner,
      executors: {
        generated_answer: () => cleanAnswer("semantic_metric"),
        research: () => { semanticResearch += 1; return { summary: "research" }; },
      },
    });
    await semanticEngine.run({ question: "revenue by region", requestedMode: "auto" }, () => {});
    expect(semanticResearch).toBe(0);

    // Generated SQL answer (same status) → research step DOES run. The tier, not
    // the route or status, is the discriminator.
    let generatedResearch = 0;
    const generatedEngine = new AgentRunEngine({
      idGenerator: () => "run-generated-continues",
      now: fixedClock(),
      planner: twoStepPlanner,
      executors: {
        generated_answer: () => cleanAnswer("generated_sql"),
        research: () => { generatedResearch += 1; return { summary: "research" }; },
      },
    });
    await generatedEngine.run({ question: "why did margin drop", requestedMode: "auto" }, () => {});
    expect(generatedResearch).toBe(1);
  });

  it("keeps a generated answer with no grounding terminal", async () => {
    const events: AgentRunEvent[] = [];
    const engine = new AgentRunEngine({
      idGenerator: () => "run-escalate",
      now: fixedClock(),
      router: { decide: () => authoritativeDecision('bounded_exploration') },
      gates: defaultAgentRunGates,
      executors: {
        generated_answer: () => ({ answer: "", artifacts: [] }),
        research: () => ({
          summary: "Grounded research dossier.",
          artifacts: [{ id: "r1", kind: "research_run", title: "Research", trustState: "review_required", payload: {} }],
          evaluations: [{ id: "catalog-grounding", label: "Catalog grounding", passed: true, severity: "info", message: "Grounded." }],
        }),
      },
    });

    const run = await engine.run({
      question: "show me something ungrounded",
      intent: "ad_hoc_ranking",
      signals: { certifiedScore: 0.1, hasRetrieval: true },
    }, (event) => events.push(event));

    expect(run.route).toBe("generated_answer");
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]?.status).toBe("passed");
    expect(run.repairAttempts).toBe(0);
    expect(run.escalationAttempts).toBe(0);
    expect(run.budgetUsage?.usage).toMatchObject({
      laneExecutionAttemptsUsed: 0,
      engineEscalationsUsed: 0,
    });
    expect(events.map((event) => event.type)).not.toContain("escalated");
  });

  it("does not spend the engine escalation budget for a terminal lookup gap", async () => {
    let researchCalls = 0;
    const events: AgentRunEvent[] = [];
    const engine = new AgentRunEngine({
      idGenerator: () => "run-escalation-budget",
      now: fixedClock(),
      router: { decide: () => authoritativeDecision('bounded_exploration') },
      maxEngineEscalations: 0,
      gates: defaultAgentRunGates,
      executors: {
        generated_answer: () => ({ answer: "", artifacts: [] }),
        research: () => {
          researchCalls += 1;
          return { summary: "Should not run." };
        },
      },
    });

    const run = await engine.run({
      question: "show me something ungrounded",
      intent: "ad_hoc_ranking",
      signals: { certifiedScore: 0.1, hasRetrieval: true },
    }, (event) => events.push(event));

    expect(researchCalls).toBe(0);
    expect(run.route).toBe("generated_answer");
    expect(run.status).toBe("needs_review");
    expect(run.repairAttempts).toBe(0);
    expect(run.escalationAttempts).toBe(0);
    expect(run.budgetUsage?.limits.engineEscalations).toBe(0);
    expect(events.some((event) => event.type === "escalated")).toBe(false);
  });

  it("does not retry or silently turn an ordinary shape failure into Research", async () => {
    let generatedCalls = 0;
    let researchCalls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => "run-shape-bounded",
      now: fixedClock(),
      maxRepairAttempts: 1,
      gates: defaultAgentRunGates,
      executors: {
        generated_answer: () => {
          generatedCalls += 1;
          return {
            answer: "Customer list without the requested measure.",
            artifacts: [{
              id: `generated:${generatedCalls}`,
              kind: "answer",
              title: "Generated answer",
              trustState: "review_required",
              payload: {
                answer: "Customer list without the requested measure.",
                result: { columns: ["customer_name"], rows: [{ customer_name: "A" }], rowCount: 1 },
              },
            }],
          };
        },
        research: () => {
          researchCalls += 1;
          return { summary: "This must remain explicit." };
        },
      },
    });

    const run = await engine.run({ question: "Who are the top customers by revenue?" });

    expect(generatedCalls).toBe(1);
    expect(researchCalls).toBe(0);
    expect(run.steps.map((step) => step.route)).toEqual(["generated_answer"]);
    expect(run.escalationAttempts).toBe(0);
    expect(run.repairAttempts).toBe(0);
    expect(run.status).toBe("needs_review");
  });

  it("escalates an app build with no certified coverage to a block draft", async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => "run-app-escalate",
      now: fixedClock(),
      gates: defaultAgentRunGates,
      executors: {
        app_build: () => ({
          artifacts: [{ id: "a1", kind: "app_draft", title: "App", trustState: "review_required", payload: { session: { status: "needs_coverage" } } }],
        }),
        dql_block_draft: () => ({
          summary: "Drafted the gap block.",
          artifacts: [{ id: "b1", kind: "dql_block_draft", title: "Gap block", trustState: "review_required", payload: { certifierVerdict: { ready: true } } }],
        }),
      },
    });

    const run = await engine.run({ question: "build a revenue dashboard", requestedMode: "app" });

    expect(run.steps[0]?.route).toBe("app_build");
    expect(run.steps[0]?.status).toBe("escalated");
    expect(run.route).toBe("dql_block_draft");
  });

  it("stops repairing once the modify budget is exhausted and finishes review-required", async () => {
    let calls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => "run-budget",
      now: fixedClock(),
      maxRepairAttempts: 1,
      gates: defaultAgentRunGates,
      executors: {
        sql_cell: () => {
          calls += 1;
          return { artifacts: [{ id: `sql:${calls}`, kind: "sql_cell", title: "Cell", trustState: "review_required", payload: {} }] };
        },
      },
    });

    const run = await engine.run({ question: "create a sql cell", requestedMode: "sql" });

    expect(calls).toBe(2); // initial build + one repair, then budget exhausted
    expect(run.repairAttempts).toBe(1);
    expect(run.escalationAttempts).toBe(0);
    expect(run.status).toBe("needs_review");
  });

  it("runs a multi-step plan and aggregates artifacts across steps", async () => {
    const planner: AgentRunPlanner = {
      plan: () => ({
        source: "llm",
        rationale: "Investigate, then draft a governed block.",
        steps: [
          { id: "s1", route: "research", goal: "Investigate drivers", successCriteria: [] },
          { id: "s2", route: "dql_block_draft", goal: "Draft the metric block", successCriteria: [] },
        ],
      }),
      replan: () => ({ decision: "accept" }),
    };
    const executors = {
      research: (): AgentRouteExecutorResult => ({
        summary: "Research done.",
        artifacts: [{ id: "r1", kind: "research_run" as const, title: "Research", trustState: "review_required" as const, payload: {} }],
      }),
      dql_block_draft: (): AgentRouteExecutorResult => ({
        summary: "Draft done.",
        artifacts: [{ id: "b1", kind: "dql_block_draft" as const, title: "Block", trustState: "review_required" as const, payload: { certifierVerdict: { ready: true } } }],
      }),
    };
    const engine = new AgentRunEngine({ idGenerator: () => "run-multi", now: fixedClock(), planner, gates: defaultAgentRunGates, executors });

    const run = await engine.run({ question: "why is revenue down, then make a block" });

    expect(run.plan?.source).toBe("llm");
    expect(run.steps.map((step) => step.route)).toEqual(["research", "dql_block_draft"]);
    expect(run.route).toBe("dql_block_draft");
    expect(run.artifacts.map((artifact) => artifact.kind)).toEqual(["research_run", "dql_block_draft"]);
  });

  it("preserves an earlier step's answer when the final step only drafts an artifact", async () => {
    const planner: AgentRunPlanner = {
      plan: () => ({
        source: "llm",
        rationale: "Answer, then draft a governed block.",
        steps: [
          { id: "s1", route: "generated_answer", goal: "Answer the question", successCriteria: [] },
          { id: "s2", route: "dql_block_draft", goal: "Draft the metric block", successCriteria: [] },
        ],
      }),
      replan: () => ({ decision: "accept" }),
    };
    const executors = {
      generated_answer: (): AgentRouteExecutorResult => ({
        summary: "Answered.",
        answer: "Total revenue is $1.2M across 3 regions.",
        artifacts: [{ id: "a1", kind: "answer" as const, title: "Answer", trustState: "review_required" as const, payload: {} }],
      }),
      dql_block_draft: (): AgentRouteExecutorResult => ({
        summary: "Draft done.",
        // A later step that only drafts an artifact must not drop the earlier answer.
        artifacts: [{ id: "b1", kind: "dql_block_draft" as const, title: "Block", trustState: "review_required" as const, payload: { certifierVerdict: { ready: true } } }],
      }),
    };
    const engine = new AgentRunEngine({ idGenerator: () => "run-preserve", now: fixedClock(), planner, gates: defaultAgentRunGates, executors });

    const run = await engine.run({ question: "what is total revenue, then make a block" });

    expect(run.steps.map((step) => step.route)).toEqual(["generated_answer", "dql_block_draft"]);
    expect(run.answer).toBe("Total revenue is $1.2M across 3 regions.");
  });
});

describe("AgentRunEngine audience", () => {
  it("collapses a stakeholder authoring request to a governed answer + certification handoff", async () => {
    const engine = new AgentRunEngine({ idGenerator: () => "run-sh", now: fixedClock() });
    const run = await engine.run({ question: "create a sql cell for revenue", requestedMode: "sql", audience: "stakeholder" });
    expect(run.route).toBe("generated_answer");
    expect(run.status).toBe("needs_review");
    expect(run.nextActions.some((action) => action.id === "request-certification")).toBe(true);
    expect(run.nextActions.some((action) => action.route === "sql_cell" || action.route === "dql_block_draft")).toBe(false);
  });

  it("keeps authoring routes for an analyst", async () => {
    const engine = new AgentRunEngine({ idGenerator: () => "run-an", now: fixedClock() });
    const run = await engine.run({ question: "create a sql cell for revenue", requestedMode: "sql", audience: "analyst" });
    expect(run.route).toBe("sql_cell");
  });

  it("keeps a stakeholder app-coverage gap in ordinary Ask, not implicit Research", async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => "run-sh-app",
      now: fixedClock(),
      gates: defaultAgentRunGates,
      executors: {
        app_build: () => ({
          artifacts: [{ id: "a1", kind: "app_draft", title: "App", trustState: "review_required", payload: { session: { status: "needs_coverage" } } }],
        }),
        research: () => ({
          summary: "Grounded research instead.",
          artifacts: [{ id: "r1", kind: "research_run", title: "Research", trustState: "review_required", payload: {} }],
          evaluations: [{ id: "catalog-grounding", label: "Catalog grounding", passed: true, severity: "info", message: "Grounded." }],
        }),
      },
    });
    const run = await engine.run({ question: "build a revenue dashboard", requestedMode: "app", audience: "stakeholder" });
    expect(run.steps[0]?.route).toBe("app_build");
    expect(run.steps[0]?.status).toBe("escalated");
    expect(run.route).toBe("generated_answer");
  });

  it("answers anyway for a stakeholder instead of dead-ending on clarify", async () => {
    const engine = new AgentRunEngine({ idGenerator: () => "run-anyway", now: fixedClock() });
    const run = await engine.run({ question: "what is total revenue?", intent: "ad_hoc_ranking", audience: "stakeholder" });
    expect(run.route).toBe("generated_answer");
  });

  it("still clarifies for a stakeholder when the catalog flags missing context", async () => {
    const engine = new AgentRunEngine({ idGenerator: () => "run-missing", now: fixedClock() });
    const run = await engine.run({
      question: "show me the thing",
      intent: "ad_hoc_ranking",
      audience: "stakeholder",
      signals: { missingContext: ["Which measure should I use?"] },
    });
    expect(run.route).toBe("clarify");
  });

  it("answers anyway for an analyst soft clarify (nothing governed matched) instead of dead-ending", async () => {
    const engine = new AgentRunEngine({ idGenerator: () => "run-analyst-anyway", now: fixedClock() });
    const run = await engine.run({ question: "what is total revenue?", intent: "ad_hoc_ranking", audience: "analyst" });
    expect(run.route).toBe("generated_answer");
  });

  it("lets the governed answer loop handle a router-only clarification for an analyst", async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => "run-router-anyway",
      now: fixedClock(),
      router: {
        decide: () => ({
          action: "clarify",
          confidence: 0.82,
          reason: "The ranking could be interpreted in more than one way.",
          clarifyingQuestion: "Rank by spend or by product variety?",
          followsUp: false,
        }),
      },
      executors: {
        generated_answer: () => ({ answer: "Melissa leads by beverage spend and product variety." }),
      },
    });

    const run = await engine.run({
      question: "Who are the top customers buying different beverage products?",
      intent: "ad_hoc_ranking",
      audience: "analyst",
    });

    expect(run.route).toBe("generated_answer");
    expect(run.status).not.toBe("needs_clarification");
    expect(run.answer).toContain("Melissa");
  });

  it("keeps a genuine analyst clarify (explicit missing context) as clarify", async () => {
    const engine = new AgentRunEngine({ idGenerator: () => "run-analyst-missing", now: fixedClock() });
    const run = await engine.run({
      question: "show me the thing",
      intent: "ad_hoc_ranking",
      audience: "analyst",
      signals: { missingContext: ["Which measure should I use?"] },
    });
    expect(run.route).toBe("clarify");
  });

  it("strips analyst next-actions from a stakeholder run", async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => "run-sh-na",
      now: fixedClock(),
      executors: {
        research: () => ({
          summary: "Research.",
          status: "needs_review",
          artifacts: [{ id: "r1", kind: "research_run", title: "Research", trustState: "review_required", payload: {} }],
          nextActions: [
            { id: "create-block", label: "Create DQL draft", route: "dql_block_draft", artifactKind: "dql_block_draft" },
            { id: "drill", label: "Drill down", route: "research" },
          ],
        }),
      },
    });
    const run = await engine.run({ question: "why is revenue down?", requestedMode: "research", audience: "stakeholder" });
    expect(run.nextActions.some((action) => action.id === "create-block")).toBe(false);
    expect(run.nextActions.some((action) => action.id === "drill")).toBe(true);
    expect(run.nextActions.some((action) => action.id === "request-certification")).toBe(true);
  });
});

describe("clarification continuations — Ask surface", () => {
  /**
   * The reported clarify loop. On the Ask surface a clarification persists the
   * RESOLVED analytical route (`generated_answer`) with
   * `runStatus: 'needs_clarification'`, and thread runs clear `history`. The
   * engine's only lookup matched `route === 'clarify'`, so it never found the
   * pending clarification: the reply ran context-free and was clarified again.
   *
   * `buildConversationSnapshot` publishes `pendingClarification` correctly —
   * nothing consumed it. Now the engine reads it first.
   */
  function askSurfaceContext(overrides: Record<string, unknown> = {}) {
    return {
      conversationContext: {
        conversationEnvelope: {
          threadId: "thr_1",
          recentTurns: [{
            id: "trn_1",
            question: "What is total revenue?",
            answerSummary: "Do you mean gross or net revenue?",
            // The route the run WOULD have taken — not 'clarify'.
            route: "generated_answer",
            runStatus: "needs_clarification",
          }],
          pendingClarification: {
            sourceTurnId: "trn_1",
            question: "Do you mean gross or net revenue?",
            sourceQuestion: "What is total revenue?",
          },
          ...overrides,
        },
      },
    };
  }

  it("recovers the original question from the envelope when the route is not 'clarify'", () => {
    // `history` is empty — thread runs clear it — so the envelope is the ONLY
    // source. Before this, the turn scan required `route === 'clarify'` and
    // found nothing, so the reply ran as a bare context-free word.
    const continuation = resolveClarificationContinuation({
      question: "net",
      history: [],
      ...askSurfaceContext(),
    });

    expect(continuation).toBeDefined();
    expect(continuation!.sourceQuestion).toBe("What is total revenue?");
    expect(continuation!.clarifyingQuestion).toBe("Do you mean gross or net revenue?");
    expect(continuation!.resolvedQuestion).toContain("What is total revenue?");
    expect(continuation!.resolvedQuestion).toContain("net");
  });

  it("still works from a legacy envelope carrying only serverSnapshot", () => {
    const continuation = resolveClarificationContinuation({
      question: "net",
      history: [],
      conversationContext: {
        serverSnapshot: {
          recentTurns: [{
            question: "What is total revenue?",
            answerSummary: "Do you mean gross or net revenue?",
            route: "clarify",
          }],
        },
      },
    });

    expect(continuation?.sourceQuestion).toBe("What is total revenue?");
  });

  it("uses the exact source run for a structured choice even without conversation storage", () => {
    const continuation = resolveClarificationContinuation({
      question: "Lost Deal Activity Count",
      selectedEvidenceId: "semantic:metric:sales.lost_deal_activity_count",
      clarificationSourceQuestion: "Compare monthly competitive losses by competitor and activity count",
      history: [],
    });

    expect(continuation).toMatchObject({
      sourceQuestion: "Compare monthly competitive losses by competitor and activity count",
      reply: "Lost Deal Activity Count",
    });
  });

  it("does not fold a complete new question into a pending clarification", () => {
    const continuation = resolveClarificationContinuation({
      question: "Which warehouses shipped late last quarter?",
      history: [],
      ...askSurfaceContext(),
    });

    expect(continuation).toBeUndefined();
  });
});

describe("clarification continuations", () => {
  it("treats a substantive new question without punctuation as a fresh turn", () => {
    const continuation = resolveClarificationContinuation({
      question: "who are the customers userd the beverage products",
      conversationContext: {
        serverSnapshot: {
          recentTurns: [{
            question: "what product they bought for this amount?",
            answerSummary: "Which product meaning do you want?",
            route: "clarify",
          }],
        },
      },
    });

    expect(continuation).toBeUndefined();
  });

  it("recovers to a previously successful analytical question after clarification", () => {
    const continuation = resolveClarificationContinuation({
      question: "what region has the most revenue",
      conversationContext: {
        serverSnapshot: {
          recentTurns: [
            {
              question: "what region has the most revenue",
              answerSummary: "Philadelphia has the highest revenue.",
              route: "answer",
              runStatus: "completed",
            },
            {
              question: "filter that customer",
              answerSummary: "Which customer column should define the answer?",
              route: "clarify",
              runStatus: "needs_clarification",
            },
          ],
        },
      },
    });

    expect(continuation).toBeUndefined();
  });

  it("treats a compact metric-by-dimension request as a fresh turn", () => {
    const continuation = resolveClarificationContinuation({
      question: "revenue by region",
      conversationContext: {
        serverSnapshot: {
          recentTurns: [{
            question: "filter that customer",
            answerSummary: "Which customer column should define the answer?",
            route: "clarify",
            runStatus: "needs_clarification",
          }],
        },
      },
    });

    expect(continuation).toBeUndefined();
  });

  it("recovers the original question and actual clarifying question from persisted turns", () => {
    const continuation = resolveClarificationContinuation({
      question: "yes",
      conversationContext: {
        serverSnapshot: {
          recentTurns: [{
            question: "Who are the top customers buying different beverage products?",
            answerSummary: "Do you want total beverage spend or a per-product breakdown?",
            route: "clarify",
          }],
        },
      },
    });

    expect(continuation).toMatchObject({
      sourceQuestion: "Who are the top customers buying different beverage products?",
      clarifyingQuestion: "Do you want total beverage spend or a per-product breakdown?",
      reply: "yes",
    });
    expect(continuation?.resolvedQuestion).toContain("User clarification: yes");
    expect(continuation?.resolvedQuestion).toContain("Do not repeat the same clarification");
  });

  it("recovers the analytical question from an already repeated clarification chain", () => {
    const continuation = resolveClarificationContinuation({
      question: "yes, per product",
      conversationContext: {
        serverSnapshot: {
          recentTurns: [
            {
              question: "Who are the top customers buying different beverage products?",
              answerSummary: "Rank by spend or by product variety?",
              route: "clarify",
            },
            {
              question: "yes",
              answerSummary: "Do you mean individual products or total beverage revenue?",
              route: "clarify",
            },
          ],
        },
      },
    });

    expect(continuation?.sourceQuestion).toBe("Who are the top customers buying different beverage products?");
    expect(continuation?.clarifyingQuestion).toBe("Do you mean individual products or total beverage revenue?");
    expect(continuation?.resolvedQuestion).toContain("User clarification: yes, per product");
  });

  it("fails closed a free-text clarification continuation that still has no frozen RAP", async () => {
    let routed = false;
    let executedQuestion = "";
    const engine = new AgentRunEngine({
      idGenerator: () => "run-clarification-follow-up",
      now: fixedClock(),
      router: {
        decide: () => {
          routed = true;
          return { action: "clarify", confidence: 0.9, reason: "Ask again", followsUp: true };
        },
      },
      executors: {
        generated_answer: ({ request }) => {
          executedQuestion = request.question;
          return { answer: "Melissa leads across five beverage product types." };
        },
      },
    });

    const run = await engine.run({
      question: "yes",
      conversationContext: {
        serverSnapshot: {
          recentTurns: [{
            question: "Who are the top customers buying different beverage products?",
            answerSummary: "Do you want total beverage spend or a per-product breakdown?",
            route: "clarify",
          }],
        },
      },
    });

    expect(routed).toBe(false);
    expect(executedQuestion).toBe("");
    expect(run.question).toBe("yes");
    expect(run.route).toBe("blocked");
    expect(run.answer).toContain("could not freeze an exact analytical plan");
    expect(run.events[0]?.payload).toMatchObject({ question: "yes", clarificationResolved: true });
  });

  it("AGT-011 routes a structured meaning choice against the original question and selected evidence", async () => {
    const selectedEvidenceId = "semantic:metric:dbt_core_models.total_ccu_count";
    let routedQuestion = "";
    let routedEvidenceId: string | undefined;
    let executedQuestion = "";
    let executedEvidenceId: string | undefined;
    const engine = new AgentRunEngine({
      idGenerator: () => "run-structured-clarification",
      now: fixedClock(),
      router: {
        decide: (request) => {
          routedQuestion = request.question;
          routedEvidenceId = request.selectedEvidenceId;
          return {
            action: "answer",
            confidence: 1,
            reason: "The user selected an exact governed metric.",
            source: "heuristic",
            category: "data_lookup",
            meaningResolution: {
              interpretedQuestion: request.question,
              questionType: "lookup",
              selectedConceptIds: [selectedEvidenceId],
              recommendedExecutionId: selectedEvidenceId,
              queryIntent: { measures: [selectedEvidenceId], dimensions: [], filters: [] },
              rejectedCandidates: [],
              confidence: "high",
              missingInformation: [],
              recommendedRoute: "semantic",
            },
          };
        },
      },
      executors: {
        semantic_answer: ({ request }) => {
          executedQuestion = request.question;
          executedEvidenceId = request.selectedEvidenceId;
          return { answer: "Total CCU count is 42." };
        },
      },
    });

    const run = await engine.run({
      question: "Total CCU Count",
      selectedEvidenceId,
      conversationContext: {
        serverSnapshot: {
          recentTurns: [{
            question: "What is the total CCU count?",
            answerSummary: "Which total CCU count meaning do you want?",
            route: "clarify",
          }],
        },
      },
    });

    expect(routedQuestion).toBe("What is the total CCU count?");
    expect(executedQuestion).toBe("What is the total CCU count?");
    expect(routedEvidenceId).toBe(selectedEvidenceId);
    expect(executedEvidenceId).toBe(selectedEvidenceId);
    expect(run.question).toBe("Total CCU Count");
    expect(run.route).toBe("semantic_answer");
    expect(run.answer).toBe("Total CCU count is 42.");
  });

  it("AGT-011 returns identifier-bound options with a hard clarification", async () => {
    const clarificationOptions = [{
      id: "semantic:metric:orders.total_revenue",
      label: "Total Revenue",
      description: "Recognized order revenue.",
      kind: "semantic_metric",
    }];
    const engine = new AgentRunEngine({
      idGenerator: () => "run-structured-options",
      now: fixedClock(),
      router: {
        decide: () => ({
          action: "clarify",
          confidence: 0.7,
          reason: "Two governed meanings are materially different.",
          requiresClarification: true,
          clarifyingQuestion: "Which revenue meaning do you want?",
          clarificationOptions,
        }),
      },
    });

    const run = await engine.run({ question: "What is revenue?" });

    expect(run.status).toBe("needs_clarification");
    expect(run.clarificationOptions).toEqual(clarificationOptions);
  });

  it("AGT-014 preserves entity-path options discovered by the selected semantic executor", async () => {
    const clarificationOptions = [{
      id: "semantic-path:report_date:bcm_ccu_pc",
      label: "Use Report Date via bcm_ccu_pc",
      question: "Who are the top customers and what is their BCM this month?",
      kind: "semantic_entity_path",
    }];
    const engine = new AgentRunEngine({
      idGenerator: () => "run-runtime-path-options",
      now: fixedClock(),
      router: {
        decide: () => ({
          action: "answer",
          confidence: 0.9,
          reason: "A governed semantic metric and dimension were resolved.",
          requiresClarification: false,
          meaningResolution: {
            interpretedQuestion: "Who are the top customers and what is their BCM this month?",
            questionType: "ranking",
            selectedConceptIds: ["semantic:metric:total_bcm"],
            recommendedExecutionId: "semantic:metric:total_bcm",
            queryIntent: { measures: ["total_bcm"], dimensions: ["customer"], filters: [] },
            rejectedCandidates: [],
            confidence: "high",
            missingInformation: [],
            recommendedRoute: "semantic",
          },
          resolvedAnalyticalPlan: {
            mode: 'authoritative',
            capability: 'semantic_execution',
            planId: 'rap:total-bcm-customer-month',
            fingerprint: 'sha256:total-bcm-customer-month',
          } as IntentDecision['resolvedAnalyticalPlan'],
        }),
      },
      executors: {
        semantic_answer: () => ({
          status: "needs_clarification",
          trustState: "not_applicable",
          stopReason: "needs_clarification",
          answerRefusalCode: "ambiguous",
          answer: "Choose the governed entity path for Report Date.",
          clarificationOptions,
        }),
      },
    });

    const run = await engine.run({ question: "Who are the top customers and what is their BCM this month?" });

    expect(run.status).toBe("needs_clarification");
    expect(run.clarificationOptions).toEqual(clarificationOptions);
  });

  it("fails closed before a legacy generator can reinterpret a consumed structured choice", async () => {
    const selectedEvidenceId = "semantic:metric:sales.lost_opportunities_count";
    const repeatedOptions = [{
      id: selectedEvidenceId,
      label: "Lost Opportunities Count",
      kind: "semantic_metric",
    }];
    let generatedCalls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => "run-no-repeated-clarification",
      now: fixedClock(),
      router: {
        decide: () => ({
          action: "answer",
          confidence: 0.8,
          reason: "Continue the governed cascade after consuming the selected identity.",
          source: "heuristic",
          category: "data_lookup",
        }),
      },
      executors: {
        generated_answer: () => {
          generatedCalls += 1;
          return {
            status: "needs_clarification",
            trustState: "not_applicable",
            stopReason: "needs_clarification",
            answerRefusalCode: "ambiguous",
            answer: "Which governed metric should I use?",
            clarificationOptions: repeatedOptions,
          };
        },
      },
    });

    const run = await engine.run({
      question: "Lost Opportunities Count",
      selectedEvidenceId,
    });

    expect(run.status).toBe("blocked");
    expect(run.trustState).toBe("blocked");
    expect(generatedCalls).toBe(0);
    expect(run.clarificationOptions).toBeUndefined();
    expect(run.answer).toContain("could not freeze an exact analytical plan");
  });
});

describe("selectRoute", () => {
  it("uses the authoritative plan capability instead of the legacy recommended route", () => {
    const decision = {
      action: 'answer',
      confidence: 0.9,
      reason: 'Resolved.',
      followsUp: false,
      meaningResolution: {
        interpretedQuestion: 'Revenue by customer',
        questionType: 'ranking',
        selectedConceptIds: ['dbt:column:orders.amount'],
        queryIntent: { measures: ['revenue'], dimensions: ['customer'], filters: [] },
        rejectedCandidates: [],
        confidence: 'high',
        missingInformation: [],
        recommendedRoute: 'semantic',
      },
      resolvedAnalyticalPlan: {
        mode: 'authoritative',
        capability: 'governed_relational',
      } as IntentDecision['resolvedAnalyticalPlan'],
    } satisfies IntentDecision;
    expect(selectRoute({ question: 'Revenue by customer' }, decision)).toBe('generated_answer');
    expect(selectRoute({ question: 'Revenue by customer', requestedMode: 'research' }, decision)).toBe('research');
  });

  it("uses explicit mode before heuristics", () => {
    const decision = decideAgentAction({
      question: "build a dashboard but just give SQL",
      intent: "ad_hoc_ranking",
      signals: { certifiedScore: 0.9 },
    });
    expect(selectRoute({ question: "build a dashboard but just give SQL", requestedMode: "sql" }, decision)).toBe("sql_cell");
  });

  it("routes a conversational turn to the conversation route before authoring regexes", () => {
    const decision = decideAgentAction({ question: "hi", intent: "clarify" });
    expect(decision.action).toBe("converse");
    expect(selectRoute({ question: "hi" }, decision)).toBe("conversation");
  });
});

describe("AgentRunEngine — conversation route", () => {
  it("completes a conversational run with no governance chrome and no trust badge", async () => {
    const store = new InMemoryAgentRunStore();
    const engine = new AgentRunEngine({
      store,
      idGenerator: () => "run-converse",
      now: fixedClock(),
      executors: {
        conversation: () => ({
          answer: "Hi! I answer questions about your data.",
          answerKind: "conversational",
          status: "completed",
          trustState: "not_applicable",
          stopReason: "conversational_reply",
          artifacts: [],
          evaluations: [],
          nextActions: [{ id: "suggest-question-1", label: "What is total revenue?" }],
        }),
      },
    });
    const run = await engine.run({ question: "hi" });
    expect(run).toMatchObject({
      route: "conversation",
      status: "completed",
      trustState: "not_applicable",
      stopReason: "conversational_reply",
      answerKind: "conversational",
      answer: "Hi! I answer questions about your data.",
    });
    expect(run.artifacts).toHaveLength(0);
    expect(run.evaluations).toHaveLength(0);
    expect(run.nextActions[0]).toMatchObject({ id: "suggest-question-1" });
  });

  it("passes conversation through for a stakeholder audience", async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => "run-converse-stakeholder",
      now: fixedClock(),
      executors: {
        conversation: () => ({ answer: "Hello!", answerKind: "conversational", status: "completed", trustState: "not_applicable", evaluations: [] }),
      },
    });
    const run = await engine.run({ question: "hello", audience: "stakeholder" });
    expect(run.route).toBe("conversation");
    expect(run.status).toBe("completed");
  });

  it.each([
    "what we are talking about here?",
    "what we are reviewing in this chat",
    "what are we revewing and discussing in whole conversaion?",
  ])("routes Ask-mode conversation recap '%s' to conversation when context exists", async (question) => {
    const engine = new AgentRunEngine({
      idGenerator: () => "run-context-recap",
      now: fixedClock(),
      executors: {
        conversation: ({ request }) => ({
          answer: `We were talking about ${request.conversationContext?.sourceQuestion}.`,
          answerKind: "conversational",
          status: "completed",
          trustState: "not_applicable",
          evaluations: [],
        }),
      },
    });

    const run = await engine.run({
      question,
      requestedMode: "ask",
      conversationContext: {
        sourceQuestion: "Top products by revenue",
        resultColumns: ["product_name", "category", "revenue"],
      },
    });

    expect(run.route).toBe("conversation");
    expect(run.answerKind).toBe("conversational");
    expect(run.answer).toContain("Top products by revenue");
    expect(run.artifacts).toHaveLength(0);
  });

  it("does not let an injected conversational decision bypass an analytical RAP boundary", async () => {
    let conversationCalls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => "run-router",
      now: fixedClock(),
      router: { decide: () => ({ action: "converse", confidence: 0.99, reason: "router says hi", conversationalKind: "greeting", followsUp: false }) },
      executors: {
        conversation: () => { conversationCalls += 1; return { answer: "routed reply", answerKind: "conversational", status: "completed", trustState: "not_applicable", evaluations: [] }; },
      },
    });
    // A question the deterministic tier would send to the data cascade, forced to converse by the router.
    const run = await engine.run({ question: "what is total revenue?", signals: { certifiedScore: 0.9 } });
    expect(conversationCalls).toBe(0);
    expect(run.route).toBe("blocked");
    expect(run.answer).toContain('could not freeze an exact analytical plan');
  });

  it("runs retrieval-first routing for Ask mode before selecting the governed executor", async () => {
    let routerCalls = 0;
    let semanticCalls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => "run-ask-router",
      now: fixedClock(),
      router: {
        decide: () => {
          routerCalls += 1;
          return {
            action: "answer",
            confidence: 0.9,
            reason: "Resolved against a semantic metric.",
            followsUp: false,
            meaningResolution: {
              interpretedQuestion: "Monthly rollover balance by customer",
              questionType: "ranking",
              selectedConceptIds: ["semantic:rollover_balance_amount"],
              recommendedExecutionId: "semantic:rollover_balance_amount",
              queryIntent: { measures: ["rollover_balance_amount"], dimensions: ["customer"], filters: [] },
              rejectedCandidates: [],
              confidence: "high",
              missingInformation: [],
              recommendedRoute: "semantic",
            },
          };
        },
      },
      executors: {
        semantic_answer: () => {
          semanticCalls += 1;
          return {
            answer: "Resolved semantic answer.",
            answerTier: "semantic_metric",
          };
        },
      },
    });

    const run = await engine.run({ question: "monthly rollover balance", requestedMode: "ask" });

    expect(routerCalls).toBe(1);
    expect(semanticCalls).toBe(0);
    expect(run.route).toBe("blocked");
  });

  it("falls back to deterministic routing when the router throws", async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => "run-router-throws",
      now: fixedClock(),
      router: { decide: () => { throw new Error("router down"); } },
      executors: {
        conversation: () => ({ answer: "hi", answerKind: "conversational", status: "completed", trustState: "not_applicable", evaluations: [] }),
      },
    });
    const run = await engine.run({ question: "hi" });
    expect(run.route).toBe("conversation");
  });

  it('persists additive content-free V2 telemetry while retaining the V1 receipt', async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-telemetry',
      now: fixedClock(),
      planner: fixedRoutePlanner('generated_answer'),
      executors: {
        generated_answer: () => ({
          answer: 'done',
          status: 'needs_review',
          trustState: 'review_required',
          telemetry: {
            version: 1,
            stageDurationsMs: { retrieval: 12, execution: 8, total: 30 },
            providerRoundTrips: 1,
            toolCalls: 2,
            sqlExecutions: 1,
            repairs: 0,
            egressReceipts: 1,
            warehouseDurationMs: 8,
          },
          providerEgressReceipts: [{
            version: 1,
            purpose: 'answer_generation',
            provider: 'test',
            permittedCategories: ['question'],
            resultRowCount: 0,
            columnCount: 0,
            redactionPolicyId: 'zero-result-rows-v1',
            optIn: false,
            payloadFingerprint: 'a'.repeat(64),
          }],
        }),
      },
    });
    const run = await engine.run({ question: 'revenue', requestedMode: 'ask' });
    expect(run.diagnosticReceipt?.version).toBe(1);
    expect(run.diagnosticReceiptV2).toMatchObject({
      version: 2,
      runId: 'run-telemetry',
      telemetry: {
        providerRoundTrips: 1,
        toolCalls: 2,
        sqlExecutions: 1,
        egressReceipts: 1,
        warehouseDurationMs: 8,
      },
      providerEgressReceiptFingerprints: [expect.stringMatching(/^[a-f0-9]{64}$/)],
    });
    expect(JSON.stringify(run.diagnosticReceiptV2)).not.toContain('done');
    expect(JSON.stringify(run.diagnosticReceiptV2)).not.toContain('rows');
  });

  it('persists physical dispatch evidence when the executor throws after send', async () => {
    const receipt = {
      version: 1 as const,
      purpose: 'answer_generation' as const,
      provider: 'openai',
      permittedCategories: ['question' as const],
      resultRowCount: 0,
      columnCount: 0,
      redactionPolicyId: 'no-result-rows-v1',
      optIn: false,
      payloadFingerprint: `sha256:${'a'.repeat(64)}`,
    };
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-failed-dispatch-evidence',
      now: fixedClock(),
      planner: fixedRoutePlanner('generated_answer'),
      executors: {
        generated_answer: () => {
          throw Object.assign(new Error('provider failed after send'), {
            providerDispatchEvidence: {
              providerEgressReceipts: [receipt],
              providerRoundTrips: 1,
              toolCalls: 0,
              sqlExecutions: 0,
              repairs: 0,
              fallbackReason: 'provider_error',
            },
          });
        },
      },
    });
    const run = await engine.run({ question: 'revenue', requestedMode: 'ask' });
    expect(run.status).toBe('blocked');
    expect(run.providerEgressReceipts).toEqual([receipt]);
    expect(run.telemetry).toMatchObject({ providerRoundTrips: 1, egressReceipts: 1, fallbackReason: 'provider_error' });
    expect(run.diagnosticReceiptV2).toMatchObject({
      telemetry: { providerRoundTrips: 1, egressReceipts: 1 },
      providerEgressReceiptFingerprints: [expect.stringMatching(/^[a-f0-9]{64}$/)],
    });
  });

  it('retains physical dispatch evidence on cancellation after send', async () => {
    const cancellation = Object.assign(new DOMException('cancelled after send', 'AbortError'), {
      providerDispatchEvidence: {
        providerEgressReceipts: [{
          version: 1,
          purpose: 'answer_generation',
          provider: 'ollama',
          permittedCategories: ['question'],
          resultRowCount: 0,
          columnCount: 0,
          redactionPolicyId: 'no-result-rows-v1',
          optIn: false,
          payloadFingerprint: `sha256:${'b'.repeat(64)}`,
        }],
        providerRoundTrips: 1,
        toolCalls: 0,
        sqlExecutions: 0,
        repairs: 0,
        fallbackReason: 'cancelled',
      },
    });
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-cancelled-dispatch-evidence',
      now: fixedClock(),
      planner: fixedRoutePlanner('generated_answer'),
      executors: { generated_answer: () => { throw cancellation; } },
    });
    const run = await engine.run({ question: 'revenue', requestedMode: 'ask' });
    expect(run.telemetry).toMatchObject({ providerRoundTrips: 1, egressReceipts: 1, fallbackReason: 'cancelled' });
    expect(run.providerEgressReceipts).toHaveLength(1);
  });

  it('applies one 45s/120s hard deadline with deterministic route soft targets', async () => {
    expect(agentRequestDeadlineMs('ask')).toBe(45_000);
    expect(agentRequestDeadlineMs('research')).toBe(120_000);
    expect(agentRouteDeadlineMs('certified_answer')).toBe(5_000);
    expect(agentRouteDeadlineMs('semantic_answer')).toBe(5_000);
    expect(agentRouteDeadlineMs('generated_answer')).toBe(15_000);
    expect(agentRouteDeadlineMs('research')).toBe(120_000);
    const observed: number[] = [];
    const controller = new AbortController();
    controller.abort(new DOMException('route deadline', 'TimeoutError'));
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-route-deadline',
      now: fixedClock(),
      planner: fixedRoutePlanner('generated_answer'),
      routeTimeoutSignal: (durationMs) => {
        observed.push(durationMs);
        return controller.signal;
      },
      executors: {
        generated_answer: ({ request }) => {
          if (request.signal?.aborted) throw request.signal.reason;
          return { answer: 'unreachable' };
        },
      },
    });
    const run = await engine.run({ question: 'revenue', requestedMode: 'ask' });
    expect(observed).toEqual([45_000]);
    expect(run).toMatchObject({
      status: 'blocked',
      trustState: 'blocked',
      diagnosticReceiptV2: { telemetry: { fallbackReason: 'executor_failure' } },
    });
    expect(run.summary).toContain('time limit');
  });

  it('accepts a frozen semantic result after its 5s soft target but before the 45s hard ceiling', async () => {
    let nowMs = 0;
    const budget = createAgentRunBudget({
      requestedMode: 'ask', startedAtMs: 0, nowMs: () => nowMs,
      timeoutSignal: () => new AbortController().signal,
    });
    const decision = {
      action: 'answer', confidence: 1, reason: 'exact semantic binding', followsUp: false,
      resolvedAnalyticalPlan: { mode: 'authoritative', capability: 'semantic_execution' } as never,
    } satisfies IntentDecision;
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-late-frozen-semantic',
      now: () => new Date(nowMs),
      router: { decide: async () => decision },
      planner: fixedRoutePlanner('semantic_answer'),
      executors: { semantic_answer: () => {
        nowMs = 6_000;
        return { answer: 'Validated late semantic result.' };
      } },
    });
    const run = await engine.run({ question: 'revenue', requestedMode: 'ask', runBudget: budget });
    expect(run.answer).toBe('Validated late semantic result.');
    expect(run.status).not.toBe('needs_clarification');
  });

  it('refuses a new ordinary analytical branch after its soft target when no plan is frozen', async () => {
    let nowMs = 16_000;
    const budget = createAgentRunBudget({
      requestedMode: 'ask', startedAtMs: 0, nowMs: () => nowMs,
      timeoutSignal: () => new AbortController().signal,
    });
    let executions = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-soft-refusal', now: () => new Date(nowMs),
      router: { decide: async () => ({ action: 'answer', confidence: 0.5, reason: 'no frozen plan', followsUp: false }) },
      planner: fixedRoutePlanner('generated_answer'),
      executors: { generated_answer: () => { executions += 1; return { answer: 'must not run' }; } },
    });
    const run = await engine.run({ question: 'unknown metric', requestedMode: 'ask', runBudget: budget });
    expect(executions).toBe(0);
    expect(run.status).toBe('needs_clarification');
    expect(run.answer).toContain('discovery window ended');
  });

  it('stops new Research branches at 90s while retaining a validated partial executor result', async () => {
    let nowMs = 89_000;
    const budget = createAgentRunBudget({
      requestedMode: 'research', startedAtMs: 0, nowMs: () => nowMs,
      timeoutSignal: () => new AbortController().signal,
    });
    let calls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-research-soft', now: () => new Date(nowMs),
      router: { decide: async () => ({ action: 'investigate', confidence: 0.8, reason: 'explicit research', followsUp: false }) },
      planner: fixedRoutePlanner('research'),
      executors: { research: () => {
        calls += 1;
        nowMs = 91_000;
        return { answer: 'Validated partial finding.', artifacts: [{ id: 'partial', kind: 'research_run', title: 'Partial', trustState: 'review_required', payload: { limitations: ['branch budget ended'] } }] };
      } },
    });
    const run = await engine.run({ question: 'research revenue', requestedMode: 'research', runBudget: budget });
    expect(calls).toBe(1);
    expect(run.answer).toBe('Validated partial finding.');
    expect(budget.mayStartDiscovery('research')).toBe(false);
    expect(run.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'partial' })]));
  });

  it('starts the absolute deadline before a router that ignores AbortSignal', async () => {
    const deadline = new AbortController();
    deadline.abort(new DOMException('request deadline', 'TimeoutError'));
    const observed: number[] = [];
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-routing-deadline',
      router: { decide: async () => new Promise<IntentDecision>(() => {}) },
      routeTimeoutSignal: (durationMs) => {
        observed.push(durationMs);
        return deadline.signal;
      },
    });
    const run = await engine.run({ question: 'revenue', requestedMode: 'ask' });
    expect(observed).toEqual([45_000]);
    expect(run).toMatchObject({ status: 'blocked', trustState: 'blocked' });
    expect(run.answer).toBeUndefined();
  });

  it('uses the typed modeling outcome instead of the generic blocked fallback', async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-typed-modeling-gap',
      now: fixedClock(),
      router: {
        decide: () => ({
          action: 'block', confidence: 1, followsUp: false, source: 'heuristic',
          reason: 'The selected metric does not model a reachable workspace grouping.',
          terminalOutcome: {
            kind: 'modeling_gap',
            code: 'ANALYTICAL_MODELING_GAP',
            message: 'The selected metric does not model a reachable workspace grouping.',
            candidateIds: [],
          },
        }),
      },
    });
    const run = await engine.run({ question: 'Rank workspaces by cost', requestedMode: 'ask' });
    expect(run).toMatchObject({
      status: 'blocked',
      summary: 'The selected metric does not model a reachable workspace grouping.',
    });
    expect(run.summary).not.toBe('Agent run is blocked.');
  });

  it('rejects a late executor success even when the executor ignores AbortSignal', async () => {
    const controller = new AbortController();
    let complete!: (value: AgentRouteExecutorResult) => void;
    const ignoredSignalWork = new Promise<AgentRouteExecutorResult>((resolve) => { complete = resolve; });
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-ignored-signal',
      now: fixedClock(),
      planner: fixedRoutePlanner('generated_answer'),
      routeTimeoutSignal: () => controller.signal,
      executors: { generated_answer: () => ignoredSignalWork },
    });
    const pending = engine.run({ question: 'revenue', requestedMode: 'ask' });
    await Promise.resolve();
    controller.abort(new DOMException('route deadline', 'TimeoutError'));
    complete({ answer: 'late success must not persist' });
    const run = await pending;
    expect(run).toMatchObject({ status: 'blocked', trustState: 'blocked' });
    expect(run.answer).toBeUndefined();
    expect(JSON.stringify(run)).not.toContain('late success must not persist');
  });

  it('uses one absolute deadline across planning and execution', async () => {
    const epoch = Date.parse('2026-06-29T00:00:00.000Z');
    let elapsedMs = 0;
    const observed: number[] = [];
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-absolute-deadline',
      now: () => new Date(epoch + elapsedMs),
      router: {
        decide: () => {
          elapsedMs = 10_000;
          return { action: 'answer', confidence: 1, reason: 'generated', followsUp: false, source: 'heuristic' };
        },
      },
      planner: {
        plan: ({ request, routeDecision }) => {
          elapsedMs = 12_000;
          return {
            source: 'deterministic' as const,
            rationale: routeDecision.reason,
            steps: [{ id: 'step-1', route: 'generated_answer' as const, goal: request.question, successCriteria: [] }],
          };
        },
        replan: () => ({ decision: 'accept' }),
      },
      routeTimeoutSignal: (durationMs) => {
        observed.push(durationMs);
        return new AbortController().signal;
      },
      executors: { generated_answer: () => ({ answer: 'within remaining budget' }) },
    });
    const run = await engine.run({ question: 'revenue', requestedMode: 'ask' });
    expect(run.status).not.toBe('blocked');
    expect(observed).toEqual([45_000]);
  });

  it('keeps an already-aborted cancellation terminal during routing', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('cancelled', 'AbortError'));
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-routing-cancelled',
      now: fixedClock(),
      router: { decide: async () => new Promise<IntentDecision>(() => {}) },
    });
    const run = await engine.run({ question: 'revenue', requestedMode: 'ask', signal: controller.signal });
    expect(run).toMatchObject({ status: 'blocked', trustState: 'blocked' });
    expect(run.answer).toBeUndefined();
  });
});

function fixedClock(): () => Date {
  return () => new Date("2026-06-29T00:00:00.000Z");
}

function authoritativeDecision(
  capability: 'certified_execution' | 'semantic_execution' | 'governed_relational' | 'bounded_exploration',
): IntentDecision {
  return {
    action: 'answer',
    confidence: 1,
    reason: 'Exact immutable analytical plan.',
    followsUp: false,
    source: 'heuristic',
    resolvedAnalyticalPlan: {
      mode: 'authoritative',
      capability,
      planId: `rap:test:${capability}`,
      fingerprint: `sha256:test:${capability}`,
    } as IntentDecision['resolvedAnalyticalPlan'],
  };
}

function fixedRoutePlanner(route: AgentRunRoute): AgentRunPlanner {
  return {
    plan: ({ request, routeDecision }) => ({
      source: "deterministic",
      rationale: routeDecision.reason,
      steps: [{
        id: "step-1",
        route,
        goal: request.question,
        successCriteria: [],
      }],
    }),
    replan: ({ currentStep }) => {
      const failing = currentStep.evaluations.find((evaluation) => !evaluation.passed && evaluation.suggestedRepair);
      if (failing?.repairAction?.kind === "escalate") {
        return {
          decision: "escalate",
          route: failing.repairAction.route,
          repairHint: failing.repairAction.hint ?? failing.suggestedRepair,
        };
      }
      return failing?.suggestedRepair
        ? { decision: "repair", repairHint: failing.suggestedRepair }
        : { decision: "accept" };
    },
  };
}
