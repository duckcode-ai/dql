import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  CompletionItem as LSPCompletionItem,
  CompletionItemKind,
  Hover,
  Diagnostic,
  DiagnosticSeverity,
  TextEdit,
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { DQLLanguageService } from './language-service.js';

export function startServer(): void {
  const connection = createConnection(ProposedFeatures.all);
  const documents = new TextDocuments(TextDocument);
  const service = new DQLLanguageService();

  connection.onInitialize((_params: InitializeParams): InitializeResult => {
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        completionProvider: {
          resolveProvider: false,
          triggerCharacters: ['.', '@', ',', '('],
        },
        hoverProvider: true,
        documentFormattingProvider: true,
        diagnosticProvider: {
          interFileDependencies: false,
          workspaceDiagnostics: false,
        },
      },
    };
  });

  // Validate on open and change
  documents.onDidChangeContent((change) => {
    validateDocument(change.document);
  });

  function validateDocument(doc: TextDocument): void {
    const source = doc.getText();
    const lsDiags = service.validate(source, doc.uri);

    const diagnostics: Diagnostic[] = lsDiags.map((d) => ({
      range: d.range,
      severity: mapSeverity(d.severity),
      message: d.message,
      source: d.source,
    }));

    connection.sendDiagnostics({ uri: doc.uri, diagnostics });
  }

  function mapSeverity(s: 1 | 2 | 3 | 4): DiagnosticSeverity {
    switch (s) {
      case 1: return DiagnosticSeverity.Error;
      case 2: return DiagnosticSeverity.Warning;
      case 3: return DiagnosticSeverity.Information;
      case 4: return DiagnosticSeverity.Hint;
    }
  }

  // Completions
  connection.onCompletion((params): LSPCompletionItem[] => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];

    const source = doc.getText();
    const items = service.getCompletions(source, params.position.line, params.position.character);

    return items.map((item) => ({
      label: item.label,
      kind: mapCompletionKind(item.kind),
      detail: item.detail,
      insertText: item.insertText,
    }));
  });

  function mapCompletionKind(kind: number): CompletionItemKind {
    switch (kind) {
      case 3: return CompletionItemKind.Function;
      case 5: return CompletionItemKind.Field;
      case 14: return CompletionItemKind.Keyword;
      default: return CompletionItemKind.Text;
    }
  }

  // Hover
  connection.onHover((params): Hover | null => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;

    const source = doc.getText();
    const result = service.getHover(source, params.position.line, params.position.character);

    if (!result) return null;

    return {
      contents: { kind: 'markdown', value: result.contents },
    };
  });

  connection.onDocumentFormatting((params): TextEdit[] => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];

    const source = doc.getText();
    const formatted = service.format(source);
    if (formatted === source) return [];

    const lastLine = doc.lineCount > 0 ? doc.lineCount - 1 : 0;
    const rawLines = doc.getText().split(/\r?\n/);
    const lastText = rawLines[rawLines.length - 1] ?? '';

    return [{
      range: {
        start: { line: 0, character: 0 },
        end: { line: lastLine, character: lastText.length },
      },
      newText: formatted,
    }];
  });

  documents.listen(connection);
  connection.listen();
}
