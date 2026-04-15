import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import Dagre from '@dagrejs/dagre';
import { api } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';

interface LineageNode {
  id: string;
  type: string;
  name: string;
  domain?: string;
  status?: string;
}

interface LineageEdge {
  source: string;
  target: string;
  type: string;
}

const NODE_TYPE_COLORS: Record<string, string> = {
  source_table: '#8b949e',
  dbt_model: '#ff7b72',
  dbt_source: '#79c0ff',
  block: '#56d364',
  metric: '#388bfd',
  dimension: '#e3b341',
  domain: '#d2a8ff',
  chart: '#f778ba',
  dashboard: '#d2a8ff',
};

const TYPE_LABELS: Record<string, string> = {
  source_table: 'TABLE',
  dbt_model: 'DBT',
  dbt_source: 'SOURCE',
  block: 'BLOCK',
  metric: 'METRIC',
  dimension: 'DIM',
  domain: 'DOMAIN',
  chart: 'CHART',
  dashboard: 'NOTEBOOK',
};

const TYPE_TITLES: Record<string, string> = {
  source_table: 'Source Table',
  dbt_model: 'dbt Model',
  dbt_source: 'dbt Source',
  block: 'DQL Block',
  metric: 'Metric',
  dimension: 'Dimension',
  domain: 'Business Domain',
  chart: 'Chart',
  dashboard: 'Notebook',
};

const EDGE_TYPE_COLORS: Record<string, string> = {
  reads_from: '#8b949e',
  feeds_into: '#56d364',
  aggregates: '#388bfd',
  visualizes: '#f778ba',
  depends_on: '#ff7b72',
  contains: '#d2a8ff',
  crosses_domain: '#d2a8ff',
};

const EDGE_TITLES: Record<string, string> = {
  reads_from: 'reads from',
  feeds_into: 'feeds into',
  aggregates: 'aggregates into',
  visualizes: 'visualizes',
  depends_on: 'dbt depends on',
  contains: 'notebook contains',
  crosses_domain: 'crosses domain',
};

function layoutGraph(nodes: Node[], edges: Edge[]) {
  const graph = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: 'LR', ranksep: 80, nodesep: 40, marginx: 32, marginy: 32 });

  for (const node of nodes) {
    graph.setNode(node.id, { width: 190, height: 58 });
  }
  for (const edge of edges) {
    graph.setEdge(edge.source, edge.target);
  }

  Dagre.layout(graph);

  return nodes.map((node) => {
    const position = graph.node(node.id);
    return {
      ...node,
      position: { x: position.x - 95, y: position.y - 29 },
    };
  });
}

function DagNode({ data, selected }: NodeProps) {
  const nodeType = data.nodeType as string;
  const color = NODE_TYPE_COLORS[nodeType] ?? '#8b949e';
  const label = TYPE_LABELS[nodeType] ?? nodeType.toUpperCase();
  return (
    <div
      style={{
        minWidth: 156,
        maxWidth: 220,
        background: '#161b22',
        border: `2px solid ${selected ? '#58a6ff' : color}`,
        borderRadius: 10,
        padding: '8px 10px',
        boxShadow: selected ? '0 0 0 1px rgba(88, 166, 255, 0.2)' : 'none',
      }}
    >
      <Handle type="target" position={Position.Left} style={{ width: 7, height: 7, background: color, border: 'none' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: '0.04em',
            color: '#0d1117',
            background: color,
            borderRadius: 4,
            padding: '2px 6px',
          }}
        >
          {label}
        </span>
        {(data.domain as string | undefined) && (
          <span style={{ color: '#8b949e', fontSize: 10 }}>
            {data.domain as string}
          </span>
        )}
      </div>
      <div
        style={{
          color: '#e6edf3',
          fontSize: 11,
          fontWeight: 600,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={data.label as string}
      >
        {data.label as string}
      </div>
      <div style={{ color: '#8b949e', fontSize: 10, marginTop: 3 }}>
        {TYPE_TITLES[nodeType] ?? nodeType}
      </div>
      <Handle type="source" position={Position.Right} style={{ width: 7, height: 7, background: color, border: 'none' }} />
    </div>
  );
}

const nodeTypes = { dagNode: DagNode };

function FilterChip({
  label,
  active,
  color,
  onClick,
}: {
  label: string;
  active: boolean;
  color: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        borderRadius: 999,
        border: `1px solid ${active ? color : '#30363d'}`,
        background: active ? `${color}22` : 'transparent',
        color: active ? color : '#8b949e',
        fontSize: 10,
        fontWeight: 700,
        padding: '4px 8px',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

export function LineageDAG() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];

  const [loading, setLoading] = useState(true);
  const [fullGraph, setFullGraph] = useState<{ nodes: LineageNode[]; edges: LineageEdge[] }>({ nodes: [], edges: [] });
  const [graphData, setGraphData] = useState<{ nodes: LineageNode[]; edges: LineageEdge[] }>({ nodes: [], edges: [] });
  const [focalNode, setFocalNode] = useState<LineageNode | null>(null);
  const [selectedNode, setSelectedNode] = useState<LineageNode | null>(null);
  const [search, setSearch] = useState('');
  const [matches, setMatches] = useState<Array<{ node: LineageNode; score: number }>>([]);
  const [visibleTypes, setVisibleTypes] = useState<Record<string, boolean>>({
    source_table: true,
    dbt_model: true,
    dbt_source: true,
    block: true,
    dashboard: true,
    domain: true,
  });

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const loadFullGraph = useCallback(async () => {
    setLoading(true);
    const data = await api.fetchLineage();
    const graph = { nodes: data.nodes ?? [], edges: data.edges ?? [] };
    setFullGraph(graph);
    setGraphData(graph);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadFullGraph();
  }, [loadFullGraph]);

  useEffect(() => {
    let cancelled = false;
    if (search.trim().length < 2) {
      setMatches([]);
      return;
    }
    void api.searchLineage(search.trim()).then((result) => {
      if (!cancelled) setMatches(result.matches ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [search]);

  const filteredGraph = useMemo(() => {
    const visibleNodeIds = new Set(
      graphData.nodes
        .filter((node) => visibleTypes[node.type] ?? false)
        .map((node) => node.id),
    );
    return {
      nodes: graphData.nodes.filter((node) => visibleNodeIds.has(node.id)),
      edges: graphData.edges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)),
    };
  }, [graphData, visibleTypes]);

  useEffect(() => {
    const nodes: Node[] = filteredGraph.nodes.map((node) => ({
      id: node.id,
      type: 'dagNode',
      position: { x: 0, y: 0 },
      data: {
        label: node.name,
        nodeType: node.type,
        domain: node.domain,
      },
    }));

    const edges: Edge[] = filteredGraph.edges.map((edge, index) => ({
      id: `edge-${index}-${edge.source}-${edge.target}-${edge.type}`,
      source: edge.source,
      target: edge.target,
      style: {
        stroke: EDGE_TYPE_COLORS[edge.type] ?? '#8b949e',
        strokeWidth: 1.6,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: EDGE_TYPE_COLORS[edge.type] ?? '#8b949e',
        width: 12,
        height: 12,
      },
    }));

    setRfNodes(layoutGraph(nodes, edges));
    setRfEdges(edges);
  }, [filteredGraph, setRfEdges, setRfNodes]);

  const focusNode = useCallback(async (nodeId: string) => {
    const result = await api.queryLineage({ focus: nodeId });
    setGraphData(result.graph ?? { nodes: [], edges: [] });
    setFocalNode(result.focalNode ?? null);
    setSelectedNode(result.focalNode ?? null);
    dispatch({ type: 'SET_LINEAGE_FOCUS', nodeId });
    setSearch('');
    setMatches([]);
  }, [dispatch]);

  useEffect(() => {
    if (!state.lineageFocusNodeId) return;
    void focusNode(state.lineageFocusNodeId);
  }, [focusNode, state.lineageFocusNodeId]);

  const resetFocus = useCallback(() => {
    setGraphData(fullGraph);
    setFocalNode(null);
    setSelectedNode(null);
    dispatch({ type: 'SET_LINEAGE_FOCUS', nodeId: null });
  }, [dispatch, fullGraph]);

  const handleNodeClick = useCallback(async (_event: React.MouseEvent, node: Node) => {
    await focusNode(node.id);
  }, [focusNode]);

  const selectedSummary = useMemo(() => {
    if (!selectedNode) return null;
    const incoming = graphData.edges.filter((edge) => edge.target === selectedNode.id).length;
    const outgoing = graphData.edges.filter((edge) => edge.source === selectedNode.id).length;
    return { incoming, outgoing };
  }, [graphData.edges, selectedNode]);

  if (loading) {
    return <div style={{ padding: 16, color: t.textMuted, fontSize: 12 }}>Loading lineage graph...</div>;
  }

  if (fullGraph.nodes.length === 0) {
    return <div style={{ padding: 16, color: t.textMuted, fontSize: 12 }}>No lineage graph available yet.</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0d1117' }}>
      <div style={{ padding: 8, borderBottom: `1px solid ${t.headerBorder}`, background: t.sidebarBg }}>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
          <FilterChip label="Tables" active={visibleTypes.source_table} color={NODE_TYPE_COLORS.source_table} onClick={() => setVisibleTypes((current) => ({ ...current, source_table: !current.source_table }))} />
          <FilterChip label="dbt Models" active={visibleTypes.dbt_model} color={NODE_TYPE_COLORS.dbt_model} onClick={() => setVisibleTypes((current) => ({ ...current, dbt_model: !current.dbt_model }))} />
          <FilterChip label="dbt Sources" active={visibleTypes.dbt_source} color={NODE_TYPE_COLORS.dbt_source} onClick={() => setVisibleTypes((current) => ({ ...current, dbt_source: !current.dbt_source }))} />
          <FilterChip label="DQL Blocks" active={visibleTypes.block} color={NODE_TYPE_COLORS.block} onClick={() => setVisibleTypes((current) => ({ ...current, block: !current.block }))} />
          <FilterChip label="Notebooks" active={visibleTypes.dashboard} color={NODE_TYPE_COLORS.dashboard} onClick={() => setVisibleTypes((current) => ({ ...current, dashboard: !current.dashboard }))} />
          <FilterChip label="Domains" active={visibleTypes.domain} color={NODE_TYPE_COLORS.domain} onClick={() => setVisibleTypes((current) => ({ ...current, domain: !current.domain }))} />
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search lineage and focus the graph..."
            style={{
              flex: 1,
              padding: '8px 10px',
              borderRadius: 6,
              border: `1px solid ${t.headerBorder}`,
              background: '#0d1117',
              color: t.textPrimary,
              fontSize: 12,
              outline: 'none',
            }}
          />
          {focalNode && (
            <button
              onClick={resetFocus}
              style={{
                borderRadius: 6,
                border: `1px solid ${t.headerBorder}`,
                background: 'transparent',
                color: t.textPrimary,
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 600,
                padding: '8px 10px',
              }}
            >
              Show All
            </button>
          )}
        </div>
        <div style={{ marginTop: 8, color: t.textMuted, fontSize: 11, lineHeight: 1.5 }}>
          This graph connects raw source tables and dbt DAGs to DQL blocks and the notebooks that consume them. Search to focus on a single path instead of scanning the full project graph.
        </div>

        {matches.length > 0 && (
          <div style={{ marginTop: 8, border: `1px solid ${t.headerBorder}`, borderRadius: 8, overflow: 'hidden' }}>
            {matches.slice(0, 8).map((match) => (
              <button
                key={match.node.id}
                onClick={() => void focusNode(match.node.id)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 10px',
                  background: 'transparent',
                  border: 'none',
                  borderTop: `1px solid ${t.headerBorder}`,
                  color: t.textPrimary,
                  cursor: 'pointer',
                }}
              >
                <span style={{ color: NODE_TYPE_COLORS[match.node.type] ?? '#8b949e', fontSize: 10, fontWeight: 700, marginRight: 8 }}>
                  {TYPE_LABELS[match.node.type] ?? match.node.type.toUpperCase()}
                </span>
                {match.node.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div style={{ flex: 1, position: 'relative' }}>
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={handleNodeClick}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.18 }}
          proOptions={{ hideAttribution: true }}
          style={{ background: '#0d1117' }}
        >
          <Background color="#21262d" gap={24} size={1} />
          <Controls showInteractive={false} />
          <MiniMap
            nodeColor={(node) => NODE_TYPE_COLORS[(node.data?.nodeType as string) ?? 'source_table'] ?? '#8b949e'}
            maskColor="rgba(0,0,0,0.55)"
            style={{ background: '#0d1117', border: '1px solid #30363d' }}
          />

          <Panel position="top-left">
            <div
              style={{
                background: 'rgba(13, 17, 23, 0.9)',
                border: '1px solid #30363d',
                borderRadius: 8,
                padding: '8px 10px',
                minWidth: 220,
                color: '#e6edf3',
                fontSize: 12,
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 4 }}>
                {focalNode ? focalNode.name : 'Full Lineage View'}
              </div>
              <div style={{ color: '#8b949e', fontSize: 11 }}>
                {graphData.nodes.length} node(s), {graphData.edges.length} edge(s)
              </div>
              <div style={{ color: '#8b949e', fontSize: 11, marginTop: 6, lineHeight: 1.5 }}>
                {focalNode
                  ? `Focused on ${TYPE_TITLES[focalNode.type] ?? focalNode.type}. Upstream shows provenance from tables/dbt; downstream shows DQL and notebook consumption.`
                  : 'Full project lineage across source tables, dbt, DQL blocks, and notebooks.'}
              </div>
              {selectedNode && selectedSummary && (
                <div style={{ marginTop: 8, color: '#8b949e', fontSize: 11 }}>
                  {selectedSummary.incoming} upstream, {selectedSummary.outgoing} downstream
                </div>
              )}
            </div>
          </Panel>

          <Panel position="bottom-left">
            <div
              style={{
                display: 'flex',
                gap: 10,
                background: 'rgba(13, 17, 23, 0.9)',
                border: '1px solid #30363d',
                borderRadius: 8,
                padding: '6px 10px',
                color: '#8b949e',
                fontSize: 10,
              }}
            >
              {Object.entries(EDGE_TYPE_COLORS).map(([type, color]) => (
                <span key={type} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ width: 10, height: 2, background: color, display: 'inline-block' }} />
                  {EDGE_TITLES[type] ?? type}
                </span>
              ))}
            </div>
          </Panel>
        </ReactFlow>
      </div>
    </div>
  );
}
