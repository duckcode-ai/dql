import { describe, it, expect } from 'vitest';
import { Lexer } from './lexer.js';
import { TokenType } from './token.js';

describe('Lexer', () => {
  it('tokenizes simple chart call keywords', () => {
    const lexer = new Lexer('chart.line');
    const tokens = lexer.tokenize();
    expect(tokens[0].type).toBe(TokenType.ChartKeyword);
    expect(tokens[1].type).toBe(TokenType.Dot);
    expect(tokens[2].type).toBe(TokenType.Identifier);
    expect(tokens[2].value).toBe('line');
    expect(tokens[3].type).toBe(TokenType.EOF);
  });

  it('tokenizes dashboard keyword and string', () => {
    const lexer = new Lexer('dashboard "My Dashboard"');
    const tokens = lexer.tokenize();
    expect(tokens[0].type).toBe(TokenType.DashboardKeyword);
    expect(tokens[1].type).toBe(TokenType.StringLiteral);
    expect(tokens[1].value).toBe('My Dashboard');
  });

  it('tokenizes let variable declaration', () => {
    const lexer = new Lexer('let today = CURRENT_DATE');
    const tokens = lexer.tokenize();
    expect(tokens[0].type).toBe(TokenType.LetKeyword);
    expect(tokens[1].type).toBe(TokenType.Identifier);
    expect(tokens[1].value).toBe('today');
    expect(tokens[2].type).toBe(TokenType.Equals);
    expect(tokens[3].type).toBe(TokenType.Identifier);
    expect(tokens[3].value).toBe('CURRENT_DATE');
  });

  it('tokenizes numbers', () => {
    const lexer = new Lexer('42 3.14');
    const tokens = lexer.tokenize();
    expect(tokens[0].type).toBe(TokenType.NumberLiteral);
    expect(tokens[0].value).toBe('42');
    expect(tokens[1].type).toBe(TokenType.NumberLiteral);
    expect(tokens[1].value).toBe('3.14');
  });

  it('tokenizes boolean literals', () => {
    const lexer = new Lexer('true false');
    const tokens = lexer.tokenize();
    expect(tokens[0].type).toBe(TokenType.BooleanLiteral);
    expect(tokens[0].value).toBe('true');
    expect(tokens[1].type).toBe(TokenType.BooleanLiteral);
    expect(tokens[1].value).toBe('false');
  });

  it('tokenizes decorator syntax', () => {
    const lexer = new Lexer('@schedule(daily, "9:00 AM")');
    const tokens = lexer.tokenize();
    expect(tokens[0].type).toBe(TokenType.AtSign);
    expect(tokens[1].type).toBe(TokenType.Identifier);
    expect(tokens[1].value).toBe('schedule');
    expect(tokens[2].type).toBe(TokenType.LeftParen);
    expect(tokens[3].type).toBe(TokenType.Identifier);
    expect(tokens[3].value).toBe('daily');
    expect(tokens[4].type).toBe(TokenType.Comma);
    expect(tokens[5].type).toBe(TokenType.StringLiteral);
    expect(tokens[5].value).toBe('9:00 AM');
  });

  it('tokenizes array literals', () => {
    const lexer = new Lexer('["a", "b", "c"]');
    const tokens = lexer.tokenize();
    expect(tokens[0].type).toBe(TokenType.LeftBracket);
    expect(tokens[1].type).toBe(TokenType.StringLiteral);
    expect(tokens[6].type).toBe(TokenType.RightBracket);
  });

  it('skips single-line comments', () => {
    const lexer = new Lexer('// this is a comment\nchart');
    const tokens = lexer.tokenize();
    expect(tokens[0].type).toBe(TokenType.ChartKeyword);
  });

  it('tracks source locations correctly', () => {
    const lexer = new Lexer('let x = 10');
    const tokens = lexer.tokenize();
    expect(tokens[0].span.start.line).toBe(1);
    expect(tokens[0].span.start.column).toBe(1);
  });

  it('handles INTERVAL keyword', () => {
    const lexer = new Lexer("INTERVAL '1 day'");
    const tokens = lexer.tokenize();
    expect(tokens[0].type).toBe(TokenType.IntervalKeyword);
    expect(tokens[1].type).toBe(TokenType.StringLiteral);
    expect(tokens[1].value).toBe('1 day');
  });

  it('handles escaped strings', () => {
    const lexer = new Lexer('"hello \\"world\\""');
    const tokens = lexer.tokenize();
    expect(tokens[0].type).toBe(TokenType.StringLiteral);
    expect(tokens[0].value).toBe('hello "world"');
  });

  it('tokenizes block keyword', () => {
    const lexer = new Lexer('block "Revenue by Segment"');
    const tokens = lexer.tokenize();
    expect(tokens[0].type).toBe(TokenType.BlockKeyword);
    expect(tokens[1].type).toBe(TokenType.StringLiteral);
    expect(tokens[1].value).toBe('Revenue by Segment');
  });

  it('tokenizes block field keywords', () => {
    const lexer = new Lexer('domain type description tags owner query visualization tests params assert');
    const tokens = lexer.tokenize();
    expect(tokens[0].type).toBe(TokenType.DomainKeyword);
    expect(tokens[1].type).toBe(TokenType.TypeKeyword);
    expect(tokens[2].type).toBe(TokenType.DescriptionKeyword);
    expect(tokens[3].type).toBe(TokenType.TagsKeyword);
    expect(tokens[4].type).toBe(TokenType.OwnerKeyword);
    expect(tokens[5].type).toBe(TokenType.QueryKeyword);
    expect(tokens[6].type).toBe(TokenType.VisualizationKeyword);
    expect(tokens[7].type).toBe(TokenType.TestsKeyword);
    expect(tokens[8].type).toBe(TokenType.ParamsKeyword);
    expect(tokens[9].type).toBe(TokenType.AssertKeyword);
  });

  it('tokenizes triple-quote strings', () => {
    const lexer = new Lexer('"""\nSELECT * FROM orders\nWHERE status = \'active\'\n"""');
    const tokens = lexer.tokenize();
    expect(tokens[0].type).toBe(TokenType.TripleQuoteString);
    expect(tokens[0].value).toContain('SELECT * FROM orders');
    expect(tokens[0].value).toContain("WHERE status = 'active'");
  });

  it('tokenizes > and < operators', () => {
    const lexer = new Lexer('assert row_count > 0');
    const tokens = lexer.tokenize();
    expect(tokens[0].type).toBe(TokenType.AssertKeyword);
    expect(tokens[1].type).toBe(TokenType.Identifier);
    expect(tokens[2].type).toBe(TokenType.GreaterThan);
    expect(tokens[3].type).toBe(TokenType.NumberLiteral);
  });

  it('tokenizes >= <= == != operators', () => {
    const lexer = new Lexer('assert row_count >= 1 assert row_count <= 2 assert row_count == 2 assert row_count != 0');
    const tokens = lexer.tokenize();
    expect(tokens.some((t) => t.type === TokenType.GreaterThanOrEqual)).toBe(true);
    expect(tokens.some((t) => t.type === TokenType.LessThanOrEqual)).toBe(true);
    expect(tokens.some((t) => t.type === TokenType.DoubleEquals)).toBe(true);
    expect(tokens.some((t) => t.type === TokenType.NotEquals)).toBe(true);
  });

  it('tokenizes IN keyword', () => {
    const lexer = new Lexer('IN ["a", "b"]');
    const tokens = lexer.tokenize();
    expect(tokens[0].type).toBe(TokenType.InKeyword);
    expect(tokens[1].type).toBe(TokenType.LeftBracket);
  });

  it('tokenizes var and default keywords', () => {
    const lexer = new Lexer('var("period", default="Q1")');
    const tokens = lexer.tokenize();
    expect(tokens[0].type).toBe(TokenType.VarKeyword);
    expect(tokens[1].type).toBe(TokenType.LeftParen);
  });
});

describe('Lexer.scanSQLBoundary', () => {
  it('detects comma + identifier + equals boundary', () => {
    const source = 'SELECT date, revenue FROM sales, x = date)';
    const result = Lexer.scanSQLBoundary(source, 0, 1);
    expect(result.sql).toBe('SELECT date, revenue FROM sales');
    expect(result.endOffset).toBe(31); // position of the boundary comma
  });

  it('handles subqueries with nested parens', () => {
    const source = 'SELECT (SELECT COUNT(*) FROM orders) as cnt FROM dual, x = cnt)';
    const result = Lexer.scanSQLBoundary(source, 0, 1);
    expect(result.sql).toBe('SELECT (SELECT COUNT(*) FROM orders) as cnt FROM dual');
  });

  it('handles SQL with string containing commas', () => {
    const source = "SELECT name, 'a,b,c' as val FROM t, x = name)";
    const result = Lexer.scanSQLBoundary(source, 0, 1);
    expect(result.sql).toBe("SELECT name, 'a,b,c' as val FROM t");
  });

  it('handles closing paren when no named args', () => {
    const source = 'SELECT count(*) FROM orders)';
    const result = Lexer.scanSQLBoundary(source, 0, 1);
    expect(result.sql).toBe('SELECT count(*) FROM orders');
  });

  it('does not treat SQL = as boundary (comparison)', () => {
    const source = "SELECT * FROM orders WHERE status = 'active', x = status)";
    const result = Lexer.scanSQLBoundary(source, 0, 1);
    expect(result.sql).toBe("SELECT * FROM orders WHERE status = 'active'");
  });
});
