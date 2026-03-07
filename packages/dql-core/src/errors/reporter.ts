import { Diagnostic, DiagnosticSeverity } from './diagnostic.js';

export class DiagnosticReporter {
  private diagnostics: Diagnostic[] = [];

  report(diagnostic: Diagnostic): void {
    this.diagnostics.push(diagnostic);
  }

  error(message: string, span: Diagnostic['span'], hint?: string): void {
    this.report({ severity: DiagnosticSeverity.Error, message, span, hint });
  }

  warning(message: string, span: Diagnostic['span'], hint?: string): void {
    this.report({ severity: DiagnosticSeverity.Warning, message, span, hint });
  }

  hasErrors(): boolean {
    return this.diagnostics.some((d) => d.severity === DiagnosticSeverity.Error);
  }

  getErrors(): Diagnostic[] {
    return this.diagnostics.filter((d) => d.severity === DiagnosticSeverity.Error);
  }

  getAll(): Diagnostic[] {
    return [...this.diagnostics];
  }

  clear(): void {
    this.diagnostics = [];
  }

  format(source: string): string {
    return this.diagnostics.map((d) => formatDiagnostic(d, source)).join('\n\n');
  }
}

export function formatDiagnostic(diagnostic: Diagnostic, source: string): string {
  const { severity, message, span, hint } = diagnostic;
  const lines = source.split('\n');
  const lineText = lines[span.start.line - 1] ?? '';
  const lineNum = String(span.start.line);
  const padding = ' '.repeat(lineNum.length);
  const file = span.start.file ? `${span.start.file}:` : '';

  let output = `${severity}: ${message}\n`;
  output += `  --> ${file}${span.start.line}:${span.start.column}\n`;
  output += `${padding} |\n`;
  output += `${lineNum} | ${lineText}\n`;

  const underlineStart = span.start.column - 1;
  const underlineLen = Math.max(
    1,
    span.start.line === span.end.line ? span.end.column - span.start.column : lineText.length - underlineStart,
  );
  output += `${padding} | ${' '.repeat(underlineStart)}${'^'.repeat(underlineLen)}`;

  if (hint) {
    output += `\n${padding} = hint: ${hint}`;
  }

  return output;
}

export class DQLSyntaxError extends Error {
  constructor(
    message: string,
    public readonly diagnostics: Diagnostic[],
  ) {
    super(message);
    this.name = 'DQLSyntaxError';
  }
}

export class DQLSemanticError extends Error {
  constructor(
    message: string,
    public readonly diagnostics: Diagnostic[],
  ) {
    super(message);
    this.name = 'DQLSemanticError';
  }
}
