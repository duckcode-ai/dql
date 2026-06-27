/**
 * Grain / contract gate for certified-block routing.
 *
 * Retrieval is keyword-based (FTS5/BM25), so the router can surface a certified
 * block that is *close* to the question but answers a DIFFERENT grain than what
 * was asked (e.g. an account-grain block for a region-grain question). Serving
 * that as "Certified" is worse than refusing — it is a confidently wrong governed
 * answer.
 *
 * Blocks already carry `grain`, `entities`, and `declaredOutputs`; this module
 * uses them as a hard gate. Before a Tier-1 certified route is served, the
 * question's requested grain/entity is compared with the candidate block's
 * declared grain. Exact or compatible (coarser-rollup) grains pass; a genuine
 * grain/entity mismatch demotes the answer to Tier-2 (generated, block-as-context).
 *
 * The gate is deliberately CONSERVATIVE: when the question has no clearly
 * extractable grain, or the block declares no grain, it does NOT demote — it
 * must not regress today's behavior or over-refuse true matches.
 */

import type { MetadataObject } from './catalog.js';
import type { AnalysisQuestionPlan } from './analysis-planner.js';

/** Coarsest-to-finest time grain ordering. Lower index = finer granularity. */
const TIME_GRAIN_ORDER = ['hour', 'day', 'week', 'month', 'quarter', 'year'] as const;
type TimeGrain = (typeof TIME_GRAIN_ORDER)[number];

/**
 * Maps surface words (singular, after light normalization) to a canonical time
 * grain. Both question terms and block grain tokens are run through this.
 */
const TIME_GRAIN_SYNONYMS: Record<string, TimeGrain> = {
  hour: 'hour', hourly: 'hour',
  day: 'day', daily: 'day', date: 'day', dt: 'day',
  week: 'week', weekly: 'week', wk: 'week',
  month: 'month', monthly: 'month', mo: 'month', mtd: 'month',
  quarter: 'quarter', quarterly: 'quarter', qtr: 'quarter', qtd: 'quarter',
  year: 'year', yearly: 'year', annual: 'year', annually: 'year', yr: 'year', ytd: 'year',
  season: 'year',
};

/**
 * Known entity-grain synonym groups. Each group's members are treated as the
 * same entity grain. This is intentionally small and high-confidence — unknown
 * tokens fall back to literal comparison, never a forced match.
 */
const ENTITY_GRAIN_GROUPS: string[][] = [
  ['account', 'accounts'],
  ['customer', 'customers', 'client', 'clients'],
  ['user', 'users', 'member', 'members'],
  ['region', 'regions', 'geo', 'market', 'territory'],
  ['product', 'products', 'sku', 'item', 'items'],
  ['order', 'orders'],
  ['player', 'players', 'athlete', 'athletes'],
  ['team', 'teams'],
  ['vendor', 'vendors', 'supplier', 'suppliers', 'merchant', 'merchants'],
  ['segment', 'segments', 'cohort', 'cohorts'],
  ['channel', 'channels'],
  ['department', 'departments', 'team'],
  ['country', 'countries', 'nation'],
  ['store', 'stores', 'location', 'locations'],
];

export type GrainGateKind =
  | 'no_requested_grain'
  | 'block_grain_unknown'
  | 'exact'
  | 'compatible_rollup'
  | 'mismatch';

export interface RequestedGrain {
  /** Canonical time grain requested, if the question implies one. */
  time?: TimeGrain;
  /**
   * Entity/dimension grain tokens requested by the question (normalized,
   * canonicalized to a synonym group representative where known).
   */
  entities: string[];
  /** True when neither a time grain nor an entity grain could be extracted. */
  empty: boolean;
}

export interface GrainGateResult {
  /** Whether the candidate block may be served as a Tier-1 certified answer. */
  allow: boolean;
  kind: GrainGateKind;
  /** Human-readable description of the requested grain (for routeReason). */
  requestedGrainLabel: string;
  /** Human-readable description of the block's declared grain (for routeReason). */
  blockGrainLabel: string;
  reason: string;
}

/**
 * Extract the question's requested grain from the already-computed analysis
 * plan. Conservative by design: we only treat a token as a requested grain when
 * it is a recognized dimension/time word. Free-form named entities (e.g. a
 * person's name used as a filter value) are NOT a grain request.
 */
export function requestedGrainFromPlan(plan: AnalysisQuestionPlan): RequestedGrain {
  const time = extractTimeGrain([
    ...plan.timeTerms,
    ...plan.dimensionTerms,
    plan.normalizedQuestion,
  ]);

  const entityTokens = new Set<string>();
  for (const term of [...plan.dimensionTerms, ...plan.metricTerms]) {
    for (const token of grainTokens(term)) {
      const canonical = canonicalEntityToken(token);
      if (canonical) entityTokens.add(canonical);
    }
  }

  const entities = [...entityTokens];
  return { time, entities, empty: !time && entities.length === 0 };
}

/**
 * Compare a certified block's declared grain / outputs / entities against the
 * question's requested grain. Returns whether Tier-1 is still allowed and a
 * structured reason.
 */
export function grainMatches(
  block: MetadataObject,
  requested: RequestedGrain,
): GrainGateResult {
  const requestedGrainLabel = describeRequestedGrain(requested);

  // No-grain-no-demote: if the question carries no clearly-extractable grain,
  // never demote — preserve current behavior.
  if (requested.empty) {
    return {
      allow: true,
      kind: 'no_requested_grain',
      requestedGrainLabel,
      blockGrainLabel: describeBlockGrain(block),
      reason: 'question has no clearly-extractable grain; grain gate does not demote',
    };
  }

  const blockGrain = blockGrainProfile(block);
  const blockGrainLabel = describeBlockGrain(block);

  // Backward compatible: a block with no declared grain/outputs/entities cannot
  // be gated — we have nothing to compare against, so allow (don't over-refuse).
  if (!blockGrain.time && blockGrain.entities.length === 0) {
    return {
      allow: true,
      kind: 'block_grain_unknown',
      requestedGrainLabel,
      blockGrainLabel,
      reason: 'block declares no grain/outputs/entities to gate against; allowing Tier 1',
    };
  }

  // ---- Time grain check (only when the question requests a time grain) ----
  if (requested.time) {
    if (blockGrain.time) {
      if (blockGrain.time === requested.time) {
        // exact time match; fall through to entity check
      } else if (timeGrainIndex(blockGrain.time) < timeGrainIndex(requested.time)) {
        // Block grain is FINER than requested (e.g. daily block, weekly
        // question) → it can roll up. Compatible.
        return {
          allow: true,
          kind: 'compatible_rollup',
          requestedGrainLabel,
          blockGrainLabel,
          reason: `block grain=${blockGrain.time} is finer than requested grain=${requested.time} → safe roll-up`,
        };
      } else {
        // Block grain is COARSER than requested (e.g. monthly block, daily
        // question) → cannot answer the finer question. Mismatch.
        return {
          allow: false,
          kind: 'mismatch',
          requestedGrainLabel,
          blockGrainLabel,
          reason: `certified block grain=${blockGrain.time} ≠ requested grain=${requested.time} → Tier 2`,
        };
      }
    }
    // Block declares no time grain but does declare an entity grain that the
    // question does not request as a dimension → that is itself a likely
    // entity mismatch, handled below.
  }

  // ---- Entity / dimension grain check ----
  if (requested.entities.length > 0 && blockGrain.entities.length > 0) {
    const overlap = requested.entities.some((entity) => blockGrain.entities.includes(entity));
    if (!overlap) {
      const reqEntity = requested.entities[0];
      const blockEntity = blockGrain.entities[0];
      return {
        allow: false,
        kind: 'mismatch',
        requestedGrainLabel,
        blockGrainLabel,
        reason: `certified block grain=${blockEntity} ≠ requested grain=${reqEntity} → Tier 2`,
      };
    }
  }

  return {
    allow: true,
    kind: 'exact',
    requestedGrainLabel,
    blockGrainLabel,
    reason: 'certified block grain satisfies the requested grain',
  };
}

interface BlockGrainProfile {
  time?: TimeGrain;
  /** Canonical entity-grain tokens declared by the block. */
  entities: string[];
}

/**
 * Build the block's declared grain profile from `grain`, `declaredOutputs`, and
 * `entities` (read from the indexed payload).
 */
function blockGrainProfile(block: MetadataObject): BlockGrainProfile {
  const payload = block.payload ?? {};
  const grainStr = typeof payload.grain === 'string' ? payload.grain : '';
  const declaredOutputs = stringArray(payload.declaredOutputs);
  const entities = stringArray(payload.entities);

  const time = extractTimeGrain([grainStr, ...declaredOutputs]);

  const entityTokens = new Set<string>();
  // The declared `grain` string is the strongest signal (e.g. "account_id",
  // "region", "customer_id"). Tokenize it and canonicalize known entity words.
  for (const token of grainTokens(grainStr)) {
    const canonical = canonicalEntityToken(token);
    if (canonical) entityTokens.add(canonical);
  }
  // Declared business entities are also an entity-grain signal.
  for (const entity of entities) {
    for (const token of grainTokens(entity)) {
      const canonical = canonicalEntityToken(token);
      if (canonical) entityTokens.add(canonical);
    }
  }
  // Output columns named like `<entity>_id` are a strong row-grain signal.
  for (const output of declaredOutputs) {
    for (const token of grainTokens(output)) {
      const canonical = canonicalEntityToken(token);
      if (canonical) entityTokens.add(canonical);
    }
  }

  return { time, entities: [...entityTokens] };
}

function extractTimeGrain(values: string[]): TimeGrain | undefined {
  for (const value of values) {
    for (const token of grainTokens(value)) {
      const grain = TIME_GRAIN_SYNONYMS[token];
      if (grain) return grain;
    }
  }
  return undefined;
}

/**
 * Split a value into normalized grain tokens. Strips a trailing `_id`/`id`
 * suffix so `account_id` and `account` compare equal, and lightly singularizes.
 */
function grainTokens(value: string): string[] {
  if (!value) return [];
  return value
    .toLowerCase()
    .replace(/[_\-./]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && token !== 'id')
    .map((token) => (token.endsWith('id') && token.length > 3 ? token.slice(0, -2) : token))
    .map(singularize);
}

function singularize(token: string): string {
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith('ses') && token.length > 4) return token.slice(0, -2);
  if (token.endsWith('s') && token.length > 3) return token.slice(0, -1);
  return token;
}

/** Canonicalize a token to its entity-grain group representative, if known. */
function canonicalEntityToken(token: string): string | undefined {
  const normalized = singularize(token);
  for (const group of ENTITY_GRAIN_GROUPS) {
    if (group.map(singularize).includes(normalized)) return singularize(group[0]);
  }
  return undefined;
}

function timeGrainIndex(grain: TimeGrain): number {
  return TIME_GRAIN_ORDER.indexOf(grain);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function describeRequestedGrain(requested: RequestedGrain): string {
  const parts = [requested.time, ...requested.entities].filter(Boolean);
  return parts.length ? parts.join('+') : 'none';
}

function describeBlockGrain(block: MetadataObject): string {
  const profile = blockGrainProfile(block);
  const declared = typeof block.payload?.grain === 'string' ? block.payload.grain : '';
  if (declared) return declared;
  const parts = [profile.time, ...profile.entities].filter(Boolean);
  return parts.length ? parts.join('+') : 'unknown';
}
