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

/** Snake_case identifier rule the namer enforces: `^[a-z][a-z0-9_]*$`. */
const SEMANTIC_NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Words that hint at the metric/entity being asked about. Kept tiny and
 * convention-agnostic — this is a deterministic fallback, not an NLP model.
 */
const GRAIN_HINTS: Array<{ re: RegExp; grain: string }> = [
  { re: /\b(daily|per day|by day|each day)\b/i, grain: 'daily' },
  { re: /\b(weekly|per week|by week|each week)\b/i, grain: 'weekly' },
  { re: /\b(monthly|per month|by month|each month)\b/i, grain: 'monthly' },
  { re: /\b(quarterly|per quarter|by quarter)\b/i, grain: 'quarterly' },
  { re: /\b(yearly|annual|annually|per year|by year)\b/i, grain: 'yearly' },
];

/** Common analytic entities/measures we recognize for the rule-based fallback. */
const ENTITY_HINTS = [
  'orders', 'order', 'revenue', 'sales', 'customers', 'customer', 'users', 'user',
  'sessions', 'session', 'payments', 'payment', 'subscriptions', 'subscription',
  'churn', 'retention', 'signups', 'signup', 'spend', 'cost', 'profit', 'margin',
  'shipments', 'shipment', 'products', 'product', 'accounts', 'account', 'leads',
  'lead', 'tickets', 'ticket', 'visits', 'visit', 'transactions', 'transaction',
];

/** A "by <dimension>" phrase points at the key dimension of the question. */
const DIMENSION_RE = /\bby\s+([a-z][a-z0-9 ]{1,30}?)(?:\s+(?:at|per|for|in|over|grouped|broken)\b|[?.,]|$)/i;

function snakeTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function toSnake(value: string): string {
  return snakeTokens(value).join('_').replace(/^_+|_+$/g, '');
}

/**
 * Validate + normalize a provider-suggested block name. Returns a clean
 * snake_case slug (deduped against `existing`) or undefined when the suggestion
 * is unusable.
 */
function sanitizeProviderName(suggested: string | undefined, existing: Set<string>): string | undefined {
  if (typeof suggested !== 'string') return undefined;
  let candidate = suggested.trim().toLowerCase();
  if (!candidate) return undefined;
  // Coerce light formatting (spaces / dashes / camelCase) into snake_case before
  // validating, so a well-meaning but loosely-formatted suggestion still passes.
  if (!SEMANTIC_NAME_RE.test(candidate)) {
    candidate = candidate
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }
  if (!SEMANTIC_NAME_RE.test(candidate)) return undefined;
  return dedupeSlug(candidate.slice(0, 60).replace(/_+$/, ''), existing);
}

/**
 * Rule-based semantic extraction: entity (+ key dimension + grain) from the
 * question, e.g. "total orders by geography at the daily level" →
 * `orders_by_geography_daily`. Returns undefined when no entity is recognizable.
 */
function ruleBasedName(question: string): string | undefined {
  const lower = question.toLowerCase();
  const tokens = snakeTokens(question);

  // Entity: first recognized analytic noun, singular/plural insensitive.
  const entity = ENTITY_HINTS.find((hint) => tokens.includes(hint));
  if (!entity) return undefined;

  const parts: string[] = [entity];

  // Key dimension: a "by <dimension>" phrase, reduced to its head noun.
  const dimMatch = lower.match(DIMENSION_RE);
  if (dimMatch) {
    const dim = toSnake(dimMatch[1]);
    if (dim && dim !== entity) parts.push('by', dim);
  }

  // Grain: an explicit time grain hint.
  const grainHint = GRAIN_HINTS.find((hint) => hint.re.test(lower));
  if (grainHint) parts.push(grainHint.grain);

  const slug = parts.join('_').replace(/^_+|_+$/g, '');
  return slug || undefined;
}

/** Append `_2`, `_3`, … until the slug is unused. */
function dedupeSlug(slug: string, existing: Set<string>): string {
  if (!existing.has(slug)) return slug;
  let n = 2;
  while (existing.has(`${slug}_${n}`)) n += 1;
  return `${slug}_${n}`;
}

export interface SemanticDraftNameInput {
  /** The user prompt / question that motivated the block. */
  question: string;
  /** A short snake_case name the provider suggested, if any. Preferred when valid. */
  providerName?: string;
  /** Existing block/draft slugs to dedupe against. */
  existingSlugs?: Iterable<string>;
}

/**
 * Pick a SEMANTIC snake_case name for a builder-generated block.
 *
 * Priority:
 *   1. A valid provider-suggested name (`^[a-z][a-z0-9_]*$`), deduped.
 *   2. A rule-based extraction (entity + key dimension + grain), deduped.
 *   3. The legacy question tokenizer (`deriveGeneratedDraftSlug`) — LAST resort.
 *
 * This deliberately avoids the old behavior of naming a block after the literal
 * question (e.g. `can_you_build_the_total_orders_by_geography_at_the_level`).
 */
export function deriveSemanticDraftName(input: SemanticDraftNameInput): string {
  const existing = new Set<string>(input.existingSlugs ?? []);

  const fromProvider = sanitizeProviderName(input.providerName, existing);
  if (fromProvider) return fromProvider;

  const fromRule = ruleBasedName(input.question);
  if (fromRule) return dedupeSlug(fromRule.slice(0, 60).replace(/_+$/, ''), existing);

  // Last resort: the legacy tokenizer, still deduped so re-asks don't collide.
  return dedupeSlug(deriveGeneratedDraftSlug(input.question), existing);
}

export function upsertGeneratedDraft(
  projectRoot: string,
  rec: GeneratedDraftRecord,
): GeneratedDraftBlock {
  const { filePath, relativePath } = resolveGeneratedDraftPath(projectRoot, rec);

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
      path: relativePath,
      askedTimes: next,
      proposedContractId: rec.proposedContractId,
    };
  }

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, renderGeneratedDraft(rec, relativePath));
  return {
    path: relativePath,
    askedTimes: 1,
    proposedContractId: rec.proposedContractId,
  };
}

function resolveGeneratedDraftPath(projectRoot: string, rec: GeneratedDraftRecord): { filePath: string; relativePath: string } {
  const safeDomain = (rec.proposedDomain ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/^\/+|\/+$/g, '');
  const relativePath = safeDomain && existsSync(join(projectRoot, 'domains', safeDomain))
    ? `domains/${safeDomain}/blocks/_drafts/${rec.slug}.dql`
    : `blocks/_drafts/${rec.slug}.dql`;
  return {
    filePath: join(projectRoot, relativePath),
    relativePath,
  };
}

function renderGeneratedDraft(rec: GeneratedDraftRecord, draftPath: string): string {
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
    //   dql certify --from-draft ${draftPath} \\
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

function escapeDqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
