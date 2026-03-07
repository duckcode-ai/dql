import type {
  ExpressionNode,
  ProgramNode,
  DashboardNode,
  ChartCallNode,
  FilterCallNode,
  VariableDeclNode,
  DecoratorNode,
  SQLQueryNode,
  NamedArgNode,
  StatementNode,
  WorkbookNode,
  BlockDeclNode,
} from './nodes.js';
import { NodeKind } from './nodes.js';

export function printAST(node: ProgramNode): string {
  let result = 'Program\n';
  for (const stmt of node.statements) {
    result += printStatement(stmt, 1);
  }
  return result;
}

function printStatement(node: StatementNode, indent: number): string {
  switch (node.kind) {
    case NodeKind.Dashboard:
      return printDashboard(node, indent);
    case NodeKind.ChartCall:
      return printChart(node, indent);
    case NodeKind.Workbook:
      return printWorkbook(node, indent);
    case NodeKind.ImportDecl:
      return `${'  '.repeat(indent)}Import [${node.names.join(', ')}] from "${node.path}"\n`;
    case NodeKind.BlockDecl:
      return printBlockDecl(node, indent);
    default:
      return '';
  }
}

function printWorkbook(node: WorkbookNode, indent: number): string {
  const prefix = '  '.repeat(indent);
  let result = `${prefix}Workbook "${node.title}"\n`;
  for (const dec of node.decorators) {
    result += printDecorator(dec, indent + 1);
  }
  for (const page of node.pages) {
    result += `${prefix}  Page "${page.title}"\n`;
    for (const item of page.body) {
      switch (item.kind) {
        case NodeKind.VariableDecl:
          result += printVariable(item, indent + 2);
          break;
        case NodeKind.ChartCall:
          result += printChart(item, indent + 2);
          break;
        case NodeKind.FilterCall:
          result += printFilter(item, indent + 2);
          break;
      }
    }
  }
  return result;
}

function printDashboard(node: DashboardNode, indent: number): string {
  const prefix = '  '.repeat(indent);
  let result = `${prefix}Dashboard "${node.title}"\n`;
  for (const dec of node.decorators) {
    result += printDecorator(dec, indent + 1);
  }
  for (const item of node.body) {
    switch (item.kind) {
      case NodeKind.VariableDecl:
        result += printVariable(item, indent + 1);
        break;
      case NodeKind.ChartCall:
        result += printChart(item, indent + 1);
        break;
      case NodeKind.FilterCall:
        result += printFilter(item, indent + 1);
        break;
    }
  }
  return result;
}

function printChart(node: ChartCallNode, indent: number): string {
  const prefix = '  '.repeat(indent);
  let result = `${prefix}ChartCall .${node.chartType}\n`;
  result += `${prefix}  SQL: ${node.query.rawSQL}\n`;
  for (const arg of node.args) {
    result += printNamedArg(arg, indent + 1);
  }
  return result;
}

function printFilter(node: FilterCallNode, indent: number): string {
  const prefix = '  '.repeat(indent);
  let result = `${prefix}FilterCall .${node.filterType}\n`;
  if (node.query) {
    result += `${prefix}  SQL: ${node.query.rawSQL}\n`;
  }
  for (const arg of node.args) {
    result += printNamedArg(arg, indent + 1);
  }
  return result;
}

function printVariable(node: VariableDeclNode, indent: number): string {
  const prefix = '  '.repeat(indent);
  return `${prefix}Let ${node.name} = ${expressionToString(node.initializer)}\n`;
}

function printDecorator(node: DecoratorNode, indent: number): string {
  const prefix = '  '.repeat(indent);
  let result = `${prefix}@${node.name}`;
  if (node.arguments.length > 0) {
    result += `(${node.arguments.map((a: ExpressionNode) => expressionToString(a)).join(', ')})`;
  }
  return result + '\n';
}

function printNamedArg(node: NamedArgNode, indent: number): string {
  const prefix = '  '.repeat(indent);
  return `${prefix}${node.name} = ${expressionToString(node.value)}\n`;
}

function printBlockDecl(node: BlockDeclNode, indent: number): string {
  const prefix = '  '.repeat(indent);
  let result = `${prefix}Block "${node.name}"\n`;
  for (const dec of node.decorators) {
    result += printDecorator(dec, indent + 1);
  }
  if (node.domain) result += `${prefix}  domain = "${node.domain}"\n`;
  if (node.blockType) result += `${prefix}  type = "${node.blockType}"\n`;
  if (node.description) result += `${prefix}  description = "${node.description}"\n`;
  if (node.tags) result += `${prefix}  tags = [${node.tags.map(t => `"${t}"`).join(', ')}]\n`;
  if (node.query) result += `${prefix}  SQL: ${node.query.rawSQL.substring(0, 60)}...\n`;
  if (node.visualization) {
    result += `${prefix}  visualization\n`;
    for (const prop of node.visualization.properties) {
      result += printNamedArg(prop, indent + 2);
    }
  }
  if (node.tests) {
    result += `${prefix}  tests (${node.tests.length})\n`;
  }
  return result;
}

function expressionToString(node: ExpressionNode): string {
  switch (node.kind) {
    case NodeKind.StringLiteral:
      return `"${node.value}"`;
    case NodeKind.NumberLiteral:
      return String(node.value);
    case NodeKind.BooleanLiteral:
      return String(node.value);
    case NodeKind.Identifier:
      return node.name;
    case NodeKind.ArrayLiteral:
      return `[${node.elements.map(expressionToString).join(', ')}]`;
    case NodeKind.BinaryExpr:
      return `(${expressionToString(node.left)} ${node.operator} ${expressionToString(node.right)})`;
    case NodeKind.IntervalExpr:
      return `INTERVAL '${node.value}'`;
    case NodeKind.FunctionCall:
      return `${node.callee}(${node.arguments.map(expressionToString).join(', ')})`;
    case NodeKind.TemplateString:
      return node.parts
        .map((p) => (typeof p === 'string' ? p : `{${expressionToString(p)}}`))
        .join('');
  }
}
