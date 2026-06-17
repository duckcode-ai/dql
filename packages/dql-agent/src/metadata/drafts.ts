import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface GeneratedDraftRecord {
  slug: string;
  question: string;
  proposedSql: string;
  proposedContractId: string;
  proposedDomain?: string;
  proposedEntity?: string;
  upstreamRefs?: string[];
  sourceQuestion?: string;
  sourceBlock?: string;
  followupKind?: string;
  requestedFilters?: string[];
  requestedDimensions?: string[];
  contextPackId?: string;
  routeIntent?: string;
  validationWarnings?: string[];
}

export interface GeneratedDraftBlock {
  path: string;
  askedTimes: number;
  proposedContractId: string;
}

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'for', 'from',
  'has', 'have', 'how', 'i', 'in', 'is', 'it', 'me', 'much', 'my', 'of',
  'on', 'or', 'our', 'so', 'that', 'the', 'their', 'then', 'there', 'this',
  'to', 'us', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who',
  'why', 'will', 'with', 'you', 'your',
]);

export function deriveGeneratedDraftSlug(question: string): string {
  const tokens = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));
  const slug = tokens.join('_').slice(0, 60).replace(/_+$/, '');
  return slug || 'untitled_proposal';
}

export function upsertGeneratedDraft(
  projectRoot: string,
  rec: GeneratedDraftRecord,
): GeneratedDraftBlock {
  const draftDir = join(projectRoot, 'blocks', '_drafts');
  const filePath = join(draftDir, `${rec.slug}.dql`);

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf-8');
    const m = existing.match(/asked_times\s*=\s*(\d+)/);
    const prev = m ? Number.parseInt(m[1], 10) : 1;
    const next = Number.isFinite(prev) ? prev + 1 : 2;
    const updated = m
      ? existing.replace(/asked_times\s*=\s*\d+/, `asked_times = ${next}`)
      : existing.replace(/\n\s*query\s*=/, `\n    asked_times = ${next}\n\n    query =`);
    writeFileSync(filePath, stampLastAsked(updated));
    return {
      path: relativeToProject(projectRoot, filePath),
      askedTimes: next,
      proposedContractId: rec.proposedContractId,
    };
  }

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, renderGeneratedDraft(rec));
  return {
    path: relativeToProject(projectRoot, filePath),
    askedTimes: 1,
    proposedContractId: rec.proposedContractId,
  };
}

function renderGeneratedDraft(rec: GeneratedDraftRecord): string {
  const now = new Date().toISOString();
  const upstream = arrayField('upstream_refs', rec.upstreamRefs ?? []);
  const requestedFilters = arrayField('requested_filters', rec.requestedFilters ?? []);
  const requestedDimensions = arrayField('requested_dimensions', rec.requestedDimensions ?? []);
  const warnings = arrayField('validation_warnings', rec.validationWarnings ?? []);
  const safeSql = rec.proposedSql.replace(/"""/g, '\\"\\"\\"');
  return `block "${escapeDqlString(rec.slug)}" {
    domain = "${escapeDqlString(rec.proposedDomain ?? 'misc')}"
    type = "custom"
    status = "draft"
    description = """${rec.question.replace(/"""/g, '\\"\\"\\"')}"""

    // Tier-2 generated proposal. This block is NOT certified.
    // Reviewer must validate filters, joins, grain, metric definition, lineage,
    // and contract ownership before promotion.
    //
    // Promotion path:
    //   dql certify --from-draft blocks/_drafts/${rec.slug}.dql \\
    //               --domain ${rec.proposedDomain ?? 'misc'} \\
    //               --contract ${rec.proposedContractId}@1 \\
    //               --owner you@example.com
    datalex_contract = ""

    // Tier-2 proposal metadata. Keep these as flat fields so the draft remains
    // valid DQL and can be indexed by the local metadata catalog.
    asked_times = 1
    first_asked = "${now}"
    last_asked = "${now}"
    proposed_contract_id = "${escapeDqlString(rec.proposedContractId)}"
    proposed_domain = "${escapeDqlString(rec.proposedDomain ?? '')}"
    proposed_entity = "${escapeDqlString(rec.proposedEntity ?? '')}"
    source_question = "${escapeDqlString(rec.sourceQuestion ?? '')}"
    source_block = "${escapeDqlString(rec.sourceBlock ?? '')}"
    followup_kind = "${escapeDqlString(rec.followupKind ?? '')}"
    context_pack_id = "${escapeDqlString(rec.contextPackId ?? '')}"
    route_intent = "${escapeDqlString(rec.routeIntent ?? '')}"${upstream}${requestedFilters}${requestedDimensions}${warnings}

    query = """
        ${safeSql.split('\n').join('\n        ')}
    """
}
`;
}

function arrayField(name: string, values: string[]): string {
  if (values.length === 0) return '';
  return `\n    ${name} = [${values.map((value) => `"${escapeDqlString(value)}"`).join(', ')}]`;
}

function stampLastAsked(content: string): string {
  const now = new Date().toISOString();
  if (/last_asked\s*=\s*"[^"]*"/.test(content)) {
    return content.replace(/last_asked\s*=\s*"[^"]*"/, `last_asked = "${now}"`);
  }
  return content;
}

function relativeToProject(root: string, abs: string): string {
  const rootSlash = root.endsWith('/') ? root : root + '/';
  return abs.startsWith(rootSlash) ? abs.slice(rootSlash.length) : abs;
}

function escapeDqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
