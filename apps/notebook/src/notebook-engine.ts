import { parse, NodeKind } from '@duckcodeailabs/dql-core';
import type {
  BlockDeclNode,
  ChartCallNode,
  NamedArgNode,
  ExpressionNode,
  StringLiteralNode,
  NumberLiteralNode,
  IdentifierNode,
  ChartType,
} from '@duckcodeailabs/dql-core';

export interface VizConfig {
  chart: ChartType | string;
  x?: string;
  y?: string | string[];
  color?: string;
  label?: string;
  value?: string;
  format?: string;
  title?: string;
}

export interface NotebookBlock {
  id: string;
  name: string;
  sql: string;
  viz: VizConfig | null;
  params: Record<string, string | number | boolean>;
}

export interface ParseResult {
  blocks: NotebookBlock[];
  errors: string[];
}

function exprValue(expr: ExpressionNode): string | number | boolean {
  switch (expr.kind) {
    case NodeKind.StringLiteral: return (expr as StringLiteralNode).value;
    case NodeKind.NumberLiteral: return (expr as NumberLiteralNode).value;
    case NodeKind.Identifier:    return (expr as IdentifierNode).name;
    default: return '';
  }
}

function namedArgsToViz(args: NamedArgNode[]): VizConfig {
  const props: Record<string, string | number | boolean> = {};
  for (const arg of args) {
    props[arg.name] = exprValue(arg.value);
  }
  const chart = (props['chart'] ?? props['type'] ?? 'table') as string;
  const y = props['y'];
  return {
    chart,
    x: props['x'] as string | undefined,
    y: typeof y === 'string' ? y : undefined,
    color: props['color'] as string | undefined,
    label: props['label'] as string | undefined,
    value: props['value'] as string | undefined,
    format: props['format'] as string | undefined,
    title: props['title'] as string | undefined,
  };
}

export function parseDQL(source: string): ParseResult {
  const errors: string[] = [];
  let ast: ReturnType<typeof parse>;

  try {
    ast = parse(source);
  } catch (e) {
    return { blocks: [], errors: [e instanceof Error ? e.message : 'Parse error'] };
  }

  const blocks: NotebookBlock[] = [];
  let idx = 0;

  for (const stmt of ast.statements) {
    // --- block "Name" { ... } ---
    if (stmt.kind === NodeKind.BlockDecl) {
      const b = stmt as BlockDeclNode;
      if (!b.query?.rawSQL) continue;

      const params: Record<string, string | number | boolean> = {};
      if (b.params) {
        for (const p of b.params.params) {
          params[p.name] = exprValue(p.initializer);
        }
      }

      const viz = b.visualization
        ? namedArgsToViz(b.visualization.properties)
        : null;

      blocks.push({
        id: `block-${idx++}`,
        name: b.name,
        sql: b.query.rawSQL.trim(),
        viz,
        params,
      });
    }

    // --- chart.bar(SELECT ..., x = col, y = col) ---
    if (stmt.kind === NodeKind.ChartCall) {
      const c = stmt as ChartCallNode;
      const viz = namedArgsToViz(c.args);
      viz.chart = c.chartType;
      blocks.push({
        id: `chart-${idx++}`,
        name: viz.title ?? `Chart ${idx}`,
        sql: c.query.rawSQL.trim(),
        viz,
        params: {},
      });
    }
  }

  return { blocks, errors };
}
