import { describe, it, expect } from "vitest";
import { probeSemanticJoinFanout } from "./fanout-probe.js";

describe("probeSemanticJoinFanout (governed semantic fanout gate)", () => {
  const PROBE_SQL = "SELECT (SELECT COUNT(*) FROM f) AS base_rows, (SELECT COUNT(*) FROM f JOIN d ON f.k = d.k) AS joined_rows";
  const payload = (rows: unknown[]) => ({ columns: ["base_rows", "joined_rows"], rows, rowCount: rows.length });

  it("blocks with an actionable message when the join multiplies rows", async () => {
    const outcome = await probeSemanticJoinFanout(PROBE_SQL, ["fct_consumption", "dim_customer"], async () =>
      payload([{ base_rows: 1_000, joined_rows: 250_000 }]) as never);
    expect(outcome).toMatchObject({ status: "blocked", code: "SEMANTIC_FANOUT_DUPLICATE_KEY" });
    if (outcome.status === "blocked") {
      expect(outcome.message).toContain("join inflates results");
      expect(outcome.message).toContain("fct_consumption, dim_customer");
      expect(outcome.message).toContain("×250");
      expect(outcome.message).toContain("not unique on the joined side");
    }
  });

  it("passes clean N:1 joins (joined count equals base count)", async () => {
    const outcome = await probeSemanticJoinFanout(PROBE_SQL, ["f", "d"], async () =>
      payload([{ base_rows: 1_000, joined_rows: 1_000 }]) as never);
    expect(outcome).toEqual({ status: "safe" });
  });

  it("passes row-reducing inner joins (fewer rows is loss, not inflation)", async () => {
    const outcome = await probeSemanticJoinFanout(PROBE_SQL, ["f", "d"], async () =>
      payload([{ base_rows: 1_000, joined_rows: 900 }]) as never);
    expect(outcome).toEqual({ status: "safe" });
  });

  it("parses warehouse casing and array-shaped rows", async () => {
    const upper = await probeSemanticJoinFanout(PROBE_SQL, ["f", "d"], async () =>
      payload([{ BASE_ROWS: "100", JOINED_ROWS: "700" }]) as never);
    expect(upper).toMatchObject({ status: "blocked", code: "SEMANTIC_FANOUT_DUPLICATE_KEY" });
    if (upper.status === "blocked") expect(upper.message).toContain("×7");
    const arrays = await probeSemanticJoinFanout(PROBE_SQL, ["f", "d"], async () =>
      payload([[100, 700]]) as never);
    expect(arrays).toMatchObject({ status: "blocked", code: "SEMANTIC_FANOUT_DUPLICATE_KEY" });
    if (arrays.status === "blocked") expect(arrays.message).toContain("×7");
  });

  it("fails closed when the probe errors or does not return verifiable counts", async () => {
    const failed = await probeSemanticJoinFanout(PROBE_SQL, ["f"], async () => {
      throw new Error("permission denied for token=not-for-chat");
    });
    expect(failed).toMatchObject({ status: "blocked", code: "SEMANTIC_FANOUT_PROBE_ERROR" });
    if (failed.status === "blocked") expect(failed.message).not.toContain("not-for-chat");
    const garbage = await probeSemanticJoinFanout(PROBE_SQL, ["f"], async () =>
      payload([{ something: "else" }]) as never);
    expect(garbage).toMatchObject({ status: "blocked", code: "SEMANTIC_FANOUT_PROBE_UNPARSEABLE" });
    const emptyBase = await probeSemanticJoinFanout(PROBE_SQL, ["f"], async () =>
      payload([{ base_rows: 0, joined_rows: 0 }]) as never);
    expect(emptyBase).toMatchObject({ status: "blocked", code: "SEMANTIC_FANOUT_PROBE_UNPARSEABLE" });
  });
});


