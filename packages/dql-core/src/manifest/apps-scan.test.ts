import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest } from './builder.js';

let projectRoot: string;

function writeBlock(name: string, body: string) {
  writeFileSync(
    join(projectRoot, 'blocks', `${name}.dql`),
    body,
    'utf-8',
  );
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dql-apps-scan-'));
  mkdirSync(join(projectRoot, 'blocks'), { recursive: true });
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'test' }));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('buildManifest with apps + dashboards', () => {
  it('returns empty apps/dashboards when apps/ is missing', () => {
    writeBlock('revenue_total', `block "revenue_total" { domain = "growth" sql = "SELECT 1 AS revenue" }`);
    const manifest = buildManifest({ projectRoot, dqlVersion: 'test' });
    expect(manifest.apps).toBeUndefined();
    expect(manifest.dashboards).toBeUndefined();
  });

  it('discovers apps and dashboards and resolves block refs', () => {
    writeBlock(
      'revenue_total',
      `block "revenue_total" {
  domain = "growth"
  type = "custom"
  query = """SELECT 1 AS revenue"""
}`,
    );

    const appDir = join(projectRoot, 'apps', 'growth-cxo');
    mkdirSync(join(appDir, 'dashboards'), { recursive: true });

    writeFileSync(join(appDir, 'dql.app.json'), JSON.stringify({
      version: 1,
      id: 'growth-cxo',
      name: 'Growth — CXO',
      domain: 'growth',
      owners: ['alice@acme.com'],
      members: [{ userId: 'alice@acme.com', roles: ['owner'] }],
      roles: [{ id: 'owner' }],
      policies: [],
      homepage: { type: 'dashboard', id: 'weekly-overview' },
    }));

    writeFileSync(join(appDir, 'dashboards', 'weekly-overview.dqld'), JSON.stringify({
      version: 1,
      id: 'weekly-overview',
      metadata: { title: 'Weekly Overview', domain: 'growth' },
      layout: {
        kind: 'grid',
        cols: 12,
        rowHeight: 80,
        items: [
          { i: 'kpi', x: 0, y: 0, w: 3, h: 2,
            block: { blockId: 'revenue_total' },
            viz: { type: 'single_value' } },
        ],
      },
    }));

    const manifest = buildManifest({ projectRoot, dqlVersion: 'test' });

    expect(Object.keys(manifest.blocks)).toContain('revenue_total');

    expect(Object.keys(manifest.apps ?? {})).toEqual(['growth-cxo']);
    expect(Object.keys(manifest.dashboards ?? {})).toEqual(['weekly-overview']);

    const dashboard = manifest.dashboards!['weekly-overview'];
    expect(dashboard.appId).toBe('growth-cxo');
    expect(dashboard.blockIds).toEqual(['revenue_total']);
    expect(dashboard.unresolvedRefs).toEqual([]);

    const app = manifest.apps!['growth-cxo'];
    expect(app.dashboards).toEqual(['weekly-overview']);
    expect(app.homepage).toEqual({ type: 'dashboard', id: 'weekly-overview' });

    // Lineage: app:growth-cxo node, dashboard:weekly-overview node, edge between.
    const ids = new Set(manifest.lineage.nodes.map((n) => n.id));
    expect(ids.has('app:growth-cxo')).toBe(true);
    expect(ids.has('dashboard:weekly-overview')).toBe(true);
    expect(ids.has('block:revenue_total')).toBe(true);

    const edge = manifest.lineage.edges.find(
      (e) => e.source === 'dashboard:weekly-overview' && e.target === 'app:growth-cxo',
    );
    expect(edge?.type).toBe('contains');

    const blockToDashboard = manifest.lineage.edges.find(
      (e) => e.source === 'block:revenue_total' && e.target === 'dashboard:weekly-overview',
    );
    expect(blockToDashboard?.type).toBe('contains');
  });

  it('records diagnostics for unresolved block refs and unknown homepage', () => {
    const appDir = join(projectRoot, 'apps', 'growth-cxo');
    mkdirSync(join(appDir, 'dashboards'), { recursive: true });
    writeFileSync(join(appDir, 'dql.app.json'), JSON.stringify({
      version: 1,
      id: 'growth-cxo',
      name: 'Growth',
      domain: 'growth',
      owners: ['alice@acme.com'],
      members: [{ userId: 'alice@acme.com', roles: ['owner'] }],
      roles: [{ id: 'owner' }],
      policies: [],
      homepage: { type: 'dashboard', id: 'does-not-exist' },
    }));
    writeFileSync(join(appDir, 'dashboards', 'd1.dqld'), JSON.stringify({
      version: 1,
      id: 'd1',
      metadata: { title: 'D1' },
      layout: {
        kind: 'grid',
        cols: 12,
        rowHeight: 80,
        items: [
          { i: 'a', x: 0, y: 0, w: 3, h: 2,
            block: { blockId: 'ghost' },
            viz: { type: 'line' } },
        ],
      },
    }));

    const manifest = buildManifest({ projectRoot, dqlVersion: 'test' });
    const messages = (manifest.diagnostics ?? []).map((d) => d.message);
    expect(messages.some((m) => m.includes('unresolved block refs: ghost'))).toBe(true);
    expect(messages.some((m) => m.includes('homepage references unknown dashboard "does-not-exist"'))).toBe(true);
  });
});
