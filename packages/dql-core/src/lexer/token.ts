import type { SourceSpan } from '../errors/diagnostic.js';

export enum TokenType {
  // Literals
  StringLiteral = 'StringLiteral',
  NumberLiteral = 'NumberLiteral',
  BooleanLiteral = 'BooleanLiteral',

  // Identifiers & Keywords
  Identifier = 'Identifier',
  DashboardKeyword = 'DashboardKeyword',
  WorkbookKeyword = 'WorkbookKeyword',
  PageKeyword = 'PageKeyword',
  LetKeyword = 'LetKeyword',
  ParamKeyword = 'ParamKeyword',
  ChartKeyword = 'ChartKeyword',
  FilterKeyword = 'FilterKeyword',
  IntervalKeyword = 'IntervalKeyword',
  ImportKeyword = 'ImportKeyword',
  FromKeyword = 'FromKeyword',
  UseKeyword = 'UseKeyword',
  LayoutKeyword = 'LayoutKeyword',
  RowKeyword = 'RowKeyword',
  BlockKeyword = 'BlockKeyword',
  DomainKeyword = 'DomainKeyword',
  TypeKeyword = 'TypeKeyword',
  DescriptionKeyword = 'DescriptionKeyword',
  TagsKeyword = 'TagsKeyword',
  OwnerKeyword = 'OwnerKeyword',
  QueryKeyword = 'QueryKeyword',
  VisualizationKeyword = 'VisualizationKeyword',
  TestsKeyword = 'TestsKeyword',
  ParamsKeyword = 'ParamsKeyword',
  AssertKeyword = 'AssertKeyword',
  VarKeyword = 'VarKeyword',
  DefaultKeyword = 'DefaultKeyword',
  MetricKeyword = 'MetricKeyword',
  MetricsKeyword = 'MetricsKeyword',
  ColonToken = 'ColonToken',
  TripleQuoteString = 'TripleQuoteString',
  GreaterThan = 'GreaterThan',
  LessThan = 'LessThan',
  GreaterThanOrEqual = 'GreaterThanOrEqual',
  LessThanOrEqual = 'LessThanOrEqual',
  DoubleEquals = 'DoubleEquals',
  NotEquals = 'NotEquals',
  InKeyword = 'InKeyword',

  // SQL (opaque fragment captured by parser)
  SQLFragment = 'SQLFragment',

  // Decorators
  AtSign = 'AtSign',

  // Punctuation
  LeftParen = 'LeftParen',
  RightParen = 'RightParen',
  LeftBrace = 'LeftBrace',
  RightBrace = 'RightBrace',
  LeftBracket = 'LeftBracket',
  RightBracket = 'RightBracket',
  Comma = 'Comma',
  Dot = 'Dot',
  Equals = 'Equals',
  Plus = 'Plus',
  Minus = 'Minus',
  Star = 'Star',

  // Special
  Comment = 'Comment',
  Newline = 'Newline',
  EOF = 'EOF',
}

export interface Token {
  type: TokenType;
  value: string;
  span: SourceSpan;
}

const KEYWORDS: Record<string, TokenType> = {
  dashboard: TokenType.DashboardKeyword,
  workbook: TokenType.WorkbookKeyword,
  page: TokenType.PageKeyword,
  let: TokenType.LetKeyword,
  param: TokenType.ParamKeyword,
  chart: TokenType.ChartKeyword,
  filter: TokenType.FilterKeyword,
  true: TokenType.BooleanLiteral,
  false: TokenType.BooleanLiteral,
  INTERVAL: TokenType.IntervalKeyword,
  import: TokenType.ImportKeyword,
  from: TokenType.FromKeyword,
  use: TokenType.UseKeyword,
  layout: TokenType.LayoutKeyword,
  row: TokenType.RowKeyword,
  block: TokenType.BlockKeyword,
  domain: TokenType.DomainKeyword,
  type: TokenType.TypeKeyword,
  description: TokenType.DescriptionKeyword,
  tags: TokenType.TagsKeyword,
  owner: TokenType.OwnerKeyword,
  query: TokenType.QueryKeyword,
  visualization: TokenType.VisualizationKeyword,
  tests: TokenType.TestsKeyword,
  params: TokenType.ParamsKeyword,
  assert: TokenType.AssertKeyword,
  var: TokenType.VarKeyword,
  default: TokenType.DefaultKeyword,
  IN: TokenType.InKeyword,
  metric: TokenType.MetricKeyword,
  metrics: TokenType.MetricsKeyword,
};

export function lookupKeyword(identifier: string): TokenType {
  return KEYWORDS[identifier] ?? TokenType.Identifier;
}

export const CHART_TYPES = new Set([
  'line',
  'bar',
  'kpi',
  'pie',
  'donut',
  'scatter',
  'area',
  'stacked-area',
  'stacked_area',
  'heatmap',
  'table',
  'metric',
  'stacked-bar',
  'stacked_bar',
  'grouped-bar',
  'grouped_bar',
  'combo',
  'histogram',
  'funnel',
  'treemap',
  'tree-map',
  'sankey',
  'flow',
  'sparkline',
  'spark-line',
  'spark',
  'small_multiples',
  'small-multiples',
  'small_multiple',
  'small-multiple',
  'gauge',
  'waterfall',
  'boxplot',
  'geo',
  'forecast',
]);

export const CHART_TYPE_ALIASES: Record<string, string> = {
  'grouped-bar': 'grouped_bar',
  grouped_bar: 'grouped_bar',
  'stacked-bar': 'stacked_bar',
  stacked_bar: 'stacked_bar',
  'stacked-area': 'area',
  stacked_area: 'area',
  donut: 'pie',
  forecast: 'line',
  'tree-map': 'treemap',
  flow: 'sankey',
  'spark-line': 'sparkline',
  spark: 'sparkline',
  'small-multiples': 'small_multiples',
  small_multiple: 'small_multiples',
  'small-multiple': 'small_multiples',
};

export function normalizeChartType(chartType: string): string {
  return CHART_TYPE_ALIASES[chartType] ?? chartType;
}

export const FILTER_TYPES = new Set([
  'dropdown',
  'date_range',
  'text',
  'multi_select',
  'range',
]);

export const SQL_START_KEYWORDS = new Set([
  'SELECT',
  'WITH',
]);
