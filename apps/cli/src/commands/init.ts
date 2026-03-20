import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWelcomeNotebook, serializeNotebook } from '@duckcodeailabs/dql-notebook';
import type { CLIFlags } from '../args.js';
import { runNotebook } from './notebook.js';

const COMMAND_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGED_TEMPLATE_ROOT = resolve(COMMAND_DIR, '../assets/templates');
const REPO_TEMPLATE_ROOT = resolve(COMMAND_DIR, '../../../../templates');
const TEMPLATE_ROOT = existsSync(PACKAGED_TEMPLATE_ROOT) ? PACKAGED_TEMPLATE_ROOT : REPO_TEMPLATE_ROOT;

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
  const templateId = flags.template || 'starter';
  const templateDir = resolve(TEMPLATE_ROOT, templateId);

  if (!existsSync(templateDir)) {
    throw new Error(`Template "${templateId}" not found. Available templates: ${listTemplates().join(', ')}`);
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

  cpSync(templateDir, targetDir, { recursive: true });
  replaceTokens(targetDir, {
    '__PROJECT_NAME__': projectName,
  });
  ensureWelcomeNotebook(targetDir, projectName, templateId);

  if (flags.format === 'json') {
    console.log(JSON.stringify({
      project: projectName,
      path: targetDir,
      created: true,
      template: templateId,
      nextSteps: [
        `cd ${targetArg || '.'}`,
        'dql notebook',
        'dql parse blocks/revenue_by_segment.dql',
      ],
    }, null, 2));
    return;
  }

  console.log(`\n  ✓ Created DQL project: ${projectName}`);
  console.log(`    Path: ${targetDir}`);
  console.log(`    Template: ${templateId}`);
  console.log('');
  console.log('  Next steps:');
  if (targetArg && targetArg !== '.') {
    console.log(`    1. cd ${targetArg}`);
    console.log('    2. dql notebook');
    console.log('    3. dql parse blocks/revenue_by_segment.dql');
  } else {
    console.log('    1. dql notebook');
    console.log('    2. dql parse blocks/revenue_by_segment.dql');
  }
  console.log('');

  if (flags.open) {
    await runNotebook(targetDir, flags);
  }
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

function listTemplates(): string[] {
  if (!existsSync(TEMPLATE_ROOT)) {
    return [];
  }
  return readdirSync(TEMPLATE_ROOT).filter((entry) => statSync(join(TEMPLATE_ROOT, entry)).isDirectory()).sort();
}

function ensureWelcomeNotebook(targetDir: string, projectName: string, templateId: string): void {
  const notebookDir = join(targetDir, 'notebooks');
  mkdirSync(notebookDir, { recursive: true });
  const notebookPath = join(notebookDir, 'welcome.dqlnb');

  if (existsSync(notebookPath)) {
    return;
  }

  writeFileSync(notebookPath, serializeNotebook(createWelcomeNotebook(templateId, projectName)), 'utf-8');
}
