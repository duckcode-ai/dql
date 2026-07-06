import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SemanticLayer } from "@duckcodeailabs/dql-core";
import { KGStore } from "./kg/sqlite-fts.js";
import { answer as answerBase, parseProposal } from "./answer-loop.js";
import { buildLocalContextPack } from "./metadata/catalog.js";
import type { KGNode } from "./kg/types.js";
import type { CertifiedBlockApplicability } from "./metadata/analysis-planner.js";
import type { CertifiedBlockFit } from "./metadata/block-fit.js";
import type { AgentProvider, AgentMessage, AgentToolDefinition, ProviderToolLoopOptions } from "./providers/types.js";

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

class ToolStubProvider extends StubProvider {
  toolCalls: Array<{ toolNames: string[]; maxToolCalls?: number }> = [];

  async generateWithTools(
    messages: AgentMessage[],
    tools: AgentToolDefinition[],
    options?: ProviderToolLoopOptions,
  ): Promise<string> {
    this.messages = messages;
    this.toolCalls.push({ toolNames: tools.map((tool) => tool.name), maxToolCalls: options?.maxToolCalls });
    const tool = tools.find((candidate) => candidate.name === "inspect_metadata_context");
    if (tool) {
      const input = { question: "tool-assisted generation" };
      const output = await tool.run(input);
      options?.onToolCall?.({ name: tool.name, input, output, isError: false });
    }
    return "```json\n{\"summary\":\"Tool-assisted SQL proposal.\",\"sql\":\"SELECT region, COUNT(*) AS order_count FROM orders GROUP BY region\",\"viz\":\"bar\",\"outputs\":[\"region\",\"order_count\"]}\n```";
  }
}

function inspectMetadataTool(observed: unknown[] = []): AgentToolDefinition {
  return {
    name: "inspect_metadata_context",
    description: "Inspect context.",
    inputSchema: { type: "object", properties: { question: { type: "string" } } },
    run: async (args) => {
      observed.push(args);
      return { contextPackId: "ctx_test", selectedRelations: ["orders"] };
    },
  };
}

function answer(input: Parameters<typeof answerBase>[0]) {
  return answerBase(input);
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
    expect(result.evidence?.route[0]).toMatchObject({
      tool: "cascade_triage",
      status: "checked",
    });
    expect(result.evidence?.route).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "cascade_certified",
          status: "selected",
        }),
        expect.objectContaining({
          tool: "search_certified_artifacts",
          status: "selected",
        }),
      ]),
    );
    expect(result.evidence?.selectedAssets[0].nodeId).toBe(
      "block:revenue_total",
    );
    expect(result.evidence?.outcome?.name).toContain("Revenue leadership");
    expect(result.cascade).toMatchObject({
      terminalLane: "certified",
      routeTier: "certified_block",
      ref: "revenue_total",
      outcome: {
        lane: "certified",
        routeTier: "certified_block",
        ref: "revenue_total",
        executionStatus: "not_requested",
      },
    });
  });

  it("Tier 2: a governed semantic metric EXECUTES deterministically with zero LLM calls", async () => {
    // Governed hierarchy: certified blocks → semantic metrics → generated SQL.
    // With no certified block in play, a confident metric match must run the
    // metric's own definition and return rows — the provider is never invoked.
    kg.rebuild(
      [
        {
          nodeId: "metric:order_item.revenue",
          kind: "metric",
          name: "order_item.revenue",
          domain: "growth",
          status: "certified",
          description: "Recognized revenue measure over order items.",
          llmContext: "sql: SUM(product_price)\ntable: dev.order_items",
          sourceTier: "semantic_layer",
        },
      ],
      [],
    );
    const provider = new StubProvider("should never be called");
    const executed: string[] = [];
    const result = await answer({
      question: "what is our total revenue?",
      provider,
      kg,
      executeGeneratedSql: async (sql) => {
        executed.push(sql);
        return {
          columns: ["order_item_revenue"],
          rows: [{ order_item_revenue: 785425.37 }],
          rowCount: 1,
          executionTime: 4,
          sql,
        };
      },
    });
    // The metric definition ran — real rows, real SQL, no model involvement.
    expect(provider.messages).toHaveLength(0);
    expect(executed).toHaveLength(1);
    expect(executed[0]).toContain("SUM(product_price)");
    expect(result.result?.rowCount).toBe(1);
    expect(result.sourceTier).toBe("semantic_layer");
    expect(result.text).toContain("governed metric order_item.revenue");
  });

  it("does NOT terminate a data conversation with a business-view document (360-profile regression)", async () => {
    // Prior turn returned customer rows; the follow-up asks for a specific
    // customer's profile. A certified business VIEW may only ground the answer —
    // never BE the answer ("certified" must mean an executable definition ran).
    const provider = new StubProvider(
      "```sql\nSELECT customer_name, lifetime_spend FROM dim_customers WHERE customer_name = 'Mr. Matthew Meyer'\n```",
    );
    const result = await answer({
      question: "so Matthew is the top so what is his revenue health profile view?",
      provider,
      kg,
      followUp: {
        kind: "contextual",
        sourceQuestion: "who are the customers? give me the customers info",
        priorResultColumns: ["customer_name", "customer_type", "lifetime_spend"],
        priorResultValues: { customer_name: ["Mr. Matthew Meyer", "Aaron Gardner"] },
      },
    });
    // The certified business view must not short-circuit into a no-data
    // "certified" answer; the loop proceeds to an executable tier instead.
    expect(result.kind === "certified" && !result.result).toBe(false);
    expect(result.sourceTier === "business_context" && !result.result).toBe(false);
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
          sourcePath: "blocks/total_revenue.dql",
          sql: "SELECT SUM(amount) AS total_revenue FROM orders",
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
    expect(result.dqlArtifact?.kind).toBe("certified_block");
    expect(result.dqlArtifact?.name).toBe("total_revenue");
    expect(result.dqlArtifact?.sourcePath).toBe("blocks/total_revenue.dql");
    expect(result.dqlArtifact?.source).toContain('status = "certified"');
    expect(result.dqlArtifact?.source).toContain("SELECT SUM(amount) AS total_revenue FROM orders");
    expect(provider.calls).toHaveLength(0);
  });

  it("downgrades a certified execution when the result misses requested columns", async () => {
    const question = "Show total revenue with customer name";
    kg.rebuild(
      [
        {
          nodeId: "block:total_revenue",
          kind: "block",
          name: "total_revenue",
          domain: "revenue",
          status: "certified",
          description: "Single-value gross revenue KPI across all orders.",
          tags: ["revenue", "kpi", "customer"],
          examples: [{ question }],
          sourceTier: "certified_artifact",
          certification: "certified",
          provenance: "DQL block",
          declaredOutputs: ["revenue"],
        },
      ],
      [],
    );

    const result = await answer({
      question,
      provider: new StubProvider("should not be called"),
      kg,
      contextPack: {
        id: "ctx_total_revenue",
        question,
        focusObjectKey: "dql:block:total_revenue",
        mode: "question",
        trustLabel: "certified",
        objects: [{
          objectKey: "dql:block:total_revenue",
          objectType: "dql_block",
          name: "total_revenue",
          status: "certified",
          sourceSystem: "DQL block",
          snippet: "Single-value gross revenue KPI across all orders.",
        }],
        edges: [],
        queryRuns: [],
        citations: [],
        evidenceSummaries: [],
        warnings: [],
        routeDecision: {
          route: "certified",
          intent: "exact_certified_lookup",
          reason: "exact certified test route",
          trustLabel: "certified",
          reviewStatus: "certified",
          exactObjectKey: "dql:block:total_revenue",
          selectedEvidence: [],
          missingContext: [],
          followUps: [],
        },
        evidenceRoles: [],
        allowedSqlContext: { relations: [], sourceBlockSql: [] },
        missingContext: [],
        conflicts: [],
        retrievalDiagnostics: {
          strategy: "sqlite_fts",
          selectedObjects: 1,
          selectedEvidence: [],
          topRejected: [],
          certifiedCandidateFits: [],
          candidateConflicts: [],
        },
        freshness: {
          catalogPath: ".dql/cache/metadata.sqlite",
          builtAt: null,
          fingerprint: null,
        },
      } as any,
      executeCertifiedBlock: async () => ({
        columns: ["revenue"],
        rows: [{ revenue: 222.5 }],
        rowCount: 1,
      }),
    });

    expect(result.kind).toBe("uncertified");
    expect(result.certification).toBe("analyst_review_required");
    expect(result.reviewStatus).toBe("analyst_review_required");
    expect(result.validationWarnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("customer_name"),
      ]),
    );
    expect(result.text).toContain("Review required");
    expect(result.evidence?.validation?.status).toBe("warning");
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

  it("uses bounded provider tool calls for generated proposals when available", async () => {
    const observed: unknown[] = [];
    const provider = new ToolStubProvider("fallback should not be called");
    const result = await answer({
      question: "What is the order count by region and product category?",
      provider,
      kg,
      answerLoopTools: [inspectMetadataTool(observed)],
    });

    expect(provider.calls).toHaveLength(0);
    expect(provider.toolCalls).toEqual([
      { toolNames: ["inspect_metadata_context"], maxToolCalls: 8 },
    ]);
    expect(provider.messages.at(-1)?.content).toContain("8 call(s) (multi_entity");
    expect(observed).toEqual([{ question: "tool-assisted generation" }]);
    expect(result.kind).toBe("uncertified");
    expect(result.proposedSql).toContain("COUNT(*) AS order_count");
    expect(result.dqlArtifact?.source).toContain('outputs = ["region", "order_count"]');
    expect(result.evidence?.toolCalls).toEqual([
      expect.objectContaining({
        name: "inspect_metadata_context",
        status: "checked",
        inputSummary: expect.stringContaining("tool-assisted generation"),
        outputSummary: expect.stringContaining("ctx_test"),
        order: 1,
      }),
    ]);
    expect(result.evidence?.route).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "inspect_metadata_context",
          status: "checked",
          label: "Provider tool observed: inspect_metadata_context",
        }),
      ]),
    );
  });

  it("carries structured DQL metadata into generated artifacts and draft capture", async () => {
    const provider = new StubProvider([
      "```json",
      JSON.stringify({
        summary: "Top product supply value by product and supply.",
        sql: [
          "SELECT product_name, supply_name, SUM(order_value) AS total_value",
          "FROM analytics.product_supply_orders",
          "WHERE is_perishable = true",
          "GROUP BY product_name, supply_name",
          "ORDER BY total_value DESC",
          "LIMIT 10",
        ].join("\n"),
        viz: "table",
        outputs: ["product_name", "supply_name", "total_value"],
        dql: {
          entity: "product_supply",
          dimensions: ["product_name", "supply_name"],
          filters: ["is_perishable = true", "top 10 by total_value"],
        },
      }),
      "```",
    ].join("\n"));
    let captured: {
      proposedEntity?: string;
      requestedDimensions?: string[];
      requestedFilters?: string[];
      outputs?: string[];
    } | undefined;
    const result = await answer({
      question: "Give me the complete supply chain with product and order details with top 10 value",
      provider,
      kg,
      schemaContext: [{
        relation: "analytics.product_supply_orders",
        name: "product_supply_orders",
        columns: [
          { name: "product_name" },
          { name: "supply_name" },
          { name: "is_perishable" },
          { name: "order_value" },
        ],
      }],
      captureGeneratedDraft: ({ proposedEntity, requestedDimensions, requestedFilters, outputs }) => {
        captured = { proposedEntity, requestedDimensions, requestedFilters, outputs };
        return {
          path: "blocks/_drafts/product_supply_top_10_value.dql",
          askedTimes: 1,
          proposedContractId: "supply_chain.Unknown.product_supply_top_10_value",
        };
      },
    });

    expect(result.kind).toBe("uncertified");
    expect(result.dqlArtifact?.sourcePath).toBe("blocks/_drafts/product_supply_top_10_value.dql");
    expect(result.dqlArtifact?.source).toContain('proposed_entity = "product_supply"');
    expect(result.dqlArtifact?.source).toContain('requested_dimensions = ["product_name", "supply_name"]');
    expect(result.dqlArtifact?.source).toContain('requested_filters = ["is_perishable = true", "top 10 by total_value"]');
    expect(result.dqlArtifact?.source).toContain('outputs = ["product_name", "supply_name", "total_value"]');
    expect(captured).toEqual({
      proposedEntity: "product_supply",
      requestedDimensions: ["product_name", "supply_name"],
      requestedFilters: ["is_perishable = true", "top 10 by total_value"],
      outputs: ["product_name", "supply_name", "total_value"],
    });
  });

  it("uses a smaller lookup budget for simple generated proposals", async () => {
    const provider = new ToolStubProvider("fallback should not be called");
    const result = await answer({
      question: "What is the median order value?",
      provider,
      kg,
      answerLoopTools: [inspectMetadataTool()],
    });

    expect(provider.calls).toHaveLength(0);
    expect(provider.toolCalls).toEqual([
      { toolNames: ["inspect_metadata_context"], maxToolCalls: 3 },
    ]);
    expect(provider.messages.at(-1)?.content).toContain("3 call(s) (lookup");
    expect(result.kind).toBe("uncertified");
  });

  it("expands the provider tool budget for deep analysis requests", async () => {
    const provider = new ToolStubProvider("fallback should not be called");
    const result = await answer({
      question: "What is the order count by region?",
      provider,
      kg,
      analysisDepth: "deep",
      answerLoopTools: [inspectMetadataTool()],
    });

    expect(provider.calls).toHaveLength(0);
    expect(provider.toolCalls).toEqual([
      { toolNames: ["inspect_metadata_context"], maxToolCalls: 15 },
    ]);
    expect(provider.messages.at(-1)?.content).toContain("15 call(s) (deep_research");
    expect(result.kind).toBe("uncertified");
  });

  it("uses deep-mode candidate selection to avoid an invalid first generated SQL proposal", async () => {
    const provider = new StubProvider([
      [
        "```json",
        JSON.stringify({
          summary: "First candidate uses an unavailable customer column.",
          sql: "SELECT customer_name, COUNT(*) AS order_count FROM analytics.orders GROUP BY customer_name",
          viz: "bar",
          outputs: ["customer_name", "order_count"],
        }),
        "```",
      ].join("\n"),
      [
        "```json",
        JSON.stringify({
          summary: "Order count by region from the inspected orders table.",
          sql: "SELECT region, COUNT(*) AS order_count FROM analytics.orders GROUP BY region",
          viz: "bar",
          outputs: ["region", "order_count"],
        }),
        "```",
      ].join("\n"),
      [
        "```json",
        JSON.stringify({
          summary: "Third candidate uses an unavailable relation.",
          sql: "SELECT region, COUNT(*) AS order_count FROM analytics.order_regions GROUP BY region",
          viz: "bar",
          outputs: ["region", "order_count"],
        }),
        "```",
      ].join("\n"),
    ]);
    const executedSql: string[] = [];

    const result = await answer({
      question: "Deep research order count by region",
      provider,
      kg,
      analysisDepth: "deep",
      schemaContext: [{
        relation: "analytics.orders",
        name: "orders",
        columns: [
          { name: "order_id" },
          { name: "region" },
        ],
      }],
      executeGeneratedSql: async (sql) => {
        executedSql.push(sql);
        return {
          columns: ["region", "order_count"],
          rows: [{ region: "West", order_count: 3 }],
          rowCount: 1,
          sql,
        };
      },
    });

    // Initial (invalid) + three diverse alternatives (direct / query-plan /
    // decomposition) = 4 candidates generated.
    expect(provider.calls).toHaveLength(4);
    expect(executedSql).toEqual([
      "SELECT region, COUNT(*) AS order_count FROM analytics.orders GROUP BY region",
    ]);
    expect(result.kind).toBe("uncertified");
    expect(result.proposedSql).toContain("GROUP BY region");
    expect(result.result?.rowCount).toBe(1);
    expect(result.validationWarnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Deep candidate selection reviewed 4 candidates and selected candidate 2"),
      ]),
    );
  });

  it("deep mode diversifies even when the first candidate is clean, and reports agreement", async () => {
    // All candidates return the same valid SQL, so they all execute and AGREE —
    // but the point is that deep mode + an executor generates alternatives at all
    // (a valid-but-wrong first candidate could otherwise never be out-voted).
    const provider = new StubProvider(
      [
        "```json",
        JSON.stringify({
          summary: "Order count by region.",
          sql: "SELECT region, COUNT(*) AS order_count FROM analytics.orders GROUP BY region",
          viz: "bar",
          outputs: ["region", "order_count"],
        }),
        "```",
      ].join("\n"),
    );
    const result = await answer({
      question: "Deep research order count by region",
      provider,
      kg,
      analysisDepth: "deep",
      schemaContext: [{
        relation: "analytics.orders",
        name: "orders",
        columns: [{ name: "order_id" }, { name: "region" }],
      }],
      executeGeneratedSql: async (sql) => ({
        columns: ["region", "order_count"],
        rows: [{ region: "West", order_count: 3 }],
        rowCount: 1,
        sql,
      }),
    });

    // Initial + 3 diverse alternatives — diversified despite a clean first candidate.
    expect(provider.calls.length).toBeGreaterThan(1);
    expect(result.kind).toBe("uncertified");
    expect(result.validationWarnings.join(" ")).toContain("executed candidates agreed on the result");
  });

  it("renders rich prior result refs from the conversation snapshot into generated-answer prompts", async () => {
    const provider = new StubProvider([
      "```json",
      JSON.stringify({
        summary: "Product supply rows with product details from the prior result context.",
        sql: [
          "SELECT product_id, supply_id, supply_name, supply_cost",
          "FROM analytics.product_supplies",
          "ORDER BY supply_cost DESC",
          "LIMIT 10",
        ].join("\n"),
        viz: "table",
        outputs: ["product_id", "supply_id", "supply_name", "supply_cost"],
      }),
      "```",
    ].join("\n"));
    const result = await answer({
      question: "can you include product details with previous results and give final",
      provider,
      kg,
      conversationSnapshot: {
        threadId: "thread_products",
        recentTurns: [
          {
            id: "turn_signups",
            question: "how many signups last quarter",
            answerSummary: "There were 412 signups.",
            resultColumns: ["quarter", "signups"],
            resultRowCount: 1,
          },
        ],
        recalledTurns: [
          {
            id: "turn_products",
            question: "give me product and supply info",
            answerSummary: "Product to supply breakdown.",
            resultColumns: ["product_id", "supply_id", "supply_name", "supply_cost"],
            resultRowCount: 65,
            sourceSql: "SELECT product_id, supply_id, supply_name, supply_cost FROM analytics.product_supplies",
            dqlArtifact: {
              kind: "sql_block",
              name: "product_supply_breakdown",
              source: "block \"product_supply_breakdown\" {\n  type = \"custom\"\n}",
            },
          },
        ],
      },
      schemaContext: [
        {
          relation: "analytics.product_supplies",
          name: "product_supplies",
          columns: [
            { name: "product_id" },
            { name: "supply_id" },
            { name: "supply_name" },
            { name: "supply_cost" },
          ],
        },
      ],
    });

    const prompt = provider.messages.map((message) => message.content).join("\n\n");
    expect(prompt).toContain("Recalled earlier turns");
    expect(prompt).toContain("rows: 65");
    expect(prompt).toContain("sql: SELECT product_id, supply_id, supply_name, supply_cost FROM analytics.product_supplies");
    expect(prompt).toContain("dql: product_supply_breakdown");
    expect(result.kind).toBe("uncertified");
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
    expect(result.dqlArtifact?.kind).toBe("sql_block");
    expect(result.dqlArtifact?.name).toBe("median_order_value_region");
    expect(result.dqlArtifact?.source).toContain('block "median_order_value_region"');
    expect(result.dqlArtifact?.source).toContain('type = "custom"');
    expect(result.dqlArtifact?.source).toContain('status = "draft"');
    expect(result.dqlArtifact?.source).toContain('outputs = ["region", "median_order_value"]');
    expect(result.dqlArtifact?.source).toContain('query = """');
    expect(result.dqlArtifact?.source).toContain("SELECT region, MEDIAN(amount) AS median_order_value FROM fct_orders GROUP BY region");
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

  it("warns when generated preview results miss requested columns or top-N shape", async () => {
    const question = "Who are the top 2 customers with customer name and revenue?";
    const provider = new StubProvider(
      "Top customers by revenue.\n\n" +
        "```sql\nSELECT customer_id, revenue FROM customers ORDER BY revenue DESC\n```\n\n" +
        "Viz: table",
    );

    const result = await answerBase({
      question,
      provider,
      kg,
      executeGeneratedSql: async (sql) => ({
        columns: ["customer_id", "revenue"],
        rows: [
          { customer_id: 1, revenue: 100 },
          { customer_id: 2, revenue: 90 },
          { customer_id: 3, revenue: 80 },
        ],
        rowCount: 3,
        sql,
      }),
    });

    expect(result.kind).toBe("uncertified");
    expect(result.validationWarnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("customer_name"),
        expect.stringContaining("top 2"),
      ]),
    );
  });

  it("trims a global top-N generated result to N rows and notes the trim", async () => {
    const question = "Show the top 3 customers by revenue";
    const provider = new StubProvider(
      "Top customers by revenue.\n\n" +
        "```sql\nSELECT customer_name, revenue FROM customers ORDER BY revenue DESC\n```\n\n" +
        "Viz: table",
    );

    const result = await answerBase({
      question,
      provider,
      kg,
      executeGeneratedSql: async (sql) => ({
        columns: ["customer_name", "revenue"],
        rows: [
          { customer_name: "A", revenue: 100 },
          { customer_name: "B", revenue: 90 },
          { customer_name: "C", revenue: 80 },
          { customer_name: "D", revenue: 70 },
          { customer_name: "E", revenue: 60 },
        ],
        rowCount: 5,
        sql,
      }),
    });

    // Global top-3 ask: the 5-row result is trimmed to 3, with a transparent note.
    expect(result.result?.rowCount).toBe(3);
    expect(result.result?.rows).toHaveLength(3);
    expect(result.validationWarnings).toEqual(
      expect.arrayContaining([expect.stringContaining("Showed the top 3 of 5 rows")]),
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
    const provider = new StubProvider([
      "```json",
      JSON.stringify({
        summary: "Customer order performance ranking generated from the inspected customer mart.",
        sql: [
          "SELECT customer_name, count_lifetime_orders AS orders, ROUND(lifetime_spend, 2) AS lifetime_spend",
          "FROM analytics.customers",
          "ORDER BY lifetime_spend DESC, count_lifetime_orders DESC",
          "LIMIT 10",
        ].join("\n"),
        viz: "table",
        outputs: ["customer_name", "orders", "lifetime_spend"],
      }),
      "```",
    ].join("\n"));
    const result = await answerBase({
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
    expect(provider.calls).toHaveLength(1);
    expect(provider.messages.map((message) => message.content).join("\n\n")).toContain("count_lifetime_orders");
  });

  it("honors an already-demoted category revenue route for a product-grain revenue request", async () => {
    kg.rebuild(
      [
        {
          nodeId: "block:food_vs_drink_revenue",
          kind: "block",
          name: "food_vs_drink_revenue",
          domain: "orders",
          status: "certified",
          description: "Revenue split between food and drink categories from order items.",
          llmContext: "Use only for Food vs Drink category-level revenue, not product-level revenue.",
          tags: ["revenue", "category", "food", "drink"],
          sourceTier: "certified_artifact",
          certification: "certified",
          provenance: "DQL block",
          grain: "category",
          entities: ["Category"],
          declaredOutputs: ["category", "revenue"],
          dimensions: ["category"],
        },
        {
          nodeId: "dbt_model:order_items",
          kind: "dbt_model",
          name: "order_items",
          domain: "orders",
          description: "Order item rows with product name, product type/category, and product price.",
          sourceTier: "dbt_manifest",
          certification: "ai_generated",
          provenance: "dbt manifest",
        },
      ],
      [],
    );
    const provider = new StubProvider([
      "```json",
      JSON.stringify({
        summary: "Product-grain revenue ranking generated from order items after using the certified category block only as context.",
        sql: [
          "SELECT product_name, product_type AS category, SUM(product_price) AS revenue",
          "FROM analytics.order_items",
          "GROUP BY product_name, product_type",
          "ORDER BY revenue DESC",
          "LIMIT 10",
        ].join("\n"),
        viz: "bar",
        outputs: ["product_name", "category", "revenue"],
      }),
      "```",
    ].join("\n"));
    const schemaContext = [
      {
        relation: "analytics.order_items",
        schema: "analytics",
        name: "order_items",
        columns: [
          { name: "product_name", type: "VARCHAR" },
          { name: "product_type", type: "VARCHAR" },
          { name: "product_price", type: "DECIMAL" },
          { name: "order_item_id", type: "BIGINT" },
        ],
      },
    ];
    const question =
      "Can you give me the most revenue numbers products who does the most impacted? Give me the complete results with product name, category and revenue";
    const result = await answerBase({
      question,
      provider,
      kg,
      schemaContext,
      contextPack: contextPackForRankedRelations(question, [
        {
          relation: "analytics.order_items",
          name: "order_items",
          source: "dbt manifest",
          columns: [
            ...schemaContext[0]!.columns,
            { name: "category", description: "Projected by certified source SQL shape." },
            { name: "revenue", description: "Projected by certified source SQL shape." },
          ],
          rank: 1,
          score: 84,
          reason: "selected product revenue relation",
        },
      ], {
        metricTerms: ["revenue"],
        dimensionTerms: ["product", "category"],
        routeIntent: "ad_hoc_ranking",
        certifiedApplicability: {
          objectKey: "block:food_vs_drink_revenue",
          name: "food_vs_drink_revenue",
          kind: "context_only",
          score: 0.42,
          reasons: ["category revenue block is only context for product-grain request"],
        },
        blockFit: {
          kind: "context_only",
          confidence: "high",
          reasons: ["missing requested dimensions: product", "missing requested outputs: product_name"],
          missingOutputs: ["product_name"],
          missingDimensions: ["product"],
          unsupportedFilters: [],
          topNAction: "none",
          inferredContract: false,
        },
        certifiedCandidateFits: [{
          objectKey: "block:food_vs_drink_revenue",
          name: "food_vs_drink_revenue",
          applicabilityKind: "context_only",
          applicabilityScore: 0.42,
          action: "context_only",
          fit: {
            kind: "context_only",
            confidence: "high",
            reasons: ["missing requested dimensions: product", "missing requested outputs: product_name"],
            missingOutputs: ["product_name"],
            missingDimensions: ["product"],
            unsupportedFilters: [],
            topNAction: "none",
            inferredContract: false,
          },
        }],
      }),
      executeGeneratedSql: async (sql) => ({
        columns: ["product_name", "category", "revenue"],
        rows: [{ product_name: "Classic Jaffle", category: "Food", revenue: 120 }],
        rowCount: 1,
        sql,
      }),
    });

    expect(result.kind).toBe("uncertified");
    expect(result.block).toBeUndefined();
    expect(result.reviewStatus).toBe("draft_ready");
    expect(result.sourceCertifiedBlock).not.toBe("food_vs_drink_revenue");
    expect(result.proposedSql).toContain("product_name");
    expect(result.proposedSql).toContain("product_type AS category");
    expect(result.proposedSql).toContain("SUM(product_price) AS revenue");
    expect(result.proposedSql).not.toContain("food_vs_drink_revenue");
    expect(result.result?.columns).toEqual(["product_name", "category", "revenue"]);
    expect(provider.calls).toHaveLength(1);
    expect(provider.messages.map((message) => message.content).join("\n\n")).toContain("food_vs_drink_revenue");
    expect(result.evidence?.route).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "check_certified_fit",
          status: "checked",
          label: expect.stringContaining("food_vs_drink_revenue"),
          detail: expect.stringContaining("product"),
        }),
        expect.objectContaining({
          tool: "check_certified_candidate_fit",
          status: "checked",
          label: expect.stringContaining("food_vs_drink_revenue"),
          detail: expect.stringContaining("missing requested outputs: product_name"),
        }),
      ]),
    );
  });

  it("passes certified source SQL expressions to the provider when only projected source-shape columns are selected", async () => {
    const provider = new StubProvider([
      "```json",
      JSON.stringify({
        summary: "Product revenue by category generated from certified source SQL shape context.",
        sql: [
          "SELECT",
          "  product_name AS product_name,",
          "  CASE WHEN is_food_item THEN 'Food' ELSE 'Drink' END AS category,",
          "  SUM(product_price) AS revenue",
          "FROM dev.order_items",
          "GROUP BY 1, 2",
          "ORDER BY revenue DESC",
          "LIMIT 10",
        ].join("\n"),
        viz: "bar",
        outputs: ["product_name", "category", "revenue"],
      }),
      "```",
    ].join("\n"));
    const question =
      "Can you give me the most revenue numbers products who does the most impacted? Give me the complete results with product name, category and revenue";
    const result = await answerBase({
      question,
      provider,
      kg,
      schemaContext: [],
      contextPack: contextPackForRankedRelations(question, [
        {
          relation: "dev.order_items",
          name: "order_items",
          source: "certified source SQL shape",
          columns: [
            { name: "product_name", description: "Projected by certified source SQL shape." },
            { name: "category", description: "Projected by certified source SQL shape." },
            { name: "revenue", description: "Projected by certified source SQL shape." },
            { name: "units", description: "Projected by certified source SQL shape." },
          ],
          rank: 1,
          score: 84,
          reason: "selected projected source shape for product revenue",
        },
      ], {
        metricTerms: ["revenue"],
        dimensionTerms: ["product", "category"],
        routeIntent: "ad_hoc_ranking",
        sourceBlockSql: [
          {
            objectKey: "dql:block:top_products",
            name: "top_products",
            status: "certified",
            sql: [
              "SELECT",
              "  product_name,",
              "  SUM(product_price) AS revenue,",
              "  COUNT(*) AS units",
              "FROM dev.order_items",
              "GROUP BY 1",
              "ORDER BY revenue DESC",
              "LIMIT 10",
            ].join("\n"),
          },
          {
            objectKey: "dql:block:food_vs_drink_revenue",
            name: "food_vs_drink_revenue",
            status: "certified",
            sql: [
              "SELECT",
              "  CASE WHEN is_food_item THEN 'Food' ELSE 'Drink' END AS category,",
              "  SUM(product_price) AS revenue",
              "FROM dev.order_items",
              "GROUP BY 1",
              "ORDER BY revenue DESC",
            ].join("\n"),
          },
        ],
      }),
      executeGeneratedSql: async (sql) => ({
        columns: ["product_name", "category", "revenue"],
        rows: [{ product_name: "Classic Jaffle", category: "Food", revenue: 120 }],
        rowCount: 1,
        sql,
      }),
    });

    expect(provider.calls).toHaveLength(1);
    const prompt = provider.messages.map((message) => message.content).join("\n\n");
    expect(prompt).toContain("top_products");
    expect(prompt).toContain("food_vs_drink_revenue");
    expect(prompt).toContain("CASE WHEN is_food_item THEN 'Food' ELSE 'Drink' END AS category");
    expect(result.kind).toBe("uncertified");
    expect(result.reviewStatus).toBe("draft_ready");
    expect(result.proposedSql).toContain("product_name AS product_name");
    expect(result.proposedSql).toContain("CASE WHEN is_food_item THEN 'Food' ELSE 'Drink' END AS category");
    expect(result.proposedSql).toContain("SUM(product_price) AS revenue");
    expect(result.proposedSql).toContain("FROM dev.order_items");
    expect(result.proposedSql).toContain("GROUP BY 1, 2");
    expect(result.proposedSql).toContain("ORDER BY revenue DESC");
    expect(result.proposedSql).not.toContain("FROM food_vs_drink_revenue");
    expect(result.validationWarnings ?? []).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("missing requested output column"),
      ]),
    );
    expect(result.result?.columns).toEqual(["product_name", "category", "revenue"]);
  });

  it("generates a customer drilldown for a singular prior product reference", async () => {
    const provider = new StubProvider([
      "```json",
      JSON.stringify({
        summary: "Customer drilldown generated from the selected order-item relation for the prior product.",
        sql: [
          "SELECT",
          "  f.customer_name AS customer_name,",
          "  f.product_name AS product_name,",
          "  SUM(f.product_price) AS revenue",
          "FROM dev.order_items AS f",
          "WHERE f.product_name = 'for richer or pourover'",
          "GROUP BY f.customer_name, f.product_name",
          "ORDER BY revenue DESC",
          "LIMIT 10",
        ].join("\n"),
        viz: "table",
        outputs: ["customer_name", "product_name", "revenue"],
      }),
      "```",
    ].join("\n"));
    const question = "who are the customers for this product?";
    const schemaContext = [
      {
        relation: "dev.order_items",
        schema: "dev",
        name: "order_items",
        columns: [
          { name: "customer_name", type: "VARCHAR" },
          { name: "product_name", type: "VARCHAR", sampleValues: ["for richer or pourover", "vanilla ice"] },
          { name: "product_price", type: "DECIMAL" },
          { name: "order_item_id", type: "BIGINT" },
        ],
      },
    ];
    const result = await answerBase({
      question,
      provider,
      kg,
      schemaContext,
      contextPack: contextPackForRankedRelations(question, [{
        relation: "dev.order_items",
        name: "order_items",
        source: "dbt manifest",
        columns: schemaContext[0]!.columns,
        rank: 1,
        score: 92,
        reason: "selected order item relation for product customer drilldown",
      }], {
        metricTerms: ["revenue"],
        dimensionTerms: ["customer", "product"],
        routeIntent: "entity_drilldown",
      }),
      followUp: {
        kind: "drilldown",
        filters: ["for richer or pourover"],
        dimensions: ["product"],
        priorResultColumns: ["product_name", "category", "revenue", "units"],
        priorResultValues: {
          product_name: ["for richer or pourover", "vanilla ice"],
          category: ["Drink"],
        },
        priorMeasures: ["revenue"],
      },
      executeGeneratedSql: async (sql) => ({
        columns: ["customer_name", "product_name", "revenue"],
        rows: [{ customer_name: "Mr. Matthew Meyer", product_name: "for richer or pourover", revenue: 70 }],
        rowCount: 1,
        sql,
      }),
    });

    expect(provider.calls).toHaveLength(1);
    const prompt = provider.messages.map((message) => message.content).join("\n\n");
    expect(prompt).toContain("dev.order_items");
    expect(prompt).toContain("for richer or pourover");
    expect(result.kind).toBe("uncertified");
    expect(result.proposedSql).toContain("f.customer_name AS customer_name");
    expect(result.proposedSql).toContain("f.product_name AS product_name");
    expect(result.proposedSql).toContain("SUM(f.product_price) AS revenue");
    expect(result.proposedSql).toContain("WHERE f.product_name = 'for richer or pourover'");
    expect(result.proposedSql).toContain("GROUP BY f.customer_name, f.product_name");
    expect(result.proposedSql).not.toContain("top_products");
    expect(result.validationWarnings ?? []).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("missing requested output column"),
      ]),
    );
    expect(result.result?.columns).toEqual(["customer_name", "product_name", "revenue"]);
  });

  it("generates a product-customer revenue view for combined product and buyer requests", async () => {
    const provider = new StubProvider([
      "```json",
      JSON.stringify({
        summary: "Product/customer revenue view generated from the selected order-item relation.",
        sql: [
          "SELECT",
          "  f.product_name AS product_name,",
          "  CASE WHEN f.is_food_item THEN 'Food' ELSE 'Drink' END AS category,",
          "  f.customer_name AS customer_name,",
          "  SUM(f.product_price) AS revenue,",
          "  COUNT(*) AS units",
          "FROM dev.order_items AS f",
          "GROUP BY f.product_name, CASE WHEN f.is_food_item THEN 'Food' ELSE 'Drink' END, f.customer_name",
          "ORDER BY revenue DESC",
          "LIMIT 10",
        ].join("\n"),
        viz: "table",
        outputs: ["product_name", "category", "customer_name", "revenue", "units"],
      }),
      "```",
    ].join("\n"));
    const question = "Can you give me the most revenue numbers products who does the most impacted? Give me the complete results with product name, category and revenue and also give the complete view of customers who bought these product";
    const schemaContext = [
      {
        relation: "dev.order_items",
        schema: "dev",
        name: "order_items",
        columns: [
          { name: "customer_name", type: "VARCHAR" },
          { name: "product_name", type: "VARCHAR" },
          { name: "is_food_item", type: "BOOLEAN" },
          { name: "product_price", type: "DECIMAL" },
          { name: "order_item_id", type: "BIGINT" },
        ],
      },
    ];
    const result = await answerBase({
      question,
      provider,
      kg,
      schemaContext,
      contextPack: contextPackForRankedRelations(question, [{
        relation: "dev.order_items",
        name: "order_items",
        source: "dbt manifest",
        columns: schemaContext[0]!.columns,
        rank: 1,
        score: 93,
        reason: "selected order item relation for product/customer revenue view",
      }], {
        metricTerms: ["revenue"],
        dimensionTerms: ["product", "category", "customer"],
        routeIntent: "ad_hoc_ranking",
      }),
      executeGeneratedSql: async (sql) => ({
        columns: ["product_name", "category", "customer_name", "revenue", "units"],
        rows: [{
          product_name: "for richer or pourover",
          category: "Drink",
          customer_name: "Mr. Matthew Meyer",
          revenue: 70,
          units: 10,
        }],
        rowCount: 1,
        sql,
      }),
    });

    expect(provider.calls).toHaveLength(1);
    const prompt = provider.messages.map((message) => message.content).join("\n\n");
    expect(prompt).toContain("dev.order_items");
    expect(prompt).toContain("customer_name");
    expect(prompt).toContain("selected order item relation for product/customer revenue view");
    expect(result.kind).toBe("uncertified");
    expect(result.proposedSql).toContain("f.product_name AS product_name");
    expect(result.proposedSql).toContain("CASE WHEN f.is_food_item THEN 'Food' ELSE 'Drink' END AS category");
    expect(result.proposedSql).toContain("f.customer_name AS customer_name");
    expect(result.proposedSql).toContain("SUM(f.product_price) AS revenue");
    expect(result.proposedSql).toContain("COUNT(*) AS units");
    expect(result.proposedSql).toContain("GROUP BY f.product_name, CASE WHEN f.is_food_item THEN 'Food' ELSE 'Drink' END, f.customer_name");
    expect(result.proposedSql).not.toContain("top_customers");
    expect(result.proposedSql).not.toContain("lifetime_spend");
    expect(result.validationWarnings ?? []).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("missing requested output column"),
      ]),
    );
    expect(result.result?.columns).toEqual(["product_name", "category", "customer_name", "revenue", "units"]);
  });

  it("surfaces a partial (customer-only) table with a warning instead of refusing a combined product/buyer request", async () => {
    const question = "Can you give me the most revenue numbers products who does the most impacted? Give me the complete results with product name, category and revenue and also give the complete view of customers who bought these product";
    const provider = new StubProvider([
      "Customer-only result.\n\n",
      "```sql\n",
      "SELECT customer_name, count_lifetime_orders AS orders, lifetime_spend\n",
      "FROM dev.customers\n",
      "ORDER BY lifetime_spend DESC\n",
      "LIMIT 10\n",
      "```\n\n",
      "Viz: table",
    ].join(""));
    const schemaContext = [
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
    ];
    const result = await answerBase({
      question,
      provider,
      kg,
      schemaContext,
      contextPack: contextPackForRankedRelations(question, [{
        relation: "dev.customers",
        name: "customers",
        source: "dbt manifest",
        columns: schemaContext[0]!.columns,
        rank: 1,
        score: 90,
        reason: "selected customer relation",
      }], {
        metricTerms: ["revenue"],
        dimensionTerms: ["product", "category", "customer"],
        routeIntent: "ad_hoc_ranking",
      }),
      executeGeneratedSql: async (sql) => ({
        columns: ["customer_name", "orders", "lifetime_spend"],
        rows: [{ customer_name: "Mr. Matthew Meyer", orders: 33, lifetime_spend: 3089.8 }],
        rowCount: 1,
        sql,
      }),
    });

    expect(provider.calls).toHaveLength(1);
    // The result executed — surface it (review-required) with a partial-shape
    // warning instead of refusing outright.
    expect(result.kind).toBe("uncertified");
    expect(result.text).toContain("Partial answer");
    expect(result.validationWarnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("the result is missing"),
      ]),
    );
    // The executed rows and a DQL artifact are returned, not thrown away.
    expect(result.result?.columns).toEqual(["customer_name", "orders", "lifetime_spend"]);
    expect(result.dqlArtifact?.source).toBeTruthy();
  });

  it("generates product categories for a prior customer set even when category is derived", async () => {
    const provider = new StubProvider([
      "```json",
      JSON.stringify({
        summary: "Product category rows for the prior customers generated from the selected order-item relation.",
        sql: [
          "SELECT",
          "  f.customer_name AS customer_name,",
          "  f.product_name AS product_name,",
          "  CASE WHEN f.is_food_item THEN 'Food' ELSE 'Drink' END AS category,",
          "  SUM(f.product_price) AS revenue,",
          "  COUNT(*) AS units",
          "FROM dev.order_items AS f",
          "WHERE f.customer_name IN ('Mr. Matthew Meyer', 'Aaron Gardner')",
          "GROUP BY f.customer_name, f.product_name, CASE WHEN f.is_food_item THEN 'Food' ELSE 'Drink' END",
          "ORDER BY customer_name ASC, revenue DESC",
          "LIMIT 10",
        ].join("\n"),
        viz: "table",
        outputs: ["customer_name", "product_name", "category", "revenue", "units"],
      }),
      "```",
    ].join("\n"));
    const question = "what are the product catagories for these customers";
    const schemaContext = [
      {
        relation: "dev.order_items",
        schema: "dev",
        name: "order_items",
        columns: [
          { name: "customer_name", type: "VARCHAR" },
          { name: "product_name", type: "VARCHAR" },
          { name: "is_food_item", type: "BOOLEAN" },
          { name: "product_price", type: "DECIMAL" },
          { name: "order_item_id", type: "BIGINT" },
        ],
      },
    ];
    const result = await answerBase({
      question,
      provider,
      kg,
      schemaContext,
      contextPack: contextPackForRankedRelations(question, [{
        relation: "dev.order_items",
        name: "order_items",
        source: "dbt manifest",
        columns: schemaContext[0]!.columns,
        rank: 1,
        score: 91,
        reason: "selected order item relation for customer category view",
      }], {
        metricTerms: ["revenue"],
        dimensionTerms: ["customer", "category"],
        routeIntent: "entity_drilldown",
      }),
      followUp: {
        kind: "drilldown",
        filters: ["Mr. Matthew Meyer", "Aaron Gardner"],
        dimensions: ["customer"],
        priorResultColumns: ["product_name", "category", "customer_name", "revenue", "units"],
        priorResultValues: {
          customer_name: ["Mr. Matthew Meyer", "Aaron Gardner"],
          product_name: ["for richer or pourover", "vanilla ice"],
          category: ["Drink"],
        },
        priorMeasures: ["revenue"],
      },
      executeGeneratedSql: async (sql) => ({
        columns: ["customer_name", "product_name", "category", "revenue", "units"],
        rows: [{ customer_name: "Mr. Matthew Meyer", product_name: "for richer or pourover", category: "Drink", revenue: 70, units: 10 }],
        rowCount: 1,
        sql,
      }),
    });

    expect(provider.calls).toHaveLength(1);
    const prompt = provider.messages.map((message) => message.content).join("\n\n");
    expect(prompt).toContain("dev.order_items");
    expect(prompt).toContain("Mr. Matthew Meyer");
    expect(result.kind).toBe("uncertified");
    expect(result.proposedSql).toContain("f.customer_name AS customer_name");
    expect(result.proposedSql).toContain("f.product_name AS product_name");
    expect(result.proposedSql).toContain("CASE WHEN f.is_food_item THEN 'Food' ELSE 'Drink' END AS category");
    expect(result.proposedSql).toContain("SUM(f.product_price) AS revenue");
    expect(result.proposedSql).toContain("WHERE f.customer_name IN ('Mr. Matthew Meyer', 'Aaron Gardner')");
    expect(result.proposedSql).toContain("GROUP BY f.customer_name, f.product_name, CASE WHEN f.is_food_item THEN 'Food' ELSE 'Drink' END");
    expect(result.proposedSql).not.toContain(" category ");
    expect(result.validationWarnings ?? []).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("outside the inspected columns"),
      ]),
    );
    expect(result.result?.columns).toEqual(["customer_name", "product_name", "category", "revenue", "units"]);
  });

  it("generates product and category rows for above-order follow-ups using prior customers", async () => {
    const provider = new StubProvider([
      "```json",
      JSON.stringify({
        summary: "Product and category rows for the prior customers generated from order items joined to customers.",
        sql: [
          "SELECT",
          "  c.customer_name AS customer_name,",
          "  f.product_name AS product_name,",
          "  f.product_type AS category,",
          "  SUM(f.product_price) AS revenue,",
          "  COUNT(*) AS units",
          "FROM order_items AS f",
          "JOIN fct_orders AS b ON f.order_id = b.order_id",
          "JOIN dim_customers AS c ON b.customer_id = c.customer_id",
          "WHERE c.customer_name IN ('Mr. Matthew Meyer', 'Aaron Gardner')",
          "GROUP BY c.customer_name, f.product_name, f.product_type",
          "ORDER BY customer_name ASC, revenue DESC",
          "LIMIT 10",
        ].join("\n"),
        viz: "table",
        outputs: ["customer_name", "product_name", "category", "revenue", "units"],
      }),
      "```",
    ].join("\n"));
    const question = "what the are the products and sub catogories for the above orders";
    const schemaContext = [
      {
        relation: "order_items",
        schema: "main",
        name: "order_items",
        columns: [
          { name: "order_item_id", type: "BIGINT" },
          { name: "order_id", type: "BIGINT" },
          { name: "product_name", type: "VARCHAR" },
          { name: "product_type", type: "VARCHAR" },
          { name: "product_price", type: "DECIMAL" },
        ],
      },
      {
        relation: "fct_orders",
        schema: "main",
        name: "fct_orders",
        columns: [
          { name: "order_id", type: "BIGINT" },
          { name: "customer_id", type: "BIGINT" },
        ],
      },
      {
        relation: "dim_customers",
        schema: "main",
        name: "dim_customers",
        columns: [
          { name: "customer_id", type: "BIGINT" },
          { name: "customer_name", type: "VARCHAR" },
        ],
      },
    ];
    const result = await answerBase({
      question,
      provider,
      kg,
      schemaContext,
      contextPack: contextPackForRankedRelations(question, schemaContext.map((table, index) => ({
        relation: table.relation,
        name: table.name,
        source: "dbt manifest",
        columns: table.columns,
        rank: index + 1,
        score: 90 - index,
        reason: "selected prior customer order relation",
      })), {
        metricTerms: ["revenue"],
        dimensionTerms: ["customer", "product", "category"],
        routeIntent: "entity_drilldown",
      }),
      followUp: {
        kind: "drilldown",
        filters: ["Mr. Matthew Meyer", "Aaron Gardner"],
        dimensions: ["customer"],
        priorResultColumns: ["customer_name", "orders", "lifetime_spend"],
        priorResultValues: {
          customer_name: ["Mr. Matthew Meyer", "Aaron Gardner"],
        },
        priorMeasures: ["lifetime_spend"],
      },
      executeGeneratedSql: async (sql) => ({
        columns: ["customer_name", "product_name", "category", "revenue", "units"],
        rows: [{
          customer_name: "Mr. Matthew Meyer",
          product_name: "for richer or pourover",
          category: "Drink",
          revenue: 70,
          units: 10,
        }],
        rowCount: 1,
        sql,
      }),
    });

    expect(provider.calls).toHaveLength(1);
    const prompt = provider.messages.map((message) => message.content).join("\n\n");
    expect(prompt).toContain("order_items");
    expect(prompt).toContain("selected prior customer order relation");
    expect(result.kind).toBe("uncertified");
    expect(result.proposedSql).toContain("f.product_name AS product_name");
    expect(result.proposedSql).toContain("f.product_type AS category");
    expect(result.proposedSql).toContain("SUM(f.product_price) AS revenue");
    expect(result.proposedSql).toContain("JOIN fct_orders AS b ON f.order_id = b.order_id");
    expect(result.proposedSql).toContain("JOIN dim_customers AS c ON b.customer_id = c.customer_id");
    expect(result.proposedSql).toContain("WHERE c.customer_name IN ('Mr. Matthew Meyer', 'Aaron Gardner')");
    expect(result.proposedSql).toContain("GROUP BY c.customer_name, f.product_name, f.product_type");
    expect(result.result?.columns).toEqual(["customer_name", "product_name", "category", "revenue", "units"]);
  });

  it("does not certify global top customers for a category-scoped follow-up", async () => {
    kg.rebuild(
      [
        {
          nodeId: "block:food_vs_drink_revenue",
          kind: "block",
          name: "food_vs_drink_revenue",
          domain: "orders",
          status: "certified",
          description: "Revenue split between food and drink categories from order items.",
          tags: ["revenue", "category", "food", "drink"],
          sourceTier: "certified_artifact",
          certification: "certified",
          provenance: "DQL block",
          grain: "category",
          declaredOutputs: ["category", "revenue"],
          dimensions: ["category"],
        },
        {
          nodeId: "block:top_customers",
          kind: "block",
          name: "top_customers",
          domain: "customers",
          status: "certified",
          description: "Top 10 customers by lifetime spend, with order counts.",
          llmContext: "Use for overall best customers by lifetime spend only.",
          tags: ["customers", "ranking", "orders"],
          sourceTier: "certified_artifact",
          certification: "certified",
          provenance: "DQL block",
          grain: "customer",
          declaredOutputs: ["customer_name", "lifetime_spend", "order_count"],
          dimensions: ["customer"],
          sql: "SELECT customer_name, lifetime_spend, order_count FROM customers ORDER BY lifetime_spend DESC LIMIT 10",
        },
      ],
      [],
    );
    const provider = new StubProvider([
      "```json",
      JSON.stringify({
        summary: "Top customers for the prior categories generated from the selected product/customer relation.",
        sql: [
          "SELECT",
          "  f.customer_name AS customer_name,",
          "  f.product_type AS category,",
          "  SUM(f.product_price) AS revenue",
          "FROM analytics.order_items AS f",
          "WHERE f.product_type IN ('Food', 'Drink')",
          "GROUP BY f.customer_name, f.product_type",
          "ORDER BY revenue DESC",
          "LIMIT 5",
        ].join("\n"),
        viz: "table",
        outputs: ["customer_name", "category", "revenue"],
      }),
      "```",
    ].join("\n"));
    const question = "who are the top 5 customers for these categories?";
    const schemaContext = [
      {
        relation: "analytics.order_items",
        schema: "analytics",
        name: "order_items",
        columns: [
          { name: "customer_name", type: "VARCHAR" },
          { name: "product_type", type: "VARCHAR" },
          { name: "product_price", type: "DECIMAL" },
        ],
      },
    ];
    const result = await answerBase({
      question,
      provider,
      kg,
      schemaContext,
      contextPack: contextPackForRankedRelations(question, [
        {
          relation: "analytics.order_items",
          name: "order_items",
          source: "dbt manifest",
          columns: schemaContext[0]!.columns,
          rank: 1,
          score: 81,
          reason: "selected product/customer revenue relation",
        },
      ], {
        metricTerms: ["revenue"],
        dimensionTerms: ["customer", "category"],
        routeIntent: "entity_drilldown",
        certifiedApplicability: {
          objectKey: "block:top_customers",
          name: "top_customers",
          kind: "context_only",
          score: 0.38,
          reasons: ["overall top customers block lacks category scope"],
        },
        blockFit: {
          kind: "context_only",
          confidence: "high",
          reasons: ["missing requested dimensions: category", "unsupported requested filters: category"],
          missingOutputs: [],
          missingDimensions: ["category"],
          unsupportedFilters: ["category"],
          topNAction: "none",
          inferredContract: false,
        },
      }),
      followUp: {
        kind: "drilldown",
        sourceBlockName: "food_vs_drink_revenue",
        filters: ["Food", "Drink"],
        dimensions: ["category"],
        priorResultColumns: ["category", "revenue"],
        priorResultValues: { category: ["Food", "Drink"] },
      },
      executeGeneratedSql: async (sql) => ({
        columns: ["customer_name", "category", "revenue"],
        rows: [{ customer_name: "Mr. Matthew Meyer", category: "Food", revenue: 3089.8 }],
        rowCount: 1,
        sql,
      }),
    });

    expect(provider.calls).toHaveLength(1);
    const prompt = provider.messages.map((message) => message.content).join("\n\n");
    expect(prompt).toContain("analytics.order_items");
    expect(prompt).toContain("Food");
    expect(result.kind).toBe("uncertified");
    expect(result.block).toBeUndefined();
    expect(result.reviewStatus).toBe("draft_ready");
    expect(result.sourceCertifiedBlock).toBe("food_vs_drink_revenue");
    expect(result.proposedSql).toContain("product_type IN ('Food', 'Drink')");
    expect(result.proposedSql).toContain("SUM(f.product_price) AS revenue");
    expect(result.proposedSql).toContain("LIMIT 5");
    expect(result.proposedSql).not.toContain("order_item_id_sum");
    expect(result.proposedSql).not.toContain("top_customers");
    expect(result.result?.columns).toEqual(["customer_name", "category", "revenue"]);
    expect(result.evidence?.route).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "check_certified_fit",
          status: "checked",
          label: expect.stringContaining("top_customers"),
          detail: expect.stringContaining("category"),
        }),
      ]),
    );
  });

  it("joins through orders for category-scoped customer follow-ups when customers are not on order items", async () => {
    kg.rebuild(
      [
        {
          nodeId: "block:food_vs_drink_revenue",
          kind: "block",
          name: "food_vs_drink_revenue",
          domain: "orders",
          status: "certified",
          description: "Revenue split between food and drink categories from order items.",
          tags: ["revenue", "category", "food", "drink"],
          sourceTier: "certified_artifact",
          certification: "certified",
          provenance: "DQL block",
          grain: "category",
          declaredOutputs: ["category", "revenue"],
          dimensions: ["category"],
        },
        {
          nodeId: "block:top_customers",
          kind: "block",
          name: "top_customers",
          domain: "customers",
          status: "certified",
          description: "Top 10 customers by lifetime spend, with order counts.",
          llmContext: "Use for overall best customers by lifetime spend only.",
          tags: ["customers", "ranking", "orders"],
          sourceTier: "certified_artifact",
          certification: "certified",
          provenance: "DQL block",
          grain: "customer",
          declaredOutputs: ["customer_name", "lifetime_spend", "order_count"],
          dimensions: ["customer"],
          sql: "SELECT customer_name, lifetime_spend, order_count FROM customers ORDER BY lifetime_spend DESC LIMIT 10",
        },
      ],
      [],
    );
    const question = "who are the top 5 customers for these categories?";
    const schemaContext = [
      {
        relation: "order_items",
        schema: "main",
        name: "order_items",
        columns: [
          { name: "order_item_id", type: "BIGINT" },
          { name: "order_id", type: "BIGINT" },
          { name: "product_id", type: "VARCHAR" },
          { name: "product_type", type: "VARCHAR" },
          { name: "product_price", type: "DECIMAL" },
        ],
      },
      {
        relation: "fct_orders",
        schema: "main",
        name: "fct_orders",
        columns: [
          { name: "order_id", type: "BIGINT" },
          { name: "customer_id", type: "BIGINT" },
        ],
      },
      {
        relation: "dim_customers",
        schema: "main",
        name: "dim_customers",
        columns: [
          { name: "customer_id", type: "BIGINT" },
          { name: "customer_name", type: "VARCHAR" },
        ],
      },
    ];
    const provider = new StubProvider([
      "```json",
      JSON.stringify({
        summary: "Customer category follow-up generated from order items joined to orders and customers.",
        sql: [
          "SELECT",
          "  c.customer_name AS customer_name,",
          "  f.product_type AS category,",
          "  SUM(f.product_price) AS revenue",
          "FROM order_items AS f",
          "JOIN fct_orders AS b ON f.order_id = b.order_id",
          "JOIN dim_customers AS c ON b.customer_id = c.customer_id",
          "WHERE f.product_type IN ('jaffle', 'beverage')",
          "GROUP BY c.customer_name, f.product_type",
          "ORDER BY revenue DESC",
          "LIMIT 5",
        ].join("\n"),
        viz: "table",
        outputs: ["customer_name", "category", "revenue"],
      }),
      "```",
    ].join("\n"));
    const result = await answerBase({
      question,
      provider,
      kg,
      schemaContext,
      contextPack: contextPackForRankedRelations(question, schemaContext.map((table, index) => ({
        relation: table.relation,
        name: table.name,
        source: "dbt manifest",
        columns: table.columns,
        rank: index + 1,
        score: 90 - index,
        reason: "selected follow-up join relation",
      })), {
        metricTerms: ["revenue"],
        dimensionTerms: ["customer", "category"],
        routeIntent: "entity_drilldown",
        sourceBlockSql: [{
          objectKey: "dql:block:food_vs_drink_revenue",
          name: "food_vs_drink_revenue",
          status: "certified",
          sql: "SELECT CASE WHEN product_type = 'jaffle' THEN 'Food' WHEN product_type = 'beverage' THEN 'Drink' ELSE product_type END AS category, SUM(product_price) AS revenue FROM order_items GROUP BY 1",
        }],
      }),
      followUp: {
        kind: "drilldown",
        sourceBlockName: "food_vs_drink_revenue",
        filters: ["Food", "Drink"],
        dimensions: ["category"],
        priorResultColumns: ["category", "revenue"],
        priorResultValues: { category: ["Food", "Drink"] },
      },
      executeGeneratedSql: async (sql) => ({
        columns: ["customer_name", "category", "revenue"],
        rows: [{ customer_name: "Alice Johnson", category: "jaffle", revenue: 24 }],
        rowCount: 1,
        sql,
      }),
    });

    expect(provider.calls).toHaveLength(1);
    const prompt = provider.messages.map((message) => message.content).join("\n\n");
    expect(prompt).toContain("order_items");
    expect(prompt).toContain("food_vs_drink_revenue");
    expect(result.kind).toBe("uncertified");
    expect(result.sourceCertifiedBlock).toBe("food_vs_drink_revenue");
    expect(result.proposedSql).toContain("c.customer_name AS customer_name");
    expect(result.proposedSql).toContain("f.product_type AS category");
    expect(result.proposedSql).toContain("SUM(f.product_price) AS revenue");
    expect(result.proposedSql).toContain("FROM order_items AS f");
    expect(result.proposedSql).toContain("JOIN fct_orders AS b ON f.order_id = b.order_id");
    expect(result.proposedSql).toContain("JOIN dim_customers AS c ON b.customer_id = c.customer_id");
    expect(result.proposedSql).toContain("f.product_type IN ('jaffle', 'beverage')");
    expect(result.proposedSql).toContain("LIMIT 5");
    expect(result.proposedSql).not.toContain("top_customers");
    expect(result.proposedSql).not.toContain("product_id AS product_id");
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
    const result = await answerBase({
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
    expect(provider.calls).toHaveLength(1);
    expect(provider.messages.map((message) => message.content).join("\n\n")).toContain("analytics.player_scoring");
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
    const provider = new StubProvider([
      "```json",
      JSON.stringify({
        summary: "Least scoring players generated by adapting the certified top-scorers SQL shape.",
        sql: "SELECT player_name, season, total_points FROM NBA_GAMES.RAW.fct_player_performance ORDER BY total_points ASC LIMIT 10",
        viz: "table",
        outputs: ["player_name", "season", "total_points"],
      }),
      "```",
    ].join("\n"));
    const result = await answerBase({
      question: "Who scored the least points?",
      provider,
      kg,
      contextPack: {
        id: "ctx_test",
        question: "Who scored the least points?",
        focusObjectKey: "dql:block:Top 10 Goal Scorers",
        mode: "question",
        trustLabel: "mixed",
        trustLabelInfo: {
          id: "ai_generated",
          base: "AI-Generated",
          qualifier: "mixed context",
          display: "AI-Generated · mixed context",
          severity: "caution",
          color: "amber",
        },
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
          certifiedCandidateFits: [],
          candidateConflicts: [],
        },
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
              sql: "SELECT player_name, season, total_points FROM NBA_GAMES.RAW.fct_player_performance ORDER BY total_points DESC LIMIT 10",
            },
          ],
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
    expect(provider.calls).toHaveLength(1);
    const prompt = provider.messages.map((message) => message.content).join("\n\n");
    expect(prompt).toContain("trust_label_canonical: AI-Generated · mixed context");
    expect(prompt).toContain("Worked examples from certified blocks");
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
    const provider = new StubProvider([
      "```json",
      JSON.stringify({
        summary: "Better-performing customers generated from the inspected customer mart.",
        sql: [
          "SELECT customer_name, count_lifetime_orders AS orders, ROUND(lifetime_spend, 2) AS lifetime_spend",
          "FROM dev.customers",
          "ORDER BY lifetime_spend DESC, count_lifetime_orders DESC",
          "LIMIT 10",
        ].join("\n"),
        viz: "table",
        outputs: ["customer_name", "orders", "lifetime_spend"],
      }),
      "```",
    ].join("\n"));
    const result = await answerBase({
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
    expect(result.evidence?.selectedAssets.some((asset) => asset.name === "top_customers")).toBe(true);
    expect(provider.calls).toHaveLength(1);
    expect(provider.messages.map((message) => message.content).join("\n\n")).toContain("dev.customers");
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
    const provider = new StubProvider([
      "```json",
      JSON.stringify({
        summary: "Least-order customers generated from the inspected customer mart.",
        sql: [
          "SELECT customer_name, count_lifetime_orders AS orders, ROUND(lifetime_spend, 2) AS lifetime_spend",
          "FROM dev.customers",
          "ORDER BY count_lifetime_orders ASC, lifetime_spend ASC",
          "LIMIT 10",
        ].join("\n"),
        viz: "table",
        outputs: ["customer_name", "orders", "lifetime_spend"],
      }),
      "```",
    ].join("\n"));
    const result = await answerBase({
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
    expect(provider.calls).toHaveLength(1);
    expect(provider.messages.map((message) => message.content).join("\n\n")).toContain("count_lifetime_orders");
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
    const provider = new StubProvider([
      "```json",
      JSON.stringify({
        summary: "Product revenue ranking generated from the inspected dbt relation.",
        sql: [
          "SELECT product_name, SUM(revenue) AS revenue_sum",
          "FROM analytics.product_revenue",
          "GROUP BY product_name",
          "ORDER BY revenue_sum DESC",
          "LIMIT 10",
        ].join("\n"),
        viz: "bar",
        outputs: ["product_name", "revenue_sum"],
      }),
      "```",
    ].join("\n"));
    const result = await answerBase({
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
    expect(result.dqlArtifact?.kind).toBe("sql_block");
    expect(result.proposedSql).toContain("FROM analytics.product_revenue");
    expect(result.proposedSql).toContain("product_name");
    expect(result.proposedSql).toContain("SUM(revenue)");
    expect(result.proposedSql).toContain("ORDER BY revenue_sum DESC");
    expect(result.result?.rowCount).toBe(1);
    expect(provider.calls).toHaveLength(1);
    const prompt = provider.messages.map((message) => message.content).join("\n\n");
    expect(prompt).toContain("analytics.product_revenue");
    expect(prompt).toContain("product_name");
    expect(prompt).toContain("revenue");
  });

  it("skips legacy schema proposal builders by default", async () => {
    kg.rebuild([], []);
    const provider = new StubProvider([
      "Provider-authored product revenue query.\n\n",
      "```sql",
      "SELECT product_name, SUM(revenue) AS provider_revenue",
      "FROM analytics.product_revenue",
      "GROUP BY product_name",
      "ORDER BY provider_revenue DESC",
      "LIMIT 10",
      "```",
      "",
      "Viz: bar",
    ].join("\n"));
    const result = await answerBase({
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
    });

    expect(result.kind).toBe("uncertified");
    expect(provider.calls).toHaveLength(1);
    expect(result.proposedSql).toContain("provider_revenue");
    expect(result.proposedSql).not.toContain("revenue_sum");
  });

  it("uses governed lineage aliases when physical metric columns do not match the business term", async () => {
    kg.rebuild([], []);
    const provider = new StubProvider([
      "```json",
      JSON.stringify({
        summary: "Product revenue ranking generated from the governed lineage alias on product_price.",
        sql: [
          "SELECT product_name, SUM(product_price) AS revenue_sum",
          "FROM analytics.order_items",
          "GROUP BY product_name",
          "ORDER BY revenue_sum DESC",
          "LIMIT 10",
        ].join("\n"),
        viz: "bar",
        outputs: ["product_name", "revenue_sum"],
      }),
      "```",
    ].join("\n"));
    const result = await answerBase({
      question: "Which products have the highest revenue?",
      provider,
      kg,
      schemaContext: [
        {
          relation: "analytics.order_items",
          schema: "analytics",
          name: "order_items",
          source: "dbt manifest",
          columns: [
            { name: "product_name", type: "VARCHAR" },
            {
              name: "product_price",
              type: "DECIMAL",
              description: "Item sale price. Governed aliases from lineage: revenue.",
            },
          ],
        },
      ],
      executeGeneratedSql: async (sql) => ({
        columns: ["product_name", "revenue_sum"],
        rows: [{ product_name: "Jaffle", revenue_sum: 200000 }],
        rowCount: 1,
        sql,
      }),
    });

    expect(result.kind).toBe("uncertified");
    expect(result.proposedSql).toContain("FROM analytics.order_items");
    expect(result.proposedSql).toContain("product_name");
    expect(result.proposedSql).toContain("SUM(product_price)");
    expect(result.proposedSql).not.toContain("SUM(revenue)");
    expect(provider.calls).toHaveLength(1);
    expect(provider.messages.map((message) => message.content).join("\n\n")).toContain("Governed aliases from lineage: revenue");
  });

  it("generates generic dbt-only trend SQL from inspected relation columns", async () => {
    kg.rebuild([], []);
    const provider = new StubProvider([
      "```json",
      JSON.stringify({
        summary: "Monthly revenue trend generated from the inspected dbt relation.",
        sql: [
          "SELECT month, SUM(revenue) AS revenue_sum",
          "FROM analytics.monthly_revenue",
          "GROUP BY month",
          "ORDER BY month ASC",
          "LIMIT 10",
        ].join("\n"),
        viz: "line",
        outputs: ["month", "revenue_sum"],
      }),
      "```",
    ].join("\n"));
    const result = await answerBase({
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
    expect(provider.calls).toHaveLength(1);
    expect(provider.messages.map((message) => message.content).join("\n\n")).toContain("analytics.monthly_revenue");
  });

  it("generates distinct entity count SQL when the question asks how many customers", async () => {
    kg.rebuild([], []);
    const provider = new StubProvider([
      "```json",
      JSON.stringify({
        summary: "Customer count by region generated from the inspected customer orders relation.",
        sql: [
          "SELECT region, COUNT(DISTINCT customer_id) AS customer_count",
          "FROM analytics.customer_orders",
          "GROUP BY region",
          "ORDER BY customer_count DESC",
          "LIMIT 10",
        ].join("\n"),
        viz: "bar",
        outputs: ["region", "customer_count"],
      }),
      "```",
    ].join("\n"));
    const result = await answerBase({
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
    expect(provider.calls).toHaveLength(1);
    expect(provider.messages.map((message) => message.content).join("\n\n")).toContain("customer_id");
  });

  it("generates distinct order count SQL for count-by-time questions", async () => {
    kg.rebuild([], []);
    const provider = new StubProvider([
      "```json",
      JSON.stringify({
        summary: "Monthly order count generated from the inspected orders relation.",
        sql: [
          "SELECT month, COUNT(DISTINCT order_id) AS order_count",
          "FROM analytics.orders",
          "GROUP BY month",
          "ORDER BY month ASC",
          "LIMIT 10",
        ].join("\n"),
        viz: "line",
        outputs: ["month", "order_count"],
      }),
      "```",
    ].join("\n"));
    const result = await answerBase({
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
    expect(provider.calls).toHaveLength(1);
    expect(provider.messages.map((message) => message.content).join("\n\n")).toContain("order_id");
  });

  it("prefers the context-pack selected relation when several dbt tables look plausible", async () => {
    kg.rebuild([], []);
    const provider = new StubProvider([
      "```json",
      JSON.stringify({
        summary: "Revenue by product generated from the metadata-selected relation.",
        sql: [
          "SELECT product_name, SUM(net_revenue) AS revenue_sum",
          "FROM analytics.fct_product_revenue",
          "GROUP BY product_name",
          "ORDER BY revenue_sum DESC",
          "LIMIT 10",
        ].join("\n"),
        viz: "bar",
        outputs: ["product_name", "revenue_sum"],
      }),
      "```",
    ].join("\n"));
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
    const result = await answerBase({
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
    expect(provider.calls).toHaveLength(1);
    const prompt = provider.messages.map((message) => message.content).join("\n\n");
    expect(prompt).toContain("analytics.fct_product_revenue");
    expect(prompt).toContain("selected by metadata planner for product revenue");
  });

  it("generates generic join SQL when a metric fact table needs a requested dimension table", async () => {
    kg.rebuild([], []);
    const provider = new StubProvider([
      "```json",
      JSON.stringify({
        summary: "Revenue by customer segment generated from the selected fact and dimension tables.",
        sql: [
          "SELECT d.segment AS segment, SUM(f.revenue) AS revenue_sum",
          "FROM analytics.fct_orders AS f",
          "JOIN analytics.dim_customers AS d ON f.customer_id = d.customer_id",
          "GROUP BY d.segment",
          "ORDER BY revenue_sum DESC",
          "LIMIT 10",
        ].join("\n"),
        viz: "bar",
        outputs: ["segment", "revenue_sum"],
      }),
      "```",
    ].join("\n"));
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

    const result = await answerBase({
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
    expect(provider.calls).toHaveLength(1);
    expect(provider.messages.map((message) => message.content).join("\n\n")).toContain("Suggested join paths from selected metadata");
  });

  it("renders KG cross-domain join routes as relationship evidence for generated SQL", async () => {
    kg.rebuild(
      [
        {
          nodeId: "dbt_model:fct_revenue",
          kind: "dbt_model",
          name: "fct_revenue",
          domain: "revenue",
          description: "Revenue fact table keyed by customer.",
          sourceTier: "dbt_manifest",
        },
        {
          nodeId: "entity:Customer",
          kind: "entity",
          name: "Customer",
          domain: "customer",
          description: "Customer entity joining revenue and support activity.",
          sourceTier: "semantic_layer",
        },
        {
          nodeId: "dbt_model:fct_support_tickets",
          kind: "dbt_model",
          name: "fct_support_tickets",
          domain: "support",
          description: "Support ticket fact table keyed by customer.",
          sourceTier: "dbt_manifest",
        },
      ],
      [
        { src: "dbt_model:fct_revenue", dst: "entity:Customer", kind: "related_to", weight: 0.9 },
        { src: "entity:Customer", dst: "dbt_model:fct_support_tickets", kind: "related_to", weight: 0.9 },
      ],
    );
    const provider = new StubProvider([
      "```json",
      JSON.stringify({
        summary: "Revenue by support tickets generated from selected cross-domain context.",
        sql: [
          "SELECT r.customer_id, SUM(r.revenue) AS revenue_sum, COUNT(t.ticket_id) AS ticket_count",
          "FROM analytics.fct_revenue AS r",
          "JOIN analytics.fct_support_tickets AS t ON r.customer_id = t.customer_id",
          "GROUP BY r.customer_id",
          "ORDER BY revenue_sum DESC",
        ].join("\n"),
        viz: "table",
        outputs: ["customer_id", "revenue_sum", "ticket_count"],
      }),
      "```",
    ].join("\n"));
    const schemaContext = [
      {
        relation: "analytics.fct_revenue",
        schema: "analytics",
        name: "fct_revenue",
        source: "dbt manifest",
        columns: [
          { name: "customer_id", type: "VARCHAR" },
          { name: "revenue", type: "DECIMAL" },
        ],
      },
      {
        relation: "analytics.fct_support_tickets",
        schema: "analytics",
        name: "fct_support_tickets",
        source: "dbt manifest",
        columns: [
          { name: "customer_id", type: "VARCHAR" },
          { name: "ticket_id", type: "VARCHAR" },
        ],
      },
    ];

    const result = await answerBase({
      question: "Show revenue by support tickets by customer",
      provider,
      kg,
      schemaContext,
      contextPack: contextPackForRankedRelations("Show revenue by support tickets by customer", [
        {
          relation: "analytics.fct_revenue",
          name: "fct_revenue",
          source: "dbt manifest",
          columns: schemaContext[0]!.columns,
          rank: 1,
          score: 78,
          reason: "selected revenue fact table",
        },
        {
          relation: "analytics.fct_support_tickets",
          name: "fct_support_tickets",
          source: "dbt manifest",
          columns: schemaContext[1]!.columns,
          rank: 2,
          score: 72,
          reason: "selected support fact table",
        },
      ], { dimensionTerms: ["support", "customer"] }),
    });

    const prompt = provider.messages.map((message) => message.content).join("\n\n");
    expect(result.kind).toBe("uncertified");
    expect(prompt).toContain("Knowledge graph join routes");
    expect(prompt).toMatch(/dbt_model:fct_(revenue|support_tickets) -> entity:Customer -> dbt_model:fct_(revenue|support_tickets)/);
    expect(prompt).toContain("SQL must still use inspected relation columns");
  });

  it("renders ranked relation cards with column meaning for provider-generated SQL", async () => {
    kg.rebuild([], []);
    const provider = new StubProvider(
      "Revenue change by product is generated from the selected dbt relation and needs review.\n\n" +
        "```sql\nSELECT product_name, month, SUM(net_revenue) AS revenue FROM analytics.fct_product_revenue GROUP BY product_name, month ORDER BY month DESC\n```\n\n" +
        "Viz: line",
    );

    const rankedRelations = [
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
      ...Array.from({ length: 12 }, (_, index) => ({
        relation: `analytics.join_candidate_${index + 3}`,
        name: `join_candidate_${index + 3}`,
        source: "dbt manifest",
        columns: [
          { name: "product_id", type: "VARCHAR" },
          { name: `candidate_value_${index + 3}`, type: "DECIMAL" },
        ],
        rank: index + 3,
        score: 40 - index,
        reason: `available join candidate ${index + 3}`,
      })),
    ];

    const result = await answer({
      question: "Why did revenue change by product?",
      provider,
      kg,
      contextPack: contextPackForRankedRelations("Why did revenue change by product?", rankedRelations, {
        topRejected: [
          {
            objectKey: "dbt:model:dim_suppliers",
            objectType: "dbt_model",
            name: "dim_suppliers",
            reason: "Lower retrieval score than selected context window.",
            score: 18,
            rejectedRank: 41,
          },
        ],
      }),
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
    expect(prompt).toContain("Other available relations (names only - expand context before using columns): analytics.join_candidate_13, analytics.join_candidate_14, dim_suppliers");
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

  it("renders expanded deep context budget for research questions", async () => {
    kg.rebuild([], []);
    const provider = new StubProvider([
      "```json",
      JSON.stringify({
        summary: "Deep research SQL uses the lower-ranked wide relation.",
        sql: "SELECT col_1, col_120 FROM analytics.deep_relation_39 LIMIT 10",
        viz: "table",
        outputs: ["col_1", "col_120"],
      }),
      "```",
    ].join("\n"));
    const rankedRelations = Array.from({ length: 45 }, (_, index) => ({
      relation: `analytics.deep_relation_${index + 1}`,
      name: `deep_relation_${index + 1}`,
      source: "dbt manifest",
      columns: Array.from({ length: index === 38 ? 130 : 3 }, (__, columnIndex) => ({
        name: `col_${columnIndex + 1}`,
        type: columnIndex === 119 ? "DECIMAL" : "VARCHAR",
        ...(columnIndex === 119 ? { description: "Deep-column metric needed for research" } : {}),
      })),
      rank: index + 1,
      score: 100 - index,
      reason: `deep context candidate ${index + 1}`,
    }));
    const contextPack = contextPackForRankedRelations(
      "Deep research why revenue changed by product and supplier",
      rankedRelations,
      {
        needsResearchWorkspace: true,
        objects: [
          { objectKey: "dbt:model:deep_relation_39", objectType: "dbt_model", name: "deep_relation_39", fullName: "analytics.deep_relation_39" },
          { objectKey: "dbt:model:deep_relation_41", objectType: "dbt_model", name: "deep_relation_41", fullName: "analytics.deep_relation_41" },
        ],
        edges: [
          { edgeType: "related_to", fromKey: "dbt:model:deep_relation_39", toKey: "dbt:model:deep_relation_41", confidence: 0.91 },
        ],
      },
    );

    const result = await answer({
      question: "Deep research why revenue changed by product and supplier",
      provider,
      kg,
      contextPack,
      analysisDepth: "deep",
    });

    const prompt = provider.messages.map((message) => message.content).join("\n\n");
    expect(result.kind).toBe("uncertified");
    expect(prompt).toContain("Context budget: deep");
    expect(prompt).toContain("[rank 39, score 62.0] analytics.deep_relation_39 (dbt manifest)");
    expect(prompt).toContain("col_120 DECIMAL - Deep-column metric needed for research");
    expect(prompt).toContain("Other available relations (names only - expand context before using columns): analytics.deep_relation_41");
    expect(prompt).toContain("Context graph edges:");
    expect(prompt).toContain("related_to: dbt:model:deep_relation_39 -> dbt:model:deep_relation_41");
  });

  it("generates review-required entity profile SQL from inspected schema context", async () => {
    kg.rebuild([], []);
    const provider = new StubProvider([
      "```json",
      JSON.stringify({
        summary: "Kevin Durant profile generated from inspected player stats schema.",
        sql: [
          "SELECT player_name, season, team_name, total_points, total_assists, total_rebounds",
          "FROM analytics.int_player_stats",
          "WHERE player_name = 'Kevin Durant'",
          "LIMIT 50",
        ].join("\n"),
        viz: "table",
        outputs: ["player_name", "season", "team_name", "total_points", "total_assists", "total_rebounds"],
      }),
      "```",
    ].join("\n"));
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
    const result = await answerBase({
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
          certifiedCandidateFits: [],
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
    expect(provider.calls).toHaveLength(1);
    expect(provider.messages.map((message) => message.content).join("\n\n")).toContain("analytics.int_player_stats");
  });

  it("generates entity profile SQL from catalog-only dbt models in a large repo", async () => {
    kg.rebuild([], []);
    const projectRoot = join(dir, "large-dbt-project");
    seedLargeDbtProfileProject(projectRoot);
    const provider = new StubProvider([
      "```json",
      JSON.stringify({
        summary: "Kevin Durant profile generated from the selected athlete box score model.",
        sql: [
          "SELECT athlete_name, game_date, pts, ast, reb",
          "FROM NBA_DB.ANALYTICS.athlete_box_scores",
          "WHERE athlete_name = 'Kevin Durant'",
          "ORDER BY game_date DESC",
          "LIMIT 50",
        ].join("\n"),
        viz: "table",
        outputs: ["athlete_name", "game_date", "pts", "ast", "reb"],
      }),
      "```",
    ].join("\n"));
    const question = "Can you research Kevin Durant profile and provide complete stats";
    const contextPack = await buildLocalContextPack(projectRoot, {
      question,
      limit: 80,
    });

    const result = await answerBase({
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
    expect(provider.calls).toHaveLength(1);
    expect(provider.messages.map((message) => message.content).join("\n\n")).toContain("NBA_DB.ANALYTICS.athlete_box_scores");
  });

  it("uses certified block SQL shape as context for entity profiles when dbt columns are unavailable", async () => {
    kg.rebuild([], []);
    const provider = new StubProvider([
      "```json",
      JSON.stringify({
        summary: "Kevin Durant profile generated from certified player-performance SQL shape.",
        sql: [
          "SELECT player_name, season, total_points, games_played,",
          "  ROUND(total_points / NULLIF(games_played, 0), 2) AS points_per_game",
          "FROM NBA_GAMES.RAW.fct_player_performance",
          "WHERE player_name = 'Kevin Durant'",
          "ORDER BY season DESC",
          "LIMIT 50",
        ].join("\n"),
        viz: "table",
        outputs: ["player_name", "season", "total_points", "games_played", "points_per_game"],
      }),
      "```",
    ].join("\n"));
    const result = await answerBase({
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
          certifiedCandidateFits: [],
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
    expect(provider.calls).toHaveLength(1);
    const prompt = provider.messages.map((message) => message.content).join("\n\n");
    expect(prompt).toContain("Worked examples from certified blocks");
    expect(prompt).toContain("points_per_game");
    expect(result.proposedSql).toContain("NBA_GAMES.RAW.fct_player_performance");
    expect(result.proposedSql).toContain("player_name = 'Kevin Durant'");
    expect(result.proposedSql).toContain("points_per_game");
    expect(result.result?.rowCount).toBe(1);
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
          {
            objectKey: "dql:block_output:Top 10 Goal Scorers.total_points",
            objectType: "dql_block_output",
            name: "total_points",
            fullName: "Top 10 Goal Scorers.total_points",
            status: "certified",
          },
          {
            objectKey: "warehouse:column:NBA_GAMES.RAW.fct_player_performance.points",
            objectType: "warehouse_column",
            name: "points",
            fullName: "NBA_GAMES.RAW.fct_player_performance.points",
            sourceSystem: "DQL block column lineage",
          },
        ],
        edges: [
          {
            edgeType: "derives_from",
            fromKey: "dql:block_output:Top 10 Goal Scorers.total_points",
            toKey: "warehouse:column:NBA_GAMES.RAW.fct_player_performance.points",
            confidence: 0.92,
            payload: { aggregateFn: "sum" },
          },
        ],
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
          certifiedCandidateFits: [],
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
    expect(prompt).toContain("Column lineage from governed metadata:");
    expect(prompt).toContain("Top 10 Goal Scorers.total_points derives from NBA_GAMES.RAW.fct_player_performance.points via SUM");
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
    let capturedSourceDqlArtifact: unknown;
    const result = await answer({
      question: "Drill into Enterprise last week",
      provider,
      kg,
      followUp: {
        kind: "drilldown",
        sourceBlockName: "revenue_total",
        filters: ["Enterprise", "last week"],
        priorDqlArtifact: {
          kind: "certified_block",
          name: "revenue_total",
          sourcePath: "blocks/revenue_total.dql",
          source: 'block "revenue_total" {\n  status = "certified"\n  query = """SELECT SUM(amount) AS revenue FROM fct_orders"""\n}',
        },
      },
      captureGeneratedDraft: ({ followUp, sourceBlock, sourceDqlArtifact }) => {
        capturedSourceDqlArtifact = sourceDqlArtifact;
        return {
          path: `blocks/_drafts/${followUp?.sourceBlockName ?? sourceBlock?.name ?? "draft"}.dql`,
          askedTimes: 1,
          proposedContractId: "growth.Unknown.enterprise_drilldown",
        };
      },
    });
    expect(result.kind).toBe("uncertified");
    expect(result.reviewStatus).toBe("draft_ready");
    expect(result.text).toContain("This is an uncertified drilldown.");
    expect(result.proposedSql).toContain("segment = 'Enterprise'");
    expect(result.sourceCertifiedBlock).toBe("revenue_total");
      expect(result.dqlArtifact?.source).toContain('source_dql_kind = "certified_block"');
      expect(result.dqlArtifact?.source).toContain('source_dql_name = "revenue_total"');
      expect(result.dqlArtifact?.source).toContain('source_dql_path = "blocks/revenue_total.dql"');
      expect(result.dqlArtifact?.source).toMatch(/source_dql_hash = "[a-f0-9]{64}"/);
      expect(capturedSourceDqlArtifact).toMatchObject({
        kind: "certified_block",
        name: "revenue_total",
        sourcePath: "blocks/revenue_total.dql",
      });
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
      "Review-required drilldown DQL artifact is not certified",
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
          certifiedCandidateFits: [],
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
    expect(result.text).toContain("review-required DQL artifact");
    expect(result.text).toContain("SQL preview failed validation");
    expect(result.evidence?.validation?.message).toContain("filters \"Enterprise\" on customer");
    expect(executed).toBe(false);
    expect(captured).toBe(false);
  });

  it("plans a clear entity follow-up drilldown from inspected values and source block SQL", async () => {
    const provider = new StubProvider([
      "```json",
      JSON.stringify({
        summary: "Enterprise revenue by customer for last week, generated from inspected context.",
        sql: [
          "SELECT customer, SUM(revenue) AS revenue_total",
          "FROM main.revenue",
          "WHERE segment = 'Enterprise' AND week = DATE '2026-06-08'",
          "GROUP BY customer",
          "ORDER BY revenue_total DESC",
          "LIMIT 50",
        ].join("\n"),
        viz: "bar",
        outputs: ["customer", "revenue_total"],
      }),
      "```",
    ].join("\n"));
    let executedSql = "";
    let capturedSql = "";
    let capturedOutputs: string[] | undefined;
    const result = await answerBase({
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
          certifiedCandidateFits: [],
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
      captureGeneratedDraft: ({ sql, outputs }) => {
        capturedSql = sql;
        capturedOutputs = outputs;
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
    expect(capturedOutputs).toEqual(["customer", "revenue_total"]);
    expect(result.dqlArtifact?.source).toContain('outputs = ["customer", "revenue_total"]');
    expect(provider.calls).toHaveLength(1);
    const prompt = provider.messages.map((message) => message.content).join("\n\n");
    expect(prompt).toContain("main.revenue");
    expect(prompt).toContain("week = DATE '2026-06-08'");
    expect(result.draftBlock?.path).toContain("blocks/_drafts/");
  });

  it("repairs generated SQL once after a retryable execution failure", async () => {
    const provider = new StubProvider([
      "Draft using available columns.\n\n```sql\nSELECT customer_name, SUM(order_total) AS revenue FROM orders GROUP BY customer_name\n```\n\nViz: bar",
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
        if (attempts === 1) throw new Error('Runtime Error: transient preview execution failure');
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
    expect(result.evidence?.route).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "cascade_budget",
          label: "Repair budget used: re-ground 0/2, execution 1/2",
        }),
      ]),
    );
  });

  it("does not repair generated SQL when the execution repair budget is exhausted", async () => {
    const provider = new StubProvider([
      "Draft using available columns.\n\n```sql\nSELECT customer_name, SUM(order_total) AS revenue FROM orders GROUP BY customer_name\n```\n\nViz: bar",
      "This repair should not be requested.\n\n```sql\nSELECT customer_name, SUM(order_total) AS revenue FROM dev.orders GROUP BY customer_name\n```",
    ]);
    let attempts = 0;
    const result = await answer({
      question: "Repair revenue by customer",
      provider,
      kg,
      cascadeBudgetModel: { lane: { execution: 0 } },
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
      executeGeneratedSql: async () => {
        attempts += 1;
        throw new Error('Runtime Error: transient preview execution failure');
      },
    });

    expect(result.kind).toBe("uncertified");
    expect(result.executionError).toContain("transient preview execution failure");
    expect(result.analysisPlan?.repairAttempts).toBe(0);
    expect(attempts).toBe(1);
    expect(provider.calls).toHaveLength(1);
    expect(result.evidence?.route.map((step) => step.tool)).not.toContain("cascade_budget");
  });

  it("does not execute repaired SQL that fails the grounded context guard", async () => {
    const provider = new StubProvider([
      "Draft using available columns.\n\n```sql\nSELECT customer_name, SUM(order_total) AS revenue FROM dev.orders GROUP BY customer_name\n```\n\nViz: bar",
      "Incorrect repair that escapes the inspected context.\n\n```sql\nSELECT customer_name, SUM(order_total) AS revenue FROM dev.shadow_orders GROUP BY customer_name\n```\n\nViz: bar",
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
        if (/shadow_orders/i.test(sql)) throw new Error("shadow repair should not execute");
        throw new Error("Runtime Error: transient preview execution failure");
      },
    });

    expect(result.kind).toBe("uncertified");
    expect(attempts).toBe(1);
    expect(result.proposedSql).toContain("FROM dev.orders");
    expect(result.proposedSql).not.toContain("shadow_orders");
    expect(result.executionError).toContain("outside the inspected metadata context");
    expect(result.analysisPlan?.repairAttempts).toBe(0);
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
    expect(result.evidence?.route).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "cascade_budget",
          label: "Repair budget used: re-ground 0/2, execution 1/2",
        }),
      ]),
    );
  });

  it("self-repairs context-validation failures: bad column on turn 1, corrected JOIN on turn 2 executes", async () => {
    // Turn 1 hallucinates `product_name` onto the fact table; the guard rejects
    // it and the bounded repair pass hands the model the exact error. Turn 2's
    // corrected SQL (join-free, using inspected columns) validates and EXECUTES.
    const provider = new StubProvider([
      "```sql\nSELECT product_name, SUM(amount) AS revenue FROM analytics.fct_orders GROUP BY product_name\n```",
      "```sql\nSELECT c.segment, o.week, SUM(o.amount) AS revenue FROM analytics.fct_orders o JOIN analytics.dim_customers c ON o.customer_id = c.customer_id GROUP BY c.segment, o.week\n```",
    ]);
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
        return {
          columns: ["segment", "revenue"],
          rows: [{ segment: "enterprise", revenue: 100 }],
          rowCount: 1,
          sql,
        };
      },
    });

    expect(provider.calls).toHaveLength(2);
    expect(executed).toBe(true);
    expect(result.kind).toBe("uncertified");
    expect(result.result?.rowCount).toBe(1);
    expect(result.validationWarnings).toEqual(
      expect.arrayContaining([expect.stringContaining("Repaired after context-validation failure")]),
    );
    expect(result.evidence?.route).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "cascade_budget",
          label: "Repair budget used: re-ground 1/2, execution 0/2",
        }),
      ]),
    );
  });

  it("re-grounds unknown relations from an expansion callback before asking the model to repair", async () => {
    const provider = new StubProvider(
      "```sql\nSELECT oi.product_id, s.supply_name, SUM(oi.product_price) AS product_value\nFROM dev.order_items oi\nJOIN dev.supplies s ON oi.product_id = s.product_id\nGROUP BY oi.product_id, s.supply_name\nORDER BY product_value DESC\nLIMIT 10\n```",
    );
    let executedSql: string | undefined;
    const question = "Complete supply chain with product and order details top 10 value";
    const result = await answer({
      question,
      provider,
      kg,
      contextPack: contextPackForRankedRelations(question, [
        {
          relation: "dev.order_items",
          name: "order_items",
          source: "dbt manifest",
          columns: [
            { name: "product_id", type: "VARCHAR" },
            { name: "product_price", type: "DECIMAL" },
          ],
          rank: 1,
          score: 80,
          reason: "selected order item fact table",
        },
      ], {
        metricTerms: ["value"],
        dimensionTerms: ["product", "supply"],
        routeIntent: "entity_drilldown",
      }),
      expandGroundingContext: async (request) => {
        expect(request.code).toBe("unknown_relation");
        expect(request.offending?.relation).toBe("dev.supplies");
        return {
          relations: [{
            relation: "dev.supplies",
            name: "supplies",
            source: "runtime schema snapshot",
            columns: [
              { name: "product_id", type: "VARCHAR" },
              { name: "supply_name", type: "VARCHAR" },
            ],
          }],
          notes: ["dev.supplies columns: product_id, supply_name"],
        };
      },
      executeGeneratedSql: async (sql) => {
        executedSql = sql;
        return {
          columns: ["product_id", "supply_name", "product_value"],
          rows: [{ product_id: "JAF-001", supply_name: "bread", product_value: 120 }],
          rowCount: 1,
          sql,
        };
      },
    });

    expect(provider.calls).toHaveLength(1);
    expect(executedSql).toContain("dev.supplies");
    expect(result.kind).toBe("uncertified");
    expect(result.result?.rowCount).toBe(1);
    expect(result.validationWarnings).toEqual(
      expect.arrayContaining([expect.stringContaining("Re-grounded metadata context before repair")]),
    );
    expect(result.evidence?.route).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "cascade_budget",
          label: "Repair budget used: re-ground 1/2, execution 0/2",
        }),
      ]),
    );
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
    expect(result.refusalCode).toBe("grounding_gap");
    expect(result.refusalDetails).toMatchObject({
      code: "unknown_column",
      offending: { column: "fake_column" },
    });
    expect(result.text).toContain('column "fake_column"');
    expect(executed).toBe(false);
    // Initial generation + exactly ONE bounded self-repair attempt (which still
    // fails against this stub) — invalid SQL is never executed either way.
    expect(provider.calls).toHaveLength(2);
  });

  it("tags a provider outage with the provider_error refusal code (not a clarify)", async () => {
    class ThrowingProvider extends StubProvider {
      async generate(): Promise<string> {
        throw new Error("upstream 503");
      }
    }
    const provider = new ThrowingProvider("unused");
    const question = "Revenue by segment ranked";
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
            { name: "segment", type: "VARCHAR" },
            { name: "amount", type: "DECIMAL" },
          ],
          rank: 1,
          score: 80,
          reason: "selected revenue fact table",
        },
      ], {
        metricTerms: ["revenue"],
        dimensionTerms: ["segment"],
        mode: "ad_hoc_ranking",
        routeIntent: "ad_hoc_ranking",
      }),
    });
    expect(result.kind).toBe("no_answer");
    expect(result.refusalCode).toBe("provider_error");
    expect(result.refusalDetails).toMatchObject({ code: "provider_error" });
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

  it("continues past generic catalog clarify when inspected SQL context can answer", async () => {
    kg.rebuild([], []);
    const contextPack = contextPackForRankedRelations("Show revenue by region", [{
      relation: "analytics.fct_orders",
      name: "fct_orders",
      source: "runtime schema",
      columns: [
        { name: "region" },
        { name: "amount" },
      ],
      rank: 1,
      score: 90,
      reason: "runtime schema matched revenue by region",
    }], {
      metricTerms: ["revenue"],
      dimensionTerms: ["region"],
      routeIntent: "ad_hoc_ranking",
    });
    contextPack.routeDecision = {
      route: "clarify",
      intent: "clarify",
      reason: "DQL needs one more business or metadata detail before it can safely generate SQL.",
      trustLabel: "mixed",
      reviewStatus: "none",
      selectedEvidence: [],
      missingContext: [{
        kind: "metadata",
        severity: "blocking",
        message: "No certified block, semantic metric, dbt model, or runtime schema matched strongly enough to answer safely.",
      }],
      followUps: [],
    };
    const provider = new StubProvider([
      "Revenue by region.",
      "",
      "```sql",
      "SELECT region, SUM(amount) AS revenue",
      "FROM analytics.fct_orders",
      "GROUP BY region",
      "```",
      "",
      "Viz: bar",
    ].join("\n"));

    const result = await answer({
      question: "Show revenue by region",
      provider,
      kg,
      contextPack,
      executeGeneratedSql: async (sql) => ({
        columns: ["region", "revenue"],
        rows: [{ region: "North", revenue: 10 }],
        rowCount: 1,
        sql,
      }),
    });

    expect(result.kind).toBe("uncertified");
    expect(result.route?.tier).toBe("generated_sql");
    expect(result.route?.label).toBe("Prepared review-required DQL artifact with SQL preview.");
    expect(result.dqlArtifact?.kind).toBe("sql_block");
    expect(result.proposedSql).toContain("analytics.fct_orders");
    expect(provider.calls.length).toBeLessThanOrEqual(1);
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
  options: {
    metricTerms?: string[];
    dimensionTerms?: string[];
    mode?: string;
    routeIntent?: string;
    certifiedApplicability?: CertifiedBlockApplicability;
    blockFit?: CertifiedBlockFit;
    certifiedCandidateFits?: Array<{
      objectKey: string;
      name: string;
      applicabilityKind: "exact_answer" | "safe_parameterized" | "context_only" | "not_applicable";
      applicabilityScore: number;
      action: "certified_answer" | "context_only" | "eligible_not_selected" | "rejected_for_fit";
      fit: CertifiedBlockFit;
    }>;
    sourceBlockSql?: Array<{
      objectKey: string;
      name: string;
      status?: string;
      sql: string;
    }>;
    topRejected?: Array<{
      objectKey: string;
      objectType: string;
      name: string;
      reason: string;
      score: number;
      rejectedRank: number;
    }>;
    needsResearchWorkspace?: boolean;
    objects?: Array<Record<string, unknown>>;
    edges?: Array<Record<string, unknown>>;
  } = {},
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
      needsResearchWorkspace: options.needsResearchWorkspace ?? false,
      searchQueries: [question],
      searchTerms: [...metricTerms, ...dimensionTerms],
      requestedShape: {
        dimensions: dimensionTerms,
        measures: metricTerms,
        requiredOutputs: [...dimensionTerms, ...metricTerms],
        filters: [],
        followUpReferences: [],
      },
      confidence: 0.85,
      reasons: ["test context"],
    },
    objects: options.objects ?? [],
    edges: options.edges ?? [],
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
	      certifiedApplicability: options.certifiedApplicability,
	      blockFit: options.blockFit,
	    },
    evidenceRoles: [],
    allowedSqlContext: {
      relations: relations.map(({ rank: _rank, score: _score, reason: _reason, ...relation }) => relation),
      sourceBlockSql: options.sourceBlockSql ?? [],
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
      topRejected: options.topRejected ?? [],
      certifiedCandidateFits: options.certifiedCandidateFits ?? [],
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
  it("extracts a structured JSON proposal from a fenced object", () => {
    const raw = [
      "```json",
      JSON.stringify({
        summary: "Revenue by region at region grain.",
        sql: "SELECT region, SUM(amount) AS revenue FROM orders GROUP BY region",
        viz: "bar",
        outputs: ["region", "revenue"],
      }),
      "```",
    ].join("\n");
    expect(parseProposal(raw)).toEqual({
      text: "Revenue by region at region grain.",
      sql: "SELECT region, SUM(amount) AS revenue FROM orders GROUP BY region",
      viz: "bar",
      outputs: ["region", "revenue"],
    });
  });

  it("extracts DQL metadata from a structured JSON proposal", () => {
    const raw = [
      "```json",
      JSON.stringify({
        summary: "Product supply value at product and supply grain.",
        sql: "SELECT product_name, supply_name, SUM(order_value) AS total_value FROM product_supply_orders GROUP BY product_name, supply_name",
        viz: "table",
        outputs: ["product_name", "supply_name", "total_value"],
        dql: {
          entity: "product_supply",
          dimensions: ["product_name", "supply_name", "product_name"],
          filters: ["top 10 by total_value", "top 10 by total_value"],
        },
      }),
      "```",
    ].join("\n");
    expect(parseProposal(raw)).toEqual({
      text: "Product supply value at product and supply grain.",
      sql: "SELECT product_name, supply_name, SUM(order_value) AS total_value FROM product_supply_orders GROUP BY product_name, supply_name",
      viz: "table",
      outputs: ["product_name", "supply_name", "total_value"],
      proposedEntity: "product_supply",
      requestedDimensions: ["product_name", "supply_name"],
      requestedFilters: ["top 10 by total_value"],
    });
  });

  it("extracts a structured JSON proposal from a raw object", () => {
    const raw = JSON.stringify({
      answer: "One KPI row.",
      query: "SELECT COUNT(*) AS order_count FROM orders",
      visualization: "single_value",
    });
    expect(parseProposal(raw)).toEqual({
      text: "One KPI row.",
      sql: "SELECT COUNT(*) AS order_count FROM orders",
      viz: "single_value",
    });
  });

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

  it("falls back to the legacy SQL parser when JSON is malformed", () => {
    const raw = '```json\n{"summary": "bad"\n```\n\nFallback summary.\n```sql\nSELECT 3\n```\nViz: table';
    expect(parseProposal(raw)).toEqual({
      text: "Fallback summary.",
      sql: "SELECT 3",
      viz: "table",
    });
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

  it("compiles metric, dimension, and time grain through SemanticLayer.composeQuery before provider generation", async () => {
    kg.rebuild(
      [
        revenueMetric("total_revenue", "Total recognized revenue"),
      ],
      [],
    );
    const semanticLayer = new SemanticLayer({
      metrics: [
        {
          name: "total_revenue",
          label: "Total Revenue",
          description: "Total recognized revenue.",
          domain: "finance",
          sql: "amount",
          type: "sum",
          table: "orders",
        },
      ],
      dimensions: [
        {
          name: "channel",
          label: "Channel",
          description: "Sales channel.",
          domain: "finance",
          sql: "channel",
          type: "string",
          table: "orders",
        },
        {
          name: "order_date",
          label: "Order Date",
          description: "Order date.",
          domain: "finance",
          sql: "order_date",
          type: "date",
          table: "orders",
          isTimeDimension: true,
        },
      ],
    });
    const provider = new StubProvider("should not be called");
    let capturedDqlArtifact: unknown;

    const result = await answer({
      question: "Show monthly revenue by channel",
      provider,
      kg,
      semanticLayer,
      executeGeneratedSql: async (sql) => ({
        columns: ["channel", "order_date_month", "total_revenue"],
        rows: [{ channel: "Direct", order_date_month: "2026-01-01", total_revenue: 123 }],
        rowCount: 1,
        sql,
      }),
      captureGeneratedDraft: ({ dqlArtifact }) => {
        capturedDqlArtifact = dqlArtifact;
        return {
          path: "blocks/_drafts/monthly_revenue_by_channel.dql",
          askedTimes: 1,
          proposedContractId: "finance.Unknown.monthly_revenue_by_channel",
        };
      },
    });

    expect(result.route?.tier).toBe("semantic_metric");
    expect(result.cascade).toMatchObject({
      terminalLane: "semantic",
      routeTier: "semantic_metric",
      ref: "total_revenue",
      artifactKind: "semantic_block",
      outcome: {
        lane: "semantic",
        routeTier: "semantic_metric",
        ref: "total_revenue",
        artifactKind: "semantic_block",
        metrics: ["total_revenue"],
        dimensions: ["channel"],
        rowCount: 1,
      },
    });
    expect(provider.calls).toHaveLength(0);
    expect(result.proposedSql).toContain("SUM(amount) AS total_revenue");
    expect(result.proposedSql).toContain("channel AS channel");
    expect(result.proposedSql).toContain("DATE_TRUNC('month', orders.order_date) AS order_date_month");
    expect(result.result?.rowCount).toBe(1);
    expect(result.dqlArtifact?.kind).toBe("semantic_block");
    expect(result.dqlArtifact?.name).toBe("monthly_revenue_by_channel");
    expect(result.dqlArtifact?.source).toContain('type = "semantic"');
    expect(result.dqlArtifact?.source).toContain('block "monthly_revenue_by_channel"');
    expect(result.dqlArtifact?.source).toContain('metric = "total_revenue"');
    expect(result.dqlArtifact?.source).toContain('dimensions = ["channel"]');
    expect(result.dqlArtifact?.source).toContain('time_dimension = "order_date"');
    expect(result.dqlArtifact?.source).toContain('granularity = "month"');
    expect(result.evidence?.route).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "cascade_semantic",
          status: "selected",
          detail: "total_revenue",
        }),
        expect.objectContaining({
          tool: "cascade_generated",
          status: "skipped",
        }),
      ]),
    );
    expect(result.draftBlock?.path).toBe("blocks/_drafts/monthly_revenue_by_channel.dql");
    expect(capturedDqlArtifact).toMatchObject({
      kind: "semantic_block",
      name: "monthly_revenue_by_channel",
      source: expect.stringContaining('type = "semantic"'),
      metrics: ["total_revenue"],
      dimensions: ["channel"],
      timeDimension: { name: "order_date", granularity: "month" },
    });
  });

  it("falls back to ONE LLM member selection when deterministic selection misses (Lane 2, not Lane 3)", async () => {
    kg.rebuild([revenueMetric("total_revenue", "Total recognized revenue")], []);
    const semanticLayer = new SemanticLayer({
      metrics: [
        {
          name: "total_revenue",
          label: "Total Revenue",
          description: "Total recognized revenue.",
          domain: "finance",
          sql: "amount",
          type: "sum",
          table: "orders",
        },
      ],
      dimensions: [
        {
          name: "channel",
          label: "Channel",
          description: "Sales channel.",
          domain: "finance",
          sql: "channel",
          type: "string",
          table: "orders",
        },
      ],
    });
    // "acquisition medium" is a paraphrase of `channel` that the deterministic
    // token matcher cannot resolve, so composeSemanticQueryForQuestion misses —
    // but the metric still matches, so the LLM member fallback fires.
    const provider = new StubProvider(
      '```json\n{"metrics":["total_revenue"],"dimensions":["channel"]}\n```',
    );

    const result = await answer({
      question: "revenue by acquisition medium",
      provider,
      kg,
      semanticLayer,
      executeGeneratedSql: async (sql) => ({
        columns: ["channel", "total_revenue"],
        rows: [{ channel: "Direct", total_revenue: 100 }],
        rowCount: 1,
        sql,
      }),
    });

    expect(result.route?.tier).toBe("semantic_metric");
    // Exactly ONE provider call — the member selection — and the compiler produced the SQL.
    expect(provider.calls).toHaveLength(1);
    expect(result.proposedSql).toContain("SUM(amount) AS total_revenue");
    expect(result.proposedSql).toContain("channel AS channel");
    expect(result.dqlArtifact?.kind).toBe("semantic_block");
  });

  it("stamps a certified-metric answer as 'reviewed' (verified), never 'certified'", async () => {
    const certifiedMetric: KGNode = {
      ...revenueMetric("total_revenue", "Total recognized revenue"),
      certification: "certified",
    };
    kg.rebuild([certifiedMetric], []);
    const semanticLayer = new SemanticLayer({
      metrics: [
        {
          name: "total_revenue",
          label: "Total Revenue",
          description: "Total recognized revenue.",
          domain: "finance",
          sql: "amount",
          type: "sum",
          table: "orders",
          status: "certified",
        },
      ],
      dimensions: [],
    });
    const provider = new StubProvider("should not be called");
    const result = await answer({
      question: "What is total revenue?",
      provider,
      kg,
      semanticLayer,
      executeGeneratedSql: async (sql) => ({ columns: ["total_revenue"], rows: [{ total_revenue: 42 }], rowCount: 1, sql }),
    });

    expect(result.route?.tier).toBe("semantic_metric");
    // Verified — above generated SQL, below human-certified. The invariant holds:
    // AI never stamps its own answer 'certified'.
    expect(result.trustLabelInfo?.id).toBe("reviewed");
    expect(result.kind).not.toBe("certified");
    expect(provider.calls).toHaveLength(0);
  });

  it("compiles multiple semantic metrics through SemanticLayer.composeQuery", async () => {
    kg.rebuild(
      [
        revenueMetric("total_revenue", "Total recognized revenue"),
        {
          nodeId: "metric:order_count",
          kind: "metric",
          name: "order_count",
          domain: "finance",
          description: "Count of orders",
          tags: ["orders"],
          llmContext: "sql: COUNT(order_id)\ntable: orders",
          sourceTier: "semantic_layer",
          certification: "ai_generated",
          provenance: "semantic layer",
        },
      ],
      [],
    );
    const semanticLayer = new SemanticLayer({
      metrics: [
        {
          name: "total_revenue",
          label: "Total Revenue",
          description: "Total recognized revenue.",
          domain: "finance",
          sql: "amount",
          type: "sum",
          table: "orders",
        },
        {
          name: "order_count",
          label: "Order Count",
          description: "Count of orders.",
          domain: "finance",
          sql: "order_id",
          type: "count",
          table: "orders",
        },
      ],
      dimensions: [
        {
          name: "channel",
          label: "Channel",
          description: "Sales channel.",
          domain: "finance",
          sql: "channel",
          type: "string",
          table: "orders",
        },
      ],
    });
    const provider = new StubProvider("should not be called");

    const result = await answer({
      question: "Show revenue and orders by channel",
      provider,
      kg,
      semanticLayer,
      executeGeneratedSql: async (sql) => ({
        columns: ["channel", "total_revenue", "order_count"],
        rows: [{ channel: "Direct", total_revenue: 123, order_count: 4 }],
        rowCount: 1,
        sql,
      }),
    });

    expect(result.route?.tier).toBe("semantic_metric");
    expect(provider.calls).toHaveLength(0);
    expect(result.proposedSql).toContain("SUM(amount) AS total_revenue");
    expect(result.proposedSql).toContain("COUNT(order_id) AS order_count");
    expect(result.dqlArtifact?.metrics).toEqual(expect.arrayContaining(["total_revenue", "order_count"]));
    expect(result.dqlArtifact?.source).toContain('metrics = [');
    expect(result.dqlArtifact?.source).toContain('"total_revenue"');
    expect(result.dqlArtifact?.source).toContain('"order_count"');
    expect(result.text).toContain("governed semantic metrics");
  });

  it("falls through to generated DQL when the semantic layer cannot express the requested dimension", async () => {
    kg.rebuild(
      [
        revenueMetric("total_revenue", "Total recognized revenue"),
      ],
      [],
    );
    const semanticLayer = new SemanticLayer({
      metrics: [
        {
          name: "total_revenue",
          label: "Total Revenue",
          description: "Total recognized revenue.",
          domain: "finance",
          sql: "amount",
          type: "sum",
          table: "orders",
        },
      ],
      dimensions: [
        {
          name: "channel",
          label: "Channel",
          description: "Sales channel.",
          domain: "finance",
          sql: "channel",
          type: "string",
          table: "orders",
        },
      ],
    });
    const provider = new StubProvider([
      "```json",
      JSON.stringify({
        summary: "Revenue by product from inspected SQL context.",
        sql: "SELECT product_name, SUM(amount) AS total_revenue FROM orders GROUP BY product_name",
        viz: "bar",
        outputs: ["product_name", "total_revenue"],
      }),
      "```",
    ].join("\n"));

    const result = await answer({
      question: "Show revenue by product",
      provider,
      kg,
      semanticLayer,
      schemaContext: [
        {
          relation: "orders",
          name: "orders",
          columns: [
            { name: "product_name" },
            { name: "amount" },
          ],
        },
      ],
      executeGeneratedSql: async (sql) => ({
        columns: ["product_name", "total_revenue"],
        rows: [{ product_name: "JAF-001", total_revenue: 123 }],
        rowCount: 1,
        sql,
      }),
    });

    // Two calls: one governed member-selection attempt (declines — product is not
    // a semantic dimension) then Lane-3 generation. R3.5 spends one cheap call to
    // try the governed tier before falling through.
    expect(provider.calls).toHaveLength(2);
    expect(result.route?.tier).toBe("generated_sql");
    expect(result.dqlArtifact?.kind).toBe("sql_block");
    expect(result.dqlArtifact?.source).toContain('type = "custom"');
    expect(result.dqlArtifact?.source).toContain("SELECT product_name, SUM(amount) AS total_revenue FROM orders GROUP BY product_name");
  });

  it("compiles semantic filters, order, and limit through SemanticLayer.composeQuery", async () => {
    kg.rebuild(
      [
        revenueMetric("total_revenue", "Total recognized revenue"),
      ],
      [],
    );
    const semanticLayer = new SemanticLayer({
      metrics: [
        {
          name: "total_revenue",
          label: "Total Revenue",
          description: "Total recognized revenue.",
          domain: "finance",
          sql: "amount",
          type: "sum",
          table: "orders",
        },
      ],
      dimensions: [
        {
          name: "channel",
          label: "Channel",
          description: "Sales channel.",
          domain: "finance",
          sql: "channel",
          type: "string",
          table: "orders",
        },
        {
          name: "order_date",
          label: "Order Date",
          description: "Order date.",
          domain: "finance",
          sql: "order_date",
          type: "date",
          table: "orders",
          isTimeDimension: true,
        },
      ],
    });
    const provider = new StubProvider("should not be called");

    const result = await answer({
      question: "Show top 5 monthly revenue for Online channel",
      provider,
      kg,
      semanticLayer,
      executeGeneratedSql: async (sql) => ({
        columns: ["channel", "order_date_month", "total_revenue"],
        rows: [{ channel: "Online", order_date_month: "2026-01-01", total_revenue: 123 }],
        rowCount: 1,
        sql,
      }),
    });

    expect(result.route?.tier).toBe("semantic_metric");
    expect(provider.calls).toHaveLength(0);
    expect(result.proposedSql).toContain("WHERE channel = 'Online'");
    expect(result.proposedSql).toContain("ORDER BY total_revenue DESC");
    expect(result.proposedSql).toContain("LIMIT 5");
    expect(result.dqlArtifact?.filters).toEqual([
      { dimension: "channel", operator: "equals", values: ["Online"] },
    ]);
    expect(result.dqlArtifact?.orderBy).toEqual([{ name: "total_revenue", direction: "desc" }]);
    expect(result.dqlArtifact?.limit).toBe(5);
    expect(result.dqlArtifact?.source).toContain('requested_filters = ["channel=Online"]');
    expect(result.dqlArtifact?.source).toContain('order_by = ["total_revenue desc"]');
    expect(result.dqlArtifact?.source).toContain("limit = 5");
  });

  it("routes an ad-hoc analytical question to generated_sql", async () => {
    seedMetricsKg();
    const provider = new StubProvider(
      "Median order value by region.\n\n```sql\nSELECT region, MEDIAN(amount) FROM dev.order_items GROUP BY region\n```\n\nViz: bar",
    );
    const result = await answer({ question: "median order value by region", provider, kg });
    expect(result.route?.tier).toBe("generated_sql");
    expect(result.route?.label).toBe("Prepared review-required DQL artifact with SQL preview.");
    expect(result.dqlArtifact?.kind).toBe("sql_block");
    expect(result.cascade).toMatchObject({
      terminalLane: "generated",
      routeTier: "generated_sql",
      artifactKind: "sql_block",
      outcome: {
        lane: "generated",
        routeTier: "generated_sql",
        artifactKind: "sql_block",
        hasSqlPreview: true,
        executionStatus: "not_requested",
      },
    });
  });

  it("preserves certified-first routing (certified_block route)", async () => {
    // Uses the top-level beforeEach KG with block:revenue_total certified.
    const provider = new StubProvider("should not be called");
    const result = await answer({ question: "What was revenue this quarter?", provider, kg });
    expect(result.kind).toBe("certified");
    expect(result.route?.tier).toBe("certified_block");
    expect(result.route?.ref).toBe("revenue_total");
    expect(result.cascade).toMatchObject({
      terminalLane: "certified",
      routeTier: "certified_block",
      ref: "revenue_total",
      outcome: {
        lane: "certified",
        routeTier: "certified_block",
        ref: "revenue_total",
      },
    });
  });

  it("keeps an honest refusal as no_answer when nothing fits", async () => {
    kg.rebuild([], []);
    const provider = new StubProvider("I cannot answer that.");
    const result = await answer({ question: "qwfp zxcv asdf", provider, kg });
    expect(result.kind).toBe("no_answer");
    expect(result.route?.tier).toBe("no_answer");
    expect(result.cascade).toMatchObject({
      terminalLane: "refusal",
      routeTier: "no_answer",
      refusalCode: "model_declined",
      outcome: {
        lane: "refusal",
        routeTier: "no_answer",
        refusalCode: "model_declined",
        reason: "I cannot answer that.",
      },
    });
  });
});
