import { describe, expect, it } from 'vitest';
import {
  hydrateAppScopedDashboardFilterValues,
  pagesForDashboardFilterValue,
  readPersistedAppFilterValues,
  valuesForDashboardPage,
  writePersistedAppFilterValues,
} from './app-dashboard-filter-scope';

const pages = [
  { id: 'overview', filters: [
    { id: 'region', scope: { app: true } },
    { id: 'status', scope: { page: 'overview' } },
  ] },
  { id: 'details', filters: [
    { id: 'region', scope: { app: true } },
    // A deliberate id collision with a page-local control must not create an
    // implicit App-wide filter.
    { id: 'status', scope: { page: 'details' } },
  ] },
];

describe('App dashboard filter scope', () => {
  it('moves only explicitly App-scoped values across pages', () => {
    expect(pagesForDashboardFilterValue(pages, 'overview', pages[0]!.filters[0]!)).toEqual(['overview', 'details']);
    expect(pagesForDashboardFilterValue(pages, 'overview', pages[0]!.filters[1]!)).toEqual(['overview']);

    expect(valuesForDashboardPage({
      filters: pages[1]!.filters,
      pageValues: { status: 'open' },
      appValues: { region: 'CA', status: 'wrong-page' },
      defaultValue: () => '',
    })).toEqual({ region: 'CA', status: 'open' });
  });

  it('hydrates a newly added App page without changing a same-id page-local value', () => {
    const page = {
      id: 'page-3',
      filters: [
        { id: 'region', scope: { app: true } },
        { id: 'status', scope: { page: 'page-3' } },
      ],
    };

    expect(hydrateAppScopedDashboardFilterValues({
      filters: page.filters,
      pageValues: { status: 'open' },
      appValues: { region: 'CA', status: 'must-not-leak' },
    })).toEqual({ region: 'CA', status: 'open' });

    // Clearing a shared control is still an intentional App selection. A
    // later page must show All values rather than reviving an old page value.
    expect(hydrateAppScopedDashboardFilterValues({
      filters: page.filters,
      pageValues: { region: 'CA', status: 'open' },
      appValues: { region: '' },
    })).toEqual({ region: '', status: 'open' });
  });

  it('persists only a validated object envelope for an App session', () => {
    const writes = new Map<string, string>();
    const storage: Pick<Storage, 'getItem' | 'setItem'> = {
      getItem: (key: string) => writes.get(key) ?? null,
      setItem: (key: string, value: string) => { writes.set(key, value); },
    };
    writePersistedAppFilterValues(storage, 'app:commerce', {
      draft: { region: 'CA' },
      applied: { region: 'CA' },
    });
    expect(readPersistedAppFilterValues(storage, 'app:commerce')).toEqual({
      draft: { region: 'CA' },
      applied: { region: 'CA' },
    });
    writes.set('bad', JSON.stringify({ draft: ['CA'], applied: 'CA' }));
    expect(readPersistedAppFilterValues(storage, 'bad')).toEqual({ draft: {}, applied: {} });
  });
});
