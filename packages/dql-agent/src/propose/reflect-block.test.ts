import { describe, it, expect } from 'vitest';
import { reflectAndReviseBlock, type ReflectableDraft } from './reflect-block.js';

function draft(overrides: Partial<ReflectableDraft> = {}): ReflectableDraft {
  return {
    slug: 'revenue',
    domain: 'marts',
    owner: 'me@example.com',
    description: 'Total product revenue.',
    grain: 'one row per ordered_at',
    outputs: ['ordered_at', 'revenue'],
    entities: [],
    invariants: [],
    llmContext: 'Answers revenue questions.',
    reviewCadence: 'quarterly',
    tags: ['metric'],
    sourceSystems: ['dbt'],
    gitPath: 'blocks/_drafts/revenue.dql',
    blockType: 'semantic',
    pattern: 'metric_wrapper',
    metricRef: 'revenue',
    ...overrides,
  };
}

describe('reflectAndReviseBlock — output contract', () => {
  it('declares output columns the SQL returns but the draft missed', () => {
    const r = reflectAndReviseBlock(draft({ outputs: ['revenue'] }), {
      actualColumns: ['ordered_at', 'revenue'],
      tests: { passed: 1, failed: 0 },
    });
    expect(r.revised.outputs).toEqual(['ordered_at', 'revenue']);
    expect(r.outputContract?.undeclaredColumns).toContain('ordered_at');
    expect(r.fixesApplied.some((f) => f.rule === 'output-contract')).toBe(true);
  });

  it('removes phantom outputs the SQL does not actually return', () => {
    const r = reflectAndReviseBlock(draft({ outputs: ['revenue', 'made_up_col'] }), {
      actualColumns: ['revenue'],
      tests: { passed: 1, failed: 0 },
    });
    expect(r.revised.outputs).toEqual(['revenue']);
    expect(r.outputContract?.phantomOutputs).toContain('made_up_col');
  });

  it('reports the contract aligned when declared outputs already match', () => {
    const r = reflectAndReviseBlock(draft(), { actualColumns: ['ordered_at', 'revenue'], tests: { passed: 1, failed: 0 } });
    expect(r.outputContract?.aligned).toBe(true);
  });
});

describe('reflectAndReviseBlock — governance gap-filling', () => {
  it('infers a missing grain and defaults review cadence / llmContext', () => {
    const r = reflectAndReviseBlock(
      draft({ grain: undefined, reviewCadence: undefined, llmContext: undefined }),
      { actualColumns: ['ordered_at', 'revenue'], tests: { passed: 1, failed: 0 } },
    );
    expect(r.revised.grain && r.revised.grain.length > 0).toBe(true);
    expect(r.revised.reviewCadence).toBe('quarterly');
    expect(r.revised.llmContext && r.revised.llmContext.length > 0).toBe(true);
    expect(r.fixesApplied.some((f) => f.rule === 'declares-grain')).toBe(true);
  });

  it('demotes an unbound metric_wrapper to a custom block', () => {
    const r = reflectAndReviseBlock(
      draft({ pattern: 'metric_wrapper', metricRef: undefined, blockType: 'custom' }),
      { actualColumns: ['ordered_at', 'revenue'], tests: { passed: 1, failed: 0 } },
    );
    expect(r.revised.pattern).toBe('custom');
  });
});

describe('reflectAndReviseBlock — readiness gates', () => {
  it('is ready when owner is set, tests pass, and the contract is clean', () => {
    const r = reflectAndReviseBlock(draft(), {
      actualColumns: ['ordered_at', 'revenue'],
      tests: { passed: 1, failed: 0 },
    });
    expect(r.ready).toBe(true);
    expect(r.testsPassed).toBe(true);
  });

  it('keeps owner as the human gate — never auto-filled', () => {
    const r = reflectAndReviseBlock(draft({ owner: '' }), {
      actualColumns: ['ordered_at', 'revenue'],
      tests: { passed: 1, failed: 0 },
    });
    expect(r.revised.owner).toBe(''); // not invented
    expect(r.ready).toBe(false);
    expect(r.remainingBlocking.some((b) => b.toLowerCase().includes('owner'))).toBe(true);
  });

  it('is not ready without a tests verdict (tests must actually run)', () => {
    const r = reflectAndReviseBlock(draft()); // no probe → no test results
    expect(r.ready).toBe(false);
    expect(r.remainingBlocking.some((b) => b.toLowerCase().includes('test'))).toBe(true);
  });

  it('fails readiness when a test fails', () => {
    const r = reflectAndReviseBlock(draft(), {
      actualColumns: ['ordered_at', 'revenue'],
      tests: { passed: 0, failed: 1 },
    });
    expect(r.testsPassed).toBe(false);
    expect(r.ready).toBe(false);
  });
});
