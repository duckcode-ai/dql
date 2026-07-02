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
