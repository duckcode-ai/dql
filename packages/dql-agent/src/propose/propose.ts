/**
 * `dql propose` engine — turn dbt evidence into a ranked queue of DRAFT blocks.
 *
 * Product principle: **AI drafts, humans certify.** A new user should not author
 * DQL from a blank file. This engine scans dbt artifacts and proposes a draft
 * governance layer: one `block` per high-value model, born `status: draft`, run
 * through the Certifier (results stored so a reviewer sees "what's missing to
 * certify"), and demand-ranked by downstream value.
 *
 * Hard rules enforced here:
 *   - Nothing is ever emitted with `status: certified`. Promotion is a separate
 *     human action (`dql certify --from-draft`).
 *   - Re-running is idempotent: an existing draft / certified / review block for
 *     the same model is never overwritten or duplicated.
 *   - Inference is conservative — grain/pattern/outputs are only set when the
 *     evidence is obvious, and invariants are limited to provably-safe checks.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Certifier } from '@duckcodeailabs/dql-governance';
import type { BlockRecord, BlockStatus } from '@duckcodeailabs/dql-project';
import {
  loadDbtArtifacts,
  type DbtArtifacts,
  type DbtColumn,
  type DbtModelNode,
} from './dbt-artifacts.js';
import {
  upsertProposedDraft,
  blockSlug,
  type ProposedDraftRecord,
} from './write-draft.js';

export interface ProposeOptions {
  projectRoot: string;
  dbtManifestPath: string;
  /** Default owner stamped on drafts (reviewer fills in if blank). */
  owner?: string;
  /**
   * Cap on the number of drafts written in one run. Keeps the queue reviewable
   * on large dbt projects. undefined = no cap.
   */
  limit?: number;
  /**
   * When true, score and rank but do not write any files. Useful for previews.
   */
  dryRun?: boolean;
  /**
   * Set of model/block slugs that already exist in the project (drafts or
   * certified). When omitted, the engine derives it by checking the filesystem.
   * Injectable for tests.
   */
  existingBlockSlugs?: Set<string>;
}

export type ProposedPattern =
  | 'entity_profile'
  | 'metric_wrapper'
  | 'entity_rollup'
  | 'trend'
  | 'custom';

export interface ProposalInference {
  pattern: ProposedPattern;
  grain?: string;
  declaredOutputs: string[];
  entities: string[];
  llmContext?: string;
  invariants: string[];
  examples: Array<{ question: string; sql?: string }>;
  tags: string[];
}

export interface ProposalRanking {
  /** Number of dbt models that depend on this model (downstream fan-out). */
  fanOut: number;
  /** Whether a dbt exposure references this model. */
  exposureLinked: boolean;
  /** Recorded runs from run_results.json (0 when unavailable). */
  runCount: number;
  /** Composite score used to order the queue (higher = more valuable). */
  score: number;
}

export interface ProposalResult {
  model: string;
  slug: string;
  domain: string;
  inference: ProposalInference;
  ranking: ProposalRanking;
  /** Path written (relative to projectRoot), or undefined when skipped/dry-run. */
  path?: string;
  /** Why a draft was skipped (already exists), if applicable. */
  skipped?: string;
  /** Stored Certifier verdict so a reviewer sees what's missing to certify. */
  certification: {
    certified: false;
    errors: Array<{ rule: string; message: string }>;
    warnings: Array<{ rule: string; message: string }>;
  };
}

export interface ProposeSummary {
  projectName?: string;
  modelsScanned: number;
  proposalsRanked: number;
  draftsWritten: number;
  draftsSkipped: number;
  proposals: ProposalResult[];
}

const TIME_COLUMN_RE = /(^|_)(date|day|week|month|quarter|year|period|ts|time|timestamp|datetime|created_at|updated_at)($|_)/i;
const ID_COLUMN_RE = /(_id|_key|_pk|_sk)$/i;
const MEASURE_COLUMN_RE = /(amount|amt|total|count|qty|quantity|revenue|cost|price|sum|avg|score|value|balance|rate|pct|percent)/i;

/** Slugify a domain label to the folder-safe form draft writers expect. */
function normalizeDomain(value: string | undefined): string {
  const safe = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '');
  return safe || 'uncategorized';
}

/** Choose the effective columns for a model: catalog (typed) ∪ manifest YAML. */
function effectiveColumns(model: DbtModelNode, artifacts: DbtArtifacts): DbtColumn[] {
  const catalog = artifacts.catalogColumns.get(model.uniqueId) ?? [];
  if (catalog.length === 0) return model.columns;
  // Merge descriptions from the YAML columns onto the typed catalog columns.
  const yamlByName = new Map(model.columns.map((c) => [c.name.toLowerCase(), c]));
  return catalog.map((c) => ({
    name: c.name,
    type: c.type ?? yamlByName.get(c.name.toLowerCase())?.type,
    description: c.description ?? yamlByName.get(c.name.toLowerCase())?.description,
  }));
}

/**
 * Infer the row grain conservatively. We only commit to a grain when there is a
 * single obvious identifier column or an explicit primary-key declaration; we
 * never guess composite grains.
 */
function inferGrain(model: DbtModelNode, columns: DbtColumn[]): string | undefined {
  // 1. Explicit primary key in meta/config (dbt convention varies; check both).
  const metaPk = model.meta.primary_key ?? model.meta.grain ?? (model.config.meta as Record<string, unknown> | undefined)?.primary_key;
  if (typeof metaPk === 'string' && metaPk.trim()) return metaPk.trim();
  if (Array.isArray(metaPk) && metaPk.length === 1 && typeof metaPk[0] === 'string') return metaPk[0];

  // 2. A single id/key column → that is the grain.
  const idColumns = columns.filter((c) => ID_COLUMN_RE.test(c.name));
  if (idColumns.length === 1) return idColumns[0].name;

  // 3. A column matching `<entity>_id` where entity == singularized model name.
  const entity = singularize(stripModelPrefix(model.name));
  const named = columns.find((c) => c.name.toLowerCase() === `${entity}_id` || c.name.toLowerCase() === `${entity}_key`);
  if (named) return named.name;

  return undefined;
}

/** Conservative pattern inference from columns + folder + semantic linkage. */
function inferPattern(
  model: DbtModelNode,
  columns: DbtColumn[],
  grain: string | undefined,
  hasSemanticMetric: boolean,
): ProposedPattern {
  if (hasSemanticMetric) return 'metric_wrapper';

  const hasTime = columns.some((c) => TIME_COLUMN_RE.test(c.name));
  const hasMeasure = columns.some((c) => MEASURE_COLUMN_RE.test(c.name));
  const idCount = columns.filter((c) => ID_COLUMN_RE.test(c.name)).length;

  // dim_* with a single grain and no measures → entity_profile.
  if (grain && !hasMeasure && /^(dim_|d_)/i.test(model.name)) return 'entity_profile';
  if (grain && !hasMeasure && idCount === 1) return 'entity_profile';

  // fct_*/agg with a grain + measures → entity_rollup.
  if (grain && hasMeasure && /^(fct_|fact_|f_|agg_)/i.test(model.name)) return 'entity_rollup';

  // Time + measure, no stable single grain → trend.
  if (hasTime && hasMeasure && !grain) return 'trend';

  return 'custom';
}

function inferEntities(model: DbtModelNode, grain: string | undefined): string[] {
  if (!grain) return [];
  // Derive the business entity from the grain column or model name.
  const base = grain.replace(ID_COLUMN_RE, '');
  const entity = base || singularize(stripModelPrefix(model.name));
  return entity ? [entity] : [];
}

/**
 * Build provably-safe, *column-checkable* invariants only. The runtime invariant
 * evaluator only sees a query's result columns, so a `row_count >= 0` invariant is
 * "uncheckable" there (it surfaces as a warning) even though the generated test
 * assertion covers it. We therefore emit only column predicates the evaluator can
 * actually check — when an obvious non-negative measure exists, a `>= 0` guard the
 * reviewer can keep or drop. (Row-count coverage lives in the block's tests.)
 */
function inferInvariants(columns: DbtColumn[]): string[] {
  const invariants: string[] = [];
  const countLike = columns.find((c) => /(^|_)(count|qty|quantity|num_|n_)/i.test(c.name));
  if (countLike) invariants.push(`${countLike.name} >= 0`);
  return invariants;
}

/** Build llmContext + examples from the model description (conservative). */
function buildLlmContext(model: DbtModelNode, columns: DbtColumn[], grain: string | undefined): {
  llmContext?: string;
  examples: Array<{ question: string; sql?: string }>;
} {
  const desc = model.description?.trim();
  const grainSentence = grain ? ` One row per ${grain}.` : '';
  const llmContext = desc
    ? `${desc}${grainSentence}`.trim()
    : undefined;

  // Prefer concrete business questions (better agent grounding + a real eval set)
  // over a generic "what does this contain?". Derived only from observable evidence
  // — the grain entity and an obvious measure column — so we never invent semantics.
  const examples: Array<{ question: string; sql?: string }> = [];
  const entity = singularize(
    ((grain ? grain.replace(/_id$/i, '') : '') || stripModelPrefix(model.name)),
  ).replace(/_/g, ' ').trim();
  const measureColumn =
    columns.find((c) => /(amount|spend|revenue|sales|price|value|cost|total)/i.test(c.name)) ??
    columns.find((c) => /(^|_)(count|qty|quantity|num_|n_)/i.test(c.name));
  const measurePhrase = measureColumn ? measureColumn.name.replace(/_/g, ' ') : undefined;

  if (grain && entity) {
    examples.push({ question: `How many ${pluralize(entity)} are there?` });
    if (measurePhrase) {
      examples.push({ question: `What is the total ${measurePhrase} per ${entity}?` });
    }
  } else if (measurePhrase) {
    examples.push({ question: `What is the total ${measurePhrase}?` });
  } else if (desc) {
    examples.push({ question: `What does the ${stripModelPrefix(model.name).replace(/_/g, ' ')} data cover?` });
  }
  return { llmContext, examples };
}

function inferTags(model: DbtModelNode): string[] {
  const tags = new Set<string>(['proposed', 'from-dbt']);
  for (const tag of model.tags) tags.add(tag);
  if (model.folder) tags.add(model.folder);
  return [...tags];
}

function buildInference(
  model: DbtModelNode,
  artifacts: DbtArtifacts,
  hasSemanticMetric: boolean,
): ProposalInference {
  const columns = effectiveColumns(model, artifacts);
  const grain = inferGrain(model, columns);
  const pattern = inferPattern(model, columns, grain, hasSemanticMetric);
  const { llmContext, examples } = buildLlmContext(model, columns, grain);
  return {
    pattern,
    grain,
    declaredOutputs: columns.map((c) => c.name),
    entities: inferEntities(model, grain),
    llmContext,
    invariants: inferInvariants(columns),
    examples,
    tags: inferTags(model),
  };
}

/**
 * Score a model by demand: downstream fan-out (primary), exposure linkage, and
 * run frequency. Staging/seed-tier models score lower so marts surface first.
 */
function rankModel(
  model: DbtModelNode,
  fanOut: number,
  exposureLinked: boolean,
  runCount: number,
): ProposalRanking {
  let score = fanOut * 10;
  if (exposureLinked) score += 50;
  score += Math.min(runCount, 20) * 2;
  // Marts are the high-value answer surface; nudge them up, staging down.
  if (model.folder === 'marts' || /^(fct_|dim_|mart_|rpt_)/i.test(model.name)) score += 15;
  if (model.folder === 'staging' || /^stg_/i.test(model.name)) score -= 20;
  if (model.folder === 'intermediate' || /^int_/i.test(model.name)) score -= 10;
  return { fanOut, exposureLinked, runCount, score };
}

/** Build the wrapping SQL for a model via `{{ ref('<model>') }}`. */
function buildQuery(model: DbtModelNode): string {
  return `SELECT * FROM {{ ref('${model.name}') }}`;
}

/** Map our inference into a BlockRecord for the Certifier (status always draft). */
function toBlockRecord(
  slug: string,
  domain: string,
  owner: string,
  model: DbtModelNode,
  inference: ProposalInference,
  gitPath: string,
): BlockRecord {
  const now = new Date();
  const sourceSystems = [model.schema, model.database].filter((v): v is string => Boolean(v));
  return {
    id: slug,
    name: slug,
    domain,
    type: 'custom',
    version: '0.1.0',
    status: 'draft' as BlockStatus,
    gitRepo: '',
    gitPath,
    gitCommitSha: '',
    description: model.description?.trim() || `Draft governance block proposed from dbt model ${model.name}.`,
    owner,
    tags: inference.tags,
    dependencies: model.dependsOn,
    usedInCount: 0,
    createdAt: now,
    updatedAt: now,
    llmContext: inference.llmContext,
    examples: inference.examples.length > 0 ? inference.examples : undefined,
    invariants: inference.invariants,
    pattern: inference.pattern,
    grain: inference.grain,
    entities: inference.entities.length > 0 ? inference.entities : undefined,
    declaredOutputs: inference.declaredOutputs.length > 0 ? inference.declaredOutputs : undefined,
    sourceSystems: sourceSystems.length > 0 ? sourceSystems : undefined,
    // Two tests proposed below match the invariants we emit.
    testAssertions: inference.invariants.map((inv) => `assert ${inv}`),
  };
}

/**
 * Detect blocks that already exist for a model so re-runs never duplicate or
 * overwrite. We check both draft-queue locations and the canonical domain
 * folder for a `<slug>.dql` file.
 */
function deriveExistingSlugs(projectRoot: string, slugs: string[]): Set<string> {
  const existing = new Set<string>();
  for (const slug of slugs) {
    const candidates = [
      join(projectRoot, 'blocks', '_drafts', `${slug}.dql`),
      join(projectRoot, 'blocks', `${slug}.dql`),
    ];
    // Domain-first locations are checked lazily below; we scan the common ones.
    if (candidates.some((p) => existsSync(p))) existing.add(slug);
  }
  return existing;
}

/**
 * Run the proposal engine end to end: load artifacts, infer, rank, write drafts,
 * and store Certifier verdicts. Returns a deterministic, ranked summary.
 */
export function propose(options: ProposeOptions): ProposeSummary {
  const { projectRoot, dbtManifestPath } = options;
  const owner = options.owner ?? '';
  const artifacts = loadDbtArtifacts(dbtManifestPath);

  // Downstream fan-out: count edges pointing *into* each model.
  const fanOut = new Map<string, number>();
  for (const model of artifacts.models) {
    for (const dep of model.dependsOn) {
      fanOut.set(dep, (fanOut.get(dep) ?? 0) + 1);
    }
  }
  // Exposure linkage.
  const exposureLinked = new Set<string>();
  for (const exposure of artifacts.exposures) {
    for (const dep of exposure.dependsOn) exposureLinked.add(dep);
  }
  // Models bound to a semantic metric → eligible for metric_wrapper.
  const metricModels = new Set<string>();
  for (const metric of artifacts.semanticMetrics) {
    if (metric.model) metricModels.add(metric.model.toLowerCase());
  }

  const certifier = new Certifier();
  const proposals: ProposalResult[] = [];

  for (const model of artifacts.models) {
    const slug = blockSlug(model.name);
    const domain = normalizeDomain(model.domainHint);
    const inference = buildInference(model, artifacts, metricModels.has(model.name.toLowerCase()));
    const ranking = rankModel(
      model,
      fanOut.get(model.uniqueId) ?? 0,
      exposureLinked.has(model.uniqueId),
      artifacts.runCounts.get(model.uniqueId) ?? 0,
    );

    // Build the would-be draft path (matches the draft-writer's resolution).
    const draftRelPath = resolveDraftRelPath(projectRoot, domain, slug);
    const record = toBlockRecord(slug, domain, owner, model, inference, draftRelPath);
    const verdict = certifier.evaluate(record);

    proposals.push({
      model: model.name,
      slug,
      domain,
      inference,
      ranking,
      certification: {
        certified: false,
        errors: verdict.errors,
        warnings: verdict.warnings,
      },
    });
  }

  // Rank: score desc, then fan-out desc, then name asc for determinism.
  proposals.sort((a, b) => {
    if (b.ranking.score !== a.ranking.score) return b.ranking.score - a.ranking.score;
    if (b.ranking.fanOut !== a.ranking.fanOut) return b.ranking.fanOut - a.ranking.fanOut;
    return a.slug.localeCompare(b.slug);
  });

  const allSlugs = proposals.map((p) => p.slug);
  const existingSlugs = options.existingBlockSlugs ?? deriveExistingSlugs(projectRoot, allSlugs);

  let draftsWritten = 0;
  let draftsSkipped = 0;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;

  for (const proposal of proposals) {
    if (existingSlugs.has(proposal.slug)) {
      proposal.skipped = 'A block for this model already exists; not overwriting.';
      draftsSkipped++;
      continue;
    }
    if (draftsWritten >= limit) {
      proposal.skipped = 'Above --limit; re-run to draft lower-ranked models.';
      draftsSkipped++;
      continue;
    }
    if (options.dryRun) {
      draftsWritten++; // counted as "would write" for the summary
      continue;
    }

    const model = artifacts.models.find((m) => m.name === proposal.model)!;
    const draftRecord: ProposedDraftRecord = {
      slug: proposal.slug,
      domain: proposal.domain,
      owner,
      description:
        model.description?.trim() ||
        `Draft governance block proposed from dbt model ${proposal.model}.`,
      sql: buildQuery(model),
      pattern: proposal.inference.pattern,
      grain: proposal.inference.grain,
      entities: proposal.inference.entities,
      declaredOutputs: proposal.inference.declaredOutputs,
      llmContext: proposal.inference.llmContext,
      invariants: proposal.inference.invariants,
      examples: proposal.inference.examples,
      tags: proposal.inference.tags,
      sourceModel: proposal.model,
      sourceSystems: [model.schema, model.database].filter((v): v is string => Boolean(v)),
      certification: proposal.certification,
    };
    const written = upsertProposedDraft(projectRoot, draftRecord);
    proposal.path = written.path;
    if (written.created) draftsWritten++;
    else {
      proposal.skipped = 'A block for this model already exists; not overwriting.';
      draftsSkipped++;
    }
  }

  return {
    projectName: artifacts.projectName,
    modelsScanned: artifacts.models.length,
    proposalsRanked: proposals.length,
    draftsWritten,
    draftsSkipped,
    proposals,
  };
}

/** Mirror of the draft-writer's path resolution (for the certifier gitPath). */
function resolveDraftRelPath(projectRoot: string, domain: string, slug: string): string {
  if (domain && existsSync(join(projectRoot, 'domains', domain))) {
    return `domains/${domain}/blocks/_drafts/${slug}.dql`;
  }
  return `blocks/_drafts/${slug}.dql`;
}

// ---- small word helpers (intentionally minimal — no NLP dependency) ----

function stripModelPrefix(name: string): string {
  return name.replace(/^(stg_|int_|fct_|fact_|f_|dim_|d_|agg_|mart_|rpt_)/i, '');
}

function singularize(word: string): string {
  if (/ies$/i.test(word)) return word.replace(/ies$/i, 'y');
  if (/ses$/i.test(word)) return word.replace(/es$/i, '');
  if (/s$/i.test(word) && !/ss$/i.test(word)) return word.replace(/s$/i, '');
  return word;
}

function pluralize(word: string): string {
  if (/[^aeiou]y$/i.test(word)) return word.replace(/y$/i, 'ies');
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}
