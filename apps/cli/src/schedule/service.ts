import { QueryExecutor, type ConnectionConfig } from '@duckcodeailabs/dql-connectors';
import { buildManifest } from '@duckcodeailabs/dql-core';
import { findProjectRoot, loadProjectConfig, normalizeProjectConnection } from '../local-runtime.js';
import { discoverScheduledBlocks } from './discovery.js';
import { runAppDashboard, runBlock } from './runner.js';
import type { ScheduledAppDashboard, ScheduledBlock } from './types.js';

export interface ServiceOptions {
  projectRoot?: string;
  connection?: ConnectionConfig;
}

export interface StartedService {
  blocks: ScheduledBlock[];
  apps: ScheduledAppDashboard[];
  stop: () => Promise<void>;
}

export async function startScheduleService(options: ServiceOptions = {}): Promise<StartedService> {
  const projectRoot = options.projectRoot ?? findProjectRoot(process.cwd());
  const projectConfig = loadProjectConfig(projectRoot);
  const connection =
    options.connection ??
    normalizeProjectConnection(
      projectConfig.defaultConnection ?? { driver: 'duckdb' },
      projectRoot,
    );

  const executor = new QueryExecutor();
  const blocks = discoverScheduledBlocks(projectRoot);
  const manifest = buildManifest({ projectRoot });
  const apps: ScheduledAppDashboard[] = Object.values(manifest.apps ?? {}).flatMap((app) =>
    (app.schedules ?? [])
      .filter((schedule) => schedule.enabled !== false)
      .map((schedule) => ({
        appId: app.id,
        dashboardId: schedule.dashboard,
        scheduleId: schedule.id,
        cron: schedule.cron,
      })),
  );

  // Dynamic import so node-cron stays off the hot path for one-shot commands.
  const nodeCron = (await import('node-cron' as string)) as typeof import('node-cron');

  const tasks: Array<{ stop: () => void }> = [];
  for (const block of blocks) {
    if (!nodeCron.validate(block.schedule.cron)) {
      console.error(`[schedule] invalid cron "${block.schedule.cron}" on ${block.name}, skipping`);
      continue;
    }
    const task = nodeCron.schedule(block.schedule.cron, () => {
      void (async () => {
        try {
          const record = await runBlock(block.path, {
            executor,
            connection,
            projectRoot,
            trigger: 'cron',
          });
          const breached = record.alerts.filter((a) => a.breached).length;
          const tag = record.error ? 'error' : breached > 0 ? `breached:${breached}` : 'ok';
          console.log(`[schedule] ${record.startedAt} ${block.name} → ${tag}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[schedule] run failed for ${block.name}: ${msg}`);
        }
      })();
    });
    tasks.push({ stop: () => task.stop() });
  }

  for (const appSchedule of apps) {
    if (!nodeCron.validate(appSchedule.cron)) {
      console.error(`[schedule] invalid cron "${appSchedule.cron}" on ${appSchedule.appId}/${appSchedule.scheduleId}, skipping`);
      continue;
    }
    const task = nodeCron.schedule(appSchedule.cron, () => {
      void (async () => {
        try {
          const record = await runAppDashboard(appSchedule.appId, appSchedule.dashboardId, {
            executor,
            connection,
            projectRoot,
            trigger: 'cron',
            scheduleId: appSchedule.scheduleId,
          });
          const failed = record.queries.filter((q) => q.error).length;
          const tag = record.error ? 'error' : failed > 0 ? `tile-errors:${failed}` : 'ok';
          console.log(`[schedule] ${record.startedAt} ${appSchedule.appId}/${appSchedule.dashboardId} → ${tag}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[schedule] app run failed for ${appSchedule.appId}/${appSchedule.scheduleId}: ${msg}`);
        }
      })();
    });
    tasks.push({ stop: () => task.stop() });
  }

  return {
    blocks,
    apps,
    async stop() {
      for (const t of tasks) t.stop();
    },
  };
}
