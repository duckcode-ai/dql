import type { Cell } from '../../store/types';

export interface TeachCorrectionEligibility {
  eligible: boolean;
  generatedSql: string;
  correctedSql: string;
  question?: string;
}

/**
 * CTX-005 / E2E-001: Teach is offered only for an explicit edit followed by a successful live run.
 * Cached snapshots and stale results are not evidence that the edited SQL works.
 */
export function teachCorrectionEligibility(cell: Cell): TeachCorrectionEligibility {
  const generatedSql = (cell.dqlArtifact?.sql ?? cell.dqlArtifact?.compiledSql ?? '').trim();
  const correctedSql = cell.content.trim();
  const question = cell.dqlArtifact?.question?.trim();
  const edited = Boolean(generatedSql) && Boolean(correctedSql) && generatedSql !== correctedSql;
  const ranEditedSql = cell.status === 'success'
    && cell.execution?.status === 'success'
    && cell.stale !== true
    && cell.fromSnapshot !== true
    && Boolean(cell.result);
  return {
    eligible: edited && Boolean(question) && ranEditedSql,
    generatedSql,
    correctedSql,
    question,
  };
}
