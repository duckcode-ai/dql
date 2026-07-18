import type {
  DbtOnboardingApplyResponse,
  DbtOnboardingJob,
  DbtOnboardingJobResponse,
} from '../../api/client';

/** Normalize Apply, refresh, and job-poll envelopes into one truthful UI state. */
export function dbtPreparationFromResponse(
  response: DbtOnboardingApplyResponse | DbtOnboardingJobResponse | null | undefined,
): DbtOnboardingJob | null {
  if (!response) return null;
  if ('job' in response && response.job) return response.job;
  const id = response.id ?? ('jobId' in response ? response.jobId : undefined);
  if (!id) return null;
  return {
    id,
    kind: response.kind,
    status: (response.status as DbtOnboardingJob['status'] | undefined) ?? 'running',
    stage: response.stage,
    progress: response.progress,
    message: response.message,
    phases: response.phases,
    result: response.result,
    error: response.error,
  };
}
