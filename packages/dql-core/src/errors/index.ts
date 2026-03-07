export {
  type SourceLocation,
  type SourceSpan,
  DiagnosticSeverity,
  type Diagnostic,
  createSpan,
} from './diagnostic.js';

export {
  DiagnosticReporter,
  formatDiagnostic,
  DQLSyntaxError,
  DQLSemanticError,
} from './reporter.js';
