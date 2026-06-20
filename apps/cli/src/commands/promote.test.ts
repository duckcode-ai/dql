import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promoteArtifact } from './promote.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('promoteArtifact', () => {
  it('strips notebook run state and marks metadata shared', () => {
    const root = createProject();
    mkdirSync(join(root, 'notebooks'), { recursive: true });
    writeFileSync(join(root, 'notebooks', 'analysis.dqlnb'), JSON.stringify({
      version: 1,
      title: 'Analysis',
      metadata: { visibility: 'private', modifiedAt: '2026-06-20T00:00:00Z' },
      cells: [
        { id: 'sql-1', type: 'sql', content: 'SELECT 1', result: { rows: [{ value: 1 }] }, executionCount: 3 },
      ],
    }));

    const result = promoteArtifact(root, 'notebook', 'notebooks/analysis.dqlnb');
    const promoted = JSON.parse(readFileSync(join(root, result.path), 'utf-8'));

    expect(result.path).toBe('notebooks/analysis.dqlnb');
    expect(promoted.metadata.visibility).toBe('shared');
    expect(promoted.metadata.lifecycle).toBe('review');
    expect(promoted.metadata.modifiedAt).toBeUndefined();
    expect(promoted.cells[0].result).toBeUndefined();
    expect(promoted.cells[0].executionCount).toBeUndefined();
    expect(result.removedLocalState).toEqual(expect.arrayContaining(['result', 'executionCount', 'modifiedAt']));
  });

  it('promotes app visibility and removes private notebook refs', () => {
    const root = createProject();
    writeApp(root);

    const result = promoteArtifact(root, 'app', 'nba-analysis');
    const promoted = JSON.parse(readFileSync(join(root, result.path), 'utf-8'));

    expect(promoted.visibility).toBe('shared');
    expect(promoted.lifecycle).toBe('review');
    expect(promoted.notebooks).toEqual([
      { path: 'apps/nba-analysis/notebooks/shared.dqlnb', role: 'analysis', visibility: 'shared' },
    ]);
  });

  it('strips dashboard ai pins and promotes legacy GenUI options into display metadata', () => {
    const root = createProject();
    writeApp(root);
    const dashboardPath = join(root, 'apps', 'nba-analysis', 'dashboards', 'overview.dqld');
    writeFileSync(dashboardPath, JSON.stringify({
      version: 1,
      id: 'overview',
      metadata: { title: 'Overview', visibility: 'private', modifiedAt: '2026-06-20T00:00:00Z' },
      layout: {
        kind: 'grid',
        cols: 12,
        rowHeight: 80,
        items: [
          {
            i: 'scorers',
            x: 0, y: 0, w: 8, h: 4,
            block: { blockId: 'Top Scorers' },
            viz: {
              type: 'bar',
              options: {
                dqlGenUi: {
                  component: 'RankingPanel',
                  defaultVisualization: 'bar',
                  allowedVisualizations: ['bar', 'table'],
                  layoutIntent: 'wide',
                  rationale: 'Ranking panel for NBA scorers.',
                  trustState: 'certified',
                  reviewStatus: 'certified',
                },
              },
            },
            result: { rows: [] },
          },
          {
            i: 'pin',
            x: 8, y: 0, w: 4, h: 3,
            aiPin: { id: 'pin-1' },
            viz: { type: 'table' },
          },
        ],
      },
    }));

    const result = promoteArtifact(root, 'dashboard', 'nba-analysis/overview');
    const promoted = JSON.parse(readFileSync(join(root, result.path), 'utf-8'));

    expect(promoted.metadata.visibility).toBe('shared');
    expect(promoted.layout.items).toHaveLength(1);
    expect(promoted.layout.items[0].display).toMatchObject({
      mode: 'block_hint',
      component: 'RankingPanel',
      defaultVisualization: 'bar',
      trustState: 'certified',
    });
    expect(promoted.layout.items[0].viz.options.dqlGenUi).toBeUndefined();
    expect(promoted.layout.items[0].result).toBeUndefined();
    expect(result.removedLocalState).toEqual(expect.arrayContaining(['aiPin tiles', 'legacy dqlGenUi options', 'result', 'modifiedAt']));
  });
});

function createProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'dql-promote-'));
  tempDirs.push(root);
  writeFileSync(join(root, 'dql.config.json'), '{}\n');
  mkdirSync(join(root, 'apps', 'nba-analysis', 'dashboards'), { recursive: true });
  return root;
}

function writeApp(root: string): void {
  const appPath = join(root, 'apps', 'nba-analysis', 'dql.app.json');
  if (existsSync(appPath)) return;
  writeFileSync(appPath, JSON.stringify({
    version: 1,
    id: 'nba-analysis',
    name: 'NBA Analysis',
    visibility: 'private',
    domain: 'nba',
    lifecycle: 'draft',
    owners: ['analytics@local'],
    notebooks: [
      { path: 'apps/nba-analysis/notebooks/private.dqlnb', role: 'analysis', visibility: 'private' },
      { path: 'apps/nba-analysis/notebooks/shared.dqlnb', role: 'analysis', visibility: 'shared' },
    ],
    members: [{ userId: 'analytics@local', roles: ['owner'] }],
    roles: [{ id: 'owner' }],
    policies: [{
      id: 'read',
      domain: 'nba',
      minClassification: 'internal',
      allowedRoles: ['owner'],
      accessLevel: 'read',
    }],
    homepage: { type: 'dashboard', id: 'overview' },
  }, null, 2));
}
