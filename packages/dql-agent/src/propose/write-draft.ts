/**
 * Draft-queue writer for `dql propose`.
 *
 * This reuses the exact draft-writing convention the MCP `suggest_block` and the
 * Tier-2 `upsertGeneratedDraft` paths already use:
 *   - Drafts land under `domains/<domain>/blocks/_drafts/<slug>.dql` when the
 *     domain dir exists, else `blocks/_drafts/<slug>.dql`.
 *   - Files are born `status = "draft"` and are NEVER written as certified.
 *   - Re-running is idempotent: if a file already exists at the target path it
 *     is left untouched and `created: false` is returned.
 *
 * The renderer emits valid DQL (verified against the parser's accepted field
 * set) including the conservative governance metadata the Certifier reads, plus
 * the stored Certifier verdict as a comment header so a reviewer immediately
 * sees "what's missing to certify".
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface ProposedDraftRecord {
  slug: string;
  domain: string;
  owner: string;
  description: string;
  /** Block body SQL (wraps the dbt model via `{{ ref('...') }}`). */
  sql: string;
  /**
   * 'semantic' for a metric-bound block (import-adapter shape: `metric` + a
   * pre-compiled `query` that runs offline), else 'custom'. Defaults to 'custom'.
   */
  blockType?: 'custom' | 'semantic';
  /** Governed metric this block wraps (semantic blocks). Satisfies metric_wrapper. */
  metricRef?: string;
  /** Semantic dimensions the metric is grouped by (semantic blocks). */
  dimensions?: string[];
  pattern: string;
  grain?: string;
  entities: string[];
  declaredOutputs: string[];
  llmContext?: string;
  /** Review cadence (e.g. "quarterly"); AI-defaulted so the cadence warning is pre-satisfied. */
  reviewCadence?: string;
  invariants: string[];
  examples: Array<{ question: string; sql?: string }>;
  tags: string[];
  /** dbt model this draft was proposed from. */
  sourceModel: string;
  sourceSystems: string[];
  /** Stored Certifier verdict — surfaced as a review header, not as status. */
  certification: {
    certified: false;
    errors: Array<{ rule: string; message: string }>;
    warnings: Array<{ rule: string; message: string }>;
  };
}

export interface WrittenDraft {
  path: string;
  /** false when an existing block was found and left untouched (idempotent). */
  created: boolean;
}

/** Slugify a model name into a kebab/snake block id (snake to match dbt). */
export function blockSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || 'proposed_block';
}

function normalizeDomainFolder(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '');
}

/** Resolve the draft path exactly like suggest_block / upsertGeneratedDraft. */
function resolveDraftPath(
  projectRoot: string,
  domain: string,
  slug: string,
): { filePath: string; relativePath: string } {
  const safeDomain = normalizeDomainFolder(domain);
  const relativePath =
    safeDomain && existsSync(join(projectRoot, 'domains', safeDomain))
      ? `domains/${safeDomain}/blocks/_drafts/${slug}.dql`
      : `blocks/_drafts/${slug}.dql`;
  return { filePath: join(projectRoot, relativePath), relativePath };
}

/**
 * Write the proposed draft. Idempotent: an existing file at the target path is
 * left untouched. We additionally check the canonical (non-draft) domain block
 * path so a re-run never re-proposes a block a human already promoted.
 */
export function upsertProposedDraft(
  projectRoot: string,
  rec: ProposedDraftRecord,
): WrittenDraft {
  const { filePath, relativePath } = resolveDraftPath(projectRoot, rec.domain, rec.slug);
  const safeDomain = normalizeDomainFolder(rec.domain);

  // Canonical promoted locations — if the human already certified/moved it,
  // do not re-propose.
  const promotedCandidates = [
    safeDomain ? join(projectRoot, 'domains', safeDomain, 'blocks', `${rec.slug}.dql`) : undefined,
    join(projectRoot, 'blocks', `${rec.slug}.dql`),
  ].filter((p): p is string => Boolean(p));

  if (existsSync(filePath) || promotedCandidates.some((p) => existsSync(p))) {
    return { path: relativePath, created: false };
  }

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, renderProposedDraft(rec, relativePath), 'utf-8');
  return { path: relativePath, created: true };
}

function escapeString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function stringArray(name: string, values: string[]): string {
  if (values.length === 0) return '';
  return `\n  ${name} = [${values.map((v) => `"${escapeString(v)}"`).join(', ')}]`;
}

/** Render the full draft block as canonical DQL text. */
export function renderProposedDraft(rec: ProposedDraftRecord, draftPath: string): string {
  const header = renderReviewHeader(rec, draftPath);

  const grainLine = rec.grain ? `\n  grain = "${escapeString(rec.grain)}"` : '';
  const entitiesLine = stringArray('entities', rec.entities);
  const outputsLine = stringArray('outputs', rec.declaredOutputs);
  const sourceSystemsLine = stringArray('sourceSystems', rec.sourceSystems);
  const tagsLine = stringArray('tags', rec.tags);
  const llmContextLine = rec.llmContext
    ? `\n  llmContext = "${escapeString(rec.llmContext)}"`
    : '';
  const reviewCadenceLine = rec.reviewCadence
    ? `\n  reviewCadence = "${escapeString(rec.reviewCadence)}"`
    : '';
  const invariantsLine = stringArray('invariants', rec.invariants);
  const examplesBlock = renderExamples(rec.examples);
  const testsBlock = renderTests(rec.invariants);
  const ownerLine = rec.owner ? `\n  owner = "${escapeString(rec.owner)}"` : '';
  // Semantic (metric-bound) block: declare the governed metric + dimensions. The
  // pre-compiled `query` below keeps it runnable offline (import-adapter shape).
  const blockType = rec.blockType ?? 'custom';
  const metricLine = blockType === 'semantic' && rec.metricRef
    ? `\n  metric = "${escapeString(rec.metricRef)}"`
    : '';
  const dimensionsLine = stringArray('dimensions', rec.dimensions ?? []);

  return `// dql-format: 1
${header}block "${rec.slug}" {
  domain = "${escapeString(rec.domain)}"
  type = "${blockType}"
  status = "draft"
  description = "${escapeString(rec.description)}"${ownerLine}${metricLine}
  pattern = "${escapeString(rec.pattern)}"${grainLine}${entitiesLine}${outputsLine}${dimensionsLine}${sourceSystemsLine}${tagsLine}${llmContextLine}${reviewCadenceLine}${invariantsLine}

  query = """
${indent(rec.sql, 4)}
  """${examplesBlock}${testsBlock}
}
`;
}

/**
 * A comment header that records the stored Certifier verdict so a reviewer sees
 * exactly what is missing before this draft can be promoted to certified.
 */
function renderReviewHeader(rec: ProposedDraftRecord, draftPath: string): string {
  const lines: string[] = [
    `// Proposed DRAFT from dbt model "${rec.sourceModel}". NOT certified.`,
    `// AI drafts, humans certify — review grain/outputs/invariants/SQL, then:`,
    `//   dql certify --from-draft ${draftPath} --owner you@example.com`,
    `//`,
    `// Certifier verdict at proposal time: NOT certifiable.`,
  ];
  if (rec.certification.errors.length > 0) {
    lines.push(`// Blocking (${rec.certification.errors.length}):`);
    for (const err of rec.certification.errors) {
      lines.push(`//   - ${err.rule}: ${err.message}`);
    }
  }
  if (rec.certification.warnings.length > 0) {
    lines.push(`// Warnings (${rec.certification.warnings.length}):`);
    for (const warn of rec.certification.warnings) {
      lines.push(`//   - ${warn.rule}: ${warn.message}`);
    }
  }
  return lines.join('\n') + '\n';
}

function renderExamples(examples: Array<{ question: string; sql?: string }>): string {
  if (examples.length === 0) return '';
  const entries = examples
    .map((ex) => {
      const sqlPart = ex.sql ? `, sql = "${escapeString(ex.sql)}"` : '';
      return `    { question = "${escapeString(ex.question)}"${sqlPart} }`;
    })
    .join(',\n');
  return `\n\n  examples = [\n${entries}\n  ]`;
}

/**
 * Emit `tests { assert ... }` mirroring the safe invariants. The parser accepts
 * `assert <field> <op> <number>`; our invariants are of that shape.
 */
function renderTests(invariants: string[]): string {
  if (invariants.length === 0) return '';
  const asserts = invariants.map((inv) => `    assert ${inv}`).join('\n');
  return `\n\n  tests {\n${asserts}\n  }`;
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? pad + line : line))
    .join('\n');
}
