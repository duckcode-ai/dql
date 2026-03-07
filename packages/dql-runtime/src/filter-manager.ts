import { DataFetcher } from './data-fetcher.js';
import { escapeHTML } from './utils.js';

export interface FilterConfig {
  id: string;
  type: string;
  sql: string;
  params: unknown[];
  param: string;
  label: string;
  defaultValue?: unknown;
}

export class FilterManager {
  private filterState: Record<string, unknown> = {};
  private fetcher: DataFetcher;
  private onApply: () => void;

  constructor(fetcher: DataFetcher, onApply: () => void) {
    this.fetcher = fetcher;
    this.onApply = onApply;
  }

  getState(): Record<string, unknown> {
    return { ...this.filterState };
  }

  async init(filters: FilterConfig[]): Promise<void> {
    if (!filters || filters.length === 0) return;

    for (const filter of filters) {
      if (filter.sql) {
        await this.loadFilterOptions(filter);
      }
      if (filter.defaultValue) {
        this.filterState[filter.param] = filter.defaultValue;
        this.setUIValue(filter.id, filter.defaultValue);
      }
    }

    this.setupEventHandlers(filters);
  }

  private async loadFilterOptions(filter: FilterConfig): Promise<void> {
    try {
      const result = await this.fetcher.fetch(filter.id, filter.sql, []);
      if (!result.rows || result.rows.length === 0) return;

      const selectEl = document.getElementById(filter.id);
      if (!selectEl || selectEl.tagName !== 'SELECT') return;

      const colName =
        result.columns && result.columns.length > 0
          ? result.columns[0].name
          : Object.keys(result.rows[0] || {})[0];
      if (!colName) return;

      for (const row of result.rows) {
        const val = row[colName];
        if (val === null || val === undefined) continue;
        const option = document.createElement('option');
        option.value = String(val);
        option.textContent = String(val);
        selectEl.appendChild(option);
      }
    } catch (err) {
      console.warn('[DQL] Failed to load filter options for ' + filter.id, err);
    }
  }

  private setUIValue(filterId: string, value: unknown): void {
    const el = document.getElementById(filterId) as HTMLInputElement | null;
    if (!el) return;
    el.value = String(value);
  }

  private setupEventHandlers(filters: FilterConfig[]): void {
    const applyBtn = document.getElementById('dql-filter-apply');
    const resetBtn = document.getElementById('dql-filter-reset');

    if (applyBtn) {
      applyBtn.addEventListener('click', () => {
        this.collectState(filters);
        this.onApply();
      });
    }

    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        this.resetState(filters);
        this.onApply();
      });
    }

    // Auto-apply for select/date filters
    const autoApplyEls = document.querySelectorAll('.dql-filter-select, .dql-filter-date');
    autoApplyEls.forEach((el) => {
      el.addEventListener('change', () => {
        this.collectState(filters);
        this.onApply();
      });
    });

    // Debounced auto-apply for text inputs
    const debounceTimers: Record<string, ReturnType<typeof setTimeout>> = {};
    const textInputs = document.querySelectorAll('.dql-filter-input[type="text"]');
    textInputs.forEach((el) => {
      el.addEventListener('input', () => {
        const id = (el as HTMLElement).id;
        if (debounceTimers[id]) clearTimeout(debounceTimers[id]);
        debounceTimers[id] = setTimeout(() => {
          this.collectState(filters);
          this.onApply();
        }, 300);
      });
    });
  }

  private collectState(filters: FilterConfig[]): void {
    this.filterState = {};
    for (const filter of filters) {
      const el = document.getElementById(filter.id) as HTMLInputElement | null;
      if (!el) continue;
      const value = el.value;
      if (value && value !== '') {
        this.filterState[filter.param] = value;
      }
    }
  }

  private resetState(filters: FilterConfig[]): void {
    this.filterState = {};
    for (const filter of filters) {
      const el = document.getElementById(filter.id) as HTMLInputElement | null;
      if (!el) continue;
      if (filter.defaultValue) {
        el.value = String(filter.defaultValue);
        this.filterState[filter.param] = filter.defaultValue;
      } else {
        el.value = '';
      }
    }
  }

  applyToSQL(sql: string): string {
    const urlParams = new URLSearchParams(window.location.search);
    const merged: Record<string, unknown> = { ...this.filterState };
    urlParams.forEach((value, key) => {
      if (key !== '_from' && key !== '_fromTitle' && !merged[key]) {
        merged[key] = value;
      }
    });

    let result = sql;
    for (const [paramName, paramValue] of Object.entries(merged)) {
      const placeholder = '{' + paramName + '}';
      result = result.split(placeholder).join(String(paramValue).replace(/'/g, "''"));
    }
    return result;
  }
}
