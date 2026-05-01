import { describe, it, expect } from 'vitest';

import { DataLexLanguageService } from './language-service.js';

describe('DataLexLanguageService — v0.1 diagnose', () => {
  const service = new DataLexLanguageService();

  it('returns no diagnostics for a valid starter model', () => {
    const source = `model:
  name: commerce
  version: 1.0.0
  domain: commerce
  owners:
    - data@example.com
  state: draft

entities:
  - name: Customer
    type: table
    fields:
      - name: customer_id
        type: integer
        primary_key: true
        nullable: false
`;
    expect(service.diagnose(source, 'file:///tmp/commerce.model.yaml')).toEqual([]);
  });

  it('emits a YAML parse error with mark line + column', () => {
    const source = 'model:\n  name: : : : :\n';
    const diags = service.diagnose(source, 'file:///tmp/bad.model.yaml');
    expect(diags.length).toBeGreaterThan(0);
    expect(diags[0].message).toContain('YAML parse error');
  });

  it('flags a missing required field with a schema diagnostic', () => {
    const source = `model:
  name: commerce
  version: 1.0.0
  domain: commerce
  state: draft

entities:
  - name: Customer
    type: table
`;
    const diags = service.diagnose(source, 'file:///tmp/no-owners.model.yaml');
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.some((d) => d.message.includes('owners'))).toBe(true);
  });

  it('flags a name that violates the snake_case pattern', () => {
    const source = `model:
  name: BadName
  version: 1.0.0
  domain: commerce
  owners:
    - data@example.com
  state: draft

entities:
  - name: Customer
    type: table
`;
    const diags = service.diagnose(source, 'file:///tmp/bad-name.model.yaml');
    expect(diags.some((d) => d.message.includes('pattern') || d.message.includes('match'))).toBe(true);
  });

  it('returns no diagnostics on an empty document', () => {
    expect(service.diagnose('', 'file:///tmp/empty.model.yaml')).toEqual([]);
  });

  it('emits a diagnostic when the document root is not an object', () => {
    const diags = service.diagnose('"a string"\n', 'file:///tmp/string-root.model.yaml');
    expect(diags.length).toBeGreaterThan(0);
    expect(diags[0].message).toMatch(/root must be an object/);
  });
});
