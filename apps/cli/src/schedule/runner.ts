import { readFileSync } from 'node:fs';
import { compile } from '@duckcodeailabs/dql-compiler';
import type { QueryExecutor, ConnectionConfig } from '@duckcodeailabs/dql-connectors';
import { findProjectRoot, loadProjectConfig, prepareLocalExecution } from '../local-runtime.js';
import { evaluateAlerts } from './alerts.js';
import { deriveBlockName } from './discovery.js';
import { dispatchNotifications } from './notifiers/index.js';
import { writeRunRecord } from './runs.js';
import type { QueryRunResult, RunRecord } from './types.js';

export interface RunOptions {
  executor: QueryExecutor;
  connection: ConnectionConfig;
  projectRoot?: string;
  trigger?: 'manual' | 'cron';
  previewRows?: number;
}

export async function runBlock(absPath: string, options: RunOptions): Promise<RunRecord> {
  const projectRoot = options.projectRoot ?? findProjectRoot(process.cwd());
  const projectConfig = loadProjectConfig(projectRoot);
  const trigger = options.trigger ?? 'manual';
  const previewRows = options.previewRows ?? 3;

  const startedAt = new Date().toISOString();
  const block = deriveBlockName(projectRoot, absPath);

  let queries: QueryRunResult[] = [];
  let alertResults: Awaited<ReturnType<typeof evaluateAlerts>> = [];
  let notifications: Awaited<ReturnType<typeof dispatchNotifications>> = [];
  let error: string | undefined;

  try {
    const source = readFileSync(absPath, 'utf-8');
    const compiled = compile(source, { file: absPath });

    if (compiled.errors.length > 0) {
      error = compiled.errors.join('; ');
    }

    const dashboard = compiled.dashboards[0];
    if (!dashboard) {
      error = error ?? 'compile produced no dashboards';
    } else {
      // Execute each chart query.
      for (const q of dashboard.metadata.queries) {
        const t0 = Date.now();
        try {
          const prepared = prepareLocalExecution(q.sql, options.connection, projectRoot, projectConfig);
          const result = await options.executor.executeQuery(
            prepared.sql,
            [],
            {},
            prepared.connection,
          );
          queries.push({
            chartId: q.id,
            sql: q.sql,
            rowCount: result.rows.length,
            durationMs: Date.now() - t0,
            preview: result.rows.slice(0, previewRows) as Array<Record<string, unknown>>,
          });
        } catch (err) {
          queries.push({
            chartId: q.id,
            sql: q.sql,
            rowCount: 0,
            durationMs: Date.now() - t0,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Evaluate alerts.
      alertResults = await evaluateAlerts(
        dashboard.metadata.alerts ?? [],
        options.executor,
        options.connection,
      );

      // Fire notifications only if at least one alert breached OR no alerts were
      // declared (so scheduled runs without alerts still produce an audit entry).
      const anyBreached = alertResults.some((a) => a.breached);
      const hasAlerts = alertResults.length > 0;
      const shouldNotify = anyBreached || !hasAlerts;

      if (shouldNotify && (dashboard.metadata.notifications?.length ?? 0) > 0) {
        notifications = await dispatchNotifications(
          dashboard.metadata.notifications ?? [],
          {
            block,
            path: absPath,
            startedAt,
            alerts: alertResults,
            queries,
            trigger,
          },
          projectRoot,
        );
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const record: RunRecord = {
    startedAt,
    finishedAt: new Date().toISOString(),
    block,
    path: absPath,
    trigger,
    queries,
    alerts: alertResults,
    notifications,
    error,
  };

  writeRunRecord(projectRoot, record);
  return record;
}
