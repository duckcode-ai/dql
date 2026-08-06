import React, { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CalendarDays, Hash, List, ToggleLeft, Type } from 'lucide-react';
import { api, type DashboardDocumentResponse } from '../../api/client';
import { defaultParameterFilterValue } from './dashboard-filters';
import { formatBusinessLabel } from './app-text';

/**
 * The App dashboard filter row: the controls, their value coercion, and the
 * per-type icons.
 *
 * Extracted from `AppsView.tsx`. Self-contained — it reads and writes a plain
 * `Record<string, unknown>` of filter values and knows nothing about the App.
 */
type DashboardFilter = NonNullable<DashboardDocumentResponse['dashboard']['filters']>[number];

export function DashboardFilterControls({
  filters,
  values,
  onChange,
}: {
  filters: DashboardFilter[];
  values: Record<string, unknown>;
  onChange: (filter: DashboardFilter, value: unknown) => void;
}) {
  if (filters.length === 0) {
    return <span className="dql-app-filter-empty">No filters</span>;
  }
  return (
    <>
      {filters.map((filter) => (
        <DashboardFilterInput
          key={filter.id}
          filter={filter}
          value={values[filter.id] ?? defaultDashboardFilterValue(filter)}
          onChange={(value) => onChange(filter, value)}
        />
      ))}
    </>
  );
}

function DashboardFilterInput({
  filter,
  value,
  onChange,
}: {
  filter: DashboardFilter;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const label = formatBusinessLabel(filter.id);
  const valueText = filterInputValue(filter, value);
  // Categorical filters bound to a tile: fetch the column's distinct values and
  // upgrade the free-text box to a real dropdown (low-cardinality only).
  const sourceBlockId = (filter as { sourceBlockId?: string }).sourceBlockId;
  const column = filter.bindsTo || filter.id;
  const wantsOptions = (filter.type === 'string' || filter.type === 'select') && Boolean(sourceBlockId) && !filter.options?.length;
  const [fetchedOptions, setFetchedOptions] = useState<string[] | null>(null);
  useEffect(() => {
    if (!wantsOptions || !sourceBlockId) return;
    let cancelled = false;
    void api.dashboardFilterOptions(sourceBlockId, column).then((res) => {
      if (!cancelled && res && res.options.length > 0 && !res.truncated) setFetchedOptions(res.options);
    });
    return () => { cancelled = true; };
  }, [sourceBlockId, column, wantsOptions]);
  if (fetchedOptions && fetchedOptions.length > 0) {
    return (
      <FilterSelect
        icon={filterIconForDashboardFilter(filter)}
        label={label}
        value={valueText}
        onChange={onChange}
        options={[['', `All ${label.toLowerCase()}`], ...fetchedOptions.map((opt) => [opt, opt] as [string, string])]}
      />
    );
  }
  if (filter.type === 'select') {
    return (
      <FilterSelect
        icon={filterIconForDashboardFilter(filter)}
        label={label}
        value={valueText}
        onChange={onChange}
        options={filterOptions(filter)}
      />
    );
  }
  if (filter.type === 'boolean') {
    return (
      <FilterSelect
        icon={filterIconForDashboardFilter(filter)}
        label={label}
        value={String(Boolean(value))}
        onChange={(next) => onChange(next === 'true')}
        options={[
          ['true', 'Yes'],
          ['false', 'No'],
        ]}
      />
    );
  }
  if (filter.type === 'daterange') {
    const range = value && typeof value === 'object' && !Array.isArray(value)
      ? (value as { start?: unknown; end?: unknown })
      : {};
    const start = typeof range.start === 'string' ? range.start : '';
    const end = typeof range.end === 'string' ? range.end : '';
    // Emit a range ONLY when both ends are set (runtime needs both for BETWEEN);
    // a partial range is sent as undefined so the filter is simply skipped.
    const emit = (nextStart: string, nextEnd: string) =>
      onChange(nextStart && nextEnd ? { start: nextStart, end: nextEnd } : undefined);
    return (
      <label className="dql-app-filter-select dql-app-filter-range" title={filter.bindsTo ? `${label} -> ${filter.bindsTo}` : label} aria-label={label}>
        <span className="dql-app-filter-icon">{filterIconForDashboardFilter(filter)}</span>
        <input type="date" value={start} aria-label={`${label} from`} onChange={(event) => emit(event.target.value, end)} />
        <span className="dql-app-filter-range-sep">–</span>
        <input type="date" value={end} aria-label={`${label} to`} onChange={(event) => emit(start, event.target.value)} />
      </label>
    );
  }
  return (
    <label className="dql-app-filter-select" title={filter.bindsTo ? `${label} -> ${filter.bindsTo}` : label} aria-label={label}>
      <span className="dql-app-filter-icon">{filterIconForDashboardFilter(filter)}</span>
      <input
        type={filter.type === 'number' ? 'number' : filter.type === 'date' ? 'date' : 'text'}
        value={valueText}
        placeholder={label}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function filterIconForDashboardFilter(filter: DashboardFilter): ReactNode {
  if (filter.type === 'date' || filter.type === 'daterange' || /season|year|date|time|period/i.test(filter.id)) {
    return <CalendarDays size={13} />;
  }
  return <Hash size={13} />;
}

function filterOptions(filter: DashboardFilter): Array<[string, string]> {
  const options = filter.options?.length ? filter.options : [filter.default].filter((value) => value !== undefined);
  return options.map((option) => [String(option), formatBusinessLabel(String(option))]);
}

export function defaultDashboardFilterValue(filter: DashboardFilter): unknown {
  if (filter.default !== undefined) return filter.default;
  if (filter.type === 'number') return defaultParameterFilterValue(filter.id);
  if (filter.type === 'boolean') return false;
  if (filter.type === 'select') return filter.options?.[0] ?? '';
  return '';
}

function filterInputValue(filter: DashboardFilter, value: unknown): string {
  if (value === undefined || value === null) return String(defaultDashboardFilterValue(filter) ?? '');
  if (filter.type === 'daterange' && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function coerceDashboardFilterValue(filter: DashboardFilter, value: unknown): unknown {
  if (filter.type === 'number') {
    if (typeof value === 'string' && value.trim() === '') return '';
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : value;
  }
  if (filter.type === 'boolean') return value === true || value === 'true';
  if (filter.type === 'select' && typeof filter.default === 'number') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : value;
  }
  return value;
}

export function shallowEqualRecords(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.is(left[key], right[key]));
}

function FilterSelect({
  label,
  icon,
  value,
  options,
  onChange,
}: {
  label: string;
  icon?: ReactNode;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="dql-app-filter-select" title={label} aria-label={label}>
      {icon ? <span className="dql-app-filter-icon">{icon}</span> : <span>{label}</span>}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select>
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button type="button" className={`dql-app-toggle ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}>
      <i /> {label}
    </button>
  );
}
