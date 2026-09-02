import { describe, expect, it } from 'vitest';
import { NodeKind, Parser } from '@duckcodeailabs/dql-core';
import { composeAskV2RelationalProgram } from './ask-v2-relational-program.js';
import { buildAskV2TextToolContract } from './ask-v2-analyst-prompt.js';

/**
 * These guard the failure that made every analytics question on a 3,373-model
 * dbt project fail the same way: `compile_and_run_dql` demanded a DQL block the
 * model was never taught to write, so it sent SQL, the block parser refused it,
 * and the frozen plan left no route to the tier that would have worked.
 */
describe('governed relational program composition', () => {
  const parses = (program: string): boolean => {
    const parsed = new Parser(program, '<test>').parse();
    return parsed.statements.some((statement) => statement.kind === NodeKind.BlockDecl);
  };

  it('composes a DQL block the parser accepts, not raw SQL', () => {
    const result = composeAskV2RelationalProgram({
      relation: 'mart_arr',
      measures: [{ column: 'arr', aggregation: 'sum', alias: 'total_arr' }],
      dimensions: [{ column: 'crm_account_name' }],
      orderBy: { alias: 'total_arr', direction: 'desc' },
      limit: 10,
      description: 'top 10 customer accounts by net arr',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(parses(result.composed.program)).toBe(true);
    expect(result.composed.sql).toContain('SUM("arr") AS "total_arr"');
    expect(result.composed.sql).toContain('GROUP BY "crm_account_name"');
    expect(result.composed.sql).toContain('ORDER BY "total_arr" DESC');
    expect(result.composed.sql).toContain('LIMIT 10');
    expect(result.composed.outputAliases).toEqual(['crm_account_name', 'total_arr']);
  });

  it('renders each supported aggregation, including count distinct', () => {
    const result = composeAskV2RelationalProgram({
      relation: 'mart_crm_opportunity',
      measures: [
        { column: 'dim_crm_opportunity_id', aggregation: 'count_distinct', alias: 'opportunities' },
        { column: 'net_arr', aggregation: 'avg' },
      ],
      dimensions: [{ column: 'stage_name' }],
      filters: [{ column: 'is_open', operator: 'is_true' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.composed.sql).toContain('COUNT(DISTINCT "dim_crm_opportunity_id") AS "opportunities"');
    expect(result.composed.sql).toContain('AVG("net_arr") AS "net_arr"');
    expect(result.composed.sql).toContain('WHERE "is_open" = TRUE');
  });

  it('escapes a literal instead of interpolating it', () => {
    const result = composeAskV2RelationalProgram({
      relation: 'mart_arr',
      measures: [{ column: 'arr' }],
      filters: [{ column: 'segment', operator: '=', value: "O'Brien' OR 1=1 --" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.composed.sql).toContain(`"segment" = 'O''Brien'' OR 1=1 --'`);
  });

  it('refuses a filter value it cannot render as a plain literal', () => {
    const result = composeAskV2RelationalProgram({
      relation: 'mart_arr',
      measures: [{ column: 'arr' }],
      filters: [{ column: 'segment', operator: '=', value: { nested: true } }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasonCode).toBe('GOVERNED_RELATIONAL_FILTER_VALUE_REJECTED');
  });

  it('refuses an aggregation it does not implement rather than guessing one', () => {
    const result = composeAskV2RelationalProgram({
      relation: 'mart_arr',
      measures: [{ column: 'arr', aggregation: 'stddev' }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasonCode).toBe('GOVERNED_RELATIONAL_PLAN_INCOMPLETE');
    expect(result.detail).toContain('sum');
  });

  it('keeps two measures on the same column distinguishable', () => {
    const result = composeAskV2RelationalProgram({
      relation: 'mart_arr',
      measures: [
        { column: 'arr', aggregation: 'sum' },
        { column: 'arr', aggregation: 'avg' },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.composed.outputAliases).toEqual(['arr', 'arr_2']);
  });
});

describe('text tool contract', () => {
  /**
   * On every non-native transport this string is the only tool schema the
   * model ever sees, and the response schema declares `input` opaque. Publishing
   * parameter NAMES alone meant a nested argument was invisible: the analyst
   * knew `relationalPlan` existed but not that it carried measures, so it sent a
   * measure with no breakdown and the answer came back as a bare total.
   */
  it('publishes nested argument structure, types, enums, and required fields', () => {
    const contract = buildAskV2TextToolContract([{
      name: 'compile_and_run_dql',
      description: 'Choose the shape.',
      run: async () => ({}),
      inputSchema: {
        type: 'object',
        properties: {
          relationalPlan: {
            type: 'object',
            properties: {
              measures: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    aggregation: { type: 'string', enum: ['sum', 'count', 'avg'] },
                  },
                  required: ['id'],
                },
              },
              limit: { type: 'integer' },
            },
            required: ['measures'],
          },
        },
        required: [],
      },
    }], 8);
    expect(contract).toContain('measures![]{id!:str, aggregation:sum|count|avg}');
    expect(contract).toContain('limit:num');
  });
});
