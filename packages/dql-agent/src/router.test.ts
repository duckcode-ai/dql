import { describe, expect, it, vi } from "vitest";
import { createHybridRouter, humanizeCandidateDefinition, collapseRedundantGovernedCandidates, bestGovernedInterpretation } from "./router.js";
import type { AgentRunRequest } from "./agent-run-engine.js";
import type { AgentEvidenceCandidate } from "./meaning-resolution.js";

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

  it("uses the server conversation envelope when client history is absent", async () => {
    const complete = vi.fn(async () => JSON.stringify({
      category: "data_lookup",
      depth: "quick",
      needsClarification: false,
      rationale: "follow-up lookup",
    }));
    const router = createHybridRouter({ complete });
    await router.decide(ask("widgets", {
      conversationContext: {
        conversationEnvelope: {
          version: 1,
          threadId: "thread_revenue",
          surface: "ask",
          recentTurns: [{
            id: "turn_1",
            question: "revenue by region",
            answerSummary: "West led revenue.",
            trustLabel: "certified",
            runStatus: "completed",
          }],
        },
      },
    }));

    expect(complete).toHaveBeenCalledTimes(1);
    const prompt = complete.mock.calls[0][0].user;
    expect(prompt).toContain("user: revenue by region");
    expect(prompt).toContain("assistant: [confirmed] West led revenue.");
    expect(prompt).toContain("thread: thread_revenue");
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

/**
 * REPORTED: "when any chat output got an error, the following questions get the
 * same error in that session. The same question in a NEW session works."
 *
 * The routing cache key rendered the conversation ENVELOPE — working state,
 * summary, thread id — none of which a FAILED turn advances. Re-asking after a
 * failure produced a byte-identical key, so the router replayed its cached
 * decision for the full TTL and the question failed the same way. A new thread
 * changed the `thread:` line, missed the cache, re-routed, and answered.
 */
describe("routing cache must not outlive the turn it was made for", () => {
  function contextAfter(turnIds: string[]) {
    return {
      threadId: "thr_1",
      latestTurnId: turnIds.at(-1),
      turns: turnIds.map((id) => ({ id })),
      conversationEnvelope: {
        threadId: "thr_1",
        recentTurns: turnIds.map((id) => ({ id, question: "q" })),
      },
    };
  }

  it("re-routes after a failed turn is appended, instead of replaying the cache", async () => {
    let calls = 0;
    const router = createHybridRouter({
      llmThreshold: 2, // force the classification path every time
      complete: async () => {
        calls += 1;
        return JSON.stringify({
          category: "data_lookup", depth: "quick", needsClarification: false, rationale: "r",
        });
      },
      getCatalogContext: () => "catalog",
    });

    const question = "give me Lost Opportunities by month for FY26";
    await router.decide({ question, conversationContext: contextAfter(["t1"]) } as never);
    const first = calls;

    // Same question, same thread — but a turn (the failure) has been appended.
    await router.decide({ question, conversationContext: contextAfter(["t1", "t2_failed"]) } as never);
    expect(calls, "the router replayed a stale decision after a failed turn").toBe(first + 1);
  });

  it("still caches a genuinely identical repeat at the same conversation position", async () => {
    let calls = 0;
    const router = createHybridRouter({
      llmThreshold: 2,
      complete: async () => {
        calls += 1;
        return JSON.stringify({
          category: "data_lookup", depth: "quick", needsClarification: false, rationale: "r",
        });
      },
      getCatalogContext: () => "catalog",
    });
    const request = { question: "total revenue", conversationContext: contextAfter(["t1"]) } as never;
    await router.decide(request);
    const second = await router.decide(request);
    expect(calls).toBe(1);
    expect(second.source).toBe("cache");
  });
});

describe('clarification choices are readable by a person', () => {
  it('summarizes a raw semantic-layer record instead of pasting YAML into the question', () => {
    // This exact record reached a user as the body of a clarify card:
    // "label: customers aggregation: count_distinct table: ... expr: customer_id".
    expect(humanizeCandidateDefinition([
      'label: customers',
      'aggregation: count_distinct',
      'table: "jaffle_shop"."main"."dim_customers"',
      'expr: customer_id',
      'agg_time_dimension: first_ordered_at',
    ].join('\n'))).toBe('count distinct of customer_id from dim_customers.');
  });

  it('leaves authored prose alone, including a sentence containing a colon', () => {
    expect(humanizeCandidateDefinition('Customer grain mart.')).toBe('Customer grain mart.');
    expect(humanizeCandidateDefinition('Revenue: the amount billed for each order item.'))
      .toBe('Revenue: the amount billed for each order item.');
    expect(humanizeCandidateDefinition('   ')).toBeUndefined();
    expect(humanizeCandidateDefinition(undefined)).toBeUndefined();
  });
});

describe('committing to a governed reading instead of interrogating the user', () => {
  const cand = (over: Partial<AgentEvidenceCandidate>): AgentEvidenceCandidate => ({
    id: 'x', kind: 'semantic_metric', trustTier: 'semantic', name: 'x',
    relevanceScore: 0.5, matchReasons: [], compatibility: 'unknown', eligible: true,
    ...over,
  } as AgentEvidenceCandidate);

  it('treats a simple metric, the measure it wraps, and their model as one meaning', () => {
    // Exactly the card users were shown: `customers.customers` metric,
    // `customers.customers` measure, and the `customers` model — one number,
    // offered as three competing "meanings".
    const collapsed = collapseRedundantGovernedCandidates('who are the top customers', [
      cand({ id: 'semantic:metric:customers.customers', name: 'customers', semanticObjectType: 'metric', semanticModel: 'customers', relevanceScore: 0.9 }),
      cand({ id: 'semantic:measure:customers.customers', name: 'customers', kind: 'semantic_member', semanticObjectType: 'measure', semanticModel: 'customers', relevanceScore: 0.8 }),
      cand({ id: 'semantic:model:customers', name: 'customers', kind: 'semantic_member', semanticObjectType: 'model', semanticModel: 'customers', relevanceScore: 0.7 }),
    ]);
    expect(collapsed).toHaveLength(1);
    // The metric is the most authoritative representative of the three.
    expect(collapsed[0]!.id).toBe('semantic:metric:customers.customers');
  });

  it('does not offer join keys as readings of an attribute question', () => {
    const collapsed = collapseRedundantGovernedCandidates('Can you include customer names', [
      cand({ id: 'semantic:entity:customers.customer', semanticObjectType: 'entity', relevanceScore: 0.9 }),
      cand({ id: 'semantic:entity:orders.customer', semanticObjectType: 'entity', relevanceScore: 0.85 }),
      cand({ id: 'semantic:dimension:customer_name', semanticObjectType: 'dimension', relevanceScore: 0.6 }),
    ]);
    expect(collapsed.map((c) => c.id)).toEqual(['semantic:dimension:customer_name']);
  });

  it('keeps genuinely different metrics distinct', () => {
    const collapsed = collapseRedundantGovernedCandidates('what is revenue', [
      cand({ id: 'semantic:metric:finance.booked_revenue', name: 'booked_revenue', semanticObjectType: 'metric', semanticModel: 'finance', relevanceScore: 0.9 }),
      cand({ id: 'semantic:metric:billing.billed_revenue', name: 'billed_revenue', semanticObjectType: 'metric', semanticModel: 'billing', relevanceScore: 0.88 }),
    ]);
    expect(collapsed).toHaveLength(2);
  });

  it('never commits to a partial match, which is proven not to cover the request', () => {
    expect(bestGovernedInterpretation('top beverage customers', [
      cand({ id: 'dql:block:top_beverage_customers', kind: 'certified_block', compatibility: 'partial', relevanceScore: 0.9 }),
      cand({ id: 'semantic:order_item:product', kind: 'semantic_member', compatibility: 'partial', relevanceScore: 0.8 }),
    ])).toBeUndefined();
  });

  it('commits to the best executable reading when one exists', () => {
    expect(bestGovernedInterpretation('how many orders are there', [
      cand({ id: 'semantic:model:orders', kind: 'semantic_member', semanticObjectType: 'model', compatibility: 'unknown', relevanceScore: 1 }),
      cand({ id: 'dql:entity:core::entity::orders', kind: 'dql_modeling', compatibility: 'partial', relevanceScore: 0.9 }),
    ])?.id).toBe('semantic:model:orders');
  });
});
