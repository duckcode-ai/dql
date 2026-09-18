/**
 * Browser-pure App filter scope helpers.
 *
 * A dashboard filter id is only meaningful inside its declaring page unless
 * both pages explicitly declare it with `scope.app`.  Keeping that decision
 * here prevents a convenient shared state object from turning two unrelated
 * page controls with the same id into an implicit cross-page binding.
 */

export type ScopedDashboardFilter = {
  id: string;
  scope?: { app?: boolean; page?: string; tileIds?: string[] };
};

export type ScopedDashboardPage<TFilter extends ScopedDashboardFilter = ScopedDashboardFilter> = {
  id: string;
  filters?: TFilter[];
};

export type PersistedAppFilterValues = {
  draft: Record<string, unknown>;
  applied: Record<string, unknown>;
};

export function isAppScopedDashboardFilter(filter: ScopedDashboardFilter | undefined | null): boolean {
  return filter?.scope?.app === true;
}

/**
 * Pages that may receive a value change from this exact control. Page-local
 * controls remain on their declared page, even where another page reused the
 * same id for a different governed field.
 */
export function pagesForDashboardFilterValue<TFilter extends ScopedDashboardFilter>(
  pages: Array<ScopedDashboardPage<TFilter>>,
  sourcePageId: string,
  filter: TFilter,
): string[] {
  if (!isAppScopedDashboardFilter(filter)) return [sourcePageId];
  return pages
    .filter((page) => page.filters?.some((candidate) => (
      candidate.id === filter.id && isAppScopedDashboardFilter(candidate)
    )))
    .map((page) => page.id);
}

/**
 * Hydrate only the controls declared on a page. An App-scoped value wins for
 * an App-scoped control; a same-named page-local control never receives it.
 */
export function valuesForDashboardPage<TFilter extends ScopedDashboardFilter>(input: {
  filters: TFilter[];
  pageValues: Record<string, unknown>;
  appValues: Record<string, unknown>;
  defaultValue: (filter: TFilter) => unknown;
}): Record<string, unknown> {
  const hydrated = hydrateAppScopedDashboardFilterValues(input);
  return Object.fromEntries(input.filters.map((filter) => [
    filter.id,
    hydrated[filter.id] ?? input.defaultValue(filter),
  ]));
}

/**
 * Project current App-scoped selections onto one declared page. Keeping the
 * shared values separate from the page map lets a page added after selection
 * receive its App control without making a same-id page-local control global.
 */
export function hydrateAppScopedDashboardFilterValues<TFilter extends ScopedDashboardFilter>(input: {
  filters: TFilter[];
  pageValues: Record<string, unknown>;
  appValues: Record<string, unknown>;
}): Record<string, unknown> {
  const hydrated = { ...input.pageValues };
  for (const filter of input.filters) {
    if (!isAppScopedDashboardFilter(filter) || !Object.prototype.hasOwnProperty.call(input.appValues, filter.id)) continue;
    hydrated[filter.id] = input.appValues[filter.id];
  }
  return hydrated;
}

export function readPersistedAppFilterValues(storage: Pick<Storage, 'getItem'>, key: string): PersistedAppFilterValues {
  try {
    const raw = storage.getItem(key);
    if (!raw) return { draft: {}, applied: {} };
    const value = JSON.parse(raw) as Partial<PersistedAppFilterValues>;
    return {
      draft: isRecord(value.draft) ? value.draft : {},
      applied: isRecord(value.applied) ? value.applied : {},
    };
  } catch {
    return { draft: {}, applied: {} };
  }
}

export function writePersistedAppFilterValues(
  storage: Pick<Storage, 'setItem'>,
  key: string,
  value: PersistedAppFilterValues,
): void {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Filter state is a convenience. The current in-memory page remains usable
    // when local storage is unavailable.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
