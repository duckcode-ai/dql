import type { CLIFlags } from '../args.js';
import { createBlockStudioImportSession } from '../block-studio-import.js';

export async function runImport(source: string, rest: string[], flags: CLIFlags): Promise<void> {
  if (source !== 'sql') {
    console.error(`\n  ✗ Unknown import source: "${source}"`);
    console.error('    Supported sources in this build: sql');
    console.error('');
    process.exit(1);
  }

  const inputPath = rest[0] || flags.input;
  if (!inputPath) {
    console.error('\n  ✗ Missing SQL import path.');
    console.error('    Usage: dql import sql <file-or-folder> [--domain <name>] [--owner <name>]');
    console.error('');
    process.exit(1);
  }

  const session = createBlockStudioImportSession(process.cwd(), {
    sourceKind: 'raw-sql',
    inputPath,
    domain: flags.domain || 'imported',
    owner: flags.owner || '',
  });

  if (flags.format === 'json') {
    console.log(JSON.stringify(session, null, 2));
    return;
  }

  console.log('\n  DQL Import: SQL');
  console.log('  ─────────────────────────────');
  console.log(`  Session:     ${session.id}`);
  console.log(`  Source:      ${session.inputPath}`);
  console.log(`  Candidates:  ${session.candidates.length}`);
  console.log(`  Domain:      ${session.defaults.domain}`);
  if (session.defaults.owner) console.log(`  Owner:       ${session.defaults.owner}`);
  console.log('');
  for (const candidate of session.candidates) {
    const tables = candidate.lineage.sourceTables.length > 0
      ? candidate.lineage.sourceTables.join(', ')
      : 'not detected';
    const warnings = candidate.lineage.warnings.length > 0
      ? ` · ${candidate.lineage.warnings.join('; ')}`
      : '';
    console.log(`  • ${candidate.name}`);
    console.log(`    ${candidate.id} · confidence ${Math.round(candidate.confidence * 100)}% · tables: ${tables}${warnings}`);
  }
  console.log('');
  console.log('  Review in Block Studio Import, then run and save selected candidates as draft blocks.');
  console.log(`  Import cache: .dql/imports/${session.id}/`);
  console.log('');
}
