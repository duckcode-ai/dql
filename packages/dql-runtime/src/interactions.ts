import { escapeHTML, cleanDatum, getClickedLabel } from './utils.js';
import { DataFetcher } from './data-fetcher.js';

export interface InteractionConfig {
  drillDown?: string;
  linkTo?: string;
  onClick?: string;
  filterBy?: string | string[];
}

interface DrillFrame {
  chartId: string;
  label: string;
  templateSQL: string;
  datum: Record<string, unknown>;
  predicates: Record<string, unknown[]>;
  connectionId?: string;
}

export interface InteractionState {
  crossFilters: Record<string, Record<string, unknown[]>>;
  drillStack: DrillFrame[];
}

export interface InteractionManagerOptions {
  onStateChange?: (state: InteractionState) => void;
}

export class InteractionManager {
  private vegaViews: Record<string, any> = {};
  private fetcher: DataFetcher;
  private crossFilterState: Record<string, Record<string, unknown[]>> = {};
  private drillStack: DrillFrame[] = [];
  private onStateChange?: (state: InteractionState) => void;

  constructor(fetcher: DataFetcher, options: InteractionManagerOptions = {}) {
    this.fetcher = fetcher;
    this.onStateChange = options.onStateChange;
  }

  registerView(chartId: string, view: any): void {
    this.vegaViews[chartId] = view;
  }

  getView(chartId: string): any {
    return this.vegaViews[chartId];
  }

  getState(): InteractionState {
    return {
      crossFilters: this.getCrossFilters(),
      drillStack: this.getDrillStack(),
    };
  }

  getCrossFilters(): Record<string, Record<string, unknown[]>> {
    return JSON.parse(JSON.stringify(this.crossFilterState));
  }

  getDrillStack(): DrillFrame[] {
    return JSON.parse(JSON.stringify(this.drillStack));
  }

  setupChartInteractions(
    chartId: string,
    view: any,
    interaction: InteractionConfig,
    _data: unknown[],
  ): void {
    view.addEventListener('click', (_event: unknown, item: any) => {
      if (!item || !item.datum) return;
      const datum = item.datum;

      if (interaction.drillDown) {
        this.handleDrillDown(chartId, interaction.drillDown, datum);
      }
      if (interaction.linkTo) {
        this.handleLinkTo(interaction.linkTo, datum);
      }
      if (interaction.onClick) {
        this.handleOnClick(interaction.onClick, datum, chartId);
      }
    });

    if (interaction.filterBy) {
      this.setupFilterByInteraction(chartId, view, interaction.filterBy);
    }
  }

  async drillUp(): Promise<void> {
    if (this.drillStack.length === 0) return;
    this.drillStack.pop();
    this.emitStateChange();

    const modal = document.getElementById('dql-drill-modal');
    const bodyEl = document.getElementById('dql-drill-body');
    if (!modal || !bodyEl) return;

    if (this.drillStack.length === 0) {
      modal.classList.remove('active');
      return;
    }

    const top = this.drillStack[this.drillStack.length - 1];
    bodyEl.innerHTML = '<div class="dql-loading">Loading details...</div>';
    const result = await this.fetchDrillDown(top);
    if (result.error) {
      bodyEl.innerHTML = `<div class="dql-error">${escapeHTML(result.error)}</div>`;
      return;
    }
    if (!result.rows || result.rows.length === 0) {
      bodyEl.innerHTML = '<div class="dql-loading">No data found</div>';
      return;
    }

    bodyEl.innerHTML = this.renderDrillTable(result.columns, result.rows);
  }

  private async handleDrillDown(
    chartId: string,
    drillDownSQL: string,
    datum: Record<string, unknown>,
  ): Promise<void> {
    const clean = cleanDatum(datum);
    const frame: DrillFrame = {
      chartId,
      label: String(getClickedLabel(clean) || chartId),
      templateSQL: drillDownSQL,
      datum: clean,
      predicates: this.buildPredicates(clean),
      connectionId: this.resolveChartConnection(chartId),
    };
    this.drillStack.push(frame);
    this.emitStateChange();

    const modal = document.getElementById('dql-drill-modal');
    const titleEl = document.getElementById('dql-drill-title');
    const stackEl = document.getElementById('dql-drill-stack');
    const bodyEl = document.getElementById('dql-drill-body');
    if (!modal || !bodyEl) return;

    if (titleEl) titleEl.textContent = 'Detail View - ' + frame.label;
    if (stackEl) {
      stackEl.textContent = this.drillStack.map((entry) => entry.label).join(' > ');
    }
    bodyEl.innerHTML = '<div class="dql-loading">Loading details...</div>';
    modal.classList.add('active');

    const result = await this.fetchDrillDown(frame);
    if (result.error) {
      bodyEl.innerHTML = `<div class="dql-error">${escapeHTML(result.error)}</div>`;
      return;
    }
    if (!result.rows || result.rows.length === 0) {
      bodyEl.innerHTML = '<div class="dql-loading">No data found</div>';
      return;
    }

    bodyEl.innerHTML = this.renderDrillTable(result.columns, result.rows);
  }

  private async fetchDrillDown(frame: DrillFrame): Promise<any> {
    try {
      const apiEndpoint = (globalThis as any).DQL_CONFIG?.apiEndpoint ?? '/api/query';
      const response = await globalThis.fetch(apiEndpoint.replace('/query', '/drill'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chartId: frame.chartId,
          templateSQL: frame.templateSQL,
          datum: frame.datum,
          connectionId: frame.connectionId,
        }),
      });

      if (!response.ok) throw new Error('Drill-down query failed: ' + response.statusText);
      return response.json();
    } catch (error: any) {
      return { columns: [], rows: [], error: error.message };
    }
  }

  private renderDrillTable(
    columns: Array<{ name: string }> | undefined,
    rows: Record<string, unknown>[],
  ): string {
    const colNames = columns ? columns.map((c) => c.name) : Object.keys(rows[0] || {});

    let html = '<table class="dql-drill-table"><thead><tr>';
    for (const col of colNames) {
      html += `<th>${escapeHTML(col)}</th>`;
    }
    html += '</tr></thead><tbody>';

    const maxRows = Math.min(rows.length, 100);
    for (let r = 0; r < maxRows; r++) {
      html += '<tr>';
      for (const col of colNames) {
        const val = rows[r][col];
        html += `<td>${escapeHTML(val === null || val === undefined ? '' : String(val))}</td>`;
      }
      html += '</tr>';
    }

    html += '</tbody></table>';
    if (rows.length > 100) {
      html += `<p style="margin-top:12px;color:#888;">Showing first 100 of ${rows.length} rows</p>`;
    }
    return html;
  }

  private handleLinkTo(linkTo: string, datum: Record<string, unknown>): void {
    let url = linkTo.replace(/\{(\w+)\}/g, (_m, key) => {
      const val = datum[key];
      return val === null || val === undefined ? '' : String(val);
    });

    const config = (globalThis as any).DQL_CONFIG;
    const sep = url.indexOf('?') >= 0 ? '&' : '?';
    url += sep + '_from=' + encodeURIComponent(location.pathname) +
      '&_fromTitle=' + encodeURIComponent(config?.title ?? '');

    window.location.href = url;
  }

  private handleOnClick(action: string, datum: Record<string, unknown>, chartId: string): void {
    const event = new CustomEvent('dql:click', {
      detail: { chartId, action, datum },
      bubbles: true,
    });
    document.dispatchEvent(event);

    const config = (globalThis as any).DQL_CONFIG;
    if (action === 'drill_down') {
      const interaction = config?.interactions?.[chartId];
      if (interaction?.drillDown) {
        this.handleDrillDown(chartId, interaction.drillDown, datum);
      }
    } else if (action === 'navigate' || action === 'link') {
      const interaction = config?.interactions?.[chartId];
      if (interaction?.linkTo) {
        this.handleLinkTo(interaction.linkTo, datum);
      }
    } else if (action.startsWith('set_param:') || action.startsWith('set_params:')) {
      document.dispatchEvent(new CustomEvent('dql:param-action', {
        detail: { chartId, action, datum },
        bubbles: true,
      }));
    }
  }

  private setupFilterByInteraction(chartId: string, view: any, filterBy: string | string[]): void {
    const fields = Array.isArray(filterBy) ? filterBy : [filterBy];

    view.addSignalListener('dql_filter', (_name: string, value: any) => {
      const selectedValues: Record<string, unknown[]> = {};
      if (value && value.vlPoint && value.vlPoint.or) {
        for (const point of value.vlPoint.or) {
          for (const field of fields) {
            if (point[field] !== undefined && point[field] !== null && point[field] !== '') {
              if (!selectedValues[field]) selectedValues[field] = [];
              if (!selectedValues[field].includes(point[field])) {
                selectedValues[field].push(point[field]);
              }
            }
          }
        }
      }

      this.applyCrossChartFilter(chartId, selectedValues);
    });
  }

  private applyCrossChartFilter(sourceChartId: string, selectedValues: Record<string, unknown[]>): void {
    if (Object.keys(selectedValues).length === 0) {
      delete this.crossFilterState[sourceChartId];
    } else {
      this.crossFilterState[sourceChartId] = selectedValues;
    }

    this.emitStateChange();
    document.dispatchEvent(new CustomEvent('dql:cross-filter', {
      detail: {
        sourceChartId,
        selectedValues,
        state: this.getCrossFilters(),
      },
      bubbles: true,
    }));
  }

  private buildPredicates(datum: Record<string, unknown>): Record<string, unknown[]> {
    const predicates: Record<string, unknown[]> = {};
    for (const [key, value] of Object.entries(datum)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      if (value === null || value === undefined || value === '') continue;
      predicates[key] = [value];
    }
    return predicates;
  }

  private resolveChartConnection(chartId: string): string | undefined {
    const config = (globalThis as any).DQL_CONFIG;
    const charts = Array.isArray(config?.charts) ? config.charts : [];
    const chart = charts.find((entry: { id: string; connection?: string }) => entry.id === chartId);
    return chart?.connection;
  }

  private emitStateChange(): void {
    if (this.onStateChange) {
      this.onStateChange(this.getState());
    }
  }
}
