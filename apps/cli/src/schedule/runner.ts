import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compile } from '@duckcodeailabs/dql-compiler';
import type { NotificationIR } from '@duckcodeailabs/dql-compiler';
import type { QueryExecutor, ConnectionConfig } from '@duckcodeailabs/dql-connectors';
import {
  buildManifest,
  isBlockIdRef,
  loadDashboardDocument,
  resolveSemanticLayerAsync,
  type DashboardGridItem,
  type ManifestBlock,
} from '@duckcodeailabs/dql-core';
import { buildExecutionPlan } from '@duckcodeailabs/dql-notebook';
import { findProjectRoot, loadProjectConfig, prepareLocalExecution } from '../local-runtime.js';
import { runtimeVariables } from '../governance-runtime.js';
import { isDigestOutput, runDigestBuild } from '../digest.js';
import { evaluateAlerts } from './alerts.js';
import { deriveBlockName } from './discovery.js';
import { dispatchNotifications } from './notifiers/index.js';
import { writeRunRecord } from './runs.js';
import type { NotifierPayload, QueryRunResult, RunRecord } from './types.js';

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
            q.sqlParams ?? [],
            runtimeVariables({}),
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
        const payload: NotifierPayload = {
          block,
          path: absPath,
          startedAt,
          alerts: alertResults,
          queries,
          trigger,
        };

        if (isDigestOutput(dashboard)) {
          try {
            const digest = await runDigestBuild(dashboard, projectRoot);
            payload.html = digest.html;
            payload.markdown = digest.markdown;
            payload.digestTitle = dashboard.metadata.title ?? block;
            payload.digestDiagnostics = digest.diagnostics;
          } catch (err) {
            payload.digestDiagnostics = [
              {
                level: 'warning',
                message: `digest build failed: ${err instanceof Error ? err.message : String(err)}`,
              },
            ];
          }
        }

        notifications = await dispatchNotifications(
          dashboard.metadata.notifications ?? [],
          payload,
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

export async function runAppDashboard(
  appId: string,
  dashboardId: string,
  options: RunOptions & { scheduleId?: string },
): Promise<RunRecord> {
  const projectRoot = options.projectRoot ?? findProjectRoot(process.cwd());
  const projectConfig = loadProjectConfig(projectRoot);
  const trigger = options.trigger ?? 'manual';
  const previewRows = options.previewRows ?? 3;
  const startedAt = new Date().toISOString();
  const block = `app/${appId}/${dashboardId}${options.scheduleId ? `#${options.scheduleId}` : ''}`;

  let queries: QueryRunResult[] = [];
  let notifications: Awaited<ReturnType<typeof dispatchNotifications>> = [];
  let error: string | undefined;

  try {
    const manifest = buildManifest({ projectRoot });
    const app = manifest.apps?.[appId];
    const dashboard = manifest.dashboards?.[`${appId}/${dashboardId}`];
    if (!app) throw new Error(`App not found: ${appId}`);
    if (!dashboard) throw new Error(`Dashboard not found: ${appId}/${dashboardId}`);

    const loadedDashboard = loadDashboardDocument(join(projectRoot, dashboard.filePath)).document;
    if (!loadedDashboard) throw new Error(`Dashboard file could not be loaded: ${dashboard.filePath}`);

    const semantic = await resolveSemanticLayerAsync(projectConfig.semanticLayer, projectRoot);
    const semanticLayer = semantic.layer;

    for (const item of loadedDashboard.layout.items) {
      if (!item.block) continue;
      const t0 = Date.now();
      const manifestBlock = resolveDashboardItemBlock(item, manifest.blocks);
      if (!manifestBlock) {
        queries.push({
          chartId: item.i,
          sql: '',
          rowCount: 0,
          durationMs: Date.now() - t0,
          error: `Unresolved block reference: ${JSON.stringify(item.block)}`,
        });
        continue;
      }

      try {
        const source = readFileSync(join(projectRoot, manifestBlock.filePath), 'utf-8');
        const plan = buildExecutionPlan(
          { id: item.i, type: 'dql', source, title: item.title ?? manifestBlock.name },
          { semanticLayer, driver: options.connection.driver },
        );
        if (!plan) throw new Error('Block produced no executable query');
        const prepared = prepareLocalExecution(plan.sql, options.connection, projectRoot, projectConfig);
        const result = await options.executor.executeQuery(
          prepared.sql,
          plan.sqlParams ?? [],
          runtimeVariables(plan.variables),
          prepared.connection,
        );
        queries.push({
          chartId: item.i,
          sql: plan.sql,
          rowCount: result.rows.length,
          durationMs: Date.now() - t0,
          preview: result.rows.slice(0, previewRows) as Array<Record<string, unknown>>,
        });
      } catch (err) {
        queries.push({
          chartId: item.i,
          sql: manifestBlock.sql,
          rowCount: 0,
          durationMs: Date.now() - t0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const notificationTargets: NotificationIR[] = [];
    for (const delivery of (app.schedules ?? []).find((s) => s.id === options.scheduleId)?.deliver ?? []) {
      if (delivery.kind === 'slack') {
        notificationTargets.push({ type: 'slack', recipients: [delivery.channel] });
      } else if (delivery.kind === 'email') {
        notificationTargets.push({ type: 'email', recipients: delivery.to });
      }
    }

    if (notificationTargets.length > 0) {
      const ok = queries.filter((q) => !q.error).length;
      const failed = queries.length - ok;
      notifications = await dispatchNotifications(
        notificationTargets,
        {
          block,
          path: dashboard.filePath,
          startedAt,
          alerts: [],
          queries,
          trigger,
          markdown: `# ${dashboard.title}\n\n${ok} tiles ran successfully${failed ? `, ${failed} failed` : ''}.`,
          digestTitle: dashboard.title,
        },
        projectRoot,
      );
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const record: RunRecord = {
    startedAt,
    finishedAt: new Date().toISOString(),
    block,
    path: `apps/${appId}/dashboards/${dashboardId}.dqld`,
    trigger,
    queries,
    alerts: [],
    notifications,
    error,
  };

  writeRunRecord(projectRoot, record);
  return record;
}

function resolveDashboardItemBlock(
  item: DashboardGridItem,
  blocks: Record<string, ManifestBlock>,
): ManifestBlock | null {
  if (!item.block) return null;
  if (isBlockIdRef(item.block)) return blocks[item.block.blockId] ?? null;
  const normalized = item.block.ref.replace(/\\/g, '/');
  return Object.values(blocks).find((b) => b.filePath.replace(/\\/g, '/') === normalized) ?? null;
}
