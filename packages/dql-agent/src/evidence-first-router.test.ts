import { describe, expect, it, vi } from "vitest";
import { answerAnywayRoute, selectRoute, type AgentRunRequest } from "./agent-run-engine.js";
import type { AgentEvidenceCandidate, AgentRetrievalEvidence, MeaningResolution } from "./meaning-resolution.js";
import { createHybridRouter } from "./router.js";

const request = (question: string): AgentRunRequest => ({ question });

function candidate(overrides: Partial<AgentEvidenceCandidate> = {}): AgentEvidenceCandidate {
  return {
    id: "semantic:consumption:rollover_balance_amount",
    kind: "semantic_metric",
    trustTier: "semantic",
    name: "Rollover Balance Amount",
    aliases: ["rollover_balance_amount"],
    definition: "Remaining eligible balance carried into the next month.",
    dimensions: ["customer", "month"],
    timeGrains: ["month"],
    relevanceScore: 0.95,
    matchReasons: ["phrase match"],
    compatibility: "compatible",
    ...overrides,
  };
}

function evidence(candidates: AgentEvidenceCandidate[]): AgentRetrievalEvidence {
  return {
    snapshotId: "snapshot-1",
    sourceFingerprint: "fingerprint-1",
    candidates,
    parsedIntent: { measures: ["rollover balance amount"], dimensions: ["customer"], timeGrain: "month", order: "desc", limit: 10 },
  };
}

function resolved(overrides: Partial<MeaningResolution> = {}): MeaningResolution {
  return {
    interpretedQuestion: "Rank customers by actual monthly rollover balance",
    questionType: "ranking",
    selectedConceptIds: ["semantic:consumption:rollover_balance_amount"],
    recommendedExecutionId: "semantic:consumption:rollover_balance_amount",
    queryIntent: { measures: ["semantic:consumption:rollover_balance_amount"], dimensions: ["customer"], filters: [], timeGrain: "month", order: "desc", limit: 10 },
    rejectedCandidates: [],
    confidence: "high",
    missingInformation: [],
    recommendedRoute: "semantic",
    ...overrides,
  };
}

describe("AGT-009/AGT-010 evidence-first hybrid routing", () => {
  it("retrieves before routing and sends a bounded evidence package to meaning resolution", async () => {
    const getEvidence = vi.fn(async () => evidence([
      candidate(),
      candidate({
        id: "semantic:consumption:rollover_risk_amount",
        name: "Rollover Risk Amount",
        definition: "Forecasted balance at risk of expiry.",
        relevanceScore: 0.8,
      }),
    ]));
    const resolveMeaning = vi.fn(async () => resolved({
      rejectedCandidates: [{ id: "semantic:consumption:rollover_risk_amount", reason: "Risk is not actual balance." }],
    }));
    const complete = vi.fn(async () => JSON.stringify({ category: "general_knowledge" }));
    const router = createHybridRouter({ getEvidence, resolveMeaning, complete });

    const decision = await router.decide(request("Who are the top customers by monthly rollover amount?"));

    expect(getEvidence).toHaveBeenCalledTimes(1);
    expect(resolveMeaning).toHaveBeenCalledTimes(1);
    expect(resolveMeaning.mock.calls[0][0].candidates).toHaveLength(2);
    expect(complete).not.toHaveBeenCalled();
    expect(decision.action).toBe("answer");
    expect(decision.category).toBe("data_lookup");
    expect(decision.meaningResolution?.selectedConceptIds).toEqual(["semantic:consumption:rollover_balance_amount"]);
    expect(decision.retrievalEvidence?.candidateIds).toHaveLength(2);
  });

  it("propagates the request cancellation signal into meaning resolution", async () => {
    const controller = new AbortController();
    const resolveMeaning = vi.fn(async (input: { signal?: AbortSignal }) => {
      expect(input.signal).toBe(controller.signal);
      return resolved();
    });
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => evidence([
        candidate(),
        candidate({
          id: "semantic:billing:monthly_rollover_amount",
          name: "Monthly Rollover Amount",
          relevanceScore: 0.84,
        }),
      ]),
    });

    await router.decide({ ...request("monthly rollover amount"), signal: controller.signal });

    expect(resolveMeaning).toHaveBeenCalledTimes(1);
  });

  it("does not swallow cancellation and continue through a fallback route", async () => {
    const controller = new AbortController();
    const router = createHybridRouter({
      resolveMeaning: async () => {
        controller.abort(new Error("Stopped by user."));
        throw controller.signal.reason;
      },
      getEvidence: async () => evidence([
        candidate(),
        candidate({
          id: "semantic:billing:monthly_rollover_amount",
          name: "Monthly Rollover Amount",
          relevanceScore: 0.84,
        }),
      ]),
    });

    await expect(router.decide({
      ...request("monthly rollover amount"),
      signal: controller.signal,
    })).rejects.toThrow("Stopped by user.");
  });

  it("bypasses AI for a unique explicit qualified reference", async () => {
    const complete = vi.fn(async () => "{}");
    const resolveMeaning = vi.fn(async () => resolved());
    const router = createHybridRouter({
      complete,
      resolveMeaning,
      getEvidence: async () => evidence([candidate()]),
    });
    const decision = await router.decide(request("show @metric(rollover_balance_amount) by customer"));
    expect(resolveMeaning).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(decision.meaningResolution?.confidence).toBe("high");
    expect(selectRoute(request("q"), decision)).toBe("semantic_answer");
  });

  it("reuses the provider completion as a single bounded meaning resolver", async () => {
    const complete = vi.fn(async () => JSON.stringify(resolved({
      rejectedCandidates: [{ id: "semantic:consumption:rollover_risk_amount", reason: "Risk is a forecast." }],
    })));
    const router = createHybridRouter({
      complete,
      getEvidence: async () => evidence([
        candidate({ definition: `Actual balance ${"detail ".repeat(2_000)}` }),
        candidate({
          id: "semantic:consumption:rollover_risk_amount",
          name: "Rollover Risk Amount",
          definition: `Forecasted risk ${"noise ".repeat(2_000)}`,
          relevanceScore: 0.85,
        }),
      ]),
    });
    const decision = await router.decide(request("top customers by monthly rollover balance"));
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0].system).toMatch(/resolve business meaning/i);
    expect(complete.mock.calls[0][0].user.length).toBeLessThan(10_000);
    expect(decision.meaningResolution?.confidence).toBe("high");
    expect(decision.action).toBe("answer");
  });

  it("uses AI when one exact name still has a materially related competing meaning", async () => {
    const resolveMeaning = vi.fn(async () => resolved());
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => evidence([
        candidate({ exactMatch: true }),
        candidate({
          id: "semantic:billing:monthly_rollover_amount",
          name: "Monthly Rollover Amount",
          definition: "New amount rolled over during the month rather than ending balance.",
          relevanceScore: 0.84,
        }),
      ]),
    });
    await router.decide(request("monthly rollover balance amount"));
    expect(resolveMeaning).toHaveBeenCalledTimes(1);
  });

  it("AGT-010 avoids a duplicate meaning call for typed compositional follow-ups", async () => {
    const resolveMeaning = vi.fn(async () => resolved());
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => evidence([
        candidate({
          id: 'dql:block:top_beverage_customers',
          kind: 'certified_block',
          trustTier: 'certified',
          compatibility: 'partial',
        }),
        candidate({
          id: 'semantic:order_item:product',
          kind: 'semantic_member',
          compatibility: 'partial',
        }),
      ]),
    });

    const decision = await router.decide({
      question: 'what product they bought for this amount?',
      history: [
        { role: 'user', text: 'top beverage customers' },
        { role: 'assistant', text: 'Melissa Lopez leads beverage revenue.' },
      ],
      conversationContext: { priorResultValues: { customer_name: ['Melissa Lopez'] } },
    });

    expect(resolveMeaning).not.toHaveBeenCalled();
    expect(decision.action).toBe('answer');
    expect(decision.followsUp).toBe(true);
    expect(decision.retrievalEvidence?.candidateIds).toHaveLength(2);
  });

  it("rejects invented resolver IDs and preserves a hard clarification", async () => {
    const candidates = [candidate(), candidate({
      id: "semantic:billing:monthly_rollover_amount",
      name: "Monthly Rollover Amount",
      definition: "New balance rolled over during the month.",
      relevanceScore: 0.9,
    })];
    const router = createHybridRouter({
      getEvidence: async () => evidence(candidates),
      resolveMeaning: async () => resolved({ selectedConceptIds: ["semantic:invented"] }),
    });
    const ask = request("monthly rollover amount");
    const decision = await router.decide(ask);
    expect(decision.action).toBe("clarify");
    expect(decision.requiresClarification).toBe(true);
    expect(decision.clarifyingQuestion).toMatch(/Which meaning/i);
    expect(answerAnywayRoute(selectRoute(ask, decision), ask, "stakeholder", decision)).toBe("clarify");
  });

  it("keeps a low-confidence business ambiguity out of generated SQL", async () => {
    const router = createHybridRouter({
      getEvidence: async () => evidence([candidate(), candidate({
        id: "semantic:billing:monthly_rollover_amount",
        name: "Monthly Rollover Amount",
        relevanceScore: 0.9,
      })]),
      resolveMeaning: async () => resolved({
        selectedConceptIds: [],
        recommendedExecutionId: undefined,
        confidence: "low",
        recommendedRoute: "clarify",
        clarifyingQuestion: "Do you mean ending balance or newly rolled-over amount?",
      }),
    });
    const ask = request("monthly rollover amount");
    const decision = await router.decide(ask);
    expect(decision.clarifyingQuestion).toBe("Do you mean ending balance or newly rolled-over amount?");
    expect(selectRoute(ask, decision)).toBe("clarify");
  });

  it("uses the recommended compatible certified executor only after meaning resolution", async () => {
    const block = candidate({
      id: "block:consumption:customer_rollover_report",
      kind: "certified_block",
      trustTier: "certified",
      name: "Customer Rollover Report",
      relevanceScore: 0.93,
    });
    const router = createHybridRouter({
      getEvidence: async () => evidence([candidate(), block]),
      resolveMeaning: async () => resolved({
        recommendedExecutionId: block.id,
        recommendedRoute: "certified",
      }),
    });
    const ask = request("top customers by monthly rollover amount");
    const decision = await router.decide(ask);
    expect(selectRoute(ask, decision)).toBe("certified_answer");
  });

  it("routes a uniquely compatible high-relevance certified ranking without an AI planning call (AGT-009, AGT-010, PERF-002)", async () => {
    const topCustomers = candidate({
      id: "dql:block:top_beverage_customers",
      kind: "certified_block",
      trustTier: "certified",
      name: "top_beverage_customers",
      definition: "Top customers ranked by beverage revenue. One row per customer.",
      dimensions: ["customer"],
      relevanceScore: 1,
      compatibility: "compatible",
      exactMatch: false,
    });
    const productRanking = candidate({
      id: "dql:block:beverage_revenue_by_product",
      kind: "certified_block",
      trustTier: "certified",
      name: "beverage_revenue_by_product",
      definition: "Beverage revenue by product. One row per product.",
      dimensions: ["product"],
      relevanceScore: 0.91,
      compatibility: "incompatible",
    });
    const rawProducts = candidate({
      id: "warehouse:table:dev.products",
      kind: "sql_table",
      trustTier: "exploratory",
      name: "dev.products",
      relevanceScore: 0.88,
      compatibility: "unknown",
    });
    const resolveMeaning = vi.fn(async () => resolved());
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        ...evidence([topCustomers, productRanking, rawProducts]),
        parsedIntent: {
          measures: ["spend"],
          dimensions: ["customer"],
          filters: [{ field: "category", value: "beverage" }],
          order: "desc",
          limit: 10,
        },
      }),
    });

    const ask = request("who are the top customers who spent on beverage category products?");
    const decision = await router.decide(ask);

    expect(resolveMeaning).not.toHaveBeenCalled();
    expect(decision.action).toBe("answer");
    expect(decision.meaningResolution?.recommendedExecutionId).toBe(topCustomers.id);
    expect(decision.meaningResolution?.recommendedRoute).toBe("certified");
    expect(selectRoute(ask, decision)).toBe("certified_answer");
  });

  it("can still classify true general knowledge only after retrieval returns no evidence", async () => {
    const calls: string[] = [];
    const router = createHybridRouter({
      getEvidence: async () => {
        calls.push("retrieval");
        return evidence([]);
      },
      complete: async () => {
        calls.push("classification");
        return JSON.stringify({ category: "general_knowledge", depth: "quick", needsClarification: false, rationale: "world knowledge" });
      },
    });
    const decision = await router.decide(request("what is a data mesh"));
    expect(calls).toEqual(["retrieval", "classification"]);
    expect(decision.category).toBe("general_knowledge");
    expect(decision.action).toBe("converse");
  });
});
