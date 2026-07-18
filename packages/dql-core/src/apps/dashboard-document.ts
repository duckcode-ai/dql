/**
 * Dashboard documents — `apps/<app>/dashboards/<id>.dqld`.
 *
 * `.dqld` is JSON. A dashboard composes certified blocks (or notebook cells
 * bound to block files) into an explicit grid layout with params, filters,
 * and a viz config per item. Distinct from `.dqlnb` notebooks, which are a
 * linear cell sequence.
 *
 * The reference shape allows two forms:
 * - by-id  : `{ "blockId": "revenue_total" }` — resolved at compile time
 *            against the manifest's blocks map.
 * - by-path: `{ "ref": "blocks/revenue_total.dql" }` — resolved against the
 *            block scanner's path-to-name map.
 *
 * Either form may also pin a git SHA (`"version": "git:abc123"`).
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

export type DashboardParam = {
  id: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'daterange';
  default?: unknown;
  description?: string;
};

export type DashboardFilter = {
  id: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'daterange' | 'select';
  default?: unknown;
  /** For 'select': allowed values. */
  options?: string[];
  /** Optional dimension reference the filter binds to. */
  bindsTo?: string;
};

export type DashboardBlockRef =
  | { blockId: string; version?: string }
  | { ref: string; version?: string };

export type DashboardVizConfig = {
  /** Chart kind. The renderer picks the matching @duckcodeailabs/dql-charts component. */
  type:
    | 'single_value'
    | 'grouped_bar'
    | 'stacked_bar'
    | 'line'
    | 'bar'
    | 'area'
    | 'pie'
    | 'donut'
    | 'scatter'
    | 'heatmap'
    | 'histogram'
    | 'waterfall'
    | 'gauge'
    | 'table'
    | 'pivot'
    | 'map'
    | 'funnel'
    | 'sankey'
    | 'kpi'
    | 'text'
    | 'heading';
  /** Free-form per-renderer options (axes, colors, etc.). */
  options?: Record<string, unknown>;
};

export type DashboardDisplayMode = 'manual' | 'ai_generated' | 'block_hint';
export type DashboardDisplayComponent =
  | 'BusinessBrief'
  | 'KpiMetric'
  | 'TrendPanel'
  | 'RankingPanel'
  | 'EvidenceTable'
  | 'PivotTable'
  | 'TrustCallout'
  | 'NarrativePanel'
  | 'ResearchActions';
export type DashboardDisplayLayoutIntent = 'auto' | 'compact' | 'standard' | 'wide' | 'tall' | 'full';
export type DashboardDisplayTrustState = 'certified' | 'review_required' | 'draft_ready';
export type DashboardDisplayReviewStatus = 'certified' | 'draft_ready' | 'review_required';

export type DashboardDisplayMetadata = {
  /** Presentation source. The block remains the data contract; this is consumer-level UI metadata. */
  mode: DashboardDisplayMode;
  component: DashboardDisplayComponent;
  defaultVisualization: DashboardVizConfig['type'];
  allowedVisualizations: DashboardVizConfig['type'][];
  fieldHints?: Record<string, string>;
  layoutIntent: DashboardDisplayLayoutIntent;
  rationale: string;
  trustState: DashboardDisplayTrustState;
  reviewStatus: DashboardDisplayReviewStatus;
};

export type DashboardTileFilterBinding = {
  /** Dashboard/app filter id such as `period`, `region`, or `season`. */
  filter: string;
  /** Physical column/expression or semantic field this filter can bind to. */
  binding?: string;
  /** Whether this becomes a block parameter or an outer predicate at execution time. */
  mode?: 'parameter' | 'predicate';
  /** Block parameter names controlled by this app filter. */
  paramNames?: string[];
  /** If true, the tile should warn when the filter is missing. */
  required?: boolean;
  /** Populated when a global filter intentionally does not apply to this tile. */
  unsupportedReason?: string;
};

export type DashboardTileParameterBinding = {
  /** Block parameter name. */
  param: string;
  /** Where the parameter value comes from on the consumption surface. */
  source: 'dashboard_filter' | 'constant' | 'persona' | 'variable';
  filter?: string;
  field?: string;
  value?: unknown;
  /** Typed block contract metadata used to render the correct consumer control. */
  parameterType?: 'string' | 'number' | 'boolean' | 'date' | 'string[]' | 'number[]' | 'date[]';
  required?: boolean;
  default?: unknown;
  policy?: 'dynamic' | 'static' | 'business' | 'derived' | 'optional' | 'ambiguous_review_required';
};

export type DashboardTileSourceEvidence = {
  source: string;
  reason: string;
  kind?: string;
  nodeId?: string;
  path?: string;
  trustState?: DashboardDisplayTrustState;
};

export type DashboardTextTile = {
  markdown: string;
};

export type DashboardAiPinRef = {
  id: string;
};

/** Canonical governed semantic query. This stores intent and reviewed semantic
 * references, never copied/generated SQL. The runtime compiles it against the
 * active snapshot before every execution. */
export type DashboardSemanticQueryRef = {
  id: string;
  provider: 'metricflow' | 'native';
  metrics: string[];
  dimensions?: string[];
  filters?: Array<{ field: string; operator: string; value: unknown }>;
  timeDimension?: string;
  orderBy?: Array<{ field: string; direction: 'asc' | 'desc' }>;
  limit?: number;
  semanticModelRefs: string[];
  definitionFingerprint: string;
  snapshotId?: string;
};

export type DashboardStoryEvidencePlan = {
  version: 1;
  goal: string;
  audience?: string;
  /** Tile ids eligible to contribute facts. Empty means every governed data tile. */
  eligibleTileIds?: string[];
  /** Tile ids whose verified results may support driver language. */
  driverTileIds?: string[];
  /** Preferred business terms to retain in the story. */
  vocabulary?: string[];
};

export type DashboardStoryFact = {
  id: string;
  tileId: string;
  kind: 'value' | 'rank' | 'share' | 'delta' | 'trend' | 'driver' | 'scope' | 'freshness';
  label: string;
  value: string | number | boolean | null;
  unit?: string;
  comparison?: { baseline: string | number; delta?: string | number };
  grain?: string;
  filters?: Record<string, unknown>;
  evidenceRef: string;
  trustState: DashboardDisplayTrustState;
};

export type DashboardStoryClaim = {
  text: string;
  factIds: string[];
  kind: 'observation' | 'comparison' | 'driver' | 'implication' | 'caveat';
};

export type DashboardStoryBrief = {
  headline: string;
  paragraphs: string[];
  implication?: string;
  caveat?: string;
  claims: DashboardStoryClaim[];
  evidenceRefs: string[];
  trustState: DashboardDisplayTrustState;
  generatedBy: 'deterministic' | 'ai';
};

export type DashboardGridItem = {
  /** Stable layout id — used by the grid editor for positioning persistence. */
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Certified/shared block source. Existing dashboards use this shape. */
  block?: DashboardBlockRef;
  /** Local narrative/section text tile. */
  text?: DashboardTextTile;
  /** Local AI-generated answer pin stored in .dql/local/apps.sqlite. */
  aiPin?: DashboardAiPinRef;
  /** Governed semantic query compiled against the current snapshot. */
  semantic?: DashboardSemanticQueryRef;
  viz: DashboardVizConfig;
  /** Governed GenUI/display contract for this specific App or notebook tile. */
  display?: DashboardDisplayMetadata;
  /** App-level filter compatibility and binding metadata for this tile. */
  filterBindings?: DashboardTileFilterBinding[];
  /** Runtime parameter binding metadata for this tile. */
  parameterBindings?: DashboardTileParameterBinding[];
  /** Evidence used by AI/App Builder to choose this tile and presentation. */
  sourceEvidence?: DashboardTileSourceEvidence[];
  /** Denormalized trust marker for stakeholder and source-control surfaces. */
  trustState?: DashboardDisplayTrustState;
  /** Denormalized review marker for stakeholder and source-control surfaces. */
  reviewStatus?: DashboardDisplayReviewStatus;
  /** Optional human-readable title shown in the tile header. */
  title?: string;
  /** Story layout: which dashboard section this tile belongs to (optional, additive). */
  sectionId?: string;
};

/**
 * Story-layout section (optional, additive): groups tiles into a narrated flow —
 * executive summary → KPI band → per-question insights → review appendix.
 * Dashboards without sections render as the classic grid.
 */
export type DashboardSection = {
  id: string;
  title: string;
  kind: 'exec_summary' | 'kpi_band' | 'insight' | 'appendix';
  /** Narrated intro for the section (real numbers from executed results). */
  narrative?: string;
  order: number;
};

export interface DashboardDocument {
  version: 1;
  id: string;
  metadata: {
    title: string;
    description?: string;
    domain?: string;
    subdomain?: string;
    groups?: string[];
    audience?: string;
    visibility?: 'shared' | 'private' | 'template';
    lifecycle?: 'draft' | 'review' | 'certified' | 'deprecated';
    tags?: string[];
    businessOutcome?: string;
    businessOwner?: string;
    decisionUse?: string;
    reviewCadence?: string;
    businessRules?: string[];
    caveats?: string[];
  };
  params?: DashboardParam[];
  filters?: DashboardFilter[];
  /** Story layout sections (optional). Old dashboards simply have none. */
  sections?: DashboardSection[];
  /** Runtime story evidence contract. Result-specific prose is never persisted. */
  story?: DashboardStoryEvidencePlan;
  layout: {
    kind: 'grid';
    cols: number;
    rowHeight: number;
    items: DashboardGridItem[];
  };
}

export interface DashboardParseError {
  path: string;
  message: string;
}

export interface DashboardLoadResult {
  document: DashboardDocument | null;
  errors: DashboardParseError[];
}

export function parseDashboardDocument(text: string, path = '<dashboard.dqld>'): DashboardLoadResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      document: null,
      errors: [{ path, message: `invalid JSON: ${(err as Error).message}` }],
    };
  }
  return validateDashboardDocument(raw, path);
}

export function loadDashboardDocument(filePath: string): DashboardLoadResult {
  if (!existsSync(filePath)) {
    return { document: null, errors: [{ path: filePath, message: 'file not found' }] };
  }
  const text = readFileSync(filePath, 'utf-8');
  return parseDashboardDocument(text, filePath);
}

/** Return the absolute paths of every `.dqld` file under `<appDir>/dashboards/`. */
export function findDashboardsForApp(appDir: string): string[] {
  const dashboardsDir = join(appDir, 'dashboards');
  if (!existsSync(dashboardsDir)) return [];
  return scanDashboardsRecursive(dashboardsDir);
}

/** Return the absolute paths of every `.dqld` file under any `apps/<id>/dashboards/`. */
export function findAllDashboards(projectRoot: string): string[] {
  const appsDir = join(projectRoot, 'apps');
  if (!existsSync(appsDir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    out.push(...findDashboardsForApp(join(appsDir, entry.name)));
  }
  return out.sort();
}

function scanDashboardsRecursive(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      out.push(...scanDashboardsRecursive(p));
    } else if (entry.isFile() && extname(entry.name) === '.dqld') {
      out.push(p);
    }
  }
  return out;
}

/** True when the layout item references a block by id (vs by path). */
export function isBlockIdRef(ref: DashboardBlockRef): ref is { blockId: string; version?: string } {
  return typeof (ref as { blockId?: unknown }).blockId === 'string';
}

/** Extract every block name/id referenced from a dashboard, regardless of ref form. */
export function extractDashboardBlockRefs(doc: DashboardDocument): {
  byId: string[];
  byPath: string[];
} {
  const byId: string[] = [];
  const byPath: string[] = [];
  for (const item of doc.layout.items) {
    if (!item.block) continue;
    if (isBlockIdRef(item.block)) byId.push(item.block.blockId);
    else byPath.push(item.block.ref);
  }
  return { byId, byPath };
}

// ---- Validation ----

function validateDashboardDocument(raw: unknown, path: string): DashboardLoadResult {
  const errors: DashboardParseError[] = [];
  const err = (msg: string) => errors.push({ path, message: msg });

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    err('expected a JSON object at the top level');
    return { document: null, errors };
  }
  const obj = raw as Record<string, unknown>;
  const version = obj.version ?? 1;
  if (version !== 1) err(`unsupported version ${String(version)} (expected 1)`);

  if (typeof obj.id !== 'string' || obj.id.length === 0) {
    err('id must be a non-empty string');
    return { document: null, errors };
  }
  const id = obj.id;

  const metadata = readMetadata(obj.metadata, err);
  const params = readParams(obj.params, err);
  const filters = readFilters(obj.filters, err);
  const sections = readSections(obj.sections, err);
  const story = readStoryEvidencePlan(obj.story, err);
  const layout = readLayout(obj.layout, err);

  if (errors.length > 0) {
    return { document: null, errors };
  }

  return {
    document: {
      version: 1,
      id,
      metadata,
      params: params.length > 0 ? params : undefined,
      filters: filters.length > 0 ? filters : undefined,
      sections: sections.length > 0 ? sections : undefined,
      ...(story ? { story } : {}),
      layout,
    },
    errors: [],
  };
}

function readStoryEvidencePlan(raw: unknown, err: (m: string) => void): DashboardStoryEvidencePlan | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    err('story must be an object when present');
    return undefined;
  }
  const story = raw as Record<string, unknown>;
  if (story.version !== 1) err('story.version must be 1');
  if (typeof story.goal !== 'string' || !story.goal.trim()) {
    err('story.goal must be a non-empty string');
    return undefined;
  }
  return {
    version: 1,
    goal: story.goal,
    audience: typeof story.audience === 'string' ? story.audience : undefined,
    eligibleTileIds: stringArrayOrUndefined(story.eligibleTileIds, 'story.eligibleTileIds', err),
    driverTileIds: stringArrayOrUndefined(story.driverTileIds, 'story.driverTileIds', err),
    vocabulary: stringArrayOrUndefined(story.vocabulary, 'story.vocabulary', err),
  };
}

/** Story sections are optional and additive — absent/invalid entries are skipped
 *  (a malformed section must never brick an otherwise valid dashboard). */
function readSections(raw: unknown, err: (m: string) => void): DashboardSection[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    err('sections must be an array when present');
    return [];
  }
  const kinds = ['exec_summary', 'kpi_band', 'insight', 'appendix'] as const;
  const sections: DashboardSection[] = [];
  raw.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) return;
    const section = entry as Record<string, unknown>;
    if (typeof section.id !== 'string' || section.id.length === 0) return;
    if (typeof section.title !== 'string') return;
    if (typeof section.kind !== 'string' || !kinds.includes(section.kind as typeof kinds[number])) return;
    sections.push({
      id: section.id,
      title: section.title,
      kind: section.kind as DashboardSection['kind'],
      narrative: typeof section.narrative === 'string' ? section.narrative : undefined,
      order: typeof section.order === 'number' ? section.order : index,
    });
  });
  return sections;
}

function readMetadata(raw: unknown, err: (m: string) => void): DashboardDocument['metadata'] {
  if (typeof raw !== 'object' || raw === null) {
    err('metadata must be an object');
    return { title: 'Untitled' };
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.title !== 'string' || o.title.length === 0) {
    err('metadata.title must be a non-empty string');
    return { title: 'Untitled' };
  }
  const tags = o.tags;
  let tagsTyped: string[] | undefined;
  if (tags !== undefined) {
    if (!Array.isArray(tags) || !tags.every((x) => typeof x === 'string')) {
      err('metadata.tags must be an array of strings');
    } else {
      tagsTyped = tags as string[];
    }
  }
  return {
    title: o.title,
    description: typeof o.description === 'string' ? o.description : undefined,
    domain: typeof o.domain === 'string' ? o.domain : undefined,
    subdomain: typeof o.subdomain === 'string' ? o.subdomain : undefined,
    groups: stringArrayOrUndefined(o.groups, 'metadata.groups', err),
    audience: typeof o.audience === 'string' ? o.audience : undefined,
    visibility: enumOrUndefined(o.visibility, 'metadata.visibility', ['shared', 'private', 'template'] as const, err),
    lifecycle: enumOrUndefined(o.lifecycle, 'metadata.lifecycle', ['draft', 'review', 'certified', 'deprecated'] as const, err),
    tags: tagsTyped,
    businessOutcome: typeof o.businessOutcome === 'string' ? o.businessOutcome : undefined,
    businessOwner: typeof o.businessOwner === 'string' ? o.businessOwner : undefined,
    decisionUse: typeof o.decisionUse === 'string' ? o.decisionUse : undefined,
    reviewCadence: typeof o.reviewCadence === 'string' ? o.reviewCadence : undefined,
    businessRules: stringArrayOrUndefined(o.businessRules, 'metadata.businessRules', err),
    caveats: stringArrayOrUndefined(o.caveats, 'metadata.caveats', err),
  };
}

function stringArrayOrUndefined(raw: unknown, field: string, err: (m: string) => void): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string')) {
    err(`${field} must be an array of strings`);
    return undefined;
  }
  return raw as string[];
}

function readParams(raw: unknown, err: (m: string) => void): DashboardParam[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    err('params must be an array');
    return [];
  }
  const allowed = ['string', 'number', 'boolean', 'date', 'daterange'] as const;
  const out: DashboardParam[] = [];
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i] as Record<string, unknown>;
    if (typeof p?.id !== 'string' || typeof p?.type !== 'string'
      || !allowed.includes(p.type as typeof allowed[number])) {
      err(`params[${i}] must have string id and type in ${allowed.join('|')}`);
      continue;
    }
    out.push({
      id: p.id,
      type: p.type as DashboardParam['type'],
      default: p.default,
      description: typeof p.description === 'string' ? p.description : undefined,
    });
  }
  return out;
}

function readFilters(raw: unknown, err: (m: string) => void): DashboardFilter[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    err('filters must be an array');
    return [];
  }
  const allowed = ['string', 'number', 'boolean', 'date', 'daterange', 'select'] as const;
  const out: DashboardFilter[] = [];
  for (let i = 0; i < raw.length; i++) {
    const f = raw[i] as Record<string, unknown>;
    if (typeof f?.id !== 'string' || typeof f?.type !== 'string'
      || !allowed.includes(f.type as typeof allowed[number])) {
      err(`filters[${i}] must have string id and type in ${allowed.join('|')}`);
      continue;
    }
    let opts: string[] | undefined;
    if (f.options !== undefined) {
      if (!Array.isArray(f.options) || !f.options.every((x) => typeof x === 'string')) {
        err(`filters[${i}].options must be an array of strings`);
      } else {
        opts = f.options as string[];
      }
    }
    out.push({
      id: f.id,
      type: f.type as DashboardFilter['type'],
      default: f.default,
      options: opts,
      bindsTo: typeof f.bindsTo === 'string' ? f.bindsTo : undefined,
    });
  }
  return out;
}

function readLayout(raw: unknown, err: (m: string) => void): DashboardDocument['layout'] {
  if (typeof raw !== 'object' || raw === null) {
    err('layout must be an object');
    return { kind: 'grid', cols: 12, rowHeight: 80, items: [] };
  }
  const o = raw as Record<string, unknown>;
  if (o.kind !== 'grid') {
    err(`layout.kind must be "grid" (got ${String(o.kind)})`);
  }
  const cols = typeof o.cols === 'number' && o.cols > 0 ? o.cols : 12;
  const rowHeight = typeof o.rowHeight === 'number' && o.rowHeight > 0 ? o.rowHeight : 80;

  if (!Array.isArray(o.items)) {
    err('layout.items must be an array');
    return { kind: 'grid', cols, rowHeight, items: [] };
  }

  const allowedViz = [
    'single_value', 'line', 'bar', 'grouped_bar', 'stacked_bar', 'area', 'pie', 'donut', 'scatter',
    'heatmap', 'histogram', 'waterfall', 'gauge', 'table', 'pivot', 'map', 'funnel', 'sankey', 'kpi', 'text', 'heading',
  ] as const;

  const items: DashboardGridItem[] = [];
  for (let i = 0; i < o.items.length; i++) {
    const it = o.items[i] as Record<string, unknown>;
    if (typeof it?.i !== 'string') {
      err(`layout.items[${i}].i must be a string`);
      continue;
    }
    const x = num(it.x), y = num(it.y), w = num(it.w), h = num(it.h);
    if (x === null || y === null || w === null || h === null) {
      err(`layout.items[${i}] must have numeric x, y, w, h`);
      continue;
    }

    const blockRaw = it.block as Record<string, unknown> | undefined;
    const textRaw = it.text as Record<string, unknown> | undefined;
    const aiPinRaw = it.aiPin as Record<string, unknown> | undefined;
    const semantic = readSemanticQueryRef(it.semantic, i, err);
    let block: DashboardBlockRef | null = null;
    if (blockRaw && typeof blockRaw.blockId === 'string') {
      block = { blockId: blockRaw.blockId, version: typeof blockRaw.version === 'string' ? blockRaw.version : undefined };
    } else if (blockRaw && typeof blockRaw.ref === 'string') {
      block = { ref: blockRaw.ref, version: typeof blockRaw.version === 'string' ? blockRaw.version : undefined };
    }
    const text = textRaw && typeof textRaw.markdown === 'string'
      ? { markdown: textRaw.markdown }
      : null;
    const aiPin = aiPinRaw && typeof aiPinRaw.id === 'string'
      ? { id: aiPinRaw.id }
      : null;
    if (!block && !text && !aiPin && !semantic) {
      err(`layout.items[${i}] must have a block, semantic, text, or aiPin source`);
      continue;
    }

    const vizRaw = it.viz as Record<string, unknown> | undefined;
    if (!vizRaw || typeof vizRaw.type !== 'string'
      || !allowedViz.includes(vizRaw.type as typeof allowedViz[number])) {
      err(`layout.items[${i}].viz.type must be in ${allowedViz.join('|')}`);
      continue;
    }
    let opts: Record<string, unknown> | undefined;
    if (vizRaw.options !== undefined) {
      if (typeof vizRaw.options !== 'object' || vizRaw.options === null || Array.isArray(vizRaw.options)) {
        err(`layout.items[${i}].viz.options must be an object`);
      } else {
        opts = vizRaw.options as Record<string, unknown>;
      }
    }

    const display = readDisplayMetadata(it.display, i, allowedViz, err);
    const filterBindings = readTileFilterBindings(it.filterBindings, i, err);
    const parameterBindings = readTileParameterBindings(it.parameterBindings, i, err);
    const sourceEvidence = readTileSourceEvidence(it.sourceEvidence, i, err);
    const trustState = enumOrUndefined(it.trustState, `layout.items[${i}].trustState`, ['certified', 'review_required', 'draft_ready'] as const, err);
    const reviewStatus = enumOrUndefined(it.reviewStatus, `layout.items[${i}].reviewStatus`, ['certified', 'draft_ready', 'review_required'] as const, err);

    items.push({
      i: it.i,
      x, y, w, h,
      ...(block ? { block } : {}),
      ...(text ? { text } : {}),
      ...(aiPin ? { aiPin } : {}),
      ...(semantic ? { semantic } : {}),
      viz: { type: vizRaw.type as DashboardVizConfig['type'], options: opts },
      ...(display ? { display } : {}),
      ...(filterBindings.length > 0 ? { filterBindings } : {}),
      ...(parameterBindings.length > 0 ? { parameterBindings } : {}),
      ...(sourceEvidence.length > 0 ? { sourceEvidence } : {}),
      ...(trustState ? { trustState } : {}),
      ...(reviewStatus ? { reviewStatus } : {}),
      title: typeof it.title === 'string' ? it.title : undefined,
      ...(typeof it.sectionId === 'string' && it.sectionId ? { sectionId: it.sectionId } : {}),
    });
  }

  return { kind: 'grid', cols, rowHeight, items };
}

function readSemanticQueryRef(
  raw: unknown,
  index: number,
  err: (m: string) => void,
): DashboardSemanticQueryRef | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    err(`layout.items[${index}].semantic must be an object`);
    return undefined;
  }
  const item = raw as Record<string, unknown>;
  const provider = enumValue(item.provider, ['metricflow', 'native'] as const, `layout.items[${index}].semantic.provider`, err);
  const metrics = stringArrayOrUndefined(item.metrics, `layout.items[${index}].semantic.metrics`, err) ?? [];
  const modelRefs = stringArrayOrUndefined(item.semanticModelRefs, `layout.items[${index}].semantic.semanticModelRefs`, err) ?? [];
  if (typeof item.id !== 'string' || !item.id) err(`layout.items[${index}].semantic.id must be a non-empty string`);
  if (metrics.length === 0) err(`layout.items[${index}].semantic.metrics must include at least one metric`);
  if (modelRefs.length === 0) err(`layout.items[${index}].semantic.semanticModelRefs must include at least one reference`);
  if (typeof item.definitionFingerprint !== 'string' || !item.definitionFingerprint) {
    err(`layout.items[${index}].semantic.definitionFingerprint must be a non-empty string`);
  }
  const filters: DashboardSemanticQueryRef['filters'] = [];
  if (item.filters !== undefined) {
    if (!Array.isArray(item.filters)) err(`layout.items[${index}].semantic.filters must be an array`);
    else item.filters.forEach((candidate, filterIndex) => {
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
        err(`layout.items[${index}].semantic.filters[${filterIndex}] must be an object`);
        return;
      }
      const filter = candidate as Record<string, unknown>;
      if (typeof filter.field !== 'string' || typeof filter.operator !== 'string') {
        err(`layout.items[${index}].semantic.filters[${filterIndex}] requires field and operator`);
        return;
      }
      filters.push({ field: filter.field, operator: filter.operator, value: filter.value });
    });
  }
  const orderBy: NonNullable<DashboardSemanticQueryRef['orderBy']> = [];
  if (item.orderBy !== undefined) {
    if (!Array.isArray(item.orderBy)) err(`layout.items[${index}].semantic.orderBy must be an array`);
    else item.orderBy.forEach((candidate, orderIndex) => {
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return;
      const order = candidate as Record<string, unknown>;
      const direction = enumValue(order.direction, ['asc', 'desc'] as const, `layout.items[${index}].semantic.orderBy[${orderIndex}].direction`, err);
      if (typeof order.field === 'string' && direction) orderBy.push({ field: order.field, direction });
    });
  }
  if (!provider || typeof item.id !== 'string' || !item.id || metrics.length === 0 || modelRefs.length === 0 || typeof item.definitionFingerprint !== 'string' || !item.definitionFingerprint) return undefined;
  return {
    id: item.id,
    provider,
    metrics,
    dimensions: stringArrayOrUndefined(item.dimensions, `layout.items[${index}].semantic.dimensions`, err),
    ...(filters.length ? { filters } : {}),
    timeDimension: typeof item.timeDimension === 'string' ? item.timeDimension : undefined,
    ...(orderBy.length ? { orderBy } : {}),
    limit: typeof item.limit === 'number' && item.limit > 0 ? Math.floor(item.limit) : undefined,
    semanticModelRefs: modelRefs,
    definitionFingerprint: item.definitionFingerprint,
    snapshotId: typeof item.snapshotId === 'string' ? item.snapshotId : undefined,
  };
}

function readDisplayMetadata(
  raw: unknown,
  index: number,
  allowedViz: readonly DashboardVizConfig['type'][],
  err: (m: string) => void,
): DashboardDisplayMetadata | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    err(`layout.items[${index}].display must be an object`);
    return undefined;
  }
  const display = raw as Record<string, unknown>;
  const modes = ['manual', 'ai_generated', 'block_hint'] as const;
  const components = [
    'BusinessBrief',
    'KpiMetric',
    'TrendPanel',
    'RankingPanel',
    'EvidenceTable',
    'PivotTable',
    'TrustCallout',
    'NarrativePanel',
    'ResearchActions',
  ] as const;
  const layoutIntents = ['auto', 'compact', 'standard', 'wide', 'tall', 'full'] as const;
  const trustStates = ['certified', 'review_required', 'draft_ready'] as const;
  const reviewStatuses = ['certified', 'draft_ready', 'review_required'] as const;
  const mode = enumValue(display.mode, modes, `layout.items[${index}].display.mode`, err);
  const component = enumValue(display.component, components, `layout.items[${index}].display.component`, err);
  const defaultVisualization = enumValue(display.defaultVisualization, allowedViz, `layout.items[${index}].display.defaultVisualization`, err);
  const layoutIntent = enumValue(display.layoutIntent, layoutIntents, `layout.items[${index}].display.layoutIntent`, err);
  const trustState = enumValue(display.trustState, trustStates, `layout.items[${index}].display.trustState`, err);
  const reviewStatus = enumValue(display.reviewStatus, reviewStatuses, `layout.items[${index}].display.reviewStatus`, err);
  const rationale = typeof display.rationale === 'string' ? display.rationale : undefined;
  if (!rationale) err(`layout.items[${index}].display.rationale must be a string`);
  const allowedVisualizations = Array.isArray(display.allowedVisualizations)
    ? display.allowedVisualizations.filter((value): value is DashboardVizConfig['type'] =>
        typeof value === 'string' && allowedViz.includes(value as DashboardVizConfig['type']),
      )
    : [];
  if (!Array.isArray(display.allowedVisualizations) || allowedVisualizations.length === 0) {
    err(`layout.items[${index}].display.allowedVisualizations must include at least one supported visualization`);
  }
  let fieldHints: Record<string, string> | undefined;
  if (display.fieldHints !== undefined) {
    if (typeof display.fieldHints !== 'object' || display.fieldHints === null || Array.isArray(display.fieldHints)) {
      err(`layout.items[${index}].display.fieldHints must be an object`);
    } else {
      fieldHints = Object.fromEntries(
        Object.entries(display.fieldHints as Record<string, unknown>)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      );
    }
  }
  if (!mode || !component || !defaultVisualization || !layoutIntent || !trustState || !reviewStatus || !rationale || allowedVisualizations.length === 0) {
    return undefined;
  }
  return {
    mode,
    component,
    defaultVisualization,
    allowedVisualizations,
    ...(fieldHints && Object.keys(fieldHints).length > 0 ? { fieldHints } : {}),
    layoutIntent,
    rationale,
    trustState,
    reviewStatus,
  };
}

function readTileFilterBindings(
  raw: unknown,
  index: number,
  err: (m: string) => void,
): DashboardTileFilterBinding[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    err(`layout.items[${index}].filterBindings must be an array`);
    return [];
  }
  const out: DashboardTileFilterBinding[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      err(`layout.items[${index}].filterBindings[${i}] must be an object`);
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.filter !== 'string' || record.filter.length === 0) {
      err(`layout.items[${index}].filterBindings[${i}].filter must be a non-empty string`);
      continue;
    }
    const mode = enumOrUndefined(record.mode, `layout.items[${index}].filterBindings[${i}].mode`, ['parameter', 'predicate'] as const, err);
    const paramNames = stringArrayOrUndefined(record.paramNames, `layout.items[${index}].filterBindings[${i}].paramNames`, err);
    out.push({
      filter: record.filter,
      binding: typeof record.binding === 'string' ? record.binding : undefined,
      ...(mode ? { mode } : {}),
      ...(paramNames ? { paramNames } : {}),
      required: typeof record.required === 'boolean' ? record.required : undefined,
      unsupportedReason: typeof record.unsupportedReason === 'string' ? record.unsupportedReason : undefined,
    });
  }
  return out;
}

function readTileParameterBindings(
  raw: unknown,
  index: number,
  err: (m: string) => void,
): DashboardTileParameterBinding[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    err(`layout.items[${index}].parameterBindings must be an array`);
    return [];
  }
  const out: DashboardTileParameterBinding[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      err(`layout.items[${index}].parameterBindings[${i}] must be an object`);
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.param !== 'string' || record.param.length === 0) {
      err(`layout.items[${index}].parameterBindings[${i}].param must be a non-empty string`);
      continue;
    }
    const source = enumValue(record.source, ['dashboard_filter', 'constant', 'persona', 'variable'] as const, `layout.items[${index}].parameterBindings[${i}].source`, err);
    if (!source) continue;
    out.push({
      param: record.param,
      source,
      filter: typeof record.filter === 'string' ? record.filter : undefined,
      field: typeof record.field === 'string' ? record.field : undefined,
      value: record.value,
      parameterType: enumOrUndefined(record.parameterType, `layout.items[${index}].parameterBindings[${i}].parameterType`, ['string', 'number', 'boolean', 'date', 'string[]', 'number[]', 'date[]'] as const, err),
      required: typeof record.required === 'boolean' ? record.required : undefined,
      default: record.default,
      policy: enumOrUndefined(record.policy, `layout.items[${index}].parameterBindings[${i}].policy`, ['dynamic', 'static', 'business', 'derived', 'optional', 'ambiguous_review_required'] as const, err),
    });
  }
  return out;
}

function readTileSourceEvidence(
  raw: unknown,
  index: number,
  err: (m: string) => void,
): DashboardTileSourceEvidence[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    err(`layout.items[${index}].sourceEvidence must be an array`);
    return [];
  }
  const out: DashboardTileSourceEvidence[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      err(`layout.items[${index}].sourceEvidence[${i}] must be an object`);
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.source !== 'string' || record.source.length === 0) {
      err(`layout.items[${index}].sourceEvidence[${i}].source must be a non-empty string`);
      continue;
    }
    if (typeof record.reason !== 'string' || record.reason.length === 0) {
      err(`layout.items[${index}].sourceEvidence[${i}].reason must be a non-empty string`);
      continue;
    }
    const trustState = enumOrUndefined(record.trustState, `layout.items[${index}].sourceEvidence[${i}].trustState`, ['certified', 'review_required', 'draft_ready'] as const, err);
    out.push({
      source: record.source,
      reason: record.reason,
      kind: typeof record.kind === 'string' ? record.kind : undefined,
      nodeId: typeof record.nodeId === 'string' ? record.nodeId : undefined,
      path: typeof record.path === 'string' ? record.path : undefined,
      ...(trustState ? { trustState } : {}),
    });
  }
  return out;
}

function enumValue<T extends readonly string[]>(
  raw: unknown,
  allowed: T,
  field: string,
  err: (m: string) => void,
): T[number] | undefined {
  if (typeof raw !== 'string' || !allowed.includes(raw as T[number])) {
    err(`${field} must be one of ${allowed.join('|')}`);
    return undefined;
  }
  return raw as T[number];
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function enumOrUndefined<T extends readonly string[]>(
  raw: unknown,
  field: string,
  allowed: T,
  err: (m: string) => void,
): T[number] | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'string' && (allowed as readonly string[]).includes(raw)) return raw as T[number];
  err(`${field} must be one of ${allowed.join('|')}`);
  return undefined;
}
