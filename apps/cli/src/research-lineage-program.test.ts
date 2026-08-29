import { describe, expect, it, vi } from 'vitest';
import { LineageGraph } from '@duckcodeailabs/dql-core';
import {
  RESEARCH_LINEAGE_MAX_DEPTH,
  runResearchLineageProgramV1,
} from './research-lineage-program.js';

function graphFixture(): LineageGraph {
  const graph = new LineageGraph();
  graph.addNode({ id: 'dbt_source:raw_orders', type: 'dbt_source', name: 'raw_orders' });
  graph.addNode({ id: 'dbt_model:orders', type: 'dbt_model', name: 'orders' });
  graph.addNode({ id: 'metric:orders.gross_revenue', type: 'metric', name: 'orders.gross_revenue' });
  graph.addNode({ id: 'dashboard:revenue', type: 'dashboard', name: 'revenue' });
  graph.addEdge({ source: 'dbt_source:raw_orders', target: 'dbt_model:orders', type: 'depends_on' });
  graph.addEdge({ source: 'dbt_model:orders', target: 'metric:orders.gross_revenue', type: 'aggregates' });
  graph.addEdge({ source: 'metric:orders.gross_revenue', target: 'dashboard:revenue', type: 'visualizes' });
  return graph;
}

function run(target: string, overrides: Partial<Parameters<typeof runResearchLineageProgramV1>[0]> = {}) {
  return runResearchLineageProgramV1({
    graph: graphFixture(),
    graphFingerprint: 'graph:fixture',
    target,
    expectedSnapshotId: 'snapshot:one',
    currentSnapshotId: 'snapshot:one',
    snapshotFingerprint: 'snapshot:fixture',
    ...overrides,
  });
}

describe('Research lineage program V1', () => {
  it('resolves an exact same-snapshot semantic alias and records structural, non-causal zero-call evidence', () => {
    const result = run('semantic:orders:gross_revenue');

    expect(result.receipt).toMatchObject({
      version: 1,
      evidenceKind: 'lineage_graph',
      status: 'completed',
      resolution: 'canonical_alias',
      candidateCount: 1,
      targetType: 'metric',
      upstreamNodeCount: 2,
      downstreamNodeCount: 1,
      validator: {
        kind: 'structural_dependency',
        evaluated: true,
        outcome: 'dependency_observed',
        nonCausal: true,
      },
      zeroCallCounters: {
        providerCalls: 0,
        sqlExecutions: 0,
        warehouseExecutions: 0,
        repairAttempts: 0,
      },
    });
    expect(result.summary).toMatch(/does not establish a causal explanation/i);
  });

  it('returns typed ambiguous, missing, and stale results without a fuzzy fallback', () => {
    const ambiguous = graphFixture();
    ambiguous.addNode({ id: 'metric:a.gross_revenue', type: 'metric', name: 'gross_revenue' });
    ambiguous.addNode({ id: 'metric:b.gross_revenue', type: 'metric', name: 'gross_revenue' });
    expect(runResearchLineageProgramV1({
      graph: ambiguous,
      graphFingerprint: 'graph:ambiguous',
      target: 'gross_revenue',
    }).receipt).toMatchObject({ status: 'ambiguous', resolution: 'ambiguous', candidateCount: 2 });
    expect(run('semantic:missing:net_revenue').receipt).toMatchObject({ status: 'missing', resolution: 'missing', candidateCount: 0 });
    expect(run('metric:orders.gross_revenue', { currentSnapshotId: 'snapshot:two' }).receipt).toMatchObject({
      status: 'stale',
      resolution: 'stale',
      candidateCount: 0,
    });
    expect(run('metric:orders.gross_revenue', { snapshotStale: true }).receipt).toMatchObject({
      status: 'stale',
      resolution: 'stale',
      candidateCount: 0,
      zeroCallCounters: { providerCalls: 0, sqlExecutions: 0, warehouseExecutions: 0, repairAttempts: 0 },
    });
    expect(runResearchLineageProgramV1({ target: 'metric:orders.gross_revenue' }).receipt).toMatchObject({
      status: 'unavailable',
      resolution: 'unavailable',
      candidateCount: 0,
      zeroCallCounters: { providerCalls: 0, sqlExecutions: 0, warehouseExecutions: 0, repairAttempts: 0 },
    });
  });

  it('requires a completed bounded exact-name scan for a human-readable target', () => {
    expect(run('revenue').receipt).toMatchObject({
      status: 'completed', resolution: 'exact_name', candidateCount: 1,
    });

    const highCardinality = new LineageGraph();
    highCardinality.addNode({ id: 'dashboard:revenue', type: 'dashboard', name: 'Revenue Dashboard' });
    for (let index = 0; index < 5_000; index += 1) {
      highCardinality.addNode({ id: `dashboard:other_${index}`, type: 'dashboard', name: `Other dashboard ${index}` });
    }
    const allNodes = vi.spyOn(highCardinality, 'getAllNodes').mockImplementation(() => {
      throw new Error('bounded human-readable resolution must not materialize the graph');
    });
    const incomplete = runResearchLineageProgramV1({
      graph: highCardinality,
      graphFingerprint: 'graph:human-readable-high-cardinality',
      target: 'Revenue Dashboard',
      maxNodes: 4,
      maxEdges: 3,
      maxPaths: 2,
    });
    expect(allNodes).not.toHaveBeenCalled();
    expect(incomplete.receipt).toMatchObject({
      status: 'unavailable', resolution: 'unavailable', candidateCount: 1,
      zeroCallCounters: { providerCalls: 0, sqlExecutions: 0, warehouseExecutions: 0, repairAttempts: 0 },
    });
    expect(incomplete.summary).toMatch(/could not complete bounded exact-target resolution/i);

    const controller = new AbortController();
    const originalVisitNodes = highCardinality.visitNodes.bind(highCardinality);
    vi.spyOn(highCardinality, 'visitNodes').mockImplementation((visitor) => {
      let visited = 0;
      return originalVisitNodes((node) => {
        visited += 1;
        if (visited === 3) controller.abort(new Error('cancel bounded name resolution'));
        return visitor(node);
      });
    });
    expect(() => runResearchLineageProgramV1({
      graph: highCardinality,
      graphFingerprint: 'graph:human-readable-cancelled',
      target: 'Revenue Dashboard',
      signal: controller.signal,
    })).toThrow('cancel bounded name resolution');
  });

  it('never widens a qualified semantic target to a same-leaf metric in another model', () => {
    const decoy = graphFixture();
    decoy.addNode({ id: 'metric:marketing.gross_revenue', type: 'metric', name: 'gross_revenue' });
    decoy.addNode({ id: 'metric:gross_revenue', type: 'metric', name: 'gross_revenue' });

    const result = runResearchLineageProgramV1({
      graph: decoy,
      graphFingerprint: 'graph:qualified-decoy',
      target: 'semantic:orders:gross_revenue',
    });

    expect(result.receipt).toMatchObject({
      status: 'completed',
      resolution: 'canonical_alias',
      candidateCount: 1,
      targetType: 'metric',
    });
    // A regression to the old bare `gross_revenue` alias would be ambiguous
    // here, or worse select the marketing metric when the intended one is
    // absent. Qualified source/model authority must remain intact.
    const onlyDecoy = new LineageGraph();
    onlyDecoy.addNode({ id: 'metric:marketing.gross_revenue', type: 'metric', name: 'gross_revenue' });
    onlyDecoy.addNode({ id: 'metric:gross_revenue', type: 'metric', name: 'gross_revenue' });
    expect(runResearchLineageProgramV1({
      graph: onlyDecoy,
      graphFingerprint: 'graph:only-decoy',
      target: 'semantic:orders:gross_revenue',
    }).receipt).toMatchObject({ status: 'missing', resolution: 'missing', candidateCount: 0 });
  });

  it('bounds deep/cyclic graphs and reports truncation rather than looping or issuing a call', () => {
    const graph = graphFixture();
    graph.addNode({ id: 'dbt_model:cycle', type: 'dbt_model', name: 'cycle' });
    graph.addEdge({ source: 'dbt_model:cycle', target: 'dbt_model:orders', type: 'depends_on' });
    graph.addEdge({ source: 'dbt_model:orders', target: 'dbt_model:cycle', type: 'depends_on' });
    const cyclic = runResearchLineageProgramV1({
      graph,
      graphFingerprint: 'graph:cycle',
      target: 'metric:orders.gross_revenue',
      maxDepth: RESEARCH_LINEAGE_MAX_DEPTH,
      maxNodes: 96,
      maxEdges: 160,
    });
    expect(cyclic.receipt.status).toBe('completed');
    expect(cyclic.receipt.truncated).toBe(false);

    const truncated = run('metric:orders.gross_revenue', { maxDepth: 1, maxPaths: 1, maxNodes: 2, maxEdges: 1 });
    expect(truncated.receipt).toMatchObject({
      status: 'truncated',
      truncated: true,
      zeroCallCounters: { providerCalls: 0, sqlExecutions: 0, warehouseExecutions: 0, repairAttempts: 0 },
    });
    expect(truncated.receipt.upstreamPathCount).toBeLessThanOrEqual(1);
    expect(truncated.receipt.downstreamPathCount).toBeLessThanOrEqual(1);
  });

  it('shares the terminal-route cap across upstream and downstream traversal', () => {
    const graph = new LineageGraph();
    const root = 'metric:orders.gross_revenue';
    graph.addNode({ id: root, type: 'metric', name: 'orders.gross_revenue' });
    for (let index = 0; index < 8; index += 1) {
      const upstream = `dbt_model:upstream_${index}`;
      const downstream = `dashboard:downstream_${index}`;
      graph.addNode({ id: upstream, type: 'dbt_model', name: `upstream_${index}` });
      graph.addNode({ id: downstream, type: 'dashboard', name: `downstream_${index}` });
      graph.addEdge({ source: upstream, target: root, type: 'aggregates' });
      graph.addEdge({ source: root, target: downstream, type: 'visualizes' });
    }
    const result = runResearchLineageProgramV1({
      graph,
      graphFingerprint: 'graph:bidirectional-route-cap',
      target: root,
      maxDepth: 6,
      maxPaths: 12,
      maxNodes: 32,
      maxEdges: 32,
    });

    expect(result.receipt).toMatchObject({ status: 'truncated', truncated: true });
    expect(result.receipt.upstreamPathCount + result.receipt.downstreamPathCount).toBeLessThanOrEqual(12);
    expect(result.receipt.upstreamPathCount + result.receipt.downstreamPathCount).toBe(12);
    expect(result.receipt.upstreamPathCount).toBe(8);
    expect(result.receipt.downstreamPathCount).toBe(4);
  });

  it('caps high-fanout traversal before it scans a project-wide graph and honors cancellation', () => {
    const graph = new LineageGraph();
    graph.addNode({ id: 'metric:orders.gross_revenue', type: 'metric', name: 'orders.gross_revenue' });
    for (let index = 0; index < 5_000; index += 1) {
      const id = `dashboard:fanout_${index}`;
      graph.addNode({ id, type: 'dashboard', name: `fanout_${index}` });
      graph.addEdge({ source: 'metric:orders.gross_revenue', target: id, type: 'visualizes' });
    }
    // A direct qualified target is a map lookup. It must not scan all 5,001
    // graph nodes before the traversal caps take effect.
    const allNodes = vi.spyOn(graph, 'getAllNodes').mockImplementation(() => {
      throw new Error('qualified target resolution must not enumerate the graph');
    });
    const result = runResearchLineageProgramV1({
      graph,
      graphFingerprint: 'graph:fanout',
      target: 'metric:orders.gross_revenue',
      maxDepth: 6,
      maxPaths: 2,
      maxNodes: 4,
      maxEdges: 3,
    });
    expect(allNodes).not.toHaveBeenCalled();
    expect(result.receipt).toMatchObject({
      status: 'truncated',
      truncated: true,
      zeroCallCounters: { providerCalls: 0, sqlExecutions: 0, warehouseExecutions: 0, repairAttempts: 0 },
    });
    expect(result.receipt.traversedNodeCount).toBeLessThanOrEqual(3);
    expect(result.receipt.traversedEdgeCount).toBeLessThanOrEqual(3);
    expect(result.receipt.upstreamPathCount).toBeLessThanOrEqual(2);
    expect(result.receipt.downstreamPathCount).toBeLessThanOrEqual(2);

    const cancelled = AbortSignal.abort(new Error('stop bounded lineage work'));
    expect(() => runResearchLineageProgramV1({
      graph,
      graphFingerprint: 'graph:fanout-cancelled',
      target: 'metric:orders.gross_revenue',
      signal: cancelled,
    })).toThrow('stop bounded lineage work');
  });

  it('keeps target and graph content out of the portable receipt', () => {
    const target = 'customer secret revenue metric';
    const result = run(target, {
      graphFingerprint: '/private/office/revenue-lineage.graph',
      expectedSnapshotId: 'office customer snapshot',
      snapshotFingerprint: 'customer-specific source state',
    });
    const serialized = JSON.stringify(result.receipt);
    expect(serialized).not.toContain(target);
    expect(serialized).not.toContain('orders.gross_revenue');
    expect(serialized).not.toContain('raw_orders');
    expect(serialized).not.toContain('resultFingerprint');
    expect(serialized).not.toContain('executionReceipt');
    expect(serialized).not.toContain('/private/office/revenue-lineage.graph');
    expect(serialized).not.toContain('office customer snapshot');
    expect(serialized).not.toContain('customer-specific source state');
    expect(result.receipt.targetFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.receipt.graphFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.receipt.snapshotId).toMatch(/^[a-f0-9]{64}$/);
    expect(result.receipt.snapshotFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});
