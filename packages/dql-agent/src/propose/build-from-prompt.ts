/**
 * Unified AI BUILD engine (spec 14, part B) — ONE engine, two targets.
 *
 * `buildFromPrompt` turns a natural-language prompt into either:
 *   - target:'cell'  → a SQL snippet for an ad-hoc notebook cell (writes nothing).
 *   - target:'block' → a COMPLETE governance DRAFT written to disk via
 *                       `upsertProposedDraft`, with its Certifier verdict stored.
 *
 * It deliberately does NOT route through the governed Q&A answer-loop
 * (`answer()` / `ask_dql`). Building is a different intent: it must not leak the
 * answer-loop's self-correction reasoning, evidence tiers, or reviewStatus. We
 * reuse the lighter plumbing instead:
 *   - `pickProvider` / `provider.generate` for AI content (optional),
 *   - `loadDbtArtifacts` for offline schema grounding,
 *   - `deriveSemanticDraftName` for a semantic block name,
 *   - `resolveLocalOwner` so a draft is never born without an owner,
 *   - `upsertProposedDraft` + `Certifier` for the draft + stored verdict.
 *
 * Principles enforced here:
 *   - AI drafts, humans certify: a block is ALWAYS `status: "draft"`; this engine
 *     never writes `certified`.
 *   - Structure deterministic, content AI-optional: with no provider, the cell
 *     target returns a deterministic templated SELECT (or a helpful message in
 *     `explanation`) and the block target falls back to deterministic content.
 *     It never crashes on the offline path.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Certifier } from '@duckcodeailabs/dql-governance';
import type { BlockRecord, BlockStatus } from '@duckcodeailabs/dql-project';
import { deriveSemanticDraftName } from '../metadata/drafts.js';
import { resolveLocalOwner } from '../metadata/identity.js';
import { pickProvider } from '../providers/index.js';
import type { AgentProvider } from '../providers/types.js';
import { loadDbtArtifacts, type DbtArtifacts, type DbtModelNode } from './dbt-artifacts.js';
import { blockSlug, upsertProposedDraft, type ProposedDraftRecord } from './write-draft.js';

export interface BuildFromPromptContext {
  /** Current SQL in the focused cell (for refine/extend prompts). */
  cellSql?: string;
  /** A selected fragment the user highlighted. */
  selection?: string;
}

export interface BuildFromPromptOptions {
  projectRoot: string;
  prompt: string;
  context?: BuildFromPromptContext;
  target: 'cell' | 'block';
  /** Explicit owner; when absent the local OSS owner is resolved + stamped. */
  owner?: string;
  /**
   * Provider override (mainly for tests). When omitted the engine picks the
   * first available provider; when none is available it degrades offline.
   */
  provider?: AgentProvider;
  /**
   * Force the offline/deterministic path even if a provider is configured.
   * Used by tests for determinism (mirrors `aiEnrichment: 'off'`).
   */
  offline?: boolean;
  /** Optional explicit dbt manifest path (else auto-discovered under the project). */
  dbtManifestPath?: string;
  /** Domain for a built block draft. Defaults to `misc`. */
  domain?: string;
}

export interface BuildCellResult {
  target: 'cell';
  sql: string;
  explanation?: string;
}

export interface BuildBlockResult {
  target: 'block';
  path: string;
  name: string;
  sqlPreview: string;
  description: string;
  grain?: string;
  outputs: string[];
  examples: string[];
  certifierVerdict: CertifierVerdict;
}

export type BuildFromPromptResult = BuildCellResult | BuildBlockResult;

export interface CertifierVerdict {
  blocking: string[];
  warnings: string[];
  ready: boolean;
}

const CELL_SYSTEM_PROMPT =
  'You are a SQL generator for an analytics notebook. Given a request and the ' +
  'available schema, return ONE read-only SQL query (SELECT/WITH only). ' +
  'Respond with ONLY a JSON object — no prose, no markdown fences.';

const BLOCK_SYSTEM_PROMPT =
  'You design a reusable, governed analytics block from a natural-language request. ' +
  'Use only the schema provided; do not invent tables or columns. ' +
  'Respond with ONLY a JSON object — no prose, no markdown fences.';

/** Best-effort load of dbt artifacts for schema grounding. Never throws. */
function tryLoadArtifacts(projectRoot: string, manifestPath?: string): DbtArtifacts | undefined {
  const candidates = [
    manifestPath,
    join(projectRoot, 'target', 'manifest.json'),
    join(projectRoot, '..', 'target', 'manifest.json'),
    join(projectRoot, '..', 'dbt', 'target', 'manifest.json'),
  ].filter((p): p is string => Boolean(p));
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      return loadDbtArtifacts(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

/** Compact schema text (model → columns) the provider can ground SQL on. */
function schemaSummary(artifacts: DbtArtifacts | undefined, limit = 40): string {
  if (!artifacts || artifacts.models.length === 0) return '(no schema available)';
  const lines: string[] = [];
  for (const model of artifacts.models.slice(0, limit)) {
    const cols = effectiveColumnNames(model, artifacts).slice(0, 24);
    lines.push(`- ${model.name}(${cols.join(', ')})`);
  }
  return lines.join('\n');
}

function effectiveColumnNames(model: DbtModelNode, artifacts: DbtArtifacts): string[] {
  const catalog = artifacts.catalogColumns.get(model.uniqueId) ?? [];
  if (catalog.length > 0) return catalog.map((c) => c.name);
  return model.columns.map((c) => c.name);
}

/** Pull the first balanced JSON object out of a model response. */
function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1));
          return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown, max = 12): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim())
    .slice(0, max);
}

/** Resolve the provider for this run, honoring `offline` + explicit overrides. */
async function resolveProvider(options: BuildFromPromptOptions): Promise<AgentProvider | undefined> {
  if (options.offline) return undefined;
  if (options.provider) {
    return (await options.provider.available().catch(() => false)) ? options.provider : undefined;
  }
  const provider = await pickProvider();
  return (await provider.available().catch(() => false)) ? provider : undefined;
}

/** Deterministic, offline-safe templated SQL when no provider is available. */
function fallbackCellSql(artifacts: DbtArtifacts | undefined, context?: BuildFromPromptContext): string {
  if (context?.cellSql?.trim()) return context.cellSql.trim();
  const first = artifacts?.models[0];
  if (first) return `SELECT *\nFROM ${first.name}\nLIMIT 100`;
  return 'SELECT 1 AS placeholder';
}

/** Strip markdown fences / `sql` prefixes a provider might add around a query. */
function cleanSql(raw: string): string {
  let sql = raw.trim();
  sql = sql.replace(/^```(?:sql)?\s*/i, '').replace(/\s*```$/i, '');
  return sql.trim();
}

// ─── target: cell ───────────────────────────────────────────────────────────

async function buildCell(
  options: BuildFromPromptOptions,
  artifacts: DbtArtifacts | undefined,
  provider: AgentProvider | undefined,
): Promise<BuildCellResult> {
  if (!provider) {
    return {
      target: 'cell',
      sql: fallbackCellSql(artifacts, options.context),
      explanation:
        'No AI provider is configured. Returned a starter query — edit it, or set a provider to generate SQL from your prompt.',
    };
  }

  const parts = [
    `Request: ${options.prompt}`,
    options.context?.cellSql ? `Current cell SQL:\n${options.context.cellSql}` : null,
    options.context?.selection ? `Selected fragment:\n${options.context.selection}` : null,
    `Available schema:\n${schemaSummary(artifacts)}`,
    'Produce JSON with keys: "sql" (one read-only SELECT/WITH query) and optional "explanation" (one sentence).',
  ].filter(Boolean);

  try {
    const response = await provider.generate(
      [
        { role: 'system', content: CELL_SYSTEM_PROMPT },
        { role: 'user', content: parts.join('\n\n') },
      ],
      { maxTokens: 600, temperature: 0.1, signal: AbortSignal.timeout(25_000) },
    );
    const parsed = extractJson(response);
    const sql = parsed ? asString(parsed.sql) : undefined;
    if (sql) {
      return { target: 'cell', sql: cleanSql(sql), explanation: parsed ? asString(parsed.explanation) : undefined };
    }
  } catch {
    // Fall through to the deterministic fallback below.
  }

  return {
    target: 'cell',
    sql: fallbackCellSql(artifacts, options.context),
    explanation: 'Could not generate SQL from the prompt; returned a starter query to refine.',
  };
}

// ─── target: block ──────────────────────────────────────────────────────────

interface BlockDraftContent {
  name?: string;
  sql?: string;
  description?: string;
  grain?: string;
  outputs: string[];
  llmContext?: string;
  examples: string[];
  entities: string[];
  invariants: string[];
}

async function generateBlockContent(
  options: BuildFromPromptOptions,
  artifacts: DbtArtifacts | undefined,
  provider: AgentProvider | undefined,
): Promise<BlockDraftContent> {
  if (!provider) return { outputs: [], examples: [], entities: [], invariants: [] };

  const parts = [
    `Request: ${options.prompt}`,
    options.context?.cellSql ? `Reference SQL:\n${options.context.cellSql}` : null,
    `Available schema:\n${schemaSummary(artifacts)}`,
    'Produce JSON with keys:',
    '- "name": a short snake_case block name (entity + key dimension + grain), e.g. "orders_by_region_daily".',
    '- "sql": one read-only SELECT/WITH query answering the request, using only the schema above.',
    '- "description": one or two business-facing sentences.',
    '- "grain": the row grain (e.g. "one row per customer per day"), or "".',
    '- "outputs": array of output column names the query returns.',
    '- "llmContext": one to three sentences telling an AI agent when to use this block.',
    '- "examples": array of up to 3 business questions this block answers.',
    '- "entities": array of business entities (e.g. ["order"]).',
    '- "invariants": array of simple column predicates that should hold (e.g. ["order_count >= 0"]), or [].',
  ].filter(Boolean);

  try {
    const response = await provider.generate(
      [
        { role: 'system', content: BLOCK_SYSTEM_PROMPT },
        { role: 'user', content: parts.join('\n') },
      ],
      { maxTokens: 900, temperature: 0.2, signal: AbortSignal.timeout(25_000) },
    );
    const parsed = extractJson(response);
    if (!parsed) return { outputs: [], examples: [], entities: [], invariants: [] };
    return {
      name: asString(parsed.name),
      sql: asString(parsed.sql),
      description: asString(parsed.description),
      grain: asString(parsed.grain),
      outputs: asStringArray(parsed.outputs, 30),
      llmContext: asString(parsed.llmContext),
      examples: asStringArray(parsed.examples, 3),
      entities: asStringArray(parsed.entities, 6),
      invariants: asStringArray(parsed.invariants, 6),
    };
  } catch {
    return { outputs: [], examples: [], entities: [], invariants: [] };
  }
}

/** Scan the project for existing block/draft slugs so the namer can dedupe. */
function collectExistingSlugs(projectRoot: string): Set<string> {
  const slugs = new Set<string>();
  const dirs = [
    join(projectRoot, 'blocks'),
    join(projectRoot, 'blocks', '_drafts'),
  ];
  // Domain-scoped block + draft folders.
  const domainsRoot = join(projectRoot, 'domains');
  if (existsSync(domainsRoot)) {
    try {
      for (const domain of readdirSync(domainsRoot)) {
        dirs.push(
          join(domainsRoot, domain, 'blocks'),
          join(domainsRoot, domain, 'blocks', '_drafts'),
        );
      }
    } catch {
      // Best-effort scan.
    }
  }
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir)) {
        if (entry.endsWith('.dql')) slugs.add(entry.replace(/\.dql$/, ''));
      }
    } catch {
      // Skip unreadable dirs.
    }
  }
  return slugs;
}

function verdictFrom(result: { errors: Array<{ message: string }>; warnings: Array<{ message: string }> }): CertifierVerdict {
  return {
    blocking: result.errors.map((e) => e.message),
    warnings: result.warnings.map((w) => w.message),
    ready: result.errors.length === 0,
  };
}

async function buildBlock(
  options: BuildFromPromptOptions,
  artifacts: DbtArtifacts | undefined,
  provider: AgentProvider | undefined,
): Promise<BuildBlockResult> {
  const { projectRoot } = options;
  const owner = resolveLocalOwner(projectRoot, { explicit: options.owner });
  const domain = (options.domain ?? 'misc').trim() || 'misc';

  const content = await generateBlockContent(options, artifacts, provider);

  // Semantic name: provider suggestion → rule-based → legacy tokenizer (never the raw prompt).
  const existingSlugs = collectExistingSlugs(projectRoot);
  const name = deriveSemanticDraftName({
    question: options.prompt,
    providerName: content.name,
    existingSlugs,
  });

  // SQL: provider SQL → reference cell SQL → deterministic templated SELECT.
  const sql =
    (content.sql && cleanSql(content.sql)) ||
    (options.context?.cellSql?.trim()) ||
    fallbackCellSql(artifacts, options.context);

  const description =
    content.description || `Draft block built from prompt: "${options.prompt.slice(0, 160)}".`;
  const outputs = content.outputs;
  const examples = content.examples;
  const entities = content.entities;
  const invariants = content.invariants;
  const grain = content.grain;
  // Tag with a sensible default so the has-tags warning is satisfied.
  const tags = ['proposed', 'ai-build'];

  // Certifier verdict (stored, never used to flip status). Build a BlockRecord
  // mirroring what the draft will declare so the verdict matches the file.
  const draftRelPath = resolveDraftRelPath(projectRoot, domain, name);
  const record = toBlockRecord({
    slug: name,
    domain,
    owner,
    description,
    grain,
    outputs,
    entities,
    invariants,
    llmContext: content.llmContext,
    tags,
    gitPath: draftRelPath,
  });
  const evaluation = new Certifier().evaluate(record);
  const verdict = verdictFrom(evaluation);

  const draft: ProposedDraftRecord = {
    slug: name,
    domain,
    owner,
    description,
    sql,
    pattern: 'custom',
    grain,
    entities,
    declaredOutputs: outputs,
    llmContext: content.llmContext,
    invariants,
    examples: examples.map((question) => ({ question })),
    tags,
    sourceModel: '(ai-build prompt)',
    sourceSystems: [],
    // Store the same verdict the record produced so the review header is accurate.
    certification: {
      certified: false,
      errors: evaluation.errors,
      warnings: evaluation.warnings,
    },
  };

  const written = upsertProposedDraft(projectRoot, draft);

  return {
    target: 'block',
    path: written.path,
    name,
    sqlPreview: sql,
    description,
    grain,
    outputs,
    examples,
    certifierVerdict: verdict,
  };
}

/** Mirror of the draft-writer's path resolution (for the certifier gitPath). */
function resolveDraftRelPath(projectRoot: string, domain: string, slug: string): string {
  const safe = domain
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '');
  if (safe && existsSync(join(projectRoot, 'domains', safe))) {
    return `domains/${safe}/blocks/_drafts/${slug}.dql`;
  }
  return `blocks/_drafts/${slug}.dql`;
}

interface BlockRecordInput {
  slug: string;
  domain: string;
  owner: string;
  description: string;
  grain?: string;
  outputs: string[];
  entities: string[];
  invariants: string[];
  llmContext?: string;
  tags: string[];
  gitPath: string;
}

function toBlockRecord(input: BlockRecordInput): BlockRecord {
  const now = new Date();
  return {
    id: input.slug,
    name: input.slug,
    domain: input.domain,
    type: 'custom',
    version: '0.1.0',
    status: 'draft' as BlockStatus,
    gitRepo: '',
    gitPath: input.gitPath,
    gitCommitSha: '',
    description: input.description,
    owner: input.owner,
    tags: input.tags,
    dependencies: [],
    usedInCount: 0,
    createdAt: now,
    updatedAt: now,
    llmContext: input.llmContext,
    invariants: input.invariants,
    pattern: 'custom',
    grain: input.grain,
    entities: input.entities.length > 0 ? input.entities : undefined,
    declaredOutputs: input.outputs.length > 0 ? input.outputs : undefined,
    testAssertions: input.invariants.map((inv) => `assert ${inv}`),
  };
}

/**
 * Build from a natural-language prompt. ONE engine, two targets:
 *   - 'cell'  → returns SQL (writes nothing).
 *   - 'block' → writes a complete DRAFT and returns its path + preview fields.
 */
export async function buildFromPrompt(options: BuildFromPromptOptions): Promise<BuildFromPromptResult> {
  if (!options.prompt || !options.prompt.trim()) {
    throw new Error('buildFromPrompt requires a non-empty prompt.');
  }
  const artifacts = tryLoadArtifacts(options.projectRoot, options.dbtManifestPath);
  const provider = await resolveProvider(options);

  return options.target === 'cell'
    ? buildCell(options, artifacts, provider)
    : buildBlock(options, artifacts, provider);
}

// Re-export so callers can reuse the slugifier when needed.
export { blockSlug };
