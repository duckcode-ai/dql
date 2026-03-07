export class KPIRenderer {
  render(containerId: string, data: Record<string, unknown>[], metrics: string[]): void {
    const container = document.getElementById(containerId);
    if (!container || data.length === 0) return;

    const row = data[0];
    const cards = metrics
      .map((metric) => {
        const value = row[metric];
        const label = metric.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
        return `<div class="dql-kpi-card"><div class="dql-kpi-label">${label}</div><div class="dql-kpi-value">${value ?? '-'}</div></div>`;
      })
      .join('');

    container.innerHTML = `<div class="dql-kpi-grid">${cards}</div>`;
  }
}
