import { describe, expect, it, vi } from "vitest";
import { narrateResult } from "./narrate.js";

const revenueByRegion = {
  columns: ["region", "revenue"],
  rows: [
    { region: "West", revenue: 1100 },
    { region: "South", revenue: 640 },
    { region: "North", revenue: 580 },
    { region: "East", revenue: 520 },
    { region: "Central", revenue: 300 },
  ],
};

describe("narrateResult deterministic fallback", () => {
  it("computes a grounded summary + findings with no LLM", async () => {
    const out = await narrateResult({ question: "revenue by region", result: revenueByRegion });
    expect(out.source).toBe("deterministic");
    expect(out.summary).toContain("West");
    expect(out.summary).toMatch(/34%|35%/); // 1100 / 3140 ≈ 35%
    expect(out.keyFindings.length).toBeGreaterThan(0);
    expect(out.keyFindings[0]).toContain("West");
  });

  it("handles empty results without crashing", async () => {
    const out = await narrateResult({ question: "revenue by region", result: { columns: ["region", "revenue"], rows: [] } });
    expect(out.source).toBe("deterministic");
    expect(out.summary).toContain("No rows");
    expect(out.keyFindings).toEqual([]);
  });

  it("builds per-item insight captions for app tiles", async () => {
    const out = await narrateResult({
      question: "revenue app",
      items: [
        { id: "tile-1", title: "Revenue by region", result: revenueByRegion },
        { id: "tile-2", title: "Empty", result: { columns: ["x"], rows: [] } },
      ],
    });
    expect(out.perItemInsight?.["tile-1"]).toContain("West");
    expect(out.perItemInsight?.["tile-2"]).toBeUndefined();
  });
});

describe("narrateResult LLM path", () => {
  it("uses the injected completion and parses its JSON", async () => {
    const complete = vi.fn().mockResolvedValue(JSON.stringify({
      summary: "Revenue is concentrated in the West.",
      keyFindings: ["West is 35% of revenue", "Central lags"],
      recommendation: "Investigate Central's pipeline.",
    }));
    const out = await narrateResult({ question: "revenue by region", result: revenueByRegion }, { complete });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(out.source).toBe("llm");
    expect(out.summary).toContain("West");
    expect(out.recommendation).toContain("Central");
  });

  it("falls back to deterministic when the LLM output is unparsable", async () => {
    const complete = vi.fn().mockResolvedValue("not json");
    const out = await narrateResult({ question: "revenue by region", result: revenueByRegion }, { complete });
    expect(out.source).toBe("deterministic");
    expect(out.summary).toContain("West");
  });

  it("falls back to deterministic when the completion throws", async () => {
    const complete = vi.fn().mockRejectedValue(new Error("provider down"));
    const out = await narrateResult({ question: "revenue by region", result: revenueByRegion }, { complete });
    expect(out.source).toBe("deterministic");
  });

  it("keeps deterministic per-item captions even on the LLM path", async () => {
    const complete = vi.fn().mockResolvedValue(JSON.stringify({ summary: "ok", keyFindings: ["a"] }));
    const out = await narrateResult({
      question: "revenue app",
      items: [{ id: "tile-1", title: "Revenue by region", result: revenueByRegion }],
    }, { complete });
    expect(out.source).toBe("llm");
    expect(out.perItemInsight?.["tile-1"]).toContain("West");
  });
});
