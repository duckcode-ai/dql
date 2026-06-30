import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KGStore } from "./kg/sqlite-fts.js";
import { answer, parseProposal } from "./answer-loop.js";
import { buildLocalContextPack } from "./metadata/catalog.js";
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

function seedLargeDbtProfileProject(projectRoot: string): void {
  mkdirSync(join(projectRoot, "target"), { recursive: true });
  writeFileSync(join(projectRoot, "dql.config.json"), JSON.stringify({ project: "large_dbt_profile" }), "utf-8");
  const nodes: Record<string, Record<string, unknown>> = {};
  for (let index = 0; index < 220; index += 1) {
    nodes[`model.large_dbt_profile.noisy_${index}`] = {
      resource_type: "model",
      name: `noisy_${index}`,
      alias: `noisy_${index}`,
      database: "NBA_DB",
      schema: "ANALYTICS",
      description: `Unrelated model ${index} in a large dbt repo.`,
      depends_on: { nodes: [] },
      tags: ["noise"],
      original_file_path: `models/noisy/noisy_${index}.sql`,
      config: { materialized: "table" },
      columns: {
        id: { name: "id", data_type: "number" },
        created_at: { name: "created_at", data_type: "timestamp" },
      },
    };
  }
  nodes["model.large_dbt_profile.athlete_box_scores"] = {
    resource_type: "model",
    name: "athlete_box_scores",
    alias: "athlete_box_scores",
    database: "NBA_DB",
    schema: "ANALYTICS",
    description: "Box score rows at game grain for each athlete.",
    depends_on: { nodes: [] },
    tags: ["profile", "stats"],
    original_file_path: "models/marts/athlete_box_scores.sql",
    config: { materialized: "table" },
    columns: {
      athlete_name: {
        name: "athlete_name",
        data_type: "text",
        description: "Name of the athlete.",
      },
      game_date: {
        name: "game_date",
        data_type: "date",
        description: "Date of the game.",
      },
      pts: {
        name: "pts",
        data_type: "number",
        description: "Points recorded.",
      },
      ast: {
        name: "ast",
        data_type: "number",
        description: "Assists recorded.",
      },
      reb: {
        name: "reb",
        data_type: "number",
        description: "Rebounds recorded.",
      },
    },
  };
  writeFileSync(
    join(projectRoot, "target", "manifest.json"),
    JSON.stringify({
      metadata: { project_name: "large_dbt_profile" },
      nodes,
      sources: {},
    }),
    "utf-8",
  );
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
    let executed = false;
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
        executed = true;
        throw new Error("Generated SQL preview only supports read-only SELECT or WITH queries.");
      },
    });
    expect(result.kind).toBe("no_answer");
    expect(result.result).toBeUndefined();
    expect(result.text).toContain("read-only SELECT");
    expect(executed).toBe(false);
    expect(result.evidence?.execution?.status).toBe("not_applicable");
    expect(result.evidence?.route).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "validate_sql",
          status: "failed",
        }),
      ]),
    );
    expect(result.evidence?.validation?.status).toBe("failed");
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
    expect(result.proposedSql).toContain("season");
    expect(result.result?.rowCount).toBe(1);
    expect(provider.calls).toHaveLength(0);
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

  it("generates least-order customer names instead of reusing selected summary blocks", async () => {
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
      question: "I need the customer names who order least performance and less orders?",
      provider,
      kg,
      blockHints: ["top_customers"],
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
          { customer_name: "Low Order Customer", orders: 1, lifetime_spend: 24.5 },
          { customer_name: "Occasional Buyer", orders: 2, lifetime_spend: 80 },
        ],
        rowCount: 2,
        sql,
      }),
    });
    expect(result.kind).toBe("uncertified");
    expect(result.block).toBeUndefined();
    expect(result.proposedSql).toContain("dev.customers");
    expect(result.proposedSql).toContain("customer_name");
    expect(result.proposedSql).toContain("count_lifetime_orders");
    expect(result.proposedSql).toContain("ORDER BY count_lifetime_orders ASC");
    expect(result.proposedSql).not.toContain("total_customers");
    expect(result.proposedSql).not.toContain("revenue_by_month");
    expect(result.result?.rowCount).toBe(2);
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

  it("generates generic dbt-only ranking SQL from inspected relation columns", async () => {
    kg.rebuild([], []);
    const provider = new StubProvider("should not be called");
    const result = await answer({
      question: "Which products have the highest revenue?",
      provider,
      kg,
      schemaContext: [
        {
          relation: "analytics.product_revenue",
          schema: "analytics",
          name: "product_revenue",
          source: "dbt manifest",
          columns: [
            { name: "product_name", type: "VARCHAR" },
            { name: "month", type: "DATE" },
            { name: "revenue", type: "DECIMAL" },
          ],
        },
      ],
      executeGeneratedSql: async (sql) => ({
        columns: ["product_name", "revenue_sum"],
        rows: [{ product_name: "Enterprise Plan", revenue_sum: 200000 }],
        rowCount: 1,
        sql,
      }),
    });

    expect(result.kind).toBe("uncertified");
    expect(result.reviewStatus).toBe("draft_ready");
    expect(result.proposedSql).toContain("FROM analytics.product_revenue");
    expect(result.proposedSql).toContain("product_name");
    expect(result.proposedSql).toContain("SUM(revenue)");
    expect(result.proposedSql).toContain("ORDER BY revenue_sum DESC");
    expect(result.result?.rowCount).toBe(1);
    expect(provider.calls).toHaveLength(0);
  });

  it("generates generic dbt-only trend SQL from inspected relation columns", async () => {
    kg.rebuild([], []);
    const provider = new StubProvider("should not be called");
    const result = await answer({
      question: "Show revenue by month",
      provider,
      kg,
      schemaContext: [
        {
          relation: "analytics.monthly_revenue",
          schema: "analytics",
          name: "monthly_revenue",
          source: "dbt manifest",
          columns: [
            { name: "month", type: "DATE" },
            { name: "revenue", type: "DECIMAL" },
            { name: "customer_count", type: "INTEGER" },
          ],
        },
      ],
    });

    expect(result.kind).toBe("uncertified");
    expect(result.suggestedViz).toBe("line");
    expect(result.proposedSql).toContain("FROM analytics.monthly_revenue");
    expect(result.proposedSql).toContain("GROUP BY month");
    expect(result.proposedSql).toContain("SUM(revenue)");
    expect(provider.calls).toHaveLength(0);
  });

  it("generates distinct entity count SQL when the question asks how many customers", async () => {
    kg.rebuild([], []);
    const provider = new StubProvider("should not be called");
    const result = await answer({
      question: "How many customers by region?",
      provider,
      kg,
      schemaContext: [
        {
          relation: "analytics.customer_orders",
          schema: "analytics",
          name: "customer_orders",
          source: "dbt manifest",
          columns: [
            { name: "customer_id", type: "VARCHAR" },
            { name: "region", type: "VARCHAR" },
            { name: "order_total", type: "DECIMAL" },
          ],
        },
      ],
    });

    expect(result.kind).toBe("uncertified");
    expect(result.proposedSql).toContain("FROM analytics.customer_orders");
    expect(result.proposedSql).toContain("region");
    expect(result.proposedSql).toContain("COUNT(DISTINCT customer_id) AS customer_count");
    expect(result.proposedSql).toContain("GROUP BY region");
    expect(provider.calls).toHaveLength(0);
  });

  it("generates distinct order count SQL for count-by-time questions", async () => {
    kg.rebuild([], []);
    const provider = new StubProvider("should not be called");
    const result = await answer({
      question: "Number of orders by month",
      provider,
      kg,
      schemaContext: [
        {
          relation: "analytics.orders",
          schema: "analytics",
          name: "orders",
          source: "dbt manifest",
          columns: [
            { name: "order_id", type: "VARCHAR" },
            { name: "month", type: "DATE" },
            { name: "amount", type: "DECIMAL" },
          ],
        },
      ],
    });

    expect(result.kind).toBe("uncertified");
    expect(result.suggestedViz).toBe("line");
    expect(result.proposedSql).toContain("FROM analytics.orders");
    expect(result.proposedSql).toContain("COUNT(DISTINCT order_id) AS order_count");
    expect(result.proposedSql).toContain("GROUP BY month");
    expect(provider.calls).toHaveLength(0);
  });

  it("prefers the context-pack selected relation when several dbt tables look plausible", async () => {
    kg.rebuild([], []);
    const provider = new StubProvider("should not be called");
    const schemaContext = [
      {
        relation: "analytics.product_revenue_summary",
        schema: "analytics",
        name: "product_revenue_summary",
        source: "dbt manifest",
        columns: [
          { name: "product_name", type: "VARCHAR" },
          { name: "month", type: "DATE" },
          { name: "revenue", type: "DECIMAL" },
        ],
      },
      {
        relation: "analytics.fct_product_revenue",
        schema: "analytics",
        name: "fct_product_revenue",
        source: "dbt manifest",
        columns: [
          { name: "product_name", type: "VARCHAR" },
          { name: "month", type: "DATE" },
          { name: "net_revenue", type: "DECIMAL" },
        ],
      },
    ];
    const result = await answer({
      question: "Show revenue by product",
      provider,
      kg,
      schemaContext,
      contextPack: contextPackForRankedRelations("Show revenue by product", [
        {
          relation: "analytics.product_revenue_summary",
          name: "product_revenue_summary",
          source: "dbt manifest",
          columns: schemaContext[0]!.columns,
          rank: 2,
          score: 42,
          reason: "secondary model with weaker metadata score",
        },
        {
          relation: "analytics.fct_product_revenue",
          name: "fct_product_revenue",
          source: "dbt manifest",
          columns: schemaContext[1]!.columns,
          rank: 1,
          score: 75,
          reason: "selected by metadata planner for product revenue",
        },
      ]),
    });

    expect(result.kind).toBe("uncertified");
    expect(result.proposedSql).toContain("FROM analytics.fct_product_revenue");
    expect(result.proposedSql).toContain("SUM(net_revenue)");
    expect(result.proposedSql).not.toContain("analytics.product_revenue_summary");
    expect(provider.calls).toHaveLength(0);
  });

  it("generates generic join SQL when a metric fact table needs a requested dimension table", async () => {
    kg.rebuild([], []);
    const provider = new StubProvider("should not be called");
    const schemaContext = [
      {
        relation: "analytics.fct_orders",
        schema: "analytics",
        name: "fct_orders",
        source: "dbt manifest",
        columns: [
          { name: "order_id", type: "VARCHAR" },
          { name: "customer_id", type: "VARCHAR" },
          { name: "revenue", type: "DECIMAL" },
          { name: "order_month", type: "DATE" },
        ],
      },
      {
        relation: "analytics.dim_customers",
        schema: "analytics",
        name: "dim_customers",
        source: "dbt manifest",
        columns: [
          { name: "customer_id", type: "VARCHAR" },
          { name: "customer_name", type: "VARCHAR" },
          { name: "segment", type: "VARCHAR" },
        ],
      },
    ];

    const result = await answer({
      question: "Show revenue by customer segment",
      provider,
      kg,
      schemaContext,
      contextPack: contextPackForRankedRelations("Show revenue by customer segment", [
        {
          relation: "analytics.fct_orders",
          name: "fct_orders",
          source: "dbt manifest",
          columns: schemaContext[0]!.columns,
          rank: 1,
          score: 78,
          reason: "selected fact table for revenue metric",
        },
        {
          relation: "analytics.dim_customers",
          name: "dim_customers",
          source: "dbt manifest",
          columns: schemaContext[1]!.columns,
          rank: 2,
          score: 64,
          reason: "selected dimension table for customer segment",
        },
      ], { dimensionTerms: ["customer", "segment"] }),
      executeGeneratedSql: async (sql) => ({
        columns: ["segment", "revenue_sum"],
        rows: [{ segment: "Enterprise", revenue_sum: 250000 }],
        rowCount: 1,
        sql,
      }),
    });

    expect(result.kind).toBe("uncertified");
    expect(result.proposedSql).toContain("FROM analytics.fct_orders AS f");
    expect(result.proposedSql).toContain("JOIN analytics.dim_customers AS d ON f.customer_id = d.customer_id");
    expect(result.proposedSql).toContain("d.segment AS segment");
    expect(result.proposedSql).toContain("SUM(f.revenue) AS revenue_sum");
    expect(result.proposedSql).toContain("GROUP BY d.segment");
    expect(result.result?.rowCount).toBe(1);
    expect(result.analysisPlan?.candidateJoins[0]).toMatchObject({
      leftRelation: "analytics.fct_orders",
      leftColumn: "customer_id",
      rightRelation: "analytics.dim_customers",
      rightColumn: "customer_id",
      reason: "shared key customer_id",
    });
    expect(provider.calls).toHaveLength(0);
  });

  it("renders ranked relation cards with column meaning for provider-generated SQL", async () => {
    kg.rebuild([], []);
    const provider = new StubProvider(
      "Revenue change by product is generated from the selected dbt relation and needs review.\n\n" +
        "```sql\nSELECT product_name, month, SUM(net_revenue) AS revenue FROM analytics.fct_product_revenue GROUP BY product_name, month ORDER BY month DESC\n```\n\n" +
        "Viz: line",
    );

    const result = await answer({
      question: "Why did revenue change by product?",
      provider,
      kg,
      contextPack: contextPackForRankedRelations("Why did revenue change by product?", [
        {
          relation: "analytics.fct_product_revenue",
          name: "fct_product_revenue",
          source: "dbt manifest",
          columns: [
            { name: "product_id", type: "VARCHAR", description: "Product key" },
            { name: "product_name", type: "VARCHAR", description: "Product display name", sampleValues: ["Starter"] },
            { name: "month", type: "DATE", description: "Revenue month" },
            { name: "net_revenue", type: "DECIMAL", description: "Revenue after refunds and test-account exclusions" },
          ],
          rank: 1,
          score: 81.5,
          reason: "selected by metadata planner for product revenue change",
        },
        {
          relation: "analytics.dim_products",
          name: "dim_products",
          source: "dbt manifest",
          columns: [
            { name: "product_id", type: "VARCHAR", description: "Product key" },
            { name: "product_category", type: "VARCHAR", description: "Product category" },
          ],
          rank: 2,
          score: 55,
          reason: "selected dimension table for product attributes",
        },
      ]),
    });

    const prompt = provider.messages.map((message) => message.content).join("\n\n");
    expect(result.kind).toBe("uncertified");
    expect(provider.calls).toHaveLength(1);
    expect(prompt).toContain("Selected SQL relation context:");
    expect(prompt).toContain("[rank 1, score 81.5] analytics.fct_product_revenue (dbt manifest)");
    expect(prompt).toContain("why selected: selected by metadata planner for product revenue change");
    expect(prompt).toContain("Suggested join paths from selected metadata:");
    expect(prompt).toContain("analytics.fct_product_revenue.product_id -> analytics.dim_products.product_id (shared key product_id)");
    expect(prompt).toContain("product_name VARCHAR - Product display name; matched values: \"Starter\"");
    expect(prompt).toContain("net_revenue DECIMAL - Revenue after refunds and test-account exclusions");
    expect(result.analysisPlan?.candidateTables[0]).toMatchObject({
      relation: "analytics.fct_product_revenue",
      reason: "metadata rank 1: selected by metadata planner for product revenue change",
    });
    expect(result.analysisPlan?.candidateJoins[0]).toMatchObject({
      leftRelation: "analytics.fct_product_revenue",
      leftColumn: "product_id",
      rightRelation: "analytics.dim_products",
      rightColumn: "product_id",
    });
  });

  it("generates review-required entity profile SQL from inspected schema context", async () => {
    kg.rebuild([], []);
    const provider = new StubProvider("should not be called");
    const schemaContext = [
      {
        relation: "analytics.int_player_stats",
        schema: "analytics",
        name: "int_player_stats",
        source: "dbt manifest",
        columns: [
          { name: "player_name", type: "VARCHAR" },
          { name: "season", type: "INTEGER" },
          { name: "team_name", type: "VARCHAR" },
          { name: "total_points", type: "INTEGER" },
          { name: "total_assists", type: "INTEGER" },
          { name: "total_rebounds", type: "INTEGER" },
        ],
      },
    ];
    const result = await answer({
      question: "Can you research on Kevin Durant profile and provide me the complete stats",
      provider,
      kg,
      schemaContext,
      contextPack: {
        id: "ctx_profile",
        question: "Can you research on Kevin Durant profile and provide me the complete stats",
        focusObjectKey: "dbt:model:int_player_stats",
        mode: "question",
        trustLabel: "mixed",
        questionPlan: {
          question: "Can you research on Kevin Durant profile and provide me the complete stats",
          normalizedQuestion: "can you research on kevin durant profile and provide me the complete stats",
          mode: "entity_profile",
          routeIntent: "entity_drilldown",
          entities: [{ text: "Kevin Durant", source: "explicit_filter" }],
          metricTerms: ["stat"],
          dimensionTerms: ["profile"],
          filterTerms: ["kevin", "durant"],
          timeTerms: [],
          outputShape: "profile",
          needsGeneratedSql: true,
          shouldConsiderCertifiedExact: false,
          needsResearchWorkspace: true,
          searchQueries: ["Kevin Durant stat profile"],
          searchTerms: ["kevin", "durant", "stat", "profile"],
          confidence: 0.9,
          reasons: ["classified as entity_profile"],
        },
        objects: [
          {
            objectKey: "dbt:model:int_player_stats",
            objectType: "dbt_model",
            name: "int_player_stats",
            fullName: "analytics.int_player_stats",
            status: "dbt_imported",
          },
        ],
        edges: [],
        queryRuns: [],
        citations: [],
        evidenceSummaries: [],
        warnings: [],
        routeDecision: {
          route: "generated_sql",
          intent: "entity_drilldown",
          reason: "Entity profile questions require generated SQL at the requested entity grain.",
          trustLabel: "mixed",
          reviewStatus: "draft_ready",
          selectedEvidence: [],
          missingContext: [],
          followUps: [],
        },
        evidenceRoles: [],
        allowedSqlContext: {
          relations: schemaContext.map((table) => ({
            relation: table.relation,
            name: table.name,
            source: table.source,
            columns: table.columns,
          })),
          sourceBlockSql: [],
        },
        missingContext: [],
        conflicts: [],
        retrievalDiagnostics: {
          strategy: "sqlite_fts",
          selectedObjects: 1,
          selectedEvidence: [],
          topRejected: [],
          candidateConflicts: [],
        },
        freshness: {
          catalogPath: "/tmp/metadata.sqlite",
          builtAt: null,
          fingerprint: null,
        },
      } as any,
      executeGeneratedSql: async (sql) => ({
        columns: ["player_name", "season", "team_name", "total_points", "total_assists", "total_rebounds"],
        rows: [{ player_name: "Kevin Durant", season: 2024, team_name: "PHX", total_points: 2032, total_assists: 320, total_rebounds: 512 }],
        rowCount: 1,
        sql,
      }),
    });

    expect(result.kind).toBe("uncertified");
    expect(result.block).toBeUndefined();
    expect(result.reviewStatus).toBe("draft_ready");
    expect(result.analysisPlan?.intent).toBe("entity_drilldown");
    expect(result.proposedSql).toContain("analytics.int_player_stats");
    expect(result.proposedSql).toContain("player_name = 'Kevin Durant'");
    expect(result.proposedSql).toContain("total_points");
    expect(result.result?.rowCount).toBe(1);
    expect(provider.calls).toHaveLength(0);
  });

  it("generates entity profile SQL from catalog-only dbt models in a large repo", async () => {
    kg.rebuild([], []);
    const projectRoot = join(dir, "large-dbt-project");
    seedLargeDbtProfileProject(projectRoot);
    const provider = new StubProvider("should not be called");
    const question = "Can you research Kevin Durant profile and provide complete stats";
    const contextPack = await buildLocalContextPack(projectRoot, {
      question,
      limit: 80,
    });

    const result = await answer({
      question,
      provider,
      kg,
      contextPack,
      executeGeneratedSql: async (sql) => ({
        columns: ["athlete_name", "game_date", "pts", "ast", "reb"],
        rows: [{
          athlete_name: "Kevin Durant",
          game_date: "2024-01-01",
          pts: 31,
          ast: 5,
          reb: 8,
        }],
        rowCount: 1,
        sql,
      }),
    });

    expect(contextPack.retrievalDiagnostics.schemaShapeCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          objectKey: "dbt:model:athlete_box_scores",
          relation: "NBA_DB.ANALYTICS.athlete_box_scores",
        }),
      ]),
    );
    expect(contextPack.allowedSqlContext.relations.map((relation) => relation.relation)).toContain("NBA_DB.ANALYTICS.athlete_box_scores");
    expect(result.kind).toBe("uncertified");
    expect(result.reviewStatus).toBe("draft_ready");
    expect(result.proposedSql).toContain("NBA_DB.ANALYTICS.athlete_box_scores");
    expect(result.proposedSql).toContain("athlete_name = 'Kevin Durant'");
    expect(result.proposedSql).toContain("game_date");
    expect(result.proposedSql).toContain("pts");
    expect(result.result?.rowCount).toBe(1);
    expect(provider.calls).toHaveLength(0);
  });

  it("uses certified block SQL shape as context for entity profiles when dbt columns are unavailable", async () => {
    kg.rebuild([], []);
    const provider = new StubProvider("should not be called");
    const result = await answer({
      question: "Can you research on Kevin Durant profile and provide me the complete stats",
      provider,
      kg,
      contextPack: {
        id: "ctx_profile_sql_shape",
        question: "Can you research on Kevin Durant profile and provide me the complete stats",
        focusObjectKey: "dql:block:Top 10 Goal Scorers",
        mode: "question",
        trustLabel: "mixed",
        questionPlan: {
          question: "Can you research on Kevin Durant profile and provide me the complete stats",
          normalizedQuestion: "can you research on kevin durant profile and provide me the complete stats",
          mode: "entity_profile",
          routeIntent: "entity_drilldown",
          entities: [{ text: "Kevin Durant", source: "explicit_filter" }],
          metricTerms: ["stat"],
          dimensionTerms: ["profile"],
          filterTerms: ["kevin", "durant"],
          timeTerms: [],
          outputShape: "profile",
          needsGeneratedSql: true,
          shouldConsiderCertifiedExact: false,
          needsResearchWorkspace: true,
          searchQueries: ["Kevin Durant stat profile"],
          searchTerms: ["kevin", "durant", "stat", "profile"],
          confidence: 0.9,
          reasons: ["classified as entity_profile"],
        },
        objects: [
          {
            objectKey: "dql:block:Top 10 Goal Scorers",
            objectType: "dql_block",
            name: "Top 10 Goal Scorers",
            status: "certified",
            payload: {
              sql: [
                "SELECT player_name, season, total_points, games_played,",
                "ROUND(total_points / NULLIF(games_played, 0), 2) AS points_per_game",
                "FROM NBA_GAMES.RAW.fct_player_performance",
                "WHERE season = 2016",
                "ORDER BY total_points DESC",
                "LIMIT 10",
              ].join("\n"),
            },
          },
        ],
        edges: [],
        queryRuns: [],
        citations: [],
        evidenceSummaries: [],
        warnings: [],
        routeDecision: {
          route: "generated_sql",
          intent: "entity_drilldown",
          reason: "Use certified player stats as context only for the requested entity profile.",
          trustLabel: "mixed",
          reviewStatus: "draft_ready",
          certifiedApplicability: {
            objectKey: "dql:block:Top 10 Goal Scorers",
            name: "Top 10 Goal Scorers",
            kind: "context_only",
            score: 44,
            reasons: ["question asks for a different entity grain"],
          },
          selectedEvidence: [],
          missingContext: [],
          followUps: [],
        },
        evidenceRoles: [],
        allowedSqlContext: {
          relations: [
            {
              relation: "NBA_GAMES.RAW.fct_player_performance",
              name: "fct_player_performance",
              source: "certified block dependency",
              columns: [],
            },
          ],
          sourceBlockSql: [
            {
              objectKey: "dql:block:Top 10 Goal Scorers",
              name: "Top 10 Goal Scorers",
              status: "certified",
              sql: [
                "SELECT player_name, season, total_points, games_played,",
                "ROUND(total_points / NULLIF(games_played, 0), 2) AS points_per_game",
                "FROM NBA_GAMES.RAW.fct_player_performance",
                "WHERE season = 2016",
                "ORDER BY total_points DESC",
                "LIMIT 10",
              ].join("\n"),
            },
          ],
        },
        missingContext: [],
        conflicts: [],
        retrievalDiagnostics: {
          strategy: "sqlite_fts",
          selectedObjects: 1,
          selectedEvidence: [],
          topRejected: [],
          candidateConflicts: [],
        },
        freshness: {
          catalogPath: "/tmp/metadata.sqlite",
          builtAt: null,
          fingerprint: null,
        },
      } as any,
      executeGeneratedSql: async (sql) => ({
        columns: ["player_name", "season", "total_points", "games_played", "points_per_game"],
        rows: [{ player_name: "Kevin Durant", season: 2016, total_points: 1555, games_played: 62, points_per_game: 25.08 }],
        rowCount: 1,
        sql,
      }),
    });

    expect(result.kind).toBe("uncertified");
    expect(result.proposedSql).toContain("NBA_GAMES.RAW.fct_player_performance");
    expect(result.proposedSql).toContain("player_name = 'Kevin Durant'");
    expect(result.proposedSql).toContain("points_per_game");
    expect(result.validationWarnings ?? []).not.toEqual(
      expect.arrayContaining([expect.stringContaining("Column validation was advisory")]),
    );
    expect(result.result?.rowCount).toBe(1);
    expect(provider.calls).toHaveLength(0);
  });

  it("passes certified SQL shape context to the provider when relation columns are sparse", async () => {
    kg.rebuild([], []);
    const provider = new StubProvider(
      "Team scoring comparison generated from certified source SQL shape.\n\n" +
        "```sql\nSELECT team_name, SUM(total_points) AS total_points FROM NBA_GAMES.RAW.fct_player_performance GROUP BY team_name ORDER BY total_points DESC\n```\n\n" +
        "Viz: bar",
    );
    const result = await answer({
      question: "Compare scoring by team",
      provider,
      kg,
      contextPack: {
        id: "ctx_sparse_shape",
        question: "Compare scoring by team",
        focusObjectKey: "dql:block:Top 10 Goal Scorers",
        mode: "question",
        trustLabel: "mixed",
        questionPlan: {
          question: "Compare scoring by team",
          normalizedQuestion: "compare scoring by team",
          mode: "comparison",
          routeIntent: "segment_compare",
          entities: [],
          metricTerms: ["scoring"],
          dimensionTerms: ["team"],
          filterTerms: [],
          timeTerms: [],
          outputShape: "table",
          needsGeneratedSql: true,
          shouldConsiderCertifiedExact: false,
          needsResearchWorkspace: true,
          searchQueries: ["scoring team"],
          searchTerms: ["scoring", "team"],
          confidence: 0.82,
          reasons: ["classified as comparison"],
        },
        objects: [
          {
            objectKey: "dql:block:Top 10 Goal Scorers",
            objectType: "dql_block",
            name: "Top 10 Goal Scorers",
            status: "certified",
            payload: {
              sql: "SELECT player_name, team_name, season, total_points FROM NBA_GAMES.RAW.fct_player_performance ORDER BY total_points DESC LIMIT 10",
            },
          },
        ],
        edges: [],
        queryRuns: [],
        citations: [],
        evidenceSummaries: [],
        warnings: [],
        routeDecision: {
          route: "generated_sql",
          intent: "segment_compare",
          reason: "Use certified scoring block as context only for the requested team comparison.",
          trustLabel: "mixed",
          reviewStatus: "draft_ready",
          certifiedApplicability: {
            objectKey: "dql:block:Top 10 Goal Scorers",
            name: "Top 10 Goal Scorers",
            kind: "context_only",
            score: 38,
            reasons: ["question asks for a different team grain"],
          },
          selectedEvidence: [],
          missingContext: [],
          followUps: [],
        },
        evidenceRoles: [],
        allowedSqlContext: {
          relations: [
            {
              relation: "NBA_GAMES.RAW.fct_player_performance",
              name: "fct_player_performance",
              source: "certified block dependency",
              columns: [],
            },
          ],
          sourceBlockSql: [
            {
              objectKey: "dql:block:Top 10 Goal Scorers",
              name: "Top 10 Goal Scorers",
              status: "certified",
              sql: "SELECT player_name, team_name, season, total_points FROM NBA_GAMES.RAW.fct_player_performance ORDER BY total_points DESC LIMIT 10",
            },
          ],
        },
        missingContext: [],
        conflicts: [],
        retrievalDiagnostics: {
          strategy: "sqlite_fts",
          selectedObjects: 1,
          selectedEvidence: [],
          topRejected: [],
          candidateConflicts: [],
        },
        freshness: {
          catalogPath: "/tmp/metadata.sqlite",
          builtAt: null,
          fingerprint: null,
        },
      } as any,
    });

    const prompt = provider.messages.map((message) => message.content).join("\n\n");
    expect(result.kind).toBe("uncertified");
    expect(provider.calls).toHaveLength(1);
    expect(prompt).toContain("Worked examples from certified blocks");
    expect(prompt).toContain("relation: NBA_GAMES.RAW.fct_player_performance");
    expect(prompt).toContain("projected columns: player_name, team_name, season, total_points");
    expect(result.validationWarnings ?? []).not.toEqual(
      expect.arrayContaining([expect.stringContaining("Column validation was advisory")]),
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

  it("uses a distinct certified drilldown block when the follow-up grain is covered", async () => {
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
    expect(result.block?.name).toBe("revenue_by_segment");
    expect(result.analysisPlan?.intent).toBe("drillthrough");
    expect(provider.calls.length).toBe(0);
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
	    captureGeneratedDraft: ({ followUp, sourceBlock }) => ({
	      path: `blocks/_drafts/${followUp?.sourceBlockName ?? sourceBlock?.name ?? "draft"}.dql`,
	      askedTimes: 1,
	      proposedContractId: "growth.Unknown.enterprise_drilldown",
	    }),
	  });
	    expect(result.kind).toBe("uncertified");
	    expect(result.reviewStatus).toBe("draft_ready");
	    expect(result.text).toContain("This is an uncertified drilldown.");
	    expect(result.proposedSql).toContain("segment = 'Enterprise'");
	    expect(result.sourceCertifiedBlock).toBe("revenue_total");
	    expect(result.draftBlock?.path).toBe("blocks/_drafts/revenue_total.dql");
	    expect(result.promoteCommand).toContain("dql certify --from-draft");
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

  it("rejects generated drilldown SQL before execution when a filter uses the wrong inspected column", async () => {
    const provider = new StubProvider(
      "Enterprise revenue drilldown draft.\n\n" +
        "```sql\nSELECT segment, SUM(amount) AS revenue FROM fct_orders WHERE customer = 'Enterprise' GROUP BY segment\n```\n\n" +
        "Viz: table",
    );
    let executed = false;
    let captured = false;
    const result = await answer({
      question: "Break that down by segment for Enterprise last week",
      provider,
      kg,
      followUp: {
        kind: "drilldown",
        sourceBlockName: "revenue_total",
        filters: ["Enterprise", "last week"],
        dimensions: ["segment"],
      },
      contextPack: {
        id: "ctx_enterprise",
        question: "Break that down by segment for Enterprise last week",
        focusObjectKey: "dql:block:revenue_total",
        mode: "question",
        trustLabel: "mixed",
        objects: [],
        edges: [],
        queryRuns: [],
        citations: [],
        evidenceSummaries: [],
        warnings: [],
        routeDecision: {
          route: "generated_sql",
          intent: "entity_drilldown",
          reason: "follow-up drilldown",
          trustLabel: "mixed",
          reviewStatus: "draft_ready",
          selectedEvidence: [],
          missingContext: [],
          followUps: [],
        },
        evidenceRoles: [],
        allowedSqlContext: {
          relations: [{
            relation: "fct_orders",
            name: "fct_orders",
            source: "runtime schema",
            columns: [
              { name: "week" },
              { name: "segment", sampleValues: ["Enterprise"] },
              { name: "customer", sampleValues: ["Acme Corp"] },
              { name: "amount" },
            ],
          }],
          sourceBlockSql: [],
        },
        missingContext: [],
        conflicts: [],
        retrievalDiagnostics: {
          strategy: "sqlite_fts",
          selectedObjects: 0,
          selectedEvidence: [],
          topRejected: [],
          candidateConflicts: [],
        },
        freshness: {
          catalogPath: ".dql/cache/metadata.sqlite",
          builtAt: null,
          fingerprint: null,
        },
      } as any,
      executeGeneratedSql: async () => {
        executed = true;
        throw new Error("should not execute invalid SQL");
      },
      captureGeneratedDraft: () => {
        captured = true;
        throw new Error("should not capture invalid SQL");
      },
    });

    expect(result.kind).toBe("no_answer");
    expect(result.text).toContain("could not safely prepare");
    expect(result.evidence?.validation?.message).toContain("filters \"Enterprise\" on customer");
    expect(executed).toBe(false);
    expect(captured).toBe(false);
  });

  it("plans a clear entity follow-up drilldown from inspected values and source block SQL", async () => {
    const provider = new StubProvider("provider should not be called");
    let executedSql = "";
    let capturedSql = "";
    const result = await answer({
      question: "Break Enterprise revenue down by customer last week",
      provider,
      kg,
      followUp: {
        kind: "drilldown",
        sourceBlockName: "revenue_total",
        filters: ["Enterprise", "last week"],
        dimensions: ["customer"],
      },
      schemaContext: [],
      contextPack: {
        id: "ctx_enterprise_customer",
        question: "Break Enterprise revenue down by customer last week",
        focusObjectKey: "dql:block:revenue_total",
        mode: "question",
        trustLabel: "mixed",
        objects: [],
        edges: [],
        queryRuns: [],
        citations: [],
        evidenceSummaries: [],
        warnings: [],
        routeDecision: {
          route: "generated_sql",
          intent: "entity_drilldown",
          reason: "follow-up drilldown",
          trustLabel: "mixed",
          reviewStatus: "draft_ready",
          selectedEvidence: [],
          missingContext: [],
          followUps: [],
        },
        evidenceRoles: [],
        allowedSqlContext: {
          relations: [{
            relation: "main.revenue",
            name: "revenue",
            source: "runtime schema",
            columns: [
              { name: "week" },
              { name: "segment", sampleValues: ["Enterprise"] },
              { name: "customer", sampleValues: ["Acme Corp"] },
              { name: "revenue" },
            ],
          }],
          sourceBlockSql: [{
            objectKey: "dql:block:revenue_total",
            name: "revenue_total",
            status: "certified",
            sql: "SELECT SUM(revenue) AS revenue_total FROM main.revenue WHERE week = DATE '2026-06-08'",
          }],
        },
        missingContext: [],
        conflicts: [],
        retrievalDiagnostics: {
          strategy: "sqlite_fts",
          selectedObjects: 0,
          selectedEvidence: [],
          topRejected: [],
          candidateConflicts: [],
        },
        freshness: {
          catalogPath: ".dql/cache/metadata.sqlite",
          builtAt: null,
          fingerprint: null,
        },
      } as any,
      executeGeneratedSql: async (sql) => {
        executedSql = sql;
        return {
          columns: ["customer", "revenue_total"],
          rows: [{ customer: "Acme Corp", revenue_total: 12000 }],
          rowCount: 1,
          sql,
        };
      },
      captureGeneratedDraft: ({ sql }) => {
        capturedSql = sql;
        return {
          path: "blocks/_drafts/break_enterprise_revenue_down_by_customer_last_week.dql",
          askedTimes: 1,
          proposedContractId: "growth.Unknown.break_enterprise",
        };
      },
    });

    expect(result.kind).toBe("uncertified");
    expect(result.reviewStatus).toBe("draft_ready");
    expect(result.proposedSql).toContain("FROM main.revenue");
    expect(result.proposedSql).toContain("segment = 'Enterprise'");
    expect(result.proposedSql).toContain("week = DATE '2026-06-08'");
    expect(result.proposedSql).toContain("GROUP BY customer");
    expect(result.proposedSql).not.toContain("total_revenue");
    expect(executedSql).toBe(result.proposedSql);
    expect(capturedSql).toBe(result.proposedSql);
    expect(provider.calls).toHaveLength(0);
    expect(result.draftBlock?.path).toContain("blocks/_drafts/");
  });

  it("repairs generated SQL once after a retryable execution failure", async () => {
    const provider = new StubProvider([
      "Draft using the first guessed column.\n\n```sql\nSELECT customer, SUM(total) AS revenue FROM orders GROUP BY customer\n```\n\nViz: bar",
      "Corrected draft using the available columns.\n\n```sql\nSELECT customer_name, SUM(order_total) AS revenue FROM dev.orders GROUP BY customer_name\n```\n\nViz: bar",
    ]);
    let attempts = 0;
    const result = await answer({
      question: "Repair revenue by customer",
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

  it("rejects provider SQL that selects unknown columns from a joined CTE before execution", async () => {
    const provider = new StubProvider(
      "Draft diagnostic SQL.\n\n" +
        "```sql\nWITH enterprise AS (\n  SELECT o.amount AS revenue, c.segment\n  FROM analytics.fct_orders o\n  JOIN analytics.dim_customers c ON o.customer_id = c.customer_id\n)\nSELECT fake_column FROM enterprise\n```\n\n" +
        "Viz: table",
    );
    let executed = false;
    const question = "Why did revenue change by segment?";
    const result = await answer({
      question,
      provider,
      kg,
      contextPack: contextPackForRankedRelations(question, [
        {
          relation: "analytics.fct_orders",
          name: "fct_orders",
          source: "dbt manifest",
          columns: [
            { name: "customer_id", type: "VARCHAR" },
            { name: "amount", type: "DECIMAL" },
            { name: "week", type: "DATE" },
          ],
          rank: 1,
          score: 80,
          reason: "selected revenue fact table",
        },
        {
          relation: "analytics.dim_customers",
          name: "dim_customers",
          source: "dbt manifest",
          columns: [
            { name: "customer_id", type: "VARCHAR" },
            { name: "segment", type: "VARCHAR" },
          ],
          rank: 2,
          score: 65,
          reason: "selected customer dimension",
        },
      ], {
        metricTerms: ["revenue"],
        dimensionTerms: ["segment"],
        mode: "diagnose_change",
        routeIntent: "diagnose_change",
      }),
      executeGeneratedSql: async (sql) => {
        executed = true;
        return { columns: ["fake_column"], rows: [], rowCount: 0, sql };
      },
    });

    expect(result.kind).toBe("no_answer");
    expect(result.text).toContain('column "fake_column"');
    expect(executed).toBe(false);
    expect(provider.calls).toHaveLength(1);
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

function contextPackForRankedRelations(
  question: string,
  relations: Array<{
    relation: string;
    name: string;
    source: string;
    columns: Array<{ name: string; type?: string; description?: string; sampleValues?: string[] }>;
    rank: number;
    score: number;
    reason: string;
  }>,
  options: { metricTerms?: string[]; dimensionTerms?: string[]; mode?: string; routeIntent?: string } = {},
) {
  const metricTerms = options.metricTerms ?? ["revenue"];
  const dimensionTerms = options.dimensionTerms ?? ["product"];
  const mode = options.mode ?? "general_analysis";
  const routeIntent = options.routeIntent ?? "driver_breakdown";
  return {
    id: "ctx_ranked_relations",
    question,
    focusObjectKey: null,
    mode: "question",
    trustLabel: "mixed",
    questionPlan: {
      question,
      normalizedQuestion: question.toLowerCase(),
      mode,
      routeIntent,
      entities: [],
      metricTerms,
      dimensionTerms,
      filterTerms: [],
      timeTerms: [],
      outputShape: "table",
      needsGeneratedSql: true,
      shouldConsiderCertifiedExact: false,
      needsResearchWorkspace: false,
      searchQueries: [question],
      searchTerms: [...metricTerms, ...dimensionTerms],
      confidence: 0.85,
      reasons: ["test context"],
    },
    objects: [],
    edges: [],
    queryRuns: [],
    citations: [],
    evidenceSummaries: [],
    warnings: [],
    routeDecision: {
      route: "generated_sql",
      intent: routeIntent,
      reason: "Use selected dbt metadata context.",
      trustLabel: "mixed",
      reviewStatus: "draft_ready",
      selectedEvidence: [],
      missingContext: [],
      followUps: [],
    },
    evidenceRoles: [],
    allowedSqlContext: {
      relations: relations.map(({ rank: _rank, score: _score, reason: _reason, ...relation }) => relation),
      sourceBlockSql: [],
    },
    missingContext: [],
    conflicts: [],
    retrievalDiagnostics: {
      strategy: "sqlite_fts",
      selectedObjects: relations.length,
      selectedEvidence: [],
      selectedRelations: relations.map((relation) => ({
        relation: relation.relation,
        name: relation.name,
        source: relation.source,
        score: relation.score,
        reason: relation.reason,
        columns: relation.columns.map((column) => column.name),
        rank: relation.rank,
      })),
      topRejected: [],
      candidateConflicts: [],
    },
    freshness: {
      catalogPath: "/tmp/metadata.sqlite",
      builtAt: null,
      fingerprint: null,
    },
  } as any;
}

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

describe("answer — freshness-aware trust", () => {
  function certifiedBlockWithDataState(
    dataState: "fresh" | "stale" | "failed" | undefined,
  ): KGNode {
    return {
      nodeId: "block:orders_total",
      kind: "block",
      name: "orders_total",
      domain: "sales",
      status: "certified",
      description: "Total orders KPI.",
      tags: ["orders", "kpi"],
      sourceTier: "certified_artifact",
      certification: "certified",
      provenance: "DQL block",
      dataState,
      dataStateDetail:
        dataState === "failed"
          ? 'Upstream dbt model "orders_raw" last run failed (status: error).'
          : dataState === "stale"
            ? 'Upstream data from "orders_raw" is past its freshness window.'
            : undefined,
    };
  }

  it('labels a certified block with a failed upstream "Certified · upstream failed" and caveats the answer', async () => {
    kg.rebuild([certifiedBlockWithDataState("failed")], []);
    const provider = new StubProvider("should not be called");
    const result = await answer({ question: "What is total orders?", provider, kg });

    expect(result.kind).toBe("certified");
    expect(result.trustLabelInfo?.display).toBe("Certified · upstream failed");
    expect(result.text).toMatch(/upstream dbt model.*last run failed/i);
  });

  it('labels a certified block with stale upstream data "Certified · stale data"', async () => {
    kg.rebuild([certifiedBlockWithDataState("stale")], []);
    const provider = new StubProvider("should not be called");
    const result = await answer({ question: "What is total orders?", provider, kg });

    expect(result.kind).toBe("certified");
    expect(result.trustLabelInfo?.display).toBe("Certified · stale data");
    expect(result.text).toMatch(/stale/i);
  });

  it('leaves a certified block with fresh upstreams as plain "Certified" with no caveat', async () => {
    kg.rebuild([certifiedBlockWithDataState("fresh")], []);
    const provider = new StubProvider("should not be called");
    const result = await answer({ question: "What is total orders?", provider, kg });

    expect(result.kind).toBe("certified");
    expect(result.trustLabelInfo?.display).toBe("Certified");
    expect(result.text).not.toMatch(/Data caveat/i);
  });

  it("is backward compatible: no dataState → plain Certified (degrades to unknown)", async () => {
    kg.rebuild([certifiedBlockWithDataState(undefined)], []);
    const provider = new StubProvider("should not be called");
    const result = await answer({ question: "What is total orders?", provider, kg });

    expect(result.kind).toBe("certified");
    expect(result.trustLabelInfo?.display).toBe("Certified");
  });
});

describe("answer route exposure + semantic-metric routing (spec 17, part C)", () => {
  function revenueMetric(name: string, description: string): KGNode {
    return {
      nodeId: `metric:${name}`,
      kind: "metric",
      name,
      domain: "finance",
      description,
      tags: ["revenue"],
      llmContext: `sql: SUM(amount)\ntable: dev.order_items`,
      sourceTier: "semantic_layer",
      certification: "ai_generated",
      provenance: "semantic layer",
    };
  }

  function seedMetricsKg(): void {
    kg.rebuild(
      [
        revenueMetric("cumulative_revenue", "Running total of recognized revenue"),
        revenueMetric("food_revenue", "Revenue from food line items"),
        revenueMetric("drink_revenue", "Revenue from drink line items"),
      ],
      [],
    );
  }

  it("routes a clear metric question to semantic_metric with a metric ref (the reported miss)", async () => {
    seedMetricsKg();
    const provider = new StubProvider(
      "Total revenue from the governed metric.\n\n```sql\nSELECT SUM(amount) AS revenue FROM dev.order_items\n```\n\nViz: single_value",
    );
    const result = await answer({ question: "what is our total revenue", provider, kg });
    expect(result.kind).not.toBe("no_answer");
    expect(result.route?.tier).toBe("semantic_metric");
    expect(result.route?.ref).toMatch(/revenue/);
    expect(result.route?.label).toContain("metric");
  });

  it("answers a metric question deterministically even when the model declines SQL", async () => {
    seedMetricsKg();
    // A provider that returns prose with no SQL block would normally refuse; the
    // matched governed metric must still answer (offline-safe metric SQL).
    const provider = new StubProvider("I am not sure how to write that SQL.");
    const result = await answer({ question: "show me total revenue", provider, kg });
    expect(result.route?.tier).toBe("semantic_metric");
    expect(result.proposedSql ?? result.sql ?? "").toMatch(/SUM\(amount\)/i);
  });

  it("routes an ad-hoc analytical question to generated_sql", async () => {
    seedMetricsKg();
    const provider = new StubProvider(
      "Median order value by region.\n\n```sql\nSELECT region, MEDIAN(amount) FROM dev.order_items GROUP BY region\n```\n\nViz: bar",
    );
    const result = await answer({ question: "median order value by region", provider, kg });
    expect(result.route?.tier).toBe("generated_sql");
  });

  it("preserves certified-first routing (certified_block route)", async () => {
    // Uses the top-level beforeEach KG with block:revenue_total certified.
    const provider = new StubProvider("should not be called");
    const result = await answer({ question: "What was revenue this quarter?", provider, kg });
    expect(result.kind).toBe("certified");
    expect(result.route?.tier).toBe("certified_block");
    expect(result.route?.ref).toBe("revenue_total");
  });

  it("keeps an honest refusal as no_answer when nothing fits", async () => {
    kg.rebuild([], []);
    const provider = new StubProvider("I cannot answer that.");
    const result = await answer({ question: "qwfp zxcv asdf", provider, kg });
    expect(result.kind).toBe("no_answer");
    expect(result.route?.tier).toBe("no_answer");
  });
});
