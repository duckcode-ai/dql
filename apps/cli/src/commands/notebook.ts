import { exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runNotebook(_flags: Record<string, unknown>) {
  // The notebook app lives at apps/notebook relative to the repo root
  // When installed as CLI, we look for the pre-built dist
  // When in dev (monorepo), we start the Vite dev server

  const notebookAppDir = resolve(__dirname, '../../../../apps/notebook');
  const distDir = resolve(__dirname, '../../../../apps/notebook/dist');

  if (existsSync(join(notebookAppDir, 'package.json'))) {
    // In monorepo dev mode — start Vite dev server
    console.log('Starting DQL Notebook...\n');
    const child = exec('pnpm dev', { cwd: notebookAppDir });
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
    process.on('SIGINT', () => { child.kill(); process.exit(0); });
  } else {
    console.error('Notebook app not found. Install @duckcodeailabs/dql-cli from the full DQL monorepo.');
    process.exit(1);
  }
}
