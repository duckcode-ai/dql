import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  type InitializeParams,
  type InitializeResult,
  TextDocumentSyncKind,
  type Diagnostic,
  DiagnosticSeverity,
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { DataLexLanguageService, type LSDiagnostic } from './language-service.js';

export function startServer(): void {
  const connection = createConnection(ProposedFeatures.all);
  const documents = new TextDocuments(TextDocument);
  const service = new DataLexLanguageService();

  connection.onInitialize((_params: InitializeParams): InitializeResult => ({
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      diagnosticProvider: {
        interFileDependencies: false,
        workspaceDiagnostics: false,
      },
    },
  }));

  documents.onDidChangeContent((change) => {
    validateDocument(change.document);
  });

  function validateDocument(doc: TextDocument): void {
    if (!isDataLexDocument(doc.uri)) {
      connection.sendDiagnostics({ uri: doc.uri, diagnostics: [] });
      return;
    }
    const lsDiags: LSDiagnostic[] = service.diagnose(doc.getText(), doc.uri);
    const diagnostics: Diagnostic[] = lsDiags.map((d) => ({
      range: d.range,
      severity: mapSeverity(d.severity),
      message: d.message,
      source: d.source,
    }));
    connection.sendDiagnostics({ uri: doc.uri, diagnostics });
  }

  documents.listen(connection);
  connection.listen();
}

function isDataLexDocument(uri: string): boolean {
  // DataLex YAML files we want to validate. Keep loose so projects with
  // non-standard layouts still get diagnostics; the schema validator
  // tolerates documents that don't look like DataLex models cleanly.
  return /\.(model|relationship|diagram|data_type|semantic)\.ya?ml$/i.test(uri);
}

function mapSeverity(s: 1 | 2 | 3 | 4): DiagnosticSeverity {
  switch (s) {
    case 1:
      return DiagnosticSeverity.Error;
    case 2:
      return DiagnosticSeverity.Warning;
    case 3:
      return DiagnosticSeverity.Information;
    case 4:
      return DiagnosticSeverity.Hint;
  }
}
