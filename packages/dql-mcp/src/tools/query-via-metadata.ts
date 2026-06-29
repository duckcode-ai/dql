import { z } from 'zod';
import type { DQLContext } from '../context.js';
import {
  buildLocalContextPack,
  openMetadataCatalog,
  recordQueryRun,
  upsertGeneratedDraft,
  validateSqlAgainstLocalContext,
  type LocalContextPack,
} from '@duckcodeailabs/dql-agent';
import type {
  DataLexConformance,
  DataLexRelationship,
  JoinPathResolution,
} from '@duckcodeailabs/dql-core';

export const queryViaMetadataInput = {
  question: z
    .string()
    .min(1)
    .describe(
      'The user question being answered, verbatim. Used for the draft block name and description.',
    ),
  proposedSql: z
    .string()
    .min(1)
    .optional()
    .describe(
      'SQL the agent inferred from the inspected metadata context. Omit to return the catalog route plan and allowed SQL context before writing SQL.',
    ),
  contextPackId: z
    .string()
    .optional()
    .describe('Context-pack id returned by inspect_metadata_context. When supplied, query_via_metadata validates SQL against that exact catalog context.'),
  intent: z
    .enum([
      'diagnose_change',
      'driver_breakdown',
      'segment_compare',
      'entity_drilldown',
      'anomaly_investigation',
      'trust_gap_review',
    ])
    .optional()
    .describe('Optional deep-research intent for dashboard drilldowns and investigation-style answers.'),
  upstreamRefs: z
    .array(z.string())
    .optional()
    .describe('Tables / blocks the agent thinks are involved.'),
  followUp: z
    .object({
      kind: z.enum(['generic', 'drilldown']),
      sourceBlockName: z.string().optional(),
      sourceQuestion: z.string().optional(),
      sourceAnswer: z.string().optional(),
      filters: z.array(z.string()).optional(),
      dimensions: z.array(z.string()).optional(),
    })
    .optional()
    .describe('Structured prior-answer context for follow-up drilldowns. Generated SQL remains uncertified.'),
  proposedDomain: z
    .string()
    .optional()
    .describe(
      'Best guess at the DataLex domain that owns this question (e.g. "customer", "finance"). Used to suggest a contract id.',
    ),
  proposedEntity: z
    .string()
    .optional()
    .describe(
      'Best guess at the entity (PascalCase, e.g. "Customer"). Used together with proposedDomain to suggest a contract id.',
    ),
  saveDraft: z
    .boolean()
    .optional()
    .describe(
      'Persist a draft .dql file under the local draft queue for later human review and certification. Default true.',
    ),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      'If true, return the proposed SQL + lineage without executing. Default false (execute).',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(10000)
    .optional()
    .describe('Max rows to return on execution.'),
  serverUrl: z
    .string()
    .optional()
    .describe(
      'Base URL of the local DQL runtime (default http://127.0.0.1:3474). Start it with `dql serve`.',
    ),
};

/**
 * Tier-2 of the graduated-trust loop. Use ONLY after `query_via_block` has
 * confirmed there's no certified block for the question.
 *
 * - Executes the proposed SQL against the local runtime (unless dryRun).
 * - Returns the result with `uncertified: true` so the agent surfaces the
 *   trust label to the human.
 * - Optionally captures the proposal as a draft block in the local draft
 *   queue. Same question = same slug; askedTimes
 *   counter increments on dedupe.
 *
 * The agent contract: surface `uncertified: true` verbatim, and tell the
 * user about the draft block path + the `dql certify --from-draft` command
 * if they want the answer certified for next time.
 */
export async function queryViaMetadata(
  ctx: DQLContext,
  args: {
    question: string;
    proposedSql?: string;
    contextPackId?: string;
    intent?: MetadataResearchIntent;
    upstreamRefs?: string[];
    followUp?: MetadataFollowUpContext;
    proposedDomain?: string;
    proposedEntity?: string;
    saveDraft?: boolean;
    dryRun?: boolean;
    limit?: number;
    serverUrl?: string;
  },
) {
  const slug = deriveSlug(args.question);
  const proposedContractId = suggestContractId(slug, args.proposedDomain, args.proposedEntity);
  const intent = normalizeMetadataResearchIntent(args.intent, args.question);
  const contextPack = await buildTier2ContextPack(ctx.projectRoot, args.question, args.contextPackId, args.followUp);
  const hasInspectedContext = hasInspectedMetadataContext(contextPack);
  // DataLex modeled join semantics (canonical keys + grain-safe orientation) for
  // the entities this question touches. Undefined when no manifest is loaded.
  const datalexJoinGuidance = buildDataLexJoinGuidance(ctx.datalexRegistry, [
    ...(args.upstreamRefs ?? []),
    ...(args.proposedEntity ? [args.proposedEntity] : []),
  ]);
  const contextNeedsClarification = hasInspectedContext && contextPack?.routeDecision.route === 'clarify';
  if (contextNeedsClarification || !args.proposedSql?.trim()) {
    recordTier2QueryRun(ctx.projectRoot, {
      slug,
      question: args.question,
      status: contextNeedsClarification ? 'clarify' : 'planning_only',
      errorCode: contextNeedsClarification ? 'missing_context' : undefined,
      contextPack,
    });
    return {
      uncertified: true,
      intent,
      reviewStatus: 'none',
      planningOnly: true,
      contextPack,
      datalexJoinGuidance,
      routeDecision: contextPack?.routeDecision,
      allowedSqlContext: contextPack?.allowedSqlContext,
      selectedRelations: contextPack?.retrievalDiagnostics.selectedRelations?.slice(0, 12) ?? [],
      selectedJoinPaths: contextPack?.retrievalDiagnostics.selectedJoinPaths?.slice(0, 12) ?? [],
      schemaShapeCandidates: contextPack?.retrievalDiagnostics.schemaShapeCandidates?.slice(0, 12) ?? [],
      missingContext: contextPack?.missingContext ?? [],
      evidence: metadataEvidence(intent, args, { status: 'planning_only' }, contextPack),
      reason: contextNeedsClarification
        ? contextPack.routeDecision.reason
        : 'No SQL was supplied. Inspect the context pack and provide one read-only SELECT/WITH query that uses only allowed relations and columns.',
    };
  }
  const proposedSql = args.proposedSql.trim();
  const contextValidation = validateSqlAgainstLocalContext(proposedSql, hasInspectedContext ? contextPack : undefined, {
    question: args.question,
    intent,
    filterValues: args.followUp?.filters,
  });
  if (!contextValidation.ok) {
    recordTier2QueryRun(ctx.projectRoot, { slug, question: args.question, status: 'rejected', errorCode: contextValidation.code, contextPack });
    return {
      uncertified: true,
      intent,
      reviewStatus: 'rejected',
      errorCode: contextValidation.code,
      trustStatus: metadataTrustStatus('rejected', intent, undefined, contextValidation.error, contextValidation.warnings),
      evidence: metadataEvidence(intent, args, { status: 'rejected', error: contextValidation.error, validationWarnings: contextValidation.warnings }, contextPack),
      contextPack,
      error: contextValidation.error,
      validationWarnings: contextValidation.warnings,
      proposedSql,
      draftBlock: undefined,
    };
  }
  const safety = buildMetadataPreviewSql(proposedSql, args.limit ?? 200);
  if (!safety.ok) {
    recordTier2QueryRun(ctx.projectRoot, { slug, question: args.question, status: 'rejected', errorCode: 'unsafe_sql', contextPack });
    return {
      uncertified: true,
      intent,
      reviewStatus: 'rejected',
      errorCode: safety.code,
      trustStatus: metadataTrustStatus('rejected', intent, undefined, safety.error, contextValidation.warnings),
      evidence: metadataEvidence(intent, args, { status: 'rejected', error: safety.error, validationWarnings: contextValidation.warnings }, contextPack),
      contextPack,
      error: safety.error,
      validationWarnings: contextValidation.warnings,
      proposedSql,
      draftBlock: undefined,
    };
  }

  let draftBlock: { path: string; askedTimes: number; proposedContractId: string } | undefined;
  if (args.saveDraft !== false) {
    draftBlock = upsertGeneratedDraft(ctx.projectRoot, {
      slug,
      question: args.question,
      proposedSql,
      proposedContractId,
      proposedDomain: args.proposedDomain,
      proposedEntity: args.proposedEntity,
      upstreamRefs: args.upstreamRefs ?? [],
      sourceQuestion: args.followUp?.sourceQuestion,
      sourceBlock: args.followUp?.sourceBlockName,
      followupKind: args.followUp?.kind,
      requestedFilters: args.followUp?.filters,
      requestedDimensions: args.followUp?.dimensions,
      contextPackId: contextPack?.id,
      routeIntent: contextPack?.routeDecision.intent ?? intent,
      validationWarnings: contextValidation.warnings,
    });
  }

  if (args.dryRun) {
    return {
      uncertified: true,
      intent,
      reviewStatus: 'draft_ready',
      trustStatus: metadataTrustStatus('draft_ready', intent, draftBlock, undefined, contextValidation.warnings),
      evidence: metadataEvidence(intent, args, { status: 'dry_run', draftBlock, validationWarnings: contextValidation.warnings }, contextPack),
      contextPack,
      datalexJoinGuidance,
      reason: 'dryRun=true; SQL not executed. Returned proposal only.',
      proposedSql,
      draftBlock,
      validationWarnings: contextValidation.warnings,
      promote: draftBlock
        ? `if you want this question certified, run: dql certify --from-draft ${draftBlock.path}`
        : undefined,
    };
  }

  const base = args.serverUrl ?? process.env.DQL_RUNTIME_URL ?? 'http://127.0.0.1:3474';
  const url = `${base.replace(/\/$/, '')}/api/notebook/execute`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cell: {
          id: `mcp-tier2-${slug}`,
          type: 'sql',
          source: wrapSqlAsDqlCell(safety.sql),
          title: args.question,
        },
      }),
    });
  } catch (err) {
    const error = `Could not reach DQL runtime at ${base}. Start it with \`dql serve\` in ${ctx.projectRoot}. (${err instanceof Error ? err.message : String(err)})`;
    recordTier2QueryRun(ctx.projectRoot, { slug, question: args.question, status: 'runtime_unavailable', errorCode: 'runtime_unavailable', contextPack });
    return {
      uncertified: true,
      intent,
      trustStatus: metadataTrustStatus('draft_ready', intent, draftBlock, error, contextValidation.warnings),
      evidence: metadataEvidence(intent, args, { status: 'runtime_unavailable', draftBlock, error, validationWarnings: contextValidation.warnings }, contextPack),
      contextPack,
      error,
      draftBlock,
      validationWarnings: contextValidation.warnings,
    };
  }

  if (!response.ok) {
    const error = `Runtime returned ${response.status}: ${await response.text()}`;
    recordTier2QueryRun(ctx.projectRoot, { slug, question: args.question, status: 'runtime_error', errorCode: `http_${response.status}`, contextPack });
    return {
      uncertified: true,
      intent,
      trustStatus: metadataTrustStatus('draft_ready', intent, draftBlock, error, contextValidation.warnings),
      evidence: metadataEvidence(intent, args, { status: 'runtime_error', draftBlock, error, validationWarnings: contextValidation.warnings }, contextPack),
      contextPack,
      error,
      draftBlock,
      validationWarnings: contextValidation.warnings,
    };
  }

  const payload = (await response.json()) as {
    result?: {
      columns?: Array<{ name: string; type?: string }>;
      rows?: unknown[];
      executionTime?: number;
    };
    error?: string;
  };
  if (payload.error) {
    recordTier2QueryRun(ctx.projectRoot, { slug, question: args.question, status: 'execution_failed', errorCode: 'execution_failed', contextPack });
    return {
      uncertified: true,
      intent,
      trustStatus: metadataTrustStatus('draft_ready', intent, draftBlock, payload.error, contextValidation.warnings),
      evidence: metadataEvidence(intent, args, { status: 'execution_failed', draftBlock, error: payload.error, validationWarnings: contextValidation.warnings }, contextPack),
      contextPack,
      error: payload.error,
      draftBlock,
      validationWarnings: contextValidation.warnings,
    };
  }
  const rows = payload.result?.rows ?? [];
  recordTier2QueryRun(ctx.projectRoot, {
    slug,
    question: args.question,
    status: 'executed',
    rowCount: rows.length,
    durationMs: payload.result?.executionTime ?? undefined,
    contextPack,
  });

  return {
    uncertified: true,
    intent,
    reviewStatus: 'draft_ready',
    trustStatus: metadataTrustStatus('draft_ready', intent, draftBlock, undefined, contextValidation.warnings),
    evidence: metadataEvidence(intent, args, {
      status: 'executed',
      draftBlock,
      rowCount: rows.length,
      durationMs: payload.result?.executionTime ?? null,
      validationWarnings: contextValidation.warnings,
    }, contextPack),
    contextPack,
    datalexJoinGuidance,
    reason: 'no certified block matched the question; result derived from manifest + dbt schema',
    question: args.question,
    rowCount: rows.length,
    durationMs: payload.result?.executionTime ?? null,
    columns: payload.result?.columns ?? [],
    rows: args.limit ? rows.slice(0, args.limit) : rows,
    proposedSql,
    draftBlock,
    validationWarnings: contextValidation.warnings,
    promote: draftBlock
      ? `if you want this question certified, run: dql certify --from-draft ${draftBlock.path}`
      : undefined,
  };
}

// -- helpers ---------------------------------------------------------------

export interface DataLexJoinGuidance {
  source: 'datalex_manifest';
  note: string;
  entities: Array<{
    concept: string;
    domain?: string;
    canonicalKey?: string[];
    physical: string[];
  }>;
  joins: Array<{
    from: string;
    to: string;
    on?: string;
    cardinality?: string;
    fansOut: boolean;
    guidance: string;
  }>;
  unresolved?: Array<{ from: string; to: string; reason: string; message: string }>;
}

interface JoinGuidanceRegistry {
  conformance(): DataLexConformance[];
  relationships(): DataLexRelationship[];
  joinPath(
    base: string,
    target: string,
    opts?: { baseDomain?: string; targetDomain?: string },
  ): JoinPathResolution;
}

/**
 * Build grain-safe join guidance from the DataLex manifest for the entities a
 * Tier-2 question touches. This is what turns conformance + typed relationships
 * into something the agent can act on BEFORE it writes SQL: the canonical key to
 * join each business concept on, and — for each pair — whether joining one onto
 * the other fans out (and therefore needs aggregation to stay grain-safe).
 *
 * `refs` are the tables/entities the agent thinks are involved; physical model
 * names (`dim_customer`), physical entity names (`DimCustomer`), and concept
 * names (`Customer`) all resolve. With none resolved we surface the whole
 * (small) conformance map so the agent still sees the modeled joins.
 *
 * Returns undefined when no DataLex manifest is loaded — Tier-2 must keep working
 * for projects that never adopted DataLex (graduated trust).
 */
export function buildDataLexJoinGuidance(
  registry: JoinGuidanceRegistry,
  refs: string[],
): DataLexJoinGuidance | undefined {
  // Gate on conformance, NOT registry.isLoaded() — that's contracts-based, and a
  // modeling-primary manifest carries conformance + relationships with zero
  // contracts. No conformance (or no manifest) => no guidance; Tier-2 still runs.
  const conformance = registry.conformance();
  if (conformance.length === 0) return undefined;

  const conceptByKey = new Map<string, DataLexConformance>();
  for (const c of conformance) {
    conceptByKey.set(c.concept.toLowerCase(), c);
    for (const p of c.physical ?? []) {
      if (p.entity) conceptByKey.set(p.entity.toLowerCase(), c);
      if (p.binding?.ref) conceptByKey.set(p.binding.ref.toLowerCase(), c);
    }
  }

  const involved: DataLexConformance[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const c = conceptByKey.get(String(ref ?? '').toLowerCase());
    if (c && !seen.has(c.concept.toLowerCase())) {
      seen.add(c.concept.toLowerCase());
      involved.push(c);
    }
  }
  // Scope to the involved concepts; with none resolved, fall back to the whole
  // (bounded) conformance map so the agent still gets the modeled join keys.
  const concepts = involved.length > 0 ? involved : conformance.slice(0, 12);

  const entities = concepts.map((c) => ({
    concept: c.concept,
    domain: c.domain,
    canonicalKey: c.canonical_key,
    physical: (c.physical ?? [])
      .map((p) => p.binding?.ref)
      .filter((r): r is string => Boolean(r)),
  }));

  const joins: DataLexJoinGuidance['joins'] = [];
  const unresolved: NonNullable<DataLexJoinGuidance['unresolved']> = [];
  for (let i = 0; i < concepts.length; i += 1) {
    for (let j = i + 1; j < concepts.length; j += 1) {
      const a = concepts[i];
      const b = concepts[j];
      let jp = registry.joinPath(a.concept, b.concept, {
        baseDomain: a.domain,
        targetDomain: b.domain,
      });
      // Prefer the non-fanning orientation (join the "one" side onto the "many"
      // side, i.e. the dimension onto the fact) so the primary guidance is the
      // grain-safe join; the fan-out direction is still called out in the text.
      if (jp.ok && jp.fansOut) {
        const flipped = registry.joinPath(b.concept, a.concept, {
          baseDomain: b.domain,
          targetDomain: a.domain,
        });
        if (flipped.ok && !flipped.fansOut) jp = flipped;
      }
      if (!jp.ok) {
        if (jp.reason === 'ambiguous') {
          unresolved.push({ from: a.concept, to: b.concept, reason: jp.reason, message: jp.message });
        }
        // 'no_relationship' is expected for unrelated pairs — skip quietly.
        continue;
      }
      const on =
        jp.base.column && jp.target.column
          ? `${jp.base.entity}.${jp.base.column} = ${jp.target.entity}.${jp.target.column}`
          : undefined;
      joins.push({
        from: jp.base.entity,
        to: jp.target.entity,
        on,
        cardinality: jp.cardinality,
        fansOut: jp.fansOut,
        guidance: jp.fansOut
          ? `${jp.base.entity} ↔ ${jp.target.entity} is ${jp.cardinality}; either direction can multiply rows — aggregate to one grain (GROUP BY the canonical key) before joining.`
          : `Each ${jp.base.entity} has one ${jp.target.entity}: join ${jp.target.entity} onto ${jp.base.entity}${on ? ` on ${on}` : ''} without fan-out. Aggregating ${jp.base.entity} per ${jp.target.entity} fans out — GROUP BY the ${jp.target.entity} key.`,
      });
    }
  }

  return {
    source: 'datalex_manifest',
    note: 'Modeled join semantics from DataLex. Join each concept on its canonical key and respect fan-out to keep results grain-safe.',
    entities,
    joins: joins.slice(0, 25),
    ...(unresolved.length > 0 ? { unresolved } : {}),
  };
}

type MetadataResearchIntent =
  | 'diagnose_change'
  | 'driver_breakdown'
  | 'segment_compare'
  | 'entity_drilldown'
  | 'anomaly_investigation'
  | 'trust_gap_review';

type MetadataFollowUpContext = {
  kind: 'generic' | 'drilldown';
  sourceBlockName?: string;
  sourceQuestion?: string;
  sourceAnswer?: string;
  filters?: string[];
  dimensions?: string[];
};

function normalizeMetadataResearchIntent(value: unknown, question: string): MetadataResearchIntent {
  if (
    value === 'diagnose_change'
    || value === 'driver_breakdown'
    || value === 'segment_compare'
    || value === 'entity_drilldown'
    || value === 'anomaly_investigation'
    || value === 'trust_gap_review'
  ) return value;
  const text = question.toLowerCase();
  if (/\b(trust|rely|certif|lineage|owner|caveat|gap)\b/.test(text)) return 'trust_gap_review';
  if (/\b(anomal|exception|outlier|spike|dip)\b/.test(text)) return 'anomaly_investigation';
  if (/\b(compare|versus| vs |segment|cohort)\b/.test(text)) return 'segment_compare';
  if (/\b(customer|account|user|client|merchant|product|sku|entity)\b/.test(text)) return 'entity_drilldown';
  if (/\b(why|changed|change|drop|decline|increase|decrease|month|week|quarter)\b/.test(text)) return 'diagnose_change';
  if (/\b(driver|drove|break down|breakdown|contribute|top mover|movers)\b/.test(text)) return 'driver_breakdown';
  return 'driver_breakdown';
}

function metadataTrustStatus(
  reviewStatus: 'draft_ready' | 'rejected',
  intent: MetadataResearchIntent,
  draftBlock?: { path: string; askedTimes: number; proposedContractId: string },
  error?: string,
  validationWarnings: string[] = [],
) {
  return {
    label: 'AI-generated metadata research',
    uncertified: true,
    intent,
    reviewStatus,
    certification: 'uncertified',
    draftPath: draftBlock?.path,
    promotionPath: draftBlock ? 'dql certify --from-draft' : undefined,
    caveats: [
      'No certified block exactly answered this grain.',
      'SQL was generated from metadata and must be reviewed before certification.',
      ...validationWarnings,
      ...(error ? [`Execution caveat: ${error}`] : []),
    ],
  };
}

function metadataEvidence(
  intent: MetadataResearchIntent,
  args: {
    question: string;
    proposedSql?: string;
    upstreamRefs?: string[];
    followUp?: MetadataFollowUpContext;
    proposedDomain?: string;
    proposedEntity?: string;
    limit?: number;
  },
  execution: {
    status: string;
    draftBlock?: { path: string; askedTimes: number; proposedContractId: string };
    rowCount?: number;
    durationMs?: number | null;
    error?: string;
    validationWarnings?: string[];
  },
  contextPack?: LocalContextPack,
) {
  return {
    planner: {
      mode: 'metadata_text_to_sql',
      intent,
      steps: metadataInvestigationSteps(intent),
      reviewRequired: true,
      boundedPreviewLimit: args.limit ?? 200,
    },
    certifiedContext: {
      upstreamRefs: args.upstreamRefs ?? [],
      proposedDomain: args.proposedDomain,
      proposedEntity: args.proposedEntity,
      draftBlock: execution.draftBlock,
      sourceCertifiedBlock: args.followUp?.sourceBlockName,
      contextPackId: contextPack?.id,
      trustLabel: contextPack?.trustLabel,
      selectedEvidence: contextPack?.retrievalDiagnostics.selectedEvidence.slice(0, 12) ?? [],
      selectedRelations: contextPack?.retrievalDiagnostics.selectedRelations?.slice(0, 12) ?? [],
      selectedJoinPaths: contextPack?.retrievalDiagnostics.selectedJoinPaths?.slice(0, 12) ?? [],
      schemaShapeCandidates: contextPack?.retrievalDiagnostics.schemaShapeCandidates?.slice(0, 12) ?? [],
      warnings: [...(contextPack?.warnings ?? []), ...(execution.validationWarnings ?? [])],
    },
    execution: {
      status: execution.status,
      rowCount: execution.rowCount,
      durationMs: execution.durationMs,
      error: execution.error,
    },
    assumptions: [
      `Intent classified as ${intent}.`,
      'Certified blocks and metadata are context; this generated SQL is not certified.',
      'Preview SQL is read-only and bounded before execution.',
      execution.draftBlock
        ? `Draft review path captured at ${execution.draftBlock.path}.`
        : 'No draft block was captured for this run.',
    ],
  };
}

async function buildTier2ContextPack(
  projectRoot: string,
  question: string,
  contextPackId?: string,
  followUp?: MetadataFollowUpContext,
): Promise<LocalContextPack | undefined> {
  if (contextPackId) {
    const catalog = openMetadataCatalog(projectRoot);
    try {
      const existing = catalog.getContextPack(contextPackId);
      if (existing) return existing;
    } finally {
      catalog.close();
    }
  }
  return buildLocalContextPack(projectRoot, {
    question,
    mode: 'question',
    followUp,
  }).catch(() => undefined);
}

function hasInspectedMetadataContext(contextPack: LocalContextPack | undefined): contextPack is LocalContextPack {
  return Boolean(contextPack && (
    contextPack.allowedSqlContext.relations.length > 0
    || contextPack.allowedSqlContext.sourceBlockSql.length > 0
    || contextPack.objects.some((object) => object.objectType.startsWith('semantic_'))
  ));
}

function recordTier2QueryRun(
  projectRoot: string,
  args: {
    slug: string;
    question: string;
    status: string;
    rowCount?: number;
    durationMs?: number;
    errorCode?: string;
    contextPack?: LocalContextPack;
  },
): void {
  try {
    recordQueryRun(projectRoot, {
      objectKey: `dql:draft:${args.slug}`,
      source: 'ai_draft',
      status: args.status,
      rowCount: args.rowCount,
      durationMs: args.durationMs,
      errorCode: args.errorCode,
      payload: {
        question: args.question,
        contextPackId: args.contextPack?.id,
        trustLabel: args.contextPack?.trustLabel,
      },
    });
  } catch {
    // Query-run history is advisory and must not block the answer.
  }
}

function metadataInvestigationSteps(intent: MetadataResearchIntent): string[] {
  const common = ['trust check', 'draft review path'];
  if (intent === 'trust_gap_review') return ['certification review', 'lineage review', 'owner and caveat check', ...common];
  if (intent === 'entity_drilldown') return ['entity value match', 'metric trend', 'exception rows', ...common];
  if (intent === 'segment_compare') return ['segment grouping', 'baseline comparison', 'top movers', ...common];
  if (intent === 'anomaly_investigation') return ['baseline comparison', 'trend check', 'exception rows', 'top movers', ...common];
  if (intent === 'diagnose_change') return ['baseline comparison', 'trend check', 'top movers', 'segment contribution', ...common];
  return ['top movers', 'segment contribution', 'exception rows', ...common];
}

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'for', 'from',
  'has', 'have', 'how', 'i', 'in', 'is', 'it', 'me', 'much', 'my', 'of',
  'on', 'or', 'our', 'so', 'that', 'the', 'their', 'then', 'there', 'this',
  'to', 'us', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who',
  'why', 'will', 'with', 'you', 'your',
]);

/**
 * Derive a deterministic snake_case slug from a free-form question. Same
 * question -> same slug, so re-asking the question increments `asked_times`
 * on the existing draft instead of creating a new file.
 *
 * v1: lowercase, strip punctuation, drop stopwords + common quantifiers
 * (e.g. "how many"), join with `_`. Truncated to 60 chars to keep file
 * paths sensible. Not perfect across paraphrases — that's a v2 problem.
 */
export function deriveSlug(question: string): string {
  const tokens = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
  const slug = tokens.join('_').slice(0, 60).replace(/_+$/, '');
  return slug || 'untitled_proposal';
}

function suggestContractId(
  slug: string,
  domain: string | undefined,
  entity: string | undefined,
): string {
  const d = (domain || 'misc').toLowerCase();
  const e = entity && /^[A-Z]/.test(entity) ? entity : 'Unknown';
  return `${d}.${e}.${slug}`;
}

function wrapSqlAsDqlCell(sql: string): string {
  // Tier-2 cells are raw SQL. The runtime accepts SQL directly; no DQL
  // block wrapper is required for execution.
  return sql;
}

const METADATA_PREVIEW_FORBIDDEN_SQL = [
  'alter',
  'analyze',
  'attach',
  'call',
  'copy',
  'create',
  'delete',
  'detach',
  'drop',
  'export',
  'grant',
  'import',
  'insert',
  'install',
  'load',
  'merge',
  'pragma',
  'reset',
  'revoke',
  'set',
  'truncate',
  'update',
  'vacuum',
];

function buildMetadataPreviewSql(sql: string, limit: number): { ok: true; sql: string } | { ok: false; code: 'unsafe_sql'; error: string } {
  const trimmed = sql.trim();
  if (!trimmed) return { ok: false, code: 'unsafe_sql', error: 'Tier-2 metadata SQL is empty.' };
  const withoutTrailingSemicolon = trimmed.replace(/;\s*$/, '').trim();
  const scanSql = stripSqlStringsAndComments(withoutTrailingSemicolon).trim();
  if (!/^(select|with)\b/i.test(scanSql)) {
    return { ok: false, code: 'unsafe_sql', error: 'Tier-2 metadata SQL only supports read-only SELECT or WITH queries.' };
  }
  if (scanSql.includes(';')) {
    return { ok: false, code: 'unsafe_sql', error: 'Tier-2 metadata SQL only supports one statement.' };
  }
  const forbiddenPattern = new RegExp(`\\b(${METADATA_PREVIEW_FORBIDDEN_SQL.join('|')})\\b`, 'i');
  const forbidden = scanSql.match(forbiddenPattern)?.[1];
  if (forbidden) {
    return { ok: false, code: 'unsafe_sql', error: `Tier-2 metadata SQL rejected unsupported statement keyword: ${forbidden.toUpperCase()}.` };
  }
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 10000);
  return {
    ok: true,
    sql: `SELECT * FROM (\n${withoutTrailingSemicolon}\n) AS dql_mcp_metadata_preview LIMIT ${boundedLimit}`,
  };
}

function stripSqlStringsAndComments(sql: string): string {
  let output = '';
  for (let index = 0; index < sql.length; index += 1) {
    const current = sql[index];
    const next = sql[index + 1];
    if (current === '-' && next === '-') {
      output += '  ';
      index += 2;
      while (index < sql.length && sql[index] !== '\n') {
        output += ' ';
        index += 1;
      }
      if (index < sql.length) output += '\n';
      continue;
    }
    if (current === '/' && next === '*') {
      output += '  ';
      index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) {
        output += sql[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      if (index < sql.length) {
        output += '  ';
        index += 1;
      }
      continue;
    }
    if (current === "'" || current === '"') {
      const quote = current;
      output += ' ';
      while (index + 1 < sql.length) {
        index += 1;
        output += sql[index] === '\n' ? '\n' : ' ';
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 1;
            output += ' ';
            continue;
          }
          break;
        }
      }
      continue;
    }
    output += current;
  }
  return output;
}
