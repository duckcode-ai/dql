import type {
  ProgramNode,
  DashboardNode,
  ChartCallNode,
  FilterCallNode,
  VariableDeclNode,
  DecoratorNode,
  SQLQueryNode,
  NamedArgNode,
  StringLiteralNode,
  NumberLiteralNode,
  BooleanLiteralNode,
  ArrayLiteralNode,
  IdentifierNode,
  BinaryExprNode,
  IntervalExprNode,
  FunctionCallNode,
  TemplateStringNode,
  ExpressionNode,
  DashboardBodyItem,
  StatementNode,
  BlockDeclNode,
} from './nodes.js';
import { NodeKind } from './nodes.js';

export interface ASTVisitor<T = void> {
  visitProgram(node: ProgramNode): T;
  visitDashboard(node: DashboardNode): T;
  visitChartCall(node: ChartCallNode): T;
  visitFilterCall(node: FilterCallNode): T;
  visitVariableDecl(node: VariableDeclNode): T;
  visitDecorator(node: DecoratorNode): T;
  visitSQLQuery(node: SQLQueryNode): T;
  visitNamedArg(node: NamedArgNode): T;
  visitStringLiteral(node: StringLiteralNode): T;
  visitNumberLiteral(node: NumberLiteralNode): T;
  visitBooleanLiteral(node: BooleanLiteralNode): T;
  visitArrayLiteral(node: ArrayLiteralNode): T;
  visitIdentifier(node: IdentifierNode): T;
  visitBinaryExpr(node: BinaryExprNode): T;
  visitIntervalExpr(node: IntervalExprNode): T;
  visitFunctionCall(node: FunctionCallNode): T;
  visitTemplateString(node: TemplateStringNode): T;
  visitBlockDecl(node: BlockDeclNode): T;
}

export abstract class BaseVisitor<T = void> implements ASTVisitor<T> {
  visitProgram(node: ProgramNode): T {
    for (const stmt of node.statements) {
      this.visitStatement(stmt);
    }
    return undefined as T;
  }

  visitStatement(node: StatementNode): T {
    switch (node.kind) {
      case NodeKind.Dashboard:
        return this.visitDashboard(node);
      case NodeKind.ChartCall:
        return this.visitChartCall(node);
      case NodeKind.BlockDecl:
        return this.visitBlockDecl(node);
      default:
        return undefined as T;
    }
  }

  visitDashboard(node: DashboardNode): T {
    for (const dec of node.decorators) {
      this.visitDecorator(dec);
    }
    for (const item of node.body) {
      this.visitDashboardBodyItem(item);
    }
    return undefined as T;
  }

  visitDashboardBodyItem(node: DashboardBodyItem): T {
    switch (node.kind) {
      case NodeKind.VariableDecl:
        return this.visitVariableDecl(node);
      case NodeKind.ChartCall:
        return this.visitChartCall(node);
      case NodeKind.FilterCall:
        return this.visitFilterCall(node);
      default:
        return undefined as T;
    }
  }

  visitFilterCall(node: FilterCallNode): T {
    if (node.query) {
      this.visitSQLQuery(node.query);
    }
    for (const arg of node.args) {
      this.visitNamedArg(arg);
    }
    return undefined as T;
  }

  visitChartCall(node: ChartCallNode): T {
    for (const dec of node.decorators) {
      this.visitDecorator(dec);
    }
    this.visitSQLQuery(node.query);
    for (const arg of node.args) {
      this.visitNamedArg(arg);
    }
    return undefined as T;
  }

  visitVariableDecl(node: VariableDeclNode): T {
    this.visitExpression(node.initializer);
    return undefined as T;
  }

  visitDecorator(node: DecoratorNode): T {
    for (const arg of node.arguments) {
      this.visitExpression(arg);
    }
    return undefined as T;
  }

  visitSQLQuery(_node: SQLQueryNode): T {
    return undefined as T;
  }

  visitNamedArg(node: NamedArgNode): T {
    this.visitExpression(node.value);
    return undefined as T;
  }

  visitExpression(node: ExpressionNode): T {
    switch (node.kind) {
      case NodeKind.StringLiteral:
        return this.visitStringLiteral(node);
      case NodeKind.NumberLiteral:
        return this.visitNumberLiteral(node);
      case NodeKind.BooleanLiteral:
        return this.visitBooleanLiteral(node);
      case NodeKind.ArrayLiteral:
        return this.visitArrayLiteral(node);
      case NodeKind.Identifier:
        return this.visitIdentifier(node);
      case NodeKind.BinaryExpr:
        return this.visitBinaryExpr(node);
      case NodeKind.IntervalExpr:
        return this.visitIntervalExpr(node);
      case NodeKind.FunctionCall:
        return this.visitFunctionCall(node);
      case NodeKind.TemplateString:
        return this.visitTemplateString(node);
    }
  }

  visitStringLiteral(_node: StringLiteralNode): T {
    return undefined as T;
  }

  visitNumberLiteral(_node: NumberLiteralNode): T {
    return undefined as T;
  }

  visitBooleanLiteral(_node: BooleanLiteralNode): T {
    return undefined as T;
  }

  visitArrayLiteral(node: ArrayLiteralNode): T {
    for (const el of node.elements) {
      this.visitExpression(el);
    }
    return undefined as T;
  }

  visitIdentifier(_node: IdentifierNode): T {
    return undefined as T;
  }

  visitBinaryExpr(node: BinaryExprNode): T {
    this.visitExpression(node.left);
    this.visitExpression(node.right);
    return undefined as T;
  }

  visitIntervalExpr(_node: IntervalExprNode): T {
    return undefined as T;
  }

  visitFunctionCall(node: FunctionCallNode): T {
    for (const arg of node.arguments) {
      this.visitExpression(arg);
    }
    return undefined as T;
  }

  visitTemplateString(node: TemplateStringNode): T {
    for (const part of node.parts) {
      if (typeof part !== 'string') {
        this.visitExpression(part);
      }
    }
    return undefined as T;
  }

  visitBlockDecl(node: BlockDeclNode): T {
    for (const dec of node.decorators) {
      this.visitDecorator(dec);
    }
    if (node.query) {
      this.visitSQLQuery(node.query);
    }
    if (node.visualization) {
      for (const prop of node.visualization.properties) {
        this.visitNamedArg(prop);
      }
    }
    return undefined as T;
  }
}
