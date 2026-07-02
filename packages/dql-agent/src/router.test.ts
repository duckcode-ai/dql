import { describe, expect, it, vi } from "vitest";
import { createHybridRouter } from "./router.js";
import type { AgentRunRequest } from "./agent-run-engine.js";

const ask = (question: string, extra: Partial<AgentRunRequest> = {}): AgentRunRequest => ({ question, ...extra });

describe("createHybridRouter", () => {
  it("does NOT call the LLM when the deterministic decision is confident", async () => {
    const complete = vi.fn(async () => "{}");
    const router = createHybridRouter({ complete });
    // A confident certified match (>= 0.7 confidence via strong metric score).
    const decision = await router.decide(ask("what is total revenue?", { intent: "exact_certified_lookup", signals: { metricScore: 0.9 } }));
    expect(decision.action).toBe("answer");
    expect(decision.source).toBe("heuristic");
    expect(complete).not.toHaveBeenCalled();
  });

  it("does NOT call the LLM for a confident greeting", async () => {
    const complete = vi.fn(async () => "{}");
    const router = createHybridRouter({ complete });
    const decision = await router.decide(ask("hi"));
    expect(decision.action).toBe("converse");
    expect(complete).not.toHaveBeenCalled();
  });

  it("calls the LLM for a low-confidence turn and maps the category to a route", async () => {
    const complete = vi.fn(async () => JSON.stringify({ category: "data_analysis", depth: "deep", needsClarification: false, rationale: "why-style question" }));
    const router = createHybridRouter({ complete });
    // "widgets" is low-confidence in the deterministic cascade → LLM assist.
    const decision = await router.decide(ask("widgets"));
    expect(complete).toHaveBeenCalledTimes(1);
    expect(decision.action).toBe("investigate");
    expect(decision.category).toBe("data_analysis");
    expect(decision.depth).toBe("deep");
    expect(decision.source).toBe("llm");
  });

  it("maps general_knowledge to a converse action (rendered as a general-knowledge reply)", async () => {
    const complete = vi.fn(async () => JSON.stringify({ category: "general_knowledge", depth: "quick", needsClarification: false, rationale: "world knowledge" }));
    const router = createHybridRouter({ complete });
    const decision = await router.decide(ask("what is dbt"));
    expect(decision.action).toBe("converse");
    expect(decision.category).toBe("general_knowledge");
  });

  it("caches a classification so a repeated question does not call the LLM twice", async () => {
    const complete = vi.fn(async () => JSON.stringify({ category: "data_lookup", depth: "quick", needsClarification: false, rationale: "lookup" }));
    const router = createHybridRouter({ complete });
    const first = await router.decide(ask("widgets"));
    const second = await router.decide(ask("widgets"));
    expect(complete).toHaveBeenCalledTimes(1);
    expect(first.source).toBe("llm");
    expect(second.source).toBe("cache");
  });

  it("falls back to the deterministic decision when the LLM output is unparsable", async () => {
    const complete = vi.fn(async () => "not json at all");
    const router = createHybridRouter({ complete });
    const decision = await router.decide(ask("widgets"));
    expect(decision.source).toBe("heuristic");
    expect(decision.action).toBe("clarify");
  });

  it("falls back to the deterministic decision when the LLM throws", async () => {
    const complete = vi.fn(async () => { throw new Error("provider down"); });
    const router = createHybridRouter({ complete });
    const decision = await router.decide(ask("widgets"));
    expect(decision.source).toBe("heuristic");
  });

  it("is pure heuristics when no completion is injected", async () => {
    const router = createHybridRouter({});
    const decision = await router.decide(ask("widgets"));
    expect(decision.source).toBe("heuristic");
  });
});
