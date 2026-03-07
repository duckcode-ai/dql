import type { SourceLocation, SourceSpan } from '../errors/diagnostic.js';
import { TokenType, type Token, lookupKeyword } from './token.js';

export class Lexer {
  private source: string;
  private pos: number = 0;
  private line: number = 1;
  private column: number = 1;
  private file: string | undefined;

  constructor(source: string, file?: string) {
    this.source = source;
    this.file = file;
  }

  tokenize(): Token[] {
    const tokens: Token[] = [];
    while (!this.isAtEnd()) {
      this.skipWhitespace();
      if (this.isAtEnd()) break;
      const token = this.nextToken();
      if (token.type !== TokenType.Comment) {
        tokens.push(token);
      }
    }
    tokens.push(this.makeToken(TokenType.EOF, '', this.location()));
    return tokens;
  }

  nextToken(): Token {
    this.skipWhitespace();

    if (this.isAtEnd()) {
      return this.makeToken(TokenType.EOF, '', this.location());
    }

    const start = this.location();
    const ch = this.peek();

    // Single-line comment
    if (ch === '/' && this.peekNext() === '/') {
      return this.readComment(start);
    }

    // Triple-quote string literal
    if (ch === '"' && this.peekNext() === '"' && this.source[this.pos + 2] === '"') {
      return this.readTripleQuoteString(start);
    }

    // String literal
    if (ch === '"' || ch === "'") {
      return this.readString(ch, start);
    }

    // Number literal
    if (this.isDigit(ch) || (ch === '-' && this.isDigit(this.peekNext() ?? ''))) {
      return this.readNumber(start);
    }

    // Identifier or keyword
    if (this.isAlpha(ch) || ch === '_') {
      return this.readIdentifierOrKeyword(start);
    }

    // Multi-character operators
    if (ch === '>' && this.peekNext() === '=') {
      this.advance();
      this.advance();
      return this.makeToken(TokenType.GreaterThanOrEqual, '>=', start);
    }
    if (ch === '<' && this.peekNext() === '=') {
      this.advance();
      this.advance();
      return this.makeToken(TokenType.LessThanOrEqual, '<=', start);
    }
    if (ch === '=' && this.peekNext() === '=') {
      this.advance();
      this.advance();
      return this.makeToken(TokenType.DoubleEquals, '==', start);
    }
    if (ch === '!' && this.peekNext() === '=') {
      this.advance();
      this.advance();
      return this.makeToken(TokenType.NotEquals, '!=', start);
    }

    // Punctuation
    return this.readPunctuation(start);
  }

  /**
   * Scan SQL fragment from current position.
   * Called by the parser when it expects embedded SQL.
   * Scans until it finds: comma + identifier + equals at paren depth 0,
   * or a closing paren at depth 0.
   *
   * @param tokens - The token array to scan through
   * @param startIndex - Index in tokens where SQL starts
   * @returns { sql: string, endIndex: number } - The SQL text and the index after it
   */
  static scanSQLBoundary(
    source: string,
    startOffset: number,
    openParenDepth: number,
  ): { sql: string; endOffset: number } {
    let pos = startOffset;
    let parenDepth = openParenDepth;
    const len = source.length;

    while (pos < len) {
      const ch = source[pos];

      // Track string literals (skip their contents)
      if (ch === "'" || ch === '"') {
        pos = Lexer.skipStringInSQL(source, pos);
        continue;
      }

      // Track parentheses
      if (ch === '(') {
        parenDepth++;
        pos++;
        continue;
      }

      if (ch === ')') {
        if (parenDepth === 1) {
          // Closing paren of the chart call - SQL ends here
          const sql = source.substring(startOffset, pos).trim();
          return { sql, endOffset: pos };
        }
        parenDepth--;
        pos++;
        continue;
      }

      // Check for comma + identifier + equals pattern (boundary marker)
      if (ch === ',' && parenDepth === 1) {
        // Look ahead past whitespace for identifier = pattern
        let lookAhead = pos + 1;
        while (lookAhead < len && /\s/.test(source[lookAhead])) lookAhead++;

        // Check if we have an identifier
        if (lookAhead < len && /[a-zA-Z_]/.test(source[lookAhead])) {
          let identEnd = lookAhead;
          while (identEnd < len && /[a-zA-Z0-9_]/.test(source[identEnd])) identEnd++;

          // Check if followed by =
          let afterIdent = identEnd;
          while (afterIdent < len && /\s/.test(source[afterIdent])) afterIdent++;

          if (afterIdent < len && source[afterIdent] === '=') {
            // Check it's not == (comparison operator)
            if (afterIdent + 1 >= len || source[afterIdent + 1] !== '=') {
              // This is the boundary: SQL ends before this comma
              const sql = source.substring(startOffset, pos).trim();
              return { sql, endOffset: pos };
            }
          }
        }
      }

      pos++;
    }

    // Reached end without finding boundary
    const sql = source.substring(startOffset, pos).trim();
    return { sql, endOffset: pos };
  }

  private static skipStringInSQL(source: string, pos: number): number {
    const quote = source[pos];
    pos++; // skip opening quote
    while (pos < source.length) {
      if (source[pos] === '\\') {
        pos += 2; // skip escape
        continue;
      }
      if (source[pos] === quote) {
        pos++; // skip closing quote
        return pos;
      }
      pos++;
    }
    return pos;
  }

  private readComment(start: SourceLocation): Token {
    let value = '';
    while (!this.isAtEnd() && this.peek() !== '\n') {
      value += this.advance();
    }
    return this.makeToken(TokenType.Comment, value, start);
  }

  private readString(quote: string, start: SourceLocation): Token {
    this.advance(); // skip opening quote
    let value = '';
    while (!this.isAtEnd() && this.peek() !== quote) {
      if (this.peek() === '\\') {
        this.advance(); // skip backslash
        const escaped = this.advance();
        switch (escaped) {
          case 'n':
            value += '\n';
            break;
          case 't':
            value += '\t';
            break;
          case '\\':
            value += '\\';
            break;
          case "'":
            value += "'";
            break;
          case '"':
            value += '"';
            break;
          default:
            value += escaped;
        }
      } else {
        value += this.advance();
      }
    }
    if (!this.isAtEnd()) {
      this.advance(); // skip closing quote
    }
    return this.makeToken(TokenType.StringLiteral, value, start);
  }

  private readNumber(start: SourceLocation): Token {
    let value = '';
    if (this.peek() === '-') {
      value += this.advance();
    }
    while (!this.isAtEnd() && this.isDigit(this.peek())) {
      value += this.advance();
    }
    if (!this.isAtEnd() && this.peek() === '.' && this.isDigit(this.peekNext() ?? '')) {
      value += this.advance(); // dot
      while (!this.isAtEnd() && this.isDigit(this.peek())) {
        value += this.advance();
      }
    }
    return this.makeToken(TokenType.NumberLiteral, value, start);
  }

  private readIdentifierOrKeyword(start: SourceLocation): Token {
    let value = '';
    while (!this.isAtEnd() && (this.isAlphaNumeric(this.peek()) || this.peek() === '_')) {
      value += this.advance();
    }
    const type = lookupKeyword(value);
    return this.makeToken(type, value, start);
  }

  private readPunctuation(start: SourceLocation): Token {
    const ch = this.advance();
    switch (ch) {
      case '(':
        return this.makeToken(TokenType.LeftParen, ch, start);
      case ')':
        return this.makeToken(TokenType.RightParen, ch, start);
      case '{':
        return this.makeToken(TokenType.LeftBrace, ch, start);
      case '}':
        return this.makeToken(TokenType.RightBrace, ch, start);
      case '[':
        return this.makeToken(TokenType.LeftBracket, ch, start);
      case ']':
        return this.makeToken(TokenType.RightBracket, ch, start);
      case ',':
        return this.makeToken(TokenType.Comma, ch, start);
      case '.':
        return this.makeToken(TokenType.Dot, ch, start);
      case '=':
        return this.makeToken(TokenType.Equals, ch, start);
      case '+':
        return this.makeToken(TokenType.Plus, ch, start);
      case '-':
        return this.makeToken(TokenType.Minus, ch, start);
      case '*':
        return this.makeToken(TokenType.Star, ch, start);
      case '@':
        return this.makeToken(TokenType.AtSign, ch, start);
      case ':':
        return this.makeToken(TokenType.ColonToken, ch, start);
      case '>':
        return this.makeToken(TokenType.GreaterThan, ch, start);
      case '<':
        return this.makeToken(TokenType.LessThan, ch, start);
      default:
        return this.makeToken(TokenType.Identifier, ch, start);
    }
  }

  private skipWhitespace(): void {
    while (!this.isAtEnd()) {
      const ch = this.peek();
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
        this.advance();
      } else {
        break;
      }
    }
  }

  private peek(): string {
    return this.source[this.pos];
  }

  private peekNext(): string | undefined {
    return this.source[this.pos + 1];
  }

  private advance(): string {
    const ch = this.source[this.pos];
    this.pos++;
    if (ch === '\n') {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
    return ch;
  }

  private isAtEnd(): boolean {
    return this.pos >= this.source.length;
  }

  private isDigit(ch: string): boolean {
    return ch >= '0' && ch <= '9';
  }

  private isAlpha(ch: string): boolean {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
  }

  private isAlphaNumeric(ch: string): boolean {
    return this.isAlpha(ch) || this.isDigit(ch);
  }

  private readTripleQuoteString(start: SourceLocation): Token {
    // Skip opening """
    this.advance(); // "
    this.advance(); // "
    this.advance(); // "

    // Skip optional leading newline
    if (!this.isAtEnd() && this.peek() === '\n') {
      this.advance();
    }

    let value = '';
    while (!this.isAtEnd()) {
      if (
        this.peek() === '"' &&
        this.peekNext() === '"' &&
        this.source[this.pos + 2] === '"'
      ) {
        // Skip closing """
        this.advance();
        this.advance();
        this.advance();
        // Trim trailing whitespace/newline from value
        value = value.replace(/\n\s*$/, '');
        return this.makeToken(TokenType.TripleQuoteString, value, start);
      }
      value += this.advance();
    }

    // Unterminated triple-quote string
    return this.makeToken(TokenType.TripleQuoteString, value, start);
  }

  private location(): SourceLocation {
    return { line: this.line, column: this.column, offset: this.pos, file: this.file };
  }

  private makeToken(type: TokenType, value: string, start: SourceLocation): Token {
    return {
      type,
      value,
      span: { start, end: this.location() },
    };
  }
}
