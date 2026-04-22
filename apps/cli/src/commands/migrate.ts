import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { canonicalize, canonicalizeNotebook } from '@duckcodeailabs/dql-core';
import type { CLIFlags } from '../args.js';

export type MigrationSource = 'looker' | 'tableau' | 'dbt' | 'metabase' | 'raw-sql';

export interface MigrationResult {
  source: MigrationSource;
  blocksGenerated: number;
  metricsGenerated: number;
  dimensionsGenerated: number;
  needsReview: number;
}

/**
 * Generate a DQL block skeleton from a source tool definition.
 */
function generateBlockDQL(opts: {
  name: string;
  domain: string;
  description: string;
  sql: string;
  owner: string;
  tags: string[];
  chart: string;
}): string {
  const tagStr = opts.tags.map((t) => `"${t}"`).join(', ');
  return `block "${opts.name}" {
    domain = "${opts.domain}"
    type = "custom"
    description = "${opts.description}"
    tags = [${tagStr}]
    owner = "${opts.owner}"

    query = """
        ${opts.sql.split('\n').join('\n        ')}
    """

    visualization {
        chart = "${opts.chart}"
        x = dimension
        y = measure
    }

    tests {
        assert row_count > 0
    }
}
`;
}

export async function runMigrate(file: string, flags: CLIFlags): Promise<void> {
  if (file === 'format') {
    await runFormatMigrate(flags.input || '.', flags);
    return;
  }
  // file is used as the source type for migration
  const source = file as MigrationSource;
  const validSources: MigrationSource[] = ['looker', 'tableau', 'dbt', 'metabase', 'raw-sql'];

  if (!validSources.includes(source)) {
    console.error(`\n  ✗ Unknown migration source: "${source}"`);
    console.error(`    Valid sources: ${validSources.join(', ')}`);
    console.error(`    Or: "format" to upgrade .dql/.dqlnb files to the canonical on-disk format`);
    console.error('');
    process.exit(1);
  }

  if (flags.format === 'json') {
    console.log(JSON.stringify({
      source,
      status: 'scaffold',
      message: `Migration from ${source} is scaffold-only in the OSS CLI. Use the generated block as a starting point.`,
      exampleBlock: generateBlockDQL({
        name: `migrated-from-${source}`,
        domain: 'migrated',
        description: `Auto-migrated from ${source}`,
        sql: 'SELECT dimension, SUM(measure) AS measure\nFROM source_table\nGROUP BY dimension',
        owner: 'migration-bot',
        tags: ['migrated', source],
        chart: 'bar',
      }),
    }, null, 2));
    return;
  }

  console.log(`\n  DQL Migration: ${source}`);
  console.log('  ─────────────────────────────');

  switch (source) {
    case 'looker':
      console.log('  Source: LookML explores + measures + dimensions');
      console.log('  Method: Parse LookML → generate DQL blocks + semantic layer YAML');
      console.log('  Coverage: ~80% automated');
      break;
    case 'tableau':
      console.log('  Source: Workbook calculations + dashboard structure');
      console.log('  Method: Extract via REST API → generate DQL blocks per sheet');
      console.log('  Coverage: Semi-automated');
      break;
    case 'dbt': {
      const dbtDir = flags.input || '.';
      console.log(`  Source: dbt project at "${dbtDir}"`);
      console.log('  Method: Inspect models and metrics, then scaffold DQL blocks and semantic layer files manually.');
      console.log('  Coverage: Planning-only in OSS V1');
      break;
    }
    case 'metabase':
      console.log('  Source: Saved questions + dashboard cards');
      console.log('  Method: Export via API → generate DQL blocks per question');
      console.log('  Coverage: ~85% automated');
      break;
    case 'raw-sql':
      console.log('  Source: Ad-hoc SQL scripts');
      console.log('  Method: AI wraps in DQL block structure + adds metadata');
      console.log('  Coverage: AI-assisted');
      break;
  }

  console.log('\n  Example generated block:');
  console.log('  ───');
  const example = generateBlockDQL({
    name: `migrated-from-${source}`,
    domain: 'migrated',
    description: `Auto-migrated from ${source}`,
    sql: 'SELECT dimension, SUM(measure) AS measure\nFROM source_table\nGROUP BY dimension',
    owner: 'migration-bot',
    tags: ['migrated', source],
    chart: 'bar',
  });
  console.log(example.split('\n').map((l) => `    ${l}`).join('\n'));

  console.log('  Next steps:');
  console.log(`    1. Provide source files: dql migrate ${source} --input <path>`);
  console.log('    2. Review generated blocks in blocks/migrated/');
  console.log('    3. Run: dql test blocks/migrated/example.dql');
  console.log('    4. Commit and push for certification');
  console.log('');
}

interface FormatMigrateReport {
  scanned: number;
  alreadyCanonical: number;
  upgraded: number;
  failed: Array<{ path: string; error: string }>;
  dryRun: boolean;
}

export async function runFormatMigrate(root: string, flags: CLIFlags): Promise<void> {
  const dryRun = flags.check === true;
  const report: FormatMigrateReport = {
    scanned: 0,
    alreadyCanonical: 0,
    upgraded: 0,
    failed: [],
    dryRun,
  };

  for (const absPath of walkDqlFiles(root)) {
    report.scanned += 1;
    const rel = relative(root, absPath) || absPath;
    const source = readFileSync(absPath, 'utf-8');
    let canonical: string;
    try {
      canonical = absPath.endsWith('.dqlnb') ? canonicalizeNotebook(source) : canonicalize(source);
    } catch (error) {
      report.failed.push({ path: rel, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (canonical === source) {
      report.alreadyCanonical += 1;
      continue;
    }
    if (!dryRun) writeFileSync(absPath, canonical, 'utf-8');
    report.upgraded += 1;
  }

  if (flags.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
    if (report.failed.length > 0) process.exit(1);
    return;
  }

  console.log(`\n  DQL format migration${dryRun ? ' (dry run)' : ''}`);
  console.log('  ─────────────────────────────');
  console.log(`  Scanned:            ${report.scanned}`);
  console.log(`  Already canonical:  ${report.alreadyCanonical}`);
  console.log(`  ${dryRun ? 'Would upgrade' : 'Upgraded'}:     ${report.upgraded}`);
  if (report.failed.length > 0) {
    console.log(`  Failed:             ${report.failed.length}`);
    for (const f of report.failed) console.log(`    ✗ ${f.path}: ${f.error}`);
    process.exit(1);
  }
  console.log('');
}

function* walkDqlFiles(root: string): Generator<string> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'target') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && (entry.name.endsWith('.dql') || entry.name.endsWith('.dqlnb'))) {
        try {
          if (statSync(full).size > 0) yield full;
        } catch {
          // skip unreadable
        }
      }
    }
  }
}
