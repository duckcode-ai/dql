import { describe, expect, it } from 'vitest';
import {
  analyticalError,
  analyticalErrorBlocksAnswer,
  analyticalErrorDetail,
  analyticalErrorHeadline,
  tagAnalyticalError,
  withAnalyticalErrorOrigin,
  withAnalyticalErrorOriginSync,
  type AnalyticalErrorOrigin,
} from './analytical-error.js';
import { normalizeWarehouseSqlFailure } from './answer-loop.js';

describe('analytical error origin taxonomy', () => {
  it('round-trips a tag through an ordinary Error', () => {
    const error = analyticalError('I need values for: region.', {
      origin: 'dql_compilation',
      stage: 'bind',
      code: 'unresolved_parameter',
      offending: { parameter: 'region' },
    });

    const detail = analyticalErrorDetail(error);
    expect(detail?.origin).toBe('dql_compilation');
    expect(detail?.stage).toBe('bind');
    expect(detail?.offending?.parameter).toBe('region');
    expect(error.message).toBe('I need values for: region.');
  });

  it('keeps the innermost tag when an outer wrapper tries to relabel', () => {
    const inner = analyticalError('parse failed', { origin: 'dql_compilation', stage: 'compile' });
    tagAnalyticalError(inner, { origin: 'warehouse', stage: 'execute' });
    expect(analyticalErrorDetail(inner)?.origin).toBe('dql_compilation');
  });

  it('returns no detail for an untagged error', () => {
    expect(analyticalErrorDetail(new Error('boom'))).toBeUndefined();
    expect(analyticalErrorDetail('boom')).toBeUndefined();
    expect(analyticalErrorDetail(undefined)).toBeUndefined();
  });

  it('tags everything thrown inside a region', async () => {
    await expect(withAnalyticalErrorOrigin(
      { origin: 'dql_compilation', stage: 'compile' },
      async () => { throw new Error('block parse failed'); },
    )).rejects.toSatisfy((error: unknown) => analyticalErrorDetail(error)?.origin === 'dql_compilation');

    expect(() => withAnalyticalErrorOriginSync(
      { origin: 'dql_compilation', stage: 'bind' },
      () => { throw new Error('bind failed'); },
    )).toThrowError();
  });

  it('leaves a successful region untouched', async () => {
    const value = await withAnalyticalErrorOrigin({ origin: 'host', stage: 'execute' }, async () => 42);
    expect(value).toBe(42);
    expect(withAnalyticalErrorOriginSync({ origin: 'host', stage: 'execute' }, () => 7)).toBe(7);
  });

  it('gives every origin a distinct headline', () => {
    const origins: AnalyticalErrorOrigin[] = [
      'warehouse', 'dql_compilation', 'governance_gate', 'retrieval_gap', 'ambiguity', 'provider', 'host',
    ];
    const headlines = origins.map(analyticalErrorHeadline);
    expect(new Set(headlines).size).toBe(origins.length);
    expect(headlines.every((headline) => headline.trim().length > 0)).toBe(true);
  });

  it('treats only a compilation failure as non-blocking for the answer', () => {
    expect(analyticalErrorBlocksAnswer('dql_compilation')).toBe(false);
    expect(analyticalErrorBlocksAnswer('warehouse')).toBe(true);
    expect(analyticalErrorBlocksAnswer('governance_gate')).toBe(true);
  });
});

describe('normalizeWarehouseSqlFailure respects the throw-site origin', () => {
  // The reported bug: DQL's own block-compiler throw was classified by the
  // warehouse regexes and surfaced as an execution failure against the preview.
  it('does not relabel a tagged DQL compilation error as a warehouse failure', () => {
    const failure = normalizeWarehouseSqlFailure(analyticalError('I need values for: region.', {
      origin: 'dql_compilation',
      stage: 'bind',
      code: 'unresolved_parameter',
      offending: { parameter: 'region' },
    }));

    expect(failure.origin).toBe('dql_compilation');
    expect(failure.stage).toBe('bind');
    expect(failure.offending?.parameter).toBe('region');
    // Never eligible for a model SQL-repair call: the SQL was not the problem.
    expect(failure.retryDisposition).toBe('terminal');
  });

  it('does not let the warehouse classifier fire on a tagged governance refusal', () => {
    // This text matches the `unsafe` regex; without the tag it would classify
    // as a warehouse rejection of a DML statement.
    const failure = normalizeWarehouseSqlFailure(analyticalError(
      'Generated SQL preview only supports a single read-only SELECT statement.',
      { origin: 'governance_gate', stage: 'validation', code: 'unsafe_sql' },
    ));

    expect(failure.origin).toBe('governance_gate');
    expect(failure.category).toBe('unsafe');
    expect(failure.retryDisposition).toBe('terminal');
  });

  it('marks a tagged retrieval gap as refreshable rather than terminal', () => {
    const failure = normalizeWarehouseSqlFailure(analyticalError(
      'Relation orders was never inspected.',
      { origin: 'retrieval_gap', stage: 'validation', code: 'unknown_relation', offending: { relation: 'orders' } },
    ));

    expect(failure.origin).toBe('retrieval_gap');
    expect(failure.category).toBe('unknown_relation');
    expect(failure.retryDisposition).toBe('refresh_metadata');
  });

  it('still classifies a genuine untagged driver error as warehouse', () => {
    const failure = normalizeWarehouseSqlFailure(
      new Error('Binder Error: Referenced column "amt" not found in FROM clause'),
      'duckdb',
    );

    expect(failure.origin).toBe('warehouse');
    expect(failure.category).toBe('unknown_column');
    expect(failure.retryDisposition).toBe('model_repair');
    expect(failure.driver).toBe('duckdb');
  });

  it('keeps the full producer text as an inspector diagnostic', () => {
    const failure = normalizeWarehouseSqlFailure(new Error('SQL compilation error: bad thing'));
    expect(failure.diagnostic).toContain('bad thing');
  });
});
