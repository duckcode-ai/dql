import { describe, expect, it } from 'vitest';
import type { DashboardRunResponse } from '../../api/client';
import {
  formatDatasetGrainEvidenceDetail,
  formatDatasetGrainEvidenceKeyCheck,
  summarizeDatasetGrainEvidence,
} from './dataset-grain-evidence';

describe('Dataset grain evidence display (APP-018)', () => {
  it('uses the nested runtime receipt shape from a complete-source grain probe', () => {
    const actualRuntimeResponse = {
      dataset: {
        grainRuntimeEvidence: {
          status: 'passed' as const,
          uniqueness: {
            rowCount: 8,
            distinctKeyCount: 8,
            nullKeyCount: 0,
            duplicateKeyCount: 0,
          },
        },
      },
    } satisfies Pick<DashboardRunResponse['tiles'][number], 'dataset'>;
    const evidence = actualRuntimeResponse.dataset?.grainRuntimeEvidence;

    expect(summarizeDatasetGrainEvidence(evidence)).toMatchObject({
      status: 'Passed', rowCount: 8, distinctKeyCount: 8, nullKeyCount: 0, duplicateKeyCount: 0,
    });
    expect(formatDatasetGrainEvidenceKeyCheck(evidence)).toBe('Passed · 8/8 distinct keys');
    expect(formatDatasetGrainEvidenceDetail(evidence)).toBe('Passed · 8 rows · 8 distinct keys · 0 duplicate key groups');
  });

  it('does not render missing proof counts as zero', () => {
    expect(formatDatasetGrainEvidenceKeyCheck({ status: 'passed' })).toBe('Passed · key counts unavailable');
    expect(formatDatasetGrainEvidenceDetail({ status: 'passed' })).toBe('Passed · key counts unavailable');
  });
});
