import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAppDocument,
  parseDashboardDocument,
} from "@duckcodeailabs/dql-core";
import { KGStore } from "./kg/sqlite-fts.js";
import {
  generateAppFromPlan,
  planAppFromPrompt,
  validateAppPlan,
  type AppPlan,
} from "./app-builder.js";
import type { KGNode } from "./kg/types.js";

function withKg<T>(nodes: KGNode[], fn: (kg: KGStore, dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "dql-app-plan-"));
  const kg = new KGStore(join(dir, "kg.sqlite"));
  try {
    kg.rebuild(nodes, []);
    return fn(kg, dir);
  } finally {
    kg.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const revenueNodes: KGNode[] = [
  {
    nodeId: "block:revenue_total",
    kind: "block",
    name: "revenue_total",
    domain: "growth",
    status: "certified",
    description: "Weekly revenue KPI for executive review",
    llmContext: "Use this for weekly revenue health and COO scorecards.",
    tags: ["revenue", "weekly", "kpi"],
    sourceTier: "certified_artifact",
    certification: "certified",
    decisionUse: "Weekly operating review",
    caveats: ["Current week may restate."],
  },
  {
    nodeId: "block:revenue_by_segment",
    kind: "block",
    name: "revenue_by_segment",
    domain: "growth",
    status: "certified",
    description: "Revenue split by customer segment",
    llmContext:
      "Use this for Enterprise, SMB, and Mid-Market revenue drilldowns.",
    tags: ["revenue", "segment", "drilldown"],
    sourceTier: "certified_artifact",
    certification: "certified",
  },
  {
    nodeId: "block:experimental_revenue_forecast",
    kind: "block",
    name: "experimental_revenue_forecast",
    domain: "growth",
    status: "draft",
    description: "Draft revenue forecast",
    tags: ["revenue", "forecast"],
  },
  {
    nodeId: "business_view:Revenue Health",
    kind: "business_view",
    name: "Revenue Health",
    domain: "growth",
    status: "certified",
    description: "Business view for revenue leadership.",
    llmContext: "Certified context for revenue health apps.",
    sourceTier: "business_context",
    certification: "certified",
  },
];

const nbaNodes: KGNode[] = [
  {
    nodeId: "block:top_10_goal_scorers",
    kind: "block",
    name: "top_10_goal_scorers",
    domain: "nba",
    status: "certified",
    description: "Top 10 goal scorers by player and total goal count",
    llmContext: "Use this for ranking NBA players by scoring output.",
    tags: ["nba", "player", "top", "scoring"],
    sourceTier: "certified_artifact",
    certification: "certified",
  },
  {
    nodeId: "block:player_stats_data_availability",
    kind: "block",
    name: "player_stats_data_availability",
    domain: "nba",
    status: "certified",
    description: "Dataset availability and record counts for player stats",
    llmContext: "Use this as supporting data availability evidence.",
    tags: ["nba", "availability", "records"],
    sourceTier: "certified_artifact",
    certification: "certified",
  },
];

describe("planAppFromPrompt", () => {
  it("builds a reviewable local app plan from certified DQL context", () =>
    withKg(revenueNodes, (kg) => {
      const plan = planAppFromPrompt({
        prompt: "Build a weekly revenue health app for the COO",
        kg,
        owner: "ops@example.com",
      });

      expect(plan.skills.map((skill) => skill.id)).toEqual([
        "interpret_business_intent",
        "match_certified_context",
        "shape_business_story",
        "design_dashboard_layout",
        "draft_missing_sections",
        "route_review",
      ]);
      expect(plan.planning).toMatchObject({
        plannerMode: "deterministic",
        analysisIntent: "metric_monitoring",
        audience: "COO",
        domain: "growth",
      });
      expect(plan.planning.displayStrategy).toContain("KPIs");
      expect(plan.planning.certifiedContext).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            nodeId: "block:revenue_total",
            kind: "block",
          }),
          expect.objectContaining({
            nodeId: "business_view:Revenue Health",
            kind: "business_view",
          }),
        ]),
      );
      expect(plan.appId).toBe("weekly-revenue-health");
      expect(plan.domain).toBe("growth");
      expect(plan.audience).toBe("COO");
      expect(plan.lifecycle).toBe("draft");
      expect(plan.pages[0].filters.map((filter) => filter.id)).toContain(
        "week",
      );
      expect(plan.pages[0].tiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "certified_block",
            blockId: "revenue_total",
            certification: "certified",
            reviewStatus: "certified",
            display: expect.objectContaining({
              trustState: "certified",
              followUpActions: expect.arrayContaining(["open_research"]),
              genUi: expect.objectContaining({
                version: 1,
                trustState: "certified",
                allowedVisualizations: expect.arrayContaining(["line", "bar", "table"]),
              }),
            }),
          }),
          expect.objectContaining({
            kind: "draft_placeholder",
            certification: "uncertified",
            reviewStatus: "draft_ready",
            display: expect.objectContaining({
              trustState: "draft_ready",
            }),
          }),
        ]),
      );
    }));

  it("prioritizes explicitly selected certified blocks in generated plans", () =>
    withKg(revenueNodes, (kg) => {
      const plan = planAppFromPrompt({
        prompt: "Build a weekly operating app for the COO",
        kg,
        domain: "growth",
        preferredBlockIds: ["revenue_by_segment"],
      });

      const certifiedTiles = plan.pages[0].tiles.filter(
        (tile) => tile.kind === "certified_block",
      );
      expect(certifiedTiles[0]).toMatchObject({
        blockId: "revenue_by_segment",
        certification: "certified",
      });
    }));

  it("uses ranking and evidence GenUI panels for an NBA scorer app", () =>
    withKg(nbaNodes, (kg) => {
      const plan = planAppFromPrompt({
        prompt:
          "Build an NBA E2E QA app for Kevin Durant profile and player performance. Use certified player performance and top scorers blocks when available.",
        kg,
        domain: "nba",
        preferredBlockIds: [
          "top_10_goal_scorers",
          "player_stats_data_availability",
        ],
      });

      const scorerTile = plan.pages[0].tiles.find(
        (tile) => tile.blockId === "top_10_goal_scorers",
      );
      const availabilityTile = plan.pages[0].tiles.find(
        (tile) => tile.blockId === "player_stats_data_availability",
      );

      expect(scorerTile).toMatchObject({
        viz: "bar",
        display: expect.objectContaining({
          genUi: expect.objectContaining({
            component: "RankingPanel",
            layoutIntent: "wide",
            allowedVisualizations: expect.arrayContaining(["bar", "table", "donut"]),
          }),
        }),
      });
      expect(availabilityTile).toMatchObject({
        viz: "table",
        display: expect.objectContaining({
          genUi: expect.objectContaining({
            component: "EvidenceTable",
            layoutIntent: "standard",
          }),
        }),
      });
    }));
});

describe("validateAppPlan", () => {
  it("rejects certified tiles backed by non-certified blocks", () =>
    withKg(revenueNodes, (kg) => {
      const plan = planAppFromPrompt({
        prompt: "Build a weekly revenue health app for the COO",
        kg,
      });
      const badPlan: AppPlan = {
        ...plan,
        pages: [
          {
            ...plan.pages[0],
            tiles: [
              {
                ...plan.pages[0].tiles.find(
                  (tile) => tile.kind === "certified_block",
                )!,
                blockId: "experimental_revenue_forecast",
                certification: "certified",
                reviewStatus: "certified",
              },
            ],
          },
        ],
      };

      const validation = validateAppPlan(badPlan, kg);
      expect(validation.ok).toBe(false);
      expect(
        validation.issues.some((issue) =>
          issue.message.includes("not certified"),
        ),
      ).toBe(true);
    }));
});

describe("generateAppFromPlan", () => {
  it("writes deterministic app and dashboard files that parse cleanly", () =>
    withKg(revenueNodes, (kg, dir) => {
      const projectRoot = join(dir, "project");
      const plan = planAppFromPrompt({
        prompt: "Build a weekly revenue health app for the COO",
        kg,
        owner: "ops@example.com",
      });

      const generated = generateAppFromPlan(projectRoot, plan, kg);

      expect(generated.paths).toEqual([
        `apps/${plan.appId}/dql.app.json`,
        `apps/${plan.appId}/dashboards/overview.dqld`,
        `apps/${plan.appId}/README.md`,
      ]);

      const appText = readFileSync(
        join(projectRoot, generated.paths[0]),
        "utf-8",
      );
      const dashboardText = readFileSync(
        join(projectRoot, generated.paths[1]),
        "utf-8",
      );
      expect(parseAppDocument(appText).errors).toEqual([]);
      expect(parseDashboardDocument(dashboardText).errors).toEqual([]);

      const dashboard = JSON.parse(dashboardText);
      expect(dashboard.layout.items).toHaveLength(
        plan.pages[0].tiles.filter((tile) => tile.kind === "certified_block").length,
      );
      expect(dashboard.layout.items.some((item: any) => item.text)).toBe(false);
      expect(dashboard.layout.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            block: { blockId: "revenue_total" },
            viz: expect.objectContaining({
              options: expect.objectContaining({
                dqlGenUi: expect.objectContaining({
                  version: 1,
                  trustState: "certified",
                }),
              }),
            }),
          }),
        ]),
      );
      expect(dashboard.layout.items[0]).toMatchObject({
        i: "revenue-total",
        block: { blockId: "revenue_total" },
      });
      const readme = readFileSync(
        join(projectRoot, generated.paths[2]),
        "utf-8",
      );
      expect(readme).toContain("## Planner brief");
      expect(readme).toContain("## Certified context");
      expect(readme).toContain("## Review backlog");
      expect(readme).toContain("Trust and evidence gaps");
    }));
});
