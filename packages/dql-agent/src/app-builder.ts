import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  parseAppDocument,
  parseDashboardDocument,
  suggestAppId,
  type AppDocument,
  type DashboardDocument,
  type DashboardGridItem,
  type DashboardVizConfig,
} from "@duckcodeailabs/dql-core";
import type { KGNode } from "./kg/types.js";
import type { KGStore } from "./kg/sqlite-fts.js";

export type AppBuilderSkillId =
  | "interpret_business_intent"
  | "match_certified_context"
  | "shape_business_story"
  | "design_dashboard_layout"
  | "draft_missing_sections"
  | "route_review";

export type AppPlanTileKind =
  | "certified_block"
  | "draft_placeholder"
  | "narrative";

export type AppPlanAnalysisIntent =
  | "executive_summary"
  | "metric_monitoring"
  | "driver_analysis"
  | "entity_drilldown"
  | "trust_review"
  | "data_quality"
  | "experiment_readout";

export type AppPlanTileRole =
  | "business_summary"
  | "kpi"
  | "trend"
  | "breakdown"
  | "evidence"
  | "trust"
  | "research"
  | "narrative";

export type AppPlanTrustState =
  | "certified"
  | "review_required"
  | "draft_ready";

export type AppPlanFollowUpAction =
  | "ask_follow_up"
  | "open_research"
  | "review_trust"
  | "create_draft_block";

export type AppPlanLayoutIntent =
  | "auto"
  | "compact"
  | "standard"
  | "wide"
  | "tall"
  | "full";

export type AppPlanGenUiComponent =
  | "BusinessBrief"
  | "KpiMetric"
  | "TrendPanel"
  | "RankingPanel"
  | "EvidenceTable"
  | "TrustCallout"
  | "ResearchActions"
  | "NarrativePanel";

export interface AppPlanGenUi {
  version: 1;
  component: AppPlanGenUiComponent;
  role: AppPlanTileRole;
  layoutIntent: AppPlanLayoutIntent;
  defaultVisualization: DashboardVizConfig["type"];
  allowedVisualizations: DashboardVizConfig["type"][];
  fieldHints?: {
    label?: string;
    value?: string;
    x?: string;
    y?: string;
    color?: string;
    time?: string;
    rank?: string;
  };
  insightTitle: string;
  trustState: AppPlanTrustState;
  reviewStatus: AppPlanTile["reviewStatus"];
  sourceNodeId?: string;
  followUpActions: AppPlanFollowUpAction[];
  rationale: string;
}

export interface AppPlanFilter {
  id: string;
  label: string;
  type: "date" | "daterange" | "select" | "string";
  default?: unknown;
  bindsTo?: string;
}

export interface AppPlanTile {
  id: string;
  title: string;
  kind: AppPlanTileKind;
  description?: string;
  blockId?: string;
  sourceNodeId?: string;
  viz: DashboardVizConfig["type"];
  certification: "certified" | "uncertified";
  reviewStatus: "certified" | "draft_ready" | "review_required";
  rationale?: string;
  caveats?: string[];
  reviewTasks?: string[];
  display?: {
    role: AppPlanTileRole;
    recommendedDisplayType: DashboardVizConfig["type"];
    layoutPriority: number;
    expectedGrain?: string;
    trustState: AppPlanTrustState;
    followUpActions: AppPlanFollowUpAction[];
    rationale: string;
    genUi: AppPlanGenUi;
  };
}

export interface AppPlanPage {
  id: string;
  title: string;
  description?: string;
  filters: AppPlanFilter[];
  tiles: AppPlanTile[];
}

export interface AppBuilderSkill {
  id: AppBuilderSkillId;
  title: string;
  description: string;
}

export interface AppPlan {
  version: 1;
  appId: string;
  name: string;
  prompt: string;
  planning: {
    plannerMode: "deterministic" | "ai_assisted";
    normalizedGoal: string;
    analysisIntent: AppPlanAnalysisIntent;
    audience: string;
    domain: string;
    certifiedContext: Array<{
      nodeId: string;
      name: string;
      kind: string;
      reason: string;
    }>;
    missingEvidence: string[];
    displayStrategy: string;
    layoutRationale: string;
    handoffPlan: string[];
  };
  skills: AppBuilderSkill[];
  domain: string;
  audience: string;
  businessGoal: string;
  owner: string;
  lifecycle: "draft" | "review";
  tags: string[];
  pages: AppPlanPage[];
  caveats: string[];
  reviewTasks: string[];
}

export interface PlanAppFromPromptInput {
  prompt: string;
  kg: KGStore;
  domain?: string;
  owner?: string;
  preferredBlockIds?: string[];
  maxCertifiedTiles?: number;
  plannerMode?: "deterministic" | "ai_assisted";
}

export interface AppPlanValidationIssue {
  level: "error" | "warning";
  path: string;
  message: string;
}

export interface AppPlanValidationResult {
  ok: boolean;
  issues: AppPlanValidationIssue[];
  certifiedTiles: number;
  draftTiles: number;
}

export interface GenerateAppFromPlanOptions {
  overwrite?: boolean;
}

export interface GeneratedAppPackage {
  app: AppDocument;
  dashboards: DashboardDocument[];
  paths: string[];
}

export const APP_BUILDER_SKILLS: AppBuilderSkill[] = [
  {
    id: "interpret_business_intent",
    title: "Interpret business intent",
    description:
      "Normalize the raw user prompt into audience, goal, domain, and analysis intent before selecting assets.",
  },
  {
    id: "match_certified_context",
    title: "Match certified context",
    description:
      "Search the local DQL ledger for certified blocks, terms, business views, and lineage that fit the prompt.",
  },
  {
    id: "shape_business_story",
    title: "Shape the story",
    description:
      "Turn matched blocks into a stakeholder flow with filters, page title, tile order, and decision framing.",
  },
  {
    id: "design_dashboard_layout",
    title: "Design dashboard layout",
    description:
      "Choose display roles, chart types, and tile sizing from metadata so the generated app reads cleanly.",
  },
  {
    id: "draft_missing_sections",
    title: "Draft missing sections",
    description:
      "Create clearly marked draft tiles when a needed explanation, drilldown, or metric is not certified yet.",
  },
  {
    id: "route_review",
    title: "Route review",
    description:
      "Keep generated sections uncertified and attach concrete review tasks before stakeholder use.",
  },
];

export function planAppFromPrompt(input: PlanAppFromPromptInput): AppPlan {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("prompt is required");
  const domain =
    normalizeToken(input.domain) ?? inferDomain(prompt) ?? "general";
  const audience = inferAudience(prompt) ?? inferDefaultAudience(prompt);
  const analysisIntent = inferAnalysisIntent(prompt);
  const appName = titleForPrompt(prompt, inferFallbackName(prompt, domain));
  const appId = suggestAppId(appName);
  const maxCertifiedTiles = input.maxCertifiedTiles ?? 4;
  const preferredNodes = findPreferredCertifiedBlockNodes(
    input.kg,
    input.preferredBlockIds ?? [],
  );
  const matchedNodes = findCertifiedBlockNodes(
    input.kg,
    prompt,
    domain,
    Math.max(maxCertifiedTiles, preferredNodes.length),
  );
  const certifiedNodes = mergeCertifiedBlockNodes(
    preferredNodes,
    matchedNodes,
  ).slice(0, Math.max(maxCertifiedTiles, preferredNodes.length));
  const contextNodes = findCertifiedContextNodes(input.kg, prompt, domain, 6);
  const filters = inferFilters(prompt);

  const certifiedTiles = certifiedNodes.map((node, index) =>
    tileFromCertifiedNode(node, index, analysisIntent),
  );
  const draftTiles = inferDraftTiles(prompt, domain, analysisIntent, certifiedNodes).map(
    (tile, index): AppPlanTile => ({
      id: slugify(tile.title) || `draft-${index + 1}`,
      title: tile.title,
      kind: "draft_placeholder",
      description: tile.description,
      viz: tile.viz,
      certification: "uncertified",
      reviewStatus: "draft_ready",
      display: displayForDraftTile(tile.title, tile.viz, index),
      rationale:
        "No certified block was selected for this generated app section.",
      reviewTasks: [
        "Validate metric definition, grain, filters, and source tables.",
        "Promote to a certified block before treating this tile as governed.",
      ],
    }),
  );

  const narrativeTile: AppPlanTile = {
    id: "business-brief",
    title: "Business brief",
    kind: "narrative",
    description: businessBriefDescription(prompt, audience, analysisIntent),
    viz: "text",
    certification: "uncertified",
    reviewStatus: "review_required",
    display: {
      role: "business_summary",
      recommendedDisplayType: "text",
      layoutPriority: 0,
      expectedGrain: "app",
      trustState: "review_required",
      followUpActions: ["ask_follow_up", "review_trust"],
      rationale:
        "Compact business brief keeps the app goal visible without dominating the dashboard.",
      genUi: buildGenUiContract({
        title: "Business brief",
        role: "business_summary",
        viz: "text",
        text: prompt,
        trustState: "review_required",
        reviewStatus: "review_required",
        followUpActions: ["ask_follow_up", "review_trust"],
        rationale:
          "Compact business brief keeps the app goal visible without dominating the dashboard.",
      }),
    },
    rationale:
      "Narrative text is generated scaffolding and should be reviewed with the app.",
    reviewTasks: [
      "Confirm the audience, business goal, caveats, and review cadence.",
    ],
  };

  return {
    version: 1,
    appId,
    name: appName,
    prompt,
    planning: {
      plannerMode: input.plannerMode ?? "deterministic",
      normalizedGoal: normalizeGoal(prompt),
      analysisIntent,
      audience,
      domain,
      certifiedContext: summarizeCertifiedContext([
        ...certifiedNodes,
        ...contextNodes,
      ]),
      missingEvidence: missingEvidenceForPlan(
        prompt,
        analysisIntent,
        certifiedNodes,
        contextNodes,
      ),
      displayStrategy: displayStrategyForIntent(analysisIntent),
      layoutRationale:
        "Business-first layout: certified KPIs, trends, breakdowns, and evidence tiles only; generated gaps stay in the review backlog until promoted.",
      handoffPlan: [
        "Use certified block tiles as the governed dashboard surface.",
        "Keep generated narrative, trust gaps, and drilldown ideas in the review backlog.",
        "Use app chat and Research to run additional SQL, inspect previews, then pin or promote reviewed results into the app.",
      ],
    },
    skills: APP_BUILDER_SKILLS,
    domain,
    audience,
    businessGoal: prompt,
    owner: input.owner?.trim() || `${process.env.USER ?? "owner"}@local`,
    lifecycle: "draft",
    tags: Array.from(
      new Set([
        "ai-generated-app",
        ...inferTags(prompt, domain),
        `audience:${slugify(audience)}`,
      ]),
    ),
    pages: [
      {
        id: "overview",
        title: inferDashboardTitle(prompt, domain, appName),
        description: `Certified app surface for ${audience}. Draft gaps stay in Research until reviewed.`,
        filters,
        tiles: [narrativeTile, ...certifiedTiles, ...draftTiles],
      },
    ],
    caveats: [
      "Generated app plans are local draft artifacts until reviewed.",
      "Generated dashboards render certified block tiles only; draft and narrative suggestions require analyst review before they become app tiles.",
    ],
    reviewTasks: [
      "Review every backlog item before stakeholder use.",
      "Run dql app build after accepting the generated files.",
      "Use app chat or Research for additional questions, then promote reviewed SQL results to draft or certified blocks.",
    ],
  };
}

export function validateAppPlan(
  plan: AppPlan,
  kg: KGStore,
): AppPlanValidationResult {
  const issues: AppPlanValidationIssue[] = [];
  let certifiedTiles = 0;
  let draftTiles = 0;

  if (plan.version !== 1)
    issues.push(error("version", "unsupported app plan version"));
  if (!plan.appId || !/^[a-z0-9][a-z0-9_-]*$/i.test(plan.appId)) {
    issues.push(error("appId", "appId must be folder-safe"));
  }
  if (!plan.name.trim()) issues.push(error("name", "name is required"));
  if (!plan.domain.trim()) issues.push(error("domain", "domain is required"));
  if (!plan.owner.trim()) issues.push(error("owner", "owner is required"));
  if (plan.pages.length === 0)
    issues.push(error("pages", "at least one page is required"));

  for (const [pageIndex, page] of plan.pages.entries()) {
    if (!page.id.trim())
      issues.push(error(`pages[${pageIndex}].id`, "page id is required"));
    if (page.tiles.length === 0)
      issues.push(warn(`pages[${pageIndex}].tiles`, "page has no tiles"));
    for (const [tileIndex, tile] of page.tiles.entries()) {
      const path = `pages[${pageIndex}].tiles[${tileIndex}]`;
      if (!tile.id.trim())
        issues.push(error(`${path}.id`, "tile id is required"));
      if (!tile.title.trim())
        issues.push(error(`${path}.title`, "tile title is required"));
      if (tile.kind === "certified_block") {
        certifiedTiles += 1;
        if (!tile.blockId) {
          issues.push(
            error(`${path}.blockId`, "certified tile requires blockId"),
          );
          continue;
        }
        const node = kg.getNode(`block:${tile.blockId}`);
        if (!node) {
          issues.push(
            error(
              `${path}.blockId`,
              `certified block not found: ${tile.blockId}`,
            ),
          );
        } else if (node.kind !== "block" || node.status !== "certified") {
          issues.push(
            error(`${path}.blockId`, `block is not certified: ${tile.blockId}`),
          );
        }
        if (
          tile.certification !== "certified" ||
          tile.reviewStatus !== "certified"
        ) {
          issues.push(
            error(path, "certified block tiles must be visibly certified"),
          );
        }
      } else {
        draftTiles += 1;
        if (tile.certification === "certified") {
          issues.push(
            error(path, "non-block generated tiles cannot be marked certified"),
          );
        }
        if (!tile.reviewTasks || tile.reviewTasks.length === 0) {
          issues.push(
            warn(
              `${path}.reviewTasks`,
              "generated tile should include review tasks",
            ),
          );
        }
      }
    }
  }

  if (certifiedTiles === 0) {
    issues.push(
      warn(
        "pages",
        "no certified blocks matched; generated app will contain only draft/review tiles",
      ),
    );
  }

  return {
    ok: issues.every((issue) => issue.level !== "error"),
    issues,
    certifiedTiles,
    draftTiles,
  };
}

export function generateAppFromPlan(
  projectRoot: string,
  plan: AppPlan,
  kg: KGStore,
  options: GenerateAppFromPlanOptions = {},
): GeneratedAppPackage {
  const validation = validateAppPlan(plan, kg);
  const errors = validation.issues.filter((issue) => issue.level === "error");
  if (errors.length > 0) {
    throw new Error(
      `AppPlan is invalid: ${errors.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
    );
  }

  const appDir = join(projectRoot, "apps", plan.appId);
  if (existsSync(appDir) && !options.overwrite) {
    throw new Error(`App already exists: apps/${plan.appId}`);
  }

  const dashboardId = plan.pages[0]?.id || "overview";
  const app: AppDocument = {
    version: 1,
    id: plan.appId,
    name: plan.name,
    description: plan.planning.normalizedGoal,
    businessOutcome: plan.planning.normalizedGoal,
    businessOwner: plan.owner,
    decisionUse: plan.planning.displayStrategy,
    reviewCadence: inferReviewCadence(plan.prompt),
    businessRules: [
      "Certified tiles must reference existing certified blocks.",
    ],
    caveats: plan.caveats,
    visibility: "shared",
    domain: plan.domain,
    audience: plan.audience,
    lifecycle: plan.lifecycle,
    owners: [plan.owner],
    tags: plan.tags,
    members: [
      {
        userId: plan.owner,
        displayName: plan.owner,
        roles: ["owner", "analyst"],
      },
    ],
    roles: [
      {
        id: "owner",
        displayName: "Owner",
        description: "Full access to app configuration and review.",
      },
      {
        id: "analyst",
        displayName: "Analyst",
        description: "Can review generated drafts and run dashboards.",
      },
      {
        id: "viewer",
        displayName: "Viewer",
        description: "Read-only access to reviewed app content.",
      },
    ],
    policies: [
      {
        id: "viewers-read",
        domain: plan.domain,
        minClassification: "internal",
        allowedRoles: ["viewer", "analyst", "owner"],
        accessLevel: "read",
        enabled: true,
      },
      {
        id: "analyst-execute",
        domain: plan.domain,
        minClassification: "internal",
        allowedRoles: ["analyst", "owner"],
        accessLevel: "execute",
        enabled: true,
      },
    ],
    rlsBindings: [],
    schedules: [],
    homepage: { type: "dashboard", id: dashboardId },
  };

  const dashboards = plan.pages.map(
    (page): DashboardDocument => ({
      version: 1,
      id: page.id,
      metadata: {
        title: page.title,
        description: page.description ?? plan.planning.displayStrategy,
        domain: plan.domain,
        audience: plan.audience,
        visibility: "shared",
        lifecycle: "draft",
        tags: plan.tags,
        businessOutcome: plan.planning.normalizedGoal,
        businessOwner: plan.owner,
        decisionUse: plan.planning.displayStrategy,
        reviewCadence: inferReviewCadence(plan.prompt),
        caveats: plan.caveats,
      },
      filters: page.filters.map((filter) => ({
        id: filter.id,
        type: filter.type,
        default: filter.default,
        bindsTo: filter.bindsTo,
      })),
      layout: {
        kind: "grid",
        cols: 12,
        rowHeight: 80,
        items: buildLayoutItems(page.tiles),
      },
    }),
  );

  const appValidation = parseAppDocument(
    JSON.stringify(app),
    join(appDir, "dql.app.json"),
  );
  if (appValidation.errors.length > 0 || !appValidation.document) {
    throw new Error(
      `Generated app is invalid: ${appValidation.errors.map((e) => e.message).join("; ")}`,
    );
  }
  for (const dashboard of dashboards) {
    const parsed = parseDashboardDocument(
      JSON.stringify(dashboard),
      join(appDir, "dashboards", `${dashboard.id}.dqld`),
    );
    if (parsed.errors.length > 0 || !parsed.document) {
      throw new Error(
        `Generated dashboard is invalid: ${parsed.errors.map((e) => e.message).join("; ")}`,
      );
    }
  }

  mkdirSync(join(appDir, "dashboards"), { recursive: true });
  mkdirSync(join(appDir, "notebooks"), { recursive: true });
  mkdirSync(join(appDir, "drafts"), { recursive: true });
  writeFileSync(
    join(appDir, "dql.app.json"),
    JSON.stringify(appValidation.document, null, 2) + "\n",
    "utf-8",
  );
  for (const dashboard of dashboards) {
    writeFileSync(
      join(appDir, "dashboards", `${dashboard.id}.dqld`),
      JSON.stringify(dashboard, null, 2) + "\n",
      "utf-8",
    );
  }
  writeFileSync(
    join(appDir, "README.md"),
    appPlanReadme(plan, validation),
    "utf-8",
  );

  return {
    app: appValidation.document,
    dashboards,
    paths: [
      join(appDir, "dql.app.json"),
      ...dashboards.map((dashboard) =>
        join(appDir, "dashboards", `${dashboard.id}.dqld`),
      ),
      join(appDir, "README.md"),
    ].map((path) => relative(projectRoot, path)),
  };
}

function findCertifiedBlockNodes(
  kg: KGStore,
  prompt: string,
  domain: string,
  limit: number,
): KGNode[] {
  const hits = kg.search({
    query: prompt,
    domain,
    kinds: ["block"],
    limit: limit * 3,
  });
  let nodes = hits
    .map((hit) => hit.node)
    .filter((node) => node.status === "certified");
  if (nodes.length === 0 && domain !== "general") {
    nodes = kg
      .search({ query: prompt, kinds: ["block"], limit: limit * 3 })
      .map((hit) => hit.node)
      .filter((node) => node.status === "certified");
  }
  const seen = new Set<string>();
  return nodes
    .filter((node) => {
      if (seen.has(node.nodeId)) return false;
      seen.add(node.nodeId);
      return true;
    })
    .slice(0, limit);
}

function findPreferredCertifiedBlockNodes(
  kg: KGStore,
  blockIds: string[],
): KGNode[] {
  const seen = new Set<string>();
  const nodes: KGNode[] = [];
  for (const id of blockIds) {
    const clean = id.trim();
    if (!clean) continue;
    const nodeId = clean.startsWith("block:") ? clean : `block:${clean}`;
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    const node = kg.getNode(nodeId);
    if (node?.kind === "block" && node.status === "certified") {
      nodes.push(node);
    }
  }
  return nodes;
}

function mergeCertifiedBlockNodes(
  preferredNodes: KGNode[],
  matchedNodes: KGNode[],
): KGNode[] {
  const seen = new Set<string>();
  const merged: KGNode[] = [];
  for (const node of [...preferredNodes, ...matchedNodes]) {
    if (seen.has(node.nodeId)) continue;
    seen.add(node.nodeId);
    merged.push(node);
  }
  return merged;
}

function findCertifiedContextNodes(
  kg: KGStore,
  prompt: string,
  domain: string,
  limit: number,
): KGNode[] {
  const kinds: KGNode["kind"][] = [
    "business_view",
    "term",
    "metric",
    "semantic_model",
    "saved_query",
    "dbt_model",
    "dbt_source",
  ];
  const search = (withDomain: boolean) =>
    kg.search({
      query: prompt,
      kinds,
      domain: withDomain && domain !== "general" ? domain : undefined,
      limit: limit * 2,
    });
  const hits = search(true);
  const fallbackHits = hits.length === 0 ? search(false) : [];
  const seen = new Set<string>();
  return [...hits, ...fallbackHits]
    .map((hit) => hit.node)
    .filter((node) => {
      if (seen.has(node.nodeId)) return false;
      seen.add(node.nodeId);
      return node.status === "certified" || node.certification === "certified";
    })
    .slice(0, limit);
}

function inferAnalysisIntent(prompt: string): AppPlanAnalysisIntent {
  const lower = prompt.toLowerCase();
  if (/\btrust|certif|lineage|caveat|rely|govern/.test(lower))
    return "trust_review";
  if (/\bwhy|driver|drove|break\s*down|root cause|change|drop|increase|decrease/.test(lower))
    return "driver_analysis";
  if (/\bcustomer|account|player|vendor|merchant|entity|360|profile/.test(lower))
    return "entity_drilldown";
  if (/\bquality|freshness|availability|missing|anomal|monitor/.test(lower))
    return "data_quality";
  if (/\bexperiment|ab test|a\/b|variant|treatment|control/.test(lower))
    return "experiment_readout";
  if (/\bkpi|metric|scorecard|weekly|monthly|quarterly|trend/.test(lower))
    return "metric_monitoring";
  return "executive_summary";
}

function normalizeGoal(prompt: string): string {
  return prompt
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "");
}

function businessBriefDescription(
  prompt: string,
  audience: string,
  intent: AppPlanAnalysisIntent,
): string {
  return [
    `Generated from prompt: ${normalizeGoal(prompt)}.`,
    `Audience: ${audience}.`,
    `Intent: ${titleCase(intent.replace(/_/g, " "))}.`,
    "Use certified tiles as governed evidence; review generated guidance before stakeholder use.",
  ].join("\n\n");
}

function summarizeCertifiedContext(nodes: KGNode[]): AppPlan["planning"]["certifiedContext"] {
  const seen = new Set<string>();
  return nodes
    .filter((node) => {
      if (seen.has(node.nodeId)) return false;
      seen.add(node.nodeId);
      return true;
    })
    .slice(0, 10)
    .map((node) => ({
      nodeId: node.nodeId,
      name: node.name,
      kind: node.kind,
      reason:
        node.decisionUse ??
        node.businessOutcome ??
        node.description ??
        "Matched the app prompt as certified context.",
    }));
}

function missingEvidenceForPlan(
  prompt: string,
  intent: AppPlanAnalysisIntent,
  certifiedNodes: KGNode[],
  contextNodes: KGNode[],
): string[] {
  const lower = prompt.toLowerCase();
  const missing = new Set<string>();
  if (certifiedNodes.length === 0) {
    missing.add("No certified block matched strongly enough for the primary dashboard evidence.");
  }
  if (contextNodes.length === 0) {
    missing.add("No certified business view, term, semantic object, or dbt context was matched for extra explanation.");
  }
  if (intent === "driver_analysis" || /\bwhy|driver|break\s*down/.test(lower)) {
    missing.add("Driver analysis should be opened as review-required Research until a certified drilldown block exists.");
  }
  if (intent === "trust_review" || /\btrust|rely|lineage/.test(lower)) {
    missing.add("Leadership trust checks need lineage, owner, caveats, and review cadence confirmation.");
  }
  if (/\bforecast|predict|what if|plan\b/.test(lower)) {
    missing.add("Forecasting or planning views need explicit reviewed assumptions before certification.");
  }
  return Array.from(missing);
}

function displayStrategyForIntent(intent: AppPlanAnalysisIntent): string {
  switch (intent) {
    case "driver_analysis":
      return "Lead with certified summary evidence, then expose breakdown and Research actions for root-cause analysis.";
    case "entity_drilldown":
      return "Lead with entity context and certified performance blocks, then provide drilldown and trust review paths.";
    case "trust_review":
      return "Lead with certification, lineage, caveats, and review tasks before any generated interpretation.";
    case "data_quality":
      return "Lead with availability/freshness evidence, then list gaps and review actions.";
    case "experiment_readout":
      return "Lead with KPI impact, guardrails, segment readout, and decision caveats.";
    case "metric_monitoring":
      return "Lead with KPIs, trends, and breakdowns for recurring operating review.";
    default:
      return "Lead with the business brief, certified metrics, supporting breakdowns, then trust and Research actions.";
  }
}

function displayForCertifiedNode(
  node: KGNode,
  viz: DashboardVizConfig["type"],
  index: number,
  intent: AppPlanAnalysisIntent,
): NonNullable<AppPlanTile["display"]> {
  const text = [
    node.name,
    node.description,
    node.llmContext,
    ...(node.tags ?? []),
  ]
    .join(" ")
    .toLowerCase();
  const role: AppPlanTileRole =
    viz === "single_value" || viz === "kpi"
      ? "kpi"
      : viz === "line" || viz === "area"
        ? "trend"
        : /\bavailability|freshness|quality|record|records|dataset|lineage|evidence|certification|certified\b/.test(text)
          ? "evidence"
          : /\btop\s*\d+|rank|ranking|leader|leaderboard|scorer|score|goal|segment|breakdown|split|driver|player|customer|account|region|channel\b/.test(text)
          ? "breakdown"
          : "evidence";
  const followUpActions: AppPlanFollowUpAction[] = [
    "ask_follow_up",
    "open_research",
    "review_trust",
  ];
  const rationale =
    node.decisionUse ??
    node.businessOutcome ??
    "Certified block matched the app goal and can anchor the generated dashboard.";
  return {
    role,
    recommendedDisplayType: viz,
    layoutPriority: role === "kpi" ? 10 + index : role === "trend" ? 20 + index : 30 + index,
    expectedGrain: inferExpectedGrain(text, intent),
    trustState: "certified",
    followUpActions,
    rationale,
    genUi: buildGenUiContract({
      title: node.name,
      role,
      viz,
      text,
      trustState: "certified",
      reviewStatus: "certified",
      sourceNodeId: node.nodeId,
      followUpActions,
      rationale,
    }),
  };
}

function displayForDraftTile(
  title: string,
  viz: DashboardVizConfig["type"],
  index: number,
): NonNullable<AppPlanTile["display"]> {
  const lower = title.toLowerCase();
  const role: AppPlanTileRole = /\btrust|caveat|risk|gap|certif/.test(lower)
    ? "trust"
    : /\bresearch|drill|driver|exception/.test(lower)
      ? "research"
      : /\bnarrative|story|decision/.test(lower)
        ? "narrative"
        : "evidence";
  const followUpActions: AppPlanFollowUpAction[] = [
    "open_research",
    "review_trust",
    "create_draft_block",
  ];
  const rationale =
    "Generated section captures missing evidence or review work without implying certification.";
  return {
    role,
    recommendedDisplayType: viz,
    layoutPriority: role === "trust" ? 80 + index : role === "research" ? 70 + index : 60 + index,
    expectedGrain: role === "research" ? "investigation" : "app",
    trustState: "draft_ready",
    followUpActions,
    rationale,
    genUi: buildGenUiContract({
      title,
      role,
      viz,
      text: lower,
      trustState: "draft_ready",
      reviewStatus: "draft_ready",
      followUpActions,
      rationale,
    }),
  };
}

function buildGenUiContract(input: {
  title: string;
  role: AppPlanTileRole;
  viz: DashboardVizConfig["type"];
  text: string;
  trustState: AppPlanTrustState;
  reviewStatus: AppPlanTile["reviewStatus"];
  sourceNodeId?: string;
  followUpActions: AppPlanFollowUpAction[];
  rationale: string;
}): AppPlanGenUi {
  const text = `${input.title} ${input.text}`.toLowerCase();
  const component = componentForPresentation(input.role, input.viz, text);
  return {
    version: 1,
    component,
    role: input.role,
    layoutIntent: layoutIntentForPresentation(input.role, input.viz, component),
    defaultVisualization: input.viz,
    allowedVisualizations: allowedVisualizationsForPresentation(input.role, input.viz, component),
    fieldHints: fieldHintsForPresentation(text, input.viz),
    insightTitle: insightTitleForPresentation(input.title, input.role, component),
    trustState: input.trustState,
    reviewStatus: input.reviewStatus,
    sourceNodeId: input.sourceNodeId,
    followUpActions: input.followUpActions,
    rationale: input.rationale,
  };
}

function componentForPresentation(
  role: AppPlanTileRole,
  viz: DashboardVizConfig["type"],
  text: string,
): AppPlanGenUiComponent {
  if (role === "business_summary") return "BusinessBrief";
  if (role === "trust") return "TrustCallout";
  if (role === "research") return "ResearchActions";
  if (role === "narrative") return "NarrativePanel";
  if (role === "kpi") return "KpiMetric";
  if (role === "trend") return "TrendPanel";
  if (/\btop\s*\d+|rank|ranking|leader|leaderboard|scorer|scoring|score|goal\b/.test(text))
    return "RankingPanel";
  if (viz === "bar" || viz === "grouped_bar" || viz === "stacked_bar")
    return "RankingPanel";
  return "EvidenceTable";
}

function layoutIntentForPresentation(
  role: AppPlanTileRole,
  viz: DashboardVizConfig["type"],
  component: AppPlanGenUiComponent,
): AppPlanLayoutIntent {
  if (role === "business_summary") return "wide";
  if (role === "kpi") return "compact";
  if (component === "RankingPanel" || component === "TrendPanel") return "wide";
  if (component === "EvidenceTable") return viz === "table" || viz === "pivot" ? "standard" : "wide";
  if (role === "trust" || role === "research") return "compact";
  if (role === "narrative") return "standard";
  return "auto";
}

function allowedVisualizationsForPresentation(
  role: AppPlanTileRole,
  viz: DashboardVizConfig["type"],
  component: AppPlanGenUiComponent,
): DashboardVizConfig["type"][] {
  const base = new Set<DashboardVizConfig["type"]>([viz]);
  if (role === "kpi") {
    ["single_value", "kpi", "gauge", "table"].forEach((type) => base.add(type as DashboardVizConfig["type"]));
  } else if (component === "TrendPanel") {
    ["line", "area", "bar", "table"].forEach((type) => base.add(type as DashboardVizConfig["type"]));
  } else if (component === "RankingPanel") {
    ["bar", "table", "donut"].forEach((type) => base.add(type as DashboardVizConfig["type"]));
  } else if (component === "EvidenceTable") {
    ["table", "bar"].forEach((type) => base.add(type as DashboardVizConfig["type"]));
  } else if (component === "TrustCallout" || component === "ResearchActions" || component === "NarrativePanel" || component === "BusinessBrief") {
    base.add("text");
  }
  return Array.from(base);
}

function fieldHintsForPresentation(
  text: string,
  viz: DashboardVizConfig["type"],
): AppPlanGenUi["fieldHints"] | undefined {
  const hints: NonNullable<AppPlanGenUi["fieldHints"]> = {};
  if (/\bplayer|customer|account|vendor|merchant|name\b/.test(text)) hints.label = "name";
  if (/\bscore|scorer|goal|count|total|revenue|arr|amount|rate\b/.test(text)) hints.value = "value";
  if (/\bdate|week|month|quarter|season|time\b/.test(text)) hints.time = "date";
  if (/\brank|top|leader\b/.test(text)) hints.rank = "rank";
  if (viz === "line" || viz === "area") {
    hints.x ??= hints.time ?? "date";
    hints.y ??= hints.value ?? "value";
  } else if (viz === "bar" || viz === "donut" || viz === "pie") {
    hints.x ??= hints.label ?? "category";
    hints.y ??= hints.value ?? "value";
  }
  return Object.keys(hints).length ? hints : undefined;
}

function insightTitleForPresentation(
  title: string,
  role: AppPlanTileRole,
  component: AppPlanGenUiComponent,
): string {
  if (component === "BusinessBrief") return "Business context";
  if (component === "TrustCallout") return "Trust and evidence";
  if (component === "ResearchActions") return "Follow-up research";
  if (role === "kpi") return title;
  if (component === "RankingPanel") return title;
  if (component === "TrendPanel") return title;
  return title;
}

function inferExpectedGrain(text: string, intent: AppPlanAnalysisIntent): string {
  if (/\bcustomer|account|player|merchant|vendor|entity\b/.test(text)) return "entity";
  if (/\bweek|day|month|quarter|season|date|time|trend\b/.test(text)) return "time";
  if (/\bsegment|region|channel|category|product|team\b/.test(text)) return "segment";
  if (intent === "entity_drilldown") return "entity";
  if (intent === "metric_monitoring") return "metric";
  return "dashboard";
}

function tileFromCertifiedNode(
  node: KGNode,
  index: number,
  intent: AppPlanAnalysisIntent,
): AppPlanTile {
  const blockId = node.name;
  const viz = inferVizForNode(node, index);
  return {
    id: slugify(blockId) || `certified-${index + 1}`,
    title: node.name,
    kind: "certified_block",
    description: node.description,
    blockId,
    sourceNodeId: node.nodeId,
    viz,
    certification: "certified",
    reviewStatus: "certified",
    display: displayForCertifiedNode(node, viz, index, intent),
    rationale:
      node.decisionUse ??
      node.businessOutcome ??
      "Certified DQL block matched the app prompt.",
    caveats: node.caveats,
    reviewTasks: [
      "Confirm the block is the intended stakeholder-facing metric for this app.",
    ],
  };
}

function buildLayoutItems(tiles: AppPlanTile[]): DashboardGridItem[] {
  let x = 0;
  let y = 0;
  let rowH = 0;
  const orderedTiles = [...tiles].sort((a, b) => {
    const priorityA = a.display?.layoutPriority ?? 50;
    const priorityB = b.display?.layoutPriority ?? 50;
    return priorityA - priorityB;
  });
  return orderedTiles.map((tile, index) => {
    const size = tileSize(tile);
    if (x + size.w > 12) {
      x = 0;
      y += rowH || size.h;
      rowH = 0;
    }
    const item: DashboardGridItem = {
      i: tile.id || `tile-${index + 1}`,
      x,
      y,
      w: size.w,
      h: size.h,
      title: tile.title,
      viz: {
        type: tile.viz,
        options: {
          dqlGenUi: tile.display?.genUi ?? buildGenUiContract({
            title: tile.title,
            role: tile.display?.role ?? "evidence",
            viz: tile.viz,
            text: `${tile.title} ${tile.description ?? ""}`,
            trustState: tile.display?.trustState ?? (tile.certification === "certified" ? "certified" : "draft_ready"),
            reviewStatus: tile.reviewStatus,
            sourceNodeId: tile.sourceNodeId,
            followUpActions: tile.display?.followUpActions ?? [],
            rationale: tile.display?.rationale ?? tile.rationale ?? "Generated DQL app presentation metadata.",
          }),
        },
      },
    };
    if (isDashboardTile(tile)) {
      item.block = { blockId: tile.blockId };
    } else {
      item.text = { markdown: markdownForGeneratedPlanTile(tile) };
    }
    x += size.w;
    rowH = Math.max(rowH, size.h);
    return item;
  });
}

function markdownForGeneratedPlanTile(tile: AppPlanTile): string {
  const reviewTasks = tile.reviewTasks?.length
    ? tile.reviewTasks.map((task) => `- ${task}`).join("\n")
    : "- Review this generated section before stakeholder use.";
  const caveats = tile.caveats?.length
    ? `\n\nCaveats:\n${tile.caveats.map((caveat) => `- ${caveat}`).join("\n")}`
    : "";
  return [
    `### ${tile.title}`,
    "",
    tile.description ?? tile.rationale ?? "AI-generated app section.",
    "",
    `Trust: ${tile.certification === "certified" ? "certified" : "AI generated / needs review"}`,
    `Review status: ${tile.reviewStatus}`,
    "",
    "Next actions:",
    reviewTasks,
    caveats,
  ].filter(Boolean).join("\n");
}

function isDashboardTile(tile: AppPlanTile): tile is AppPlanTile & {
  kind: "certified_block";
  blockId: string;
} {
  return tile.kind === "certified_block" && tile.certification === "certified" && Boolean(tile.blockId);
}

function appPlanReadme(
  plan: AppPlan,
  validation: AppPlanValidationResult,
): string {
  return [
    `# ${plan.name}`,
    "",
    plan.businessGoal,
    "",
    `- Generated from prompt: ${plan.prompt}`,
    `- Planner mode: ${plan.planning.plannerMode}`,
    `- Analysis intent: ${plan.planning.analysisIntent}`,
    `- Domain: ${plan.domain}`,
    `- Audience: ${plan.audience}`,
    `- Lifecycle: ${plan.lifecycle}`,
    `- Certified tiles: ${validation.certifiedTiles}`,
    `- Review backlog items: ${validation.draftTiles}`,
    "",
    "## Planner brief",
    "",
    `- Goal: ${plan.planning.normalizedGoal}`,
    `- Display strategy: ${plan.planning.displayStrategy}`,
    `- Layout rationale: ${plan.planning.layoutRationale}`,
    "",
    "## Certified context",
    "",
    ...(plan.planning.certifiedContext.length
      ? plan.planning.certifiedContext.map(
          (item) => `- ${item.kind}:${item.name} — ${item.reason}`,
        )
      : ["- No certified context matched strongly enough."]),
    "",
    "## Missing evidence",
    "",
    ...(plan.planning.missingEvidence.length
      ? plan.planning.missingEvidence.map((item) => `- ${item}`)
      : ["- No missing evidence was identified by the deterministic planner."]),
    "",
    "## Review backlog",
    "",
    ...plan.pages.flatMap((page) =>
      page.tiles
        .filter((tile) => !isDashboardTile(tile))
        .map((tile) => `- ${tile.title}: ${tile.description ?? tile.rationale ?? "Review before adding to the app."}`),
    ),
    "",
    "## Agent skills applied",
    "",
    ...plan.skills.map((skill) => `- ${skill.title}: ${skill.description}`),
    "",
    "## Review tasks",
    "",
    ...plan.reviewTasks.map((task) => `- ${task}`),
    "",
    "## Caveats",
    "",
    ...plan.caveats.map((caveat) => `- ${caveat}`),
    "",
  ].join("\n");
}

function inferFallbackName(prompt: string, domain: string): string {
  const lower = prompt.toLowerCase();
  if (/\brevenue|arr|sales|pipeline|growth\b/.test(lower))
    return "Revenue Story";
  if (/\bcustomer|account|churn|retention\b/.test(lower))
    return "Customer Story";
  if (/\bquality|freshness|anomal|monitor\b/.test(lower))
    return "Data Quality Story";
  if (/\bexperiment|ab test|a\/b|readout\b/.test(lower))
    return "Experiment Story";
  return `${titleCase(domain)} App`;
}

function inferDashboardTitle(
  prompt: string,
  domain: string,
  appName: string,
): string {
  const lower = prompt.toLowerCase();
  if (/\boverview|summary|360|review|readout|monitor\b/.test(lower)) {
    return titleCase(
      prompt
        .split(/[.:;]/)[0]
        .replace(/\b(build|create|generate|make|app|dashboard)\b/gi, "")
        .trim(),
    ).slice(0, 64) || "Overview";
  }
  if (domain !== "general") return `${titleCase(domain)} Overview`;
  return appName || "Overview";
}

function inferDefaultAudience(prompt: string): string {
  const lower = prompt.toLowerCase();
  if (lower.includes("executive") || /\bcxo|ceo|cfo|coo|cro\b/.test(lower))
    return "executive team";
  if (lower.includes("sales") || lower.includes("revenue"))
    return "revenue leadership";
  if (lower.includes("customer")) return "customer team";
  if (lower.includes("quality") || lower.includes("platform"))
    return "data team";
  if (lower.includes("product") || lower.includes("experiment"))
    return "product team";
  return "stakeholders";
}

function inferTags(prompt: string, domain: string): string[] {
  const lower = prompt.toLowerCase();
  const tags = new Set<string>(["agent-built", "reviewable", domain]);
  if (/\brevenue|arr|sales|pipeline|growth\b/.test(lower)) tags.add("revenue");
  if (/\bcustomer|account|churn|retention\b/.test(lower)) tags.add("customer");
  if (/\bquality|freshness|anomal|monitor\b/.test(lower)) tags.add("quality");
  if (/\bexperiment|ab test|a\/b|readout\b/.test(lower)) tags.add("experiment");
  if (/\bweekly|week\b/.test(lower)) tags.add("weekly-review");
  if (/\bmonthly|month\b/.test(lower)) tags.add("monthly-review");
  return Array.from(tags).filter(Boolean);
}

function inferDraftTiles(
  prompt: string,
  domain: string,
  intent: AppPlanAnalysisIntent,
  certifiedNodes: KGNode[],
): Array<{
  title: string;
  description: string;
  viz: DashboardVizConfig["type"];
}> {
  const lower = prompt.toLowerCase();
  const domainLabel = titleCase(domain);
  const tiles: Array<{
    title: string;
    description: string;
    viz: DashboardVizConfig["type"];
  }> = [
    {
      title: `${domainLabel} decision story`,
      description:
        "Compact draft explanation of the business story, decision context, and caveats inferred from the prompt.",
      viz: "text",
    },
  ];

  if (intent === "driver_analysis" || /\bwhy|driver|break\s*down|root cause\b/.test(lower)) {
    tiles.push({
      title: "Research drilldowns to review",
      description:
        "Open review-required investigations for drivers, exceptions, segment comparison, and entity drilldown.",
      viz: "table",
    });
  } else if (/\brisk|caveat|issue|anomal|quality\b/.test(lower)) {
    tiles.push({
      title: "Open risks and caveats",
      description:
        "Generated review checklist for risks that need certified evidence before stakeholder use.",
      viz: "table",
    });
  } else if (/\bsegment|cohort|region|location|product|channel|customer\b/.test(lower)) {
    tiles.push({
      title: "Missing drilldowns to certify",
      description:
        "Candidate slices and drilldowns the agent could not fully back with certified blocks yet.",
      viz: "table",
    });
  } else {
    tiles.push({
      title: "Trust and evidence gaps",
      description:
        "Open evidence, lineage, and review tasks to complete before this app is governed.",
      viz: "table",
    });
  }

  if (certifiedNodes.length === 0) {
    tiles.push({
      title: "Certified block search",
      description:
        "No certified blocks matched strongly enough; review suggested sources and create certified blocks.",
      viz: "table",
    });
  }

  if (!tiles.some((tile) => /\btrust|evidence|risk|caveat|gap/.test(tile.title.toLowerCase()))) {
    tiles.push({
      title: "Trust and evidence gaps",
      description:
        "Certification, lineage, caveats, and review actions that must be confirmed before stakeholder use.",
      viz: "table",
    });
  }

  return tiles;
}

function inferDomain(prompt: string): string | undefined {
  const lower = prompt.toLowerCase();
  if (/\brevenue|arr|sales|pipeline|growth\b/.test(lower)) return "growth";
  if (/\bcustomer|account|churn|retention\b/.test(lower)) return "customer";
  if (/\bquality|freshness|anomal|platform\b/.test(lower)) return "data";
  if (/\bexperiment|product\b/.test(lower)) return "product";
  return undefined;
}

function inferAudience(prompt: string): string | undefined {
  const match = prompt.match(
    /\b(?:for|to)\s+(?:the\s+)?([A-Z][A-Za-z0-9 &-]{1,40}|COO|CEO|CFO|CRO|VP[^,.]*)/,
  );
  if (match?.[1]) return match[1].trim();
  const lower = prompt.toLowerCase();
  if (lower.includes("coo")) return "COO";
  if (lower.includes("cfo")) return "CFO";
  if (lower.includes("cro")) return "CRO";
  if (lower.includes("executive")) return "executive team";
  return undefined;
}

function inferFilters(prompt: string): AppPlanFilter[] {
  const filters: AppPlanFilter[] = [];
  const lower = prompt.toLowerCase();
  if (/\bweekly|week|last week|this week\b/.test(lower)) {
    filters.push({
      id: "week",
      label: "Week",
      type: "daterange",
      bindsTo: "date",
    });
  } else if (/\bmonthly|month|quarter|year\b/.test(lower)) {
    filters.push({
      id: "period",
      label: "Period",
      type: "daterange",
      bindsTo: "date",
    });
  }
  if (/\benterprise|segment|smb|mid-market\b/.test(lower)) {
    filters.push({
      id: "segment",
      label: "Segment",
      type: "select",
      bindsTo: "segment",
    });
  }
  return filters;
}

function inferReviewCadence(prompt: string): string {
  const lower = prompt.toLowerCase();
  if (lower.includes("daily")) return "daily";
  if (lower.includes("weekly") || lower.includes("week")) return "weekly";
  if (lower.includes("monthly") || lower.includes("month")) return "monthly";
  if (lower.includes("quarterly") || lower.includes("quarter"))
    return "quarterly";
  return "ad hoc";
}

function titleForPrompt(prompt: string, fallback: string): string {
  const cleaned = prompt
    .replace(/\bfor\s+(?:the\s+)?[A-Z][A-Za-z0-9 &-]{1,40}$/i, "")
    .replace(/\b(build|create|generate|make)\b/gi, "")
    .replace(/\b(a|an|app|dashboard|for|the)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const words = cleaned.split(" ").filter(Boolean).slice(0, 6);
  if (words.length === 0) return fallback;
  return titleCase(words.join(" "));
}

function inferVizForNode(
  node: KGNode,
  index: number,
): DashboardVizConfig["type"] {
  const text = [
    node.name,
    node.description,
    node.llmContext,
    ...(node.tags ?? []),
  ]
    .join(" ")
    .toLowerCase();
  if (/\bavailability|freshness|quality|record|records|dataset|coverage|missing\b/.test(text))
    return "table";
  if (/\btrend|time|week|month|quarter|daily|weekly|monthly\b/.test(text))
    return "line";
  if (/\btop\s*\d+|rank|ranking|leader|leaderboard|scorer|scoring|score|goal\b/.test(text))
    return "bar";
  if (/\btotal|count|rate|score|kpi|arr|revenue\b/.test(text) && index === 0)
    return "single_value";
  if (/\bsegment|region|channel|category|breakdown|split\b/.test(text))
    return "bar";
  return "table";
}

function tileSize(tile: AppPlanTile): { w: number; h: number } {
  const role = tile.display?.role;
  const viz = tile.viz;
  const component = tile.display?.genUi.component;
  const layoutIntent = tile.display?.genUi.layoutIntent;
  if (role === "business_summary") return { w: 12, h: 2 };
  if (component === "RankingPanel") return { w: 8, h: 4 };
  if (component === "EvidenceTable") return { w: layoutIntent === "tall" ? 6 : 4, h: 4 };
  if (role === "trust" || role === "research") return { w: 4, h: 3 };
  if (tile.kind === "narrative") return { w: 12, h: 2 };
  if (viz === "single_value" || viz === "kpi") return { w: 3, h: 2 };
  if (viz === "line" || viz === "area") return { w: 8, h: 4 };
  if (viz === "bar" || viz === "grouped_bar" || viz === "stacked_bar") return { w: 8, h: 4 };
  if (viz === "text") return { w: 6, h: 2 };
  if (viz === "table" || viz === "pivot") return { w: 6, h: 4 };
  return { w: 6, h: 3 };
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .map((word) =>
      word.length <= 3 && word === word.toUpperCase()
        ? word
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join(" ");
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function normalizeToken(input?: string): string | undefined {
  const value = input?.trim().toLowerCase();
  return value || undefined;
}

function error(path: string, message: string): AppPlanValidationIssue {
  return { level: "error", path, message };
}

function warn(path: string, message: string): AppPlanValidationIssue {
  return { level: "warning", path, message };
}
