import { describe, it, expect } from 'vitest';
import { LineageGraph } from './lineage-graph.js';
import { buildLineageGraph } from './builder.js';
import {
  buildTrustChain,
  analyzeImpact,
  detectDomainFlows,
  getDomainTrustOverview,
} from './domain-lineage.js';

describe('LineageGraph', () => {
  it('adds and retrieves nodes', () => {
    const graph = new LineageGraph();
    graph.addNode({ id: 'block:revenue', type: 'block', name: 'revenue', domain: 'finance' });
    expect(graph.getNode('block:revenue')?.name).toBe('revenue');
    expect(graph.nodeCount).toBe(1);
  });

  it('adds edges and queries them', () => {
    const graph = new LineageGraph();
    graph.addNode({ id: 'table:orders', type: 'source_table', name: 'orders' });
    graph.addNode({ id: 'block:revenue', type: 'block', name: 'revenue' });
    graph.addEdge({ source: 'table:orders', target: 'block:revenue', type: 'reads_from' });

    expect(graph.getOutgoingEdges('table:orders')).toHaveLength(1);
    expect(graph.getIncomingEdges('block:revenue')).toHaveLength(1);
    expect(graph.edgeCount).toBe(1);
  });

  it('finds ancestors via BFS', () => {
    const graph = new LineageGraph();
    graph.addNode({ id: 'a', type: 'source_table', name: 'a' });
    graph.addNode({ id: 'b', type: 'block', name: 'b' });
    graph.addNode({ id: 'c', type: 'block', name: 'c' });
    graph.addEdge({ source: 'a', target: 'b', type: 'reads_from' });
    graph.addEdge({ source: 'b', target: 'c', type: 'feeds_into' });

    const ancestors = graph.ancestors('c');
    expect(ancestors.map((n) => n.id)).toContain('a');
    expect(ancestors.map((n) => n.id)).toContain('b');
  });

  it('finds descendants via BFS', () => {
    const graph = new LineageGraph();
    graph.addNode({ id: 'a', type: 'source_table', name: 'a' });
    graph.addNode({ id: 'b', type: 'block', name: 'b' });
    graph.addNode({ id: 'c', type: 'block', name: 'c' });
    graph.addEdge({ source: 'a', target: 'b', type: 'reads_from' });
    graph.addEdge({ source: 'b', target: 'c', type: 'feeds_into' });

    const descendants = graph.descendants('a');
    expect(descendants.map((n) => n.id)).toContain('b');
    expect(descendants.map((n) => n.id)).toContain('c');
  });

  it('finds shortest path between nodes', () => {
    const graph = new LineageGraph();
    graph.addNode({ id: 'a', type: 'source_table', name: 'a' });
    graph.addNode({ id: 'b', type: 'block', name: 'b' });
    graph.addNode({ id: 'c', type: 'block', name: 'c' });
    graph.addEdge({ source: 'a', target: 'b', type: 'reads_from' });
    graph.addEdge({ source: 'b', target: 'c', type: 'feeds_into' });

    expect(graph.pathBetween('a', 'c')).toEqual(['a', 'b', 'c']);
    expect(graph.pathBetween('c', 'a')).toEqual([]); // No reverse path
  });

  it('serializes to and from JSON', () => {
    const graph = new LineageGraph();
    graph.addNode({ id: 'block:test', type: 'block', name: 'test', domain: 'sales' });
    graph.addEdge({ source: 'block:test', target: 'block:test', type: 'certified_by' });

    const json = graph.toJSON();
    const restored = LineageGraph.fromJSON(json);
    expect(restored.nodeCount).toBe(1);
    expect(restored.edgeCount).toBe(1);
    expect(restored.getNode('block:test')?.domain).toBe('sales');
  });

  it('filters nodes by type', () => {
    const graph = new LineageGraph();
    graph.addNode({ id: 'table:a', type: 'source_table', name: 'a' });
    graph.addNode({ id: 'block:b', type: 'block', name: 'b' });
    graph.addNode({ id: 'metric:c', type: 'metric', name: 'c' });

    expect(graph.getNodesByType('block')).toHaveLength(1);
    expect(graph.getNodesByType('source_table')).toHaveLength(1);
  });

  it('extracts a subgraph', () => {
    const graph = new LineageGraph();
    graph.addNode({ id: 'a', type: 'block', name: 'a', domain: 'finance' });
    graph.addNode({ id: 'b', type: 'block', name: 'b', domain: 'sales' });
    graph.addNode({ id: 'c', type: 'block', name: 'c', domain: 'finance' });
    graph.addEdge({ source: 'a', target: 'b', type: 'feeds_into' });
    graph.addEdge({ source: 'a', target: 'c', type: 'feeds_into' });

    const sub = graph.subgraph((n) => n.domain === 'finance');
    expect(sub.nodeCount).toBe(2);
    expect(sub.edgeCount).toBe(1); // a→c only
  });
});

describe('buildLineageGraph', () => {
  it('builds a complete graph from blocks and metrics', () => {
    const graph = buildLineageGraph(
      [
        {
          name: 'raw_orders',
          sql: 'SELECT * FROM orders',
          domain: 'data',
          owner: 'data-team',
          status: 'certified',
          chartType: 'table',
        },
        {
          name: 'revenue_by_segment',
          sql: 'SELECT * FROM ref("raw_orders")',
          domain: 'finance',
          owner: 'finance-team',
          status: 'certified',
          chartType: 'bar',
        },
      ],
      [
        { name: 'total_revenue', table: 'orders', domain: 'finance', type: 'sum' },
      ],
      [
        { name: 'segment', table: 'orders' },
      ],
    );

    // Should have: 2 blocks + 1 metric + 1 dimension + 1 source table + 2 charts + 2 domains
    expect(graph.getNodesByType('block')).toHaveLength(2);
    expect(graph.getNodesByType('metric')).toHaveLength(1);
    expect(graph.getNodesByType('source_table')).toHaveLength(1);
    expect(graph.getNodesByType('chart')).toHaveLength(2);
    expect(graph.getNodesByType('domain')).toHaveLength(2);

    // raw_orders reads from orders table
    const rawEdges = graph.getIncomingEdges('block:raw_orders');
    expect(rawEdges.some((e) => e.source === 'table:orders')).toBe(true);

    // revenue_by_segment depends on raw_orders via ref()
    const revEdges = graph.getIncomingEdges('block:revenue_by_segment');
    expect(revEdges.some((e) => e.source === 'block:raw_orders' && e.type === 'feeds_into')).toBe(true);

    // Cross-domain edge: data → finance
    const crossDomain = graph.getCrossDomainEdges();
    expect(crossDomain.length).toBeGreaterThan(0);
    expect(crossDomain.some((e) => e.sourceDomain === 'data' && e.targetDomain === 'finance')).toBe(true);
  });

  it('connects semantic blocks to their metrics', () => {
    const graph = buildLineageGraph(
      [
        {
          name: 'arr_dashboard',
          sql: '',
          domain: 'executive',
          blockType: 'semantic',
          metricRef: 'arr_growth',
          chartType: 'line',
        },
      ],
      [
        { name: 'arr_growth', table: 'revenue', domain: 'finance', type: 'sum' },
      ],
      [],
    );

    const dashEdges = graph.getIncomingEdges('block:arr_dashboard');
    expect(dashEdges.some((e) => e.source === 'metric:arr_growth')).toBe(true);
  });
});

describe('Domain Lineage', () => {
  function buildTestGraph(): LineageGraph {
    return buildLineageGraph(
      [
        {
          name: 'raw_orders',
          sql: 'SELECT * FROM orders',
          domain: 'engineering',
          status: 'certified',
          owner: 'eng-team',
        },
        {
          name: 'clean_orders',
          sql: 'SELECT * FROM ref("raw_orders")',
          domain: 'data',
          status: 'certified',
          owner: 'data-team',
        },
        {
          name: 'revenue_metric_block',
          sql: 'SELECT * FROM ref("clean_orders")',
          domain: 'finance',
          status: 'draft',
          owner: 'finance-team',
          chartType: 'bar',
        },
      ],
      [],
      [],
    );
  }

  it('builds a trust chain across domains', () => {
    const graph = buildTestGraph();
    const chain = buildTrustChain(graph, 'block:raw_orders', 'block:revenue_metric_block');

    expect(chain).not.toBeNull();
    expect(chain!.nodes).toHaveLength(3);
    expect(chain!.certifiedCount).toBe(2); // raw_orders + clean_orders
    expect(chain!.uncertifiedCount).toBe(1); // revenue_metric_block is draft
    expect(chain!.trustScore).toBeCloseTo(2 / 3);
    expect(chain!.domainCrossings).toHaveLength(2); // engineering→data, data→finance
  });

  it('performs impact analysis across domains', () => {
    const graph = buildTestGraph();
    const impact = analyzeImpact(graph, 'block:raw_orders');

    expect(impact.totalAffected).toBeGreaterThanOrEqual(2);
    expect(impact.domainImpacts.length).toBeGreaterThanOrEqual(2);

    const financeDomain = impact.domainImpacts.find((d) => d.domain === 'finance');
    expect(financeDomain).toBeDefined();
    expect(financeDomain!.affectedNodes.length).toBeGreaterThanOrEqual(1);
  });

  it('detects cross-domain flows', () => {
    const graph = buildTestGraph();
    const flows = detectDomainFlows(graph);

    expect(flows.length).toBeGreaterThan(0);
    const engToData = flows.find((f) => f.from === 'engineering' && f.to === 'data');
    expect(engToData).toBeDefined();
  });

  it('calculates domain trust overview', () => {
    const graph = buildTestGraph();
    const overview = getDomainTrustOverview(graph, 'engineering');

    expect(overview.totalBlocks).toBe(1);
    expect(overview.certified).toBe(1);
    expect(overview.trustScore).toBe(1.0);
  });

  it('returns null trust chain when no path exists', () => {
    const graph = buildTestGraph();
    // These blocks exist but there's no path from finance back to engineering
    const chain = buildTrustChain(graph, 'block:revenue_metric_block', 'block:raw_orders');
    expect(chain).toBeNull();
  });

  it('handles empty domain trust overview', () => {
    const graph = buildTestGraph();
    const overview = getDomainTrustOverview(graph, 'nonexistent');
    expect(overview.totalBlocks).toBe(0);
    expect(overview.trustScore).toBe(0);
  });
});

describe('LineageGraph edge deduplication', () => {
  it('prevents duplicate edges with same source/target/type', () => {
    const graph = new LineageGraph();
    graph.addNode({ id: 'a', type: 'block', name: 'a' });
    graph.addNode({ id: 'b', type: 'block', name: 'b' });
    graph.addEdge({ source: 'a', target: 'b', type: 'feeds_into' });
    graph.addEdge({ source: 'a', target: 'b', type: 'feeds_into' }); // duplicate

    expect(graph.edgeCount).toBe(1);
  });

  it('allows different edge types between same nodes', () => {
    const graph = new LineageGraph();
    graph.addNode({ id: 'a', type: 'block', name: 'a', domain: 'sales' });
    graph.addNode({ id: 'b', type: 'block', name: 'b', domain: 'finance' });
    graph.addEdge({ source: 'a', target: 'b', type: 'feeds_into' });
    graph.addEdge({ source: 'a', target: 'b', type: 'crosses_domain' });

    expect(graph.edgeCount).toBe(2);
  });
});

describe('buildLineageGraph — normalizeTableName', () => {
  it('normalizes read_csv_auto paths to table names', () => {
    const graph = buildLineageGraph(
      [],
      [{ name: 'rev', table: "read_csv_auto('./data/revenue.csv')", domain: 'fin', type: 'sum' }],
      [],
    );
    const tables = graph.getNodesByType('source_table');
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe('revenue');
  });

  it('normalizes read_parquet paths to table names', () => {
    const graph = buildLineageGraph(
      [],
      [{ name: 'm', table: "read_parquet('./warehouse/events.parquet')", domain: 'd', type: 'count' }],
      [],
    );
    const tables = graph.getNodesByType('source_table');
    expect(tables[0].name).toBe('events');
  });

  it('leaves plain table names unchanged', () => {
    const graph = buildLineageGraph(
      [],
      [{ name: 'm', table: 'fct_orders', domain: 'd', type: 'sum' }],
      [],
    );
    const tables = graph.getNodesByType('source_table');
    expect(tables[0].name).toBe('fct_orders');
  });
});
