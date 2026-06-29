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
  type AgentRunEvent,
} from "./agent-run-engine.js";
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
      "route.decided",
      "executor.started",
      "evaluation.recorded",
      "artifact.created",
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
