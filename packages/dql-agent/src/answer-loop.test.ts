import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KGStore } from "./kg/sqlite-fts.js";
import { answer, parseProposal } from "./answer-loop.js";
import type { KGNode } from "./kg/types.js";
import type { AgentProvider, AgentMessage } from "./providers/types.js";

class StubProvider implements AgentProvider {
  readonly name = "claude" as const;
  messages: AgentMessage[] = [];
  constructor(private readonly response: string) {}
  async available(): Promise<boolean> {
    return true;
  }
  async generate(messages: AgentMessage[]): Promise<string> {
    this.messages = messages;
    return this.response;
  }
}

let dir: string;
let kg: KGStore;

function revenueSegmentBlock(): KGNode {
  return {
    nodeId: "block:revenue_by_segment",
    kind: "block",
    name: "revenue_by_segment",
    domain: "growth",
    status: "certified",
    description: "Revenue split by customer segment for drilldown analysis",
    llmContext:
      "Use this for revenue drilldowns by segment, including Enterprise, SMB, and Mid-Market.",
    tags: ["revenue", "segment", "drilldown"],
    sourceTier: "certified_artifact",
    certification: "certified",
    provenance: "DQL block",
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kg-answer-"));
  kg = new KGStore(join(dir, "kg.sqlite"));
  kg.rebuild(
    [
      {
        nodeId: "block:revenue_total",
        kind: "block",
        name: "revenue_total",
        domain: "growth",
        status: "certified",
        description: "Top-level revenue across customer segments",
        llmContext: "Use this for revenue trends. Tracks ARR over time.",
        tags: ["revenue"],
        gitSha: "abc12345",
        sourceTier: "certified_artifact",
        certification: "certified",
        provenance: "DQL block",
        businessOutcome: "Revenue leadership can monitor quarterly growth.",
        businessOwner: "revenue-ops",
        decisionUse: "Quarterly planning and forecast review",
        reviewCadence: "weekly",
        businessRules: ["Revenue excludes test accounts."],
        caveats: [
          "Late-arriving invoices may restate current quarter revenue.",
        ],
      },
      {
        nodeId: "block:churn_logo",
        kind: "block",
        name: "churn_logo",
        domain: "retention",
        status: "draft",
        description: "Logo churn",
      },
      {
        nodeId: "term:Net Revenue",
        kind: "term",
        name: "Net Revenue",
        domain: "growth",
        status: "certified",
        description:
          "Recognized revenue after refunds and test-account exclusions.",
        llmContext: "synonyms: revenue, recognized revenue",
        sourceTier: "business_context",
        certification: "certified",
        provenance: "DQL business term",
        businessOwner: "finance",
        decisionUse: "Metric definition and stakeholder alignment",
      },
      {
        nodeId: "business_view:Revenue Health",
        kind: "business_view",
        name: "Revenue Health",
        domain: "growth",
        status: "certified",
        description: "Business view for leadership revenue health review.",
        llmContext: "terms: Net Revenue\nblocks: revenue_total",
        sourceTier: "business_context",
        certification: "certified",
        provenance: "DQL business view",
        businessOutcome:
          "Revenue leadership can inspect growth, mix, and caveats in one place.",
        decisionUse: "Weekly business review",
        reviewCadence: "weekly",
      },
      {
        nodeId: "metric:arr",
        kind: "metric",
        name: "arr",
        domain: "growth",
        description: "Annualized recurring revenue",
      },
    ],
    [],
  );
});

afterEach(() => {
  kg.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("answer (block-first loop)", () => {
  it("returns Certified when a certified block matches", async () => {
    const provider = new StubProvider("should not be called");
    const result = await answer({
      question: "What was revenue this quarter?",
      provider,
      kg,
    });
    expect(result.kind).toBe("certified");
    expect(result.block?.nodeId).toBe("block:revenue_total");
    expect(result.citations[0].gitSha).toBe("abc12345");
    expect(result.evidence?.route[0].tool).toBe("search_certified_artifacts");
    expect(result.evidence?.selectedAssets[0].nodeId).toBe(
      "block:revenue_total",
    );
    expect(result.evidence?.outcome?.name).toContain("Revenue leadership");
  });

  it("uses certified business context for definition questions", async () => {
    const provider = new StubProvider("should not be called");
    const result = await answer({
      question: "What is revenue health?",
      provider,
      kg,
    });
    expect(result.kind).toBe("certified");
    expect(result.block).toBeUndefined();
    expect(result.sourceTier).toBe("business_context");
    expect(result.citations[0]).toMatchObject({
      kind: "business_view",
      name: "Revenue Health",
      sourceTier: "business_context",
    });
    expect(result.evidence?.route).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "search_business_context",
          status: "selected",
        }),
      ]),
    );
    expect(
      result.evidence?.businessContext.some((item) =>
        item.value?.includes("Weekly business review"),
      ),
    ).toBe(true);
  });

  it("executes a certified block when the host supplies an executor", async () => {
    const provider = new StubProvider("should not be called");
    const result = await answer({
      question: "What was revenue this quarter?",
      provider,
      kg,
      executeCertifiedBlock: async () => ({
        columns: ["revenue"],
        rows: [{ revenue: 42 }],
        rowCount: 1,
        executionTime: 12,
      }),
    });
    expect(result.kind).toBe("certified");
    expect(result.result?.rowCount).toBe(1);
    expect(result.text).toContain("Returned 1 row.");
    expect(result.evidence?.execution?.status).toBe("executed");
    expect(result.evidence?.execution?.rowCount).toBe(1);
    expect(result.evidence?.validation?.status).toBe("passed");
  });

  it("returns Uncertified when no certified block matches and SQL is proposed", async () => {
    const llmReply =
      "Median order value by region — joins fct_orders with dim_customers.\n\n" +
      "```sql\nSELECT region, MEDIAN(amount) FROM fct_orders GROUP BY region\n```\n\n" +
      "Viz: bar";
    const provider = new StubProvider(llmReply);
    const result = await answer({
      question: "What is the median order value by region?",
      provider,
      kg,
    });
    expect(result.kind).toBe("uncertified");
    expect(result.proposedSql).toMatch(/SELECT region, MEDIAN/);
    expect(result.suggestedViz).toBe("bar");
    expect(result.evidence?.validation?.status).toBe("warning");
    expect(result.evidence?.route.map((step) => step.tool)).toContain(
      "validate_sql",
    );
    // Citations are best-effort — empty is acceptable when nothing in the KG matches.
    expect(Array.isArray(result.citations)).toBe(true);
  });

  it("executes generated SQL as an uncertified bounded preview when the host supplies an executor", async () => {
    const llmReply =
      "Median order value by region based on the available manifest context.\n\n" +
      "```sql\nSELECT region, MEDIAN(amount) AS median_order_value FROM fct_orders GROUP BY region\n```\n\n" +
      "Viz: bar";
    const provider = new StubProvider(llmReply);
    const result = await answer({
      question: "What is the median order value by region?",
      provider,
      kg,
      executeGeneratedSql: async (sql) => ({
        columns: ["region", "median_order_value"],
        rows: [{ region: "North", median_order_value: 120 }, { region: "South", median_order_value: 90 }],
        rowCount: 2,
        executionTime: 8,
        sql: `SELECT * FROM (${sql}) AS dql_agent_preview LIMIT 200`,
      }),
    });
    expect(result.kind).toBe("uncertified");
    expect(result.reviewStatus).toBe("draft_ready");
    expect(result.result?.rowCount).toBe(2);
    expect(result.evidence?.execution?.status).toBe("executed");
    expect(result.evidence?.execution?.message).toContain("uncertified bounded preview");
    expect(result.evidence?.route).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "execute_generated_sql",
          status: "selected",
          detail: "2 rows",
        }),
        expect.objectContaining({
          tool: "create_draft_block",
          status: "checked",
        }),
      ]),
    );
    expect(result.evidence?.validation?.status).toBe("warning");
  });

  it("keeps generated answers reviewable when SQL preview execution fails", async () => {
    const provider = new StubProvider(
      "Unsafe generated SQL.\n\n```sql\nDELETE FROM orders\n```\n\nViz: table",
    );
    const result = await answer({
      question: "Delete bad orders",
      provider,
      kg,
      executeGeneratedSql: async () => {
        throw new Error("Generated SQL preview only supports read-only SELECT or WITH queries.");
      },
    });
    expect(result.kind).toBe("uncertified");
    expect(result.result).toBeUndefined();
    expect(result.executionError).toContain("read-only SELECT");
    expect(result.evidence?.execution?.status).toBe("failed");
    expect(result.evidence?.route).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "execute_generated_sql",
          status: "failed",
        }),
      ]),
    );
    expect(result.evidence?.validation?.status).toBe("warning");
  });

  it("does not route an unmatched business object to a generic certified count block", async () => {
    kg.rebuild(
      [
        {
          nodeId: "block:total_customers",
          kind: "block",
          name: "total_customers",
          domain: "customers",
          status: "certified",
          description: "Total number of distinct customers.",
          tags: ["customers", "count"],
          sourceTier: "certified_artifact",
          certification: "certified",
          provenance: "DQL block",
        },
        {
          nodeId: "dbt_model:supplies",
          kind: "dbt_model",
          name: "supplies",
          domain: "operations",
          description: "Supply SKU table with perishable supply flags.",
          tags: ["supplies", "sku", "perishable"],
          provenance: "dbt manifest",
        },
      ],
      [],
    );
    const provider = new StubProvider(
      "Supply SKU counts by perishable flag.\n\n" +
        "```sql\nSELECT is_perishable_supply, COUNT(*) AS sku_count FROM supplies GROUP BY is_perishable_supply\n```\n\n" +
        "Viz: bar",
    );
    const result = await answer({
      question: "How many supply SKUs are perishable versus not perishable?",
      provider,
      kg,
      executeGeneratedSql: async () => ({
        columns: ["is_perishable_supply", "sku_count"],
        rows: [{ is_perishable_supply: true, sku_count: 8 }, { is_perishable_supply: false, sku_count: 12 }],
        rowCount: 2,
      }),
    });
    expect(result.kind).toBe("uncertified");
    expect(result.block).toBeUndefined();
    expect(result.proposedSql).toContain("supplies");
    expect(result.result?.rowCount).toBe(2);
    expect(result.evidence?.route).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "execute_generated_sql",
          status: "selected",
        }),
      ]),
    );
  });

  it("does not certify a generic KPI when a stronger draft breakdown block matches", async () => {
    kg.rebuild(
      [
        {
          nodeId: "block:revenue_by_customer_type",
          kind: "block",
          name: "revenue_by_customer_type",
          domain: "growth",
          status: "draft",
          description: "Revenue broken down by customer type for new and returning customers.",
          llmContext:
            "Use this for revenue breakdowns by customer type, including new vs returning customers.",
          tags: ["revenue", "customer", "type", "breakdown"],
          sourceTier: "certified_artifact",
          certification: "analyst_review_required",
          provenance: "DQL block",
        },
        {
          nodeId: "block:total_customers",
          kind: "block",
          name: "total_customers",
          domain: "growth",
          status: "certified",
          description: "Total customer count.",
          llmContext: "Use this for total customers.",
          tags: ["customers", "kpi"],
          sourceTier: "certified_artifact",
          certification: "certified",
          provenance: "DQL block",
        },
      ],
      [],
    );
    const provider = new StubProvider(
      "Draft customer type breakdown.\n\n" +
        "```sql\nSELECT customer_type, SUM(revenue) AS revenue FROM customer_revenue GROUP BY customer_type\n```\n\n" +
        "Viz: bar",
    );
    const result = await answer({
      question: "Break total revenue down by customer type",
      provider,
      kg,
    });
    expect(result.kind).toBe("uncertified");
    expect(result.reviewStatus).toBe("draft_ready");
    expect(result.block).toBeUndefined();
    expect(result.proposedSql).toContain("customer_type");
    expect(
      provider.messages.some((message) =>
        message.content.includes("block:revenue_by_customer_type") &&
        message.content.includes("draft"),
      ),
    ).toBe(true);
  });

  it("returns no_answer when the model declines without SQL", async () => {
    const provider = new StubProvider(
      "I cannot answer this without more schema context.",
    );
    const result = await answer({
      question: "Tell me a joke",
      provider,
      kg,
    });
    expect(result.kind).toBe("no_answer");
    expect(result.evidence?.validation?.status).toBe("failed");
  });

  it("passes extra context to the model without using it for certified routing", async () => {
    const provider = new StubProvider(
      "Explanation draft.\n```sql\nSELECT 1\n```\nViz: table",
    );
    const result = await answer({
      question: "Explain this current query",
      extraContext:
        "Current upstream SQL:\nSELECT SUM(amount) AS revenue FROM orders",
      provider,
      kg,
    });
    expect(result.kind).toBe("uncertified");
    expect(result.block).toBeUndefined();
    expect(
      provider.messages.some((m) => m.content.includes("Current upstream SQL")),
    ).toBe(true);
  });

  it("skips a certified block if downvotes dominate", async () => {
    for (const i of [1, 2, 3]) {
      kg.recordFeedback({
        id: `dn${i}`,
        ts: new Date().toISOString(),
        user: `u${i}`,
        question: "q",
        answerKind: "certified",
        blockId: "block:revenue_total",
        rating: "down",
      });
    }
    const llmReply = "fallback text\n```sql\nSELECT 1\n```\nViz: table";
    const provider = new StubProvider(llmReply);
    const result = await answer({
      question: "Revenue trend",
      provider,
      kg,
    });
    expect(result.kind).toBe("uncertified");
  });

  it("routes drilldown follow-ups to a distinct certified drilldown block when one exists", async () => {
    kg.rebuild(
      [
        revenueSegmentBlock(),
        {
          nodeId: "block:revenue_total",
          kind: "block",
          name: "revenue_total",
          domain: "growth",
          status: "certified",
          description: "Top-level revenue across customer segments",
          tags: ["revenue"],
          sourceTier: "certified_artifact",
          certification: "certified",
          provenance: "DQL block",
        },
      ],
      [],
    );
    const provider = new StubProvider("should not be called");
    const result = await answer({
      question: "Drill into revenue by segment for Enterprise",
      provider,
      kg,
      followUp: {
        kind: "drilldown",
        sourceBlockName: "revenue_total",
        filters: ["Enterprise"],
        dimensions: ["segment"],
      },
    });
    expect(result.kind).toBe("certified");
    expect(result.block?.nodeId).toBe("block:revenue_by_segment");
    expect(provider.messages).toHaveLength(0);
  });

  it("uses prior certified block context for review-ready drilldown drafts when no certified drilldown exists", async () => {
    const provider = new StubProvider(
      "Enterprise revenue drilldown draft based on the prior revenue block.\n\n" +
        "```sql\nSELECT week, SUM(amount) AS revenue FROM fct_orders WHERE segment = 'Enterprise' GROUP BY week\n```\n\n" +
        "Viz: line",
    );
    const result = await answer({
      question: "Drill into Enterprise last week",
      provider,
      kg,
      followUp: {
        kind: "drilldown",
        sourceBlockName: "revenue_total",
        filters: ["Enterprise", "last week"],
      },
    });
    expect(result.kind).toBe("uncertified");
    expect(result.reviewStatus).toBe("draft_ready");
    expect(result.proposedSql).toContain("segment = 'Enterprise'");
    expect(result.evidence?.route).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "propose_drilldown",
          status: "checked",
        }),
        expect.objectContaining({
          tool: "create_draft_block",
          status: "checked",
        }),
      ]),
    );
    expect(
      provider.messages.some((message) =>
        message.content.includes("source certified block: revenue_total"),
      ),
    ).toBe(true);
    expect(result.evidence?.validation?.message).toContain(
      "drilldown SQL is not certified",
    );
  });
});

describe("parseProposal", () => {
  it("extracts SQL block + viz line + summary text", () => {
    const raw = "Revenue summary.\n\n```sql\nSELECT 1\n```\n\nViz: line";
    expect(parseProposal(raw)).toEqual({
      text: "Revenue summary.",
      sql: "SELECT 1",
      viz: "line",
    });
  });

  it("handles missing viz line", () => {
    const raw = "No viz hint.\n\n```sql\nSELECT 2\n```";
    expect(parseProposal(raw)).toEqual({
      text: "No viz hint.",
      sql: "SELECT 2",
      viz: undefined,
    });
  });

  it("returns sql=undefined when there is no fenced SQL block", () => {
    const raw = "I refuse";
    const parsed = parseProposal(raw);
    expect(parsed.sql).toBeUndefined();
    expect(parsed.text).toBe("I refuse");
  });
});
