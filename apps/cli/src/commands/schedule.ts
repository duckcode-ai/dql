import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import type { CLIFlags } from '../args.js';
import { findProjectRoot, loadProjectConfig, normalizeProjectConnection } from '../local-runtime.js';
import { discoverScheduledBlocks } from '../schedule/discovery.js';
import { runBlock } from '../schedule/runner.js';
import { listRunRecords } from '../schedule/runs.js';
import { startScheduleService } from '../schedule/service.js';

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
      throw new Error(
        'dql schedule runs in the foreground — stop with Ctrl+C in the terminal where it is running.',
      );
    default:
      throw new Error('Usage: dql schedule <list|run|start|status> [args]');
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
  if (!target) throw new Error('Usage: dql schedule run <path-to-block.dql>');

  const projectRoot = findProjectRoot(process.cwd());
  const absPath = isAbsolute(target) ? target : resolve(process.cwd(), target);
  if (!existsSync(absPath)) throw new Error(`File not found: ${target}`);

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
  const service = await startScheduleService();

  if (flags.format === 'json') {
    console.log(JSON.stringify({ started: true, blocks: service.blocks }, null, 2));
  } else if (service.blocks.length === 0) {
    console.log('No scheduled blocks found. Add @schedule(...) to a .dql file and restart.');
    return;
  } else {
    console.log(`[schedule] running ${service.blocks.length} block(s). Ctrl+C to stop.`);
    for (const b of service.blocks) {
      console.log(`  - ${b.name}  cron="${b.schedule.cron}"`);
    }
  }

  // Graceful shutdown.
  const shutdown = async () => {
    await service.stop();
    console.log('\n[schedule] stopped');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Hold the event loop open.
  await new Promise<void>(() => {});
}
