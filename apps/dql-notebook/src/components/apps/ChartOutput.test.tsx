import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { renderChart } from '../output/ChartOutput';

describe('App-sized chart rendering (UI-022)', () => {
  it('fits a monthly bar series to the measured tile height with business date labels', () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      month: `2024-${String(index + 1).padStart(2, '0')}-01T00:00:00.000Z`,
      gross_revenue: (index + 1) * 1_000,
    }));
    const markup = renderToStaticMarkup(renderChart('bar', {
      columns: ['month', 'gross_revenue'],
      rows,
      rowCount: rows.length,
      executionTime: 4,
    }, 'light', { chart: 'bar', x: 'month', y: 'gross_revenue' }, 240));

    expect(markup).toContain('Jan 2024');
    expect(markup).toContain('Dec 2024');
    expect(markup).not.toContain('2024-01-01T00:0');
    expect(markup).toContain('height="236"');
  });

  it('uses one series color when no categorical color field is configured', () => {
    const markup = renderToStaticMarkup(renderChart('bar', {
      columns: ['category', 'revenue'],
      rows: [
        { category: 'A', revenue: 10 },
        { category: 'B', revenue: 20 },
        { category: 'C', revenue: 30 },
      ],
      rowCount: 3,
      executionTime: 2,
    }, 'light', { chart: 'bar' }, 180));

    expect(markup).toContain('fill="#388bfd"');
    expect(markup).not.toContain('fill="#56d364"');
    expect(markup).not.toContain('fill="#e3b341"');
  });

  it('uses measured narrow width so labels are not scaled from a desktop viewBox', () => {
    const markup = renderToStaticMarkup(renderChart('line', {
      columns: ['month', 'gross_revenue'],
      rows: [
        { month: '2025-01-01T00:00:00.000Z', gross_revenue: 10_000 },
        { month: '2025-02-01T00:00:00.000Z', gross_revenue: 12_000 },
      ],
      rowCount: 2,
      executionTime: 2,
    }, 'light', { chart: 'line' }, 220, 252));

    expect(markup).toContain('viewBox="0 0 252 216"');
    expect(markup).not.toContain('viewBox="0 0 560');
  });
});
