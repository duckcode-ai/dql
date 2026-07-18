import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  agentProjectSourceVersion,
  ensureAgentProjectReady,
  invalidateAgentProjectState,
  isAgentProjectIndexReady,
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
    expect(isAgentProjectIndexReady(root)).toBe(true);
    const second = await ensureAgentProjectReady(root);
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.sourceVersion).toBe(firstVersion);

    writeFileSync(join(root, 'dql-manifest.json'), JSON.stringify(manifest(new Date(Date.now() + 1_000).toISOString())));
    expect(isAgentProjectIndexReady(root)).toBe(false);
    const third = await ensureAgentProjectReady(root);
    expect(third.cacheHit).toBe(false);
    expect(third.sourceVersion).not.toBe(firstVersion);
    expect(isAgentProjectIndexReady(root)).toBe(true);
  });

  it('lets post-connect preparation and the first Ask share one in-flight rebuild (CTX-005, PERF-001)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-agent-shared-prepare-'));
    roots.push(root);
    writeFileSync(join(root, 'dql-manifest.json'), JSON.stringify({
      manifestVersion: 1,
      dqlVersion: 'test',
      generatedAt: new Date(0).toISOString(),
      project: 'shared-prepare-test',
      projectRoot: root,
      blocks: {}, terms: {}, businessViews: {}, dashboards: {}, apps: {}, notebooks: {},
      metrics: {}, dimensions: {}, sources: {},
      lineage: { nodes: [], edges: [], domains: [], crossDomainFlows: [], domainTrust: {} },
    }));

    const [postConnect, firstAsk] = await Promise.all([
      ensureAgentProjectReady(root),
      ensureAgentProjectReady(root),
    ]);

    expect(postConnect.cacheHit).toBe(false);
    expect(firstAsk.cacheHit).toBe(true);
    expect(firstAsk.sourceVersion).toBe(postConnect.sourceVersion);
    expect(firstAsk.metadataFingerprint).toBe(postConnect.metadataFingerprint);
    expect(firstAsk.kgFingerprint).toBe(postConnect.kgFingerprint);
  });
});
