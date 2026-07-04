import { describe, expect, it, vi } from "vitest";
import { synthesizeAnswer, inferFormat, type SynthesizeInput } from "./synthesize.js";

const preview = (rows: Array<Record<string, unknown>>, columns: string[]) => ({ columns, rows, rowCount: rows.length });

describe("inferFormat", () => {
  it("infers lookup for a single-row scalar", () => {
    expect(inferFormat({ question: "what is total revenue?", resultPreview: preview([{ revenue: 100 }], ["revenue"]) })).toBe("lookup");
  });

  it("infers comparison for a 'by X' question with many rows", () => {
    expect(inferFormat({ question: "revenue by region", resultPreview: preview([{ r: "A" }, { r: "B" }], ["r"]) })).toBe("comparison");
  });

  it("infers research for a why-style question", () => {
    expect(inferFormat({ question: "why is revenue down?" })).toBe("research");
  });

  it("infers research when the category is data_analysis", () => {
    expect(inferFormat({ question: "revenue", category: "data_analysis" })).toBe("research");
  });
});

describe("synthesizeAnswer", () => {
  it("returns the deterministic draft when no completion is injected", async () => {
    const input: SynthesizeInput = { question: "what is total revenue?", draftText: "Revenue is $2.8M.", resultPreview: preview([{ revenue: 2800000 }], ["revenue"]) };
    const result = await synthesizeAnswer(input);
    expect(result.source).toBe("deterministic");
    expect(result.text).toBe("Revenue is $2.8M.");
  });

  it("uses the LLM composition when a completion is injected", async () => {
    const complete = vi.fn(async () => "Revenue is $2.8M, up 4% from last quarter.");
    const result = await synthesizeAnswer(
      { question: "what is total revenue?", resultPreview: preview([{ revenue: 2800000 }], ["revenue"]) },
      { complete },
    );
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.source).toBe("llm");
    expect(result.text).toContain("$2.8M");
  });

  it("streams deltas through onDelta when the completion supports it", async () => {
    const deltas: string[] = [];
    const complete = vi.fn(async ({ onDelta }: { onDelta?: (d: string) => void }) => {
      onDelta?.("Revenue ");
      onDelta?.("is $2.8M.");
      return "Revenue is $2.8M.";
    });
    const result = await synthesizeAnswer(
      { question: "total revenue?", resultPreview: preview([{ revenue: 2800000 }], ["revenue"]) },
      { complete, onDelta: (d) => deltas.push(d) },
    );
    expect(deltas.join("")).toBe("Revenue is $2.8M.");
    expect(result.source).toBe("llm");
  });

  it("falls back to the deterministic floor when the completion throws", async () => {
    const complete = vi.fn(async () => { throw new Error("provider down"); });
    const result = await synthesizeAnswer(
      { question: "total revenue?", draftText: "Revenue is $2.8M." },
      { complete },
    );
    expect(result.source).toBe("deterministic");
    expect(result.text).toBe("Revenue is $2.8M.");
  });

  it("builds a deterministic table for a comparison with no draft", async () => {
    const result = await synthesizeAnswer({
      question: "revenue by region",
      resultPreview: preview([{ region: "West", revenue: 10 }, { region: "East", revenue: 8 }], ["region", "revenue"]),
    });
    expect(result.format).toBe("comparison");
    expect(result.text).toContain("| region | revenue |");
    expect(result.text).toContain("West");
  });
});

describe("verified statistics — sample-as-population hallucination guard", () => {
  it("computeResultStats covers the FULL result, not the 20-row sample", async () => {
    const { computeResultStats } = await import("./synthesize.js");
    // 200 customers sorted desc — the classic failure: narrator saw rows 1-20
    // ($3,089…$2,201) and claimed the whole result "ranges $2,200 to $3,090".
    const rows = Array.from({ length: 200 }, (_, i) => ({
      customer_name: `Customer ${i}`,
      customer_type: i < 194 ? "returning" : "new",
      lifetime_spend: 3089.8 - i * 6.79,
    }));
    const stats = computeResultStats(["customer_name", "customer_type", "lifetime_spend"], rows);
    const spend = stats.find((s) => s.column === "lifetime_spend");
    expect(spend?.kind).toBe("numeric");
    expect(spend?.max).toBe(3089.8);
    expect(spend?.min).toBeLessThan(1800); // true min of ALL rows, not the sample's 2201
    const type = stats.find((s) => s.column === "customer_type");
    expect(type?.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "returning", count: 194 }),
        expect.objectContaining({ value: "new", count: 6 }),
      ]),
    );
  });

  it("renders verified statistics and the sample label into the narration prompt", async () => {
    const prompts: Array<{ system: string; user: string }> = [];
    const complete = vi.fn(async (input: { system: string; user: string }) => {
      prompts.push(input);
      return "Spend ranges from 66.88 to 3089.8 across 200 customers.";
    });
    await synthesizeAnswer(
      {
        question: "who are the customers?",
        resultPreview: {
          columns: ["customer_name", "lifetime_spend"],
          rows: Array.from({ length: 20 }, (_, i) => ({ customer_name: `C${i}`, lifetime_spend: 3089.8 - i })),
          rowCount: 200,
          stats: [
            { column: "lifetime_spend", kind: "numeric", min: 66.88, max: 3089.8, sum: 671425.37 },
          ],
        },
      },
      { complete },
    );
    const user = prompts[0].user;
    const system = prompts[0].system;
    // The sample is labeled honestly and the stats are the declared source of truth.
    expect(user).toContain("200 rows total; SAMPLE of first 20 shown");
    expect(user).toContain("VERIFIED STATISTICS (computed over ALL 200 rows");
    expect(user).toContain("min 66.88, max 3089.8");
    expect(system).toContain("NEVER derive aggregates from the sample rows");
  });
});
