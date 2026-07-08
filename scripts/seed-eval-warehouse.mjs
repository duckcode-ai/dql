#!/usr/bin/env node
/**
 * Seed a warehouse with the deterministic execution-match eval dataset (W1.2).
 *
 * The dataset lives at apps/cli/test/fixtures/jaffle-supply-chain/seeds/seed.json
 * and is dialect-neutral. This script materializes it so that
 * `dql agent eval --execute` (and its --min-execution-match gate) can run against
 * a real warehouse. DuckDB is the free offline/CI target; `--print` emits portable
 * ANSI SQL you can pipe into any engine (Snowflake, BigQuery, Postgres, …), which
 * is how the credentialed multi-engine matrix seeds itself.
 *
 * Usage:
 *   node scripts/seed-eval-warehouse.mjs                 # → jaffle.duckdb (duckdb)
 *   node scripts/seed-eval-warehouse.mjs --out /tmp/j.duckdb
 *   node scripts/seed-eval-warehouse.mjs --print [--dialect ansi|duckdb|postgres|snowflake]
 *   node scripts/seed-eval-warehouse.mjs --seed <path/to/seed.json>
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

function parseArgs(argv) {
  const args = { print: false, dialect: null, out: null, seed: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--print' || a === '--dry-run') args.print = true;
    else if (a === '--dialect') args.dialect = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--seed') args.seed = argv[++i];
  }
  return args;
}

// Dialect-specific column types. Keep in one place so a new engine is one row.
const TYPE_MAP = {
  duckdb: { text: 'VARCHAR', int: 'INTEGER', decimal: 'DOUBLE', bool: 'BOOLEAN', timestamp: 'TIMESTAMP' },
  postgres: { text: 'text', int: 'integer', decimal: 'numeric', bool: 'boolean', timestamp: 'timestamp' },
  snowflake: { text: 'STRING', int: 'INTEGER', decimal: 'FLOAT', bool: 'BOOLEAN', timestamp: 'TIMESTAMP' },
  ansi: { text: 'VARCHAR(255)', int: 'INTEGER', decimal: 'DECIMAL(18,2)', bool: 'BOOLEAN', timestamp: 'TIMESTAMP' },
};

function sqlType(dialect, token) {
  const map = TYPE_MAP[dialect] ?? TYPE_MAP.ansi;
  return map[token] ?? map.text;
}

function literal(value, dialect) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') {
    // Engines with a real BOOLEAN take TRUE/FALSE; ansi keeps TRUE/FALSE too.
    return value ? 'TRUE' : 'FALSE';
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildStatements(seed, dialect) {
  const statements = [];
  for (const [table, def] of Object.entries(seed.tables)) {
    const cols = def.columns.map((c) => `"${c.name}" ${sqlType(dialect, c.type)}`).join(', ');
    statements.push(`DROP TABLE IF EXISTS "${table}"`);
    statements.push(`CREATE TABLE "${table}" (${cols})`);
    const colNames = def.columns.map((c) => `"${c.name}"`).join(', ');
    for (const row of def.rows) {
      const vals = def.columns.map((c) => literal(row[c.name], dialect)).join(', ');
      statements.push(`INSERT INTO "${table}" (${colNames}) VALUES (${vals})`);
    }
  }
  return statements;
}

async function seedDuckDb(statements, outPath) {
  const req = createRequire(new URL('../packages/dql-connectors/package.json', import.meta.url));
  let duckdb;
  try {
    duckdb = req('duckdb');
  } catch {
    console.error('duckdb is not installed. Install it (pnpm add duckdb) or use --print to emit SQL.');
    process.exit(1);
  }
  const db = new duckdb.Database(outPath);
  const connection = db.connect();
  const run = (sql) => new Promise((res, rej) => connection.run(sql, (e) => (e ? rej(e) : res())));
  for (const sql of statements) await run(sql);
  await new Promise((res, rej) => connection.close((e) => (e ? rej(e) : res())));
  await new Promise((res, rej) => db.close((e) => (e ? rej(e) : res())));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const seedPath = args.seed
    ? resolve(args.seed)
    : join(repoRoot, 'apps/cli/test/fixtures/jaffle-supply-chain/seeds/seed.json');
  const seed = JSON.parse(readFileSync(seedPath, 'utf8'));

  if (args.print) {
    const dialect = args.dialect ?? 'ansi';
    console.log(buildStatements(seed, dialect).map((s) => `${s};`).join('\n'));
    return;
  }

  const dialect = args.dialect ?? 'duckdb';
  const statements = buildStatements(seed, dialect);
  const outPath = args.out ?? join(repoRoot, 'jaffle.duckdb');
  await seedDuckDb(statements, outPath);
  console.log(`Seeded ${Object.keys(seed.tables).length} tables into ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
