import type { ChartIR } from '../ir/ir-nodes.js';
import type { ThemeConfig } from '../themes/theme-types.js';

export interface TableSpec {
  type: 'table';
  chartId: string;
  title?: string;
  columns?: string[];
  sortable: boolean;
  pageSize: number;
  theme: ThemeConfig;
}

export function emitTableSpec(chart: ChartIR, theme: ThemeConfig): TableSpec {
  return {
    type: 'table',
    chartId: chart.id,
    title: chart.title,
    columns: chart.config.columns,
    sortable: chart.config.sortable ?? true,
    pageSize: chart.config.pageSize ?? 25,
    theme,
  };
}

export function renderTableHTML(spec: TableSpec, data: Record<string, unknown>[]): string {
  const { theme, title, columns: specColumns, sortable } = spec;
  const columns = specColumns ?? (data.length > 0 ? Object.keys(data[0]) : []);

  const headerCells = columns
    .map(
      (col) =>
        `<th style="
          padding: 10px 16px;
          text-align: left;
          border-bottom: 2px solid ${theme.borderColor};
          color: ${theme.textColor};
          font-weight: 600;
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          ${sortable ? 'cursor: pointer;' : ''}
        ">${formatLabel(col)}</th>`,
    )
    .join('');

  const bodyRows = data
    .map(
      (row) =>
        `<tr>${columns
          .map(
            (col) =>
              `<td style="
                padding: 8px 16px;
                border-bottom: 1px solid ${theme.borderColor};
                color: ${theme.foreground};
              ">${row[col] ?? ''}</td>`,
          )
          .join('')}</tr>`,
    )
    .join('');

  return `
    <div class="dql-table-container" id="${spec.chartId}">
      ${title ? `<h3 style="color: ${theme.titleColor}; margin-bottom: 12px;">${title}</h3>` : ''}
      <div style="overflow-x: auto;">
        <table style="
          width: 100%;
          border-collapse: collapse;
          background: ${theme.cardBackground};
          border-radius: 8px;
          font-family: ${theme.fontFamily};
        ">
          <thead><tr>${headerCells}</tr></thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>
    </div>
  `;
}

function formatLabel(col: string): string {
  return col.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
