import {
  NodeKind,
  parse,
  type BlockDeclNode,
  type ExpressionNode,
  type NamedArgNode,
  type SemanticLayer,
} from '@duckcodeailabs/dql-core';
import type { SQLParamSpec } from '@duckcodeailabs/dql-connectors';
import type { NotebookCell, NotebookChartConfig } from './document.js';
import { resolveSemanticRefs, hasSemanticRefs } from './semantic-refs.js';

export interface NotebookExecutionPlan {
  title: string;
  sql: string;
  sqlParams: SQLParamSpec[];
  variables: Record<string, unknown>;
  chartConfig?: NotebookChartConfig;
  tests: Array<{ field: string; operator: string; expected: unknown }>;
}

export interface BuildExecutionPlanOptions {
  semanticLayer?: SemanticLayer;
  /** Driver name for SQL dialect selection (e.g. 'snowflake', 'bigquery'). */
  driver?: string;
}

export function buildExecutionPlan(
  cell: NotebookCell,
  options?: BuildExecutionPlanOptions,
): NotebookExecutionPlan | null {
  if (cell.type === 'markdown' || cell.type === 'chart') {
    return null;
  }

  if (cell.type === 'sql') {
    // Resolve @metric(name) and @dim(name) references in SQL cells
    let resolvedSql = cell.source;
    if (options?.semanticLayer && hasSemanticRefs(cell.source)) {
      const resolution = resolveSemanticRefs(cell.source, options.semanticLayer);
      if (resolution.unresolvedRefs.length > 0) {
        throw new Error(
          `Unresolved semantic references in SQL cell: ${resolution.unresolvedRefs.join(', ')}. ` +
          'Check that these metrics/dimensions exist in your semantic layer.',
        );
      }
      resolvedSql = resolution.resolvedSql;
    }
    return {
      title: cell.title || 'SQL cell',
      sql: resolvedSql,
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

  // Semantic blocks: compose SQL from the semantic layer
  if (block.blockType === 'semantic') {
    return buildSemanticPlan(block, options?.semanticLayer, options?.driver);
  }

  if (block.blockType !== 'custom') {
    throw new Error(`Unsupported block type "${block.blockType}". Only "custom" and "semantic" blocks can run in the notebook.`);
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

function buildSemanticPlan(
  block: BlockDeclNode,
  semanticLayer?: SemanticLayer,
  driver?: string,
): NotebookExecutionPlan {
  if (!semanticLayer) {
    throw new Error(
      'Semantic block requires a semantic-layer/ configuration. ' +
      'Add metric and dimension YAML files to your project\'s semantic-layer/ directory.',
    );
  }

  // Extract metric references: metricsRef (array) takes precedence over metricRef (single)
  const metrics: string[] = [];
  const dimensions: string[] = [];

  if (block.metricsRef && block.metricsRef.length > 0) {
    metrics.push(...block.metricsRef);
  } else if (block.metricRef) {
    metrics.push(block.metricRef);
  }

  // Also extract dimensions/metrics from block params if they reference names
  for (const param of block.params?.params ?? []) {
    const val = evaluateExpression(param.initializer);
    if (param.name === 'dimensions' && Array.isArray(val)) {
      dimensions.push(...val.map(String));
    } else if (param.name === 'metrics' && Array.isArray(val)) {
      metrics.push(...val.map(String));
    }
  }

  if (metrics.length === 0) {
    throw new Error(
      `Semantic block "${block.name}" has no metric references. ` +
      'Add metric = "metric_name" or metrics = ["metric1", "metric2"] to your block declaration.',
    );
  }

  const composed = semanticLayer.composeQuery({ metrics, dimensions, driver });
  if (!composed) {
    throw new Error(
      `Could not compose SQL for semantic block "${block.name}". ` +
      `Check that metrics [${metrics.join(', ')}] exist in your semantic-layer/ definitions.`,
    );
  }

  const chartConfig = block.visualization ? lowerChartConfig(block.visualization.properties) : undefined;
  const variables = Object.fromEntries(
    (block.params?.params ?? []).map((param) => [param.name, evaluateExpression(param.initializer)]),
  );

  return {
    title: block.name,
    sql: composed.sql,
    sqlParams: [],
    variables,
    chartConfig,
    tests: (block.tests ?? []).map((test) => ({
      field: test.field,
      operator: test.operator,
      expected: evaluateExpression(test.expected),
    })),
  };
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
