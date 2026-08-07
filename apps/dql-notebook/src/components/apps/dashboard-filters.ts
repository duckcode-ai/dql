import type { DashboardDocumentResponse } from '../../api/client';

type DashboardFilter = NonNullable<DashboardDocumentResponse['dashboard']['filters']>[number];
type DashboardLayoutItem = DashboardDocumentResponse['dashboard']['layout']['items'][number];

export function deriveDashboardFilters(dashboard: DashboardDocumentResponse['dashboard'] | null): DashboardFilter[] {
  // UI-001, E2E-001: only predicate/output bindings may drive distinct-value probes.
  if (!dashboard) return [];
  const filters = new Map<string, DashboardFilter>();
  for (const filter of dashboard.filters ?? []) {
    if (isUsefulDashboardFilter(filter)) filters.set(filter.id, { ...filter });
  }
  const blockIdOf = (item: DashboardLayoutItem): string | undefined =>
    item.block?.blockId ?? item.block?.ref;
  for (const item of dashboard.layout.items ?? []) {
    const bid = blockIdOf(item);
    for (const binding of item.filterBindings ?? []) {
      const mode = binding.mode ?? (binding.binding ? 'predicate' : undefined);
      if (!bid || mode !== 'predicate' || !binding.binding || binding.unsupportedReason) continue;
      const existing = filters.get(binding.filter);
      if (!existing) continue;
      if (!existing.bindsTo) existing.bindsTo = binding.binding;
      if (!(existing as { sourceBlockId?: string }).sourceBlockId) {
        (existing as { sourceBlockId?: string }).sourceBlockId = bid;
      }
    }
    for (const binding of item.parameterBindings ?? []) {
      const id = binding.filter || binding.field || binding.param;
      if (!id) continue;
      if (filters.has(id)) continue;
      if (isCoveredByExistingDashboardFilter(filters, binding)) continue;
      filters.set(id, filterFromParameterBinding(binding));
    }
  }
  return Array.from(filters.values());
}

export type DashboardFilterCoverage = {
  filterId: string;
  /** Tiles the filter actually narrows. */
  applied: string[];
  /** Tiles it leaves showing everything, with the reason when one is recorded. */
  unaffected: Array<{ tileId: string; title?: string; reason?: string }>;
  /** Tiles that could be filtered at all — text and heading tiles are excluded. */
  filterable: number;
};

/**
 * Which tiles a global filter actually reaches.
 *
 * A filter that narrows two of five tiles looks identical on screen to one that
 * narrows all five: `unsupportedReason` was only ever used to drop a binding
 * from the derived list, never shown. That silence is the dangerous part — you
 * filter to one customer, half the tiles keep showing everyone, and the
 * dashboard reads as if it were all one scope.
 */
export function dashboardFilterCoverage(
  dashboard: DashboardDocumentResponse['dashboard'] | null,
  filterId: string,
  run?: {
    tiles?: Array<{ tileId?: string; filterableColumns?: Array<{ column: string }> }>;
  } | null,
): DashboardFilterCoverage {
  const items = (dashboard?.layout.items ?? []).filter((item) => !isNarrativeTile(item));
  // A filter the author never declared has no `filterBindings` anywhere, so its
  // reach has to come from the tiles that reported the column as filterable.
  // Reading only the document would report "reaches no tile" for every column a
  // viewer picks, immediately before the page filters correctly.
  const declared = (dashboard?.filters ?? []).some((filter) => filter.id === filterId);
  if (!declared && run) {
    const offering = new Set(
      (run.tiles ?? [])
        .filter((tile) => (tile.filterableColumns ?? []).some((candidate) => candidate.column === filterId))
        .map((tile) => tile.tileId)
        .filter((tileId): tileId is string => Boolean(tileId)),
    );
    return {
      filterId,
      applied: items.filter((item) => offering.has(item.i)).map((item) => item.i),
      unaffected: items.filter((item) => !offering.has(item.i)).map((item) => ({
        tileId: item.i,
        title: item.title,
        reason: 'This tile does not return a column that can be filtered by this value.',
      })),
      filterable: items.length,
    };
  }
  const applied: string[] = [];
  const unaffected: DashboardFilterCoverage['unaffected'] = [];
  for (const item of items) {
    const binding = (item.filterBindings ?? []).find((candidate) => candidate.filter === filterId)
      ?? (item.parameterBindings ?? []).find((candidate) => (candidate.filter || candidate.field || candidate.param) === filterId);
    const bound = Boolean(binding)
      && !(binding as { unsupportedReason?: string }).unsupportedReason
      && Boolean((binding as { binding?: string; param?: string }).binding ?? (binding as { param?: string }).param);
    if (bound) applied.push(item.i);
    else {
      unaffected.push({
        tileId: item.i,
        title: item.title,
        reason: (binding as { unsupportedReason?: string } | undefined)?.unsupportedReason
          ?? (binding ? 'The tile declares this filter but nothing to bind it to.' : 'This tile has no column matching the filter.'),
      });
    }
  }
  return { filterId, applied, unaffected, filterable: items.length };
}

export type DashboardFilterCandidate = {
  column: string;
  /** How many tiles return this column — its reach if made a global filter. */
  tiles: number;
  sampleValues: string[];
};

/**
 * Business columns a viewer may filter this page by.
 *
 * The candidates come from each tile's server-supplied `filterableColumns`,
 * which is decided from a real dialect parse of the SQL that ran — the same
 * rule Ask and the Notebook use for result filters. An earlier version of this
 * guessed from result column names with a measure-shaped regex; that is exactly
 * what `sql-result-filter.ts` warns against, because an aggregate output needs
 * HAVING and filtering it in WHERE silently changes the number.
 *
 * Ranked by reach so the most page-wide scope is offered first. A column only
 * one tile can honour is still offered — the coverage badge tells the truth
 * about its reach, which is a better trade than hiding a useful filter.
 */
export function dashboardFilterCandidates(
  dashboard: DashboardDocumentResponse['dashboard'] | null,
  run: {
    tiles?: Array<{
      filterableColumns?: Array<{ column: string; predicateTarget: string }>;
      result?: { columns?: string[]; rows?: Array<Record<string, unknown>> };
    }>;
  } | null,
): DashboardFilterCandidate[] {
  const existing = new Set((dashboard?.filters ?? []).map((filter) => filter.id));
  const byColumn = new Map<string, { tiles: number; values: Set<string> }>();
  for (const tile of run?.tiles ?? []) {
    for (const candidate of tile.filterableColumns ?? []) {
      if (existing.has(candidate.column)) continue;
      const entry = byColumn.get(candidate.column) ?? { tiles: 0, values: new Set<string>() };
      entry.tiles += 1;
      for (const row of (tile.result?.rows ?? []).slice(0, 24)) {
        const value = row?.[candidate.column];
        if ((typeof value === 'string' || typeof value === 'number') && String(value).trim() && entry.values.size < 24) {
          entry.values.add(String(value));
        }
      }
      byColumn.set(candidate.column, entry);
    }
  }
  return Array.from(byColumn.entries())
    .map(([column, entry]) => ({ column, tiles: entry.tiles, sampleValues: Array.from(entry.values).sort() }))
    .sort((a, b) => b.tiles - a.tiles || a.column.localeCompare(b.column));
}

/** Text and heading tiles carry no data, so they are not "missing" a filter. */
function isNarrativeTile(item: DashboardLayoutItem): boolean {
  const viz = String(item.viz?.type ?? '');
  return Boolean(item.text) || viz === 'text' || viz === 'heading';
}

function isUsefulDashboardFilter(filter: DashboardFilter): boolean {
  if (filter.type === 'select' && !filter.options?.length && filter.default === undefined) return false;
  return true;
}

function filterFromParameterBinding(
  binding: NonNullable<DashboardLayoutItem['parameterBindings']>[number],
): DashboardFilter {
  const id = binding.filter || binding.field || binding.param;
  return {
    id,
    type: parameterFilterType(id, binding.parameterType),
    default: binding.default ?? defaultParameterFilterValue(id),
    bindsTo: binding.param,
  };
}

function isCoveredByExistingDashboardFilter(
  filters: Map<string, DashboardFilter>,
  binding: NonNullable<DashboardLayoutItem['parameterBindings']>[number],
): boolean {
  return Array.from(filters.values()).some((filter) => {
    if (binding.filter && filter.id === binding.filter) return true;
    if (binding.field && filter.bindsTo === binding.field) return true;
    return Boolean(binding.param && filter.bindsTo === binding.param);
  });
}

function parameterFilterType(id: string, parameterType?: string): DashboardFilter['type'] {
  if (parameterType === 'number' || parameterType === 'number[]') return 'number';
  if (parameterType === 'boolean') return 'boolean';
  if (parameterType === 'date' || parameterType === 'date[]') return 'date';
  // Time-ish columns get a date-RANGE picker (the runtime applies BETWEEN). Covers
  // the common dbt/warehouse naming (`ordered_at`, `_at`, `_date`, `_time`, `_ts`).
  if (/(_at$|_date$|_time$|_ts$|date|time|day|week|month|quarter|period)/i.test(id)) return 'daterange';
  if (/(top[_-]?n|limit|count|number|year|season)/i.test(id)) return 'number';
  return 'string';
}

export function defaultParameterFilterValue(id: string): unknown {
  const normalized = id.toLowerCase();
  if (/(top[_-]?n|limit)/.test(normalized)) return 5;
  if (/(season|year).*start|start.*(season|year)/.test(normalized)) return 2016;
  if (/(season|year).*end|end.*(season|year)/.test(normalized)) return 2017;
  return '';
}
