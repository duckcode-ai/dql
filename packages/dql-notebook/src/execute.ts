import {
  NodeKind,
  parse,
  type BlockDeclNode,
  type ExpressionNode,
  type NamedArgNode,
} from '@duckcodeailabs/dql-core';
import type { SQLParamSpec } from '@duckcodeailabs/dql-connectors';
import type { NotebookCell, NotebookChartConfig } from './document.js';

export interface NotebookExecutionPlan {
  title: string;
  sql: string;
  sqlParams: SQLParamSpec[];
  variables: Record<string, unknown>;
  chartConfig?: NotebookChartConfig;
  tests: Array<{ field: string; operator: string; expected: unknown }>;
}

export function buildExecutionPlan(cell: NotebookCell): NotebookExecutionPlan | null {
  if (cell.type === 'markdown' || cell.type === 'chart') {
    return null;
  }

  if (cell.type === 'sql') {
    return {
      title: cell.title || 'SQL cell',
      sql: cell.source,
      sqlParams: [],
      variables: {},
      chartConfig: cell.config,
      tests: [],
    };
  }

  const program = parse(cell.source);
  const block = program.statements.find((statement) => statement.kind === NodeKind.BlockDecl) as BlockDeclNode | undefined;

  if (!block) {
    throw new Error('DQL notebook cells must contain a block declaration.');
  }
  if (block.blockType !== 'custom') {
    throw new Error('Only custom DQL blocks can run inside the notebook today.');
  }
  if (!block.query) {
    throw new Error('DQL notebook block is missing a query field.');
  }

  const processed = processSQL(block.query.rawSQL, block.query.interpolations);
  const chartConfig = block.visualization ? lowerChartConfig(block.visualization.properties) : undefined;
  const variables = Object.fromEntries(
    (block.params?.params ?? []).map((param) => [param.name, evaluateExpression(param.initializer)]),
  );

  return {
    title: block.name,
    sql: processed.sql,
    sqlParams: processed.params,
    variables,
    chartConfig,
    tests: (block.tests ?? []).map((test) => ({
      field: test.field,
      operator: test.operator,
      expected: evaluateExpression(test.expected),
    })),
  };
}

function lowerChartConfig(properties: NamedArgNode[]): NotebookChartConfig {
  const config: NotebookChartConfig = {};

  for (const property of properties) {
    const value = evaluateExpression(property.value);
    switch (property.name) {
      case 'chart':
        config.chart = String(value);
        break;
      case 'x':
        config.x = String(value);
        break;
      case 'y':
        config.y = String(value);
        break;
      case 'y2':
        config.y2 = String(value);
        break;
      case 'color':
        config.color = String(value);
        break;
    }
  }

  return config;
}

function processSQL(
  rawSQL: string,
  interpolations: Array<{ variableName: string; offsetInSQL: number }>,
): { sql: string; params: SQLParamSpec[] } {
  if (interpolations.length === 0) {
    return { sql: rawSQL, params: [] };
  }

  let sql = rawSQL;
  const params: SQLParamSpec[] = [];
  const sorted = [...interpolations].sort((a, b) => b.offsetInSQL - a.offsetInSQL);
  let position = interpolations.length;

  for (const interpolation of sorted) {
    const placeholder = `$${position}`;
    const from = interpolation.offsetInSQL;
    const rest = sql.slice(from);
    const pattern = new RegExp(`^\\$\\{${interpolation.variableName}\\}|^\\{${interpolation.variableName}\\}`);
    const match = rest.match(pattern);
    if (!match) {
      position -= 1;
      continue;
    }

    sql = sql.slice(0, from) + placeholder + sql.slice(from + match[0].length);
    params.unshift({ name: interpolation.variableName, position });
    position -= 1;
  }

  return { sql, params };
}

function evaluateExpression(node: ExpressionNode): unknown {
  switch (node.kind) {
    case NodeKind.StringLiteral:
      return node.value;
    case NodeKind.NumberLiteral:
      return node.value;
    case NodeKind.BooleanLiteral:
      return node.value;
    case NodeKind.Identifier:
      return node.name;
    case NodeKind.ArrayLiteral:
      return node.elements.map((element) => evaluateExpression(element));
    case NodeKind.IntervalExpr:
      return node.value;
    case NodeKind.BinaryExpr:
      return `${evaluateExpression(node.left)} ${node.operator} ${evaluateExpression(node.right)}`;
    case NodeKind.FunctionCall:
      return node.callee;
    case NodeKind.TemplateString:
      return node.parts.map((part) => (typeof part === 'string' ? part : String(evaluateExpression(part)))).join('');
  }
}
