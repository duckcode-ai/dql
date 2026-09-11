import { describe, expect, it } from 'vitest';
import { parseIntent, type AnalyticalIntentV1 } from './intent.js';
import { executeCandidate, executeSemanticProgram } from './execute.js';
import { bindSemanticExecutionProgram, bindSemanticRequest, prepareSemantic } from './prepare/semantic.js';
import type { PreparedCandidate, SemanticExecutionProgram } from './prepare/types.js';
import { normalizeEffectiveIntent } from './resolve-intent.js';
import { buildVocabularyIndex, type VocabularySource } from './vocabulary.js';
import { runAskPipeline } from './pipeline.js';
import { mergeDiscoveredRelations } from './pipeline.js';
import type { AgentProvider } from '../providers/types.js';

const source: VocabularySource = {
  metrics: [
    { name: 'total_bcm', model: 'consumption', sourceId: 'total_bcm', aggregation: 'sum', aggTimeDimension: 'report_as_of_dt' },
    // This represents an authored MetricFlow offset. It is intentionally not
    // decomposed into generated SQL by Ask.
    { name: 'previous_year_bcm', model: 'consumption', sourceId: 'previous_year_bcm', type: 'derived', engineOnly: 'a prior-period offset on total_bcm', aggTimeDimension: 'report_as_of_dt' },
  ],
  dimensions: [{ name: 'report_as_of_dt', model: 'consumption', sourceId: 'consumption.report_as_of_dt', dataType: 'date', isTime: true }],
};
const vocabulary = buildVocabularyIndex(source);

function intent(raw: Record<string, unknown>): AnalyticalIntentV1 {
  const parsed = parseIntent({
    version: 1, kind: 'analytics', reading: 'comparison', measures: [], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar', ...raw,
  });
  if (!parsed.intent) throw new Error(parsed.errors.map((error) => error.message).join('; '));
  return parsed.intent;
}

const year = { ref: 'dimension:consumption.report_as_of_dt', op: 'gte' as const, values: ['2026-01-01'], source: 'question' as const };
const yearEnd = { ref: 'dimension:consumption.report_as_of_dt', op: 'lt' as const, values: ['2027-01-01'], source: 'question' as const };

describe('manifest-only semantic comparison reliability', () => {
  it('recovers a partial exact relation by full physical name without restoring a cross-database alias', () => {
    const relation = (database: string, columns: string[], complete = false) => ({
      database, schema: 'PUBLIC', name: 'EVENTS', columnCompleteness: complete ? 'complete' as const : 'partial' as const,
      binding: {
        version: 1 as const, logicalId: 'relation:PUBLIC.EVENTS', logicalRelation: 'PUBLIC.EVENTS',
        database: { value: database }, schema: { value: 'PUBLIC' }, table: { value: 'EVENTS' },
        source: 'warehouse_probe' as const, columns: columns.map((name) => ({ name, type: 'NUMBER' })), columnCompleteness: complete ? 'complete' as const : 'partial' as const,
      },
      columns: columns.map((name) => ({ name, dataType: 'NUMBER' })),
    });
    const base = buildVocabularyIndex({ relations: [relation('DB_A', ['A_OLD']), relation('DB_B', ['B_ONLY'])] });
    const merged = mergeDiscoveredRelations(base, [relation('DB_A', ['A_OLD', 'A_NEW'], true)]);
    const dbA = merged.entries.find((entry) => entry.kind === 'relation' && entry.physical?.binding?.database?.value === 'DB_A');
    const dbB = merged.entries.find((entry) => entry.kind === 'relation' && entry.physical?.binding?.database?.value === 'DB_B');
    expect(dbA?.model).toBe('DB_A.PUBLIC.EVENTS');
    expect(dbA?.columns).toEqual(expect.arrayContaining(['A_OLD', 'A_NEW']));
    expect(dbA?.physical?.binding?.columnCompleteness).toBe('complete');
    expect(dbB?.columns).toEqual(['B_ONLY']);
    expect(merged.resolve('PUBLIC.EVENTS')).toBeUndefined();
  });

  it('lifts a common period through a calculated output and preserves the authored offset metric', () => {
    const reading = intent({
      measures: [
        { ref: 'metric:consumption.total_bcm', alias: 'current_bcm', scope: [year, yearEnd] },
        { ref: 'metric:consumption.previous_year_bcm', alias: 'previous_bcm', scope: [year, yearEnd] },
        { ref: 'change:current_bcm/previous_bcm', alias: 'yoy_growth', change: { base: 'current_bcm', comparison: 'previous_bcm', as: 'percent' } },
      ],
    });

    normalizeEffectiveIntent(reading);

    expect(reading.filters).toEqual([year, yearEnd]);
    expect(reading.measures[0]?.scope).toBeUndefined();
    expect(reading.measures[1]?.scope).toBeUndefined();
    const bound = bindSemanticRequest(reading, vocabulary, 'metricflow-cli');
    expect(bound.request).toMatchObject({
      metrics: ['total_bcm', 'previous_year_bcm'],
      filters: [
        { dimension: 'metric_time', operator: 'gte', values: ['2026-01-01'] },
        { dimension: 'metric_time', operator: 'lt', values: ['2027-01-01'] },
      ],
    });
    expect(bound.changes).toEqual([{ alias: 'yoy_growth', base: 'total_bcm', comparison: 'previous_year_bcm', as: 'percent' }]);
  });

  it('keeps genuinely different periods in two semantic branches and invokes the adapter program compiler', async () => {
    const reading = intent({
      measures: [
        { ref: 'metric:consumption.total_bcm', alias: 'current_bcm', scope: [{ ...year, values: ['2026-09-01'] }, { ...yearEnd, values: ['2026-10-01'] }] },
        { ref: 'metric:consumption.total_bcm', alias: 'previous_bcm', scope: [{ ...year, values: ['2026-08-01'] }, { ...yearEnd, values: ['2026-09-01'] }] },
        { ref: 'change:current_bcm/previous_bcm', alias: 'mom_growth', change: { base: 'current_bcm', comparison: 'previous_bcm', as: 'percent' } },
      ],
    });
    normalizeEffectiveIntent(reading);
    expect(reading.filters).toEqual([]);

    const program = bindSemanticExecutionProgram(reading, vocabulary, 'metricflow-cli')?.program;
    expect(program).toMatchObject({ version: 1, shape: 'scalar' });
    expect(program?.branches).toHaveLength(2);
    expect(program?.branches.map((branch) => branch.request.filters?.map((filter) => filter.values[0]))).toEqual([
      ['2026-09-01', '2026-10-01'], ['2026-08-01', '2026-09-01'],
    ]);

    let compiled = 0;
    const prepared = await prepareSemantic(reading, vocabulary, {
      engine: 'metricflow-cli',
      compileSemantic: async () => ({ sql: 'unused', engine: 'metricflow-cli' }),
      compileSemanticProgram: async (input) => {
        compiled += 1;
        return {
          sql: '/* semantic period program */', engine: 'metricflow-cli',
          program: {
            ...input,
            branches: input.branches.map((branch, index) => ({ ...branch, sql: `SELECT ${index + 1} AS ${branch.outputs[0]!.source}`, engine: 'metricflow-cli' })),
          },
        };
      },
    });
    expect(compiled).toBe(1);
    expect(prepared.candidates[0]?.semanticProgram?.branches.map((branch) => branch.sql)).toEqual(['SELECT 1 AS total_bcm', 'SELECT 2 AS total_bcm']);
  });

  it('removes branch-local ranking before aligning a calculated comparison, then ranks the complete aligned population', async () => {
    const ranked = intent({
      expectedShape: 'ranking', limit: 1, ordering: { ref: 'measure:2', direction: 'desc' },
      groupBy: [{ ref: 'dimension:consumption.report_as_of_dt', role: 'categorical' }],
      measures: [
        { ref: 'metric:consumption.total_bcm', alias: 'current', scope: [{ ...year, values: ['2026-09-01'] }] },
        { ref: 'metric:consumption.total_bcm', alias: 'prior', scope: [{ ...year, values: ['2026-08-01'] }] },
        { ref: 'change:prior/current', alias: 'growth', change: { base: 'prior', comparison: 'current', as: 'absolute' } },
      ],
    });
    const boundProgram = bindSemanticExecutionProgram(ranked, vocabulary, 'metricflow-cli')!.program!;
    // Execution only accepts adapter-compiled branches.  Keep that boundary in
    // this regression: the fake adapter supplies distinct SQL for both period
    // branches, while the assertions below exercise post-alignment ranking.
    const program: SemanticExecutionProgram = {
      ...boundProgram,
      branches: boundProgram.branches.map((branch, index) => ({
        ...branch,
        sql: index === 0 ? 'current-period' : 'prior-period',
        engine: 'metricflow-cli',
      })),
    };
    expect(program.branches.every((branch) => branch.request.limit === undefined && branch.request.orderBy === undefined)).toBe(true);
    expect(program.postProcess).toMatchObject({ orderBy: { column: 'growth', direction: 'desc' }, limit: 1, requireCompletePopulation: true });
    const candidate: PreparedCandidate = {
      tier: 'semantic', trust: 'governed', sql: 'program', proof: [], semanticProgram: program,
      changes: [{ alias: 'growth', base: 'prior', comparison: 'current', as: 'absolute' }],
    };
    const outcome = await executeCandidate(candidate, ranked, {
      maxRows: 20,
      run: async (sql) => ({
        columns: ['customer', 'total_bcm'],
        rows: sql === 'current-period'
          ? [{ customer: 'A', total_bcm: 100 }, { customer: 'B', total_bcm: 90 }]
          : [{ customer: 'A', total_bcm: 1 }, { customer: 'C', total_bcm: 100 }],
        rowCount: 2, executionTimeMs: 1,
      }),
    });
    expect(outcome).toMatchObject({ ok: true, result: { rows: [{ customer: 'A', current: 100, prior: 1, growth: 99 }] } });
  });

  it('keeps high precision Snowflake decimals exact and preserves null/zero comparison behavior', async () => {
    const program: SemanticExecutionProgram = {
      version: 1, shape: 'scalar',
      branches: [
        { id: 'prior', request: { metrics: ['total_bcm'], dimensions: [] }, outputs: [{ source: 'total_bcm', as: 'prior' }], sql: 'prior', engine: 'metricflow-cli' },
        { id: 'current', request: { metrics: ['total_bcm'], dimensions: [] }, outputs: [{ source: 'total_bcm', as: 'current' }], sql: 'current', engine: 'metricflow-cli' },
      ],
    };
    const candidate: PreparedCandidate = {
      tier: 'semantic', trust: 'governed', sql: 'program', proof: [], semanticProgram: program,
      changes: [{ alias: 'delta', base: 'prior', comparison: 'current', as: 'absolute' }, { alias: 'pct', base: 'prior', comparison: 'current', as: 'percent' }],
    };
    const result = await executeCandidate(candidate, intent({ measures: [{ ref: 'metric:consumption.total_bcm' }] }), {
      run: async (sql) => ({ columns: ['total_bcm'], rows: [{ total_bcm: sql === 'prior' ? '9007199254740992' : '9007199254740993' }], rowCount: 1, executionTimeMs: 1 }),
    });
    expect(result).toMatchObject({ ok: true, result: { rows: [{ prior: '9007199254740992', current: '9007199254740993', delta: 1 }] } });
    // The exact post-arithmetic path must retain the tiny, non-zero change;
    // lowering the two large values through IEEE-754 used to turn this into 0.
    if (result.ok) expect(result.result.rows[0]?.pct).toBe(1.11e-16);
  });

  it('does not silently apply a scope placed on a calculated comparison', () => {
    const reading = intent({
      measures: [
        { ref: 'metric:consumption.total_bcm', alias: 'current_bcm', scope: [{ ...year, values: ['2026-09-01'] }] },
        { ref: 'metric:consumption.total_bcm', alias: 'previous_bcm', scope: [{ ...year, values: ['2026-08-01'] }] },
        { ref: 'change:current_bcm/previous_bcm', alias: 'mom_growth', scope: [yearEnd], change: { base: 'current_bcm', comparison: 'previous_bcm', as: 'percent' } },
      ],
    });
    expect(bindSemanticExecutionProgram(reading, vocabulary, 'metricflow-cli')?.refusal).toMatchObject({ code: 'measure_scope_not_expressible' });
  });

  it('aligns branch values, applies a percent change after semantic execution, and retains null on a zero denominator', async () => {
    const program: SemanticExecutionProgram = {
      version: 1,
      shape: 'scalar',
      branches: [
        { id: 'current', request: { metrics: ['total_bcm'], dimensions: [] }, outputs: [{ source: 'total_bcm', as: 'current_bcm' }], sql: 'current', engine: 'metricflow-cli' },
        { id: 'prior', request: { metrics: ['total_bcm'], dimensions: [] }, outputs: [{ source: 'total_bcm', as: 'previous_bcm' }], sql: 'prior', engine: 'metricflow-cli' },
      ],
    };
    const candidate: PreparedCandidate = {
      tier: 'semantic', trust: 'governed', sql: '/* semantic period program */', proof: [], semanticProgram: program,
      changes: [{ alias: 'mom_growth', base: 'previous_bcm', comparison: 'current_bcm', as: 'percent' }],
    };
    const reading = intent({ measures: [{ ref: 'metric:consumption.total_bcm' }] });
    const first = await executeCandidate(candidate, reading, {
      run: async (sql) => ({
        columns: ['total_bcm'],
        rows: [{ total_bcm: sql === 'current' ? 120 : 100 }],
        rowCount: 1,
        executionTimeMs: 3,
      }),
    });
    expect(first).toMatchObject({ ok: true, result: { rows: [{ current_bcm: 120, previous_bcm: 100, mom_growth: 0.2 }] } });

    const zero = await executeSemanticProgram({
      ...program,
      branches: program.branches.map((branch) => ({ ...branch, sql: branch.id })),
    }, {
      run: async (sql) => ({ columns: ['total_bcm'], rows: [{ total_bcm: sql === 'current' ? 120 : 0 }], rowCount: 1, executionTimeMs: 1 }),
    }, candidate);
    expect((await executeCandidate({ ...candidate, semanticProgram: { ...program, branches: program.branches.map((branch) => ({ ...branch, sql: branch.id })) } }, reading, {
      run: async (sql) => ({ columns: ['total_bcm'], rows: [{ total_bcm: sql === 'current' ? 120 : 0 }], rowCount: 1, executionTimeMs: 1 }),
    }))).toMatchObject({ ok: true, result: { rows: [{ current_bcm: 120, previous_bcm: 0, mom_growth: null }] } });
    expect(zero.rows).toEqual([{ current_bcm: 120, previous_bcm: 0 }]);
  });

  it('rejects a compiler-added metric_time column for a scalar request instead of changing the result shape', async () => {
    const program: SemanticExecutionProgram = {
      version: 1, shape: 'scalar',
      branches: [{ id: 'only', request: { metrics: ['total_bcm'], dimensions: [] }, outputs: [{ source: 'total_bcm', as: 'total_bcm' }], sql: 'SELECT', engine: 'metricflow-cli' }],
    };
    await expect(executeSemanticProgram(program, {
      run: async () => ({ columns: ['metric_time', 'total_bcm'], rows: [{ metric_time: '2026-09-01', total_bcm: 10 }], rowCount: 1, executionTimeMs: 1 }),
    }, { tier: 'semantic', trust: 'governed', sql: 'SELECT', proof: [] })).rejects.toThrow(/metric_time.*scalar request/);
  });

  it('removes an explicitly requested one-row MetricFlow support grain for an authored offset without turning a scalar into a trend', async () => {
    const program: SemanticExecutionProgram = {
      version: 1, shape: 'scalar',
      branches: [{
        id: 'yoy',
        request: { metrics: ['total_bcm', 'previous_year_bcm'], dimensions: [], timeDimension: { name: 'metric_time', granularity: 'month' } },
        outputs: [{ source: 'total_bcm', as: 'current_bcm' }, { source: 'previous_year_bcm', as: 'previous_bcm' }],
        sql: 'SELECT', engine: 'metricflow-cli',
      }],
    };
    const result = await executeSemanticProgram(program, {
      run: async () => ({ columns: ['metric_time__month', 'total_bcm', 'previous_year_bcm'], rows: [{ metric_time__month: '2026-09-01', total_bcm: 120, previous_year_bcm: 80 }], rowCount: 1, executionTimeMs: 1 }),
    }, { tier: 'semantic', trust: 'governed', sql: 'SELECT', proof: [] });
    expect(result).toEqual({ columns: ['current_bcm', 'previous_bcm'], rows: [{ current_bcm: 120, previous_bcm: 80 }], rowCount: 1, executionTimeMs: 1 });
  });

  it('fails closed for cycles and preserves typed membership semantics while leaving ranges ordered', () => {
    const cyclic = intent({
      measures: [
        { ref: 'metric:consumption.total_bcm', alias: 'a', scope: [year] },
        { ref: 'metric:consumption.previous_year_bcm', alias: 'b', scope: [year] },
      ],
    });
    cyclic.measures[0]!.change = { base: 'a', comparison: 'b', as: 'absolute' };
    normalizeEffectiveIntent(cyclic);
    expect(cyclic.filters).toEqual([]);
    expect(cyclic.measures[0]?.scope).toEqual([year]);
    expect(cyclic.measures[1]?.scope).toEqual([year]);

    const membership = intent({
      measures: [
        { ref: 'metric:consumption.total_bcm', scope: [{ ref: 'dimension:consumption.report_as_of_dt', op: 'in', values: [1, '1', 2, 1], source: 'question' }] },
        { ref: 'metric:consumption.previous_year_bcm', scope: [{ ref: 'dimension:consumption.report_as_of_dt', op: 'in', values: [2, '1', 1], source: 'question' }] },
      ],
    });
    normalizeEffectiveIntent(membership);
    expect(membership.filters).toHaveLength(1);
    expect(membership.measures.every((measure) => !measure.scope?.length)).toBe(true);

    const ranges = intent({
      measures: [
        { ref: 'metric:consumption.total_bcm', scope: [{ ref: 'dimension:consumption.report_as_of_dt', op: 'gte', values: ['2026-01-01', '2026-12-31'], source: 'question' }] },
        { ref: 'metric:consumption.previous_year_bcm', scope: [{ ref: 'dimension:consumption.report_as_of_dt', op: 'gte', values: ['2026-12-31', '2026-01-01'], source: 'question' }] },
      ],
    });
    normalizeEffectiveIntent(ranges);
    expect(ranges.filters).toEqual([]);
    expect(ranges.measures.every((measure) => measure.scope?.length === 1)).toBe(true);
  });

  it('records both physical branches when Ask executes a current-versus-previous-month semantic program', async () => {
    const provider: AgentProvider = {
      name: 'ollama', available: async () => true,
      generate: async () => JSON.stringify({
        version: 1, kind: 'analytics', reading: 'Capital One current versus previous month BCM.',
        measures: [
          { ref: 'metric:consumption.total_bcm', alias: 'current_bcm', scope: [{ ...year, values: ['2026-09-01'] }, { ...yearEnd, values: ['2026-10-01'] }] },
          { ref: 'metric:consumption.total_bcm', alias: 'previous_bcm', scope: [{ ...year, values: ['2026-08-01'] }, { ...yearEnd, values: ['2026-09-01'] }] },
          { ref: 'change:current_bcm/previous_bcm', alias: 'mom_growth', change: { base: 'previous_bcm', comparison: 'current_bcm', as: 'percent' } },
        ],
        groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar',
      }),
    };
    const outcome = await runAskPipeline({
      question: 'What is Capital One current versus previous month BCM?', vocabulary, provider, clauseCoverage: false,
      prepareDeps: {
        engine: 'metricflow-cli',
        compileSemantic: async () => ({ sql: 'unused', engine: 'metricflow-cli' }),
        compileSemanticProgram: async (input) => ({
          sql: '/* semantic program */', engine: 'metricflow-cli',
          program: { ...input, branches: input.branches.map((branch, index) => ({ ...branch, sql: index === 0 ? 'current' : 'previous', engine: 'metricflow-cli' })) },
        }),
      },
      executeDeps: {
        run: async (sql) => ({ columns: ['total_bcm'], rows: [{ total_bcm: sql === 'current' ? 120 : 100 }], rowCount: 1, executionTimeMs: 1 }),
      },
    });
    expect(outcome.kind).toBe('answered');
    if (outcome.kind !== 'answered') return;
    expect(outcome.candidate.semanticProgram?.branches).toHaveLength(2);
    expect(outcome.result.rows).toEqual([{ current_bcm: 120, previous_bcm: 100, mom_growth: 0.2 }]);
    expect(outcome.receipt.warehouse).toEqual({ attempts: 2, failures: 0, executions: 2 });
  });
});
