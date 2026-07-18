import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

interface RetrievalEvalContract {
  version: number;
  acceptanceIds: string[];
  scale: {
    semanticMetrics: number;
    dbtModels: number;
    dbtColumns: number;
    targetMetricPositions: number[];
  };
  concepts: Array<{ id: string; position?: number }>;
  defaults: {
    maxCandidateCards: number;
    maxEvidenceTokens: number;
    maxMeaningCalls: number;
    maxGenerationCalls: number;
    maxRepairCalls: number;
    maxSynthesisCalls: number;
    wrongCertifiedCeiling: number;
    inventedIdExecutionCeiling: number;
  };
  cases: Array<{
    name: string;
    expected: {
      route?: string;
      selectedConceptIds?: string[];
      maxMeaningCalls?: number;
      maxGenerationCalls?: number;
      maxSynthesisCalls?: number;
      inventedIdExecuted?: boolean;
      parity?: boolean;
    };
  }>;
  securityCases: Array<{ name: string }>;
}

const contractPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../docs/specs/dql-2-domain-context/fixtures/retrieval-first-evidence.agent-evals.yml",
);

function readContract(): RetrievalEvalContract {
  return load(readFileSync(contractPath, "utf8")) as RetrievalEvalContract;
}

describe("retrieval-first evidence eval contract", () => {
  it("tracks every stable requirement without claiming verification", () => {
    const contract = readContract();

    expect(contract.version).toBe(1);
    expect(contract.acceptanceIds).toEqual([
      "CTX-005",
      "AGT-009",
      "AGT-010",
      "PERF-002",
      "SEC-003",
      "API-003",
      "E2E-006",
    ]);
  });

  it("locks the enterprise scale and late-position retrieval targets", () => {
    const contract = readContract();

    expect(contract.scale).toMatchObject({
      semanticMetrics: 7_000,
      dbtModels: 10_000,
      dbtColumns: 300_000,
    });
    expect(contract.scale.targetMetricPositions).toEqual([
      24, 60, 200, 500, 6_789, 6_999,
    ]);
    expect(
      contract.concepts.map((concept) => concept.position).filter(Boolean),
    ).toEqual(expect.arrayContaining([24, 60, 200, 500, 6_789, 6_999]));
  });

  it("keeps meaning, trust-conflict, ambiguity, safety, and parity cases unique", () => {
    const contract = readContract();
    const names = contract.cases.map((testCase) => testCase.name);

    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining([
        "late-position actual balance definition",
        "irrelevant certification cannot override semantic meaning",
        "same display name requires domain clarification",
        "invented resolver identifier fails closed",
        "all Ask surfaces agree",
      ]),
    );
    expect(contract.securityCases).toHaveLength(1);
  });

  it("bounds evidence and model work for the executable harness", () => {
    const contract = readContract();

    expect(contract.defaults).toMatchObject({
      maxCandidateCards: 12,
      maxEvidenceTokens: 12_000,
      maxMeaningCalls: 1,
      maxGenerationCalls: 1,
      maxRepairCalls: 1,
      maxSynthesisCalls: 0,
      wrongCertifiedCeiling: 0,
      inventedIdExecutionCeiling: 0,
    });

    const explicit = contract.cases.find(
      (testCase) =>
        testCase.name === "explicit qualified metric bypasses resolver",
    );
    const invented = contract.cases.find(
      (testCase) =>
        testCase.name === "invented resolver identifier fails closed",
    );
    const parity = contract.cases.find(
      (testCase) => testCase.name === "all Ask surfaces agree",
    );

    expect(explicit?.expected.maxMeaningCalls).toBe(0);
    expect(invented?.expected.inventedIdExecuted).toBe(false);
    expect(parity?.expected.parity).toBe(true);
  });
});
