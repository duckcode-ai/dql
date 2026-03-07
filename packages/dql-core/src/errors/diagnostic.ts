export interface SourceLocation {
  line: number;
  column: number;
  offset: number;
  file?: string;
}

export interface SourceSpan {
  start: SourceLocation;
  end: SourceLocation;
}

export enum DiagnosticSeverity {
  Error = 'error',
  Warning = 'warning',
  Info = 'info',
}

export interface Diagnostic {
  severity: DiagnosticSeverity;
  message: string;
  span: SourceSpan;
  hint?: string;
}

export function createSpan(
  startLine: number,
  startCol: number,
  startOffset: number,
  endLine: number,
  endCol: number,
  endOffset: number,
  file?: string,
): SourceSpan {
  return {
    start: { line: startLine, column: startCol, offset: startOffset, file },
    end: { line: endLine, column: endCol, offset: endOffset, file },
  };
}
