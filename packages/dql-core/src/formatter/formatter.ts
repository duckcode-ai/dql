import type {
  BlockDeclNode,
  ChartCallNode,
  DashboardBodyItem,
  DashboardNode,
  DecoratorNode,
  ExpressionNode,
  FilterCallNode,
  ImportDeclNode,
  LayoutBlockNode,
  LayoutRowNode,
  NamedArgNode,
  PageNode,
  ParamDeclNode,
  ProgramNode,
  SQLQueryNode,
  StatementNode,
  UseDeclNode,
  VariableDeclNode,
  WorkbookNode,
} from '../ast/nodes.js';
import { NodeKind } from '../ast/nodes.js';
import { parse } from '../parser/parser.js';

export interface FormatOptions {
  indent?: string;
  finalNewline?: boolean;
}

export function formatDQL(source: string, options: FormatOptions = {}): string {
  const ast = parse(source);
  return formatProgram(ast, options);
}

export function formatProgram(program: ProgramNode, options: FormatOptions = {}): string {
  const state: FormatState = {
    indentUnit: options.indent ?? '  ',
  };

  const out = program.statements
    .map((stmt) => formatStatement(stmt, 0, state))
    .join('\n\n')
    .trimEnd();

  if (options.finalNewline === false) return out;
  return `${out}\n`;
}

interface FormatState {
  indentUnit: string;
}

function indent(level: number, state: FormatState): string {
  return state.indentUnit.repeat(level);
}

function formatStatement(node: StatementNode, level: number, state: FormatState): string {
  switch (node.kind) {
    case NodeKind.Dashboard:
      return formatDashboard(node, level, state);
    case NodeKind.ChartCall:
      return formatChart(node, level, state);
    case NodeKind.Workbook:
      return formatWorkbook(node, level, state);
    case NodeKind.ImportDecl:
      return formatImport(node, level, state);
    case NodeKind.BlockDecl:
      return formatBlock(node, level, state);
    default:
      return '';
  }
}

function formatDashboard(node: DashboardNode, level: number, state: FormatState): string {
  const lines: string[] = [];
  lines.push(...formatDecorators(node.decorators, level, state));
  lines.push(`${indent(level, state)}dashboard ${quote(node.title)} {`);
  for (const item of node.body) {
    lines.push(formatDashboardBodyItem(item, level + 1, state));
  }
  lines.push(`${indent(level, state)}}`);
  return lines.join('\n');
}

function formatWorkbook(node: WorkbookNode, level: number, state: FormatState): string {
  const lines: string[] = [];
  lines.push(...formatDecorators(node.decorators, level, state));
  lines.push(`${indent(level, state)}workbook ${quote(node.title)} {`);
  for (const page of node.pages) {
    lines.push(formatPage(page, level + 1, state));
  }
  lines.push(`${indent(level, state)}}`);
  return lines.join('\n');
}

function formatPage(node: PageNode, level: number, state: FormatState): string {
  const lines: string[] = [];
  lines.push(`${indent(level, state)}page ${quote(node.title)} {`);
  for (const item of node.body) {
    lines.push(formatDashboardBodyItem(item, level + 1, state));
  }
  lines.push(`${indent(level, state)}}`);
  return lines.join('\n');
}

function formatDashboardBodyItem(node: DashboardBodyItem, level: number, state: FormatState): string {
  switch (node.kind) {
    case NodeKind.VariableDecl:
      return formatVariable(node, level, state);
    case NodeKind.ParamDecl:
      return formatParam(node, level, state);
    case NodeKind.ChartCall:
      return formatChart(node, level, state);
    case NodeKind.FilterCall:
      return formatFilter(node, level, state);
    case NodeKind.UseDecl:
      return formatUse(node, level, state);
    case NodeKind.LayoutBlock:
      return formatLayout(node, level, state);
    default:
      return '';
  }
}

function formatImport(node: ImportDeclNode, level: number, state: FormatState): string {
  return `${indent(level, state)}import { ${node.names.join(', ')} } from ${quote(node.path)}`;
}

function formatUse(node: UseDeclNode, level: number, state: FormatState): string {
  const isIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/.test(node.name);
  return `${indent(level, state)}use ${isIdentifier ? node.name : quote(node.name)}`;
}

function formatVariable(node: VariableDeclNode, level: number, state: FormatState): string {
  return `${indent(level, state)}let ${node.name} = ${formatExpression(node.initializer)}`;
}

function formatParam(node: ParamDeclNode, level: number, state: FormatState): string {
  const typePart = `: ${node.paramType}`;
  const defaultPart = node.defaultValue ? ` = ${formatExpression(node.defaultValue)}` : '';
  return `${indent(level, state)}param ${node.name}${typePart}${defaultPart}`;
}

function formatDecorators(decorators: DecoratorNode[], level: number, state: FormatState): string[] {
  return decorators.map((dec) => {
    if (dec.arguments.length === 0) return `${indent(level, state)}@${dec.name}`;
    const args = dec.arguments.map((arg) => formatExpression(arg)).join(', ');
    return `${indent(level, state)}@${dec.name}(${args})`;
  });
}

function formatChart(node: ChartCallNode, level: number, state: FormatState): string {
  return formatCall(`chart.${node.chartType}`, node.decorators, node.query, node.args, level, state);
}

function formatFilter(node: FilterCallNode, level: number, state: FormatState): string {
  return formatCall(`filter.${node.filterType}`, [], node.query, node.args, level, state);
}

function formatCall(
  callName: string,
  decorators: DecoratorNode[],
  query: SQLQueryNode | undefined,
  args: NamedArgNode[],
  level: number,
  state: FormatState,
): string {
  const lines: string[] = [];
  lines.push(...formatDecorators(decorators, level, state));
  lines.push(`${indent(level, state)}${callName}(`);

  const bodyLines: string[] = [];
  if (query) {
    bodyLines.push(...formatSQLQuery(query, level + 1, state));
  }
  bodyLines.push(...args.map((arg) => `${indent(level + 1, state)}${formatNamedArg(arg)}`));

  if (bodyLines.length > 0) {
    for (let i = 0; i < bodyLines.length; i++) {
      const isLast = i === bodyLines.length - 1;
      lines.push(isLast ? bodyLines[i] : `${bodyLines[i]},`);
    }
  }

  lines.push(`${indent(level, state)})`);
  return lines.join('\n');
}

function formatLayout(node: LayoutBlockNode, level: number, state: FormatState): string {
  const lines: string[] = [];
  lines.push(`${indent(level, state)}layout(columns = ${node.columns}) {`);
  for (const row of node.rows) {
    lines.push(formatLayoutRow(row, level + 1, state));
  }
  lines.push(`${indent(level, state)}}`);
  return lines.join('\n');
}

function formatLayoutRow(node: LayoutRowNode, level: number, state: FormatState): string {
  const lines: string[] = [];
  lines.push(`${indent(level, state)}row {`);
  for (const item of node.items) {
    const body = item.node.kind === NodeKind.ChartCall
      ? formatChart(item.node, level + 1, state)
      : formatFilter(item.node, level + 1, state);

    if (item.span == null) {
      lines.push(body);
      continue;
    }

    const parts = body.split('\n');
    parts[parts.length - 1] = `${parts[parts.length - 1]} span ${item.span}`;
    lines.push(parts.join('\n'));
  }
  lines.push(`${indent(level, state)}}`);
  return lines.join('\n');
}

function formatBlock(node: BlockDeclNode, level: number, state: FormatState): string {
  const lines: string[] = [];
  lines.push(...formatDecorators(node.decorators, level, state));
  lines.push(`${indent(level, state)}block ${quote(node.name)} {`);

  if (node.domain) lines.push(`${indent(level + 1, state)}domain = ${quote(node.domain)}`);
  if (node.blockType) lines.push(`${indent(level + 1, state)}type = ${quote(node.blockType)}`);
  if (node.description) lines.push(`${indent(level + 1, state)}description = ${quote(node.description)}`);
  if (node.tags && node.tags.length > 0) {
    lines.push(`${indent(level + 1, state)}tags = [${node.tags.map(quote).join(', ')}]`);
  }
  if (node.owner) lines.push(`${indent(level + 1, state)}owner = ${quote(node.owner)}`);

  if (node.params) {
    lines.push(`${indent(level + 1, state)}params {`);
    for (const entry of node.params.params) {
      lines.push(`${indent(level + 2, state)}${entry.name} = ${formatExpression(entry.initializer)}`);
    }
    lines.push(`${indent(level + 1, state)}}`);
  }

  if (node.query) {
    lines.push(`${indent(level + 1, state)}query = """`);
    lines.push(...formatSQLQuery(node.query, level + 2, state));
    lines.push(`${indent(level + 1, state)}"""`);
  }

  if (node.visualization) {
    lines.push(`${indent(level + 1, state)}visualization {`);
    for (const prop of node.visualization.properties) {
      lines.push(`${indent(level + 2, state)}${formatNamedArg(prop)}`);
    }
    lines.push(`${indent(level + 1, state)}}`);
  }

  if (node.tests && node.tests.length > 0) {
    lines.push(`${indent(level + 1, state)}tests {`);
    for (const test of node.tests) {
      lines.push(
        `${indent(level + 2, state)}assert ${test.field} ${test.operator} ${formatExpression(test.expected)}`,
      );
    }
    lines.push(`${indent(level + 1, state)}}`);
  }

  lines.push(`${indent(level, state)}}`);
  return lines.join('\n');
}

function formatSQLQuery(query: SQLQueryNode, level: number, state: FormatState): string[] {
  const sql = query.rawSQL.replace(/^\n+|\s+$/g, '');
  if (!sql.trim()) return [`${indent(level, state)}SELECT 1`];
  const rawLines = sql.split('\n').map((line) => line.trimEnd());
  const nonEmpty = rawLines.filter((l) => l.length > 0);
  const minLeading = nonEmpty.length
    ? Math.min(...nonEmpty.map((l) => l.match(/^[ \t]*/)![0].length))
    : 0;
  return rawLines.map((line) =>
    line.length === 0 ? '' : `${indent(level, state)}${line.slice(minLeading)}`,
  );
}

function formatNamedArg(arg: NamedArgNode): string {
  return `${arg.name} = ${formatExpression(arg.value)}`;
}

function formatExpression(node: ExpressionNode): string {
  switch (node.kind) {
    case NodeKind.StringLiteral:
      return quote(node.value);
    case NodeKind.NumberLiteral:
      return String(node.value);
    case NodeKind.BooleanLiteral:
      return node.value ? 'true' : 'false';
    case NodeKind.Identifier:
      return node.name;
    case NodeKind.ArrayLiteral:
      return `[${node.elements.map((el) => formatExpression(el)).join(', ')}]`;
    case NodeKind.BinaryExpr:
      return `${formatExpression(node.left)} ${node.operator} ${formatExpression(node.right)}`;
    case NodeKind.IntervalExpr:
      return `INTERVAL ${quote(node.value)}`;
    case NodeKind.FunctionCall:
      return `${node.callee}(${node.arguments.map((arg) => formatExpression(arg)).join(', ')})`;
    case NodeKind.TemplateString:
      return quote(
        node.parts
          .map((part) => (typeof part === 'string' ? part : `{${formatExpression(part)}}`))
          .join(''),
      );
    default:
      return '';
  }
}

function quote(value: string): string {
  return JSON.stringify(value);
}
