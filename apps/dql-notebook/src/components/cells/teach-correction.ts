import type { Cell } from '../../store/types';

export interface TeachCorrectionEligibility {
  eligible: boolean;
  reason:
    | 'ready'
    | 'saved_or_certified'
    | 'missing_question'
    | 'missing_generated_sql'
    | 'not_edited'
    | 'run_required'
    | 'execution_mismatch';
  generatedSql: string;
  correctedSql: string;
  question?: string;
}

function normalizedSql(value: string | undefined): string {
  return (value ?? '')
    .trim()
    .replace(/;+\s*$/, '')
    .replace(/\s+/g, ' ');
}

/**
 * CTX-005 / E2E-001: Teach is offered only for an explicit edit followed by a successful live run.
 * Cached snapshots and stale results are not evidence that the edited SQL works.
 */
export function teachCorrectionEligibility(cell: Cell): TeachCorrectionEligibility {
  const provenance = cell.correctionProvenance;
  const generatedSql = (
    provenance?.generatedSql
    ?? cell.dqlArtifact?.sql
    ?? cell.dqlArtifact?.compiledSql
    ?? ''
  ).trim();
  const generatedDql = (provenance?.generatedDql ?? cell.dqlArtifact?.source ?? '').trim();
  const question = (provenance?.question ?? cell.dqlArtifact?.question)?.trim();
  const savedOrCertified = Boolean(
    cell.dqlArtifact?.sourcePath
    || cell.dqlArtifact?.persistence === 'saved'
    || cell.dqlArtifact?.trustState === 'certified'
    || cell.dqlArtifact?.reviewState === 'certified',
  );
  const correctedSql = cell.type === 'dql'
    ? (cell.execution?.executedSql ?? cell.execution?.compiledSql ?? '').trim()
    : cell.content.trim();
  const edited = cell.type === 'dql'
    ? Boolean(generatedDql) && generatedDql !== cell.content.trim()
    : Boolean(generatedSql) && normalizedSql(generatedSql) !== normalizedSql(cell.content);
  const executionMatchesCurrentDraft = cell.type === 'dql'
    ? Boolean(correctedSql)
    : Boolean(correctedSql)
      && normalizedSql(cell.execution?.executedSql) === normalizedSql(correctedSql);
  const ranEditedSql = cell.execution?.status === 'success'
    && cell.stale !== true
    && cell.fromSnapshot !== true
    && Boolean(cell.result)
    && executionMatchesCurrentDraft;
  const reason: TeachCorrectionEligibility['reason'] = savedOrCertified
    ? 'saved_or_certified'
    : !question
      ? 'missing_question'
      : !generatedSql
        ? 'missing_generated_sql'
        : !edited
          ? 'not_edited'
          : cell.execution?.status !== 'success'
            || cell.stale === true
            || cell.fromSnapshot === true
            || !cell.result
            ? 'run_required'
            : !executionMatchesCurrentDraft
              ? 'execution_mismatch'
              : 'ready';
  return {
    eligible: (cell.type === 'sql' || cell.type === 'dql')
      && reason === 'ready'
      && ranEditedSql,
    reason,
    generatedSql,
    correctedSql,
    question,
  };
}
