import { describe, expect, it } from "vitest";
import {
  buildMeaningEvidencePackage,
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

  it("removes ineligible evidence and bounds noisy candidates per trust lane", () => {
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
