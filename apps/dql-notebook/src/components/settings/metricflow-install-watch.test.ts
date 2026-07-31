import { describe, expect, it, vi } from 'vitest';
import type { MetricFlowInstallJob, MetricFlowInstallerStatus } from '../../api/client';
import { watchMetricFlowInstall } from './metricflow-install-watch';

function status(state: MetricFlowInstallJob['state'], updatedAt = 'unchanged'): MetricFlowInstallerStatus {
  return {
    job: {
      id: 'metricflow-install-1',
      state,
      stage: state === 'completed' ? 'ready' : 'installing',
      progress: state === 'completed' ? 100 : 45,
      adapter: 'duckdb',
      packageSpec: 'dbt-metricflow[duckdb]',
      message: state === 'completed' ? 'Local MetricFlow is ready.' : 'Installing MetricFlow.',
      createdAt: 'created',
      updatedAt,
      runtimePath: '.dql/runtimes/metricflow',
      logs: [],
    },
    recommendedAdapter: 'duckdb',
    supportedAdapters: ['duckdb'],
    projectConfigured: true,
    semanticManifestFound: true,
  };
}

describe('MetricFlow installer status watcher', () => {
  it('keeps polling when a long-running subprocess reports identical state', async () => {
    const responses = [status('running'), status('running'), status('completed', 'completed')];
    const loadStatus = vi.fn(async () => responses.shift() ?? status('completed', 'completed'));
    const onCompleted = vi.fn();
    const onFailed = vi.fn();

    await watchMetricFlowInstall({
      jobId: 'metricflow-install-1',
      loadStatus,
      onCompleted,
      onFailed,
      wait: async () => undefined,
    });

    expect(loadStatus).toHaveBeenCalledTimes(3);
    expect(onCompleted).toHaveBeenCalledOnce();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it('publishes a failed terminal status without another refresh', async () => {
    const failed = status('failed', 'failed');
    if (failed.job) failed.job.error = 'Package installation failed.';
    const onCompleted = vi.fn();
    const onFailed = vi.fn();

    await watchMetricFlowInstall({
      jobId: 'metricflow-install-1',
      loadStatus: async () => failed,
      onCompleted,
      onFailed,
      wait: async () => undefined,
    });

    expect(onFailed).toHaveBeenCalledWith(failed);
    expect(onCompleted).not.toHaveBeenCalled();
  });
});
