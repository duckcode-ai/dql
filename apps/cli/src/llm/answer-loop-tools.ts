import {
  dqlToolNamesForSurface,
  expandGroundingFromCatalog,
  openMetadataCatalog,
  type AgentToolDefinition,
} from '@duckcodeailabs/dql-agent';
import { DQLContext } from '@duckcodeailabs/dql-mcp';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join, relative } from 'node:path';
import { buildAgentTools } from './tools.js';

export function createGroundingContextExpander(projectRoot: string) {
  return async (request: Parameters<typeof expandGroundingFromCatalog>[1]) => {
    const catalog = openMetadataCatalog(projectRoot);
    try {
      return expandGroundingFromCatalog(catalog, request);
    } finally {
      catalog.close();
    }
  };
}

export function buildAnswerLoopTools(projectRoot: string): AgentToolDefinition[] {
  const ctx = new DQLContext({ projectRoot });
  const allowed = new Set<string>(dqlToolNamesForSurface('answer_loop'));
  const catalogTools = buildAgentTools(ctx)
    .filter((tool) => allowed.has(tool.name));
  return [...catalogTools, projectSourceSearchTool(projectRoot)];
}

function projectSourceSearchTool(projectRoot: string): AgentToolDefinition {
  return {
    name: 'search_project_files',
    description:
      'Fast bounded ripgrep over the live DQL/dbt source tree. Use only when catalog and semantic search missed a likely block, metric, dimension, model, or join definition. Returns source paths and matching lines; it never executes or mutates files.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Business terms or identifiers to find in DQL, SQL, YAML, JSON, and Markdown sources.' },
        limit: { type: 'number', description: 'Maximum matching lines. Default 40, maximum 100.' },
      },
    },
    run: async (args) => {
      const input = objectArgs(args);
      const query = typeof input.query === 'string' ? input.query : '';
      const limit = typeof input.limit === 'number' ? Math.max(1, Math.min(100, Math.floor(input.limit))) : 40;
      const terms = sourceSearchTerms(query);
      if (terms.length === 0) return { query, matches: [], note: 'No distinctive search terms.' };
      const pattern = terms.map(escapeRegex).join('|');
      const lines = await runRipgrep(projectRoot, pattern, limit);
      return {
        query,
        terms,
        matches: lines.map((line) => ({
          path: line.path.startsWith('.')
            ? line.path.replace(/^\.\//, '')
            : relative(projectRoot, line.path) || line.path,
          line: line.line,
          text: line.text,
        })),
      };
    },
  };
}

const SOURCE_SEARCH_STOPWORDS = new Set([
  'what', 'which', 'where', 'show', 'give', 'from', 'with', 'that', 'this', 'have',
  'does', 'the', 'and', 'for', 'our', 'their', 'metric', 'metrics', 'data', 'answer',
]);

function sourceSearchTerms(query: string): string[] {
  return Array.from(new Set((query.toLowerCase().match(/[a-z0-9_]+/g) ?? [])
    .filter((term) => term.length > 2 && !SOURCE_SEARCH_STOPWORDS.has(term))))
    .slice(0, 8);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function runRipgrep(
  projectRoot: string,
  pattern: string,
  limit: number,
): Promise<Array<{ path: string; line: number; text: string }>> {
  const args = [
    '--line-number', '--no-heading', '--color', 'never', '--ignore-case', '--max-count', '5',
    '--glob', '*.{dql,sql,yml,yaml,json,md}',
    '--glob', '!.git/**', '--glob', '!node_modules/**', '--glob', '!dist/**', '--glob', '!target/**',
    '--glob', '!.dql/cache/**',
    pattern, '.',
  ];
  return new Promise((resolveSearch) => {
    const child = spawn('rg', args, { cwd: projectRoot, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    let settled = false;
    const finish = (value: Array<{ path: string; line: number; text: string }>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveSearch(value);
    };
    // This is a safety ceiling, not an interaction target: normal searches
    // finish in milliseconds. Give a CI-loaded machine enough time to start
    // rg so a real semantic definition is not incorrectly reported missing.
    const timer = setTimeout(() => {
      child.kill();
      finish([]);
    }, 4_000);
    child.stdout.on('data', (chunk: Buffer) => {
      if (output.length < 512_000) output += chunk.toString('utf8');
      else child.kill();
    });
    // Some minimal hosted and container runtimes do not ship ripgrep. The
    // governed answer flow must still find semantic definitions rather than
    // silently falling through to generated SQL.
    child.on('error', () => finish(runNativeSourceSearch(projectRoot, pattern, limit)));
    child.on('close', () => {
      const matches = output.split(/\r?\n/).flatMap((raw) => {
        const match = raw.match(/^(.*?):(\d+):(.*)$/);
        return match ? [{ path: match[1], line: Number(match[2]), text: match[3].trim().slice(0, 500) }] : [];
      }).slice(0, limit);
      finish(matches);
    });
  });
}

const SOURCE_FILE_PATTERN = /\.(dql|sql|yml|yaml|json|md)$/i;
const SOURCE_SEARCH_IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'target', '.dql']);

function runNativeSourceSearch(
  projectRoot: string,
  pattern: string,
  limit: number,
): Array<{ path: string; line: number; text: string }> {
  const matcher = new RegExp(pattern, 'i');
  const matches: Array<{ path: string; line: number; text: string }> = [];
  const directories = [projectRoot];
  let scannedFiles = 0;

  while (directories.length > 0 && matches.length < limit && scannedFiles < 5_000) {
    const directory = directories.pop();
    if (!directory) continue;
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (matches.length >= limit) break;
      const filePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SOURCE_SEARCH_IGNORED_DIRECTORIES.has(entry.name)) directories.push(filePath);
        continue;
      }
      if (!entry.isFile() || !SOURCE_FILE_PATTERN.test(entry.name)) continue;
      scannedFiles += 1;
      if (scannedFiles > 5_000) break;
      let source: string;
      try {
        source = readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }
      for (const [index, line] of source.split(/\r?\n/).entries()) {
        if (!matcher.test(line)) continue;
        matches.push({ path: filePath, line: index + 1, text: line.trim().slice(0, 500) });
        if (matches.length >= limit) break;
      }
    }
  }
  return matches;
}

function objectArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {};
}
