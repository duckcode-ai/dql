import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  agentProjectSourceVersion,
  ensureAgentProjectReady,
  invalidateAgentProjectState,
} from './index.js';

describe('warm agent project state', () => {
  const roots: string[] = [];

  afterEach(() => {
    invalidateAgentProjectState();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('reuses one prepared index until a compiled source changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-agent-state-'));
    roots.push(root);
    const manifest = (generatedAt: string) => ({
      manifestVersion: 1,
      dqlVersion: 'test',
      generatedAt,
      project: 'warm-state-test',
      projectRoot: root,
      blocks: {}, terms: {}, businessViews: {}, dashboards: {}, apps: {}, notebooks: {},
      metrics: {}, dimensions: {}, sources: {},
      lineage: { nodes: [], edges: [], domains: [], crossDomainFlows: [], domainTrust: {} },
    });
    writeFileSync(join(root, 'dql-manifest.json'), JSON.stringify(manifest(new Date(0).toISOString())));

    const firstVersion = agentProjectSourceVersion(root);
    const first = await ensureAgentProjectReady(root);
    const second = await ensureAgentProjectReady(root);
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.sourceVersion).toBe(firstVersion);

    writeFileSync(join(root, 'dql-manifest.json'), JSON.stringify(manifest(new Date(Date.now() + 1_000).toISOString())));
    const third = await ensureAgentProjectReady(root);
    expect(third.cacheHit).toBe(false);
    expect(third.sourceVersion).not.toBe(firstVersion);
  });
});
