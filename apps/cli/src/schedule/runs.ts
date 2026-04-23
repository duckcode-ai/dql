import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunRecord } from './types.js';

const RUNS_DIR = '.dql/runs';

export function ensureRunsDir(projectRoot: string): string {
  const dir = join(projectRoot, RUNS_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function writeRunRecord(projectRoot: string, record: RunRecord): string {
  const dir = ensureRunsDir(projectRoot);
  const stamp = record.startedAt.replace(/[:.]/g, '-');
  const safeName = record.block.replace(/[^a-zA-Z0-9_-]+/g, '_');
  const file = join(dir, `${stamp}-${safeName}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n', 'utf-8');
  return file;
}

export function listRunRecords(projectRoot: string, limit = 20): RunRecord[] {
  const dir = join(projectRoot, RUNS_DIR);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit);

  const records: RunRecord[] = [];
  for (const f of files) {
    try {
      const raw = readFileSync(join(dir, f), 'utf-8');
      records.push(JSON.parse(raw) as RunRecord);
    } catch {
      /* skip malformed */
    }
  }
  return records;
}
