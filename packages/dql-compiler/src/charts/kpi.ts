import type { ChartIR } from '../ir/ir-nodes.js';
import type { ThemeConfig } from '../themes/theme-types.js';

export interface KPISpec {
  type: 'kpi';
  chartId: string;
  title?: string;
  metrics: string[];
  compareToPrevious: boolean;
  formatting?: string;
  theme: ThemeConfig;
}

export function emitKPISpec(chart: ChartIR, theme: ThemeConfig): KPISpec {
  return {
    type: 'kpi',
    chartId: chart.id,
    title: chart.title,
    metrics: chart.config.metrics ?? [],
    compareToPrevious: chart.config.compareToPrevious ?? false,
    formatting: chart.config.formatting,
    theme,
  };
}

export function renderKPIHTML(spec: KPISpec, data: Record<string, unknown>[]): string {
  const { theme, title, metrics, formatting } = spec;
  const row = data[0] ?? {};

  const metricCards = metrics.map((metric) => {
    const value = row[metric];
    const displayValue = formatValue(value, formatting);

    return `
      <div class="dql-kpi-card" style="
        background: ${theme.cardBackground};
        border: 1px solid ${theme.borderColor};
        border-radius: 8px;
        padding: 20px;
        text-align: center;
        min-width: 150px;
      ">
        <div class="dql-kpi-label" style="
          color: ${theme.textColor};
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 8px;
        ">${formatLabel(metric)}</div>
        <div class="dql-kpi-value" style="
          color: ${theme.titleColor};
          font-size: 28px;
          font-weight: 700;
        ">${displayValue}</div>
      </div>
    `;
  });

  return `
    <div class="dql-kpi-container" id="${spec.chartId}">
      ${title ? `<h3 style="color: ${theme.titleColor}; margin-bottom: 12px;">${title}</h3>` : ''}
      <div style="display: flex; gap: 16px; flex-wrap: wrap;">
        ${metricCards.join('')}
      </div>
    </div>
  `;
}

function formatValue(value: unknown, formatting?: string): string {
  if (value == null) return '-';
  const num = Number(value);
  if (isNaN(num)) return String(value);

  switch (formatting) {
    case 'currency':
      return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    case 'percent':
      return `${(num * 100).toFixed(1)}%`;
    case 'integer':
      return num.toLocaleString('en-US', { maximumFractionDigits: 0 });
    default:
      return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
}

function formatLabel(metric: string): string {
  return metric.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
