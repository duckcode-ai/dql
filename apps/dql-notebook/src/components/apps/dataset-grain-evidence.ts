import type { DashboardDatasetGrainRuntimeEvidence } from '../../api/client';

export type DatasetGrainEvidenceSummary = {
  status: string;
  rowCount?: number;
  distinctKeyCount?: number;
  nullKeyCount?: number;
  duplicateKeyCount?: number;
};

function safeCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Normalize the current runtime receipt for both App Studio and the published
 * renderer. An absent or malformed count stays unknown; it cannot become a
 * misleading zero-count proof.
 */
export function summarizeDatasetGrainEvidence(
  evidence?: DashboardDatasetGrainRuntimeEvidence,
): DatasetGrainEvidenceSummary | undefined {
  if (!evidence) return undefined;
  const uniqueness = evidence.uniqueness;
  const rowCount = safeCount(uniqueness?.rowCount ?? evidence.rowCount);
  const distinctKeyCount = safeCount(uniqueness?.distinctKeyCount ?? evidence.distinctKeyCount);
  const nullKeyCount = safeCount(uniqueness?.nullKeyCount ?? evidence.nullKeyRows);
  const duplicateKeyCount = safeCount(uniqueness?.duplicateKeyCount ?? evidence.duplicateKeyGroups);
  return {
    status: evidence.status === 'passed' ? 'Passed' : evidence.status === 'failed' ? 'Failed' : 'Unknown',
    ...(rowCount === undefined ? {} : { rowCount }),
    ...(distinctKeyCount === undefined ? {} : { distinctKeyCount }),
    ...(nullKeyCount === undefined ? {} : { nullKeyCount }),
    ...(duplicateKeyCount === undefined ? {} : { duplicateKeyCount }),
  };
}

export function formatDatasetGrainEvidenceKeyCheck(
  evidence?: DashboardDatasetGrainRuntimeEvidence,
): string | undefined {
  const summary = summarizeDatasetGrainEvidence(evidence);
  if (!summary) return undefined;
  if (summary.rowCount === undefined || summary.distinctKeyCount === undefined) {
    return `${summary.status} · key counts unavailable`;
  }
  return `${summary.status} · ${summary.distinctKeyCount}/${summary.rowCount} distinct keys`;
}

export function formatDatasetGrainEvidenceDetail(
  evidence?: DashboardDatasetGrainRuntimeEvidence,
): string | undefined {
  const summary = summarizeDatasetGrainEvidence(evidence);
  if (!summary) return undefined;
  const counts = summary.rowCount === undefined || summary.distinctKeyCount === undefined
    ? 'key counts unavailable'
    : `${summary.rowCount} rows · ${summary.distinctKeyCount} distinct keys`;
  const duplicates = summary.duplicateKeyCount === undefined
    ? ''
    : ` · ${summary.duplicateKeyCount} duplicate key groups`;
  return `${summary.status} · ${counts}${duplicates}`;
}
