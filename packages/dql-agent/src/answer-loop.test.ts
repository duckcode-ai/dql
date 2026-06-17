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
  calls: AgentMessage[][] = [];
  private readonly responses: string[];
  constructor(response: string | string[]) {
    this.responses = Array.isArray(response) ? response : [response];
  }
  async available(): Promise<boolean> {
    return true;
  }
  async generate(messages: AgentMessage[]): Promise<string> {
    this.messages = messages;
    this.calls.push(messages);
    return this.responses[Math.min(this.calls.length - 1, this.responses.length - 1)];
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

  it("prefers an exact certified executable block over a certified term for KPI questions", async () => {
    kg.rebuild(
      [
        {
          nodeId: "block:total_revenue",
          kind: "block",
          name: "total_revenue",
          domain: "revenue",
          status: "certified",
          description: "Single-value gross revenue KPI across all orders.",
          tags: ["revenue", "kpi"],
          sourceTier: "certified_artifact",
          certification: "certified",
          provenance: "DQL block",
        },
        {
          nodeId: "term:Lifetime Revenue",
          kind: "term",
          name: "Lifetime Revenue",
          domain: "customer",
          status: "certified",
          description: "Total order revenue attributed to a customer across all known orders.",
          llmContext: "synonyms: lifetime spend, customer revenue, total spend",
          sourceTier: "business_context",
          certification: "certified",
          provenance: "DQL business term",
        },
      ],
      [],
    );
    const provider = new StubProvider("should not be called");
    const result = await answer({
      question: "What is total revenue?",
      provider,
      executeCertifiedBlock: async () => ({
        columns: ["total_revenue"],
        rows: [{ total_revenue: 222.5 }],
        rowCount: 1,
      }),
      kg,
    });

    expect(result.kind).toBe("certified");
    expect(result.block?.nodeId).toBe("block:total_revenue");
    expect(result.result?.rowCount).toBe(1);
    expect(result.sourceTier).toBe("certified_artifact");
    expect(provider.calls).toHaveLength(0);
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
      question: "Show bad orders",
      provider,
      kg,
      schemaContext: [
        {
          relation: "dev.orders",
          schema: "dev",
          name: "orders",
          columns: [
            { name: "order_id", type: "VARCHAR" },
            { name: "order_total", type: "DECIMAL" },
          ],
        },
      ],
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

  it("uses a certified count block for a direct customer KPI question", async () => {
    kg.rebuild(
      [
        {
          nodeId: "block:total_customers",
          kind: "block",
          name: "total_customers",
          domain: "customers",
          status: "certified",
          description: "Total number of distinct customers.",
          llmContext: "Use for how many customers questions.",
          tags: ["customers", "kpi"],
          sourceTier: "certified_artifact",
          certification: "certified",
          provenance: "DQL block",
        },
      ],
      [],
    );
    const provider = new StubProvider("should not be called");
    const result = await answer({
      question: "How many customers do we have?",
      provider,
      kg,
      executeCertifiedBlock: async () => ({
        columns: ["total_customers"],
        rows: [{ total_customers: 100 }],
        rowCount: 1,
      }),
    });
    expect(result.kind).toBe("certified");
    expect(result.block?.nodeId).toBe("block:total_customers");
    expect(result.analysisPlan?.intent).toBe("exact_certified_lookup");
    expect(provider.calls).toHaveLength(0);
  });

  it("uses active skill preferred blocks for exact certified lookups", async () => {
    kg.rebuild(
      [
        {
          nodeId: "block:revenue_by_month",
          kind: "block",
          name: "revenue_by_month",
          domain: "growth",
          status: "certified",
          description: "Monthly revenue trend.",
          tags: ["revenue", "trend"],
          sourceTier: "certified_artifact",
          certification: "certified",
          provenance: "DQL block",
        },
        {
          nodeId: "block:revenue_total",
          kind: "block",
          name: "revenue_total",
          domain: "growth",
          status: "certified",
          description: "Board-level total revenue KPI.",
          tags: ["revenue", "kpi"],
          sourceTier: "certified_artifact",
          certification: "certified",
          provenance: "DQL block",
        },
      ],
      [],
    );
    const provider = new StubProvider("should not be called");
    const result = await answer({
      question: "What is revenue?",
      provider,
      kg,
      skills: [
        {
          id: "board-review",
          preferredMetrics: [],
          preferredBlocks: ["revenue_total"],
          vocabulary: {},
          body: "For board revenue questions, prefer the board-level KPI.",
          sourcePath: "/tmp/board.skill.md",
        },
      ],
    });
    expect(result.kind).toBe("certified");
    expect(result.block?.nodeId).toBe("block:revenue_total");
    expect(provider.calls).toHaveLength(0);
  });

  it("generates dynamic SQL for diagnostic metric questions instead of stopping at a certified KPI", async () => {
    const provider = new StubProvider(
      "February revenue declined versus January; review the segment contribution before certification.\n\n" +
        "```sql\nSELECT date_trunc('month', ordered_at) AS month, SUM(order_total) AS revenue FROM analytics.orders GROUP BY 1 ORDER BY 1\n```\n\n" +
        "Viz: line",
    );
    const result = await answer({
      question: "Why did revenue drop in February?",
      provider,
      kg,
      schemaContext: [
        {
          relation: "analytics.orders",
          schema: "analytics",
          name: "orders",
          columns: [
            { name: "ordered_at", type: "TIMESTAMP" },
            { name: "order_total", type: "DECIMAL" },
          ],
        },
      ],
      executeGeneratedSql: async (sql) => ({
        columns: ["month", "revenue"],
        rows: [
          { month: "2024-01-01", revenue: 39.5 },
          { month: "2024-02-01", revenue: 31.0 },
        ],
        rowCount: 2,
        sql,
      }),
    });

    expect(result.kind).toBe("uncertified");
    expect(result.block).toBeUndefined();
    expect(result.reviewStatus).toBe("draft_ready");
    expect(result.analysisPlan?.intent).toBe("ad_hoc_analysis");
    expect(result.proposedSql).toContain("analytics.orders");
    expect(result.result?.rowCount).toBe(2);
    expect(result.evidence?.route).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "execute_generated_sql",
          status: "selected",
        }),
      ]),
    );
    expect(provider.calls).toHaveLength(1);
  });

  it("does not let skill preferred blocks override dynamic custom-grain analysis", async () => {
    kg.rebuild(
      [
        {
          nodeId: "block:total_customers",
          kind: "block",
          name: "total_customers",
          domain: "customers",
          status: "certified",
          description: "Total number of customers.",
          tags: ["customers", "kpi"],
          sourceTier: "certified_artifact",
          certification: "certified",
          provenance: "DQL block",
        },
        {
          nodeId: "dbt_model:customers",
          kind: "dbt_model",
          name: "customers",
          domain: "customers",
          description: "Customer mart with lifetime spend and order counts.",
          sourceTier: "dbt_manifest",
          certification: "ai_generated",
          provenance: "dbt manifest",
        },
      ],
      [],
    );
    const provider = new StubProvider("should not be called");
    const result = await answer({
      question: "Can you show me the orders by customer who have performed better?",
      provider,
      kg,
      skills: [
        {
          id: "customer-kpis",
          preferredMetrics: [],
          preferredBlocks: ["total_customers"],
          vocabulary: {},
          body: "Executives often ask for customer totals.",
          sourcePath: "/tmp/customer.skill.md",
        },
      ],
      schemaContext: [
        {
          relation: "analytics.customers",
          schema: "analytics",
          name: "customers",
          columns: [
            { name: "customer_name", type: "VARCHAR" },
            { name: "count_lifetime_orders", type: "BIGINT" },
            { name: "lifetime_spend", type: "DECIMAL" },
          ],
        },
      ],
    });
    expect(result.kind).toBe("uncertified");
    expect(result.block).toBeUndefined();
    expect(result.proposedSql).toContain("analytics.customers");
    expect(result.proposedSql).not.toContain("total_customers");
  });

  it("allows an explicit saved top customers block request to stay certified", async () => {
    kg.rebuild(
      [
        {
          nodeId: "block:top_customers",
          kind: "block",
          name: "top_customers",
          domain: "customers",
          status: "certified",
          description: "Top customers by lifetime spend.",
          llmContext: "Use for the certified top customers block.",
          tags: ["customers", "ranking"],
          sourceTier: "certified_artifact",
          certification: "certified",
          provenance: "DQL block",
        },
      ],
      [],
    );
    const provider = new StubProvider("should not be called");
    const result = await answer({
      question: "Run the certified block top_customers",
      provider,
      kg,
    });
    expect(result.kind).toBe("certified");
    expect(result.block?.nodeId).toBe("block:top_customers");
    expect(provider.calls).toHaveLength(0);
  });

  it("generates dynamic SQL for least-ranked questions instead of selecting a certified top block", async () => {
    kg.rebuild(
      [
        {
          nodeId: "block:top_10_goal_scorers",
          kind: "block",
          name: "top_10_goal_scorers",
          domain: "nba",
          status: "certified",
          description: "Top 10 NBA players by total points scored.",
          llmContext: "Use for highest scoring players and top scorers by season.",
          tags: ["nba", "top", "scorers", "points", "ranking"],
          sourceTier: "certified_artifact",
          certification: "certified",
          provenance: "DQL block",
        },
        {
          nodeId: "dbt_model:player_scoring",
          kind: "dbt_model",
          name: "player_scoring",
          domain: "nba",
          description: "Player scoring fact table with season total points.",
          llmContext: "runtime relation: analytics.player_scoring\nColumns:\n- player_name\n- season\n- total_points",
          sourceTier: "dbt_manifest",
          certification: "ai_generated",
          provenance: "dbt manifest",
        },
      ],
      [],
    );
    const provider = new StubProvider(
      "Players with the fewest total points, generated for review because the certified block covers the top scorers only.\n\n" +
        "```sql\nSELECT player_name, season, total_points FROM analytics.player_scoring ORDER BY total_points ASC LIMIT 10\n```\n\n" +
        "Viz: table",
    );
    const result = await answer({
      question: "Who scored the least points?",
      provider,
      kg,
      schemaContext: [
        {
          relation: "analytics.player_scoring",
          schema: "analytics",
          name: "player_scoring",
          columns: [
            { name: "player_name", type: "VARCHAR" },
            { name: "season", type: "INTEGER" },
            { name: "total_points", type: "INTEGER" },
          ],
        },
      ],
      executeGeneratedSql: async (sql) => ({
        columns: ["player_name", "season", "total_points"],
        rows: [{ player_name: "Bench Player", season: 2024, total_points: 1 }],
        rowCount: 1,
        sql,
      }),
    });
    expect(result.kind).toBe("uncertified");
    expect(result.block).toBeUndefined();
    expect(result.analysisPlan?.intent).toBe("ad_hoc_analysis");
    expect(result.proposedSql).toContain("ORDER BY total_points ASC");
    expect(result.result?.rowCount).toBe(1);
    expect(provider.calls).toHaveLength(1);
  });

  it("uses context-pack block SQL to invert certified top rankings without hallucinating tables", async () => {
    kg.rebuild(
      [
        {
          nodeId: "block:Top 10 Goal Scorers",
          kind: "block",
          name: "Top 10 Goal Scorers",
          domain: "nba",
          status: "certified",
          description: "Top 10 NBA players by total points scored.",
          tags: ["nba", "top", "points"],
          sourceTier: "certified_artifact",
          certification: "certified",
          provenance: "DQL block",
        },
      ],
      [],
    );
    const provider = new StubProvider("should not be called");
    const result = await answer({
      question: "Who scored the least points?",
      provider,
      kg,
      contextPack: {
        id: "ctx_test",
        question: "Who scored the least points?",
        focusObjectKey: "dql:block:Top 10 Goal Scorers",
        mode: "question",
        trustLabel: "mixed",
        objects: [
          {
            objectKey: "dql:block:Top 10 Goal Scorers",
            objectType: "dql_block",
            name: "Top 10 Goal Scorers",
            status: "certified",
            payload: {
              sql: "SELECT player_name, season, total_points FROM NBA_GAMES.RAW.fct_player_performance ORDER BY total_points DESC LIMIT 10",
            },
          },
          {
            objectKey: "dbt:model:fct_player_performance",
            objectType: "dbt_model",
            name: "fct_player_performance",
            status: "dbt_imported",
          },
        ],
        edges: [],
        queryRuns: [],
        citations: [],
        evidenceSummaries: [],
        warnings: [],
        retrievalDiagnostics: {
          strategy: "sqlite_fts",
          selectedObjects: 2,
          selectedEvidence: [],
          topRejected: [],
          candidateConflicts: [],
        },
      } as any,
      executeGeneratedSql: async (sql) => ({
        columns: ["PLAYER_NAME", "SEASON", "TOTAL_POINTS"],
        rows: [{ PLAYER_NAME: "Chris Smith", SEASON: 2013, TOTAL_POINTS: 0 }],
        rowCount: 1,
        sql,
      }),
    });

    expect(result.kind).toBe("uncertified");
    expect(result.proposedSql).toContain("NBA_GAMES.RAW.fct_player_performance");
    expect(result.proposedSql).toContain("ORDER BY total_points ASC");
    expect(result.proposedSql).not.toContain("game_logs");
    expect(result.result?.rowCount).toBe(1);
    expect(provider.calls).toHaveLength(0);
  });

  it("generates dynamic customer ranking SQL instead of selecting total_customers for ad hoc performance questions", async () => {
    kg.rebuild(
      [
        {
          nodeId: "block:total_customers",
          kind: "block",
          name: "total_customers",
          domain: "customers",
          status: "certified",
          description: "Total number of distinct customers.",
          tags: ["customers", "kpi"],
          sourceTier: "certified_artifact",
          certification: "certified",
          provenance: "DQL block",
        },
        {
          nodeId: "block:top_customers",
          kind: "block",
          name: "top_customers",
          domain: "customers",
          status: "certified",
          description: "Top 10 customers by lifetime spend, with order counts.",
          llmContext: "Use for best customers and highest lifetime spend questions.",
          tags: ["customers", "ranking", "orders"],
          sourceTier: "certified_artifact",
          certification: "certified",
          provenance: "DQL block",
        },
        {
          nodeId: "dbt_model:customers",
          kind: "dbt_model",
          name: "customers",
          domain: "customers",
          description: "Customer mart with lifetime spend and order counts.",
          llmContext: "runtime relation: dev.customers\nColumns:\n- customer_name\n- count_lifetime_orders\n- lifetime_spend",
          sourceTier: "dbt_manifest",
          certification: "ai_generated",
          provenance: "dbt manifest",
        },
      ],
      [],
    );
    const provider = new StubProvider("should not be called");
    const result = await answer({
      question: "Can you show me the orders by customer who have performed better?",
      provider,
      kg,
      schemaContext: [
        {
          relation: "dev.customers",
          schema: "dev",
          name: "customers",
          columns: [
            { name: "customer_name", type: "VARCHAR" },
            { name: "count_lifetime_orders", type: "BIGINT" },
            { name: "lifetime_spend", type: "DECIMAL" },
          ],
        },
      ],
      executeGeneratedSql: async (sql) => ({
        columns: ["customer_name", "orders", "lifetime_spend"],
        rows: [
          { customer_name: "Mr. Matthew Meyer", orders: 33, lifetime_spend: 3089.8 },
          { customer_name: "Aaron Gardner", orders: 31, lifetime_spend: 2880.99 },
        ],
        rowCount: 2,
        sql,
      }),
    });
    expect(result.kind).toBe("uncertified");
    expect(result.block).toBeUndefined();
    expect(result.proposedSql).toContain("dev.customers");
    expect(result.proposedSql).toContain("count_lifetime_orders");
    expect(result.proposedSql).not.toContain("total_customers");
    expect(result.sql).toContain("lifetime_spend");
    expect(result.result?.rowCount).toBe(2);
    expect(result.analysisPlan?.intent).toBe("ad_hoc_analysis");
    expect(result.analysisPlan?.assumptions).toEqual(
      expect.arrayContaining([
        expect.stringContaining("local metadata planner"),
      ]),
    );
    expect(result.evidence?.selectedAssets.some((asset) => asset.name === "top_customers")).toBe(true);
    expect(provider.calls).toHaveLength(0);
  });

  it("generates dynamic SQL for a named-customer metric instead of selecting a broad certified KPI", async () => {
    kg.rebuild(
      [
        {
          nodeId: "block:revenue_total",
          kind: "block",
          name: "revenue_total",
          domain: "growth",
          status: "certified",
          description: "Total revenue for the business.",
          tags: ["revenue", "kpi"],
          sourceTier: "certified_artifact",
          certification: "certified",
          provenance: "DQL block",
        },
        {
          nodeId: "dbt_model:orders",
          kind: "dbt_model",
          name: "orders",
          domain: "growth",
          description: "Order fact table with customer revenue.",
          llmContext: "runtime relation: dev.orders\nColumns:\n- customer_name\n- order_total",
          sourceTier: "dbt_manifest",
          certification: "ai_generated",
          provenance: "dbt manifest",
        },
      ],
      [],
    );
    const provider = new StubProvider(
      "Revenue for Matthew Meyer from order totals. This is AI-generated and needs analyst review.\n\n" +
        "```sql\nSELECT customer_name, SUM(order_total) AS revenue FROM dev.orders WHERE customer_name = 'Matthew Meyer' GROUP BY customer_name\n```\n\n" +
        "Viz: single_value",
    );
    const result = await answer({
      question: "What is revenue for customer Matthew Meyer?",
      provider,
      kg,
      schemaContext: [
        {
          relation: "dev.orders",
          schema: "dev",
          name: "orders",
          columns: [
            { name: "customer_name", type: "VARCHAR", sampleValues: ["Matthew Meyer"] },
            { name: "order_total", type: "DECIMAL" },
          ],
        },
      ],
      executeGeneratedSql: async (sql) => ({
        columns: ["customer_name", "revenue"],
        rows: [{ customer_name: "Matthew Meyer", revenue: 3089.8 }],
        rowCount: 1,
        sql,
      }),
    });
    expect(result.kind).toBe("uncertified");
    expect(result.block).toBeUndefined();
    expect(result.analysisPlan?.intent).toBe("ad_hoc_analysis");
    expect(result.proposedSql).toContain("Matthew Meyer");
    expect(result.proposedSql).not.toContain("revenue_total");
    expect(result.result?.rowCount).toBe(1);
    expect(
      provider.messages.some((message) =>
        message.content.includes('matched values: "Matthew Meyer"'),
      ),
    ).toBe(true);
  });

  it("prioritizes customer-context citations when runtime values match a customer table", async () => {
    kg.rebuild(
      [
        {
          nodeId: "block:revenue_by_month",
          kind: "block",
          name: "revenue_by_month",
          domain: "revenue",
          status: "certified",
          description: "Monthly revenue trend.",
          tags: ["revenue", "trend"],
          sourceTier: "certified_artifact",
          certification: "certified",
          provenance: "DQL block",
        },
        {
          nodeId: "block:customer_lifetime_revenue",
          kind: "block",
          name: "customer_lifetime_revenue",
          domain: "customer",
          status: "certified",
          description: "Customer-level lifetime revenue and order count for customer performance reviews.",
          tags: ["customer", "revenue", "performance"],
          sourceTier: "certified_artifact",
          certification: "certified",
          provenance: "DQL block",
        },
      ],
      [],
    );
    const provider = new StubProvider(
      "Revenue for Matthew Meyer from the customer mart. This is AI-generated and needs analyst review.\n\n" +
        "```sql\nSELECT customer_name, lifetime_spend AS revenue FROM analytics.customers WHERE customer_name = 'Matthew Meyer'\n```\n\n" +
        "Viz: table",
    );
    const result = await answer({
      question: "What is revenue for Matthew Meyer?",
      provider,
      kg,
      schemaContext: [
        {
          relation: "analytics.customers",
          schema: "analytics",
          name: "customers",
          columns: [
            { name: "customer_name", type: "VARCHAR", sampleValues: ["Matthew Meyer"] },
            { name: "lifetime_spend", type: "DECIMAL" },
          ],
        },
      ],
      executeGeneratedSql: async (sql) => ({
        columns: ["customer_name", "revenue"],
        rows: [{ customer_name: "Matthew Meyer", revenue: 3089.8 }],
        rowCount: 1,
        sql,
      }),
    });

    expect(result.kind).toBe("uncertified");
    expect(result.citations[0]).toMatchObject({
      kind: "block",
      name: "customer_lifetime_revenue",
    });
    expect(result.evidence?.selectedAssets[0]).toMatchObject({
      kind: "block",
      name: "customer_lifetime_revenue",
    });
  });

  it("surfaces runtime schema evidence for schema-only generated answers", async () => {
    kg.rebuild([], []);
    const provider = new StubProvider(
      "Order count for Matthew Meyer from the runtime orders table. This is AI-generated and needs analyst review.\n\n" +
        "```sql\nSELECT customer_name, COUNT(*) AS orders FROM dev.orders WHERE customer_name = 'Matthew Meyer' GROUP BY customer_name\n```\n\n" +
        "Viz: table",
    );
    const result = await answer({
      question: "How many orders does customer Matthew Meyer have?",
      provider,
      kg,
      schemaContext: [
        {
          relation: "dev.orders",
          schema: "dev",
          name: "orders",
          source: "runtime information_schema",
          columns: [
            { name: "customer_name", type: "VARCHAR", sampleValues: ["Matthew Meyer"] },
            { name: "order_id", type: "VARCHAR" },
          ],
        },
      ],
      executeGeneratedSql: async (sql) => ({
        columns: ["customer_name", "orders"],
        rows: [{ customer_name: "Matthew Meyer", orders: 33 }],
        rowCount: 1,
        sql,
      }),
    });

    expect(result.kind).toBe("uncertified");
    expect(result.citations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "runtime_schema",
          name: "dev.orders",
        }),
      ]),
    );
    expect(result.evidence?.sourceTables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "runtime_schema",
          name: "dev.orders",
        }),
      ]),
    );
    expect(result.evidence?.route).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "inspect_runtime_schema",
          status: "checked",
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

  it("generates review-ready SQL for drillthrough follow-ups even when certified context exists", async () => {
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
    const provider = new StubProvider(
      "Enterprise revenue by segment drillthrough draft.\n\n" +
        "```sql\nSELECT segment, SUM(amount) AS revenue FROM fct_orders WHERE segment = 'Enterprise' GROUP BY segment\n```\n\n" +
        "Viz: bar",
    );
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
    expect(result.kind).toBe("uncertified");
    expect(result.block).toBeUndefined();
    expect(result.proposedSql).toContain("Enterprise");
    expect(result.analysisPlan?.intent).toBe("drillthrough");
    expect(provider.calls.length).toBeGreaterThan(0);
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

  it("repairs generated SQL once after a retryable execution failure", async () => {
    const provider = new StubProvider([
      "Draft using the first guessed column.\n\n```sql\nSELECT customer, SUM(total) AS revenue FROM orders GROUP BY customer\n```\n\nViz: bar",
      "Corrected draft using the available columns.\n\n```sql\nSELECT customer_name, SUM(order_total) AS revenue FROM dev.orders GROUP BY customer_name\n```\n\nViz: bar",
    ]);
    let attempts = 0;
    const result = await answer({
      question: "Show revenue by customer",
      provider,
      kg,
      schemaContext: [
        {
          relation: "dev.orders",
          schema: "dev",
          name: "orders",
          columns: [
            { name: "customer_name", type: "VARCHAR" },
            { name: "order_total", type: "DECIMAL" },
          ],
        },
      ],
      executeGeneratedSql: async (sql) => {
        attempts += 1;
        if (attempts === 1) throw new Error('Binder Error: Referenced column "customer" not found');
        return {
          columns: ["customer_name", "revenue"],
          rows: [{ customer_name: "Acme", revenue: 10 }],
          rowCount: 1,
          sql,
        };
      },
    });
    expect(result.kind).toBe("uncertified");
    expect(result.executionError).toBeUndefined();
    expect(result.proposedSql).toContain("customer_name");
    expect(result.analysisPlan?.repairAttempts).toBe(1);
    expect(provider.calls).toHaveLength(2);
  });

  it("locally repairs generated SQL alias-column binder errors before retrying the model", async () => {
    const provider = new StubProvider(
      "Order detail for top customers.\n\n" +
        "```sql\nWITH TopCustomers AS (SELECT customer_id, lifetime_spend FROM dev.customers ORDER BY lifetime_spend DESC LIMIT 10)\nSELECT t1.order_id, t2.customer_name, t1.order_total FROM dev.orders AS t1 INNER JOIN TopCustomers AS t2 ON t1.customer_id = t2.customer_id INNER JOIN dev.customers AS t3 ON t1.customer_id = t3.customer_id\n```\n\n" +
        "Viz: table",
    );
    let attempts = 0;
    const result = await answer({
      question: "Show order details by top customer",
      provider,
      kg,
      schemaContext: [
        {
          relation: "dev.customers",
          schema: "dev",
          name: "customers",
          columns: [
            { name: "customer_id", type: "VARCHAR" },
            { name: "customer_name", type: "VARCHAR" },
            { name: "lifetime_spend", type: "DECIMAL" },
          ],
        },
        {
          relation: "dev.orders",
          schema: "dev",
          name: "orders",
          columns: [
            { name: "order_id", type: "VARCHAR" },
            { name: "customer_id", type: "VARCHAR" },
            { name: "order_total", type: "DECIMAL" },
          ],
        },
      ],
      executeGeneratedSql: async (sql) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('DuckDB query failed: Binder Error: Values list "t2" does not have a column named "customer_name"');
        }
        return {
          columns: ["order_id", "customer_name", "order_total"],
          rows: [{ order_id: "1", customer_name: "Mr. Matthew Meyer", order_total: 10 }],
          rowCount: 1,
          sql,
        };
      },
    });
    expect(result.kind).toBe("uncertified");
    expect(result.proposedSql).toContain("t3.customer_name");
    expect(result.analysisPlan?.repairAttempts).toBe(1);
    expect(provider.calls).toHaveLength(1);
    expect(result.executionError).toBeUndefined();
  });

  it("asks for clarification when no metadata can ground an analytical question", async () => {
    kg.rebuild([], []);
    const provider = new StubProvider("should not be called");
    const result = await answer({
      question: "Which campaigns performed better?",
      provider,
      kg,
    });
    expect(result.kind).toBe("no_answer");
    expect(result.analysisPlan?.intent).toBe("clarify");
    expect(result.text).toContain("which metric or business object");
    expect(provider.calls).toHaveLength(0);
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
