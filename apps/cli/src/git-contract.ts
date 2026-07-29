import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * UI-001, SEC-001, E2E-001: only local runtime, credential, and generated
 * artifacts are ignored. Git-owned Hint Graph evidence intentionally remains
 * outside this list.
 */
export const LOCAL_RUNTIME_GITIGNORE_RULES = [
  'node_modules/',
  'dql-manifest.json',
  '*.duckdb',
  '*.duckdb.wal',
  '*.run.json',
  '**/.dql/runs/',
  '**/.dql/cache/',
  '**/.dql/imports/',
  '**/.dql/local/',
  '**/.dql/runtimes/',
  '**/.dql/connectors/',
  '**/.dql/memory/',
  '**/.dql/migration-staging/',
  '**/.dql/docker-starter/',
  '**/.dql/oauth-credentials.json',
  '**/.dql/provider-settings.json',
  '**/.dql/mcp-servers.json',
  '**/.dql-user-prefs.json',
] as const;

export function isLegacyBroadDqlIgnore(line: string): boolean {
  return /^\s*\/?\.dql\/\s*$/.test(line);
}

export function isGovernedSourceFile(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  const name = normalized.split('/').at(-1) ?? normalized;
  if (!name || name === '.DS_Store') return false;
  if (/\.run\.json$/i.test(normalized)) return false;
  if (/\.(?:sqlite3?|duckdb|duckdb\.wal)$/i.test(normalized)) return false;
  return true;
}

export function renderDqlGitignore(existing: string): {
  content: string;
  changed: boolean;
  removedLegacyBroadIgnore: boolean;
} {
  const lines = existing.split(/\r?\n/);
  const removedLegacyBroadIgnore = lines.some(isLegacyBroadDqlIgnore);
  const next = lines.filter((line) => !isLegacyBroadDqlIgnore(line));
  for (const rule of LOCAL_RUNTIME_GITIGNORE_RULES) {
    if (!next.some((line) => line.trim() === rule)) next.push(rule);
  }
  const content = `${next.join('\n').replace(/\n+$/, '')}\n`;
  return { content, changed: content !== existing, removedLegacyBroadIgnore };
}

export function ensureDqlGitignore(projectRoot: string): {
  changed: boolean;
  removedLegacyBroadIgnore: boolean;
} {
  const gitignorePath = join(projectRoot, '.gitignore');
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : '';
  const rendered = renderDqlGitignore(existing);
  if (rendered.changed) writeFileSync(gitignorePath, rendered.content, 'utf-8');
  return {
    changed: rendered.changed,
    removedLegacyBroadIgnore: rendered.removedLegacyBroadIgnore,
  };
}
