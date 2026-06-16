import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { DQLContext } from '../context.js';

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
    .describe(
      'SQL the agent inferred from the available manifest + dbt schema. Will be executed through the local DQL runtime against the certified data plane.',
    ),
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
      'Persist a draft .dql file under blocks/_drafts/ for later human review and certification. Default true.',
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
 * - Optionally captures the proposal as a draft block at
 *   `blocks/_drafts/<slug>.dql`. Same question = same slug; askedTimes
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
    proposedSql: string;
    intent?: MetadataResearchIntent;
    upstreamRefs?: string[];
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
  const safety = buildMetadataPreviewSql(args.proposedSql, args.limit ?? 200);
  if (!safety.ok) {
    return {
      uncertified: true,
      intent,
      reviewStatus: 'rejected',
      trustStatus: metadataTrustStatus('rejected', intent, undefined, safety.error),
      evidence: metadataEvidence(intent, args, { status: 'rejected', error: safety.error }),
      error: safety.error,
      proposedSql: args.proposedSql,
      draftBlock: undefined,
    };
  }

  let draftBlock: { path: string; askedTimes: number; proposedContractId: string } | undefined;
  if (args.saveDraft !== false) {
    draftBlock = upsertDraft(ctx.projectRoot, {
      slug,
      question: args.question,
      proposedSql: args.proposedSql,
      proposedContractId,
      proposedDomain: args.proposedDomain,
      proposedEntity: args.proposedEntity,
      upstreamRefs: args.upstreamRefs ?? [],
    });
  }

  if (args.dryRun) {
    return {
      uncertified: true,
      intent,
      reviewStatus: 'draft_ready',
      trustStatus: metadataTrustStatus('draft_ready', intent, draftBlock),
      evidence: metadataEvidence(intent, args, { status: 'dry_run', draftBlock }),
      reason: 'dryRun=true; SQL not executed. Returned proposal only.',
      proposedSql: args.proposedSql,
      draftBlock,
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
          type: 'dql',
          source: wrapSqlAsDqlCell(safety.sql),
          title: args.question,
        },
      }),
    });
  } catch (err) {
    const error = `Could not reach DQL runtime at ${base}. Start it with \`dql serve\` in ${ctx.projectRoot}. (${err instanceof Error ? err.message : String(err)})`;
    return {
      uncertified: true,
      intent,
      trustStatus: metadataTrustStatus('draft_ready', intent, draftBlock, error),
      evidence: metadataEvidence(intent, args, { status: 'runtime_unavailable', draftBlock, error }),
      error,
      draftBlock,
    };
  }

  if (!response.ok) {
    const error = `Runtime returned ${response.status}: ${await response.text()}`;
    return {
      uncertified: true,
      intent,
      trustStatus: metadataTrustStatus('draft_ready', intent, draftBlock, error),
      evidence: metadataEvidence(intent, args, { status: 'runtime_error', draftBlock, error }),
      error,
      draftBlock,
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
    return {
      uncertified: true,
      intent,
      trustStatus: metadataTrustStatus('draft_ready', intent, draftBlock, payload.error),
      evidence: metadataEvidence(intent, args, { status: 'execution_failed', draftBlock, error: payload.error }),
      error: payload.error,
      draftBlock,
    };
  }
  const rows = payload.result?.rows ?? [];

  return {
    uncertified: true,
    intent,
    reviewStatus: 'draft_ready',
    trustStatus: metadataTrustStatus('draft_ready', intent, draftBlock),
    evidence: metadataEvidence(intent, args, {
      status: 'executed',
      draftBlock,
      rowCount: rows.length,
      durationMs: payload.result?.executionTime ?? null,
    }),
    reason: 'no certified block matched the question; result derived from manifest + dbt schema',
    question: args.question,
    rowCount: rows.length,
    durationMs: payload.result?.executionTime ?? null,
    columns: payload.result?.columns ?? [],
    rows: args.limit ? rows.slice(0, args.limit) : rows,
    proposedSql: args.proposedSql,
    draftBlock,
    promote: draftBlock
      ? `if you want this question certified, run: dql certify --from-draft ${draftBlock.path}`
      : undefined,
  };
}

// -- helpers ---------------------------------------------------------------

type MetadataResearchIntent =
  | 'diagnose_change'
  | 'driver_breakdown'
  | 'segment_compare'
  | 'entity_drilldown'
  | 'anomaly_investigation'
  | 'trust_gap_review';

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
      ...(error ? [`Execution caveat: ${error}`] : []),
    ],
  };
}

function metadataEvidence(
  intent: MetadataResearchIntent,
  args: {
    question: string;
    proposedSql: string;
    upstreamRefs?: string[];
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
  },
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

function buildMetadataPreviewSql(sql: string, limit: number): { ok: true; sql: string } | { ok: false; error: string } {
  const trimmed = sql.trim();
  if (!trimmed) return { ok: false, error: 'Tier-2 metadata SQL is empty.' };
  const withoutTrailingSemicolon = trimmed.replace(/;\s*$/, '').trim();
  const scanSql = stripSqlStringsAndComments(withoutTrailingSemicolon).trim();
  if (!/^(select|with)\b/i.test(scanSql)) {
    return { ok: false, error: 'Tier-2 metadata SQL only supports read-only SELECT or WITH queries.' };
  }
  if (scanSql.includes(';')) {
    return { ok: false, error: 'Tier-2 metadata SQL only supports one statement.' };
  }
  const forbiddenPattern = new RegExp(`\\b(${METADATA_PREVIEW_FORBIDDEN_SQL.join('|')})\\b`, 'i');
  const forbidden = scanSql.match(forbiddenPattern)?.[1];
  if (forbidden) {
    return { ok: false, error: `Tier-2 metadata SQL rejected unsupported statement keyword: ${forbidden.toUpperCase()}.` };
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

interface DraftRecord {
  slug: string;
  question: string;
  proposedSql: string;
  proposedContractId: string;
  proposedDomain?: string;
  proposedEntity?: string;
  upstreamRefs: string[];
}

function upsertDraft(
  projectRoot: string,
  rec: DraftRecord,
): { path: string; askedTimes: number; proposedContractId: string } {
  const draftDir = join(projectRoot, 'blocks', '_drafts');
  const filePath = join(draftDir, `${rec.slug}.dql`);

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf-8');
    const m = existing.match(/asked_times\s*=\s*(\d+)/);
    const prev = m ? Number.parseInt(m[1], 10) : 1;
    const next = Number.isFinite(prev) ? prev + 1 : 2;
    const updated = m
      ? existing.replace(/asked_times\s*=\s*\d+/, `asked_times = ${next}`)
      : existing.replace(/_proposed\s*\{/, `_proposed {\n        asked_times = ${next}`);
    const stamped = stampLastAsked(updated);
    writeFileSync(filePath, stamped);
    return {
      path: relativeToProject(projectRoot, filePath),
      askedTimes: next,
      proposedContractId: rec.proposedContractId,
    };
  }

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, renderDraft(rec));
  return {
    path: relativeToProject(projectRoot, filePath),
    askedTimes: 1,
    proposedContractId: rec.proposedContractId,
  };
}

function relativeToProject(root: string, abs: string): string {
  const rootSlash = root.endsWith('/') ? root : root + '/';
  return abs.startsWith(rootSlash) ? abs.slice(rootSlash.length) : abs;
}

function renderDraft(rec: DraftRecord): string {
  const now = new Date().toISOString();
  const upstream = rec.upstreamRefs.length > 0
    ? `\n    upstream_refs = [${rec.upstreamRefs.map((u) => `"${u}"`).join(', ')}]`
    : '';
  // Single quoted SQL inside triple-double-quotes; avoid breaking on `"""` in user SQL.
  const safeSql = rec.proposedSql.replace(/"""/g, '\\"\\"\\"');
  return `block "${rec.slug}" {
    domain = "${rec.proposedDomain ?? 'misc'}"
    type = "custom"
    status = "draft"
    description = """${rec.question}"""

    # Tier-2 proposal — auto-captured from query_via_metadata. Reviewer
    # fills in datalex_contract + owner, then runs:
    #   dql certify --from-draft blocks/_drafts/${rec.slug}.dql \\
    #               --domain ${rec.proposedDomain ?? 'misc'} \\
    #               --contract ${rec.proposedContractId}@1 \\
    #               --owner you@example.com
    datalex_contract = ""

    _proposed {
        asked_times = 1
        first_asked = "${now}"
        last_asked = "${now}"
        proposed_contract_id = "${rec.proposedContractId}"
        proposed_domain = "${rec.proposedDomain ?? ''}"
        proposed_entity = "${rec.proposedEntity ?? ''}"${upstream}
    }

    query = """
        ${safeSql.split('\n').join('\n        ')}
    """
}
`;
}

function stampLastAsked(content: string): string {
  const now = new Date().toISOString();
  if (/last_asked\s*=\s*"[^"]*"/.test(content)) {
    return content.replace(/last_asked\s*=\s*"[^"]*"/, `last_asked = "${now}"`);
  }
  return content;
}
