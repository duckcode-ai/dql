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
