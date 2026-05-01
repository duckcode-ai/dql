import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { DQLContext } from '../context.js';

export const listProposalsInput = {
  askedAtLeastTimes: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Filter to drafts asked at least N times (defaults to 1).'),
  since: z
    .string()
    .optional()
    .describe(
      'ISO 8601 timestamp; only return drafts whose last_asked is on or after this. Useful for "what got asked this week?".',
    ),
};

export interface ProposalSummary {
  draftPath: string;
  slug: string;
  question: string;
  askedTimes: number;
  firstAsked: string;
  lastAsked: string;
  proposedContractId: string;
  proposedDomain: string;
  proposedEntity: string;
  upstreamRefs: string[];
  certifyHint: string;
}

/**
 * The OSS-side review queue for the Tier-2 promotion loop. Reads
 * `blocks/_drafts/*.dql` from the project, parses the `_proposed { ... }`
 * provenance block out of each, and returns a list ranked by `askedTimes`
 * descending — questions that get asked repeatedly are the strongest
 * candidates for certification.
 *
 * Multi-user team queues (RBAC, assignments, deadlines, audit logs) are
 * commercial-overlay features. This OSS tool reads files from disk and
 * commits to git when humans certify them. That's the shared store.
 */
export function listProposals(
  ctx: DQLContext,
  args: { askedAtLeastTimes?: number; since?: string } = {},
): { proposals: ProposalSummary[] } {
  const draftDir = join(ctx.projectRoot, 'blocks', '_drafts');
  if (!existsSync(draftDir)) return { proposals: [] };

  const minTimes = args.askedAtLeastTimes ?? 1;
  const sinceMs = args.since ? Date.parse(args.since) : null;

  const proposals: ProposalSummary[] = [];
  for (const entry of readdirSync(draftDir)) {
    if (!entry.endsWith('.dql')) continue;
    const path = join(draftDir, entry);
    const summary = parseProposal(readFileSync(path, 'utf-8'), entry, ctx.projectRoot);
    if (!summary) continue;
    if (summary.askedTimes < minTimes) continue;
    if (sinceMs !== null && Date.parse(summary.lastAsked) < sinceMs) continue;
    proposals.push(summary);
  }

  proposals.sort((a, b) => {
    if (b.askedTimes !== a.askedTimes) return b.askedTimes - a.askedTimes;
    return Date.parse(b.lastAsked) - Date.parse(a.lastAsked);
  });

  return { proposals };
}

function parseProposal(
  content: string,
  filename: string,
  projectRoot: string,
): ProposalSummary | null {
  const slug = filename.replace(/\.dql$/, '');
  const question = pickStringField(content, 'description') ?? slug;
  const askedTimes = pickIntField(content, 'asked_times', 1);
  const firstAsked = pickStringField(content, 'first_asked') ?? '';
  const lastAsked = pickStringField(content, 'last_asked') ?? '';
  const proposedContractId = pickStringField(content, 'proposed_contract_id') ?? '';
  const proposedDomain = pickStringField(content, 'proposed_domain') ?? '';
  const proposedEntity = pickStringField(content, 'proposed_entity') ?? '';
  const upstreamRefs = pickArrayField(content, 'upstream_refs');
  const draftPath = relativeTo(projectRoot, `blocks/_drafts/${filename}`);
  const certifyHint = `dql certify --from-draft ${draftPath} --domain ${proposedDomain || '<domain>'} --contract ${proposedContractId || '<id>'}@1 --owner <you@example.com>`;
  return {
    draftPath,
    slug,
    question,
    askedTimes,
    firstAsked,
    lastAsked,
    proposedContractId,
    proposedDomain,
    proposedEntity,
    upstreamRefs,
    certifyHint,
  };
}

function pickStringField(content: string, key: string): string | undefined {
  const m =
    content.match(new RegExp(`${key}\\s*=\\s*"([^"]*)"`)) ||
    content.match(new RegExp(`${key}\\s*=\\s*"""([\\s\\S]*?)"""`));
  return m?.[1]?.trim();
}

function pickIntField(content: string, key: string, defaultValue: number): number {
  const m = content.match(new RegExp(`${key}\\s*=\\s*(\\d+)`));
  return m ? Number.parseInt(m[1], 10) : defaultValue;
}

function pickArrayField(content: string, key: string): string[] {
  const m = content.match(new RegExp(`${key}\\s*=\\s*\\[([^\\]]*)\\]`));
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^"|"$/g, ''))
    .filter((s) => s.length > 0);
}

function relativeTo(root: string, relPath: string): string {
  return relPath.startsWith('/') ? relPath : relPath;
}
