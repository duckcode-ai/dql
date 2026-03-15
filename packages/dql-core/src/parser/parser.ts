import type { SourceSpan } from '../errors/diagnostic.js';
import { DiagnosticReporter, DQLSyntaxError } from '../errors/reporter.js';
import { Lexer } from '../lexer/lexer.js';
import { TokenType, type Token, CHART_TYPES, FILTER_TYPES, SQL_START_KEYWORDS, normalizeChartType } from '../lexer/token.js';
import {
  NodeKind,
  type ProgramNode,
  type StatementNode,
  type DashboardNode,
  type ChartCallNode,
  type FilterCallNode,
  type VariableDeclNode,
  type DecoratorNode,
  type SQLQueryNode,
  type NamedArgNode,
  type ExpressionNode,
  type ChartType,
  type FilterType,
  type DashboardBodyItem,
  type TemplateInterpolation,
  type WorkbookNode,
  type PageNode,
  type ParamDeclNode,
  type ParamType,
  type ImportDeclNode,
  type UseDeclNode,
  type LayoutBlockNode,
  type LayoutRowNode,
  type LayoutRowItem,
  type BlockDeclNode,
  type BlockParamsNode,
  type BlockParamEntry,
  type BlockVisualizationNode,
  type BlockTestNode,
} from '../ast/nodes.js';

export class Parser {
  private tokens: Token[];
  private pos: number = 0;
  private source: string;
  private file: string | undefined;
  private reporter: DiagnosticReporter;

  constructor(source: string, file?: string) {
    this.source = source;
    this.file = file;
    this.reporter = new DiagnosticReporter();

    const lexer = new Lexer(source, file);
    this.tokens = lexer.tokenize();
  }

  parse(): ProgramNode {
    const start = this.currentSpan();
    const statements: StatementNode[] = [];

    while (!this.isAtEnd()) {
      try {
        const stmt = this.parseStatement();
        if (stmt) {
          statements.push(stmt);
        }
      } catch (e) {
        // Skip to next statement-level token on error
        this.synchronize();
      }
    }

    if (this.reporter.hasErrors()) {
      throw new DQLSyntaxError(
        `Parse errors in ${this.file ?? '<input>'}`,
        this.reporter.getErrors(),
      );
    }

    return {
      kind: NodeKind.Program,
      statements,
      span: this.makeSpan(start, this.currentSpan()),
    };
  }

  private parseStatement(): StatementNode | null {
    // Collect leading decorators
    const decorators = this.parseDecoratorList();

    if (this.check(TokenType.WorkbookKeyword)) {
      return this.parseWorkbook(decorators);
    }

    if (this.check(TokenType.DashboardKeyword)) {
      return this.parseDashboard(decorators);
    }

    if (this.check(TokenType.ChartKeyword)) {
      return this.parseChartCall(decorators);
    }

    if (this.check(TokenType.BlockKeyword)) {
      return this.parseBlockDecl(decorators);
    }

    if (this.check(TokenType.ImportKeyword)) {
      if (decorators.length > 0) {
        this.error('Decorators cannot be applied to import statements.');
      }
      return this.parseImportDecl();
    }

    if (this.check(TokenType.EOF)) {
      return null;
    }

    this.error(`Unexpected token '${this.current().value}'. Expected 'dashboard', 'workbook', 'chart', 'block', or 'import'.`);
    return null;
  }

  private parseFilterCall(): FilterCallNode {
    const start = this.currentSpan();
    this.expect(TokenType.FilterKeyword);
    this.expect(TokenType.Dot);

    const filterTypeToken = this.expect(TokenType.Identifier);
    if (!FILTER_TYPES.has(filterTypeToken.value)) {
      this.reporter.error(
        `Unknown filter type '${filterTypeToken.value}'. Valid types: ${[...FILTER_TYPES].join(', ')}`,
        filterTypeToken.span,
        `Did you mean one of: ${[...FILTER_TYPES].join(', ')}?`,
      );
    }

    this.expect(TokenType.LeftParen);

    // Check if there's a SQL query (SELECT/WITH) or just named args
    let query: SQLQueryNode | undefined;
    const currentToken = this.current();
    const tokenVal = currentToken.value.toUpperCase();

    if (tokenVal === 'SELECT' || tokenVal === 'WITH') {
      query = this.parseSQLQuery();
    }

    // Parse named arguments
    const args: NamedArgNode[] = [];
    while (this.check(TokenType.Comma) || (!query && (this.check(TokenType.Identifier) || this.isKeywordUsableAsArgName(this.current().type)))) {
      if (this.check(TokenType.Comma)) {
        this.advance(); // consume comma
      }
      if (this.check(TokenType.RightParen)) break; // trailing comma
      args.push(this.parseNamedArg());
    }

    this.expect(TokenType.RightParen);

    return {
      kind: NodeKind.FilterCall,
      filterType: filterTypeToken.value as FilterType,
      query,
      args,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  private parseDashboard(decorators: DecoratorNode[]): DashboardNode {
    const start = decorators.length > 0 ? decorators[0].span : this.currentSpan();
    this.expect(TokenType.DashboardKeyword);

    const titleToken = this.expect(TokenType.StringLiteral);
    this.expect(TokenType.LeftBrace);

    const body: DashboardBodyItem[] = [];

    while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
      // Collect decorators for items inside dashboard
      const itemDecorators = this.parseDecoratorList();

      if (this.check(TokenType.LetKeyword)) {
        if (itemDecorators.length > 0) {
          this.error('Decorators cannot be applied to variable declarations.');
        }
        body.push(this.parseVariableDecl());
      } else if (this.check(TokenType.ParamKeyword)) {
        if (itemDecorators.length > 0) {
          this.error('Decorators cannot be applied to param declarations.');
        }
        body.push(this.parseParamDecl());
      } else if (this.check(TokenType.ChartKeyword)) {
        body.push(this.parseChartCall(itemDecorators));
      } else if (this.check(TokenType.FilterKeyword)) {
        if (itemDecorators.length > 0) {
          this.error('Decorators cannot be applied to filter declarations.');
        }
        body.push(this.parseFilterCall());
      } else if (this.check(TokenType.UseKeyword)) {
        if (itemDecorators.length > 0) {
          this.error('Decorators cannot be applied to use declarations.');
        }
        body.push(this.parseUseDecl());
      } else if (this.check(TokenType.LayoutKeyword)) {
        if (itemDecorators.length > 0) {
          this.error('Decorators cannot be applied to layout blocks.');
        }
        body.push(this.parseLayoutBlock());
      } else if (this.check(TokenType.RightBrace)) {
        break;
      } else {
        this.error(
          `Unexpected token '${this.current().value}' inside dashboard. Expected 'let', 'param', 'chart', 'filter', 'use', 'layout', or '}'.`,
        );
        this.advance();
      }
    }

    this.expect(TokenType.RightBrace);

    return {
      kind: NodeKind.Dashboard,
      title: titleToken.value,
      decorators,
      body,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  private parseChartCall(decorators: DecoratorNode[]): ChartCallNode {
    const start = decorators.length > 0 ? decorators[0].span : this.currentSpan();
    this.expect(TokenType.ChartKeyword);
    this.expect(TokenType.Dot);

    const chartTypeStart = this.currentSpan();
    const chartTypeToken = this.expect(TokenType.Identifier);
    let rawChartType = chartTypeToken.value;
    while (this.check(TokenType.Minus)) {
      this.advance();
      rawChartType += `-${this.expect(TokenType.Identifier).value}`;
    }
    const chartTypeSpan = this.makeSpan(chartTypeStart, this.previousSpan());
    if (!CHART_TYPES.has(rawChartType)) {
      this.reporter.error(
        `Unknown chart type '${rawChartType}'. Valid types: ${[...CHART_TYPES].join(', ')}`,
        chartTypeSpan,
        `Did you mean one of: ${[...CHART_TYPES].join(', ')}?`,
      );
    }
    const normalizedChartType = normalizeChartType(rawChartType);

    this.expect(TokenType.LeftParen);

    // Parse the SQL query using boundary detection on the raw source
    const query = this.parseSQLQuery();

    // Parse named arguments
    const args: NamedArgNode[] = [];
    while (this.check(TokenType.Comma)) {
      this.advance(); // consume comma
      if (this.check(TokenType.RightParen)) break; // trailing comma
      args.push(this.parseNamedArg());
    }

    this.expect(TokenType.RightParen);

    return {
      kind: NodeKind.ChartCall,
      chartType: normalizedChartType as ChartType,
      query,
      args,
      decorators,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  private parseSQLQuery(): SQLQueryNode {
    const start = this.currentSpan();

    // We need to find the SQL text from the raw source.
    // The current token should be the start of the SQL (SELECT, WITH, etc.)
    // We use Lexer.scanSQLBoundary on the raw source to find where SQL ends.
    const currentToken = this.current();
    const sqlStartOffset = currentToken.span.start.offset;

    // Scan the raw source for SQL boundary
    const { sql, endOffset } = Lexer.scanSQLBoundary(this.source, sqlStartOffset, 1);

    // Extract template interpolations from the SQL text
    const interpolations = this.extractInterpolations(sql, start);

    // Now advance our token position past all tokens that fall within the SQL range
    while (
      !this.isAtEnd() &&
      this.current().span.start.offset < endOffset
    ) {
      this.advance();
    }

    const span = this.makeSpan(start, this.currentSpan());

    return {
      kind: NodeKind.SQLQuery,
      rawSQL: sql,
      interpolations,
      span,
    };
  }

  private extractInterpolations(sql: string, baseSpan: SourceSpan): TemplateInterpolation[] {
    const interpolations: TemplateInterpolation[] = [];
    const regex = /\$\{(\w+)\}|\{(\w+)\}/g;
    let match;

    while ((match = regex.exec(sql)) !== null) {
      const variableName = match[1] || match[2];
      if (!variableName) continue;
      interpolations.push({
        variableName,
        offsetInSQL: match.index,
        span: baseSpan, // simplified; ideally compute exact position
      });
    }

    return interpolations;
  }

  private parseNamedArg(): NamedArgNode {
    const start = this.currentSpan();
    // Accept identifiers and keywords that may be used as argument names (e.g. 'param', 'label', 'from')
    const nameToken = this.current();
    if (nameToken.type === TokenType.Identifier || this.isKeywordUsableAsArgName(nameToken.type)) {
      this.advance();
    } else {
      this.error(`Expected argument name, got '${nameToken.value}'.`);
      this.advance();
    }
    this.expect(TokenType.Equals);
    const value = this.parseExpression();

    return {
      kind: NodeKind.NamedArg,
      name: nameToken.value,
      value,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  private isKeywordUsableAsArgName(type: TokenType): boolean {
    return type === TokenType.ParamKeyword
      || type === TokenType.FromKeyword
      || type === TokenType.LayoutKeyword
      || type === TokenType.RowKeyword
      || type === TokenType.UseKeyword
      || type === TokenType.ImportKeyword;
  }

  private parseVariableDecl(): VariableDeclNode {
    const start = this.currentSpan();
    this.expect(TokenType.LetKeyword);
    const nameToken = this.expect(TokenType.Identifier);
    this.expect(TokenType.Equals);
    const initializer = this.parseExpression();

    return {
      kind: NodeKind.VariableDecl,
      name: nameToken.value,
      initializer,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  private parseDecoratorList(): DecoratorNode[] {
    const decorators: DecoratorNode[] = [];
    while (this.check(TokenType.AtSign)) {
      decorators.push(this.parseDecorator());
    }
    return decorators;
  }

  private parseDecorator(): DecoratorNode {
    const start = this.currentSpan();
    this.expect(TokenType.AtSign);
    const nameToken = this.expect(TokenType.Identifier);

    const args: ExpressionNode[] = [];
    if (this.check(TokenType.LeftParen)) {
      this.advance(); // consume (
      if (!this.check(TokenType.RightParen)) {
        args.push(this.parseExpression());
        while (this.check(TokenType.Comma)) {
          this.advance();
          args.push(this.parseExpression());
        }
      }
      this.expect(TokenType.RightParen);
    }

    return {
      kind: NodeKind.Decorator,
      name: nameToken.value,
      arguments: args,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  private parseExpression(): ExpressionNode {
    let left = this.parsePrimary();

    // Handle binary + and - operators
    while (this.check(TokenType.Plus) || this.check(TokenType.Minus)) {
      const opToken = this.advance();
      const right = this.parsePrimary();
      left = {
        kind: NodeKind.BinaryExpr,
        operator: opToken.value as '+' | '-',
        left,
        right,
        span: this.makeSpan(left.span, right.span),
      };
    }

    return left;
  }

  private parsePrimary(): ExpressionNode {
    const token = this.current();

    // String literal
    if (this.check(TokenType.StringLiteral)) {
      this.advance();
      return {
        kind: NodeKind.StringLiteral,
        value: token.value,
        span: token.span,
      };
    }

    // Number literal
    if (this.check(TokenType.NumberLiteral)) {
      this.advance();
      return {
        kind: NodeKind.NumberLiteral,
        value: Number(token.value),
        span: token.span,
      };
    }

    // Boolean literal
    if (this.check(TokenType.BooleanLiteral)) {
      this.advance();
      return {
        kind: NodeKind.BooleanLiteral,
        value: token.value === 'true',
        span: token.span,
      };
    }

    // Array literal
    if (this.check(TokenType.LeftBracket)) {
      return this.parseArrayLiteral();
    }

    // INTERVAL expression
    if (this.check(TokenType.IntervalKeyword)) {
      const start = this.currentSpan();
      this.advance(); // consume INTERVAL
      const valueToken = this.expect(TokenType.StringLiteral);
      return {
        kind: NodeKind.IntervalExpr,
        value: valueToken.value,
        span: this.makeSpan(start, this.previousSpan()),
      };
    }

    // Identifier (may be function call)
    if (this.check(TokenType.Identifier)) {
      this.advance();
      const name = token.value;

      // Check for function call: ident(
      if (this.check(TokenType.LeftParen)) {
        return this.parseFunctionCall(name, token.span);
      }

      return {
        kind: NodeKind.Identifier,
        name,
        span: token.span,
      };
    }

    // Negative number (minus followed by number)
    if (this.check(TokenType.Minus)) {
      const start = this.currentSpan();
      this.advance();
      const numToken = this.expect(TokenType.NumberLiteral);
      return {
        kind: NodeKind.NumberLiteral,
        value: -Number(numToken.value),
        span: this.makeSpan(start, numToken.span),
      };
    }

    this.error(`Unexpected token '${token.value}'. Expected an expression.`);
    this.advance();
    return {
      kind: NodeKind.Identifier,
      name: '__error__',
      span: token.span,
    };
  }

  private parseArrayLiteral(): ExpressionNode {
    const start = this.currentSpan();
    this.expect(TokenType.LeftBracket);

    const elements: ExpressionNode[] = [];
    if (!this.check(TokenType.RightBracket)) {
      elements.push(this.parseExpression());
      while (this.check(TokenType.Comma)) {
        this.advance();
        if (this.check(TokenType.RightBracket)) break; // trailing comma
        elements.push(this.parseExpression());
      }
    }

    this.expect(TokenType.RightBracket);

    return {
      kind: NodeKind.ArrayLiteral,
      elements,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  private parseFunctionCall(callee: string, start: SourceSpan): ExpressionNode {
    this.expect(TokenType.LeftParen);

    const args: ExpressionNode[] = [];
    if (!this.check(TokenType.RightParen)) {
      args.push(this.parseExpression());
      while (this.check(TokenType.Comma)) {
        this.advance();
        args.push(this.parseExpression());
      }
    }

    this.expect(TokenType.RightParen);

    return {
      kind: NodeKind.FunctionCall,
      callee,
      arguments: args,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  // ---- Helpers ----

  private current(): Token {
    return this.tokens[this.pos] ?? this.tokens[this.tokens.length - 1];
  }

  private previous(): Token {
    return this.tokens[this.pos - 1] ?? this.tokens[0];
  }

  private check(type: TokenType): boolean {
    return this.current().type === type;
  }

  private advance(): Token {
    const token = this.current();
    if (!this.isAtEnd()) {
      this.pos++;
    }
    return token;
  }

  private expect(type: TokenType): Token {
    if (this.check(type)) {
      return this.advance();
    }

    const token = this.current();
    this.error(
      `Expected ${type} but found '${token.value}' (${token.type}).`,
    );

    // Return a synthetic token to keep parsing
    return {
      type,
      value: '',
      span: token.span,
    };
  }

  private isAtEnd(): boolean {
    return this.current().type === TokenType.EOF;
  }

  private error(message: string): void {
    this.reporter.error(message, this.currentSpan());
  }

  private currentSpan(): SourceSpan {
    return this.current().span;
  }

  private previousSpan(): SourceSpan {
    return this.previous().span;
  }

  private makeSpan(start: SourceSpan, end: SourceSpan): SourceSpan {
    return { start: start.start, end: end.end };
  }

  // ---- Block Declaration ----

  private parseBlockDecl(decorators: DecoratorNode[]): BlockDeclNode {
    const start = decorators.length > 0 ? decorators[0].span : this.currentSpan();
    this.expect(TokenType.BlockKeyword);

    const nameToken = this.expect(TokenType.StringLiteral);
    this.expect(TokenType.LeftBrace);

    let domain: string | undefined;
    let blockType: 'semantic' | 'custom' | undefined;
    let metricRef: string | undefined;
    let description: string | undefined;
    let tags: string[] | undefined;
    let owner: string | undefined;
    let params: BlockParamsNode | undefined;
    let query: SQLQueryNode | undefined;
    let visualization: BlockVisualizationNode | undefined;
    let tests: BlockTestNode[] | undefined;

    while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
      if (this.check(TokenType.DomainKeyword)) {
        this.advance();
        this.expect(TokenType.Equals);
        const val = this.expect(TokenType.StringLiteral);
        domain = val.value;
      } else if (this.check(TokenType.TypeKeyword)) {
        this.advance();
        this.expect(TokenType.Equals);
        const val = this.expect(TokenType.StringLiteral);
        const raw = val.value;
        if (raw === 'semantic' || raw === 'custom') {
          blockType = raw;
        } else {
          this.error(
            `Block type must be "semantic" or "custom", got "${raw}". Use type = "semantic" for dbt metric blocks or type = "custom" for SQL blocks.`,
          );
          blockType = 'custom'; // recover gracefully
        }
      } else if (this.check(TokenType.MetricKeyword)) {
        this.advance();
        this.expect(TokenType.Equals);
        const val = this.expect(TokenType.StringLiteral);
        metricRef = val.value;
      } else if (this.check(TokenType.DescriptionKeyword)) {
        this.advance();
        this.expect(TokenType.Equals);
        const val = this.expect(TokenType.StringLiteral);
        description = val.value;
      } else if (this.check(TokenType.TagsKeyword)) {
        this.advance();
        this.expect(TokenType.Equals);
        const arrExpr = this.parseArrayLiteral();
        if (arrExpr.kind === NodeKind.ArrayLiteral) {
          tags = arrExpr.elements
            .filter((e): e is import('../ast/nodes.js').StringLiteralNode => e.kind === NodeKind.StringLiteral)
            .map((e) => e.value);
        }
      } else if (this.check(TokenType.OwnerKeyword)) {
        this.advance();
        this.expect(TokenType.Equals);
        const val = this.expect(TokenType.StringLiteral);
        owner = val.value;
      } else if (this.check(TokenType.ParamsKeyword)) {
        params = this.parseBlockParams();
      } else if (this.check(TokenType.QueryKeyword)) {
        this.advance();
        this.expect(TokenType.Equals);
        if (this.check(TokenType.TripleQuoteString)) {
          const sqlToken = this.advance();
          const interpolations = this.extractInterpolations(sqlToken.value, sqlToken.span);
          query = {
            kind: NodeKind.SQLQuery,
            rawSQL: sqlToken.value,
            interpolations,
            span: sqlToken.span,
          };
        } else {
          // Fallback: parse as inline SQL
          query = this.parseSQLQuery();
        }
      } else if (this.check(TokenType.VisualizationKeyword)) {
        visualization = this.parseBlockVisualization();
      } else if (this.check(TokenType.TestsKeyword)) {
        tests = this.parseBlockTests();
      } else if (this.check(TokenType.RightBrace)) {
        break;
      } else {
        this.error(
          `Unexpected token '${this.current().value}' inside block. Expected 'domain', 'type', 'metric', 'description', 'tags', 'owner', 'params', 'query', 'visualization', 'tests', or '}'.`,
        );
        this.advance();
      }
    }

    this.expect(TokenType.RightBrace);

    return {
      kind: NodeKind.BlockDecl,
      name: nameToken.value,
      domain,
      blockType,
      metricRef,
      description,
      tags,
      owner,
      params,
      query,
      visualization,
      tests,
      decorators,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  private parseBlockParams(): BlockParamsNode {
    const start = this.currentSpan();
    this.expect(TokenType.ParamsKeyword);
    this.expect(TokenType.LeftBrace);

    const paramEntries: BlockParamEntry[] = [];

    while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
      const paramStart = this.currentSpan();
      const nameToken = this.current();
      if (nameToken.type === TokenType.Identifier || this.isBlockFieldKeyword(nameToken.type)) {
        this.advance();
      } else {
        this.error(`Expected parameter name, got '${nameToken.value}'.`);
        this.advance();
        continue;
      }
      this.expect(TokenType.Equals);
      const initializer = this.parseExpression();
      paramEntries.push({
        name: nameToken.value,
        initializer,
        span: this.makeSpan(paramStart, this.previousSpan()),
      });
    }

    this.expect(TokenType.RightBrace);

    return {
      kind: NodeKind.BlockParams,
      params: paramEntries,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  private parseBlockVisualization(): BlockVisualizationNode {
    const start = this.currentSpan();
    this.expect(TokenType.VisualizationKeyword);
    this.expect(TokenType.LeftBrace);

    const properties: NamedArgNode[] = [];

    while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
      const propStart = this.currentSpan();
      const nameToken = this.current();
      if (nameToken.type === TokenType.Identifier || this.isBlockFieldKeyword(nameToken.type)) {
        this.advance();
      } else {
        this.error(`Expected property name, got '${nameToken.value}'.`);
        this.advance();
        continue;
      }
      this.expect(TokenType.Equals);
      const value = this.parseExpression();
      properties.push({
        kind: NodeKind.NamedArg,
        name: nameToken.value,
        value,
        span: this.makeSpan(propStart, this.previousSpan()),
      });
    }

    this.expect(TokenType.RightBrace);

    return {
      kind: NodeKind.BlockVisualization,
      properties,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  private parseBlockTests(): BlockTestNode[] {
    const start = this.currentSpan();
    this.expect(TokenType.TestsKeyword);
    this.expect(TokenType.LeftBrace);

    const testNodes: BlockTestNode[] = [];

    while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
      if (this.check(TokenType.AssertKeyword)) {
        const assertStart = this.currentSpan();
        this.advance(); // consume 'assert'

        const fieldToken = this.current();
        if (fieldToken.type === TokenType.Identifier || this.isBlockFieldKeyword(fieldToken.type)) {
          this.advance();
        } else {
          this.error(`Expected field name after 'assert', got '${fieldToken.value}'.`);
          this.advance();
          continue;
        }

        // Parse operator
        let operator: BlockTestNode['operator'];
        if (this.check(TokenType.GreaterThan)) {
          this.advance();
          operator = '>';
        } else if (this.check(TokenType.LessThan)) {
          this.advance();
          operator = '<';
        } else if (this.check(TokenType.GreaterThanOrEqual)) {
          this.advance();
          operator = '>=';
        } else if (this.check(TokenType.LessThanOrEqual)) {
          this.advance();
          operator = '<=';
        } else if (this.check(TokenType.DoubleEquals)) {
          this.advance();
          operator = '==';
        } else if (this.check(TokenType.NotEquals)) {
          this.advance();
          operator = '!=';
        } else if (this.check(TokenType.InKeyword)) {
          this.advance();
          operator = 'IN';
        } else {
          this.error(`Expected comparison operator (>, <, >=, <=, ==, !=, IN) after field name, got '${this.current().value}'.`);
          this.advance();
          continue;
        }

        const expected = this.parseExpression();

        testNodes.push({
          kind: NodeKind.BlockTest,
          field: fieldToken.value,
          operator,
          expected,
          span: this.makeSpan(assertStart, this.previousSpan()),
        });
      } else if (this.check(TokenType.RightBrace)) {
        break;
      } else {
        this.error(`Unexpected token '${this.current().value}' inside tests. Expected 'assert' or '}'.`);
        this.advance();
      }
    }

    this.expect(TokenType.RightBrace);

    return testNodes;
  }

  private isBlockFieldKeyword(type: TokenType): boolean {
    return type === TokenType.DomainKeyword
      || type === TokenType.TypeKeyword
      || type === TokenType.MetricKeyword
      || type === TokenType.DescriptionKeyword
      || type === TokenType.TagsKeyword
      || type === TokenType.OwnerKeyword
      || type === TokenType.ChartKeyword
      || type === TokenType.QueryKeyword
      || type === TokenType.DefaultKeyword
      || type === TokenType.FromKeyword;
  }

  // ---- Workbook / Page ----

  private parseWorkbook(decorators: DecoratorNode[]): WorkbookNode {
    const start = decorators.length > 0 ? decorators[0].span : this.currentSpan();
    this.expect(TokenType.WorkbookKeyword);

    const titleToken = this.expect(TokenType.StringLiteral);
    this.expect(TokenType.LeftBrace);

    const pages: PageNode[] = [];

    while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
      if (this.check(TokenType.PageKeyword)) {
        pages.push(this.parsePage());
      } else if (this.check(TokenType.RightBrace)) {
        break;
      } else {
        this.error(
          `Unexpected token '${this.current().value}' inside workbook. Expected 'page' or '}'.`,
        );
        this.advance();
      }
    }

    this.expect(TokenType.RightBrace);

    return {
      kind: NodeKind.Workbook,
      title: titleToken.value,
      decorators,
      pages,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  private parsePage(): PageNode {
    const start = this.currentSpan();
    this.expect(TokenType.PageKeyword);

    const titleToken = this.expect(TokenType.StringLiteral);
    this.expect(TokenType.LeftBrace);

    const body: DashboardBodyItem[] = [];

    while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
      const itemDecorators = this.parseDecoratorList();

      if (this.check(TokenType.LetKeyword)) {
        if (itemDecorators.length > 0) {
          this.error('Decorators cannot be applied to variable declarations.');
        }
        body.push(this.parseVariableDecl());
      } else if (this.check(TokenType.ParamKeyword)) {
        if (itemDecorators.length > 0) {
          this.error('Decorators cannot be applied to param declarations.');
        }
        body.push(this.parseParamDecl());
      } else if (this.check(TokenType.ChartKeyword)) {
        body.push(this.parseChartCall(itemDecorators));
      } else if (this.check(TokenType.FilterKeyword)) {
        if (itemDecorators.length > 0) {
          this.error('Decorators cannot be applied to filter declarations.');
        }
        body.push(this.parseFilterCall());
      } else if (this.check(TokenType.UseKeyword)) {
        if (itemDecorators.length > 0) {
          this.error('Decorators cannot be applied to use declarations.');
        }
        body.push(this.parseUseDecl());
      } else if (this.check(TokenType.LayoutKeyword)) {
        if (itemDecorators.length > 0) {
          this.error('Decorators cannot be applied to layout blocks.');
        }
        body.push(this.parseLayoutBlock());
      } else if (this.check(TokenType.RightBrace)) {
        break;
      } else {
        this.error(
          `Unexpected token '${this.current().value}' inside page. Expected 'let', 'param', 'chart', 'filter', 'use', 'layout', or '}'.`,
        );
        this.advance();
      }
    }

    this.expect(TokenType.RightBrace);

    return {
      kind: NodeKind.Page,
      title: titleToken.value,
      body,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  // ---- Param Declaration ----

  private parseParamDecl(): ParamDeclNode {
    const start = this.currentSpan();
    this.expect(TokenType.ParamKeyword);

    const nameToken = this.expect(TokenType.Identifier);

    // Optional type annotation: param name: type
    let paramType: ParamType = 'string';
    if (this.check(TokenType.ColonToken)) {
      this.advance(); // consume ':'
      const typeToken = this.expect(TokenType.Identifier);
      const validTypes = ['string', 'number', 'boolean', 'date'];
      if (validTypes.includes(typeToken.value)) {
        paramType = typeToken.value as ParamType;
      } else {
        this.reporter.error(
          `Invalid param type '${typeToken.value}'. Valid types: ${validTypes.join(', ')}`,
          typeToken.span,
        );
      }
    }

    // Optional default value: = expression
    let defaultValue: ExpressionNode | undefined;
    if (this.check(TokenType.Equals)) {
      this.advance(); // consume '='
      defaultValue = this.parseExpression();
    }

    return {
      kind: NodeKind.ParamDecl,
      name: nameToken.value,
      paramType,
      defaultValue,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  // ---- Import / Use ----

  private parseImportDecl(): ImportDeclNode {
    const start = this.currentSpan();
    this.expect(TokenType.ImportKeyword);

    // import { name1, name2 } from "path"
    this.expect(TokenType.LeftBrace);

    const names: string[] = [];
    if (!this.check(TokenType.RightBrace)) {
      names.push(this.expect(TokenType.Identifier).value);
      while (this.check(TokenType.Comma)) {
        this.advance();
        if (this.check(TokenType.RightBrace)) break; // trailing comma
        names.push(this.expect(TokenType.Identifier).value);
      }
    }

    this.expect(TokenType.RightBrace);
    this.expect(TokenType.FromKeyword);

    const pathToken = this.expect(TokenType.StringLiteral);

    return {
      kind: NodeKind.ImportDecl,
      names,
      path: pathToken.value,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  private parseUseDecl(): UseDeclNode {
    const start = this.currentSpan();
    this.expect(TokenType.UseKeyword);

    let nameToken: Token;
    if (this.check(TokenType.Identifier) || this.check(TokenType.StringLiteral)) {
      nameToken = this.advance();
    } else {
      nameToken = this.expect(TokenType.Identifier);
    }

    return {
      kind: NodeKind.UseDecl,
      name: nameToken.value,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  // ---- Layout ----

  private parseLayoutBlock(): LayoutBlockNode {
    const start = this.currentSpan();
    this.expect(TokenType.LayoutKeyword);

    // Optional: layout(columns = 12)
    let columns = 12;
    if (this.check(TokenType.LeftParen)) {
      this.advance();
      const args: NamedArgNode[] = [];
      if (!this.check(TokenType.RightParen)) {
        args.push(this.parseNamedArg());
        while (this.check(TokenType.Comma)) {
          this.advance();
          if (this.check(TokenType.RightParen)) break;
          args.push(this.parseNamedArg());
        }
      }
      this.expect(TokenType.RightParen);

      const colArg = args.find((a) => a.name === 'columns');
      if (colArg && colArg.value.kind === NodeKind.NumberLiteral) {
        columns = colArg.value.value;
      }
    }

    this.expect(TokenType.LeftBrace);

    const rows: LayoutRowNode[] = [];

    while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
      if (this.check(TokenType.RowKeyword)) {
        rows.push(this.parseLayoutRow());
      } else if (this.check(TokenType.RightBrace)) {
        break;
      } else {
        this.error(
          `Unexpected token '${this.current().value}' inside layout. Expected 'row' or '}'.`,
        );
        this.advance();
      }
    }

    this.expect(TokenType.RightBrace);

    return {
      kind: NodeKind.LayoutBlock,
      columns,
      rows,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  private parseLayoutRow(): LayoutRowNode {
    const start = this.currentSpan();
    this.expect(TokenType.RowKeyword);
    this.expect(TokenType.LeftBrace);

    const items: LayoutRowItem[] = [];

    while (!this.check(TokenType.RightBrace) && !this.isAtEnd()) {
      const itemDecorators = this.parseDecoratorList();

      let node: ChartCallNode | FilterCallNode;
      if (this.check(TokenType.ChartKeyword)) {
        node = this.parseChartCall(itemDecorators);
      } else if (this.check(TokenType.FilterKeyword)) {
        if (itemDecorators.length > 0) {
          this.error('Decorators cannot be applied to filter declarations.');
        }
        node = this.parseFilterCall();
      } else if (this.check(TokenType.RightBrace)) {
        break;
      } else {
        this.error(
          `Unexpected token '${this.current().value}' inside row. Expected 'chart', 'filter', or '}'.`,
        );
        this.advance();
        continue;
      }

      // Check for optional 'span N' after the chart/filter call
      let span: number | undefined;
      if (this.check(TokenType.Identifier) && this.current().value === 'span') {
        this.advance(); // consume 'span'
        const spanToken = this.expect(TokenType.NumberLiteral);
        span = Number(spanToken.value);
      }

      items.push({ node, span });
    }

    this.expect(TokenType.RightBrace);

    return {
      kind: NodeKind.LayoutRow,
      items,
      span: this.makeSpan(start, this.previousSpan()),
    };
  }

  // ---- Helpers ----

  private synchronize(): void {
    while (!this.isAtEnd()) {
      const token = this.current();
      if (
        token.type === TokenType.DashboardKeyword ||
        token.type === TokenType.WorkbookKeyword ||
        token.type === TokenType.ChartKeyword ||
        token.type === TokenType.FilterKeyword ||
        token.type === TokenType.ImportKeyword ||
        token.type === TokenType.BlockKeyword ||
        token.type === TokenType.AtSign ||
        token.type === TokenType.RightBrace
      ) {
        return;
      }
      this.advance();
    }
  }
}

export function parse(source: string, file?: string): ProgramNode {
  const parser = new Parser(source, file);
  return parser.parse();
}
