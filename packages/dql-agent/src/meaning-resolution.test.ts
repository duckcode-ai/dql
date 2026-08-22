import { describe, expect, it } from "vitest";
import {
  buildMeaningEvidencePackage,
  certifiedCandidateExplicitlyCoversMeasures,
  findExplicitEvidenceReference,
  questionTypeFromText,
  validateMeaningResolution,
  type AgentEvidenceCandidate,
  type MeaningResolution,
} from "./meaning-resolution.js";

function candidate(overrides: Partial<AgentEvidenceCandidate> = {}): AgentEvidenceCandidate {
  return {
    id: "semantic:consumption:rollover_balance_amount",
    kind: "semantic_metric",
    trustTier: "semantic",
    name: "Rollover Balance Amount",
    definition: "Remaining eligible balance carried into the next month.",
    relevanceScore: 0.95,
    matchReasons: ["business phrase"],
    compatibility: "compatible",
    ...overrides,
  };
}

function resolution(overrides: Partial<MeaningResolution> = {}): MeaningResolution {
  return {
    interpretedQuestion: "Rank customers by actual rollover balance",
    questionType: "ranking",
    selectedConceptIds: ["semantic:consumption:rollover_balance_amount"],
    recommendedExecutionId: "semantic:consumption:rollover_balance_amount",
    queryIntent: { measures: ["rollover_balance_amount"], dimensions: ["customer"], filters: [], order: "desc", limit: 10 },
    rejectedCandidates: [],
    confidence: "high",
    missingInformation: [],
    recommendedRoute: "semantic",
    ...overrides,
  };
}

describe("AGT-010 meaning-resolution evidence boundary", () => {
  it("keeps relevance primary so unrelated certification cannot beat the right meaning", () => {
    const candidates = buildMeaningEvidencePackage({
      candidates: [
        candidate({
          id: "block:finance:certified_rollover_policy",
          kind: "certified_block",
          trustTier: "certified",
          name: "Certified rollover policy",
          relevanceScore: 0.35,
        }),
        candidate(),
      ],
    });
    expect(candidates.map((item) => item.id)).toEqual([
      "semantic:consumption:rollover_balance_amount",
      "block:finance:certified_rollover_policy",
    ]);
  });

  it("removes ineligible evidence and bounds noisy candidates per evidence lane", () => {
    const sql = Array.from({ length: 20 }, (_, index) => candidate({
      id: `sql:table:${index}`,
      kind: "sql_table",
      trustTier: "exploratory",
      relevanceScore: 0.99 - index / 100,
    }));
    const candidates = buildMeaningEvidencePackage({
      candidates: [candidate({ id: "secret", eligible: false }), candidate(), ...sql],
    }, 8);
    expect(candidates).toHaveLength(5);
    expect(candidates.some((item) => item.id === "secret")).toBe(false);
    expect(candidates.some((item) => item.id.includes("rollover_balance"))).toBe(true);
  });

  it("keeps an executable semantic metric when same-tier member matches fill the package", () => {
    const members = Array.from({ length: 8 }, (_, index) => candidate({
      id: `semantic:member:region_${index}`,
      kind: "semantic_member",
      name: `Region ${index}`,
      exactMatch: true,
      relevanceScore: 1 - index / 100,
    }));
    const metricCandidate = candidate({
      id: "semantic:metric:total_revenue",
      name: "Total Revenue",
      relevanceScore: 0.91,
    });

    const candidates = buildMeaningEvidencePackage({
      candidates: [...members, metricCandidate],
    }, 6);

    expect(candidates).toHaveLength(4);
    expect(candidates.some((item) => item.id === metricCandidate.id)).toBe(true);
    expect(candidates.filter((item) => item.kind === "semantic_member")).toHaveLength(3);
  });

  it('pins explicit revenue and the Account Name display role before more than eight same-kind decoys', () => {
    const decoys = Array.from({ length: 12 }, (_, index) => candidate({
      id: `semantic:dimension:account.owner_or_sentiment_${index}`,
      kind: 'semantic_member',
      name: index % 2 === 0 ? `Account Owner Email ${index}` : `Account Sentiment Rating ${index}`,
      relevanceScore: 0.99 - index / 100,
    }));
    const revenue = candidate({
      id: 'semantic:metric:revenue', kind: 'semantic_metric', name: 'Revenue', relevanceScore: 0.72,
    });
    const accountName = candidate({
      id: 'semantic:dimension:account.name', kind: 'semantic_member', name: 'Account Name', relevanceScore: 0.71,
    });

    const cards = buildMeaningEvidencePackage({ candidates: [...decoys, revenue, accountName] }, 8, 'Which top accounts have highest revenue?');

    expect(cards.map((item) => item.id)).toEqual(expect.arrayContaining([revenue.id, accountName.id]));
    expect(cards.filter((item) => /owner|sentiment/i.test(item.name)).map((item) => item.name)).toEqual([]);
  });

  it("recognizes a unique explicit reference without fuzzy guessing", () => {
    const found = findExplicitEvidenceReference(
      "show @metric(rollover_balance_amount) by customer",
      [candidate({ aliases: ["rollover_balance_amount"] })],
    );
    expect(found?.id).toBe("semantic:consumption:rollover_balance_amount");
  });

  it("rejects invented IDs and incompatible selections", () => {
    expect(validateMeaningResolution(
      resolution({ selectedConceptIds: ["semantic:invented"] }),
      [candidate()],
    )).toMatchObject({ ok: false });

    expect(validateMeaningResolution(
      resolution(),
      [candidate({ compatibility: "incompatible" })],
    )).toMatchObject({ ok: false });
  });

  it('AGT-009 rejects a certified execution whose own declared outputs omit the requested revenue', () => {
    const topCustomers = candidate({
      id: 'dql:block:top_customers',
      kind: 'certified_block',
      trustTier: 'certified',
      name: 'top_customers',
      compatibilityFacts: ['output: customer_name', 'output: lifetime_spend', 'output: order_count'],
    });
    const selected = resolution({
      selectedConceptIds: [topCustomers.id],
      recommendedExecutionId: topCustomers.id,
      recommendedRoute: 'certified',
      queryIntent: { measures: ['revenue'], dimensions: [], filters: [] },
    });

    expect(certifiedCandidateExplicitlyCoversMeasures(topCustomers, ['revenue'])).toBe(false);
    expect(validateMeaningResolution(selected, [topCustomers])).toMatchObject({ ok: false });
  });

  it('AGT-009 accepts a certified execution only when its own output contract declares revenue', () => {
    const revenueBlock = candidate({
      id: 'dql:block:revenue_summary',
      kind: 'certified_block',
      trustTier: 'certified',
      name: 'revenue_summary',
      compatibilityFacts: ['output: revenue'],
    });
    const selected = resolution({
      selectedConceptIds: [revenueBlock.id],
      recommendedExecutionId: revenueBlock.id,
      recommendedRoute: 'certified',
      queryIntent: { measures: ['revenue'], dimensions: [], filters: [] },
    });

    expect(certifiedCandidateExplicitlyCoversMeasures(revenueBlock, ['revenue'])).toBe(true);
    expect(validateMeaningResolution(selected, [revenueBlock])).toMatchObject({ ok: true });
  });

  it("normalizes a compatible recommended execution into the selected plan scope", () => {
    const validated = validateMeaningResolution(
      resolution({ selectedConceptIds: [] }),
      [candidate()],
    );
    expect(validated).toMatchObject({
      ok: true,
      resolution: { selectedConceptIds: ['semantic:consumption:rollover_balance_amount'] },
    });
  });

  it("rejects a direct semantic route when deterministic shape compatibility is only partial", () => {
    expect(validateMeaningResolution(
      resolution(),
      [candidate({ compatibility: "partial" })],
    )).toEqual({
      ok: false,
      reason: "A semantic route requires deterministic measure, grain, and dimension compatibility.",
    });
  });

  it("AGT-001 classifies aggregate asks as values instead of definitions", () => {
    expect(questionTypeFromText("What is total lifetime spend across all customers?")).toBe("value");
    expect(questionTypeFromText("What is customer lifetime value?")).toBe("definition");
    expect(questionTypeFromText("Show revenue by month")).toBe("trend");
  });
});
