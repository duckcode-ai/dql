import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { runBuild } from './build.js';

describe('runBuild', () => {
  it('writes an HTML bundle and metadata for a standalone block', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dql-build-'));
    const sourcePath = join(projectDir, 'sample.dql');
    const outDir = join(projectDir, 'out');

    writeFileSync(sourcePath, `block "Revenue Preview" {
  domain = "revenue"
  type = "custom"
  query = """
    SELECT 'Enterprise' AS segment, 100 AS revenue
  """
  visualization {
    chart = "bar"
    x = segment
    y = revenue
  }
}`);

    await runBuild(sourcePath, {
      check: false,
      chart: '',
      domain: '',
      format: 'json',
      help: false,
      open: null,
      input: '',
      outDir,
      owner: '',
      port: null,
      queryOnly: false,
      template: 'starter',
      connection: '',
      verbose: false,
      skipTests: false,
    });

    expect(readFileSync(join(outDir, 'index.html'), 'utf-8')).toContain('Revenue Preview');
    expect(readFileSync(join(outDir, 'dql-metadata.json'), 'utf-8')).toContain('Revenue Preview');
  });
});
