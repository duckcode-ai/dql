import { describe, it, expect } from 'vitest';
import { LineageGraph } from './lineage-graph.js';
import {
  classifyBlockChange,
  changedBlocksFromDiff,
  computeImpact,
  computeImpactFromDiff,
  renderImpactText,
} from './impact.js';
import { diffDQL } from '../format/diff.js';
import type { DiffChange } from '../format/diff.js';

/**
 * Build a small two-domain graph:
 *
 *   block:base (finance, certified)
 *     → block:mid (finance, certified)          feeds_into
 *       → block:sink (sales, certified)         feeds_into + crosses_domain
 *         → dashboard:exec (sales)              contains
 *   block:loose (finance, draft)  — standalone, not downstream of base
 */
function buildGraph(): LineageGraph {
  const g = new LineageGraph();
  g.addNode({ id: 'block:base', type: 'block', name: 'base', domain: 'finance', status: 'certified' });
  g.addNode({ id: 'block:mid', type: 'block', name: 'mid', domain: 'finance', status: 'certified' });
  g.addNode({ id: 'block:sink', type: 'block', name: 'sink', domain: 'sales', status: 'certified' });
  g.addNode({ id: 'dashboard:exec', type: 'dashboard', name: 'exec', domain: 'sales' });
  g.addNode({ id: 'block:loose', type: 'block', name: 'loose', domain: 'finance', status: 'draft' });

  g.addEdge({ source: 'block:base', target: 'block:mid', type: 'feeds_into' });
  g.addEdge({ source: 'block:mid', target: 'block:sink', type: 'feeds_into' });
  g.addEdge({
    source: 'block:mid',
    target: 'block:sink',
    type: 'crosses_domain',
    sourceDomain: 'finance',
    targetDomain: 'sales',
  });
  g.addEdge({ source: 'block:sink', target: 'dashboard:exec', type: 'contains' });
  return g;
}

describe('classifyBlockChange', () => {
  it('treats a query change as semantic', () => {
    const change: DiffChange = {
      kind: 'block-changed',
      name: 'base',
      fields: [{ path: 'query', before: 'a', after: 'b' }],
    };
    expect(classifyBlockChange(change)?.verdict).toBe('semantic');
  });

  it('treats a description-only change as non-semantic', () => {
    const change: DiffChange = {
      kind: 'block-changed',
      name: 'base',
      fields: [{ path: 'description', before: 'old', after: 'new' }],
    };
    expect(classifyBlockChange(change)?.verdict).toBe('non-semantic');
  });

  it('treats a tags + owner change as non-semantic', () => {
    const change: DiffChange = {
      kind: 'block-changed',
      name: 'base',
      fields: [
        { path: 'tags', before: 'a', after: 'a, b' },
        { path: 'owner', before: 'x', after: 'y' },
      ],
    };
    expect(classifyBlockChange(change)?.verdict).toBe('non-semantic');
  });

  it('is conservative: a mix of cosmetic + semantic is semantic', () => {
    const change: DiffChange = {
      kind: 'block-changed',
      name: 'base',
      fields: [
        { path: 'description', before: 'old', after: 'new' },
        { path: 'query', before: 'a', after: 'b' },
      ],
    };
    expect(classifyBlockChange(change)?.verdict).toBe('semantic');
  });

  it('treats added/removed blocks as structural semantic changes', () => {
    expect(classifyBlockChange({ kind: 'block-added', name: 'x' })).toMatchObject({
      verdict: 'semantic',
      structural: true,
    });
    expect(classifyBlockChange({ kind: 'block-removed', name: 'x' })).toMatchObject({
      verdict: 'semantic',
      structural: true,
    });
  });

  it('treats params / metricRef / tests changes as semantic', () => {
    for (const path of ['params.region', 'metricRef', 'metricsRef', 'tests[rev >]', 'visualization.title']) {
      const change: DiffChange = {
        kind: 'block-changed',
        name: 'base',
        fields: [{ path, before: 'a', after: 'b' }],
      };
      expect(classifyBlockChange(change)?.verdict).toBe('semantic');
    }
  });

  it('ignores non-block changes', () => {
    expect(classifyBlockChange({ kind: 'dashboard-added', title: 'd' })).toBeNull();
  });
});

describe('computeImpact — downstream walk', () => {
  it('lists the full transitive downstream set for a changed block', () => {
    const g = buildGraph();
    const report = computeImpact(g, [
      { name: 'base', verdict: 'semantic', changedFields: ['query'], structural: false },
    ]);
    const ids = report.downstream.map((n) => n.id);
    expect(ids).toContain('block:mid');
    expect(ids).toContain('block:sink');
    expect(ids).toContain('dashboard:exec');
    // `loose` is not downstream of base
    expect(ids).not.toContain('block:loose');
    // The changed block itself is not in its own downstream set
    expect(ids).not.toContain('block:base');
  });

  it('excludes domain nodes from the downstream set', () => {
    const g = buildGraph();
    g.addNode({ id: 'domain:finance', type: 'domain', name: 'finance' });
    g.addEdge({ source: 'block:base', target: 'domain:finance', type: 'crosses_domain' });
    const report = computeImpact(g, [
      { name: 'base', verdict: 'semantic', changedFields: ['query'], structural: false },
    ]);
    expect(report.downstream.map((n) => n.type)).not.toContain('domain');
  });
});

describe('computeImpact — cross-domain flagging', () => {
  it('flags the invalidated cross-domain edge finance → sales', () => {
    const g = buildGraph();
    const report = computeImpact(g, [
      { name: 'base', verdict: 'semantic', changedFields: ['query'], structural: false },
    ]);
    expect(report.crossDomainImpacts).toHaveLength(1);
    expect(report.crossDomainImpacts[0]).toMatchObject({ from: 'finance', to: 'sales' });
    expect(report.crossDomainImpacts[0].edges).toContainEqual({
      source: 'block:mid',
      target: 'block:sink',
    });
  });
});

describe('computeImpact — re-cert list', () => {
  it('lists certified downstream artifacts requiring re-cert', () => {
    const g = buildGraph();
    const report = computeImpact(g, [
      { name: 'base', verdict: 'semantic', changedFields: ['query'], structural: false },
    ]);
    const recertIds = report.requiresRecert.map((r) => r.id);
    expect(recertIds).toContain('block:mid');
    expect(recertIds).toContain('block:sink');
    // dashboard:exec has no status → not certified → not in re-cert list
    expect(recertIds).not.toContain('dashboard:exec');
    expect(report.hasCertifiedInvalidation).toBe(true);
    // attribution
    const mid = report.requiresRecert.find((r) => r.id === 'block:mid');
    expect(mid?.invalidatedBy).toEqual(['base']);
  });

  it('a non-semantic change produces no downstream impact and no re-cert', () => {
    const g = buildGraph();
    const report = computeImpact(g, [
      { name: 'base', verdict: 'non-semantic', changedFields: ['description'], structural: false },
    ]);
    expect(report.downstream).toHaveLength(0);
    expect(report.requiresRecert).toHaveLength(0);
    expect(report.crossDomainImpacts).toHaveLength(0);
    expect(report.hasCertifiedInvalidation).toBe(false);
  });

  it('does not require re-cert when downstream certified set is empty', () => {
    const g = new LineageGraph();
    g.addNode({ id: 'block:a', type: 'block', name: 'a', domain: 'x', status: 'certified' });
    g.addNode({ id: 'block:b', type: 'block', name: 'b', domain: 'x', status: 'draft' });
    g.addEdge({ source: 'block:a', target: 'block:b', type: 'feeds_into' });
    const report = computeImpact(g, [
      { name: 'a', verdict: 'semantic', changedFields: ['query'], structural: false },
    ]);
    expect(report.requiresRecert).toHaveLength(0);
    expect(report.hasCertifiedInvalidation).toBe(false);
  });

  it('by default does not re-trip the gate on already-pending downstream', () => {
    const g = new LineageGraph();
    g.addNode({ id: 'block:a', type: 'block', name: 'a', domain: 'x', status: 'certified' });
    g.addNode({
      id: 'block:b',
      type: 'block',
      name: 'b',
      domain: 'x',
      status: 'pending_recertification',
    });
    g.addEdge({ source: 'block:a', target: 'block:b', type: 'feeds_into' });
    const report = computeImpact(g, [
      { name: 'a', verdict: 'semantic', changedFields: ['query'], structural: false },
    ]);
    expect(report.hasCertifiedInvalidation).toBe(false);
    // …but counts it when ignoreAlreadyPending=false
    const strict = computeImpact(
      g,
      [{ name: 'a', verdict: 'semantic', changedFields: ['query'], structural: false }],
      { ignoreAlreadyPending: false },
    );
    expect(strict.hasCertifiedInvalidation).toBe(true);
  });
});

describe('computeImpact — domainTrust delta', () => {
  it('computes the trust drop when certified blocks are demoted', () => {
    const g = buildGraph();
    const report = computeImpact(g, [
      { name: 'base', verdict: 'semantic', changedFields: ['query'], structural: false },
    ]);
    const finance = report.domainTrustDelta.find((d) => d.domain === 'finance');
    const sales = report.domainTrustDelta.find((d) => d.domain === 'sales');

    // finance has 3 blocks (base, mid, loose); 2 certified (base, mid).
    // Only `mid` is downstream → demoted. base is the *source*, not demoted.
    expect(finance).toMatchObject({ total: 3, certifiedBefore: 2, certifiedAfter: 1 });
    expect(finance!.delta).toBeCloseTo(1 / 3 - 2 / 3, 5);

    // sales has 1 block (sink), certified → demoted → 0.
    expect(sales).toMatchObject({ total: 1, certifiedBefore: 1, certifiedAfter: 0 });
    expect(sales!.delta).toBeCloseTo(-1, 5);
  });
});

describe('computeImpactFromDiff + classification end-to-end', () => {
  const BASE = `block "base" {
    domain = "finance"
    type = "custom"
    query = """SELECT 1 AS x"""
  }`;

  it('a description-only edit yields a non-semantic verdict and no re-cert', () => {
    const after = `block "base" {
      domain = "finance"
      type = "custom"
      description = "now documented"
      query = """SELECT 1 AS x"""
    }`;
    const diff = diffDQL(BASE, after);
    const changed = changedBlocksFromDiff(diff.changes);
    expect(changed).toHaveLength(1);
    expect(changed[0].verdict).toBe('non-semantic');

    const g = buildGraph();
    const report = computeImpactFromDiff(g, diff.changes);
    expect(report.hasCertifiedInvalidation).toBe(false);
  });

  it('a query edit on `base` invalidates certified downstream', () => {
    const after = `block "base" {
      domain = "finance"
      type = "custom"
      query = """SELECT 2 AS x"""
    }`;
    const diff = diffDQL(BASE, after);
    const g = buildGraph();
    const report = computeImpactFromDiff(g, diff.changes);
    expect(report.semanticChanges).toContain('base');
    expect(report.hasCertifiedInvalidation).toBe(true);
  });
});

describe('renderImpactText', () => {
  it('renders downstream + re-cert sections', () => {
    const g = buildGraph();
    const report = computeImpact(g, [
      { name: 'base', verdict: 'semantic', changedFields: ['query'], structural: false },
    ]);
    const text = renderImpactText(report);
    expect(text).toContain('Impact Analysis');
    expect(text).toContain('Requires re-certification');
    expect(text).toContain('mid');
  });

  it('reports no re-cert for an empty report', () => {
    const report = computeImpact(new LineageGraph(), []);
    expect(renderImpactText(report)).toContain('No block changes detected.');
  });
});
