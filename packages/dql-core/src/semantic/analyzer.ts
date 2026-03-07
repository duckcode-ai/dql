import type { SourceSpan } from '../errors/diagnostic.js';
import { DiagnosticReporter, DQLSemanticError } from '../errors/reporter.js';
import type { Diagnostic } from '../errors/diagnostic.js';
import {
  NodeKind,
  type ProgramNode,
  type DashboardNode,
  type ChartCallNode,
  type FilterCallNode,
  type VariableDeclNode,
  type ParamDeclNode,
  type DecoratorNode,
  type SQLQueryNode,
  type ChartType,
  type FilterType,
  type WorkbookNode,
  type PageNode,
  type DashboardBodyItem,
  type BlockDeclNode,
} from '../ast/nodes.js';

// ---- Chart Argument Schemas ----

type ArgType = 'string' | 'number' | 'boolean' | 'identifier' | 'string[]' | 'any';

interface ArgSchema {
  required: Record<string, ArgType>;
  optional: Record<string, ArgType>;
}

const COMMON_OPTIONAL: Record<string, ArgType> = {
  title: 'string',
  title_font_size: 'number',
  theme: 'string',
  color: 'string',
  show_grid: 'boolean',
  show_legend: 'boolean',
  width: 'number',
  height: 'number',
  // Interactive features
  on_click: 'string',
  drill_down: 'string',
  link_to: 'string',
  filter_by: 'any',
  drill_hierarchy: 'string',
  drill_path: 'string',
  drill_mode: 'string',
  // Chart enhancements
  y2: 'identifier',
  tooltip: 'any',
  format_x: 'string',
  format_y: 'string',
  color_rule: 'string',
  connection: 'string',
  // Table enhancements
  pin_columns: 'string[]',
  row_color: 'string',
};

const CHART_ARG_SCHEMAS: Record<ChartType, ArgSchema> = {
  line: {
    required: { x: 'identifier', y: 'identifier' },
    optional: {
      ...COMMON_OPTIONAL,
      line_width: 'number',
      fill_opacity: 'number',
      x_axis_label: 'string',
      y_axis_label: 'string',
      stroke_dash: 'string',
    },
  },
  bar: {
    required: { x: 'identifier', y: 'identifier' },
    optional: {
      ...COMMON_OPTIONAL,
      orientation: 'string',
      bar_width: 'number',
      x_axis_label: 'string',
      y_axis_label: 'string',
    },
  },
  scatter: {
    required: { x: 'identifier', y: 'identifier' },
    optional: {
      ...COMMON_OPTIONAL,
      size: 'identifier',
      x_axis_label: 'string',
      y_axis_label: 'string',
    },
  },
  area: {
    required: { x: 'identifier', y: 'identifier' },
    optional: {
      ...COMMON_OPTIONAL,
      fill_opacity: 'number',
      x_axis_label: 'string',
      y_axis_label: 'string',
    },
  },
  pie: {
    required: { x: 'identifier', y: 'identifier' },
    optional: {
      ...COMMON_OPTIONAL,
      inner_radius: 'number',
    },
  },
  heatmap: {
    required: { x: 'identifier', y: 'identifier' },
    optional: {
      ...COMMON_OPTIONAL,
      color_field: 'identifier',
      x_axis_label: 'string',
      y_axis_label: 'string',
    },
  },
  kpi: {
    required: {},
    optional: {
      ...COMMON_OPTIONAL,
      metrics: 'string[]',
      compare_to_previous: 'boolean',
      formatting: 'string',
    },
  },
  table: {
    required: {},
    optional: {
      ...COMMON_OPTIONAL,
      columns: 'string[]',
      sortable: 'boolean',
      page_size: 'number',
    },
  },
  metric: {
    required: {},
    optional: {
      ...COMMON_OPTIONAL,
      format: 'string',
      compare_to_previous: 'boolean',
    },
  },
  stacked_bar: {
    required: { x: 'identifier', y: 'identifier' },
    optional: {
      ...COMMON_OPTIONAL,
      orientation: 'string',
      x_axis_label: 'string',
      y_axis_label: 'string',
    },
  },
  grouped_bar: {
    required: { x: 'identifier', y: 'identifier' },
    optional: {
      ...COMMON_OPTIONAL,
      orientation: 'string',
      x_axis_label: 'string',
      y_axis_label: 'string',
    },
  },
  combo: {
    required: { x: 'identifier', y: 'identifier' },
    optional: {
      ...COMMON_OPTIONAL,
      color_field: 'identifier',
      line_width: 'number',
      x_axis_label: 'string',
      y_axis_label: 'string',
    },
  },
  histogram: {
    required: { x: 'identifier' },
    optional: {
      ...COMMON_OPTIONAL,
      y: 'identifier',
      x_axis_label: 'string',
      y_axis_label: 'string',
    },
  },
  funnel: {
    required: { x: 'identifier', y: 'identifier' },
    optional: {
      ...COMMON_OPTIONAL,
      x_axis_label: 'string',
      y_axis_label: 'string',
    },
  },
  treemap: {
    required: { x: 'identifier', y: 'identifier' },
    optional: {
      ...COMMON_OPTIONAL,
      color_field: 'identifier',
    },
  },
  sankey: {
    required: { x: 'identifier', y: 'identifier' },
    optional: {
      ...COMMON_OPTIONAL,
      color_field: 'identifier',
    },
  },
  sparkline: {
    required: { x: 'identifier', y: 'identifier' },
    optional: {
      ...COMMON_OPTIONAL,
      line_width: 'number',
    },
  },
  small_multiples: {
    required: { x: 'identifier', y: 'identifier', facet: 'identifier' },
    optional: {
      ...COMMON_OPTIONAL,
      color_field: 'identifier',
      line_width: 'number',
      x_axis_label: 'string',
      y_axis_label: 'string',
    },
  },
  gauge: {
    required: { y: 'identifier' },
    optional: {
      ...COMMON_OPTIONAL,
    },
  },
  waterfall: {
    required: { x: 'identifier', y: 'identifier' },
    optional: {
      ...COMMON_OPTIONAL,
      x_axis_label: 'string',
      y_axis_label: 'string',
    },
  },
  boxplot: {
    required: { x: 'identifier', y: 'identifier' },
    optional: {
      ...COMMON_OPTIONAL,
      x_axis_label: 'string',
      y_axis_label: 'string',
    },
  },
  geo: {
    required: { x: 'identifier', y: 'identifier' },
    optional: {
      ...COMMON_OPTIONAL,
      color_field: 'identifier',
    },
  },
};

// ---- Filter Argument Schemas ----

const FILTER_ARG_SCHEMAS: Record<FilterType, ArgSchema> = {
  dropdown: {
    required: { label: 'string', param: 'string' },
    optional: { default_value: 'string', placeholder: 'string', width: 'number' },
  },
  date_range: {
    required: { label: 'string', param: 'string' },
    optional: { default_value: 'string', format: 'string', width: 'number' },
  },
  text: {
    required: { label: 'string', param: 'string' },
    optional: { placeholder: 'string', debounce: 'number', width: 'number' },
  },
  multi_select: {
    required: { label: 'string', param: 'string' },
    optional: { default_value: 'string[]', placeholder: 'string', width: 'number' },
  },
  range: {
    required: { label: 'string', param: 'string' },
    optional: { min: 'number', max: 'number', step: 'number', width: 'number' },
  },
};

const SAFE_RLS_COLUMN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const RLS_TEMPLATE_VARIABLE = /^\{[A-Za-z_][A-Za-z0-9_.]*\}$/;

// ---- Scope ----

interface Scope {
  variables: Map<string, VariableDeclNode>;
}

// ---- Analyzer ----

export class SemanticAnalyzer {
  private reporter: DiagnosticReporter;
  private scopes: Scope[] = [];

  constructor() {
    this.reporter = new DiagnosticReporter();
  }

  analyze(program: ProgramNode): Diagnostic[] {
    this.reporter.clear();
    this.scopes = [];

    for (const stmt of program.statements) {
      switch (stmt.kind) {
        case NodeKind.Dashboard:
          this.analyzeDashboard(stmt);
          break;
        case NodeKind.ChartCall:
          this.analyzeChartCall(stmt);
          break;
        case NodeKind.Workbook:
          this.analyzeWorkbook(stmt);
          break;
        case NodeKind.ImportDecl:
          // Import validation is handled at compile time
          break;
        case NodeKind.BlockDecl:
          this.analyzeBlockDecl(stmt);
          break;
      }
    }

    return this.reporter.getAll();
  }

  validate(program: ProgramNode): void {
    const diagnostics = this.analyze(program);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    if (errors.length > 0) {
      throw new DQLSemanticError(
        `Semantic errors found: ${errors.map((e) => e.message).join('; ')}`,
        errors,
      );
    }
  }

  private analyzeWorkbook(node: WorkbookNode): void {
    this.validateDecorators(node.decorators, 'dashboard');

    if (node.pages.length === 0) {
      this.reporter.warning('Workbook has no pages.', node.span);
    }

    for (const page of node.pages) {
      this.analyzePage(page);
    }
  }

  private analyzePage(node: PageNode): void {
    this.pushScope();
    this.analyzeBodyItems(node.body, node.span);
    this.popScope();
  }

  private analyzeBlockDecl(node: BlockDeclNode): void {
    this.validateDecorators(node.decorators, 'dashboard');

    if (!node.name || node.name.trim().length === 0) {
      this.reporter.error('Block must have a non-empty name.', node.span);
    }

    if (!node.domain) {
      this.reporter.warning('Block is missing a domain declaration.', node.span);
    }

    if (!node.blockType) {
      this.reporter.warning('Block is missing a type declaration.', node.span);
    }

    if (!node.query) {
      this.reporter.warning('Block has no query.', node.span);
    }

    // Validate SQL interpolations in block query
    if (node.query) {
      // Register block params as variables so SQL interpolations resolve
      this.pushScope();
      if (node.params) {
        for (const p of node.params.params) {
          this.currentScope().variables.set(p.name, {
            kind: NodeKind.VariableDecl,
            name: p.name,
            initializer: p.initializer,
            span: p.span,
          } as VariableDeclNode);
        }
      }
      this.validateSQLInterpolations(node.query);
      this.popScope();
    }
  }

  private analyzeDashboard(node: DashboardNode): void {
    this.validateDecorators(node.decorators, 'dashboard');
    this.pushScope();
    this.analyzeBodyItems(node.body, node.span);
    this.popScope();
  }

  private analyzeBodyItems(body: DashboardBodyItem[], parentSpan: SourceSpan): void {
    if (body.length === 0) {
      this.reporter.warning('Dashboard/page has no charts.', parentSpan);
    }

    for (const item of body) {
      switch (item.kind) {
        case NodeKind.VariableDecl:
          this.analyzeVariableDecl(item);
          break;
        case NodeKind.ParamDecl:
          this.analyzeParamDecl(item);
          break;
        case NodeKind.ChartCall:
          this.analyzeChartCall(item);
          break;
        case NodeKind.FilterCall:
          this.analyzeFilterCall(item);
          break;
        case NodeKind.UseDecl:
          // Use declarations are resolved at compile time
          break;
        case NodeKind.LayoutBlock:
          for (const row of item.rows) {
            for (const rowItem of row.items) {
              if (rowItem.node.kind === NodeKind.ChartCall) {
                this.analyzeChartCall(rowItem.node);
              } else if (rowItem.node.kind === NodeKind.FilterCall) {
                this.analyzeFilterCall(rowItem.node);
              }
            }
          }
          break;
      }
    }
  }

  private analyzeParamDecl(node: ParamDeclNode): void {
    const scope = this.currentScope();
    if (scope.variables.has(node.name)) {
      this.reporter.error(
        `Parameter '${node.name}' conflicts with an existing variable in this scope.`,
        node.span,
      );
    }
    // Register param as a variable so SQL interpolations can reference it
    scope.variables.set(node.name, {
      kind: NodeKind.VariableDecl,
      name: node.name,
      initializer: node.defaultValue ?? { kind: NodeKind.StringLiteral, value: '', span: node.span },
      span: node.span,
    } as VariableDeclNode);
  }

  private analyzeChartCall(node: ChartCallNode): void {
    this.validateDecorators(node.decorators, 'chart');
    this.validateChartArgs(node);
    this.validateSQLInterpolations(node.query);
  }

  private analyzeFilterCall(node: FilterCallNode): void {
    const schema = FILTER_ARG_SCHEMAS[node.filterType];
    if (!schema) return;

    const provided = new Set(node.args.map((a) => a.name));

    // Check required args
    for (const [name] of Object.entries(schema.required)) {
      if (!provided.has(name)) {
        this.reporter.error(
          `filter.${node.filterType} requires argument '${name}'.`,
          node.span,
          `Add ${name} = "..." to the filter call.`,
        );
      }
    }

    // Check for unknown args
    for (const arg of node.args) {
      if (!(arg.name in schema.required) && !(arg.name in schema.optional)) {
        this.reporter.warning(
          `Unknown argument '${arg.name}' for filter.${node.filterType}.`,
          arg.span,
          `Valid arguments: ${[...Object.keys(schema.required), ...Object.keys(schema.optional)].join(', ')}`,
        );
      }
    }

    // Validate SQL interpolations in filter query if present
    if (node.query) {
      this.validateSQLInterpolations(node.query);
    }

    // Register filter param as an implicitly-defined variable so dashboards can
    // reference it in SQL templates via {param_name} without a separate `param` declaration.
    const paramArg = node.args.find((a) => a.name === 'param');
    if (paramArg && paramArg.value.kind === NodeKind.StringLiteral) {
      const scope = this.currentScope();
      const paramName = paramArg.value.value;
      if (!scope.variables.has(paramName)) {
        const defaultArg = node.args.find((a) => a.name === 'default_value');
        const initializer = defaultArg?.value ?? { kind: NodeKind.StringLiteral, value: '', span: node.span };
        scope.variables.set(paramName, {
          kind: NodeKind.VariableDecl,
          name: paramName,
          initializer,
          span: node.span,
        } as VariableDeclNode);
      }
    }
  }

  private analyzeVariableDecl(node: VariableDeclNode): void {
    const scope = this.currentScope();
    if (scope.variables.has(node.name)) {
      this.reporter.error(
        `Variable '${node.name}' is already declared in this scope.`,
        node.span,
      );
    }
    scope.variables.set(node.name, node);
  }

  private validateChartArgs(node: ChartCallNode): void {
    const schema = CHART_ARG_SCHEMAS[node.chartType];
    if (!schema) return;

    const provided = new Set(node.args.map((a) => a.name));

    // Check required args
    for (const [name] of Object.entries(schema.required)) {
      if (!provided.has(name)) {
        this.reporter.error(
          `chart.${node.chartType} requires argument '${name}'.`,
          node.span,
          `Add ${name} = <column_name> to the chart call.`,
        );
      }
    }

    // Check for unknown args
    for (const arg of node.args) {
      if (!(arg.name in schema.required) && !(arg.name in schema.optional)) {
        this.reporter.warning(
          `Unknown argument '${arg.name}' for chart.${node.chartType}.`,
          arg.span,
          `Valid arguments: ${[...Object.keys(schema.required), ...Object.keys(schema.optional)].join(', ')}`,
        );
      }
    }

    const drillHierarchyArg = node.args.find((a) => a.name === 'drill_hierarchy');
    const drillPathArg = node.args.find((a) => a.name === 'drill_path');
    const drillModeArg = node.args.find((a) => a.name === 'drill_mode');

    if ((drillPathArg || drillModeArg) && !drillHierarchyArg) {
      this.reporter.warning(
        'drill_path/drill_mode provided without drill_hierarchy. Hierarchy-driven drill may not activate.',
        (drillPathArg ?? drillModeArg ?? node).span,
      );
    }

    if (drillModeArg && drillModeArg.value.kind === NodeKind.StringLiteral) {
      const drillMode = drillModeArg.value.value;
      const allowedModes = new Set(['modal', 'replace', 'expand']);
      if (!allowedModes.has(drillMode)) {
        this.reporter.error(
          `Invalid drill_mode '${drillMode}'. Allowed values: modal, replace, expand.`,
          drillModeArg.span,
        );
      }
    }
  }

  private validateSQLInterpolations(node: SQLQueryNode): void {
    for (const interp of node.interpolations) {
      if (!this.resolveVariable(interp.variableName)) {
        this.reporter.error(
          `Undefined variable '${interp.variableName}' in SQL template.`,
          interp.span,
          `Declare it with: let ${interp.variableName} = ...`,
        );
      }
    }
  }

  private validateDecorators(decorators: DecoratorNode[], context: 'dashboard' | 'chart'): void {
    for (const dec of decorators) {
      switch (dec.name) {
        case 'schedule':
          if (dec.arguments.length === 0) {
            this.reporter.error(
              '@schedule requires at least one argument (e.g., daily, "9:00 AM").',
              dec.span,
            );
          }
          break;
        case 'email_to':
          if (dec.arguments.length === 0) {
            this.reporter.error(
              '@email_to requires at least one email address.',
              dec.span,
            );
          }
          break;
        case 'cache':
        case 'slack_channel':
        case 'refresh':
          // Valid decorators with future implementation
          break;
        case 'if':
          if (context !== 'chart') {
            this.reporter.error(
              '@if can only be applied to chart declarations.',
              dec.span,
            );
          }
          if (dec.arguments.length === 0) {
            this.reporter.error(
              '@if requires a parameter name as argument (e.g., @if(show_details)).',
              dec.span,
            );
          }
          break;
        case 'rls':
          if (context !== 'chart') {
            this.reporter.error(
              '@rls can only be applied to chart declarations.',
              dec.span,
            );
          }
          if (dec.arguments.length < 2) {
            this.reporter.error(
              '@rls requires two arguments: column name and value (e.g., @rls("org_id", "{user.org}")).',
              dec.span,
            );
          }
          if (dec.arguments.length >= 1) {
            const columnArg = dec.arguments[0];
            const columnName =
              columnArg.kind === NodeKind.StringLiteral
                ? columnArg.value
                : (columnArg.kind === NodeKind.Identifier ? columnArg.name : '');
            if (!columnName || !SAFE_RLS_COLUMN.test(columnName.trim())) {
              this.reporter.error(
                '@rls first argument must be a safe SQL column identifier (letters/numbers/underscores, optional dot paths).',
                dec.span,
              );
            }
          }
          if (dec.arguments.length >= 2 && dec.arguments[1].kind === NodeKind.StringLiteral) {
            const raw = dec.arguments[1].value.trim();
            if (raw.startsWith('{') && raw.endsWith('}') && !RLS_TEMPLATE_VARIABLE.test(raw)) {
              this.reporter.error(
                '@rls template values must use {variable_name} or {scope.name} format.',
                dec.span,
              );
            }
          }
          break;
        case 'annotate':
          if (context !== 'chart') {
            this.reporter.error(
              '@annotate can only be applied to chart declarations.',
              dec.span,
            );
          }
          if (dec.arguments.length < 2) {
            this.reporter.error(
              '@annotate requires at least 2 arguments: x value and label (e.g., @annotate("2024-06-01", "Launch")).',
              dec.span,
            );
          }
          break;
        case 'materialize':
          if (context !== 'chart') {
            this.reporter.error(
              '@materialize can only be applied to chart declarations.',
              dec.span,
            );
          }
          break;
        case 'alert':
          break;
        default:
          this.reporter.warning(
            `Unknown decorator '@${dec.name}'.`,
            dec.span,
            `Valid decorators: @schedule, @email_to, @cache, @slack_channel, @refresh, @if, @rls, @annotate, @materialize, @alert`,
          );
      }
    }
  }

  private resolveVariable(name: string): VariableDeclNode | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const found = this.scopes[i].variables.get(name);
      if (found) return found;
    }
    return undefined;
  }

  private pushScope(): void {
    this.scopes.push({ variables: new Map() });
  }

  private popScope(): void {
    this.scopes.pop();
  }

  private currentScope(): Scope {
    if (this.scopes.length === 0) {
      this.pushScope();
    }
    return this.scopes[this.scopes.length - 1];
  }
}

export function analyze(program: ProgramNode): Diagnostic[] {
  const analyzer = new SemanticAnalyzer();
  return analyzer.analyze(program);
}
