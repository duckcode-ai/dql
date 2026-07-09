import { describe, expect, it } from "vitest";
import { defaultAgentRunGates } from "./agent-run-gates.js";
import type { AgentRouteExecutorResult, AgentRunGateContext, AgentRunRoute } from "./agent-run-engine.js";

function gateFor(route: AgentRunRoute, result: AgentRouteExecutorResult, attempt = 0) {
  const gate = defaultAgentRunGates[route];
  if (!gate) throw new Error(`no gate for ${route}`);
  const context: AgentRunGateContext = { route, request: { question: "q" }, result, attempt };
  return gate(context);
}

describe("defaultAgentRunGates", () => {
  it("answer gate flags a preview execution error as a retry", () => {
    const evaluations = gateFor("generated_answer", {
      answer: "Here is the result.",
      artifacts: [{ id: "a", kind: "answer", title: "Answer", trustState: "review_required", payload: { executionError: "no such column: foo" } }],
    });
    const exec = evaluations.find((evaluation) => evaluation.id === "execution-error");
    expect(exec?.passed).toBe(false);
    expect(exec?.repairAction?.kind).toBe("retry");
    expect(exec?.suggestedRepair).toBeTruthy();
  });

  it("answer gate escalates an empty answer to research", () => {
    const evaluations = gateFor("generated_answer", { answer: "", artifacts: [] });
    const grounding = evaluations.find((evaluation) => evaluation.id === "grounding");
    expect(grounding?.passed).toBe(false);
    expect(grounding?.severity).toBe("blocking");
    expect(grounding?.repairAction).toMatchObject({ kind: "escalate", route: "research" });
  });

  it("answer gate escalates a model_declined refusal that carries prose text to research (P1)", () => {
    // The refusal has non-empty explanatory prose in `answer`, which the old
    // `hasAnswer` check treated as a completed answer — dead-ending the run. With the
    // refusal code surfaced, the gate now treats it as no-answer and escalates.
    const evaluations = gateFor("generated_answer", {
      answer: "I could not compose a governed query for this from the available tables and metrics.",
      answerRefusalCode: "model_declined",
      artifacts: [],
    });
    const grounding = evaluations.find((evaluation) => evaluation.id === "grounding");
    expect(grounding?.passed).toBe(false);
    expect(grounding?.repairAction).toMatchObject({ kind: "escalate", route: "research" });
  });

  it("answer gate does NOT add a duplicate escalation when the executor already attached one (P1)", () => {
    // In the real app path the executor attaches `declined-despite-context`; the gate
    // backstop must not pile a second escalate eval on top of it.
    const evaluations = gateFor("generated_answer", {
      answer: "I could not compose a governed query.",
      answerRefusalCode: "model_declined",
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
    });
    expect(evaluations.filter((evaluation) => evaluation.id === "grounding")).toHaveLength(0);
    expect(evaluations.filter((evaluation) => !evaluation.passed && evaluation.repairAction?.kind === "escalate")).toHaveLength(1);
  });

  it("answer gate still ACCEPTS an ambiguous refusal as a genuine clarify (no escalation)", () => {
    // `ambiguous` is a real "the user must clarify" case — it must not be escalated.
    const evaluations = gateFor("generated_answer", {
      answer: "Which revenue measure did you mean — gross or net?",
      answerRefusalCode: "ambiguous",
      artifacts: [],
    });
    expect(evaluations.some((evaluation) => evaluation.id === "grounding")).toBe(false);
  });

  it("answer gate accepts a grounded answer with no execution error", () => {
    const evaluations = gateFor("certified_answer", {
      answer: "Revenue is $2.8M.",
      artifacts: [{ id: "a", kind: "answer", title: "Answer", trustState: "certified", payload: { answer: "Revenue is $2.8M." } }],
      evaluations: [{ id: "trust-boundary", label: "Trust", passed: true, severity: "info", message: "Certified." }],
    });
    expect(evaluations.some((evaluation) => !evaluation.passed && evaluation.suggestedRepair)).toBe(false);
  });

  it("sql cell gate flags a missing SQL as a retry", () => {
    const evaluations = gateFor("sql_cell", {
      artifacts: [{ id: "a", kind: "sql_cell", title: "Cell", trustState: "review_required", payload: {} }],
    });
    const produced = evaluations.find((evaluation) => evaluation.id === "sql-produced");
    expect(produced?.passed).toBe(false);
    expect(produced?.repairAction?.kind).toBe("retry");
  });

  it("semantic gate flags a scalar question that returned many rows (fan-out / missing aggregation)", () => {
    const gate = defaultAgentRunGates.generated_answer!;
    const context: AgentRunGateContext = {
      route: "generated_answer",
      request: { question: "what is total revenue?" },
      result: {
        answer: "Revenue.",
        artifacts: [{ id: "a", kind: "answer", title: "Answer", trustState: "review_required", payload: { answer: "Revenue.", result: { columns: ["revenue"], rows: [{ revenue: 1 }, { revenue: 2 }, { revenue: 3 }], rowCount: 3 } } }],
      },
      attempt: 0,
    };
    const semantic = gate(context).find((evaluation) => evaluation.id === "semantic-cardinality");
    expect(semantic?.passed).toBe(false);
    expect(semantic?.repairAction?.kind).toBe("retry");
  });

  it("semantic gate does NOT flag a breakdown/ranking question that returns many rows", () => {
    const gate = defaultAgentRunGates.generated_answer!;
    const context: AgentRunGateContext = {
      route: "generated_answer",
      request: { question: "who are the top customers?" },
      result: {
        answer: "Top customers.",
        artifacts: [{ id: "a", kind: "answer", title: "Answer", trustState: "review_required", payload: { answer: "Top customers.", result: { columns: ["c"], rows: [{ c: 1 }, { c: 2 }, { c: 3 }], rowCount: 3 } } }],
      },
      attempt: 0,
    };
    expect(gate(context).find((evaluation) => evaluation.id === "semantic-cardinality")).toBeUndefined();
  });

  it("answer-shape gate flags missing requested output columns", () => {
    const gate = defaultAgentRunGates.generated_answer!;
    const context: AgentRunGateContext = {
      route: "generated_answer",
      request: { question: "show revenue by product with product name, category, and revenue" },
      result: {
        answer: "Food and drink revenue.",
        artifacts: [{
          id: "a",
          kind: "answer",
          title: "Answer",
          trustState: "certified",
          payload: {
            answer: "Food and drink revenue.",
            result: { columns: ["category", "revenue"], rows: [{ category: "Food", revenue: 10 }], rowCount: 1 },
          },
        }],
      },
      attempt: 0,
    };
    const shape = gate(context).find((evaluation) => evaluation.id === "answer-shape");
    expect(shape?.passed).toBe(false);
    expect(shape?.message).toContain("product_name");
    expect(shape?.repairAction?.kind).toBe("retry");
  });

  it("certified answer-shape failures escalate to generated answers", () => {
    const gate = defaultAgentRunGates.certified_answer!;
    const context: AgentRunGateContext = {
      route: "certified_answer",
      request: { question: "show revenue by product with product name, category, and revenue" },
      result: {
        answer: "Food and drink revenue.",
        artifacts: [{
          id: "a",
          kind: "answer",
          title: "Answer",
          trustState: "certified",
          payload: {
            answer: "Food and drink revenue.",
            result: { columns: ["category", "revenue"], rows: [{ category: "Food", revenue: 10 }], rowCount: 1 },
          },
        }],
      },
      attempt: 0,
    };
    const shape = gate(context).find((evaluation) => evaluation.id === "answer-shape");
    expect(shape?.passed).toBe(false);
    expect(shape?.message).toContain("product_name");
    expect(shape?.repairAction).toMatchObject({ kind: "escalate", route: "generated_answer" });
  });

  it("answer-shape gate flags untrimmed top-N answers", () => {
    const gate = defaultAgentRunGates.generated_answer!;
    const context: AgentRunGateContext = {
      route: "generated_answer",
      request: { question: "who are the top 2 customers by revenue?" },
      result: {
        answer: "Top customers.",
        artifacts: [{
          id: "a",
          kind: "answer",
          title: "Answer",
          trustState: "review_required",
          payload: {
            answer: "Top customers.",
            result: {
              columns: ["customer_name", "revenue"],
              rows: [{ customer_name: "A", revenue: 3 }, { customer_name: "B", revenue: 2 }, { customer_name: "C", revenue: 1 }],
              rowCount: 3,
            },
          },
        }],
      },
      attempt: 0,
    };
    const topn = gate(context).find((evaluation) => evaluation.id === "answer-topn");
    expect(topn?.passed).toBe(false);
    expect(topn?.repairAction?.kind).toBe("retry");
  });

  it("semantic gate does NOT flag scalar-phrased TIME-SERIES questions (monthly total, month over month)", () => {
    const gate = defaultAgentRunGates.generated_answer!;
    const many = { columns: ["m", "v"], rows: [{ m: 1, v: 1 }, { m: 2, v: 2 }, { m: 3, v: 3 }], rowCount: 12 };
    for (const question of ["what is the monthly total revenue", "what is the daily order count", "what is total revenue month over month", "what is the running total of revenue"]) {
      const context: AgentRunGateContext = {
        route: "generated_answer",
        request: { question },
        result: { answer: "A time series.", artifacts: [{ id: "a", kind: "answer", title: "Answer", trustState: "review_required", payload: { answer: "x", result: many } }] },
        attempt: 0,
      };
      expect(gate(context).find((evaluation) => evaluation.id === "semantic-cardinality"), question).toBeUndefined();
    }
  });

  it("auto-escalates a DEEP analytical ask that returned a single scalar to research", () => {
    const gate = defaultAgentRunGates.generated_answer!;
    const context: AgentRunGateContext = {
      route: "generated_answer",
      request: { question: "why is revenue down this quarter?" },
      routeDecision: { action: "answer", confidence: 0.7, reason: "r", depth: "deep", followsUp: false },
      result: {
        answer: "Revenue is $2.1M.",
        artifacts: [{ id: "a", kind: "answer", title: "Answer", trustState: "review_required", payload: { answer: "Revenue is $2.1M.", result: { columns: ["revenue"], rows: [{ revenue: 2.1 }], rowCount: 1 } } }],
      },
      attempt: 0,
    };
    const completeness = gate(context).find((evaluation) => evaluation.id === "answer-completeness");
    expect(completeness?.passed).toBe(false);
    expect(completeness?.repairAction).toMatchObject({ kind: "escalate", route: "research" });
  });

  it("does NOT escalate a deep ask that already returned a multi-row breakdown", () => {
    const gate = defaultAgentRunGates.generated_answer!;
    const context: AgentRunGateContext = {
      route: "generated_answer",
      request: { question: "why is revenue down by region?" },
      routeDecision: { action: "answer", confidence: 0.7, reason: "r", depth: "deep", followsUp: false },
      result: {
        answer: "Regional breakdown.",
        artifacts: [{ id: "a", kind: "answer", title: "Answer", trustState: "review_required", payload: { answer: "x", result: { columns: ["region", "rev"], rows: [{ region: "A", rev: 1 }, { region: "B", rev: 2 }], rowCount: 2 } } }],
      },
      attempt: 0,
    };
    expect(gate(context).find((evaluation) => evaluation.id === "answer-completeness")).toBeUndefined();
  });

  it("does NOT escalate a QUICK lookup that returned a single scalar", () => {
    const gate = defaultAgentRunGates.generated_answer!;
    const context: AgentRunGateContext = {
      route: "generated_answer",
      request: { question: "what is total revenue?" },
      routeDecision: { action: "answer", confidence: 0.7, reason: "r", depth: "quick", followsUp: false },
      result: {
        answer: "Revenue is $2.1M.",
        artifacts: [{ id: "a", kind: "answer", title: "Answer", trustState: "review_required", payload: { answer: "Revenue is $2.1M.", result: { columns: ["revenue"], rows: [{ revenue: 2.1 }], rowCount: 1 } } }],
      },
      attempt: 0,
    };
    expect(gate(context).find((evaluation) => evaluation.id === "answer-completeness")).toBeUndefined();
  });

  it("semantic gate does NOT second-guess a certified answer resolved via the generated_answer route", () => {
    const gate = defaultAgentRunGates.generated_answer!;
    const context: AgentRunGateContext = {
      route: "generated_answer",
      request: { question: "what is total revenue?" },
      result: {
        answer: "Certified MRR by month.",
        artifacts: [{ id: "a", kind: "answer", title: "Answer", trustState: "certified", payload: { answer: "x", result: { columns: ["m"], rows: [{ m: 1 }, { m: 2 }], rowCount: 12 } } }],
      },
      attempt: 0,
    };
    expect(gate(context).find((evaluation) => evaluation.id === "semantic-cardinality")).toBeUndefined();
  });

  it("block draft gate marks an unready certifier verdict as a repairable warning", () => {
    const evaluations = gateFor("dql_block_draft", {
      artifacts: [{ id: "a", kind: "dql_block_draft", title: "Block", trustState: "review_required", payload: { certifierVerdict: { ready: false } } }],
    });
    const boundary = evaluations.find((evaluation) => evaluation.id === "certification-boundary");
    expect(boundary?.passed).toBe(false);
    expect(boundary?.severity).toBe("warning");
    expect(boundary?.repairAction?.kind).toBe("retry");
  });

  it("app build gate escalates missing coverage to a block draft", () => {
    const evaluations = gateFor("app_build", {
      artifacts: [{ id: "a", kind: "app_draft", title: "App", trustState: "review_required", payload: { session: { status: "needs_coverage" } } }],
    });
    const coverage = evaluations.find((evaluation) => evaluation.id === "app-coverage");
    expect(coverage?.passed).toBe(false);
    expect(coverage?.repairAction).toMatchObject({ kind: "escalate", route: "dql_block_draft" });
  });

  it("app build gate accepts a ready session", () => {
    const evaluations = gateFor("app_build", {
      artifacts: [{ id: "a", kind: "app_draft", title: "App", trustState: "review_required", payload: { session: { status: "ready" } } }],
    });
    expect(evaluations.some((evaluation) => evaluation.id === "app-coverage" && !evaluation.passed)).toBe(false);
  });
});
