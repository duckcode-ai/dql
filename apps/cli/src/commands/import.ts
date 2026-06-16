import type { CLIFlags } from '../args.js';
import {
  createBlockStudioImportSession,
  writeBlockStudioImportCandidate,
  type BlockStudioImportCandidate,
} from '../block-studio-import.js';
import { saveBlockStudioArtifacts, validateBlockStudioSource } from '../local-runtime.js';

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
  const candidates = session.candidates.map((candidate) => {
    const validation = validateBlockStudioSource(candidate.dqlSource);
    const next = { ...candidate, validation };
    writeBlockStudioImportCandidate(process.cwd(), session.id, next);
    return next;
  });
  const saved: Array<{ candidateId: string; path: string }> = [];
  const errors: Array<{ candidateId: string; error: string }> = [];

  if (flags.save) {
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const validationErrors = validationErrorsFor(candidate);
      if (validationErrors.length > 0) {
        errors.push({ candidateId: candidate.id, error: validationErrors.join(' ') });
        continue;
      }
      try {
        const savedPath = saveBlockStudioArtifacts(process.cwd(), {
          source: candidate.dqlSource,
          name: candidate.name,
          domain: candidate.domain,
          description: candidate.description,
          owner: candidate.owner,
          tags: candidate.tags,
          lineage: candidate.lineage.sourceTables,
          importMeta: {
            importId: session.id,
            candidateId: candidate.id,
            sourceKind: candidate.sourceKind,
            sourcePath: candidate.sourcePath,
          },
        });
        const next = { ...candidate, reviewStatus: 'saved' as const, savedPath };
        candidates[index] = next;
        writeBlockStudioImportCandidate(process.cwd(), session.id, next);
        saved.push({ candidateId: candidate.id, path: savedPath });
      } catch (error) {
        errors.push({ candidateId: candidate.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  const validatedSession = { ...session, candidates };

  if (flags.format === 'json') {
    console.log(JSON.stringify({ session: validatedSession, saved, errors }, null, 2));
    return;
  }

  console.log('\n  DQL Import: SQL');
  console.log('  ─────────────────────────────');
  console.log(`  Session:     ${session.id}`);
  console.log(`  Source:      ${session.inputPath}`);
  console.log(`  Candidates:  ${validatedSession.candidates.length}`);
  console.log(`  Domain:      ${validatedSession.defaults.domain}`);
  if (validatedSession.defaults.owner) console.log(`  Owner:       ${validatedSession.defaults.owner}`);
  if (flags.save) {
    console.log(`  Saved:       ${saved.length}`);
    if (errors.length > 0) console.log(`  Needs fixes:  ${errors.length}`);
  }
  console.log('');
  for (const candidate of validatedSession.candidates) {
    const tables = candidate.lineage.sourceTables.length > 0
      ? candidate.lineage.sourceTables.join(', ')
      : 'not detected';
    const validationErrors = validationErrorsFor(candidate);
    const warningText = candidate.lineage.warnings.length > 0
      ? ` · ${candidate.lineage.warnings.join('; ')}`
      : '';
    const savedPath = saved.find((item) => item.candidateId === candidate.id)?.path;
    console.log(`  • ${candidate.name}`);
    console.log(`    ${candidate.id} · confidence ${Math.round(candidate.confidence * 100)}% · tables: ${tables}${warningText}`);
    if (validationErrors.length > 0) console.log(`    fix: ${validationErrors.join(' ')}`);
    if (savedPath) console.log(`    saved block: ${savedPath}`);
  }
  console.log('');
  if (flags.save) {
    console.log('  Saved candidates are local blocks. Run previews/tests, then certify when they pass.');
  } else {
    console.log('  Open in Block Studio Import, then run and save selected candidates as blocks.');
    console.log('  Or re-run with --save to save all valid candidates as blocks.');
  }
  console.log(`  Import cache: .dql/imports/${validatedSession.id}/`);
  console.log('');
  if (flags.save && errors.length > 0) process.exitCode = 1;
}

function validationErrorsFor(candidate: BlockStudioImportCandidate): string[] {
  const diagnostics = ((candidate.validation as any)?.diagnostics ?? []) as Array<{ severity?: string; message?: string }>;
  return diagnostics
    .filter((diagnostic) => diagnostic.severity === 'error')
    .map((diagnostic) => diagnostic.message || 'Candidate validation failed.');
}
