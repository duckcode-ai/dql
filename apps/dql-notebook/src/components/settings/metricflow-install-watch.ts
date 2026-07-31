import type { MetricFlowInstallerStatus } from '../../api/client';

type WatchMetricFlowInstallOptions = {
  jobId: string;
  loadStatus: () => Promise<MetricFlowInstallerStatus>;
  onCompleted: (status: MetricFlowInstallerStatus) => Promise<void> | void;
  onFailed: (status: MetricFlowInstallerStatus) => Promise<void> | void;
  isCancelled?: () => boolean;
  wait?: (delayMs: number) => Promise<void>;
  intervalMs?: number;
};

const waitFor = (delayMs: number) => new Promise<void>((resolve) => {
  window.setTimeout(resolve, delayMs);
});

/**
 * Follow one installer job until it reaches a terminal state.
 *
 * This intentionally owns the polling loop instead of relying on React state
 * changes to schedule the next request. Installation subprocesses can remain
 * in one stage without emitting output for a while; the UI must keep polling
 * even when state, progress, and updatedAt are temporarily unchanged.
 */
export async function watchMetricFlowInstall({
  jobId,
  loadStatus,
  onCompleted,
  onFailed,
  isCancelled = () => false,
  wait = waitFor,
  intervalMs = 700,
}: WatchMetricFlowInstallOptions): Promise<void> {
  while (!isCancelled()) {
    await wait(intervalMs);
    if (isCancelled()) return;

    const status = await loadStatus();
    if (isCancelled()) return;

    const job = status.job;
    if (!job || job.id !== jobId) return;
    if (job.state === 'queued' || job.state === 'running') continue;
    if (job.state === 'completed') await onCompleted(status);
    else if (job.state === 'failed') await onFailed(status);
    return;
  }
}
