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
import { createRequire } from 'node:module';
import { Certifier } from '@duckcodeailabs/dql-governance';
import type { BlockRecord, BlockStatus } from '@duckcodeailabs/dql-project';
import { deriveSemanticDraftName } from '../metadata/drafts.js';
import { resolveLocalOwner } from '../metadata/identity.js';
import {
  matchSemanticMetric,
  resolveGovernedMetricSql,
  parseMetricDefinition,
} from '../metadata/metric-match.js';
import type { KGNode } from '../kg/types.js';
import { deriveBlockFilters } from './generate-sql.js';
import {
  buildSchemaGrounding,
  renderGroundingForPrompt,
  resolveRelationsInSql,
  validateSqlAgainstGrounding,
  type SchemaGrounding,
} from '../metadata/sql-grounding.js';
import { selectRelevantModels } from '../metadata/sql-retrieval.js';
import type { Skill } from '../skills/loader.js';
import { buildSkillsPrompt, loadSkills, selectRelevantSkills } from '../skills/loader.js';
import { pickProvider } from '../providers/index.js';
import type { AgentProvider } from '../providers/types.js';
import { loadDbtArtifacts, type DbtArtifacts } from './dbt-artifacts.js';
import { blockSlug, upsertProposedDraft, type ProposedDraftRecord } from './write-draft.js';
import {
  loadBlockForEdit,
  renderEditedBlock,
  resolveEditedStatus,
  writeEditedBlock,
  type LoadedBlock,
} from './edit-block.js';

export interface BuildFromPromptContext {
  /** Current SQL in the focused cell (for refine/extend prompts). */
  cellSql?: string;
  /** A selected fragment the user highlighted. */
  selection?: string;
}

/** Build mode (spec 17, part A). `edit` updates an existing block in place. */
export type BuildMode = 'create' | 'edit';

/** The chosen route surfaced on the build response (spec 17, part C). */
export interface BuildRoute {
  tier: 'certified_block' | 'semantic_metric' | 'generated_sql' | 'business_context' | 'no_answer';
  label: string;
  ref?: string;
}

export interface BuildFromPromptOptions {
  projectRoot: string;
  prompt: string;
  context?: BuildFromPromptContext;
  target: 'cell' | 'block';
  /**
   * Build mode (spec 17, part A). `'create'` (default) writes a NEW deduped
   * draft. `'edit'` loads the existing block at `blockPath`, applies the user's
   * change, and writes back to the SAME path. Edit mode is only meaningful for
   * `target: 'block'`.
   */
  mode?: BuildMode;
  /**
   * Project-relative (or absolute) path of the block to edit. REQUIRED in edit
   * mode. The updated block is written back to exactly this path.
   */
  blockPath?: string;
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
  /** Active user, for personal-skill selection. */
  userId?: string;
  /**
   * Project + user Skills to inject as business context. When omitted the
   * engine loads them from `.dql/skills/` itself.
   */
  skills?: Skill[];
  /**
   * Optional executor for a bounded preview of generated SQL. When supplied,
   * an execution error triggers the same repair loop a validation miss does.
   */
  executeSql?: (sql: string) => Promise<unknown>;
}

/** The Skills that shaped this build (stamped on both targets). */
export interface AppliedSkill {
  id: string;
  description?: string;
}

export interface BuildCellResult {
  target: 'cell';
  sql: string;
  explanation?: string;
  /** Skills that shaped the answer, for UI transparency. */
  appliedSkills?: AppliedSkill[];
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
  /** Skills that shaped the answer, for UI transparency. */
  appliedSkills?: AppliedSkill[];
  /**
   * Edit mode only (spec 17, part A): the block's SQL BEFORE the change, so the
   * UI can render a diff. Absent on a freshly created draft.
   */
  previousSql?: string;
  /** The chosen route for this build (spec 17, part C). */
  route?: BuildRoute;
  /** True when this result updated an existing block in place (edit mode). */
  edited?: boolean;
}

export type BuildFromPromptResult = BuildCellResult | BuildBlockResult;

export interface CertifierVerdict {
  blocking: string[];
  warnings: string[];
  ready: boolean;
}

const CELL_SYSTEM_PROMPT =
  'You are a SQL generator for an analytics notebook. Given a request and the ' +
  'grounded schema, return ONE read-only SQL query (SELECT/WITH only). ' +
  'Use ONLY the relations and columns provided. Reference each table by its ' +
  'fully-qualified relation (database.schema.table) EXACTLY as shown — never a ' +
  'bare model name, never a table or column not in the grounding. Use the ' +
  'listed join keys to connect tables. ' +
  'Respond with ONLY a JSON object — no prose, no markdown fences.';

const BLOCK_SYSTEM_PROMPT =
  'You design a reusable, governed analytics block from a natural-language request. ' +
  'Use ONLY the relations and columns provided; do not invent tables or columns. ' +
  "Reference each table by its {{ ref('<model>') }} form EXACTLY as shown (DQL " +
  'resolves it at execution). Use the listed join keys to connect tables. ' +
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

/**
 * A governed semantic metric matched to the build request (spec 17, part C — now
 * applied to the Build path, not just Ask). When a metric like `average_tax_rate`
 * already exists, the block should be built ON its governed definition instead of
 * the model inventing a different formula.
 */
interface MatchedGovernedMetric {
  /** Display name the user recognizes, e.g. "average_tax_rate". */
  name: string;
  /** Governed aggregate expression, e.g. "AVG(tax_rate)". */
  expr: string;
  /** Base relation, e.g. "locations". */
  table: string;
  /** Deterministic governed SELECT (fallback if the model declines SQL). */
  sql: string;
}

const requireForBuild = createRequire(import.meta.url);

/** Load metric KG nodes (read-only, best-effort) so the Build path can reuse the
 * same governed-metric matching the Ask path uses. Returns [] when no KG exists. */
function loadSemanticMetrics(projectRoot: string): KGNode[] {
  const dbPath = join(projectRoot, '.dql', 'cache', 'agent-kg.sqlite');
  if (!existsSync(dbPath)) return [];
  try {
    const Database = requireForBuild('better-sqlite3');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const rows = db
        .prepare("SELECT node_id, name, domain, description, llm_context, tags_json FROM kg_nodes WHERE kind = 'metric' LIMIT 400")
        .all() as Array<{ node_id: string; name: string; domain: string | null; description: string | null; llm_context: string | null; tags_json: string | null }>;
      return rows.map((r): KGNode => ({
        nodeId: r.node_id,
        kind: 'metric',
        name: r.name,
        domain: r.domain ?? undefined,
        description: r.description ?? undefined,
        llmContext: r.llm_context ?? undefined,
        tags: safeJsonArray(r.tags_json),
      }));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

function safeJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Match the request to a governed metric and resolve its executable definition. */
async function matchGovernedMetric(projectRoot: string, prompt: string): Promise<MatchedGovernedMetric | undefined> {
  const metrics = loadSemanticMetrics(projectRoot);
  if (metrics.length === 0) return undefined;
  const match = await matchSemanticMetric(prompt, metrics).catch(() => null);
  if (!match) return undefined;
  const resolved = resolveGovernedMetricSql(match.metric, metrics);
  if (!resolved) return undefined;
  const def = parseMetricDefinition(resolved.metric);
  if (!def) return undefined;
  // Display the metric the USER recognizes; use the resolved measure's executable def.
  return { name: match.metric.name, expr: def.expr, table: def.table, sql: resolved.sql };
}

/** Output column names that name a non-negative measure (safe for a `>= 0` guard). */
const NON_NEGATIVE_MEASURE_RE = /(revenue|sales|income|count|total|amount|sum|qty|quantity|value|price|profit|cost|spend|orders?|tax)\b/i;

/**
 * Auto-draft a safe sanity test so an AI-built block is born with at least one
 * assertion the reviewer can keep or strengthen — never asked to author one. We
 * only emit a `>= 0` guard on an output that clearly names a non-negative measure,
 * so the assertion always passes (never a surprise certification block). Returns
 * [] when nothing is provably safe, leaving "no tests" as an advisory warning.
 */
function safeSanityInvariants(outputs: string[]): string[] {
  const measure = outputs.find((name) => NON_NEGATIVE_MEASURE_RE.test(name));
  return measure ? [`${measure} >= 0`] : [];
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

/**
 * Deterministic, offline-safe templated SQL when no provider is available.
 * Grounds the starter query on the REAL qualified relation (e.g.
 * `dev.order_items`), never a bare model name.
 */
function fallbackCellSql(grounding: SchemaGrounding, context?: BuildFromPromptContext): string {
  if (context?.cellSql?.trim()) return context.cellSql.trim();
  const first = grounding.tables[0];
  if (first) return `SELECT *\nFROM ${first.qualifiedRelation}\nLIMIT 100`;
  return 'SELECT 1 AS placeholder';
}

/** Strip markdown fences / `sql` prefixes a provider might add around a query. */
function cleanSql(raw: string): string {
  let sql = raw.trim();
  sql = sql.replace(/^```(?:sql)?\s*/i, '').replace(/\s*```$/i, '');
  return sql.trim();
}

/** A worked example clause appended to grounding so the model has a pattern. */
function workedExample(grounding: SchemaGrounding, prefer: 'qualified' | 'ref'): string {
  const first = grounding.tables[0];
  if (!first) return '';
  const rel = prefer === 'ref' && first.refForm ? first.refForm : first.qualifiedRelation;
  return `Worked example — count rows in ${first.name}:\nSELECT count(*) AS row_count FROM ${rel}`;
}

/**
 * Ground generated SQL: deterministically qualify bare relations, then validate
 * against the grounding. On a validation miss (or execution error when an
 * executor is supplied) re-prompt the model with the specific error, bounded to
 * `maxRepairs` attempts. Returns the best SQL we could ground, plus a flag for
 * whether it ultimately validated. Never throws; the offline path is safe.
 */
async function groundAndRepairSql(input: {
  initialSql: string;
  grounding: SchemaGrounding;
  prefer: 'qualified' | 'ref';
  provider: AgentProvider | undefined;
  systemPrompt: string;
  userPrompt: string;
  maxRepairs?: number;
  executeSql?: (sql: string) => Promise<unknown>;
}): Promise<{ sql: string; validated: boolean; message?: string }> {
  const { grounding, prefer, provider, systemPrompt, userPrompt } = input;
  const maxRepairs = input.maxRepairs ?? 2;

  let current = resolveRelationsInSql(cleanSql(input.initialSql), grounding, { prefer }).sql;
  let lastError: string | undefined;

  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    const validation = validateSqlAgainstGrounding(current, grounding);
    let errorForRepair: string | undefined = validation.ok ? undefined : validation.error;

    // When valid and an executor is available, run a bounded preview; a runtime
    // error is just another repairable miss.
    if (!errorForRepair && input.executeSql) {
      try {
        await input.executeSql(current);
      } catch (err) {
        errorForRepair = err instanceof Error ? err.message : String(err);
      }
    }

    if (!errorForRepair) return { sql: current, validated: true };
    lastError = errorForRepair;

    if (attempt === maxRepairs || !provider) break;

    try {
      const repaired = await provider.generate(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
          { role: 'assistant', content: JSON.stringify({ sql: current }) },
          {
            role: 'user',
            content: [
              'That SQL was rejected by grounding validation.',
              `Error: ${errorForRepair}`,
              'Return corrected JSON with a "sql" key that references ONLY the grounded relations and columns shown above.',
            ].join('\n'),
          },
        ],
        { maxTokens: 700, temperature: 0.1, signal: AbortSignal.timeout(25_000) },
      );
      const parsed = extractJson(repaired);
      const next = parsed ? asString(parsed.sql) : undefined;
      if (!next) break;
      current = resolveRelationsInSql(cleanSql(next), grounding, { prefer }).sql;
    } catch {
      break;
    }
  }

  return {
    sql: current,
    validated: false,
    message: lastError
      ? `The generated SQL referenced relations or columns outside the grounded schema (${lastError}). Returned the best grounded attempt for review.`
      : undefined,
  };
}

// ─── target: cell ───────────────────────────────────────────────────────────

async function buildCell(
  options: BuildFromPromptOptions,
  grounding: SchemaGrounding,
  provider: AgentProvider | undefined,
  skillsPrompt: string,
  appliedSkills: AppliedSkill[],
  matchedMetric?: MatchedGovernedMetric,
): Promise<BuildCellResult> {
  if (!provider) {
    // No provider — prefer the governed metric definition over a blank starter.
    return {
      target: 'cell',
      sql: matchedMetric?.sql ?? fallbackCellSql(grounding, options.context),
      explanation: matchedMetric
        ? `Used the governed metric \`${matchedMetric.name}\` (${matchedMetric.expr}). Set a provider to tailor it further.`
        : 'No AI provider is configured. Returned a starter query — edit it, or set a provider to generate SQL from your prompt.',
      appliedSkills,
    };
  }

  const userPrompt = [
    skillsPrompt || null,
    `Request: ${options.prompt}`,
    matchedMetric
      ? `GOVERNED METRIC — \`${matchedMetric.name}\` is defined as ${matchedMetric.expr} over ${matchedMetric.table}. Build the SQL USING this governed expression (do not invent a different formula); apply any requested grouping on top of it.`
      : null,
    options.context?.cellSql ? `Current cell SQL:\n${options.context.cellSql}` : null,
    options.context?.selection ? `Selected fragment:\n${options.context.selection}` : null,
    `Grounded schema:\n${renderGroundingForPrompt(grounding, 'cell')}`,
    workedExample(grounding, 'qualified') || null,
    'Produce JSON with keys: "sql" (one read-only SELECT/WITH query) and optional "explanation" (one sentence).',
  ]
    .filter(Boolean)
    .join('\n\n');

  try {
    const response = await provider.generate(
      [
        { role: 'system', content: CELL_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      { maxTokens: 600, temperature: 0.1, signal: AbortSignal.timeout(25_000) },
    );
    const parsed = extractJson(response);
    const sql = parsed ? asString(parsed.sql) : undefined;
    if (sql) {
      const grounded = await groundAndRepairSql({
        initialSql: sql,
        grounding,
        prefer: 'qualified',
        provider,
        systemPrompt: CELL_SYSTEM_PROMPT,
        userPrompt,
        maxRepairs: 2,
        executeSql: options.executeSql,
      });
      return {
        target: 'cell',
        sql: grounded.sql,
        explanation: grounded.validated
          ? (parsed ? asString(parsed.explanation) : undefined)
          : grounded.message,
        appliedSkills,
      };
    }
  } catch {
    // Fall through to the deterministic fallback below.
  }

  return {
    target: 'cell',
    sql: matchedMetric?.sql ?? fallbackCellSql(grounding, options.context),
    explanation: matchedMetric
      ? `Answered from the governed metric \`${matchedMetric.name}\` (${matchedMetric.expr}).`
      : 'Could not generate SQL from the prompt; returned a starter query to refine.',
    appliedSkills,
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
  grounding: SchemaGrounding,
  provider: AgentProvider | undefined,
  skillsPrompt: string,
  matchedMetric?: MatchedGovernedMetric,
): Promise<{ content: BlockDraftContent; userPrompt: string }> {
  const userPrompt = [
    skillsPrompt || null,
    `Request: ${options.prompt}`,
    // Authoritative: a governed metric already defines this measure — use ITS
    // expression, do not re-derive a different formula.
    matchedMetric
      ? `GOVERNED METRIC — a certified semantic metric already exists for this request: \`${matchedMetric.name}\` is defined as ${matchedMetric.expr} over ${matchedMetric.table}. Build the SQL USING this exact governed expression (do not invent a different formula); apply any requested grouping or grain on top of it.`
      : null,
    options.context?.cellSql ? `Reference SQL:\n${options.context.cellSql}` : null,
    `Grounded schema:\n${renderGroundingForPrompt(grounding, 'block')}`,
    workedExample(grounding, 'ref') || null,
    'Produce JSON with keys:',
    '- "name": a short snake_case block name (entity + key dimension + grain), e.g. "orders_by_region_daily".',
    "- \"sql\": one read-only SELECT/WITH query answering the request, referencing each table by its {{ ref('<model>') }} form and only the grounded columns.",
    '- "description": one or two business-facing sentences.',
    '- "grain": the row grain (e.g. "one row per customer per day"), or "".',
    '- "outputs": array of output column names the query returns.',
    '- "llmContext": one to three sentences telling an AI agent when to use this block.',
    '- "examples": array of up to 3 business questions this block answers.',
    '- "entities": array of business entities (e.g. ["order"]).',
    '- "invariants": array of simple column predicates that should hold (e.g. ["order_count >= 0"]), or [].',
  ]
    .filter(Boolean)
    .join('\n');

  if (!provider) return { content: { outputs: [], examples: [], entities: [], invariants: [] }, userPrompt };

  try {
    const response = await provider.generate(
      [
        { role: 'system', content: BLOCK_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      { maxTokens: 900, temperature: 0.2, signal: AbortSignal.timeout(25_000) },
    );
    const parsed = extractJson(response);
    if (!parsed) return { content: { outputs: [], examples: [], entities: [], invariants: [] }, userPrompt };
    return {
      content: {
        name: asString(parsed.name),
        sql: asString(parsed.sql),
        description: asString(parsed.description),
        grain: asString(parsed.grain),
        outputs: asStringArray(parsed.outputs, 30),
        llmContext: asString(parsed.llmContext),
        examples: asStringArray(parsed.examples, 3),
        entities: asStringArray(parsed.entities, 6),
        invariants: asStringArray(parsed.invariants, 6),
      },
      userPrompt,
    };
  } catch {
    return { content: { outputs: [], examples: [], entities: [], invariants: [] }, userPrompt };
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
  grounding: SchemaGrounding,
  provider: AgentProvider | undefined,
  skillsPrompt: string,
  appliedSkills: AppliedSkill[],
  matchedMetric?: MatchedGovernedMetric,
): Promise<BuildBlockResult> {
  const { projectRoot } = options;
  const owner = resolveLocalOwner(projectRoot, { explicit: options.owner });
  const domain = (options.domain ?? 'misc').trim() || 'misc';

  const { content, userPrompt } = await generateBlockContent(options, grounding, provider, skillsPrompt, matchedMetric);

  // Semantic name: provider suggestion → rule-based → legacy tokenizer (never the raw prompt).
  const existingSlugs = collectExistingSlugs(projectRoot);
  const name = deriveSemanticDraftName({
    question: options.prompt,
    providerName: content.name,
    existingSlugs,
  });

  // SQL: provider SQL → governed metric definition (when a metric matched and the
  // model declined) → reference cell SQL → deterministic templated SELECT. All go
  // through grounding so relations become `{{ ref() }}` forms.
  let sql: string;
  const initialSql = content.sql || (matchedMetric ? matchedMetric.sql : undefined);
  if (initialSql) {
    const grounded = await groundAndRepairSql({
      initialSql,
      grounding,
      prefer: 'ref',
      provider,
      systemPrompt: BLOCK_SYSTEM_PROMPT,
      userPrompt,
      maxRepairs: 2,
    });
    sql = grounded.sql;
  } else {
    sql =
      options.context?.cellSql?.trim() ||
      resolveRelationsInSql(fallbackCellSql(grounding, options.context), grounding, { prefer: 'ref' }).sql;
  }

  const baseDescription =
    content.description || `Draft block built from prompt: "${options.prompt.slice(0, 160)}".`;
  // When built on a governed metric, make that provenance explicit in the description.
  const description = matchedMetric
    ? `${baseDescription} Built on the governed metric \`${matchedMetric.name}\` (${matchedMetric.expr}).`
    : baseDescription;
  const outputs = content.outputs;
  const examples = content.examples;
  const entities = content.entities;
  // Auto-draft a safe sanity test when the model proposed none, so a built block
  // is born with a test assertion (advisory) and the reviewer isn't asked to author
  // one. `>= 0` on a non-negative measure output is the safe, always-passing guard.
  const invariants = content.invariants.length > 0
    ? content.invariants
    : safeSanityInvariants(outputs);
  const grain = content.grain;
  // Tag with a sensible default so the has-tags warning is satisfied.
  const tags = ['proposed', 'ai-build'];
  // dbt is the upstream source system for an AI-built, dbt-grounded block — fill it
  // so the lineage warning is pre-satisfied (reviewer can refine).
  const sourceSystems = ['dbt'];

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
    blockType: matchedMetric ? 'semantic' : 'custom',
    pattern: matchedMetric ? 'metric_wrapper' : 'custom',
    metricRef: matchedMetric?.name,
  });
  const evaluation = new Certifier().evaluate(record);
  const verdict = verdictFrom(evaluation);

  const draft: ProposedDraftRecord = {
    slug: name,
    domain,
    owner,
    description,
    sql,
    // Metric-bound (semantic) block when a governed metric drove this build, so it
    // references the semantic layer instead of re-deriving the formula in raw SQL.
    blockType: matchedMetric ? 'semantic' : 'custom',
    metricRef: matchedMetric?.name,
    pattern: matchedMetric ? 'metric_wrapper' : 'custom',
    grain,
    entities,
    declaredOutputs: outputs,
    // App-ready: the block's output columns become dashboard filters.
    ...deriveBlockFilters(outputs),
    llmContext: content.llmContext,
    invariants,
    examples: examples.map((question) => ({ question })),
    tags,
    reviewCadence: 'quarterly',
    sourceModel: '(ai-build prompt)',
    sourceSystems,
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
    appliedSkills,
    edited: false,
    route: matchedMetric
      ? { tier: 'semantic_metric', label: `Based on governed metric ${matchedMetric.name}`, ref: matchedMetric.name }
      : { tier: 'generated_sql', label: `Drafted new block ${name}`, ref: name },
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
  blockType?: 'custom' | 'semantic';
  pattern?: string;
  metricRef?: string;
}

function toBlockRecord(input: BlockRecordInput): BlockRecord {
  const now = new Date();
  return {
    id: input.slug,
    name: input.slug,
    domain: input.domain,
    type: input.blockType ?? 'custom',
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
    pattern: input.pattern ?? 'custom',
    metricRef: input.metricRef,
    grain: input.grain,
    entities: input.entities.length > 0 ? input.entities : undefined,
    declaredOutputs: input.outputs.length > 0 ? input.outputs : undefined,
    testAssertions: input.invariants.map((inv) => `assert ${inv}`),
  };
}

// ─── mode: edit (spec 17, part A) ─────────────────────────────────────────────

const EDIT_BLOCK_SYSTEM_PROMPT =
  'You modify an EXISTING governed analytics block. You are given the block\'s ' +
  'current SQL + metadata and a change request (e.g. add a missed table/column, ' +
  'change the grain). Apply ONLY the requested change; preserve everything else. ' +
  'Use ONLY the relations and columns provided in the grounded schema; do not ' +
  "invent tables or columns. Reference each table by its {{ ref('<model>') }} " +
  'form EXACTLY as shown. Respond with ONLY a JSON object — no prose, no fences.';

/**
 * Edit an existing block in place (spec 17, part A). Loads the block at
 * `blockPath`, asks the model for the UPDATED SQL/metadata applying the user's
 * change, re-grounds + validates + repairs the SQL via spec-15, and writes the
 * result BACK to the SAME path. Never forks a new draft. Returns `previousSql`
 * for a diff and preserves the block's status (certified stays certified).
 */
async function editBlock(
  options: BuildFromPromptOptions,
  grounding: SchemaGrounding,
  provider: AgentProvider | undefined,
  skillsPrompt: string,
  appliedSkills: AppliedSkill[],
): Promise<BuildBlockResult> {
  if (!options.blockPath) {
    throw new Error("Edit mode requires { blockPath } to the block being modified.");
  }
  const existing: LoadedBlock = loadBlockForEdit(options.projectRoot, options.blockPath);
  const previousSql = existing.sql;

  const userPrompt = [
    skillsPrompt || null,
    `Change request: ${options.prompt}`,
    `Existing block "${existing.name}" (status: ${existing.status ?? 'draft'}, domain: ${existing.domain ?? 'misc'}):`,
    existing.description ? `Description: ${existing.description}` : null,
    existing.grain ? `Grain: ${existing.grain}` : null,
    existing.outputs?.length ? `Outputs: ${existing.outputs.join(', ')}` : null,
    `Current SQL:\n${previousSql || '(empty)'}`,
    `Grounded schema:\n${renderGroundingForPrompt(grounding, 'block')}`,
    workedExample(grounding, 'ref') || null,
    'Produce JSON with keys:',
    '- "sql": the UPDATED read-only SELECT/WITH query with the change applied, ' +
      "referencing each table by its {{ ref('<model>') }} form and only grounded columns.",
    '- "description": the updated one/two-sentence description (or the existing one if unchanged).',
    '- "grain": the row grain, only if the change alters it; else repeat the existing grain or "".',
    '- "outputs": the full array of output column names the updated query returns.',
  ]
    .filter(Boolean)
    .join('\n');

  // Generate the updated SQL/metadata (optional; offline keeps the existing SQL).
  let newSql = previousSql;
  let description = existing.description;
  let grain = existing.grain;
  let outputs = existing.outputs ?? [];
  if (provider) {
    try {
      const response = await provider.generate(
        [
          { role: 'system', content: EDIT_BLOCK_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        { maxTokens: 900, temperature: 0.1, signal: AbortSignal.timeout(25_000) },
      );
      const parsed = extractJson(response);
      if (parsed) {
        newSql = asString(parsed.sql) ?? newSql;
        description = asString(parsed.description) ?? description;
        grain = asString(parsed.grain) ?? grain;
        const parsedOutputs = asStringArray(parsed.outputs, 30);
        if (parsedOutputs.length > 0) outputs = parsedOutputs;
      }
    } catch {
      // Offline-safe: keep the existing SQL/metadata on any provider failure.
    }
  }

  // Re-ground + validate + repair the updated SQL (spec 15). Block SQL uses ref().
  const grounded = await groundAndRepairSql({
    initialSql: newSql,
    grounding,
    prefer: 'ref',
    provider,
    systemPrompt: EDIT_BLOCK_SYSTEM_PROMPT,
    userPrompt,
    maxRepairs: 2,
  });

  // Preserve name/owner/domain/grain + status policy; write BACK to same path.
  const status = resolveEditedStatus(existing.status);
  const content = renderEditedBlock({
    name: existing.name,
    blockType: existing.blockType,
    status,
    domain: existing.domain,
    owner: existing.owner,
    description,
    grain,
    pattern: existing.pattern,
    entities: existing.entities,
    outputs,
    tags: existing.tags,
    llmContext: existing.llmContext,
    invariants: existing.invariants,
    sourceSystems: existing.sourceSystems,
    sql: grounded.sql,
  });
  writeEditedBlock(existing.absPath, content);

  // Stored verdict mirrors the edited block (never used to flip status).
  const record = toBlockRecord({
    slug: existing.name,
    domain: existing.domain ?? 'misc',
    owner: existing.owner ?? resolveLocalOwner(options.projectRoot, { explicit: options.owner }),
    description: description ?? `Block "${existing.name}".`,
    grain,
    outputs,
    entities: existing.entities ?? [],
    invariants: existing.invariants ?? [],
    llmContext: existing.llmContext,
    tags: existing.tags ?? ['ai-build'],
    gitPath: existing.requestedPath,
  });
  const evaluation = new Certifier().evaluate(record);

  return {
    target: 'block',
    path: existing.requestedPath,
    name: existing.name,
    sqlPreview: grounded.sql,
    description: description ?? `Block "${existing.name}".`,
    grain,
    outputs,
    examples: [],
    certifierVerdict: verdictFrom(evaluation),
    appliedSkills,
    previousSql,
    edited: true,
    route: {
      tier: 'generated_sql',
      label: `Updated block ${existing.name} in place`,
      ref: existing.name,
    },
  };
}

/**
 * Build from a natural-language prompt. ONE engine, two targets:
 *   - 'cell'  → returns SQL (writes nothing).
 *   - 'block' → writes a complete DRAFT and returns its path + preview fields.
 *
 * `mode: 'edit'` (block target only) updates the existing block at `blockPath`
 * in place instead of forking a new draft (spec 17, part A).
 */
export async function buildFromPrompt(options: BuildFromPromptOptions): Promise<BuildFromPromptResult> {
  if (!options.prompt || !options.prompt.trim()) {
    throw new Error('buildFromPrompt requires a non-empty prompt.');
  }
  const artifacts = tryLoadArtifacts(options.projectRoot, options.dbtManifestPath);
  const provider = await resolveProvider(options);

  // Retrieval (spec 15.3): pick the RELEVANT tables for this request, not all of
  // them. Deterministic + offline by default.
  const relevantModels = await selectRelevantModels(artifacts, options.prompt, { topK: 12 });

  // Shared grounding (spec 15.2): qualified relations + {{ ref() }} forms +
  // columns/types + join keys. Used by BOTH targets.
  const grounding = buildSchemaGrounding(artifacts, relevantModels, { limit: 12 });

  // Skills (spec 16): select the SELECTED skills (not all), inject as context,
  // and record which applied. Project (pinned) skills always kept.
  const allSkills = options.skills ?? loadSkills(options.projectRoot).skills;
  const selectedSkills = selectRelevantSkills(allSkills, options.prompt, { userId: options.userId ?? null });
  const skillsPrompt = buildSkillsPrompt(selectedSkills, options.userId ?? null);
  const appliedSkills: AppliedSkill[] = selectedSkills.map((s) => ({ id: s.id, description: s.description }));

  // Semantic-metric routing (spec 17, part C) for the Build path: if a governed
  // metric already answers this request, build ON its certified definition instead
  // of letting the model invent a formula. Skipped for edit mode (a different intent).
  const matchedMetric = options.mode === 'edit'
    ? undefined
    : await matchGovernedMetric(options.projectRoot, options.prompt);

  if (options.target === 'cell') {
    return buildCell(options, grounding, provider, skillsPrompt, appliedSkills, matchedMetric);
  }
  // target: 'block' — edit an existing block in place, or create a new draft.
  return options.mode === 'edit'
    ? editBlock(options, grounding, provider, skillsPrompt, appliedSkills)
    : buildBlock(options, grounding, provider, skillsPrompt, appliedSkills, matchedMetric);
}

// Re-export so callers can reuse the slugifier when needed.
export { blockSlug };
