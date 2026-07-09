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
});
