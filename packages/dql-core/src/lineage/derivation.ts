/**
 * "Show your work" — consumer-facing derivation walk.
 *
 * A derivation walk is the plain-language story of how a single certified (or
 * generated) answer was produced: the value, the governed block that owns it,
 * the business terms and metrics/dimensions it draws on, the dbt model/source
 * it ultimately reads from, and the freshness/owner/review state that makes it
 * trustworthy.
 *
 * It is NOT the raw author lineage graph. It deliberately hides depth: a flat,
 * ordered list of steps the UI can reveal one level at a time. The structured
 * payload is assembled entirely from data that already exists —
 * `queryBusiness360` (businessDefinition / businessComposition /
 * technicalSources / consumers / gaps / evidence) plus the answer's source
 * block governance fields — so no lineage is rebuilt and no schema changes.
 */

import type { Business360Asset, Business360Result } from './query.js';

/** The kind of node a derivation step represents, ordered roughly value → source. */
export type DerivationStepKind =
  | 'value'
  | 'block'
  | 'term'
  | 'metric'
  | 'dimension'
  | 'model'
  | 'source'
  | 'consumer';

/**
 * One node in the derivation walk. Intentionally flat and plain-language: the
 * UI reveals steps progressively rather than drawing edges.
 */
export interface DerivationStep {
  kind: DerivationStepKind;
  /** Human-readable label, e.g. the block name or term name. */
  name: string;
  /** Governing owner (person/team), when known. */
  owner?: string;
  /** Certification/review status, when known (e.g. certified, review, draft). */
  status?: string;
  /** Optional one-line plain-language detail for this step. */
  detail?: string;
}

/**
 * The consumer-facing derivation payload. `trustLabel` and `freshness` are
 * OPTIONAL: they are populated from whatever exists today and are designed to
 * be filled in later by the trust-label / freshness-aware-trust features.
 */
export interface DerivationWalk {
  /** The headline value the answer reported, when there is a single one. */
  value?: string;
  /** One-sentence plain-language summary of the derivation. */
  summary: string;
  /** Ordered walk: value → block → term/metric → dbt model/source. */
  steps: DerivationStep[];
  /** Canonical trust label, when available (optional; sibling feature fills this in). */
  trustLabel?: string;
  /** Freshness marker for the upstream data, when available (optional sibling feature). */
  freshness?: string;
  /** Interpretation caveats drawn from the block's `caveats`. */
  caveats?: string[];
}

/**
 * Minimal governance descriptor for the answer's source block. Both
 * `ManifestBlock` and the agent's `KGNode` are structurally compatible, so the
 * builder can accept either without coupling to a specific package.
 */
export interface DerivationFocusBlock {
  name: string;
  owner?: string;
  status?: string;
  /** Review cadence, e.g. "monthly". Surfaced verbatim in the walk. */
  reviewCadence?: string;
  /** Interpretation caveats. Surfaced verbatim and as the walk's `caveats`. */
  caveats?: string[];
  /** Business term names this block implements. */
  termRefs?: string[];
  /** Semantic metric references. */
  metricRefs?: string[];
  /** Semantic dimension references. */
  dimensionRefs?: string[];
  /** Business outcome / decision the block supports. */
  businessOutcome?: string;
  decisionUse?: string;
}

export interface BuildDerivationWalkInput {
  /** Business-360 payload for the focus block/term (from `queryBusiness360`). */
  business360: Business360Result;
  /** The answer's source block governance fields (caveats / reviewCadence / refs). */
  block?: DerivationFocusBlock;
  /** The headline value, when the answer reported a single number/string. */
  value?: string;
  /**
   * Whether this answer is a generated (Tier-2) draft. When true the walk ends
   * with the appropriate review-required state instead of a certified close.
   */
  generated?: boolean;
  /** Optional canonical trust label (optional sibling feature). */
  trustLabel?: string;
  /** Optional freshness marker (optional sibling feature). */
  freshness?: string;
  /** Max steps of any single kind to include (keeps the walk compact). Default 3. */
  maxPerKind?: number;
}

const DEFAULT_MAX_PER_KIND = 3;

/**
 * Assemble a consumer-facing derivation walk from an already-computed
 * `queryBusiness360` result plus the answer's source block. Pure and
 * synchronous — safe to call from a browser bundle.
 */
export function buildDerivationWalk(input: BuildDerivationWalkInput): DerivationWalk {
  const { business360, block, value, generated = false } = input;
  const maxPerKind = input.maxPerKind ?? DEFAULT_MAX_PER_KIND;

  const focus = business360.focus;
  const steps: DerivationStep[] = [];

  // 1) Value — the thing the consumer actually asked about.
  if (value) {
    steps.push({
      kind: 'value',
      name: value,
      detail: focus.name ? `Reported by ${focus.name}.` : undefined,
    });
  }

  // 2) Block / business asset that owns the answer.
  const blockOwner = block?.owner ?? focus.owner;
  const blockStatus = (block?.status ?? focus.status) as string | undefined;
  const reviewCadence = block?.reviewCadence ?? metadataString(focus.metadata, 'reviewCadence');
  steps.push({
    kind: 'block',
    name: focus.name,
    owner: blockOwner,
    status: blockStatus,
    detail: blockDetail({
      reviewCadence,
      businessOutcome: block?.businessOutcome ?? metadataString(focus.metadata, 'businessOutcome'),
      decisionUse: block?.decisionUse,
    }),
  });

  // 3) Business terms that define the language of the answer.
  const termAssets = uniqueByName([
    ...business360.businessDefinition.terms,
    ...business360.businessDefinition.definedByTerms,
  ]);
  for (const term of termAssets.slice(0, maxPerKind)) {
    if (term.id === focus.id) continue;
    steps.push({
      kind: 'term',
      name: term.name,
      owner: term.owner,
      detail: 'Business term this answer is defined in.',
    });
  }

  // 4) Metrics / dimensions referenced by the block (semantic layer).
  for (const metric of dedupeNames(block?.metricRefs).slice(0, maxPerKind)) {
    steps.push({ kind: 'metric', name: metric, detail: 'Governed metric used in the calculation.' });
  }
  for (const dimension of dedupeNames(block?.dimensionRefs).slice(0, maxPerKind)) {
    steps.push({ kind: 'dimension', name: dimension, detail: 'Dimension used to slice the value.' });
  }

  // 5) dbt models / sources — the technical floor of the trust chain.
  for (const model of business360.technicalSources.dbtModels.slice(0, maxPerKind)) {
    steps.push({
      kind: 'model',
      name: model.name,
      detail: 'dbt model the certified SQL builds on.',
    });
  }
  const sourceAssets = uniqueByName([
    ...business360.technicalSources.dbtSources,
    ...business360.technicalSources.sourceTables,
  ]);
  for (const source of sourceAssets.slice(0, maxPerKind)) {
    steps.push({
      kind: 'source',
      name: source.name,
      detail: 'Raw source table the data originates from.',
    });
  }

  const caveats = dedupeNames(block?.caveats ?? metadataStringArray(focus.metadata, 'caveats'));

  return {
    value,
    summary: buildSummary({ focus, blockOwner, reviewCadence, generated, sourceAssets }),
    steps,
    trustLabel: input.trustLabel ?? (generated ? 'review_required' : undefined),
    freshness: input.freshness ?? metadataString(focus.metadata, 'freshness'),
    caveats: caveats.length > 0 ? caveats : undefined,
  };
}

function blockDetail(input: {
  reviewCadence?: string;
  businessOutcome?: string;
  decisionUse?: string;
}): string | undefined {
  const parts: string[] = [];
  if (input.businessOutcome) parts.push(input.businessOutcome);
  else if (input.decisionUse) parts.push(`Supports: ${input.decisionUse}.`);
  if (input.reviewCadence) parts.push(`Reviewed ${input.reviewCadence}.`);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

function buildSummary(input: {
  focus: Business360Asset;
  blockOwner?: string;
  reviewCadence?: string;
  generated: boolean;
  sourceAssets: Business360Asset[];
}): string {
  const ownerPhrase = input.blockOwner ? ` owned by ${input.blockOwner}` : '';
  const sourcePhrase = input.sourceAssets.length > 0
    ? ` It traces back to ${input.sourceAssets[0].name}.`
    : '';
  if (input.generated) {
    return `This value was generated from ${input.focus.name}${ownerPhrase} and still needs analyst review before it can be certified.${sourcePhrase}`;
  }
  const cadencePhrase = input.reviewCadence ? `, reviewed ${input.reviewCadence}` : '';
  return `This value comes from the certified ${input.focus.name}${ownerPhrase}${cadencePhrase}.${sourcePhrase}`;
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function metadataStringArray(metadata: Record<string, unknown> | undefined, key: string): string[] {
  const value = metadata?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function dedupeNames(values: string[] | undefined): string[] {
  if (!values) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    out.push(trimmed);
  }
  return out;
}

function uniqueByName(assets: Business360Asset[]): Business360Asset[] {
  const seen = new Set<string>();
  const out: Business360Asset[] = [];
  for (const asset of assets) {
    if (seen.has(asset.id)) continue;
    seen.add(asset.id);
    out.push(asset);
  }
  return out;
}
