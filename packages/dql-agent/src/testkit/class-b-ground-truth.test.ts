import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Offline ground-truth proof for the class-B (wrong-number) eval traps.
 *
 * The class-B fixture (apps/cli/.../agent-evals/class-b-semantic.agent-evals.yml)
 * asserts that a valid query over real columns can still return the WRONG number
 * via fan-out / wrong-grain joins. Historically its `expected.rows` were TODO
 * placeholders because the fixture shipped dbt metadata only. This test grounds
 * those numbers: it seeds a real SQL engine from the committed seed.json and, for
 * each trap, proves (a) the grain-safe query equals the committed expected rows
 * and (b) the tempting naive query OVER-reports. If someone edits the seed data
 * without updating the expected rows, this fails — keeping the credentialed
 * --execute gate honest.
 */

interface SeedColumn { name: string; type: string }
interface SeedTable { columns: SeedColumn[]; rows: Record<string, unknown>[] }
interface Seed { tables: Record<string, SeedTable> }
interface Trap {
  name: string;
  question: string;
  grainSafeSql: string;
  naiveSql: string;
  expectedRows: Record<string, unknown>[];
}

function findSeedsDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      return join(dir, 'apps/cli/test/fixtures/jaffle-supply-chain/seeds');
    }
    dir = dirname(dir);
  }
  throw new Error('could not locate monorepo root (pnpm-workspace.yaml) from ' + import.meta.url);
}

const SQLITE_TYPE: Record<string, string> = {
  text: 'TEXT',
  int: 'INTEGER',
  decimal: 'REAL',
  bool: 'INTEGER',
  timestamp: 'TEXT',
};

function seedSqlite(db: Database.Database, seed: Seed): void {
  for (const [table, def] of Object.entries(seed.tables)) {
    const cols = def.columns.map((c) => `"${c.name}" ${SQLITE_TYPE[c.type] ?? 'TEXT'}`).join(', ');
    db.exec(`CREATE TABLE "${table}" (${cols})`);
    const colNames = def.columns.map((c) => c.name);
    const placeholders = colNames.map(() => '?').join(', ');
    const insert = db.prepare(`INSERT INTO "${table}" (${colNames.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders})`);
    for (const row of def.rows) {
      insert.run(colNames.map((c) => {
        const v = row[c];
        return typeof v === 'boolean' ? (v ? 1 : 0) : v as never;
      }));
    }
  }
}

/** Round numeric cells so REAL sums compare stably; sort keys for order-independent comparison. */
function normalizeRows(rows: Record<string, unknown>[]): unknown[] {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row)
        .map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 100) / 100 : v] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}

describe('class-B trap ground truth (seed.json)', () => {
  const seedsDir = findSeedsDir();
  const seed: Seed = JSON.parse(readFileSync(join(seedsDir, 'seed.json'), 'utf8'));
  const traps: { traps: Trap[] } = JSON.parse(readFileSync(join(seedsDir, 'traps.json'), 'utf8'));

  const db = new Database(':memory:');
  seedSqlite(db, seed);

  for (const trap of traps.traps) {
    describe(trap.name, () => {
      it('grain-safe query matches the committed expected rows', () => {
        const rows = db.prepare(trap.grainSafeSql).all() as Record<string, unknown>[];
        expect(normalizeRows(rows)).toEqual(normalizeRows(trap.expectedRows));
      });

      it('naive (fan-out / wrong-grain) query over-reports — proving the trap is real', () => {
        const grainSafe = db.prepare(trap.grainSafeSql).all() as Record<string, unknown>[];
        const naive = db.prepare(trap.naiveSql).all() as Record<string, unknown>[];
        // The naive query must differ from the grain-safe answer (it inflates a total),
        // otherwise the "trap" would not actually test the wrong-number defense.
        expect(normalizeRows(naive)).not.toEqual(normalizeRows(grainSafe));
      });
    });
  }
});
