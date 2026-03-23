import type { SourceSpan } from '../errors/diagnostic.js';

// ---- Node Kinds ----

export enum NodeKind {
  Program = 'Program',
  Workbook = 'Workbook',
  Page = 'Page',
  Dashboard = 'Dashboard',
  ChartCall = 'ChartCall',
  FilterCall = 'FilterCall',
  VariableDecl = 'VariableDecl',
  ParamDecl = 'ParamDecl',
  ImportDecl = 'ImportDecl',
  UseDecl = 'UseDecl',
  LayoutBlock = 'LayoutBlock',
  LayoutRow = 'LayoutRow',
  Decorator = 'Decorator',
  SQLQuery = 'SQLQuery',
  NamedArg = 'NamedArg',
  StringLiteral = 'StringLiteral',
  NumberLiteral = 'NumberLiteral',
  BooleanLiteral = 'BooleanLiteral',
  ArrayLiteral = 'ArrayLiteral',
  Identifier = 'Identifier',
  BinaryExpr = 'BinaryExpr',
  IntervalExpr = 'IntervalExpr',
  FunctionCall = 'FunctionCall',
  TemplateString = 'TemplateString',
  BlockDecl = 'BlockDecl',
  BlockParams = 'BlockParams',
  BlockVisualization = 'BlockVisualization',
  BlockTest = 'BlockTest',
}

// ---- Base ----

export interface BaseNode {
  kind: NodeKind;
  span: SourceSpan;
}

// ---- Chart Types ----

export type ChartType =
  | 'line'
  | 'bar'
  | 'kpi'
  | 'pie'
  | 'scatter'
  | 'area'
  | 'heatmap'
  | 'table'
  | 'metric'
  | 'stacked_bar'
  | 'grouped_bar'
  | 'combo'
  | 'histogram'
  | 'funnel'
  | 'treemap'
  | 'sankey'
  | 'sparkline'
  | 'small_multiples'
  | 'gauge'
  | 'waterfall'
  | 'boxplot'
  | 'geo';

// ---- Top-level ----

export interface ProgramNode extends BaseNode {
  kind: NodeKind.Program;
  statements: StatementNode[];
}

export type StatementNode = DashboardNode | ChartCallNode | WorkbookNode | ImportDeclNode | BlockDeclNode;

// ---- Dashboard ----

export interface DashboardNode extends BaseNode {
  kind: NodeKind.Dashboard;
  title: string;
  decorators: DecoratorNode[];
  body: DashboardBodyItem[];
}

export type DashboardBodyItem = VariableDeclNode | ParamDeclNode | ChartCallNode | FilterCallNode | UseDeclNode | LayoutBlockNode;

// ---- Chart ----

export interface ChartCallNode extends BaseNode {
  kind: NodeKind.ChartCall;
  chartType: ChartType;
  query: SQLQueryNode;
  args: NamedArgNode[];
  decorators: DecoratorNode[];
}

// ---- Filter Types ----

export type FilterType = 'dropdown' | 'date_range' | 'text' | 'multi_select' | 'range';

// ---- Filter ----

export interface FilterCallNode extends BaseNode {
  kind: NodeKind.FilterCall;
  filterType: FilterType;
  query?: SQLQueryNode;
  args: NamedArgNode[];
}

// ---- SQL ----

export interface SQLQueryNode extends BaseNode {
  kind: NodeKind.SQLQuery;
  rawSQL: string;
  interpolations: TemplateInterpolation[];
}

export interface TemplateInterpolation {
  variableName: string;
  offsetInSQL: number;
  span: SourceSpan;
}

// ---- Variables ----

export interface VariableDeclNode extends BaseNode {
  kind: NodeKind.VariableDecl;
  name: string;
  initializer: ExpressionNode;
}

// ---- Decorators ----

export interface DecoratorNode extends BaseNode {
  kind: NodeKind.Decorator;
  name: string;
  arguments: ExpressionNode[];
}

// ---- Named Arguments ----

export interface NamedArgNode extends BaseNode {
  kind: NodeKind.NamedArg;
  name: string;
  value: ExpressionNode;
}

// ---- Expressions ----

export type ExpressionNode =
  | StringLiteralNode
  | NumberLiteralNode
  | BooleanLiteralNode
  | ArrayLiteralNode
  | IdentifierNode
  | BinaryExprNode
  | IntervalExprNode
  | FunctionCallNode
  | TemplateStringNode;

export interface StringLiteralNode extends BaseNode {
  kind: NodeKind.StringLiteral;
  value: string;
}

export interface NumberLiteralNode extends BaseNode {
  kind: NodeKind.NumberLiteral;
  value: number;
}

export interface BooleanLiteralNode extends BaseNode {
  kind: NodeKind.BooleanLiteral;
  value: boolean;
}

export interface ArrayLiteralNode extends BaseNode {
  kind: NodeKind.ArrayLiteral;
  elements: ExpressionNode[];
}

export interface IdentifierNode extends BaseNode {
  kind: NodeKind.Identifier;
  name: string;
}

export interface BinaryExprNode extends BaseNode {
  kind: NodeKind.BinaryExpr;
  operator: '+' | '-';
  left: ExpressionNode;
  right: ExpressionNode;
}

export interface IntervalExprNode extends BaseNode {
  kind: NodeKind.IntervalExpr;
  value: string;
}

export interface FunctionCallNode extends BaseNode {
  kind: NodeKind.FunctionCall;
  callee: string;
  arguments: ExpressionNode[];
}

export interface TemplateStringNode extends BaseNode {
  kind: NodeKind.TemplateString;
  parts: Array<string | ExpressionNode>;
}

// ---- Workbook / Page ----

export interface WorkbookNode extends BaseNode {
  kind: NodeKind.Workbook;
  title: string;
  decorators: DecoratorNode[];
  pages: PageNode[];
}

export interface PageNode extends BaseNode {
  kind: NodeKind.Page;
  title: string;
  body: DashboardBodyItem[];
}

// ---- Param Declaration ----

export type ParamType = 'string' | 'number' | 'boolean' | 'date';

export interface ParamDeclNode extends BaseNode {
  kind: NodeKind.ParamDecl;
  name: string;
  paramType: ParamType;
  defaultValue?: ExpressionNode;
}

// ---- Import / Use ----

export interface ImportDeclNode extends BaseNode {
  kind: NodeKind.ImportDecl;
  names: string[];
  path: string;
}

export interface UseDeclNode extends BaseNode {
  kind: NodeKind.UseDecl;
  name: string;
}

// ---- Block Declaration (architecture spec) ----

export interface BlockDeclNode extends BaseNode {
  kind: NodeKind.BlockDecl;
  name: string;
  domain?: string;
  /** Execution routing type. 'semantic' routes to MetricFlow; 'custom' routes to the SQL runtime. Required. */
  blockType: 'semantic' | 'custom';
  /** For blockType 'semantic': the dbt metric name this block references. Must not have a query field. */
  metricRef?: string;
  /** For blockType 'semantic': multiple metric references. Takes precedence over metricRef when present. */
  metricsRef?: string[];
  description?: string;
  tags?: string[];
  owner?: string;
  params?: BlockParamsNode;
  /** For blockType 'custom': the SQL query. Must not be present on 'semantic' blocks. */
  query?: SQLQueryNode;
  visualization?: BlockVisualizationNode;
  tests?: BlockTestNode[];
  decorators: DecoratorNode[];
}

export interface BlockParamsNode extends BaseNode {
  kind: NodeKind.BlockParams;
  params: BlockParamEntry[];
}

export interface BlockParamEntry {
  name: string;
  initializer: ExpressionNode;
  span: SourceSpan;
}

export interface BlockVisualizationNode extends BaseNode {
  kind: NodeKind.BlockVisualization;
  properties: NamedArgNode[];
}

export interface BlockTestNode extends BaseNode {
  kind: NodeKind.BlockTest;
  field: string;
  operator: '>' | '<' | '>=' | '<=' | '==' | '!=' | 'IN';
  expected: ExpressionNode;
}

// ---- Layout ----

export interface LayoutBlockNode extends BaseNode {
  kind: NodeKind.LayoutBlock;
  columns: number;
  rows: LayoutRowNode[];
}

export interface LayoutRowNode extends BaseNode {
  kind: NodeKind.LayoutRow;
  items: LayoutRowItem[];
}

export interface LayoutRowItem {
  node: ChartCallNode | FilterCallNode;
  span?: number;
}
