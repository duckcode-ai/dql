import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
// The DataLex model schema is JSON-Schema 2020-12. Use Ajv's 2020 entry
// point so $defs and other Draft 2020-12 idioms validate correctly.
import ajv2020Pkg from 'ajv/dist/2020.js';
type ErrorObject = import('ajv').ErrorObject;
const Ajv = (ajv2020Pkg as unknown as { default?: typeof import('ajv/dist/2020.js').default }).default
  ?? (ajv2020Pkg as unknown as typeof import('ajv/dist/2020.js').default);

export interface LSDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity: 1 | 2 | 3 | 4; // Error, Warning, Information, Hint
  message: string;
  source: string;
}

const SCHEMA_FILENAME = 'datalex-model.schema.json';

const __dirname_lsp = dirname(fileURLToPath(import.meta.url));

function loadBundledSchema(): Record<string, unknown> {
  // Try the dist-bundled schema first (production), fall back to src (dev).
  for (const path of [join(__dirname_lsp, SCHEMA_FILENAME), join(__dirname_lsp, '..', 'src', SCHEMA_FILENAME)]) {
    try {
      const raw = readFileSync(path, 'utf-8');
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // try next
    }
  }
  return {};
}

type AjvInstance = InstanceType<typeof Ajv>;

export class DataLexLanguageService {
  private readonly ajv: AjvInstance;
  private readonly validate: ReturnType<AjvInstance['compile']>;

  constructor() {
    this.ajv = new Ajv({ allErrors: true, strict: false });
    const schema = loadBundledSchema();
    this.validate = this.ajv.compile(schema);
  }

  /**
   * Validate a DataLex `*.model.yaml` document. Returns an empty array when
   * the document parses cleanly and matches the schema.
   */
  diagnose(source: string, _uri: string): LSDiagnostic[] {
    if (!source.trim()) return [];
    const out: LSDiagnostic[] = [];

    let parsed: unknown;
    try {
      parsed = yaml.load(source);
    } catch (err) {
      const yamlErr = err as { mark?: { line: number; column: number }; message?: string };
      const line = yamlErr.mark?.line ?? 0;
      const column = yamlErr.mark?.column ?? 0;
      out.push({
        range: zeroLengthRange(line, column),
        severity: 1,
        message: `YAML parse error: ${yamlErr.message ?? String(err)}`,
        source: 'datalex',
      });
      return out;
    }

    if (parsed === null || parsed === undefined) {
      return out;
    }
    if (typeof parsed !== 'object') {
      out.push({
        range: zeroLengthRange(0, 0),
        severity: 1,
        message: `Document root must be an object; got ${typeof parsed}.`,
        source: 'datalex',
      });
      return out;
    }

    const valid = this.validate(parsed);
    if (valid) return out;
    const errors = (this.validate.errors ?? []) as ErrorObject[];
    for (const err of errors) {
      const path = err.instancePath || '/';
      const lastSegment = path.split('/').pop() ?? '';
      const line = bestEffortLine(source, lastSegment);
      out.push({
        range: zeroLengthRange(line, 0),
        severity: 1,
        message: `${path === '/' ? 'document' : path}: ${err.message ?? 'schema violation'}${
          err.params && Object.keys(err.params).length > 0
            ? ` (${JSON.stringify(err.params)})`
            : ''
        }`,
        source: 'datalex',
      });
    }
    return out;
  }
}

function zeroLengthRange(line: number, character: number) {
  return {
    start: { line: Math.max(0, line), character: Math.max(0, character) },
    end: { line: Math.max(0, line), character: Math.max(0, character) },
  };
}

/**
 * Find the first source line that mentions the path-tail token. Best-effort:
 * a perfect column-accurate locator wants a YAML CST parser; this gets us
 * "the line containing `customer_id`" which is enough for v0.1 to be
 * useful in editor red-squiggle UX.
 */
function bestEffortLine(source: string, token: string): number {
  if (!token) return 0;
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(token)) return i;
  }
  return 0;
}
