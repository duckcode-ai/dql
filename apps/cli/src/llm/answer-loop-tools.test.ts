import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAnswerLoopTools } from './answer-loop-tools.js';

describe('answer-loop project source search', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('finds a live semantic definition before generated SQL discovery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-source-search-'));
    roots.push(root);
    mkdirSync(join(root, 'semantic-layer'), { recursive: true });
    writeFileSync(join(root, 'semantic-layer', 'metrics.yaml'), [
      'metrics:',
      '  - name: retained_customer_value',
      '    description: Customer lifetime contribution after refunds',
    ].join('\n'));
    mkdirSync(join(root, 'node_modules', 'ignored'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'ignored', 'copy.yaml'), 'retained_customer_value');

    const tool = buildAnswerLoopTools(root).find((candidate) => candidate.name === 'search_project_files');
    expect(tool).toBeDefined();
    const result = await tool!.run({ query: 'customer lifetime contribution' }) as {
      matches: Array<{ path: string; text: string }>;
    };
    expect(result.matches.some((match) => match.path === 'semantic-layer/metrics.yaml')).toBe(true);
    expect(result.matches.some((match) => match.path.includes('node_modules'))).toBe(false);
  });

  it('uses bounded native source search when ripgrep is unavailable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-source-search-fallback-'));
    roots.push(root);
    mkdirSync(join(root, 'semantic-layer'), { recursive: true });
    writeFileSync(join(root, 'semantic-layer', 'metrics.yaml'), [
      'metrics:',
      '  - name: retained_customer_value',
      '    description: Customer lifetime contribution after refunds',
    ].join('\n'));

    const originalPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const tool = buildAnswerLoopTools(root).find((candidate) => candidate.name === 'search_project_files');
      const result = await tool!.run({ query: 'customer lifetime contribution' }) as {
        matches: Array<{ path: string }>;
      };
      expect(result.matches.map((match) => match.path)).toContain('semantic-layer/metrics.yaml');
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('never returns project-local provider settings or secret-bearing source lines', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-source-search-secrets-'));
    roots.push(root);
    mkdirSync(join(root, '.dql'), { recursive: true });
    writeFileSync(join(root, '.dql', 'provider-settings.json'), JSON.stringify({ apiKey: 'live-secret-token' }));
    mkdirSync(join(root, 'models'), { recursive: true });
    writeFileSync(join(root, 'models', 'safe.yml'), [
      'description: API usage by customer',
      'api_key: should-not-leak',
    ].join('\n'));

    const tool = buildAnswerLoopTools(root).find((candidate) => candidate.name === 'search_project_files');
    const result = await tool!.run({ query: 'api key' }) as {
      matches: Array<{ path: string; text: string }>;
    };

    expect(result.matches.some((match) => match.path.includes('.dql'))).toBe(false);
    expect(result.matches.some((match) => match.text.includes('live-secret-token'))).toBe(false);
    expect(result.matches.some((match) => match.text.includes('should-not-leak'))).toBe(false);
    expect(result.matches.some((match) => match.text.includes('[REDACTED]'))).toBe(true);
  });
});
