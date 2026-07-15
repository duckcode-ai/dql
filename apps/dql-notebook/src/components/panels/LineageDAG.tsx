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
import { ShieldCheck } from 'lucide-react';
import { api } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import {
  NODE_TYPE_COLORS,
  TYPE_LABELS,
  TYPE_TITLES,
  EDGE_TYPE_COLORS,
  EDGE_TITLES,
  LAYER_ORDER,
  LINEAGE_NODE_TYPE_ORDER,
  TECHNICAL_LINEAGE_NODE_TYPES,
  BUSINESS_LINEAGE_NODE_TYPES,
  CONSUMPTION_LINEAGE_NODE_TYPES,
  getNodeLayer,
  type LineageNode,
  type LineageEdge,
  type LineageLayerName,
} from '../lineage/lineage-constants';

type LayoutMode = 'flow' | 'layered';
type Direction = 'LR' | 'TB';

const NODE_TYPE_FILTERS = [
  { type: 'term', label: 'Terms' },
  { type: 'business_view', label: 'Business Views' },
  { type: 'block', label: 'DQL Blocks' },
  { type: 'metric', label: 'Metrics' },
  { type: 'dimension', label: 'Dimensions' },
  { type: 'domain', label: 'Domains' },
  { type: 'source_table', label: 'Tables' },
  { type: 'dbt_source', label: 'dbt Sources' },
  { type: 'dbt_model', label: 'dbt Models' },
  { type: 'chart', label: 'Charts' },
  { type: 'notebook', label: 'Notebooks' },
  { type: 'dashboard', label: 'Dashboards' },
  { type: 'app', label: 'Apps' },
] as const;

const LINEAGE_PRESETS = [
  { key: 'all', label: 'All', types: LINEAGE_NODE_TYPE_ORDER },
  { key: 'technical', label: 'Technical', types: TECHNICAL_LINEAGE_NODE_TYPES },
  { key: 'business', label: 'Business', types: BUSINESS_LINEAGE_NODE_TYPES },
  { key: 'consumption', label: 'Consumption', types: CONSUMPTION_LINEAGE_NODE_TYPES },
] as const;

function layoutGraph(nodes: Node[], edges: Edge[], mode: LayoutMode = 'flow', direction: Direction = 'LR') {
  const graph = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  const isHorizontal = direction === 'LR';
  graph.setGraph({
    rankdir: direction,
    ranksep: mode === 'layered' ? 120 : (isHorizontal ? 80 : 60),
    nodesep: isHorizontal ? 40 : 50,
    marginx: 32,
    marginy: 32,
  });

  for (const node of nodes) {
    const opts: Record<string, unknown> = { width: 190, height: 58 };
    // In layered mode, assign a rank based on the node's lineage layer
    if (mode === 'layered' && node.data?.layer) {
      const layerIndex = LAYER_ORDER.indexOf(node.data.layer as LineageLayerName);
      if (layerIndex >= 0) opts.rank = layerIndex;
    }
    graph.setNode(node.id, opts);
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
      data: { ...node.data, direction },
    };
  });
}

// Prototype (Lineage Redesign) node card: type dot · mono name · uppercase
// type label in the type color · certified shield. 196px wide.
function DagNode({ data, selected }: NodeProps) {
  const nodeType = data.nodeType as string;
  const color = NODE_TYPE_COLORS[nodeType] ?? 'var(--color-text-tertiary)';
  const direction = (data.direction as Direction) ?? 'LR';
  const targetPos = direction === 'LR' ? Position.Left : Position.Top;
  const sourcePos = direction === 'LR' ? Position.Right : Position.Bottom;
  const dimmed = Boolean(data.dimmed);
  const certified = data.status === 'certified';
  return (
    <div
      style={{
        width: 196,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: 'var(--color-bg-card)',
        border: `1.5px solid ${selected ? 'var(--accent)' : 'var(--border-default)'}`,
        borderRadius: 9,
        padding: '9px 11px',
        boxShadow: selected ? '0 1px 6px rgba(107,93,211,0.16)' : '0 1px 4px rgba(26,26,26,0.05)',
        opacity: dimmed ? 0.3 : 1,
        transition: 'opacity 0.15s ease',
      }}
    >
      <Handle type="target" position={targetPos} style={{ width: 7, height: 7, background: color, border: 'none' }} />
      <span style={{ width: 8, height: 8, borderRadius: 999, background: color, flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span
          title={data.label as string}
          style={{ fontSize: 11.5, fontWeight: 650, color: 'var(--color-text-primary)', fontFamily: "'JetBrains Mono', monospace", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {data.label as string}
        </span>
        <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color }}>
          {TYPE_TITLES[nodeType] ?? nodeType}
        </span>
      </span>
      {certified ? <ShieldCheck size={12} color="var(--status-success)" strokeWidth={2} style={{ flexShrink: 0 }} /> : null}
      <Handle type="source" position={sourcePos} style={{ width: 7, height: 7, background: color, border: 'none' }} />
    </div>
  );
}

const nodeTypes = { dagNode: DagNode };

// Prototype filter chip: colored dot + label; toggled-off chips fade.
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
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        borderRadius: 999,
        border: '1px solid var(--color-border-primary)',
        background: 'var(--color-bg-card)',
        color: active ? 'var(--color-text-secondary)' : 'var(--color-text-muted)',
        fontSize: 11,
        fontWeight: 600,
        padding: '3.5px 10px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        opacity: active ? 1 : 0.45,
        transition: 'opacity 0.12s ease',
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: 999, background: color, flexShrink: 0 }} />
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
  const [visibleTypes, setVisibleTypes] = useState<Record<string, boolean>>(
    Object.fromEntries(LINEAGE_NODE_TYPE_ORDER.map((type) => [type, true])),
  );
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('flow');
  const [direction, setDirection] = useState<Direction>('LR');
  // Prototype directional focus: clicking a node dims everything that is not
  // an ancestor or descendant of it (computed client-side over visible edges).
  const [dimSelId, setDimSelId] = useState<string | null>(null);

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
        .filter((node) => visibleTypes[node.type] ?? true)
        .map((node) => node.id),
    );
    return {
      nodes: graphData.nodes.filter((node) => visibleNodeIds.has(node.id)),
      edges: graphData.edges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)),
    };
  }, [graphData, visibleTypes]);

  const activePreset = useMemo(() => {
    for (const preset of LINEAGE_PRESETS) {
      const allowed = new Set<string>(preset.types);
      const matchesPreset = LINEAGE_NODE_TYPE_ORDER.every((type) => (visibleTypes[type] ?? true) === allowed.has(type));
      if (matchesPreset) return preset.key;
    }
    return 'custom';
  }, [visibleTypes]);

  const applyPreset = useCallback((types: readonly string[]) => {
    const allowed = new Set(types);
    setVisibleTypes(Object.fromEntries(LINEAGE_NODE_TYPE_ORDER.map((type) => [type, allowed.has(type)])));
  }, []);

  const toggleType = useCallback((type: string) => {
    setVisibleTypes((current) => ({ ...current, [type]: !(current[type] ?? true) }));
  }, []);

  // Directional reachability for the focus dim: ancestors via reverse edges
  // ∪ descendants via forward edges (never the union of both per hop).
  const dimConnected = useMemo(() => {
    if (!dimSelId) return null;
    const up = new Set([dimSelId]);
    const down = new Set([dimSelId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const edge of filteredGraph.edges) {
        if (up.has(edge.target) && !up.has(edge.source)) { up.add(edge.source); grew = true; }
        if (down.has(edge.source) && !down.has(edge.target)) { down.add(edge.target); grew = true; }
      }
    }
    return new Set([...up, ...down]);
  }, [dimSelId, filteredGraph.edges]);

  useEffect(() => {
    const nodes: Node[] = filteredGraph.nodes.map((node) => ({
      id: node.id,
      type: 'dagNode',
      position: { x: 0, y: 0 },
      data: {
        label: node.name,
        nodeType: node.type,
        domain: node.domain,
        status: node.status,
        layer: getNodeLayer(node),
        dimmed: dimConnected ? !dimConnected.has(node.id) : false,
      },
    }));

    const edges: Edge[] = filteredGraph.edges.map((edge, index) => {
      const onPath = dimConnected ? dimConnected.has(edge.source) && dimConnected.has(edge.target) : false;
      const color = onPath ? 'var(--accent)' : EDGE_TYPE_COLORS[edge.type] ?? 'var(--color-text-tertiary)';
      return {
        id: `edge-${index}-${edge.source}-${edge.target}-${edge.type}`,
        source: edge.source,
        target: edge.target,
        style: {
          stroke: color,
          strokeWidth: onPath ? 2 : 1.5,
          opacity: dimConnected && !onPath ? 0.25 : 1,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color,
          width: 12,
          height: 12,
        },
      };
    });

    setRfNodes(layoutGraph(nodes, edges, layoutMode, direction));
    setRfEdges(edges);
  }, [filteredGraph, layoutMode, direction, dimConnected, setRfEdges, setRfNodes]);

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
    setDimSelId(null);
    dispatch({ type: 'SET_LINEAGE_FOCUS', nodeId: null });
  }, [dispatch, fullGraph]);

  // Prototype behavior: clicking a node dims off-path nodes on the visible
  // canvas (directional). Search matches and deep links still run the full
  // server-side focus query.
  const handleNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    setDimSelId(node.id);
    const lineageNode = filteredGraph.nodes.find((item) => item.id === node.id) ?? null;
    setSelectedNode(lineageNode);
  }, [filteredGraph.nodes]);

  const clearDim = useCallback(() => {
    setDimSelId(null);
    setSelectedNode(null);
  }, []);

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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--color-bg-primary)' }}>
      <div style={{ padding: 8, borderBottom: `1px solid ${t.headerBorder}`, background: t.sidebarBg }}>
        {/* Layout toggle + type filters */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {/* Layout mode toggle */}
          <div style={{ display: 'flex', borderRadius: 6, border: `1px solid ${t.headerBorder}`, overflow: 'hidden' }}>
            <button
              onClick={() => setLayoutMode('flow')}
              style={{
                padding: '4px 8px',
                fontSize: 10,
                fontWeight: 700,
                border: 'none',
                cursor: 'pointer',
                background: layoutMode === 'flow' ? 'var(--color-bg-tertiary)' : 'transparent',
                color: layoutMode === 'flow' ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
              }}
            >
              Flow
            </button>
            <button
              onClick={() => setLayoutMode('layered')}
              style={{
                padding: '4px 8px',
                fontSize: 10,
                fontWeight: 700,
                border: 'none',
                borderLeft: `1px solid ${t.headerBorder}`,
                cursor: 'pointer',
                background: layoutMode === 'layered' ? 'var(--color-bg-tertiary)' : 'transparent',
                color: layoutMode === 'layered' ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
              }}
            >
              Layered
            </button>
          </div>
          {/* Direction toggle — Horizontal (LR) vs Vertical (TB) */}
          <div style={{ display: 'flex', borderRadius: 6, border: `1px solid ${t.headerBorder}`, overflow: 'hidden', marginRight: 4 }}>
            <button
              title="Horizontal layout (left → right)"
              onClick={() => setDirection('LR')}
              style={{
                padding: '4px 8px',
                fontSize: 10,
                fontWeight: 700,
                border: 'none',
                cursor: 'pointer',
                background: direction === 'LR' ? 'var(--color-bg-tertiary)' : 'transparent',
                color: direction === 'LR' ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
                display: 'flex',
                alignItems: 'center',
                gap: 3,
              }}
            >
              {/* →→ horizontal icon */}
              <svg width="14" height="10" viewBox="0 0 14 10" fill="none">
                <rect x="0" y="2" width="4" height="6" rx="1" fill="currentColor" opacity="0.7"/>
                <line x1="4" y1="5" x2="10" y2="5" stroke="currentColor" strokeWidth="1.2"/>
                <path d="M9 3l2 2-2 2" stroke="currentColor" strokeWidth="1.2" fill="none"/>
                <rect x="10" y="2" width="4" height="6" rx="1" fill="currentColor"/>
              </svg>
              LR
            </button>
            <button
              title="Vertical layout (top → bottom)"
              onClick={() => setDirection('TB')}
              style={{
                padding: '4px 8px',
                fontSize: 10,
                fontWeight: 700,
                border: 'none',
                borderLeft: `1px solid ${t.headerBorder}`,
                cursor: 'pointer',
                background: direction === 'TB' ? 'var(--color-bg-tertiary)' : 'transparent',
                color: direction === 'TB' ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
                display: 'flex',
                alignItems: 'center',
                gap: 3,
              }}
            >
              {/* ↓ vertical icon */}
              <svg width="10" height="14" viewBox="0 0 10 14" fill="none">
                <rect x="2" y="0" width="6" height="4" rx="1" fill="currentColor" opacity="0.7"/>
                <line x1="5" y1="4" x2="5" y2="10" stroke="currentColor" strokeWidth="1.2"/>
                <path d="M3 9l2 2 2-2" stroke="currentColor" strokeWidth="1.2" fill="none"/>
                <rect x="2" y="10" width="6" height="4" rx="1" fill="currentColor"/>
              </svg>
              TB
            </button>
          </div>
          {/* Prototype segmented presets. */}
          <div role="group" aria-label="Lineage presets" style={{ display: 'inline-flex', alignItems: 'center', gap: 2, padding: 2, border: `1px solid ${t.headerBorder}`, borderRadius: 7, background: t.appBg, marginRight: 4 }}>
            {LINEAGE_PRESETS.map((preset) => (
              <button
                key={preset.key}
                onClick={() => applyPreset(preset.types)}
                style={{
                  padding: '4px 11px',
                  fontSize: 11.5,
                  fontWeight: 600,
                  border: 'none',
                  borderRadius: 5,
                  cursor: 'pointer',
                  fontFamily: t.font,
                  whiteSpace: 'nowrap',
                  background: activePreset === preset.key ? 'var(--accent-dim)' : 'transparent',
                  color: activePreset === preset.key ? t.accent : t.textMuted,
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>
          {NODE_TYPE_FILTERS.map((filter) => (
            <FilterChip
              key={filter.type}
              label={filter.label}
              active={visibleTypes[filter.type] ?? true}
              color={NODE_TYPE_COLORS[filter.type]}
              onClick={() => toggleType(filter.type)}
            />
          ))}
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
              background: 'var(--color-bg-sunken)',
              color: t.textPrimary,
              fontSize: 12,
              outline: 'none',
            }}
          />
          {(focalNode || dimSelId) && (
            <button
              onClick={resetFocus}
              style={{
                borderRadius: 7,
                border: `1px solid ${t.accent}`,
                background: 'var(--accent-dim)',
                color: t.accent,
                cursor: 'pointer',
                fontSize: 11.5,
                fontWeight: 650,
                padding: '6px 11px',
                whiteSpace: 'nowrap',
              }}
            >
              Show all
            </button>
          )}
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
                <span style={{ color: NODE_TYPE_COLORS[match.node.type] ?? 'var(--color-text-tertiary)', fontSize: 10, fontWeight: 700, marginRight: 8 }}>
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
          onPaneClick={clearDim}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.18 }}
          proOptions={{ hideAttribution: true }}
          style={{ background: 'var(--bg-canvas)' }}
        >
          {/* Prototype 22px dot grid. */}
          <Background color="var(--border-strong)" gap={22} size={1} />
          <Controls showInteractive={false} />
          <MiniMap
            nodeColor={(node) => NODE_TYPE_COLORS[(node.data?.nodeType as string) ?? 'source_table'] ?? 'var(--color-text-tertiary)'}
            maskColor="color-mix(in srgb, var(--color-bg-primary) 55%, transparent)"
            style={{ background: 'var(--color-bg-sunken)', border: '1px solid var(--color-border-primary)' }}
          />

          {/* Prototype overlays: focus card + node-type legend float on the
              viewport (ReactFlow Panels), never on the scrolling canvas. */}
          <Panel position="bottom-left">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
              {selectedNode ? (
                <div style={{ width: 264, background: 'var(--color-bg-card)', border: '1px solid var(--color-border-primary)', borderRadius: 11, boxShadow: '0 8px 26px rgba(26,26,26,0.13)', padding: '12px 14px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 999, background: NODE_TYPE_COLORS[selectedNode.type] ?? 'var(--color-text-tertiary)', flexShrink: 0 }} />
                    <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 700, color: 'var(--color-text-primary)', fontFamily: "'JetBrains Mono', monospace", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selectedNode.name}</span>
                    <button onClick={clearDim} title="Clear focus" style={{ width: 20, height: 20, borderRadius: 5, border: 'none', background: 'none', color: 'var(--color-text-tertiary)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0, flexShrink: 0 }}>×</button>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 3 }}>
                    {TYPE_TITLES[selectedNode.type] ?? selectedNode.type}
                    {selectedSummary ? ` · ${selectedSummary.incoming} upstream · ${selectedSummary.outgoing} downstream` : ''}
                  </div>
                  {selectedNode.domain ? (
                    <div style={{ fontSize: 11.5, color: 'var(--color-text-secondary)', lineHeight: 1.5, marginTop: 7 }}>Domain: {selectedNode.domain}</div>
                  ) : null}
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <button
                      onClick={() => { if (dimSelId) void focusNode(dimSelId); }}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 26, padding: '0 10px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 11, fontWeight: 650, cursor: 'pointer' }}
                    >
                      Focus this path
                    </button>
                    <button
                      onClick={() => dispatch({ type: 'OPEN_GLOBAL_AI', autoRun: { text: `Explain the lineage of ${selectedNode.name} — where does it come from and what consumes it?` } })}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 26, padding: '0 10px', borderRadius: 6, border: '1px solid var(--color-border-primary)', background: 'var(--color-bg-card)', color: 'var(--color-text-secondary)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
                    >
                      Ask about this
                    </button>
                  </div>
                </div>
              ) : null}
              <div
                style={{
                  display: 'flex',
                  gap: 12,
                  flexWrap: 'wrap',
                  maxWidth: 700,
                  background: 'color-mix(in srgb, var(--color-bg-card) 93%, transparent)',
                  border: '1px solid var(--color-border-primary)',
                  borderRadius: 8,
                  padding: '5px 11px',
                  color: 'var(--color-text-tertiary)',
                  fontSize: 10,
                }}
              >
                {NODE_TYPE_FILTERS.filter((filter) => visibleTypes[filter.type] ?? true).map((filter) => (
                  <span key={filter.type} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 999, background: NODE_TYPE_COLORS[filter.type], display: 'inline-block' }} />
                    {filter.label}
                  </span>
                ))}
              </div>
            </div>
          </Panel>
        </ReactFlow>
      </div>

      {/* Prototype status bar. */}
      <div style={{ height: 28, flexShrink: 0, borderTop: '1px solid var(--border-subtle)', background: 'var(--color-bg-card)', display: 'flex', alignItems: 'center', gap: 14, padding: '0 14px', fontSize: 10.5, color: 'var(--color-text-tertiary)' }}>
        <span>{filteredGraph.nodes.length} nodes · {filteredGraph.edges.length} edges{focalNode ? ` · focused on ${focalNode.name}` : ''}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--status-success)' }} />
          Compiled from the dbt manifest
        </span>
        <div style={{ flex: 1 }} />
        <span>Click a node to focus its path · click the canvas to clear</span>
      </div>
    </div>
  );
}
