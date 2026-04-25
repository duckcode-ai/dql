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
    | 'line'
    | 'bar'
    | 'area'
    | 'pie'
    | 'table'
    | 'pivot'
    | 'map'
    | 'funnel'
    | 'kpi';
  /** Free-form per-renderer options (axes, colors, etc.). */
  options?: Record<string, unknown>;
};

export type DashboardGridItem = {
  /** Stable layout id — used by the grid editor for positioning persistence. */
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  block: DashboardBlockRef;
  viz: DashboardVizConfig;
  /** Optional human-readable title shown in the tile header. */
  title?: string;
};

export interface DashboardDocument {
  version: 1;
  id: string;
  metadata: {
    title: string;
    description?: string;
    domain?: string;
    tags?: string[];
  };
  params?: DashboardParam[];
  filters?: DashboardFilter[];
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
      layout,
    },
    errors: [],
  };
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
    tags: tagsTyped,
  };
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
    'single_value', 'line', 'bar', 'area', 'pie', 'table', 'pivot', 'map', 'funnel', 'kpi',
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
    let block: DashboardBlockRef | null = null;
    if (blockRaw && typeof blockRaw.blockId === 'string') {
      block = { blockId: blockRaw.blockId, version: typeof blockRaw.version === 'string' ? blockRaw.version : undefined };
    } else if (blockRaw && typeof blockRaw.ref === 'string') {
      block = { ref: blockRaw.ref, version: typeof blockRaw.version === 'string' ? blockRaw.version : undefined };
    }
    if (!block) {
      err(`layout.items[${i}].block must be { blockId } or { ref }`);
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

    items.push({
      i: it.i,
      x, y, w, h,
      block,
      viz: { type: vizRaw.type as DashboardVizConfig['type'], options: opts },
      title: typeof it.title === 'string' ? it.title : undefined,
    });
  }

  return { kind: 'grid', cols, rowHeight, items };
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
