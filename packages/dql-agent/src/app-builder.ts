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
  | "match_certified_context"
  | "shape_business_story"
  | "draft_missing_sections"
  | "route_review";

export type AppPlanTileKind =
  | "certified_block"
  | "draft_placeholder"
  | "narrative";

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
  const filters = inferFilters(prompt);

  const certifiedTiles = certifiedNodes.map((node, index) =>
    tileFromCertifiedNode(node, index),
  );
  const draftTiles = inferDraftTiles(prompt, domain, certifiedNodes).map(
    (tile, index): AppPlanTile => ({
      id: slugify(tile.title) || `draft-${index + 1}`,
      title: tile.title,
      kind: "draft_placeholder",
      description: tile.description,
      viz: tile.viz,
      certification: "uncertified",
      reviewStatus: "draft_ready",
      rationale:
        "No certified block was selected for this generated app section.",
      reviewTasks: [
        "Validate metric definition, grain, filters, and source tables.",
        "Promote to a certified block before treating this tile as governed.",
      ],
    }),
  );

  const narrativeTile: AppPlanTile = {
    id: "app-context",
    title: "App context",
    kind: "narrative",
    description: `Generated from prompt: ${prompt}`,
    viz: "text",
    certification: "uncertified",
    reviewStatus: "review_required",
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
        description: `Generated app story for ${audience}.`,
        filters,
        tiles: [narrativeTile, ...certifiedTiles, ...draftTiles],
      },
    ],
    caveats: [
      "Generated app plans are local draft artifacts until reviewed.",
      "Certified tiles stay governed; draft and narrative tiles require analyst review.",
    ],
    reviewTasks: [
      "Review every uncertified tile before stakeholder use.",
      "Run dql app build after accepting the generated files.",
      "Promote repeated draft sections to certified blocks when the review is complete.",
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
    description: plan.businessGoal,
    businessOutcome: plan.businessGoal,
    businessOwner: plan.owner,
    decisionUse: `${plan.audience} review`,
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
        description: page.description,
        domain: plan.domain,
        audience: plan.audience,
        visibility: "shared",
        lifecycle: "draft",
        tags: plan.tags,
        businessOutcome: plan.businessGoal,
        businessOwner: plan.owner,
        decisionUse: `${plan.audience} review`,
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

function tileFromCertifiedNode(node: KGNode, index: number): AppPlanTile {
  const blockId = node.name;
  return {
    id: slugify(blockId) || `certified-${index + 1}`,
    title: node.name,
    kind: "certified_block",
    description: node.description,
    blockId,
    sourceNodeId: node.nodeId,
    viz: inferVizForNode(node, index),
    certification: "certified",
    reviewStatus: "certified",
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
  return tiles.map((tile, index) => {
    const size = tileSize(tile.viz, tile.kind);
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
      viz: { type: tile.viz },
      ...(tile.kind === "certified_block" && tile.blockId
        ? { block: { blockId: tile.blockId } }
        : { text: { markdown: markdownForGeneratedTile(tile) } }),
    };
    x += size.w;
    rowH = Math.max(rowH, size.h);
    return item;
  });
}

function markdownForGeneratedTile(tile: AppPlanTile): string {
  const lines = [
    `### ${tile.title}`,
    "",
    tile.description ?? "Generated app section pending analyst review.",
    "",
    `Certification: ${tile.certification}`,
    `Review status: ${tile.reviewStatus}`,
  ];
  if (tile.reviewTasks?.length) {
    lines.push(
      "",
      "Review tasks:",
      ...tile.reviewTasks.map((task) => `- ${task}`),
    );
  }
  return lines.join("\n");
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
    `- Domain: ${plan.domain}`,
    `- Audience: ${plan.audience}`,
    `- Lifecycle: ${plan.lifecycle}`,
    `- Certified tiles: ${validation.certifiedTiles}`,
    `- Draft/review tiles: ${validation.draftTiles}`,
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
      title: `${domainLabel} decision narrative`,
      description:
        "Draft explanation of the business story, decision context, and caveats inferred from the prompt.",
      viz: "text",
    },
  ];

  if (/\brisk|caveat|issue|anomal|quality\b/.test(lower)) {
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
      title: "Evidence gaps to certify",
      description:
        "Open sections where new or extended DQL blocks should be created before this app is governed.",
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
  if (/\btrend|time|week|month|quarter|daily|weekly|monthly\b/.test(text))
    return "line";
  if (/\btotal|count|rate|score|kpi|arr|revenue\b/.test(text) && index === 0)
    return "single_value";
  if (/\bsegment|region|channel|category|breakdown|split\b/.test(text))
    return "bar";
  return "table";
}

function tileSize(
  viz: DashboardVizConfig["type"],
  kind: AppPlanTileKind,
): { w: number; h: number } {
  if (kind === "narrative") return { w: 12, h: 2 };
  if (viz === "single_value" || viz === "kpi") return { w: 3, h: 2 };
  if (viz === "text") return { w: 6, h: 3 };
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
