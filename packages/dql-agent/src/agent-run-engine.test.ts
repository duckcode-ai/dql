import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRunEngine,
  FileAgentRunStore,
  InMemoryAgentRunStore,
  defaultAgentRunStorePath,
  selectRoute,
  routeReasoningEffort,
  type AgentRouteExecutorResult,
  type AgentRunEvent,
  type AgentRunPlanner,
  type AgentRunRoute,
} from "./agent-run-engine.js";
import { defaultAgentRunGates } from "./agent-run-gates.js";
import { decideAgentAction } from "./intent-controller.js";

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

describe("AgentRunEngine", () => {
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
    }, (event) => events.push(event));

    expect(run).toMatchObject({
      id: "run-certified",
      route: "certified_answer",
      status: "completed",
      trustState: "certified",
      stopReason: "certified_answer_found",
      answer: "Revenue is $2.8M.",
    });
    expect(run.artifacts[0]).toMatchObject({ kind: "answer", trustState: "certified" });
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
    expect(store.get("run-certified")?.route).toBe("certified_answer");
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

  it("escalates a model_declined generated answer to research instead of dead-ending (P1)", async () => {
    const events: AgentRunEvent[] = [];
    let generatedCalls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => "run-declined-escalate",
      now: fixedClock(),
      planner: fixedRoutePlanner("generated_answer"),
      gates: defaultAgentRunGates,
      executors: {
        // Mirrors the real local-runtime answerRunExecutor for a model_declined
        // refusal: non-empty apology prose, the refusal code surfaced, and a blocking
        // escalate-to-research evaluation. Previously this dead-ended as needs_clarification.
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
              severity: "blocking",
              message: "Declined despite context.",
              suggestedRepair: "Investigate the join path and compose a query.",
              repairAction: { kind: "escalate", route: "research", hint: "Investigate the join path and compose a query." },
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
    expect(run.escalationAttempts).toBe(1);
    expect(run.steps.map((step) => step.route)).toEqual(["generated_answer", "research"]);
    expect(run.stopReason).not.toBe("needs_clarification");
    expect(events.some((event) =>
      event.type === "escalated"
      && (event.payload as { route?: string })?.route === "research"
    )).toBe(true);
  });

  it("opens research as review-required durable work for investigate requests", async () => {
    const engine = new AgentRunEngine({ idGenerator: () => "run-research", now: fixedClock() });
    const run = await engine.run({
      question: "why is revenue down by segment?",
      intent: "diagnose_change",
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

  it("separates generated answers from explicit SQL-cell artifacts", async () => {
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

    expect(generated.route).toBe("generated_answer");
    expect(generated.artifacts[0]?.kind).toBe("answer");
    expect(generated.trustState).toBe("review_required");
    expect(sqlCell.route).toBe("sql_cell");
    expect(sqlCell.artifacts[0]?.kind).toBe("sql_cell");
    expect(sqlCell.stopReason).toBe("artifact_created");
  });

  it("finalizes the run route from an executor-resolved cascade route", async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => "run-resolved-certified",
      now: fixedClock(),
      executors: {
        generated_answer: () => ({
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
        }),
      },
    });

    const run = await engine.run({ question: "what is total revenue?", requestedMode: "ask" });

    expect(run.route).toBe("certified_answer");
    expect(run.status).toBe("completed");
    expect(run.trustState).toBe("certified");
    expect(run.steps[0]?.route).toBe("generated_answer");
    expect(run.steps[0]?.resolvedRoute).toBe("certified_answer");
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
    expect(run.artifacts).toHaveLength(0);
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

    const run = await engine.run({ question: "include product supply details", requestedMode: "ask" }, (event) => events.push(event));

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

  it("escalates a generated answer with no grounding to research", async () => {
    const events: AgentRunEvent[] = [];
    const engine = new AgentRunEngine({
      idGenerator: () => "run-escalate",
      now: fixedClock(),
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

    expect(run.route).toBe("research");
    expect(run.steps).toHaveLength(2);
    expect(run.steps[0]?.status).toBe("escalated");
    expect(run.steps[1]?.route).toBe("research");
    expect(run.repairAttempts).toBe(0);
    expect(run.escalationAttempts).toBe(1);
    expect(run.budgetUsage?.usage).toMatchObject({
      laneExecutionAttemptsUsed: 0,
      engineEscalationsUsed: 1,
    });
    expect(events.map((event) => event.type)).toContain("escalated");
  });

  it("does not run an escalation after the engine escalation budget is exhausted", async () => {
    let researchCalls = 0;
    const events: AgentRunEvent[] = [];
    const engine = new AgentRunEngine({
      idGenerator: () => "run-escalation-budget",
      now: fixedClock(),
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
    expect(run.status).toBe("blocked");
    expect(run.repairAttempts).toBe(0);
    expect(run.escalationAttempts).toBe(0);
    expect(run.budgetUsage?.limits.engineEscalations).toBe(0);
    expect(events.some((event) =>
      event.type === "escalated"
      && event.message.includes("budget exhausted")
    )).toBe(true);
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

  it("escalates a stakeholder app-coverage gap to research, not a block draft", async () => {
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
    expect(run.route).toBe("research");
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

describe("selectRoute", () => {
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

  it("routes Ask-mode conversation recap questions to conversation when context exists", async () => {
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
      question: "what we are talking about here?",
      requestedMode: "ask",
      conversationContext: {
        sourceQuestion: "Top products by revenue",
        resultColumns: ["product_name", "category", "revenue"],
      },
    });

    expect(run.route).toBe("conversation");
    expect(run.answerKind).toBe("conversational");
    expect(run.answer).toContain("Top products by revenue");
  });

  it("prefers an injected router decision over the deterministic path", async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => "run-router",
      now: fixedClock(),
      router: { decide: () => ({ action: "converse", confidence: 0.99, reason: "router says hi", conversationalKind: "greeting", followsUp: false }) },
      executors: {
        conversation: () => ({ answer: "routed reply", answerKind: "conversational", status: "completed", trustState: "not_applicable", evaluations: [] }),
      },
    });
    // A question the deterministic tier would send to the data cascade, forced to converse by the router.
    const run = await engine.run({ question: "what is total revenue?", signals: { certifiedScore: 0.9 } });
    expect(run.route).toBe("conversation");
    expect(run.answer).toBe("routed reply");
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
});

function fixedClock(): () => Date {
  return () => new Date("2026-06-29T00:00:00.000Z");
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
