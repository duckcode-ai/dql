import { parse, analyze, formatDQL } from '@dql/core';
import type { Diagnostic as DQLDiagnostic } from '@dql/core';

export interface LSDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity: 1 | 2 | 3 | 4; // Error, Warning, Information, Hint
  message: string;
  source: string;
}

export interface CompletionItem {
  label: string;
  kind: number; // CompletionItemKind
  detail?: string;
  insertText?: string;
}

export interface HoverResult {
  contents: string;
  range?: { start: { line: number; character: number }; end: { line: number; character: number } };
}

const CHART_TYPES = [
  'line', 'bar', 'pie', 'scatter', 'area', 'heatmap', 'kpi', 'metric', 'table',
  'stacked_bar', 'grouped_bar', 'combo', 'histogram', 'funnel',
  'treemap', 'sankey', 'sparkline', 'small_multiples',
  'gauge', 'waterfall', 'boxplot', 'geo',
];

const FILTER_TYPES = ['dropdown', 'date_range', 'text', 'multi_select', 'range'];

const KEYWORDS = [
  'dashboard', 'workbook', 'page', 'layout', 'row', 'span',
  'chart', 'filter', 'param', 'import', 'from', 'use', 'let',
];

const DECORATORS = [
  'schedule', 'email_to', 'slack_channel', 'cache', 'if', 'rls', 'alert', 'materialize', 'refresh',
];

const CHART_ARGS = [
  'x', 'y', 'title', 'color', 'size', 'width', 'height',
  'x_axis_label', 'y_axis_label', 'color_field', 'orientation',
  'show_grid', 'show_legend', 'fill_opacity', 'line_width',
  'inner_radius', 'theme', 'sortable', 'page_size', 'facet',
  'y2', 'tooltip', 'format_x', 'format_y', 'color_rule',
  'connection', 'pin_columns', 'row_color', 'topology_url',
  'drill_hierarchy', 'drill_path', 'drill_mode',
  'drill_down', 'link_to', 'on_click', 'filter_by',
];

export class DQLLanguageService {
  format(source: string): string {
    return formatDQL(source);
  }

  validate(source: string, uri: string): LSDiagnostic[] {
    const diagnostics: LSDiagnostic[] = [];

    try {
      const ast = parse(source, uri);
      const dqlDiags = analyze(ast);

      for (const d of dqlDiags) {
        diagnostics.push({
          range: {
            start: { line: d.span.start.line - 1, character: d.span.start.column - 1 },
            end: { line: d.span.end.line - 1, character: d.span.end.column - 1 },
          },
          severity: d.severity === 'error' ? 1 : d.severity === 'warning' ? 2 : 3,
          message: d.message,
          source: 'dql',
        });
      }
    } catch (parseError: any) {
      // Parse errors — try to extract line info
      const msg = parseError.message ?? String(parseError);
      const lineMatch = msg.match(/line (\d+)/i);
      const line = lineMatch ? parseInt(lineMatch[1], 10) - 1 : 0;

      diagnostics.push({
        range: {
          start: { line, character: 0 },
          end: { line, character: 100 },
        },
        severity: 1,
        message: msg,
        source: 'dql',
      });
    }

    return diagnostics;
  }

  getCompletions(source: string, line: number, character: number): CompletionItem[] {
    const lines = source.split('\n');
    const currentLine = lines[line] ?? '';
    const textBefore = currentLine.substring(0, character);

    const items: CompletionItem[] = [];

    // After "chart." — suggest chart types
    if (textBefore.match(/chart\.\s*$/)) {
      for (const ct of CHART_TYPES) {
        items.push({ label: ct, kind: 3, detail: `chart.${ct}(...)`, insertText: `${ct}(` });
      }
      return items;
    }

    // After "filter." — suggest filter types
    if (textBefore.match(/filter\.\s*$/)) {
      for (const ft of FILTER_TYPES) {
        items.push({ label: ft, kind: 3, detail: `filter.${ft}(...)`, insertText: `${ft}(` });
      }
      return items;
    }

    // After "@" — suggest decorators
    if (textBefore.match(/@\s*$/)) {
      for (const dec of DECORATORS) {
        items.push({ label: dec, kind: 3, detail: `@${dec}(...)`, insertText: `${dec}(` });
      }
      return items;
    }

    // Inside chart args (after comma or opening paren) — suggest named args
    if (textBefore.match(/,\s*$/) || textBefore.match(/\(\s*$/)) {
      // Check if we're inside a chart call
      const fullText = lines.slice(0, line + 1).join('\n');
      if (fullText.match(/chart\.\w+\([^)]*$/s)) {
        for (const arg of CHART_ARGS) {
          items.push({ label: arg, kind: 5, detail: `${arg} = ...`, insertText: `${arg} = ` });
        }
        return items;
      }
    }

    // Default: suggest keywords
    for (const kw of KEYWORDS) {
      items.push({ label: kw, kind: 14, detail: `keyword` });
    }

    return items;
  }

  getHover(source: string, line: number, character: number): HoverResult | null {
    const lines = source.split('\n');
    const currentLine = lines[line] ?? '';

    // Extract word at position
    const wordMatch = currentLine.substring(0, character + 20).match(/(\w+)$/);
    if (!wordMatch) return null;

    const word = wordMatch[1];

    // Chart type hover
    if (CHART_TYPES.includes(word)) {
      const descriptions: Record<string, string> = {
        line: 'Line chart — time series and trend visualization',
        bar: 'Bar chart — categorical comparisons',
        pie: 'Pie chart — part-of-whole distribution',
        scatter: 'Scatter plot — correlation and distribution',
        area: 'Area chart — cumulative or stacked areas',
        heatmap: 'Heatmap — matrix density visualization',
        kpi: 'KPI card — single metric display',
        metric: 'Metric card — alias for KPI',
        table: 'Data table — tabular display with sorting/pagination',
        stacked_bar: 'Stacked bar — categorical bars with color stacking',
        grouped_bar: 'Grouped bar — side-by-side categorical bars',
        combo: 'Combo chart — dual-axis bar + line overlay',
        histogram: 'Histogram — frequency distribution',
        funnel: 'Funnel chart — conversion funnel visualization',
        treemap: 'Treemap — hierarchical part-to-whole rectangles',
        sankey: 'Sankey chart — weighted source-to-target flows',
        sparkline: 'Sparkline — compact trend line for dense KPI contexts',
        small_multiples: 'Small multiples — faceted mini-charts by category',
        gauge: 'Gauge chart — speedometer-style metric',
        waterfall: 'Waterfall chart — running total with positive/negative',
        boxplot: 'Box plot — statistical distribution (quartiles, outliers)',
        geo: 'Geo chart — map/topology-driven point and region overlays',
      };
      return { contents: `**chart.${word}**\n\n${descriptions[word] ?? ''}` };
    }

    // Keyword hover
    const keywordDocs: Record<string, string> = {
      dashboard: '`dashboard "Title" { ... }` — Define a single-page dashboard',
      workbook: '`workbook "Title" { page ... }` — Multi-page report container',
      page: '`page "Name" { ... }` — A page within a workbook',
      layout: '`layout(columns = 12) { row { ... } }` — Grid layout control',
      row: '`row { chart... span N }` — Horizontal row of charts',
      span: '`chart.type(...) span N` — Column span in layout grid',
      param: '`param name: type = default` — Dashboard parameter',
      import: '`import { name } from "./file.dql"` — Import components',
      use: '`use imported_name` — Use an imported component',
    };

    if (keywordDocs[word]) {
      return { contents: keywordDocs[word] };
    }

    // Decorator hover
    if (DECORATORS.includes(word)) {
      const decDocs: Record<string, string> = {
        schedule: '`@schedule("cron_expr")` — Schedule recurring execution',
        email_to: '`@email_to("addr")` — Email report delivery',
        slack_channel: '`@slack_channel("#channel")` — Slack notification',
        cache: '`@cache(ttl = 300)` — Cache query results',
        if: '`@if("param_name")` — Conditionally show chart',
        rls: '`@rls("column", "{user.org}")` — Row-level security',
        alert: '`@alert("SQL", "> 0")` — Conditional alert trigger',
        materialize: '`@materialize(refresh = "hourly")` — Materialized view cache',
        refresh: '`@refresh(interval = 30)` — Auto-refresh interval (seconds)',
      };
      return { contents: decDocs[word] ?? `@${word} decorator` };
    }

    return null;
  }
}
