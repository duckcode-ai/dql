import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TableOutput } from '../output/TableOutput';

describe('App-sized table rendering (UI-022, E2E-020)', () => {
  it('shows 10 rows initially while retaining the complete result for paging and export', () => {
    const rows = Array.from({ length: 14 }, (_, index) => ({
      rank: index + 1,
      customer: `Customer ${index + 1}`,
    }));
    const markup = renderToStaticMarkup(<TableOutput
      result={{ columns: ['rank', 'customer'], rows, rowCount: rows.length }}
      themeMode="light"
      initialPageSize={10}
    />);

    expect(markup).toContain('Showing 1–10 of 14 rows');
    expect(markup).toContain('10 / page');
    expect(markup).toContain('Customer 10');
    expect(markup).not.toContain('Customer 11');
    expect(markup).toContain('1/2');
  });
});
