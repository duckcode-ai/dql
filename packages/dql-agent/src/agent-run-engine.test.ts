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
  type AgentRouteExecutorResult,
  type AgentRunEvent,
  type AgentRunPlanner,
} from "./agent-run-engine.js";
import { defaultAgentRunGates } from "./agent-run-gates.js";
import { decideAgentAction } from "./intent-controller.js";

describe("AgentRunEngine", () => {
  it("routes a confident certified match to a completed certified answer run", async () => {
    const store = new InMemoryAgentRunStore();
    const events: AgentRunEvent[] = [];
    const engine = new AgentRunEngine({
      store,
      idGenerator: () => "run-certified",
      now: fixedClock(),
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
      signals: { certifiedScore: 0.9, hasRetrieval: true },
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
    expect(run.nextActions.map((action) => action.id)).toEqual(["insert-sql", "create-block"]);
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
    expect(run.steps[0]?.attempts).toBe(2);
    expect(run.steps[0]?.status).toBe("repaired");
    expect(events.map((event) => event.type)).toContain("repair.attempted");
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
    expect(run.repairAttempts).toBe(1);
    expect(events.map((event) => event.type)).toContain("escalated");
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

  it("keeps the analyst default (clarify) untouched", async () => {
    const engine = new AgentRunEngine({ idGenerator: () => "run-analyst-clarify", now: fixedClock() });
    const run = await engine.run({ question: "what is total revenue?", intent: "ad_hoc_ranking", audience: "analyst" });
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
});

function fixedClock(): () => Date {
  return () => new Date("2026-06-29T00:00:00.000Z");
}
