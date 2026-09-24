import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { buildManifest } from '@duckcodeailabs/dql-core';
import type { CLIFlags } from '../args.js';
import { findProjectRoot, loadProjectConfig, normalizeProjectConnection } from '../local-runtime.js';
import { discoverScheduledBlocks } from '../schedule/discovery.js';
import { runAppDashboard, runBlock } from '../schedule/runner.js';
import { createRuntimePageRunner } from '../schedule/app-page-run.js';
import { listRunRecords } from '../schedule/runs.js';
import { startScheduleService } from '../schedule/service.js';

const PIDFILE_RELATIVE = '.dql/schedule.pid';

function pidfilePath(projectRoot: string): string {
  return join(projectRoot, PIDFILE_RELATIVE);
}

function writePidfile(projectRoot: string): void {
  const p = pidfilePath(projectRoot);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, String(process.pid), 'utf-8');
}

function removePidfile(projectRoot: string): void {
  const p = pidfilePath(projectRoot);
  try {
    if (existsSync(p)) unlinkSync(p);
  } catch {
    /* best-effort */
  }
}

function readPidfile(projectRoot: string): number | null {
  const p = pidfilePath(projectRoot);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, 'utf-8').trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function runSchedule(
  sub: string | null,
  rest: string[],
  flags: CLIFlags,
): Promise<void> {
  switch (sub) {
    case 'list':
      return runScheduleList(flags);
    case 'run':
      return runScheduleRun(rest, flags);
    case 'status':
      return runScheduleStatus(flags);
    case 'start':
      return runScheduleStart(flags);
    case 'stop':
      return runScheduleStop(flags);
    default:
      throw new Error('Usage: dql schedule <list|run|start|stop|status> [args]');
  }
}

async function runScheduleStop(flags: CLIFlags): Promise<void> {
  const projectRoot = findProjectRoot(process.cwd());
  const pid = readPidfile(projectRoot);

  if (pid === null) {
    if (flags.format === 'json') {
      console.log(JSON.stringify({ stopped: false, reason: 'no pidfile' }, null, 2));
    } else {
      console.log('[schedule] no running scheduler found (missing .dql/schedule.pid).');
    }
    return;
  }

  if (!isProcessAlive(pid)) {
    removePidfile(projectRoot);
    if (flags.format === 'json') {
      console.log(JSON.stringify({ stopped: false, reason: 'stale pidfile', pid }, null, 2));
    } else {
      console.log(`[schedule] pidfile was stale (pid ${pid} not running); cleaned up.`);
    }
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to signal scheduler (pid ${pid}): ${msg}`);
  }

  if (flags.format === 'json') {
    console.log(JSON.stringify({ stopped: true, pid }, null, 2));
  } else {
    console.log(`[schedule] sent SIGTERM to pid ${pid}`);
  }
}

async function runScheduleList(flags: CLIFlags): Promise<void> {
  const projectRoot = findProjectRoot(process.cwd());
  const blocks = discoverScheduledBlocks(projectRoot);

  if (flags.format === 'json') {
    console.log(JSON.stringify({ blocks }, null, 2));
    return;
  }

  if (blocks.length === 0) {
    console.log('No scheduled blocks found. Add @schedule("daily", "9:00 AM") to a .dql file.');
    return;
  }

  console.log(`Scheduled blocks (${blocks.length}):`);
  for (const b of blocks) {
    const alerts = b.alerts.length > 0 ? ` alerts=${b.alerts.length}` : '';
    const notifs = b.notifications.length > 0 ? ` notify=${b.notifications.map((n) => n.type).join(',')}` : '';
    console.log(`  ${b.name.padEnd(40)} cron="${b.schedule.cron}"${alerts}${notifs}`);
  }
}

async function runScheduleRun(rest: string[], flags: CLIFlags): Promise<void> {
  const target = rest[0];
  if (!target) throw new Error('Usage: dql schedule run <path-to-block.dql> | dql schedule run <appId> [scheduleId]');

  const projectRoot = findProjectRoot(process.cwd());
  const absPath = isAbsolute(target) ? target : resolve(process.cwd(), target);
  if (!existsSync(absPath)) {
    const app = buildManifest({ projectRoot }).apps?.[target];
    if (app) return runAppScheduleOnce(projectRoot, app, rest[1], flags);
    throw new Error(`File not found: ${target} (and no App has that id)`);
  }

  const projectConfig = loadProjectConfig(projectRoot);
  const connection = normalizeProjectConnection(
    projectConfig.defaultConnection ?? { driver: 'duckdb' },
    projectRoot,
  );
  const executor = new QueryExecutor();

  const record = await runBlock(absPath, {
    executor,
    connection,
    projectRoot,
    trigger: 'manual',
  });

  if (flags.format === 'json') {
    console.log(JSON.stringify(record, null, 2));
    return;
  }

  const breached = record.alerts.filter((a) => a.breached).length;
  const tag = record.error ? `error: ${record.error}` : breached > 0 ? `${breached} alert(s) breached` : 'ok';
  console.log(`  ${record.block} → ${tag}`);
  console.log(`  queries: ${record.queries.length} (${record.queries.filter((q) => !q.error).length} ok)`);
  for (const q of record.queries) {
    const s = q.error ? `err: ${q.error}` : `${q.rowCount} rows in ${q.durationMs}ms`;
    console.log(`    ${q.chartId}: ${s}`);
  }
  if (record.alerts.length > 0) {
    console.log(`  alerts:`);
    for (const a of record.alerts) {
      const status = a.error ? `err: ${a.error}` : a.breached ? 'BREACHED' : 'ok';
      const obs = a.observedValue !== undefined ? ` (observed ${a.observedValue})` : '';
      console.log(`    ${status}${obs}: ${a.alert.conditionSQL}`);
    }
  }
  if (record.notifications.length > 0) {
    console.log(`  notifications:`);
    for (const n of record.notifications) {
      const status = n.delivered ? 'sent' : `failed: ${n.error}`;
      console.log(`    ${n.type} → ${n.recipients.join(', ') || '(default)'} [${status}]`);
    }
  }
}

async function runScheduleStatus(flags: CLIFlags): Promise<void> {
  const projectRoot = findProjectRoot(process.cwd());
  const records = listRunRecords(projectRoot, 10);

  if (flags.format === 'json') {
    console.log(JSON.stringify({ records }, null, 2));
    return;
  }

  if (records.length === 0) {
    console.log('No run history in .dql/runs/. Trigger a run with: dql schedule run <path>');
    return;
  }

  console.log(`Last ${records.length} runs:`);
  for (const r of records) {
    const breached = r.alerts.filter((a) => a.breached).length;
    const tag = r.error ? 'error' : breached > 0 ? `breached:${breached}` : 'ok';
    console.log(`  ${r.startedAt}  ${r.block.padEnd(40)} ${r.trigger.padEnd(6)} ${tag}`);
  }
}

async function runScheduleStart(flags: CLIFlags): Promise<void> {
  const projectRoot = findProjectRoot(process.cwd());

  const existingPid = readPidfile(projectRoot);
  if (existingPid !== null && isProcessAlive(existingPid)) {
    throw new Error(
      `[schedule] already running (pid ${existingPid}). Use 'dql schedule stop' first.`,
    );
  }
  if (existingPid !== null) {
    removePidfile(projectRoot);
  }

  const service = await startScheduleService();
  writePidfile(projectRoot);

  if (flags.format === 'json') {
    console.log(JSON.stringify({ started: true, pid: process.pid, blocks: service.blocks }, null, 2));
  } else if (service.blocks.length === 0) {
    console.log('No scheduled blocks found. Add @schedule(...) to a .dql file and restart.');
    removePidfile(projectRoot);
    return;
  } else {
    console.log(`[schedule] running ${service.blocks.length} block(s) (pid ${process.pid}). Ctrl+C or 'dql schedule stop' to end.`);
    for (const b of service.blocks) {
      console.log(`  - ${b.name}  cron="${b.schedule.cron}"`);
    }
  }

  // Graceful shutdown.
  const shutdown = async () => {
    await service.stop();
    removePidfile(projectRoot);
    console.log('\n[schedule] stopped');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Hold the event loop open.
  await new Promise<void>(() => {});
}

/**
 * `dql schedule run <appId> [scheduleId]` — run one App schedule now, exactly
 * as cron would: a full page run, monitors checked, and the digest delivered
 * to the schedule's targets (RFC 0008 step 10).
 */
async function runAppScheduleOnce(
  projectRoot: string,
  app: NonNullable<ReturnType<typeof buildManifest>['apps']>[string],
  scheduleId: string | undefined,
  flags: CLIFlags,
): Promise<void> {
  const schedules = app.schedules ?? [];
  const schedule = scheduleId ? schedules.find((entry) => entry.id === scheduleId) : schedules.length === 1 ? schedules[0] : undefined;
  if (!schedule) {
    const ids = schedules.map((entry) => entry.id).join(', ') || 'none';
    throw new Error(scheduleId
      ? `App ${app.id} has no schedule "${scheduleId}". Schedules: ${ids}.`
      : `App ${app.id} has ${schedules.length} schedules (${ids}); name one: dql schedule run ${app.id} <scheduleId>`);
  }
  const projectConfig = loadProjectConfig(projectRoot);
  const connection = normalizeProjectConnection(projectConfig.defaultConnection ?? { driver: 'duckdb' }, projectRoot);
  // With --runtime-url the run goes through an App runtime that is already
  // serving this project (for example `dql notebook`), which matters for
  // DuckDB: only one process may open the database file.
  const record = await runAppDashboard(app.id, schedule.dashboard, {
    executor: new QueryExecutor(),
    connection,
    projectRoot,
    trigger: 'manual',
    scheduleId: schedule.id,
    ...(flags.runtimeUrl ? { pageRunner: createRuntimePageRunner(flags.runtimeUrl) } : {}),
  });
  if (flags.format === 'json') {
    console.log(JSON.stringify(record, null, 2));
    return;
  }
  const failed = record.queries.filter((query) => query.error).length;
  const firing = (record.monitors ?? []).filter((monitor) => monitor.status === 'breached');
  if (failed && record.queries.some((query) => /could not set lock on file/i.test(query.error ?? ''))) {
    console.log('  DuckDB is open in another DQL process (usually `dql notebook`). Stop it, or run through it:');
    console.log(`    dql schedule run ${app.id} ${schedule.id} --runtime-url http://127.0.0.1:<notebook port>`);
  }
  console.log(`  ${record.block} → ${record.error ? `error: ${record.error}` : failed ? `${failed} tile(s) did not run` : 'ok'}`);
  console.log(`  tiles: ${record.queries.length} (${record.queries.length - failed} ok)`);
  if (record.monitors?.length) {
    console.log(`  monitors: ${firing.length} firing of ${record.monitors.length}`);
    for (const monitor of record.monitors) console.log(`    ${monitor.status === 'breached' ? 'FIRING' : monitor.status}: ${monitor.message}`);
  }
  if (record.digestPath) console.log(`  digest: ${record.digestPath}`);
  else console.log('  digest: not sent (this schedule speaks only when an alert fires)');
  for (const notification of record.notifications) {
    console.log(`    ${notification.type} → ${notification.recipients.join(', ') || '(default)'} [${notification.delivered ? 'sent' : `failed: ${notification.error}`}]`);
  }
}
