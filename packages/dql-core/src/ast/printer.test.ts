import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from '../parser/parser.js';
import type { BlockDeclNode } from './nodes.js';
import { formatDQL } from '../formatter/formatter.js';
import { printAST } from './printer.js';

const fixture = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../apps/cli/test/fixtures/app-datasets-pilot/domains/commerce/blocks/order-lines-dataset.dql',
);

function datasetSections(source: string) {
  const block = parse(source).statements.find((statement) => statement.kind === 'BlockDecl') as BlockDeclNode | undefined;
  return { grain: block?.datasetGrain, fields: block?.datasetFields, measures: block?.datasetMeasures };
}

describe('dataset block printing', () => {
  it('formats dataset grain, fields, and measures back into DQL that parses to the same contract', () => {
    const source = readFileSync(fixture, 'utf-8');
    const original = datasetSections(source);
    expect(original.fields?.length).toBeGreaterThan(0);
    expect(original.measures?.length).toBeGreaterThan(0);

    const reparsed = datasetSections(formatDQL(source));
    expect(reparsed.grain).toEqual(original.grain);
    expect(reparsed.fields).toEqual(expect.arrayContaining(original.fields!.map((field) => expect.objectContaining({ name: field.name, role: field.role, type: field.type }))));
    expect(reparsed.measures).toEqual(expect.arrayContaining(original.measures!.map((measure) => expect.objectContaining({ name: measure.name, aggregation: measure.aggregation, additive: measure.additive }))));
  });

  it('shows the same dataset sections in the AST debug tree as the formatter writes', () => {
    const printed = printAST(parse(readFileSync(fixture, 'utf-8')));
    expect(printed).toContain('fields {');
    expect(printed).toContain('revenue { agg = "sum", from = "net_amount", additive = "additive"');
    expect(printed).toContain('keys = ["order_line_id"]');
  });
});
