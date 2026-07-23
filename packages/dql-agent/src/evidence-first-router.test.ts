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
    expect(decision.resolvedAnalyticalPlan).toMatchObject({
      mode: 'authoritative',
      snapshotId: 'snapshot-1',
      selectedConceptIds: ['semantic:consumption:rollover_balance_amount'],
      capability: 'semantic_execution',
      query: { dimensions: [expect.objectContaining({ requested: 'customer', status: 'resolved' })] },
    });
    expect(Object.isFrozen(decision.resolvedAnalyticalPlan)).toBe(true);
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

  it("AGT-017/AGT-018 keeps one authored semantic metric on the v2 route when meaning resolution is unavailable", async () => {
    const semanticCapability = {
      metricId: "semantic:orders:gross_revenue",
      semanticModelId: "semantic:model:orders",
      measureIds: ["semantic:measure:gross_revenue_measure"],
      primaryEntityId: "semantic:entity:order",
      defaultResultGrainId: "semantic:grain:scalar",
      resultGrainIds: ["semantic:grain:scalar"],
      aggregation: "sum" as const,
      additivity: { entities: "additive" as const, time: "additive" as const },
      dimensions: [],
      timeDimensions: [{
        dimensionId: "semantic:dimension:report_date",
        role: "report_as_of",
        supportedGrains: ["day"],
        defaultFor: ["scalar" as const],
      }],
      operations: ["filter" as const, "trend" as const],
      supportedOutputKinds: ["metric_value" as const],
      executionCapabilities: [{ route: "semantic" as const, adapterId: "metricflow" }],
      sourceFingerprint: "metric-capability-v1",
    };
    const authoredMetric = candidate({
      id: "semantic:metric:orders.gross_revenue",
      name: "orders.gross_revenue",
      aliases: ["gross_revenue", "revenue"],
      provenance: "dbt metric",
      analyticalCapability: semanticCapability,
      relevanceScore: 0.56,
    });
    const router = createHybridRouter({
      getEvidence: async () => ({
        snapshotId: "snapshot-semantic-fallback",
        parsedIntent: { measures: ["revenue"], dimensions: [], filters: [] },
        analyticalPolicies: [{
          policyId: "commerce::skill::revenue_reporting#analytical",
          sourceHash: "commerce-revenue-policy-v1",
          metricIds: [semanticCapability.metricId],
          timeRole: "report_as_of",
          calendarId: "calendar:gregorian",
          timezone: "America/Chicago",
          completenessPolicy: "latest_complete",
        }],
        candidates: [
          candidate({
            id: "dql:block:revenue_by_channel",
            kind: "certified_block",
            trustTier: "certified",
            name: "Revenue by channel",
            compatibility: "compatible",
            relevanceScore: 1,
          }),
          authoredMetric,
          candidate({
            id: "semantic:measure:orders.gross_revenue_measure",
            kind: "semantic_member",
            name: "orders.gross_revenue_measure",
            compatibility: "unknown",
            relevanceScore: 0.55,
          }),
          candidate({
            id: "semantic:metric:orders.gross_revenue_measure",
            name: "orders.gross_revenue_measure",
            aliases: ["gross_revenue_measure"],
            provenance: "dbt measure",
            analyticalCapability: {
              ...semanticCapability,
              metricId: "semantic:metric:gross_revenue_measure",
              sourceFingerprint: "measure-shim-v1",
            },
            relevanceScore: 0.54,
          }),
          candidate({
            id: "semantic:metric:gross_revenue",
            name: "gross_revenue",
            analyticalCapability: undefined,
            relevanceScore: 0.53,
          }),
        ],
      }),
      resolveMeaning: async () => {
        throw new Error("meaning provider deadline exceeded");
      },
    });

    const decision = await router.decide(request("What is revenue today?"));

    expect(decision.source).toBe("heuristic");
    expect(decision.meaningResolution?.recommendedExecutionId).toBe(authoredMetric.id);
    expect(decision.resolvedAnalyticalPlan).toMatchObject({
      schemaVersion: 2,
      executionId: authoredMetric.id,
      capability: "semantic_execution",
    });
    expect(selectRoute(request("What is revenue today?"), decision)).toBe("semantic_answer");
  });

  it("AGT-017 keeps two authored semantic metrics ambiguous when the resolver is unavailable", async () => {
    const executableMetric = (id: string, name: string): AgentEvidenceCandidate => candidate({
      id,
      name,
      aliases: ["revenue"],
      provenance: "dbt metric",
      analyticalCapability: {
        metricId: id.replace("semantic:metric:", "semantic:"),
        semanticModelId: `semantic:model:${name}`,
        measureIds: [`semantic:measure:${name}`],
        primaryEntityId: "semantic:entity:order",
        defaultResultGrainId: "semantic:grain:scalar",
        resultGrainIds: ["semantic:grain:scalar"],
        aggregation: "sum",
        additivity: { entities: "additive", time: "additive" },
        dimensions: [],
        timeDimensions: [],
        operations: ["filter"],
        supportedOutputKinds: ["metric_value"],
        executionCapabilities: [{ route: "semantic", adapterId: "metricflow" }],
        sourceFingerprint: `${name}-v1`,
      },
    });
    const router = createHybridRouter({
      getEvidence: async () => ({
        ...evidence([
          executableMetric("semantic:metric:finance.booked_revenue", "booked_revenue"),
          executableMetric("semantic:metric:billing.billed_revenue", "billed_revenue"),
        ]),
        parsedIntent: { measures: ["revenue"], dimensions: [], filters: [] },
      }),
      resolveMeaning: async () => {
        throw new Error("meaning provider unavailable");
      },
    });

    const decision = await router.decide(request("What is revenue today?"));

    expect(decision.resolvedAnalyticalPlan).toBeUndefined();
    expect(decision.meaningResolution).toBeUndefined();
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

  it("rejects invented resolver IDs as a stable system block", async () => {
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
    expect(decision.action).toBe("answer");
    expect(decision.requiresClarification).toBe(false);
    expect(decision.meaningResolutionErrorCode).toBe('invalid_evidence_reference');
    expect(answerAnywayRoute(selectRoute(ask, decision), ask, "stakeholder", decision)).toBe("blocked");
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
    expect(decision.clarificationOptions).toEqual([
      expect.objectContaining({
        id: "semantic:consumption:rollover_balance_amount",
        label: "Rollover Balance Amount",
      }),
      expect.objectContaining({
        id: "semantic:billing:monthly_rollover_amount",
        label: "Monthly Rollover Amount",
      }),
    ]);
    expect(selectRoute(ask, decision)).toBe("clarify");
  });

  it("AGT-011 resolves a structured clarification by stable evidence ID without another AI planning call", async () => {
    const selected = candidate({
      id: "semantic:consumption:total_ccu_count",
      name: "Total CCU Count",
      relevanceScore: 0.7,
    });
    const resolveMeaning = vi.fn(async () => resolved());
    const router = createHybridRouter({
      maxMeaningCandidates: 2,
      resolveMeaning,
      getEvidence: async () => evidence([
        candidate(),
        candidate({
          id: "semantic:billing:monthly_rollover_amount",
          name: "Monthly Rollover Amount",
          relevanceScore: 0.9,
        }),
        selected,
      ]),
    });

    const decision = await router.decide({
      question: "Total CCU Count",
      selectedEvidenceId: selected.id,
    });

    expect(resolveMeaning).not.toHaveBeenCalled();
    expect(decision.action).toBe("answer");
    expect(decision.meaningResolution).toMatchObject({
      recommendedExecutionId: selected.id,
      selectedConceptIds: [selected.id],
      confidence: "high",
    });
    expect(selectRoute({ question: "Total CCU Count", selectedEvidenceId: selected.id }, decision)).toBe("semantic_answer");
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
      dimensions: [
        "semantic:beverage:dimension:customer",
        "semantic:beverage:dimension:category",
      ],
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
      dimensions: [],
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
