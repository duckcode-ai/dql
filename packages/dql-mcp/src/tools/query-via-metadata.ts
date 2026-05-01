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
          source: wrapSqlAsDqlCell(args.proposedSql),
          title: args.question,
        },
      }),
    });
  } catch (err) {
    return {
      uncertified: true,
      error: `Could not reach DQL runtime at ${base}. Start it with \`dql serve\` in ${ctx.projectRoot}. (${err instanceof Error ? err.message : String(err)})`,
      draftBlock,
    };
  }

  if (!response.ok) {
    return {
      uncertified: true,
      error: `Runtime returned ${response.status}: ${await response.text()}`,
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
    return { uncertified: true, error: payload.error, draftBlock };
  }
  const rows = payload.result?.rows ?? [];

  return {
    uncertified: true,
    reason: 'no certified block matched the question; result derived from manifest + dbt schema',
    question: args.question,
    rowCount: rows.length,
    durationMs: payload.result?.executionTime ?? null,
    columns: payload.result?.columns ?? [],
    rows: args.limit ? rows.slice(0, args.limit) : rows,
    draftBlock,
    promote: draftBlock
      ? `if you want this question certified, run: dql certify --from-draft ${draftBlock.path}`
      : undefined,
  };
}

// -- helpers ---------------------------------------------------------------

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
