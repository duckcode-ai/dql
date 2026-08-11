import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  agentProjectSourceVersion,
  ensureAgentProjectReady,
  invalidateAgentProjectState,
  isAgentProjectIndexReady,
  queryAppSourceCatalog,
  recordAgentRuntimeVersion,
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

  it('invalidates persisted indexes once when the installed CLI version changes (CFG-003, E2E-005)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-agent-upgrade-'));
    roots.push(root);
    writeFileSync(join(root, 'dql-manifest.json'), JSON.stringify({
      manifestVersion: 1,
      dqlVersion: 'test',
      generatedAt: new Date(0).toISOString(),
      project: 'upgrade-state-test',
      projectRoot: root,
      blocks: {}, terms: {}, businessViews: {}, dashboards: {}, apps: {}, notebooks: {},
      metrics: {}, dimensions: {}, sources: {},
      lineage: { nodes: [], edges: [], domains: [], crossDomainFlows: [], domainTrust: {} },
    }));

    expect(recordAgentRuntimeVersion(root, '1.8.0')).toBe(true);
    const firstVersion = agentProjectSourceVersion(root);
    await ensureAgentProjectReady(root);
    expect(isAgentProjectIndexReady(root)).toBe(true);

    expect(recordAgentRuntimeVersion(root, '1.8.0')).toBe(false);
    expect(agentProjectSourceVersion(root)).toBe(firstVersion);
    expect(isAgentProjectIndexReady(root)).toBe(true);

    expect(recordAgentRuntimeVersion(root, '1.9.0')).toBe(true);
    expect(agentProjectSourceVersion(root)).not.toBe(firstVersion);
    expect(isAgentProjectIndexReady(root)).toBe(false);
    await ensureAgentProjectReady(root);
    expect(isAgentProjectIndexReady(root)).toBe(true);
  });

  it('API-014 PERF-001 rebuilds 4,000 current path-qualified blocks after watcher invalidation without warm traversal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-agent-current-blocks-'));
    roots.push(root);
    writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'current-blocks' }));
    writeFileSync(join(root, 'dql-manifest.json'), JSON.stringify({
      manifestVersion: 2,
      dqlVersion: 'stale',
      generatedAt: new Date(0).toISOString(),
      project: 'current-blocks',
      projectRoot: root,
      blocks: {}, blockDeclarations: [], terms: {}, businessViews: {}, dashboards: {}, apps: {}, notebooks: {},
      metrics: {}, dimensions: {}, sources: {},
      lineage: { nodes: [], edges: [], domains: [], crossDomainFlows: [], domainTrust: {} },
    }));
    mkdirSync(join(root, 'blocks', '_drafts', 'office'), { recursive: true });
    writeFileSync(join(root, 'blocks', '_drafts', 'office', 'manual.dql'), `block "Office Performance" {
  domain = "office"
  status = "draft"
  query = """SELECT 1 AS value"""
}`);
    writeFileSync(join(root, 'blocks', '_drafts', 'office', 'duplicate.dql'), `block "Office Performance" {
  domain = "office"
  status = "draft"
  query = """SELECT 2 AS value"""
}`);
    for (let index = 0; index < 4_000; index += 1) {
      writeFileSync(join(root, 'blocks', `scale-${String(index).padStart(4, '0')}.dql`), `block "Scale Block ${index}" {
  domain = "office"
  status = "draft"
  query = """SELECT ${index} AS value"""
}`);
    }

    const first = await ensureAgentProjectReady(root);
    const firstPage = queryAppSourceCatalog(root, { query: 'Office Performance', sourcePolicy: 'include_review_required' });
    const duplicateDeclarations = firstPage.items.filter((item) => item.name === 'Office Performance');
    expect(duplicateDeclarations).toHaveLength(2);
    expect(new Set(duplicateDeclarations.map((item) => item.sourcePath)).size).toBe(2);

    const latePath = join(root, 'blocks', 'scale-3999.dql');
    writeFileSync(latePath, `block "Office Late Position" {
  domain = "office"
  status = "draft"
  query = """SELECT 3 AS value"""
}`);
    // Warm version sampling is constant-time for block/domain roots. The
    // runtime's recursive watcher observes this edit and performs the same
    // explicit invalidation used here; no candidate request walks 4,000 files.
    expect(agentProjectSourceVersion(root)).toBe(first.sourceVersion);
    invalidateAgentProjectState(root);
    const refreshed = await ensureAgentProjectReady(root);
    expect(refreshed.cacheHit).toBe(false);
    expect(queryAppSourceCatalog(root, { query: 'Office Late Position', sourcePolicy: 'include_review_required' }).items)
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Office Late Position' })]));
  }, 15_000);
});
