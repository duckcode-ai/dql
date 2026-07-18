import { describe, expect, it } from 'vitest';
import { dbtPreparationFromResponse } from './dbt-preparation-model';

describe('dbt project preparation status (CTX-005, UI-007, PERF-002)', () => {
  it('normalizes the automatic post-Apply preparation job', () => {
    expect(dbtPreparationFromResponse({
      jobId: 'dbt-prepare-1',
      id: 'dbt-prepare-1',
      snapshotId: 'snapshot-1',
      status: 'running',
      stage: 'indexing',
      progress: 65,
      message: 'Indexing governed metadata.',
      phases: [
        { id: 'artifact_validation', label: 'Validate', status: 'completed', durationMs: 12 },
        { id: 'snapshot_compile', label: 'Compile', status: 'completed', durationMs: 34 },
        { id: 'search_index', label: 'Index', status: 'running' },
      ],
    })).toMatchObject({
      id: 'dbt-prepare-1',
      status: 'running',
      stage: 'indexing',
      progress: 65,
      phases: [{ status: 'completed' }, { status: 'completed' }, { status: 'running' }],
    });
  });

  it('preserves completed and failed job truth instead of describing either as merely connected', () => {
    expect(dbtPreparationFromResponse({
      id: 'dbt-prepare-ready',
      status: 'completed',
      stage: 'ready',
      progress: 100,
      message: 'Ready.',
      result: { objectCount: 11_800 },
    })).toMatchObject({ status: 'completed', stage: 'ready', progress: 100, result: { objectCount: 11_800 } });

    expect(dbtPreparationFromResponse({
      id: 'dbt-prepare-failed',
      status: 'failed',
      stage: 'indexing',
      progress: 65,
      error: 'Index build failed.',
    })).toMatchObject({ status: 'failed', error: 'Index build failed.' });
  });

  it('returns null for responses without a real preparation job', () => {
    expect(dbtPreparationFromResponse({ applied: true })).toBeNull();
    expect(dbtPreparationFromResponse(null)).toBeNull();
  });
});
