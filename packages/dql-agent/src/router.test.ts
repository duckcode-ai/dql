import { describe, expect, it, vi } from "vitest";
import { createHybridRouter, humanizeCandidateDefinition, collapseRedundantGovernedCandidates, bestGovernedInterpretation, compileAskAnalyticalProgramV1 } from "./router.js";
import { createAgentRunBudget, type AgentRunRequest } from "./agent-run-engine.js";
import type { AgentEvidenceCandidate, AgentRetrievalEvidence, MeaningResolution } from "./meaning-resolution.js";
import type { AnalyticalProgramV1, AnalyticalRequirementSetV1 } from './analytical-orchestration.js';

const ask = (question: string, extra: Partial<AgentRunRequest> = {}): AgentRunRequest => ({ question, ...extra });

describe("createHybridRouter", () => {
  it('treats a soft budget admission failure as a technical block, never a business clarification', async () => {
    const budget = createAgentRunBudget({
      requestedMode: 'ask',
      startedAtMs: 0,
      nowMs: () => 31_000,
      timeoutSignal: () => new AbortController().signal,
    });
    const router = createHybridRouter({ getEvidence: async () => ({ candidates: [] }) });

    const decision = await router.decide(ask('show revenue', { runBudget: budget }));

    expect(decision).toMatchObject({
      action: 'block',
      requiresClarification: false,
    });
    expect(decision.clarifyingQuestion).toBeUndefined();
  });

  it("treats one literal canonical semantic identifier as a zero-provider meaning binding", async () => {
    const complete = vi.fn(async () => JSON.stringify({ category: 'data_lookup', depth: 'quick', needsClarification: false, rationale: 'should not run' }));
    const canonicalMetric: AgentEvidenceCandidate = {
      id: 'semantic:metric:orders.revenue',
      qualifiedId: 'semantic:metric:orders.revenue',
      kind: 'semantic_metric',
      trustTier: 'semantic',
      name: 'orders.revenue',
      aliases: ['revenue'],
      relevanceScore: 1,
      matchReasons: ['exact canonical identifier'],
      compatibility: 'compatible',
      exactMatch: true,
    };
    const router = createHybridRouter({
      complete,
      getEvidence: async () => ({
        snapshotId: 'snapshot:canonical',
        candidates: [canonicalMetric],
        parsedIntent: { measures: ['revenue'], dimensions: [], filters: [] },
      }),
    });

    await router.decide(ask('Show semantic:metric:orders.revenue'));

    expect(complete).not.toHaveBeenCalled();
  });

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

describe('frozen Ask compiler closures', () => {
  it('AGT-036 never admits a same-snapshot tail column outside the frozen program into physical routing', () => {
    const relation: AgentEvidenceCandidate = {
      id: 'dbt:model:orders', qualifiedId: 'dbt:model:orders', kind: 'dbt_model', trustTier: 'exploratory',
      name: 'orders', relevanceScore: 1, matchReasons: ['runtime schema'], compatibility: 'compatible',
      sourceObjects: ['runtime:relation:orders'],
    };
    const revenueColumn: AgentEvidenceCandidate = {
      id: 'runtime:column:orders.revenue', qualifiedId: 'runtime:column:orders.revenue', kind: 'sql_column', trustTier: 'exploratory',
      name: 'revenue', relevanceScore: 1, matchReasons: ['runtime schema'], compatibility: 'compatible',
      sourceObjects: ['runtime:relation:orders'],
    };
    // This is present in the retrieval snapshot but deliberately absent from
    // executionCandidateIds. Before the closure check, the physical fallback
    // unioned evidence.candidates and silently selected it as `region`.
    const tailRegion: AgentEvidenceCandidate = {
      id: 'runtime:column:orders.region_tail', qualifiedId: 'runtime:column:orders.region_tail', kind: 'sql_column', trustTier: 'exploratory',
      name: 'region', relevanceScore: 0.01, matchReasons: ['same snapshot tail'], compatibility: 'compatible',
      sourceObjects: ['runtime:relation:orders'],
    };
    const metric: AgentEvidenceCandidate = {
      id: 'semantic:metric:orders.revenue', qualifiedId: 'semantic:metric:orders.revenue', kind: 'semantic_metric', trustTier: 'semantic',
      name: 'orders.revenue', relevanceScore: 1, matchReasons: ['exact metric'], compatibility: 'compatible',
      analyticalCapability: {
        metricId: 'semantic:metric:orders.revenue', semanticModelId: 'semantic:model:orders', measureIds: ['revenue'],
        primaryEntityId: 'semantic:entity:order', defaultResultGrainId: 'semantic:grain:order', resultGrainIds: ['semantic:grain:order'],
        aggregation: 'sum', additivity: { entities: 'additive', time: 'additive' }, dimensions: [], timeDimensions: [],
        operations: ['group'], supportedOutputKinds: ['metric_value'], executionCapabilities: [{ route: 'semantic', adapterId: 'metricflow-cli' }],
        sourceFingerprint: 'sha256:metric',
      },
    };
    const requirements: AnalyticalRequirementSetV1 = {
      version: 1, measures: ['revenue'], dimensions: ['region'], entityTerms: [], entityDisplayTerms: [], memberTerms: [],
    };
    const program: AnalyticalProgramV1 = {
      version: 1,
      id: 'program:frozen-closure',
      frameFingerprint: 'sha256:frame',
      taskIds: ['task:1'],
      candidateIds: [metric.id],
      executionCandidateIds: [metric.id, relation.id, revenueColumn.id],
      requiredRoles: ['metric', 'categorical_dimension'],
      filters: [],
      relationshipRequirements: [],
      outputs: {
        measures: ['revenue'], dimensions: ['region'], entityDisplayTerms: [],
        assertions: ['all_requested_measures', 'all_requested_dimensions', 'safe_relationship_closure', 'result_contract'],
      },
    };
    const evidence: AgentRetrievalEvidence = {
      snapshotId: 'snapshot:frozen-closure',
      candidates: [metric, relation, revenueColumn, tailRegion],
      parsedIntent: { measures: ['revenue'], dimensions: ['region'], filters: [] },
      diagnostics: { tierReadiness: { semanticCompiler: 'unavailable', physicalSchema: 'ready' } },
    };
    const resolution: MeaningResolution = {
      interpretedQuestion: 'show revenue by region', questionType: 'value', selectedConceptIds: [metric.id],
      recommendedExecutionId: metric.id, queryIntent: { measures: ['revenue'], dimensions: ['region'], filters: [] },
      rejectedCandidates: [], confidence: 'high', missingInformation: [], recommendedRoute: 'semantic',
    };

    const decision = compileAskAnalyticalProgramV1({
      base: { action: 'answer', confidence: 1, followsUp: false, source: 'heuristic', reason: 'base' },
      request: {
        question: 'show revenue by region',
        requestedMode: 'ask',
        askAnalystTierReadiness: { semanticCompiler: 'unavailable', physicalSchema: 'ready' },
      },
      evidence,
      program,
      candidates: [metric],
      executionCandidates: [metric, relation, revenueColumn],
      resolution,
      requirements,
    });

    expect(decision.action).toBe('block');
    expect(decision.resolvedAnalyticalPlan).toBeUndefined();
    const exploratory = decision.analyticalCascadeDecision?.attempts.find((attempt) => attempt.tier === 'exploratory_sql');
    expect(exploratory?.outcome).toBe('unavailable');
    expect(exploratory?.candidateIds).not.toContain(tailRegion.id);
    expect(decision.analyticalCascadeDecision?.planFrozen).toBe(false);

    // Cover the other compiler-owned pre-freeze path too: a semantic plan
    // that is structurally ineligible advances through the same immutable
    // closure rather than re-unioning the full retrieval snapshot.
    const continuedDecision = compileAskAnalyticalProgramV1({
      base: { action: 'answer', confidence: 1, followsUp: false, source: 'heuristic', reason: 'base' },
      request: {
        question: 'show revenue by region',
        requestedMode: 'ask',
        askAnalystTierReadiness: { semanticCompiler: 'ready', physicalSchema: 'ready' },
      },
      evidence,
      program,
      candidates: [metric],
      executionCandidates: [metric, relation, revenueColumn],
      resolution,
      requirements,
    });
    expect(continuedDecision.action).toBe('block');
    expect(continuedDecision.resolvedAnalyticalPlan).toBeDefined();
    const continuedExploratory = continuedDecision.analyticalCascadeDecision?.attempts.find((attempt) => attempt.tier === 'exploratory_sql');
    expect(continuedExploratory?.outcome).toBe('unavailable');
    expect(continuedExploratory?.candidateIds).not.toContain(tailRegion.id);
  });

  it('AGT-035 never re-authorizes scoped order variants or an order number from a full execution closure', () => {
    const customerName: AgentEvidenceCandidate = {
      id: 'semantic:uncategorized:dimension:customers.customer_name',
      qualifiedId: 'semantic:uncategorized:dimension:customers.customer_name',
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      trustTier: 'semantic',
      name: 'customers.customer_name',
      aliases: ['customer', 'customer name', 'customer_name'],
      relevanceScore: 1,
      matchReasons: ['qualified display'],
      compatibility: 'compatible',
    };
    const customerOrderNumber: AgentEvidenceCandidate = {
      id: 'semantic:uncategorized:dimension:orders.customer_order_number',
      qualifiedId: 'semantic:uncategorized:dimension:orders.customer_order_number',
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      trustTier: 'semantic',
      name: 'orders.customer_order_number',
      aliases: ['customer order number'],
      relevanceScore: 0.99,
      matchReasons: ['qualified numeric attribute'],
      compatibility: 'compatible',
    };
    const genericOrders: AgentEvidenceCandidate = {
      id: 'semantic:orders:orders',
      qualifiedId: 'semantic:orders:orders',
      kind: 'semantic_metric',
      trustTier: 'semantic',
      name: 'orders.orders',
      aliases: ['orders', 'order count'],
      definition: 'Count of orders.',
      relevanceScore: 1,
      matchReasons: ['exact generic metric'],
      compatibility: 'compatible',
      analyticalCapability: {
        metricId: 'semantic:orders:orders',
        semanticModelId: 'semantic:model:orders',
        measureIds: ['semantic:uncategorized:measure:orders.order_count'],
        primaryEntityId: 'semantic:entity:orders.order',
        defaultResultGrainId: 'semantic:grain:orders.order',
        resultGrainIds: ['semantic:grain:orders.order', 'semantic:grain:customers.customer'],
        aggregation: 'count',
        additivity: { entities: 'additive', time: 'additive' },
        dimensions: [
          {
            dimensionId: customerName.qualifiedId!,
            entityId: 'semantic:entity:customers.customer',
            label: 'Customer Name',
            aliases: ['customer', 'customer name'],
            supportedRoles: ['group_by', 'display', 'rank_entity'],
          },
          {
            dimensionId: customerOrderNumber.qualifiedId!,
            entityId: 'semantic:entity:orders.order',
            label: 'Customer Order Number',
            aliases: ['customer order number'],
            supportedRoles: ['group_by', 'display'],
          },
        ],
        timeDimensions: [],
        operations: ['group'],
        supportedOutputKinds: ['metric_value', 'dimension'],
        executionCapabilities: [{ route: 'semantic', adapterId: 'metricflow' }],
        sourceFingerprint: 'sha256:orders',
      },
    };
    const scopedMetrics = ['new_customer_orders', 'drink_orders', 'food_orders'].map((name) => ({
      ...genericOrders,
      id: `semantic:orders:${name}`,
      qualifiedId: `semantic:orders:${name}`,
      name: `orders.${name}`,
      aliases: [name],
      definition: `Count of ${name.replaceAll('_', ' ')}.`,
    }));
    const program: AnalyticalProgramV1 = {
      version: 1,
      id: 'program:order-count-minimal',
      frameFingerprint: 'sha256:order-count',
      taskIds: ['task:1'],
      candidateIds: [genericOrders.id, customerName.id],
      executionCandidateIds: [genericOrders.id, customerName.id, customerOrderNumber.id, ...scopedMetrics.map((candidate) => candidate.id)],
      requiredRoles: ['metric', 'entity_label'],
      filters: [],
      relationshipRequirements: [],
      outputs: {
        measures: ['orders'],
        dimensions: [],
        entityDisplayTerms: ['customer'],
        assertions: ['all_requested_measures', 'all_requested_dimensions', 'safe_relationship_closure', 'result_contract'],
      },
    };
    const evidence: AgentRetrievalEvidence = {
      snapshotId: 'snapshot:retained-jaffle-order-count',
      candidates: [genericOrders, customerName, customerOrderNumber, ...scopedMetrics],
      parsedIntent: { measures: ['order count'], dimensions: ['customer'], filters: [] },
    };
    const resolution: MeaningResolution = {
      interpretedQuestion: 'what is the order count for each customer?',
      questionType: 'value',
      selectedConceptIds: [genericOrders.id, customerName.id],
      recommendedExecutionId: genericOrders.id,
      queryIntent: { measures: ['orders'], dimensions: ['customer_name'], filters: [] },
      rejectedCandidates: [],
      confidence: 'high',
      missingInformation: [],
      recommendedRoute: 'semantic',
    };
    const requirements: AnalyticalRequirementSetV1 = {
      version: 1,
      measures: ['orders'],
      dimensions: [],
      entityTerms: ['customer'],
      entityDisplayTerms: ['customer'],
      memberTerms: [],
    };

    const decision = compileAskAnalyticalProgramV1({
      base: { action: 'answer', confidence: 1, followsUp: false, source: 'heuristic', reason: 'base' },
      request: {
        question: 'what is the order count for each customer?',
        requestedMode: 'ask',
        askAnalystTierReadiness: { semanticCompiler: 'ready', physicalSchema: 'ready' },
      },
      evidence,
      program,
      // Deliberately model a defensive compiler caller that supplies the full
      // frozen closure as its candidate package. The compiler must project it
      // back to program.candidateIds before legacy semantic reconciliation.
      candidates: evidence.candidates,
      executionCandidates: evidence.candidates,
      resolution,
      requirements,
    });

    expect(decision.meaningResolution?.selectedConceptIds).toEqual([genericOrders.id, customerName.id]);
    expect(decision.meaningResolution?.selectedConceptIds).not.toContain(customerOrderNumber.id);
    for (const scoped of scopedMetrics) expect(decision.meaningResolution?.selectedConceptIds).not.toContain(scoped.id);
    expect(decision.terminalOutcome?.candidateIds).toEqual([genericOrders.id, customerName.id]);
  });
});
