import { z } from 'zod';
import type { DQLContext } from '../context.js';
import {
  KGStore,
  defaultKgPath,
  ensureMetadataCatalogFresh,
  generateAppFromPlan,
  planAgentAnswer,
  planAppFromPrompt,
  reindexProject,
  validateAppPlan,
  type MetadataAllowedSqlContext,
  type MetadataObject,
} from '@duckcodeailabs/dql-agent';
import { resolveTrustLabel, trustLabelIdForRoute } from '@duckcodeailabs/dql-core';
import { suggestBlock, suggestBlockInput } from './suggest-block.js';

export const askDqlInput = {
  question: z.string().min(1).describe('Business or analytics question to route through governed DQL context.'),
  focusObjectKey: z.string().optional().describe('Optional metadata object key to bias retrieval.'),
  limit: z.number().int().min(1).max(160).optional().describe('Maximum metadata objects in the context pack.'),
};

export async function askDql(
  ctx: DQLContext,
  args: { question: string; focusObjectKey?: string; limit?: number },
) {
  const catalog = await ensureMetadataCatalogFresh(ctx.projectRoot).catch((error) => ({
    path: '',
    refreshed: false,
    objectCount: 0,
    edgeCount: 0,
    diagnostics: [{
      kind: 'metadata',
      severity: 'error' as const,
      message: error instanceof Error ? error.message : String(error),
    }],
    fingerprint: '',
  }));
  const planned = await planAgentAnswer(ctx.projectRoot, {
    question: args.question,
    focusObjectKey: args.focusObjectKey,
    limit: args.limit ?? 100,
    surface: 'mcp',
  });
  const route = planned.routeDecision;
  const exact = route.exactObjectKey
    ? planned.contextPack.objects.find((object) => object.objectKey === route.exactObjectKey)
    : undefined;
  const certifiedCandidates = planned.contextPack.objects
    .filter((object) => object.objectType === 'dql_block' && isCertified(object))
    .slice(0, 8)
    .map(summarizeObject);

  // Canonical trust label (base + optional qualifier) — one vocabulary shared
  // with the agent answer-loop and the UI badge. Derived from the route so MCP
  // clients always see the same label set.
  const trustLabel = resolveTrustLabel(trustLabelIdForRoute(route.route));

  return {
    question: args.question,
    contextPackId: planned.contextPackId,
    route: route.route,
    intent: route.intent,
    /** Legacy field retained for backward compatibility. */
    trustStatus: route.trustLabel,
    /** Canonical trust label: { id, base, qualifier?, severity, color, display }. */
    trustLabel,
    reviewStatus: route.reviewStatus,
    reason: route.reason,
    recommendedAction: recommendedAction(route.route),
    nextTool: nextTool(route.route),
    exactCertifiedBlock: exact && exact.objectType === 'dql_block' ? summarizeObject(exact) : undefined,
    certifiedCandidates,
    // Conflict route: surface BOTH sides + owners + the disambiguation prompt.
    conflict: route.routeConflict,
    selectedEvidence: route.selectedEvidence,
    allowedSqlContext: summarizeAllowedSqlContext(planned.allowedSqlContext),
    missingContext: planned.missingContext,
    followUps: route.followUps,
    warnings: [
      ...planned.warnings,
      ...catalog.diagnostics.map((diagnostic) => diagnostic.message),
    ],
    answerContract: {
      requiredFields: [
        'answer',
        'tableOrResultSummary',
        'sqlWhenGenerated',
        'trustStatus',
        'citations',
        'draftPathWhenGenerated',
        'nextReviewAction',
      ],
      // Canonical vocabulary the answer must report under `trustStatus`.
      trustLabels: ['Certified', 'Reviewed', 'AI-Generated', 'Insufficient-Context', 'Conflict'],
      rule: 'Never present generated SQL or Tier-2 preview rows as certified. On a Conflict route, present BOTH conflicting definitions with their owners and ask the user to choose — never silently pick one.',
    },
  };
}

export const buildDqlAppInput = {
  prompt: z.string().min(1).describe('App outcome request, for example "Build a Customer 360 for Melissa Lopez".'),
  domain: z.string().optional().describe('Optional business domain to prioritize.'),
  owner: z.string().optional().describe('Owner identity to store on the generated app.'),
  aiLayout: z.boolean().optional().describe('Store richer dynamic GenUI layout metadata.'),
  saveDraft: z.boolean().optional().describe('Write the app draft files. Default true.'),
  overwrite: z.boolean().optional().describe('Overwrite an existing app folder if it already exists. Default false.'),
};

export async function buildDqlApp(
  ctx: DQLContext,
  args: {
    prompt: string;
    domain?: string;
    owner?: string;
    aiLayout?: boolean;
    saveDraft?: boolean;
    overwrite?: boolean;
  },
) {
  const kgPath = defaultKgPath(ctx.projectRoot);
  await reindexProject(ctx.projectRoot, { kgPath });
  const kg = new KGStore(kgPath);
  try {
    const plan = planAppFromPrompt({
      prompt: args.prompt,
      kg,
      domain: cleanOptional(args.domain),
      owner: cleanOptional(args.owner),
      plannerMode: args.aiLayout ? 'ai_assisted' : 'deterministic',
    });
    const validation = validateAppPlan(plan, kg);
    const generated = args.saveDraft === false
      ? undefined
      : generateAppFromPlan(ctx.projectRoot, plan, kg, { overwrite: args.overwrite === true });
    if (generated) {
      ctx.refresh();
      await ensureMetadataCatalogFresh(ctx.projectRoot, { force: true }).catch(() => undefined);
    }
    return {
      ok: true,
      appId: plan.appId,
      name: plan.name,
      domain: plan.domain,
      audience: plan.audience,
      lifecycle: plan.lifecycle,
      certifiedTiles: validation.certifiedTiles,
      draftTiles: validation.draftTiles,
      validation,
      plan,
      generated,
      nextActions: generated
        ? [
          'Open the generated app draft in DQL.',
          'Review draft/research tiles before stakeholder use.',
          'Run dql app build after review.',
        ]
        : [
          'Review the returned plan.',
          'Call build_dql_app again with saveDraft=true to write files.',
        ],
    };
  } finally {
    kg.close();
  }
}

export const inspectDqlProjectInput = {
  refresh: z.boolean().optional().describe('Refresh metadata and agent index before returning status. Default true.'),
};

export async function inspectDqlProject(
  ctx: DQLContext,
  args: { refresh?: boolean },
) {
  let index: { nodes: number; edges: number; skills: number } | undefined;
  let catalog: { path: string; refreshed: boolean; objectCount: number; edgeCount: number; diagnostics: unknown[] } | undefined;
  if (args.refresh !== false) {
    index = await reindexProject(ctx.projectRoot, { kgPath: defaultKgPath(ctx.projectRoot) });
    catalog = await ensureMetadataCatalogFresh(ctx.projectRoot);
    ctx.refresh();
  }
  const manifest = ctx.manifest;
  const blocks = Object.values(manifest.blocks ?? {});
  const dashboards = Object.values(manifest.dashboards ?? {});
  const apps = Object.values(manifest.apps ?? {});
  return {
    projectRoot: ctx.projectRoot,
    blocks: {
      total: blocks.length,
      certified: blocks.filter((block) => block.status === 'certified').length,
      draft: blocks.filter((block) => block.status !== 'certified').length,
    },
    apps: apps.length,
    dashboards: dashboards.length,
    semantic: {
      metrics: ctx.semanticLayer.listMetrics().length,
      dimensions: ctx.semanticLayer.listDimensions().length,
    },
    index,
    catalog,
    recommendedNextStep: 'Use ask_dql before writing SQL, then query_via_block or query_via_metadata based on the returned route.',
  };
}

export const buildDqlBlockInput = suggestBlockInput;

export function buildDqlBlock(
  ctx: DQLContext,
  args: Parameters<typeof suggestBlock>[1],
) {
  return suggestBlock(ctx, args);
}

function recommendedAction(route: string): string {
  if (route === 'certified') return 'Use query_via_block only if the certified grain exactly answers the question.';
  if (route === 'generated_sql') return 'Generate one read-only SELECT/WITH query from the allowed SQL context, then call query_via_metadata.';
  if (route === 'research') return 'Use lineage, proposals, and metadata evidence before creating or promoting any app tile.';
  if (route === 'conflict') return 'Do not answer. Present both conflicting definitions with their owners and ask the user which one is authoritative.';
  return 'Ask for the missing business object, metric, table, filter, or grain before writing SQL.';
}

function nextTool(route: string): string {
  if (route === 'certified') return 'query_via_block';
  if (route === 'generated_sql') return 'query_via_metadata';
  if (route === 'research') return 'inspect_metadata_context';
  if (route === 'conflict') return 'ask_user_clarifying_question';
  return 'ask_user_clarifying_question';
}

function summarizeAllowedSqlContext(context: MetadataAllowedSqlContext): MetadataAllowedSqlContext {
  return {
    relations: context.relations.slice(0, 12).map((relation) => ({
      ...relation,
      columns: relation.columns.slice(0, 40),
    })),
    sourceBlockSql: context.sourceBlockSql.slice(0, 8),
  };
}

function summarizeObject(object: MetadataObject) {
  return {
    objectKey: object.objectKey,
    objectType: object.objectType,
    name: object.name,
    fullName: object.fullName,
    domain: object.domain,
    owner: object.owner,
    status: object.status,
    description: object.description,
    sourcePath: object.sourcePath,
  };
}

function isCertified(object: MetadataObject): boolean {
  return object.status === 'certified' || object.payload?.certification === 'certified';
}

function cleanOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
