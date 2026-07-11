import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import {
  canonicalize,
  canonicalizeNotebook,
  NodeKind,
  Parser,
  blockParameterDefinitions,
  applyDataLexMigration,
  resolveBlockParameterValues,
  planDataLexMigration,
  resolveDbtManifestPath,
} from '@duckcodeailabs/dql-core';
import type { CLIFlags } from '../args.js';
import { findProjectRoot } from '../local-runtime.js';
import { runImport } from './import.js';

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
  if (file === 'layout') {
    await runLayoutMigrate(flags);
    return;
  }
  if (file === 'parameters') {
    await runParameterMigrateCheck(flags);
    return;
  }
  if (file === 'datalex') {
    await runDataLexManifestMigration(flags);
    return;
  }
  // file is used as the source type for migration
  const source = file as MigrationSource;
  const validSources: MigrationSource[] = ['looker', 'tableau', 'dbt', 'metabase', 'raw-sql'];

  if (!validSources.includes(source)) {
    console.error(`\n  ✗ Unknown migration source: "${source}"`);
    console.error(`    Valid sources: ${validSources.join(', ')}`);
    console.error(`    Or: "format" to upgrade .dql/.dqlnb files to the canonical on-disk format`);
    console.error(`    Or: "layout --to domain-first --dry-run" to preview enterprise domain layout moves`);
    console.error(`    Or: "parameters --check" to audit legacy block parameter contracts`);
    console.error(`    Or: "datalex --input <datalex-manifest.json> [--apply]" for a dbt-first DQL v3 migration`);
    console.error('');
    process.exit(1);
  }

  if (source === 'raw-sql' && flags.input) {
    await runImport('sql', [flags.input], flags);
    return;
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
  console.log('    3. Run: dql validate blocks/migrated/example.dql');
  console.log('    4. Run: dql certify blocks/migrated/example.dql --connection <driver>');
  console.log('    4. Commit and push for certification');
  console.log('');
}

async function runDataLexManifestMigration(flags: CLIFlags): Promise<void> {
  const projectRoot = findProjectRoot(process.cwd());
  const datalexManifestPath = flags.datalexManifestPath || flags.input;
  if (!datalexManifestPath) {
    console.error('Usage: dql migrate datalex --input <datalex-manifest.json> [--dry-run|--apply]');
    process.exitCode = 1;
    return;
  }
  const absoluteDataLex = resolve(datalexManifestPath);
  if (!existsSync(absoluteDataLex)) {
    console.error(`DataLex manifest not found: ${absoluteDataLex}`);
    process.exitCode = 1;
    return;
  }
  const dbtManifestPath = resolveDbtManifestPath(projectRoot);
  if (!dbtManifestPath) {
    console.error('No dbt manifest found. Run dbt parse/compile or configure dql.config.json before migrating DataLex.');
    process.exitCode = 1;
    return;
  }
  const plan = planDataLexMigration({ projectRoot, datalexManifestPath: absoluteDataLex, dbtManifestPath });
  const apply = flags.apply === true && flags.dryRun !== true;
  const result = apply ? applyDataLexMigration(projectRoot, plan) : undefined;

  if (flags.format === 'json') {
    console.log(JSON.stringify({ mode: apply ? 'applied' : 'dry-run', plan, result }, null, 2));
    return;
  }
  console.log(`\n  DataLex → DQL dbt-first migration (${apply ? 'applied' : 'dry-run'})`);
  console.log(`    matched dbt entities: ${plan.report.matchedEntities.length}`);
  console.log(`    drafted DQL objects: ${plan.report.draftedObjects.length}`);
  console.log(`    dropped dbt mirrors: ${plan.report.droppedDbtMirrors.length}`);
  console.log(`    explicit losses: ${plan.report.losses.length}`);
  console.log(`    auto-certified: ${plan.report.autoCertified}`);
  if (apply) {
    console.log(`    wrote: ${result?.written.length ?? 0}; unchanged: ${result?.unchanged.length ?? 0}`);
  } else {
    console.log('    no files written; add --apply after reviewing the generated plan.');
  }
  for (const file of plan.files) console.log(`    ${file.kind}: ${file.path}`);
}

interface FormatMigrateReport {
  scanned: number;
  alreadyCanonical: number;
  upgraded: number;
  failed: Array<{ path: string; error: string }>;
  dryRun: boolean;
}

interface LayoutMove {
  source: string;
  target: string;
  kind: 'block' | 'term' | 'business-view';
  domain: string;
  status: 'move' | 'exists' | 'same';
}

interface LayoutMigrateReport {
  targetLayout: 'domain-first';
  dryRun: boolean;
  scanned: number;
  moves: LayoutMove[];
  skipped: LayoutMove[];
}

export interface ParameterMigrationIssue {
  path: string;
  block?: string;
  kind: 'undeclared_placeholder' | 'policy_without_definition' | 'incompatible_default' | 'ambiguous_semantic_filter' | 'duplicate_parameterized_contract';
  detail: string;
}

export interface ParameterMigrationReport {
  scanned: number;
  blocksWithParameters: number;
  issues: ParameterMigrationIssue[];
}

/**
 * A read-only migration audit. Existing blocks keep their legacy execution
 * defaults; the report identifies only the contracts that need a human review
 * before AI may adapt their values.
 */
export async function runParameterMigrateCheck(flags: CLIFlags): Promise<void> {
  const root = findProjectRoot(resolve(flags.input || process.cwd()));
  const report: ParameterMigrationReport = { scanned: 0, blocksWithParameters: 0, issues: [] };
  const contracts = new Map<string, Array<{ path: string; block: string }>>();

  for (const absPath of walkDqlFiles(root)) {
    if (!absPath.endsWith('.dql')) continue;
    report.scanned += 1;
    const source = readFileSync(absPath, 'utf-8');
    const program = new Parser(source, absPath).parse();
    for (const statement of program.statements) {
      if (statement.kind !== NodeKind.BlockDecl) continue;
      const block = statement;
      const path = relative(root, absPath) || absPath;
      const names = new Set(block.params?.params.map((parameter) => parameter.name) ?? []);
      const definitions = blockParameterDefinitions(block);
      if (definitions.length) report.blocksWithParameters += 1;

      for (const interpolation of block.query?.interpolations ?? []) {
        if (!names.has(interpolation.variableName)) {
          report.issues.push({
            path,
            block: block.name,
            kind: 'undeclared_placeholder',
            detail: `\${${interpolation.variableName}} is not declared in params.`,
          });
        }
      }
      for (const policy of block.parameterPolicy ?? []) {
        if (!names.has(policy.name)) {
          report.issues.push({
            path,
            block: block.name,
            kind: 'policy_without_definition',
            detail: `parameterPolicy.${policy.name} has no parameter declaration.`,
          });
        }
      }
      for (const error of resolveBlockParameterValues(definitions).errors) {
        report.issues.push({ path, block: block.name, kind: 'incompatible_default', detail: error });
      }
      if (block.blockType === 'semantic') {
        for (const binding of block.filterBindings ?? []) {
          if (!names.has(binding.filter)) {
            report.issues.push({
              path,
              block: block.name,
              kind: 'ambiguous_semantic_filter',
              detail: `filterBindings.${binding.filter} does not map to a typed parameter.`,
            });
          }
        }
      }

      const sql = block.query?.rawSQL
        ?.replace(/'(?:[^']|'')*'/g, '?')
        .replace(/\b\d+(?:\.\d+)?\b/g, '?')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      if (sql && definitions.length) {
        const signature = `${sql}::${definitions.map((parameter) => `${parameter.name}:${parameter.type}:${parameter.binding?.kind ?? 'unbound'}`).sort().join('|')}`;
        const entries = contracts.get(signature) ?? [];
        entries.push({ path, block: block.name });
        contracts.set(signature, entries);
      }
    }
  }

  for (const entries of contracts.values()) {
    if (entries.length < 2) continue;
    const detail = `Equivalent parameterized contract also appears in ${entries.map((entry) => `${entry.block} (${entry.path})`).join(', ')}.`;
    for (const entry of entries) {
      report.issues.push({ path: entry.path, block: entry.block, kind: 'duplicate_parameterized_contract', detail });
    }
  }

  if (flags.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('\n  DQL parameter migration audit');
    console.log('  ─────────────────────────────');
    console.log(`  Project: ${root}`);
    console.log(`  Scanned: ${report.scanned}`);
    console.log(`  Blocks with parameters: ${report.blocksWithParameters}`);
    console.log(`  Review issues: ${report.issues.length}`);
    for (const issue of report.issues.slice(0, 50)) {
      console.log(`    ✗ ${issue.path}${issue.block ? ` [${issue.block}]` : ''}: ${issue.detail}`);
    }
    if (report.issues.length > 50) console.log(`    ... ${report.issues.length - 50} more`);
    console.log('');
  }
  if (flags.check && report.issues.length) process.exitCode = 1;
}

export async function runLayoutMigrate(flags: CLIFlags): Promise<void> {
  if (flags.to !== 'domain-first') {
    throw new Error('Usage: dql migrate layout --to domain-first [--dry-run]');
  }

  const projectRoot = findProjectRoot(resolve(flags.input || process.cwd()));
  const dryRun = flags.dryRun === true || flags.force !== true;
  const report: LayoutMigrateReport = {
    targetLayout: 'domain-first',
    dryRun,
    scanned: 0,
    moves: [],
    skipped: [],
  };

  const legacyDirs: Array<{ dir: string; kind: LayoutMove['kind']; targetFolder: string }> = [
    { dir: 'blocks', kind: 'block', targetFolder: 'blocks' },
    { dir: 'terms', kind: 'term', targetFolder: 'terms' },
    { dir: 'business-views', kind: 'business-view', targetFolder: 'views' },
  ];

  for (const legacy of legacyDirs) {
    const root = join(projectRoot, legacy.dir);
    if (!existsSync(root)) continue;
    for (const sourcePath of walkDqlFiles(root)) {
      report.scanned += 1;
      const source = readFileSync(sourcePath, 'utf-8');
      const domain = inferDomainFromDql(source);
      const targetPath = join(projectRoot, 'domains', domain, legacy.targetFolder, basename(sourcePath));
      const relSource = relative(projectRoot, sourcePath);
      const relTarget = relative(projectRoot, targetPath);
      const status: LayoutMove['status'] = sourcePath === targetPath
        ? 'same'
        : existsSync(targetPath)
          ? 'exists'
          : 'move';
      const item: LayoutMove = {
        source: relSource,
        target: relTarget,
        kind: legacy.kind,
        domain,
        status,
      };
      if (status === 'move') {
        report.moves.push(item);
        if (!dryRun) {
          mkdirSync(dirname(targetPath), { recursive: true });
          renameSync(sourcePath, targetPath);
        }
      } else {
        report.skipped.push(item);
      }
    }
  }

  if (flags.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`\n  DQL layout migration to domain-first${dryRun ? ' (dry run)' : ''}`);
  console.log('  ─────────────────────────────');
  console.log(`  Project:       ${projectRoot}`);
  console.log(`  Scanned:       ${report.scanned}`);
  console.log(`  ${dryRun ? 'Would move' : 'Moved'}:    ${report.moves.length}`);
  console.log(`  Skipped:       ${report.skipped.length}`);
  if (report.moves.length > 0) {
    console.log('');
    for (const move of report.moves.slice(0, 25)) {
      console.log(`    ${move.source} -> ${move.target}`);
    }
    if (report.moves.length > 25) {
      console.log(`    ... ${report.moves.length - 25} more`);
    }
  }
  if (report.skipped.length > 0) {
    console.log('');
    console.log('  Skipped files:');
    for (const skipped of report.skipped.slice(0, 10)) {
      console.log(`    ${skipped.source} (${skipped.status})`);
    }
    if (report.skipped.length > 10) {
      console.log(`    ... ${report.skipped.length - 10} more`);
    }
  }
  if (dryRun && report.moves.length > 0) {
    console.log('  Re-run with --force to apply these file moves.');
  }
  console.log('');
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

function inferDomainFromDql(source: string): string {
  const match = source.match(/^\s*domain\s*=\s*"([^"]+)"/m);
  return slugifyDomain(match?.[1] || 'uncategorized');
}

function slugifyDomain(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'uncategorized';
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
