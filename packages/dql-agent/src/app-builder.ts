import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  parseAppDocument,
  parseDashboardDocument,
  suggestAppId,
  type AppDocument,
  type DashboardDisplayMetadata,
  type DashboardDocument,
  type DashboardSection,
  type DashboardTileFilterBinding,
  type DashboardTileParameterBinding,
  type DashboardTileSourceEvidence,
  type DashboardGridItem,
  type DashboardVizConfig,
} from "@duckcodeailabs/dql-core";
import type { KGNode } from "./kg/types.js";
import type { KGStore } from "./kg/sqlite-fts.js";
import type { NarrateResult } from "./narrate.js";

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
  | "PivotTable"
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
  type: "date" | "daterange" | "select" | "string" | "number";
  default?: unknown;
  options?: string[];
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
  filterBindings?: DashboardTileFilterBinding[];
  parameterBindings?: DashboardTileParameterBinding[];
  sourceEvidence?: DashboardTileSourceEvidence[];
  trustState?: AppPlanTrustState;
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

export interface AppPlanSection {
  id: string;
  title: string;
  purpose: string;
  reviewStatus: "certified" | "draft_ready" | "review_required";
}

export interface AppPlanScopedReport {
  id: string;
  title: string;
  question: string;
  description: string;
  intent: AppPlanAnalysisIntent | "proof_review";
  reviewStatus: "draft_ready" | "review_required";
  source: "app_builder";
  evidenceNeeded: string[];
  suggestedActions: AppPlanFollowUpAction[];
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
    scopedReports: AppPlanScopedReport[];
    displayStrategy: string;
    layoutRationale: string;
    handoffPlan: string[];
  };
  skills: AppBuilderSkill[];
  domain: string;
  audience: string;
  businessGoal: string;
  stakeholderSummary: string;
  owner: string;
  lifecycle: "draft" | "review";
  tags: string[];
  appSections: AppPlanSection[];
  globalFilters: AppPlanFilter[];
  selectedEvidence: Array<{
    source: string;
    reason: string;
    kind?: string;
    nodeId?: string;
    trustState: AppPlanTrustState;
  }>;
  missingEvidence: string[];
  scopedReports: AppPlanScopedReport[];
  pages: AppPlanPage[];
  caveats: string[];
  reviewTasks: string[];
  /** Plan-preview summary: how much of the app is certified vs. left as gaps. */
  coverage: {
    certifiedTiles: number;
    gaps: number;
    ratio: number;
  };
}

export interface PlanAppFromPromptInput {
  prompt: string;
  kg: KGStore;
  domain?: string;
  audience?: string;
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
  /** Story narration (from `narrateResult`) — when present, the first dashboard is
   *  written as a narrated story layout: exec-summary section + KPI band + insight
   *  sections + review appendix, with real numbers in the prose. */
  narration?: NarrateResult;
  /** Suggested questions for the app copilot (e.g. uncovered analysis gaps). */
  copilotQuestions?: string[];
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
    title: "Scope report gaps",
    description:
      "Turn missing explanations, drilldowns, and metrics into scoped analyst reports instead of dashboard placeholders.",
  },
  {
    id: "route_review",
    title: "Route review",
    description:
      "Keep generated analysis review-required and attach concrete next steps before stakeholder use.",
  },
];

export function planAppFromPrompt(input: PlanAppFromPromptInput): AppPlan {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("prompt is required");
  const domain =
    normalizeToken(input.domain) ?? inferDomain(prompt) ?? "general";
  const audience = input.audience?.trim() || inferAudience(prompt) || inferDefaultAudience(prompt);
  const analysisIntent = inferAnalysisIntent(prompt);
  const appName = titleForPrompt(prompt, inferFallbackName(prompt, domain));
  const appId = suggestAppId(appName);
  const maxCertifiedTiles = input.maxCertifiedTiles ?? 4;
  const targetCertifiedTiles = Math.max(maxCertifiedTiles, input.preferredBlockIds?.length ?? 0);
  const preferredNodes = findPreferredCertifiedBlockNodes(
    input.kg,
    input.preferredBlockIds ?? [],
  );
  const matchedNodes = findCertifiedBlockNodes(
    input.kg,
    prompt,
    domain,
    Math.max(targetCertifiedTiles * 3, preferredNodes.length),
  );
  const certifiedNodes = dedupeCertifiedBlockNodes(
    mergeCertifiedBlockNodes(preferredNodes, matchedNodes),
    new Set(preferredNodes.map((node) => node.nodeId)),
  ).slice(0, targetCertifiedTiles);
  const contextNodes = findCertifiedContextNodes(input.kg, prompt, domain, 6);
  // Bind the global filter bar to what the certified tiles actually accept (their
  // declared allowedFilters), not prompt words — falling back to prompt inference
  // only when no tile declares any filter. Keeps the dashboard's filters dynamic.
  const promptFilters = inferFilters(prompt);
  const blockFilters = filtersFromCertifiedNodes(certifiedNodes);
  const filters = blockFilters.length > 0 ? mergeAppFilters(blockFilters, promptFilters) : promptFilters;

  const certifiedTiles = certifiedNodes.map((node, index) =>
    tileFromCertifiedNode(node, index, analysisIntent, filters),
  );
  const scopedReports = inferScopedReports(
    prompt,
    domain,
    analysisIntent,
    certifiedNodes,
  );

  const certifiedContextSummary = summarizeCertifiedContext([
    ...certifiedNodes,
    ...contextNodes,
  ]);
  const missingEvidence = Array.from(new Set([
    ...missingEvidenceForPlan(
      prompt,
      analysisIntent,
      certifiedNodes,
      contextNodes,
    ),
    ...scopedReports.map((report) => `${report.title}: ${report.description}`),
  ]));
  const stakeholderSummary = stakeholderSummaryForPlan({
    prompt,
    appName,
    audience,
    domain,
    analysisIntent,
    certifiedTiles: certifiedTiles.length,
    scopedReports: scopedReports.length,
    certifiedNames: certifiedNodes.map((node) => node.name),
    filterLabels: filters.map((filter) => filter.label),
  });

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
      certifiedContext: certifiedContextSummary,
      missingEvidence,
      scopedReports,
      displayStrategy: displayStrategyForIntent(analysisIntent),
      layoutRationale:
        "Business-first layout: certified KPIs, trends, breakdowns, and proof-backed tiles only; generated gaps stay as scoped analysis memos until promoted.",
      handoffPlan: [
        "Use certified block tiles as the governed dashboard surface.",
        "Keep generated narrative, trust gaps, and drilldown ideas as scoped analysis memos until reviewed.",
        "Use app Copilot analysis to run additional SQL, inspect previews, then pin or promote reviewed results into the app.",
      ],
    },
    skills: APP_BUILDER_SKILLS,
    domain,
    audience,
    businessGoal: prompt,
    stakeholderSummary,
    owner: input.owner?.trim() || `${process.env.USER ?? "owner"}@local`,
    lifecycle: "draft",
    tags: Array.from(
      new Set([
        "ai-generated-app",
        ...inferTags(prompt, domain),
        `audience:${slugify(audience)}`,
      ]),
    ),
    appSections: [
      {
        id: "dashboard",
        title: "Stakeholder view",
        purpose: "Clean dashboard pages backed by certified blocks and active filters.",
        reviewStatus: certifiedTiles.length > 0 ? "certified" : "draft_ready",
      },
      {
        id: "research",
        title: "Analysis",
        purpose: "Review-required analyst memos for follow-up questions that need new SQL or deeper analysis.",
        reviewStatus: "draft_ready",
      },
    ],
    globalFilters: filters,
    selectedEvidence: certifiedContextSummary.map((item) => ({
      source: `${item.kind}:${item.name}`,
      reason: item.reason,
      kind: item.kind,
      nodeId: item.nodeId,
      trustState: "certified" as const,
    })),
    missingEvidence,
    scopedReports,
    pages: [
      {
        id: "overview",
        title: inferDashboardTitle(prompt, domain, appName),
        description: `Certified app surface for ${audience}. Draft gaps stay in reports until reviewed.`,
        filters,
        tiles: certifiedTiles,
      },
    ],
    caveats: [
      "Generated app plans are local draft artifacts until reviewed.",
        "Generated dashboards render certified block tiles only; draft narrative, proof, and analysis suggestions stay as scoped memos, Copilot answers, or promoted reviewed insights.",
    ],
    reviewTasks: [
      "Review every scoped analysis memo before stakeholder use.",
      ...scopedReports.map((report) =>
        `Run scoped analysis "${report.title}" from app Copilot with the stakeholder question and active filters, then pin or promote only after review.`,
      ),
      "Run dql app build after accepting the generated files.",
      "Use app Copilot analysis for additional questions, then promote reviewed SQL results to draft or certified blocks.",
    ],
    coverage: {
      certifiedTiles: certifiedTiles.length,
      gaps: scopedReports.length,
      ratio:
        certifiedTiles.length + scopedReports.length > 0
          ? certifiedTiles.length / (certifiedTiles.length + scopedReports.length)
          : 0,
    },
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
        issues.push(
          error(
            path,
            "stakeholder dashboard tiles must be certified blocks; route generated story, trust, and analysis work through scoped reports or Copilot investigations",
          ),
        );
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
        "no certified blocks matched; generated dashboard has no governed result tiles yet",
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

  const appDir = resolveAppPackageDir(projectRoot, plan.domain, plan.appId);
  if (existsSync(appDir) && !options.overwrite) {
    throw new Error(`App already exists: ${relative(projectRoot, appDir)}`);
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
    ...(options.copilotQuestions?.length
      ? { copilot: { suggestedQuestions: options.copilotQuestions.slice(0, 8) } }
      : {}),
  };

  const dashboards = plan.pages.map(
    (page, pageIndex): DashboardDocument => ({
      version: 1,
      id: page.id,
      // Story layout on the primary page when a narration was supplied.
      ...(options.narration && pageIndex === 0
        ? { sections: buildStorySections(page.tiles, options.narration) }
        : {}),
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
        ...(filter.options?.length ? { options: filter.options } : {}),
        bindsTo: filter.bindsTo,
      })),
      layout: {
        kind: "grid",
        cols: 12,
        rowHeight: 80,
        items: options.narration && pageIndex === 0
          ? buildStoryLayoutItems(page.tiles, options.narration)
          : buildLayoutItems(page.tiles),
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

function dedupeCertifiedBlockNodes(
  nodes: KGNode[],
  preferredNodeIds = new Set<string>(),
): KGNode[] {
  const selected: KGNode[] = [];
  const signatureIndex = new Map<string, number>();

  for (const node of nodes) {
    const signatures = certifiedBlockDuplicateSignatures(node);
    let duplicateIndex = -1;
    for (const signature of signatures) {
      const existing = signatureIndex.get(signature);
      if (existing !== undefined) {
        duplicateIndex = existing;
        break;
      }
    }

    if (duplicateIndex < 0) {
      signatureIndex.set(node.nodeId, selected.length);
      for (const signature of signatures) signatureIndex.set(signature, selected.length);
      selected.push(node);
      continue;
    }

    const current = selected[duplicateIndex];
    if (certifiedBlockSelectionScore(node, preferredNodeIds) > certifiedBlockSelectionScore(current, preferredNodeIds)) {
      selected[duplicateIndex] = node;
      signatureIndex.set(node.nodeId, duplicateIndex);
      for (const signature of signatures) signatureIndex.set(signature, duplicateIndex);
    }
  }

  return selected;
}

function certifiedBlockDuplicateSignatures(node: KGNode): string[] {
  const signatures = new Set<string>([node.nodeId]);
  if (node.sqlFingerprints?.exact) signatures.add(`sql:${node.sqlFingerprints.exact}`);
  if (node.sqlFingerprints?.parameterized) signatures.add(`sqlp:${node.sqlFingerprints.parameterized}`);
  if (node.businessFingerprint?.hash) signatures.add(`business:${node.businessFingerprint.hash}`);
  const topic = certifiedBlockTopicSignature(node);
  if (topic) signatures.add(`topic:${topic}`);
  return Array.from(signatures);
}

function certifiedBlockTopicSignature(node: KGNode): string {
  const text = [
    node.name,
    node.description,
    node.llmContext,
    node.businessOutcome,
    node.decisionUse,
    node.grain,
    ...(node.tags ?? []),
    ...(node.entities ?? []),
    ...(node.declaredOutputs ?? []),
    ...(node.dimensions ?? []),
    ...(node.allowedFilters ?? []),
    ...(node.businessFingerprint?.tokens ?? []),
  ].join(" ").toLowerCase();
  const sources = normalizedTopicTokens([
    ...(node.sourceSystems ?? []),
    ...(node.businessFingerprint?.tokens ?? [])
      .filter((token) => /^(source|system):/i.test(token))
      .map((token) => token.replace(/^(source|system):/i, "")),
    ...Array.from(text.matchAll(/\b(?:from|join)\s+([a-z0-9_.]+)/gi)).map((match) => match[1]),
    ...Array.from(text.matchAll(/\b([a-z0-9_]*int_player_stats|[a-z0-9_]*fct_[a-z0-9_]+|[a-z0-9_]*dim_[a-z0-9_]+)\b/gi)).map((match) => match[1]),
  ]);
  const entity = firstTopicFamily(text, [
    ["player", /\b(player|players|scorer|scorers|athlete)\b/],
    ["customer", /\b(customer|account|user|subscriber)\b/],
    ["order", /\b(order|orders|purchase)\b/],
    ["product", /\b(product|sku|item)\b/],
    ["team", /\b(team|teams)\b/],
  ]);
  const intent = firstTopicFamily(text, [
    ["availability", /\b(availability|freshness|record count|records|quality|coverage)\b/],
    ["ranking", /\b(top|bottom|rank|ranking|leader|leaderboard|scorer|scorers)\b/],
    ["trend", /\b(trend|weekly|monthly|daily|time series|over time)\b/],
    ["segment", /\b(segment|breakdown|split|by segment|cohort|region|channel)\b/],
    ["profile", /\b(profile|360|detail|drilldown)\b/],
    ["kpi", /\b(kpi|metric|total|summary|scorecard)\b/],
  ]);
  const metric = firstTopicFamily(text, [
    ["points", /\b(point|points|pts|score|scoring|scorer|scorers)\b/],
    ["revenue", /\b(revenue|arr|sales|amount|bookings)\b/],
    ["count", /\b(count|records|games played|orders|users)\b/],
    ["quality", /\b(availability|freshness|quality|coverage)\b/],
    ["conversion", /\b(conversion|rate|pct|percent|ratio)\b/],
  ]);
  if (!sources.length || !intent || !metric) return "";
  return [sources.slice(0, 3).join("+"), entity, intent, metric].filter(Boolean).join("|");
}

function normalizedTopicTokens(values: string[]): string[] {
  return Array.from(new Set(values
    .map((value) => value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, ""))
    .map((value) => value
      .replace(/^.*\./, "")
      .replace(/^transformed_/, "")
      .replace(/^nba_analytics_/, ""))
    .filter(Boolean)))
    .sort();
}

function firstTopicFamily(text: string, patterns: Array<[string, RegExp]>): string {
  return patterns.find(([, pattern]) => pattern.test(text))?.[0] ?? "";
}

function certifiedBlockSelectionScore(node: KGNode, preferredNodeIds: Set<string>): number {
  let score = preferredNodeIds.has(node.nodeId) ? 10000 : 0;
  score += (node.declaredOutputs?.length ?? 0) * 70;
  score += (node.allowedFilters?.length ?? 0) * 45;
  score += (node.parameterPolicy?.length ?? 0) * 45;
  score += (node.entities?.length ?? 0) * 35;
  score += (node.businessFingerprint?.tokens?.length ?? 0) * 8;
  if (node.grain) score += 90;
  if (node.pattern) score += 60;
  if (node.sqlFingerprints?.parameterized) score += 40;
  if (node.description && node.description.length > 80) score += 25;
  const text = [node.name, node.description, node.llmContext, ...(node.tags ?? [])].join(" ").toLowerCase();
  if (/\b(raw-sql|imported|codex-e2e|test)\b/.test(text)) score -= 80;
  if (/\breview required\b/.test(text)) score -= 10;
  return score;
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

function stakeholderSummaryForPlan(input: {
  prompt: string;
  appName: string;
  audience: string;
  domain: string;
  analysisIntent: AppPlanAnalysisIntent;
  certifiedTiles: number;
  scopedReports: number;
  certifiedNames?: string[];
  filterLabels?: string[];
}): string {
  // Ground the narrative in the actual certified blocks + filter bar — the assets the
  // app is built on — not just the prompt echo.
  const built = input.certifiedNames && input.certifiedNames.length > 0
    ? ` Built on ${input.certifiedNames.slice(0, 3).join(", ")}${input.certifiedNames.length > 3 ? ", …" : ""}.`
    : "";
  const coverage = input.certifiedTiles > 0
    ? `${input.certifiedTiles} certified tile${input.certifiedTiles === 1 ? "" : "s"} anchor the app.`
    : "No certified tiles matched strongly enough yet.";
  const filterLine = input.filterLabels && input.filterLabels.length > 0
    ? ` One filter set — ${input.filterLabels.slice(0, 4).join(", ")} — refreshes every tile that shares it.`
    : "";
  const review = input.scopedReports > 0
    ? `${input.scopedReports} scoped analysis memo${input.scopedReports === 1 ? "" : "s"} capture questions that need deeper review.`
    : "No scoped analysis memos were needed.";
  return `${input.appName} is a ${titleCase(input.domain)} decision room for ${input.audience}.${built} ${coverage}${filterLine} ${review} Intent: ${titleCase(input.analysisIntent.replace(/_/g, " "))}.`;
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
    missing.add("No certified block matched strongly enough for the primary dashboard proof.");
  }
  if (contextNodes.length === 0) {
    missing.add("No certified business view, term, semantic object, or dbt context was matched for supporting explanation.");
  }
  if (intent === "driver_analysis" || /\bwhy|driver|break\s*down/.test(lower)) {
    missing.add("Driver analysis should be opened as a review-required report until a certified drilldown block exists.");
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
      return "Lead with certified summary proof, then route root-cause questions into Copilot reports.";
    case "entity_drilldown":
      return "Lead with entity context and certified performance blocks, then provide drilldown and trust review paths.";
    case "trust_review":
      return "Lead with certification, lineage, caveats, and review tasks before any generated interpretation.";
    case "data_quality":
      return "Lead with availability and freshness proof, then list gaps and review actions.";
    case "experiment_readout":
      return "Lead with KPI impact, guardrails, segment readout, and decision caveats.";
    case "metric_monitoring":
      return "Lead with KPIs, trends, and breakdowns for recurring operating review.";
    default:
      return "Lead with the business brief, certified metrics, supporting breakdowns, then proof and report paths.";
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
          : "breakdown";
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
    "Generated section captures missing proof or review work without implying certification.";
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
  if (viz === "pivot") return "PivotTable";
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
  if (component === "PivotTable") return "standard";
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
  } else if (component === "PivotTable") {
    ["pivot", "table", "bar"].forEach((type) => base.add(type as DashboardVizConfig["type"]));
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
  if (component === "TrustCallout") return "Proof and lineage";
  if (component === "ResearchActions") return "Follow-up analysis";
  if (role === "kpi") return title;
  if (component === "RankingPanel") return title;
  if (component === "TrendPanel") return title;
  if (component === "PivotTable") return title;
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
  globalFilters: AppPlanFilter[] = [],
): AppPlanTile {
  const blockId = node.name;
  const viz = inferVizForNode(node, index);
  const filterBindings = filterBindingsForCertifiedNode(node, globalFilters);
  const parameterBindings = parameterBindingsForCertifiedNode(node, filterBindings);
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
    trustState: "certified",
    ...(filterBindings.length ? { filterBindings } : {}),
    ...(parameterBindings.length ? { parameterBindings } : {}),
    sourceEvidence: [{
      source: node.nodeId,
      reason:
        node.decisionUse ??
        node.businessOutcome ??
        node.description ??
        "Certified DQL block matched the app prompt.",
      kind: node.kind,
      nodeId: node.nodeId,
      path: node.sourcePath,
      trustState: "certified",
    }],
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

function filterBindingsForCertifiedNode(
  node: KGNode,
  globalFilters: AppPlanFilter[],
): DashboardTileFilterBinding[] {
  const bindings: DashboardTileFilterBinding[] = (node.filterBindings ?? []).map((entry) => ({
    filter: entry.filter,
    binding: entry.binding,
    mode: "predicate" as const,
  }));
  const dynamicParams = new Set(
    (node.parameterPolicy ?? [])
      .filter((entry) => entry.policy === "dynamic")
      .map((entry) => entry.name),
  );
  const allowedFilters = new Set((node.allowedFilters ?? []).map((entry) => entry.toLowerCase()));
  for (const filter of globalFilters) {
    if (bindings.some((entry) => entry.filter === filter.id)) continue;
    if (dynamicParams.has(filter.id)) {
      bindings.push({
        filter: filter.id,
        binding: filter.bindsTo ?? filter.id,
        mode: "parameter",
        paramNames: [filter.id],
      });
      continue;
    }
    const matchingParam = parameterForFilter(filter, dynamicParams);
    if (matchingParam) {
      bindings.push({
        filter: filter.id,
        binding: filter.bindsTo ?? matchingParam,
        mode: "parameter",
        paramNames: [matchingParam],
      });
      continue;
    }
    if (filter.bindsTo && allowedFilters.has(filter.bindsTo.toLowerCase())) {
      bindings.push({
        filter: filter.id,
        binding: filter.bindsTo,
        mode: "predicate",
      });
      continue;
    }
    if (filter.id && allowedFilters.has(filter.id.toLowerCase())) {
      bindings.push({
        filter: filter.id,
        binding: filter.bindsTo ?? filter.id,
        mode: "predicate",
      });
      continue;
    }
    if (filter.id) {
      bindings.push({
        filter: filter.id,
        binding: filter.bindsTo,
        unsupportedReason: "No matching certified block parameter or allowed filter was declared.",
      });
    }
  }
  return uniqueTileFilterBindings(bindings);
}

function parameterBindingsForCertifiedNode(
  node: KGNode,
  filterBindings: DashboardTileFilterBinding[],
): DashboardTileParameterBinding[] {
  const dynamicParams = (node.parameterPolicy ?? [])
    .filter((entry) => entry.policy === "dynamic")
    .map((entry) => entry.name);
  return dynamicParams.map((param) => {
    const filterBinding = filterBindings.find((entry) => entry.paramNames?.includes(param) || entry.filter === param);
    return {
      param,
      source: filterBinding ? "dashboard_filter" as const : "variable" as const,
      ...(filterBinding?.filter ? { filter: filterBinding.filter } : {}),
      field: filterBinding?.binding ?? param,
    };
  });
}

function parameterForFilter(filter: AppPlanFilter, dynamicParams: Set<string>): string | null {
  const candidates: string[] = [];
  if (filter.id === "season") candidates.push("season", "season_year", "year");
  if (filter.id === "season_start") candidates.push("season_start", "start_year", "from_year");
  if (filter.id === "season_end") candidates.push("season_end", "end_year", "to_year");
  if (filter.id === "top_n") candidates.push("top_n", "limit", "n");
  candidates.push(filter.id);
  return candidates.find((candidate) => dynamicParams.has(candidate)) ?? null;
}

function uniqueTileFilterBindings(bindings: DashboardTileFilterBinding[]): DashboardTileFilterBinding[] {
  const seen = new Set<string>();
  const out: DashboardTileFilterBinding[] = [];
  for (const binding of bindings) {
    const key = `${binding.filter}:${binding.binding ?? ""}:${binding.mode ?? ""}:${(binding.paramNames ?? []).join(",")}:${binding.unsupportedReason ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(binding);
  }
  return out;
}

/** Which story section a plan tile belongs to. KPI-shaped proof leads; gaps land
 *  in the appendix; everything else is a narrated insight. */
function storySectionForTile(tile: AppPlanTile): DashboardSection["kind"] {
  if (tile.kind === "draft_placeholder") return "appendix";
  const role = tile.display?.genUi?.role ?? tile.display?.role;
  if (role === "kpi" || tile.viz === "single_value" || tile.viz === "kpi" || tile.viz === "gauge") {
    return "kpi_band";
  }
  return "insight";
}

/** The narrated story sections for the primary dashboard page. Only sections that
 *  actually have content are emitted; the appendix also hosts AI-generated tiles
 *  the commit step attaches. */
function buildStorySections(tiles: AppPlanTile[], narration: NarrateResult): DashboardSection[] {
  const kinds = new Set(tiles.filter(isDashboardTile).map(storySectionForTile));
  const sections: DashboardSection[] = [
    {
      id: "exec_summary",
      title: "Executive summary",
      kind: "exec_summary",
      narrative: narration.summary,
      order: 0,
    },
  ];
  if (kinds.has("kpi_band")) {
    sections.push({ id: "kpi_band", title: "Key metrics", kind: "kpi_band", order: 1 });
  }
  if (kinds.has("insight")) {
    sections.push({
      id: "insight",
      title: "What the data shows",
      kind: "insight",
      narrative: narration.recommendation,
      order: 2,
    });
  }
  if (kinds.has("appendix")) {
    sections.push({
      id: "appendix",
      title: "AI-generated analysis — needs review",
      kind: "appendix",
      order: 3,
    });
  }
  return sections;
}

/** Full-width narrated exec-summary tile: the story's opening, with real numbers
 *  from executed results (the deterministic narrate fallback guarantees this offline). */
function execSummaryStoryTile(narration: NarrateResult): DashboardGridItem {
  const lines = [narration.summary.trim()];
  if (narration.keyFindings.length > 0) {
    lines.push("", ...narration.keyFindings.slice(0, 4).map((finding) => `- ${finding}`));
  }
  if (narration.recommendation) {
    lines.push("", `**Next:** ${narration.recommendation}`);
  }
  return {
    i: "story-exec-summary",
    x: 0,
    y: 0,
    w: 12,
    h: 3,
    text: { markdown: lines.join("\n") },
    viz: { type: "table" },
    title: "Executive summary",
    sectionId: "exec_summary",
  };
}

/** Story variant of the grid layout: same tiles + positions, tagged by section and
 *  led by the narrated exec-summary tile. The renderer groups by section. */
function buildStoryLayoutItems(tiles: AppPlanTile[], narration: NarrateResult): DashboardGridItem[] {
  const dashboardTiles = tiles.filter(isDashboardTile);
  const sectionById = new Map<string, DashboardSection["kind"]>(
    dashboardTiles.map((tile) => [tile.id, storySectionForTile(tile)]),
  );
  const items = buildLayoutItems(tiles).map((item) => ({
    ...item,
    sectionId: sectionById.get(item.i) ?? "insight",
  }));
  return [execSummaryStoryTile(narration), ...items];
}

function buildLayoutItems(tiles: AppPlanTile[]): DashboardGridItem[] {
  let x = 0;
  let y = 0;
  let rowH = 0;
  const orderedTiles = [...tiles].filter(isDashboardTile).sort((a, b) => {
    const priorityA = a.display?.layoutPriority ?? 50;
    const priorityB = b.display?.layoutPriority ?? 50;
    return priorityA - priorityB;
  });
  return orderedTiles.map((tile, index) => {
    const size = tileSize(tile);
    const genUi = tile.display?.genUi ?? buildGenUiContract({
      title: tile.title,
      role: tile.display?.role ?? "evidence",
      viz: tile.viz,
      text: `${tile.title} ${tile.description ?? ""}`,
      trustState: tile.display?.trustState ?? (tile.certification === "certified" ? "certified" : "draft_ready"),
      reviewStatus: tile.reviewStatus,
      sourceNodeId: tile.sourceNodeId,
      followUpActions: tile.display?.followUpActions ?? [],
      rationale: tile.display?.rationale ?? tile.rationale ?? "Generated DQL app presentation metadata.",
    });
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
          dqlGenUi: genUi,
        },
      },
      display: displayMetadataForTile(tile, genUi),
      ...(tile.filterBindings?.length ? { filterBindings: tile.filterBindings } : {}),
      ...(tile.parameterBindings?.length ? { parameterBindings: tile.parameterBindings } : {}),
      ...(tile.sourceEvidence?.length ? { sourceEvidence: tile.sourceEvidence } : {}),
      trustState: tile.trustState ?? tile.display?.trustState ?? (tile.certification === "certified" ? "certified" : "draft_ready"),
      reviewStatus: tile.reviewStatus,
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
  const reviewDashboardItems = plan.pages.flatMap((page) =>
    page.tiles
      .filter((tile) => !isDashboardTile(tile))
      .map((tile) => `- ${tile.title}: ${tile.description ?? tile.rationale ?? "Review before adding to the app."}`),
  );
  const scopedReports = plan.scopedReports.length > 0
    ? plan.scopedReports.map((report) => [
        `- ${report.title}: ${report.description}`,
        `  - Question: ${report.question}`,
        `  - Evidence needed: ${report.evidenceNeeded.join(", ")}`,
      ].join("\n"))
    : reviewDashboardItems.length > 0
      ? reviewDashboardItems
    : plan.missingEvidence.length > 0
      ? plan.missingEvidence.map((item) => `- ${item}`)
      : ["- No scoped analysis memos were suggested. Use app Copilot for follow-up questions."];
  return [
    `# ${plan.name}`,
    "",
    plan.stakeholderSummary,
    "",
    plan.businessGoal,
    "",
    `- Generated from prompt: ${plan.prompt}`,
    `- Planner mode: ${plan.planning.plannerMode}`,
    `- Analysis intent: ${plan.planning.analysisIntent}`,
    `- Domain: ${plan.domain}`,
    `- Audience: ${plan.audience}`,
    `- Lifecycle: ${plan.lifecycle}`,
    `- Certified dashboard tiles: ${validation.certifiedTiles}`,
    `- Review-required dashboard tiles: ${validation.draftTiles}`,
    `- Scoped analysis memos: ${plan.scopedReports.length}`,
    `- Global filters: ${plan.globalFilters.map((filter) => filter.id).join(", ") || "none"}`,
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
    "## Missing proof",
    "",
    ...(plan.planning.missingEvidence.length
      ? plan.planning.missingEvidence.map((item) => `- ${item}`)
      : ["- No missing proof was identified by the deterministic planner."]),
    "",
    "## Scoped analysis memos",
    "",
    ...scopedReports,
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

function inferScopedReports(
  prompt: string,
  domain: string,
  intent: AppPlanAnalysisIntent,
  certifiedNodes: KGNode[],
): AppPlanScopedReport[] {
  const lower = prompt.toLowerCase();
  const domainLabel = titleCase(domain);
  const reports: Array<{
    title: string;
    description: string;
    question: string;
    intent: AppPlanScopedReport["intent"];
    evidenceNeeded: string[];
  }> = [
    {
      title: `${domainLabel} decision story report`,
      question: `What is the decision story behind "${normalizeGoal(prompt)}"?`,
      description:
        "Analyst narrative that ties certified results to the business decision, caveats, and recommended next action.",
      intent,
      evidenceNeeded: ["certified block results", "active filters", "lineage and owner context"],
    },
  ];

  if (intent === "driver_analysis" || /\bwhy|driver|break\s*down|root cause\b/.test(lower)) {
    reports.push({
      title: "Driver analysis report",
      question: "Which drivers, segments, or entities explain the movement?",
      description:
        "Review-required report for drivers, exceptions, segment comparison, and entity drilldown.",
      intent: "driver_analysis",
      evidenceNeeded: ["comparison period", "segment fields", "metric definition", "previewed SQL"],
    });
  } else if (/\brisk|caveat|issue|anomal|quality\b/.test(lower)) {
    reports.push({
      title: "Risk and caveat report",
      question: "Which caveats or quality risks should stakeholders understand before using this app?",
      description:
        "Review checklist for risks that need certified evidence before stakeholder use.",
      intent: "data_quality",
      evidenceNeeded: ["freshness checks", "row counts", "known caveats", "owner review"],
    });
  } else if (/\bsegment|cohort|region|location|product|channel|customer\b/.test(lower)) {
    reports.push({
      title: "Drilldown certification report",
      question: "Which slices or drilldowns should become reusable certified blocks?",
      description:
        "Candidate slices and drilldowns the agent could not fully back with certified blocks yet.",
      intent: "entity_drilldown",
      evidenceNeeded: ["slice dimensions", "grain", "allowed filters", "previewed SQL"],
    });
  } else {
    reports.push({
      title: "Proof and lineage gaps",
      question: "What proof is still missing before this app can be treated as governed?",
      description:
        "Open proof, lineage, and review tasks to complete before this app is governed.",
      intent: "proof_review",
      evidenceNeeded: ["lineage", "certification state", "tests", "review cadence"],
    });
  }

  if (certifiedNodes.length === 0) {
    reports.push({
      title: "Certified block search",
      question: "Which existing or new DQL blocks should support this app?",
      description:
        "No certified blocks matched strongly enough; review suggested sources and create certified blocks.",
      intent: "proof_review",
      evidenceNeeded: ["candidate dbt models", "semantic metrics", "business terms", "draft block plan"],
    });
  }

  if (!reports.some((report) => /\btrust|evidence|risk|caveat|gap|proof/.test(report.title.toLowerCase()))) {
    reports.push({
      title: "Proof and lineage gaps",
      question: "What lineage and certification proof should be reviewed?",
      description:
        "Certification, lineage, caveats, and review actions that must be confirmed before stakeholder use.",
      intent: "proof_review",
      evidenceNeeded: ["lineage", "certification state", "owner", "tests"],
    });
  }

  return reports.map((report, index) => ({
    id: slugify(report.title) || `scoped-report-${index + 1}`,
    title: report.title,
    question: report.question,
    description: report.description,
    intent: report.intent,
    reviewStatus: "draft_ready",
    source: "app_builder",
    evidenceNeeded: report.evidenceNeeded,
    suggestedActions: ["open_research", "review_trust", "create_draft_block"],
  }));
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
  const wantsSeasonStart = /\bseason[_\s-]*start\b/.test(lower);
  const wantsSeasonEnd = /\bseason[_\s-]*end\b/.test(lower);
  const wantsTopN = /\btop[_\s-]*n\b/.test(lower);
  const years = Array.from(new Set(Array.from(prompt.matchAll(/\b(20\d{2}|19\d{2})\b/g)).map((match) => Number(match[1]))))
    .filter((year) => Number.isFinite(year))
    .sort((a, b) => a - b);
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
  if (wantsSeasonStart || wantsSeasonEnd || /\bseason|year|annual|nba\b/.test(lower) || years.length > 0) {
    if (years.length >= 2 || wantsSeasonStart || wantsSeasonEnd) {
      filters.push({
        id: "season_start",
        label: "Season start",
        type: "select",
        ...(years[0] ? { default: years[0] } : {}),
        ...(years.length ? { options: years.map(String) } : {}),
        bindsTo: "game_date_est.year",
      } as AppPlanFilter & { options: string[] });
      filters.push({
        id: "season_end",
        label: "Season end",
        type: "select",
        ...(years[years.length - 1] ? { default: years[years.length - 1] } : {}),
        ...(years.length ? { options: years.map(String) } : {}),
        bindsTo: "game_date_est.year",
      } as AppPlanFilter & { options: string[] });
    } else {
      filters.push({
        id: "season",
        label: "Season",
        type: "select",
        ...(years[0] ? { default: years[0] } : {}),
        ...(years.length ? { options: years.map(String) } : {}),
        bindsTo: "game_date_est.year",
      } as AppPlanFilter & { options?: string[] });
    }
  }
  const topN = /\btop(?:[_\s-]*n)?\s+(\d+)\b/i.exec(prompt)?.[1]
    ?? /\btop[_\s-]*n\s*[=:]?\s*(\d+)\b/i.exec(prompt)?.[1];
  if (topN || wantsTopN) {
    filters.push({
      id: "top_n",
      label: "Top N",
      type: "number" as AppPlanFilter["type"],
      ...(topN ? { default: Number(topN) } : {}),
      bindsTo: "limit",
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
  return uniquePlanFilters(filters);
}

function uniquePlanFilters(filters: AppPlanFilter[]): AppPlanFilter[] {
  const seen = new Set<string>();
  const out: AppPlanFilter[] = [];
  for (const filter of filters) {
    if (seen.has(filter.id)) continue;
    seen.add(filter.id);
    out.push(filter);
  }
  return out;
}

const APP_FILTER_TIME_RE = /(_at$|_date$|_time$|_ts$|^date$|^month$|^week$|^day$|ordered_at|created)/i;
const APP_FILTER_NUMBER_RE = /(top[_-]?n|limit|count|amount|year|score|rank)/i;

/** Map a block filter column to the dashboard control the runtime filter engine renders. */
function controlTypeForColumn(column: string): AppPlanFilter["type"] {
  if (APP_FILTER_TIME_RE.test(column)) return "daterange";
  if (APP_FILTER_NUMBER_RE.test(column)) return "number";
  return "select"; // categorical → dropdown (options filled by /api/dashboard/filter-options)
}

/**
 * Derive the global filter bar from what the certified tiles ACTUALLY accept — the
 * union of their declared `allowedFilters` (a block's governed, app-safe filters) —
 * instead of guessing from prompt words. Each control binds to a real column, so the
 * existing tile-binding logic refreshes exactly the tiles that declare it.
 */
function filtersFromCertifiedNodes(nodes: KGNode[]): AppPlanFilter[] {
  const seen = new Set<string>();
  const filters: AppPlanFilter[] = [];
  for (const node of nodes) {
    for (const column of node.allowedFilters ?? []) {
      const key = column.toLowerCase();
      if (!column.trim() || seen.has(key)) continue;
      seen.add(key);
      filters.push({
        id: column,
        label: titleCase(column.replace(/[_.]+/g, " ")),
        type: controlTypeForColumn(column),
        bindsTo: column,
      });
    }
  }
  return filters;
}

/**
 * Merge the block-derived bar (authoritative) with prompt-inferred filters: copy a
 * prompt default/options onto a matching column control, keep prompt-only PARAM
 * controls (e.g. top_n → LIMIT), and DROP prompt column filters no tile supports.
 */
function mergeAppFilters(blockFilters: AppPlanFilter[], promptFilters: AppPlanFilter[]): AppPlanFilter[] {
  const merged = blockFilters.map((f) => ({ ...f }));
  // Match by exact id first (a prompt filter for the same governed filter), else by a
  // prompt filter that binds to a column which IS a block filter. Avoid matching on a
  // shared physical bindsTo — that collides once two filters resolve to the same column.
  const matchOf = (pf: AppPlanFilter) =>
    merged.find((bf) => bf.id.toLowerCase() === pf.id.toLowerCase()) ??
    (pf.bindsTo
      ? merged.find((bf) => bf.id.toLowerCase() === pf.bindsTo!.toLowerCase())
      : undefined);
  for (const pf of promptFilters) {
    const match = matchOf(pf);
    if (match) {
      if (pf.default !== undefined && match.default === undefined) match.default = pf.default;
      if (pf.options && !match.options) match.options = pf.options;
      // Prefer the prompt's more specific physical binding when the block filter only
      // self-binds (bindsTo === id) and the prompt resolved an actual column/expression.
      if (pf.bindsTo && (!match.bindsTo || match.bindsTo.toLowerCase() === match.id.toLowerCase())) {
        match.bindsTo = pf.bindsTo;
      }
      continue;
    }
    // A param-style control (LIMIT, not a column predicate) is always useful — keep it.
    if (pf.bindsTo === "limit" || /^(top_n|limit)$/i.test(pf.id)) {
      merged.push({ ...pf });
    }
    // else: a prompt column filter that no certified tile accepts — drop it (no orphans).
  }
  return uniquePlanFilters(merged);
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
  if (component === "PivotTable") return { w: 6, h: 4 };
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

function displayMetadataForTile(
  tile: AppPlanTile,
  genUi: AppPlanGenUi,
): DashboardDisplayMetadata {
  return {
    mode: tile.kind === "certified_block" ? "block_hint" : "ai_generated",
    component: genUi.component,
    defaultVisualization: genUi.defaultVisualization,
    allowedVisualizations: genUi.allowedVisualizations,
    ...(genUi.fieldHints ? { fieldHints: cleanFieldHints(genUi.fieldHints) } : {}),
    layoutIntent: genUi.layoutIntent,
    rationale: genUi.rationale || tile.rationale || "Generated presentation metadata for this consumer surface.",
    trustState: genUi.trustState,
    reviewStatus: genUi.reviewStatus,
  };
}

function cleanFieldHints(input: AppPlanGenUi["fieldHints"]): Record<string, string> | undefined {
  if (!input) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
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

function resolveAppPackageDir(projectRoot: string, domain: string, appId: string): string {
  const domainSlug = slugify(domain);
  const domainDir = domainSlug ? join(projectRoot, "domains", domainSlug) : "";
  if (domainDir && existsSync(domainDir)) {
    return join(domainDir, "apps", appId);
  }
  return join(projectRoot, "apps", appId);
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
