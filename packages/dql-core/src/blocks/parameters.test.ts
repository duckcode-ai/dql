import { describe, expect, it } from 'vitest';
import { NodeKind } from '../ast/nodes.js';
import { Parser } from '../parser/parser.js';
import { blockParameterDefinitions, resolveBlockParameterValues } from './parameters.js';

const SOURCE = `block "Regional leaderboard" {
  domain = "sales"
  type = "custom"
  params {
    start_date: date
    end_date: date = "2026-01-31"
    region_set: string[] = ["Central"]
    top_n: number = 10
    include_inactive: boolean = false
  }
  query = """
    SELECT * FROM leaderboard
    WHERE occurred_at >= ${'${start_date}'}
      AND occurred_at <= ${'${end_date}'}
      AND region IN (${ '${region_set}' })
    LIMIT ${'${top_n}'}
  """
}`;

describe('block parameter contract', () => {
  it('parses typed, required, optional, and array parameters', () => {
    const program = new Parser(SOURCE, 'parameters.dql').parse();
    const block = program.statements.find((statement) => statement.kind === NodeKind.BlockDecl);
    expect(block?.kind).toBe(NodeKind.BlockDecl);
    if (!block || block.kind !== NodeKind.BlockDecl) return;

    expect(block.params?.params.map((parameter) => ({
      name: parameter.name,
      type: parameter.paramType,
      required: !parameter.initializer,
    }))).toEqual([
      { name: 'start_date', type: 'date', required: true },
      { name: 'end_date', type: 'date', required: false },
      { name: 'region_set', type: 'string[]', required: false },
      { name: 'top_n', type: 'number', required: false },
      { name: 'include_inactive', type: 'boolean', required: false },
    ]);

    expect(blockParameterDefinitions(block)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'start_date', type: 'date', required: true, binding: { kind: 'sql_value' } }),
      expect.objectContaining({ name: 'region_set', type: 'string[]', default: ['Central'], binding: { kind: 'sql_value' } }),
      expect.objectContaining({ name: 'top_n', type: 'number', default: 10, binding: { kind: 'sql_value' } }),
    ]));
  });

  it('coerces runtime values and reports unresolved required values', () => {
    const block = new Parser(SOURCE, 'parameters.dql').parse().statements[0];
    if (block.kind !== NodeKind.BlockDecl) throw new Error('Expected block');
    const definitions = blockParameterDefinitions(block);

    expect(resolveBlockParameterValues(definitions, { start_date: '2026-01-01', top_n: '25', region_set: 'West, East' }))
      .toMatchObject({
        values: {
          start_date: '2026-01-01',
          end_date: '2026-01-31',
          top_n: 25,
          region_set: ['West', 'East'],
          include_inactive: false,
        },
        unresolved: [],
        errors: [],
      });
    expect(resolveBlockParameterValues(definitions)).toMatchObject({ unresolved: ['start_date'] });
    expect(resolveBlockParameterValues(definitions, { start_date: 'not-a-date' }).errors)
      .toContain('Parameter "start_date" must be date.');
  });
});
