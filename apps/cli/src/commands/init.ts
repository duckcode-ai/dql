import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CLIFlags } from '../args.js';

const COMMAND_DIR = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = resolve(COMMAND_DIR, '../../../../templates/starter');

const TEXT_FILE_EXTENSIONS = new Set([
  '.json',
  '.md',
  '.yaml',
  '.yml',
  '.dql',
  '.gitignore',
  '.txt',
]);

export async function runInit(targetArg: string | null, flags: CLIFlags): Promise<void> {
  if (!existsSync(TEMPLATE_DIR)) {
    throw new Error(`Starter template not found at ${TEMPLATE_DIR}`);
  }

  const targetDir = resolve(targetArg || '.');
  const projectName = basename(targetDir) || 'dql-project';

  if (existsSync(targetDir)) {
    const contents = readdirSync(targetDir);
    if (contents.length > 0) {
      throw new Error(`Target directory is not empty: ${targetDir}`);
    }
  } else {
    mkdirSync(targetDir, { recursive: true });
  }

  cpSync(TEMPLATE_DIR, targetDir, { recursive: true });
  replaceTokens(targetDir, {
    '__PROJECT_NAME__': projectName,
  });

  if (flags.format === 'json') {
    console.log(JSON.stringify({
      project: projectName,
      path: targetDir,
      created: true,
      nextSteps: [
        `cd ${targetArg || '.'}`,
        'dql parse blocks/revenue_by_segment.dql',
        'dql preview blocks/revenue_by_segment.dql',
      ],
    }, null, 2));
    return;
  }

  console.log(`\n  ✓ Created DQL project: ${projectName}`);
  console.log(`    Path: ${targetDir}`);
  console.log('');
  console.log('  Next steps:');
  if (targetArg && targetArg !== '.') {
    console.log(`    1. cd ${targetArg}`);
    console.log('    2. dql parse blocks/revenue_by_segment.dql');
    console.log('    3. dql preview blocks/revenue_by_segment.dql');
  } else {
    console.log('    1. dql parse blocks/revenue_by_segment.dql');
    console.log('    2. dql preview blocks/revenue_by_segment.dql');
  }
  console.log('');
}

function replaceTokens(rootDir: string, replacements: Record<string, string>): void {
  const entries = readdirSync(rootDir);

  for (const entry of entries) {
    const fullPath = join(rootDir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      replaceTokens(fullPath, replacements);
      continue;
    }

    if (!shouldTreatAsText(fullPath)) {
      continue;
    }

    let content = readFileSync(fullPath, 'utf-8');
    for (const [token, value] of Object.entries(replacements)) {
      content = content.split(token).join(value);
    }
    writeFileSync(fullPath, content, 'utf-8');
  }
}

function shouldTreatAsText(filePath: string): boolean {
  const fileName = basename(filePath);
  if (fileName === '.gitignore') {
    return true;
  }

  const dot = fileName.lastIndexOf('.');
  const ext = dot >= 0 ? fileName.slice(dot) : '';
  return TEXT_FILE_EXTENSIONS.has(ext);
}
