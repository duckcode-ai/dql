import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  MiniMap,
  Controls,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeProps,
  MarkerType,
  Panel,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import Dagre from '@dagrejs/dagre';
import { useNotebook } from '../../store/NotebookStore';
import { themes, type Theme } from '../../themes/notebook-theme';
import { api } from '../../api/client';

/* ── Color & label constants ──────────────────────────────────────── */

const NODE_TYPE_COLORS: Record<string, string> = {
  source_table: '#8b949e',
  block: '#56d364',
  metric: '#388bfd',
  dimension: '#e3b341',
  domain: '#d2a8ff',
  chart: '#f778ba',
};

const TYPE_LABELS: Record<string, string> = {
  source_table: 'TABLE',
  block: 'BLOCK',
  metric: 'METRIC',
  dimension: 'DIM',
  domain: 'DOMAIN',
  chart: 'CHART',
};

const STATUS_COLORS: Record<string, string> = {
  certified: '#56d364',
  draft: '#8b949e',
  review: '#e3b341',
  deprecated: '#f85149',
  pending_recertification: '#d29922',
};

const EDGE_TYPE_COLORS: Record<string, string> = {
  reads_from: '#8b949e',
  feeds_into: '#56d364',
  aggregates: '#388bfd',
  visualizes: '#f778ba',
  crosses_domain: '#d2a8ff',
};

/* ── API types ────────────────────────────────────────────────────── */

interface LineageNode {
  id: string;
  type: string;
  name: string;
  domain?: string;
  status?: string;
  owner?: string;
  metadata?: Record<string, unknown>;
}

interface LineageEdge {
  source: string;
  target: string;
  type: string;
  sourceDomain?: string;
  targetDomain?: string;
}

/* ── Dagre auto-layout ────────────────────────────────────────────── */

function layoutGraph(
  nodes: Node[],
  edges: Edge[],
  direction: 'TB' | 'LR' = 'LR',
): { nodes: Node[]; edges: Edge[] } {
  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, ranksep: 80, nodesep: 40, marginx: 40, marginy: 40 });

  for (const node of nodes) {
    const w = node.type === 'domainGroup' ? 200 : 180;
    const h = node.type === 'domainGroup' ? 60 : 56;
    g.setNode(node.id, { width: w, height: h });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  Dagre.layout(g);

  const laid = nodes.map((node) => {
    const pos = g.node(node.id);
    const w = node.type === 'domainGroup' ? 200 : 180;
    const h = node.type === 'domainGroup' ? 60 : 56;
    return {
      ...node,
      position: { x: pos.x - w / 2, y: pos.y - h / 2 },
    };
  });

  return { nodes: laid, edges };
}

/* ── Custom DAG Node ──────────────────────────────────────────────── */

function DAGNode({ data, selected }: NodeProps) {
  const nodeType = data.nodeType as string;
  const color = NODE_TYPE_COLORS[nodeType] ?? '#8b949e';
  const label = TYPE_LABELS[nodeType] ?? nodeType.slice(0, 5).toUpperCase();
  const name = data.label as string;
  const domain = data.domain as string | undefined;
  const status = data.status as string | undefined;
  const statusColor = status ? STATUS_COLORS[status] : undefined;
  const highlighted = data.highlighted as boolean;
  const dimmed = data.dimmed as boolean;

  return (
    <div
      style={{
        background: '#161b22',
        border: `2px solid ${selected ? '#58a6ff' : highlighted ? color : '#30363d'}`,
        borderRadius: 8,
        padding: '6px 10px',
        minWidth: 140,
        maxWidth: 200,
        opacity: dimmed ? 0.3 : 1,
        transition: 'opacity 0.2s, border-color 0.2s',
        cursor: 'pointer',
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: color, width: 6, height: 6, border: 'none' }} />

      {/* Type badge row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
        <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            color: '#0d1117',
            background: color,
            borderRadius: 3,
            padding: '1px 5px',
            letterSpacing: '0.5px',
          }}
        >
          {label}
        </span>
        {domain && (
          <span style={{ fontSize: 9, color: '#8b949e' }}>{domain}</span>
        )}
        {statusColor && (
          <span
            style={{
              marginLeft: 'auto',
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: statusColor,
              flexShrink: 0,
            }}
            title={status}
          />
        )}
      </div>

      {/* Name */}
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: '#e6edf3',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={name}
      >
        {name}
      </div>

      <Handle type="source" position={Position.Right} style={{ background: color, width: 6, height: 6, border: 'none' }} />
    </div>
  );
}

const nodeTypes = { dagNode: DAGNode };

/* ── Filter chips ─────────────────────────────────────────────────── */

function FilterChip({
  label,
  color,
  active,
  count,
  onClick,
}: {
  label: string;
  color: string;
  active: boolean;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        fontSize: 9,
        fontWeight: 600,
        padding: '2px 6px',
        borderRadius: 4,
        border: `1px solid ${active ? color : '#30363d'}`,
        background: active ? `${color}20` : 'transparent',
        color: active ? color : '#8b949e',
        cursor: 'pointer',
        transition: 'all 0.15s',
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: active ? color : '#484f58',
        }}
      />
      {label}
      <span style={{ fontWeight: 400, opacity: 0.7 }}>{count}</span>
    </button>
  );
}

/* ── Main component ───────────────────────────────────────────────── */

export function LineageDAG() {
  const { state } = useNotebook();
  const t = themes[state.themeMode];

  const [loading, setLoading] = useState(true);
  const [rawNodes, setRawNodes] = useState<LineageNode[]>([]);
  const [rawEdges, setRawEdges] = useState<LineageEdge[]>([]);
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([]);

  /* Filters */
  const [showTables, setShowTables] = useState(true);
  const [showBlocks, setShowBlocks] = useState(true);
  const [showMetrics, setShowMetrics] = useState(true);
  const [showDimensions, setShowDimensions] = useState(true);
  const [showCharts, setShowCharts] = useState(true);

  /* Selection & highlight */
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [highlightedIds, setHighlightedIds] = useState<Set<string>>(new Set());

  /* Detail panel */
  const [detailNode, setDetailNode] = useState<LineageNode | null>(null);
  const [ancestors, setAncestors] = useState<LineageNode[]>([]);
  const [descendants, setDescendants] = useState<LineageNode[]>([]);

  /* Load data */
  const loadLineage = useCallback(async () => {
    setLoading(true);
    const data = await api.fetchLineage();
    setRawNodes(data.nodes ?? []);
    setRawEdges(data.edges ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadLineage();
  }, [loadLineage]);

  /* Filter visibility */
  const typeFilter = useMemo(() => {
    const s = new Set<string>();
    if (showTables) s.add('source_table');
    if (showBlocks) s.add('block');
    if (showMetrics) s.add('metric');
    if (showDimensions) s.add('dimension');
    if (showCharts) s.add('chart');
    s.add('domain'); // always show domains
    return s;
  }, [showTables, showBlocks, showMetrics, showDimensions, showCharts]);

  /* Build React Flow nodes & edges when data or filters change */
  useEffect(() => {
    const visibleNodes = rawNodes.filter((n) => typeFilter.has(n.type));
    const visibleIds = new Set(visibleNodes.map((n) => n.id));

    const flowNodes: Node[] = visibleNodes.map((n) => ({
      id: n.id,
      type: 'dagNode',
      position: { x: 0, y: 0 },
      data: {
        label: n.name,
        nodeType: n.type,
        domain: n.domain,
        status: n.status,
        owner: n.owner,
        highlighted: highlightedIds.has(n.id),
        dimmed: highlightedIds.size > 0 && !highlightedIds.has(n.id),
      },
    }));

    const flowEdges: Edge[] = rawEdges
      .filter(
        (e) =>
          visibleIds.has(e.source) &&
          visibleIds.has(e.target) &&
          e.type !== 'crosses_domain',
      )
      .map((e, i) => ({
        id: `e-${i}`,
        source: e.source,
        target: e.target,
        type: 'default',
        animated: e.type === 'feeds_into',
        style: {
          stroke: EDGE_TYPE_COLORS[e.type] ?? '#30363d',
          strokeWidth: highlightedIds.size > 0
            ? (highlightedIds.has(e.source) && highlightedIds.has(e.target) ? 2.5 : 0.5)
            : 1.5,
          opacity: highlightedIds.size > 0
            ? (highlightedIds.has(e.source) && highlightedIds.has(e.target) ? 1 : 0.15)
            : 0.7,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 12,
          height: 12,
          color: EDGE_TYPE_COLORS[e.type] ?? '#30363d',
        },
      }));

    if (flowNodes.length > 0) {
      const laid = layoutGraph(flowNodes, flowEdges, 'LR');
      setRfNodes(laid.nodes);
      setRfEdges(laid.edges);
    } else {
      setRfNodes([]);
      setRfEdges([]);
    }
  }, [rawNodes, rawEdges, typeFilter, highlightedIds, setRfNodes, setRfEdges]);

  /* Click a node → highlight upstream/downstream */
  const handleNodeClick = useCallback(
    async (_: React.MouseEvent, node: Node) => {
      if (selectedNodeId === node.id) {
        // Deselect
        setSelectedNodeId(null);
        setHighlightedIds(new Set());
        setDetailNode(null);
        setAncestors([]);
        setDescendants([]);
        return;
      }

      setSelectedNodeId(node.id);

      const raw = rawNodes.find((n) => n.id === node.id);
      setDetailNode(raw ?? null);

      // Compute upstream/downstream by walking edges
      const upIds = new Set<string>();
      const downIds = new Set<string>();

      function walkUp(id: string) {
        for (const e of rawEdges) {
          if (e.target === id && e.type !== 'crosses_domain' && !upIds.has(e.source)) {
            upIds.add(e.source);
            walkUp(e.source);
          }
        }
      }

      function walkDown(id: string) {
        for (const e of rawEdges) {
          if (e.source === id && e.type !== 'crosses_domain' && !downIds.has(e.target)) {
            downIds.add(e.target);
            walkDown(e.target);
          }
        }
      }

      walkUp(node.id);
      walkDown(node.id);

      const allHighlighted = new Set([node.id, ...upIds, ...downIds]);
      setHighlightedIds(allHighlighted);

      setAncestors(rawNodes.filter((n) => upIds.has(n.id)));
      setDescendants(rawNodes.filter((n) => downIds.has(n.id)));

      // Also try to get richer detail from API if it's a block
      if (raw?.type === 'block') {
        const detail = await api.fetchBlockLineage(raw.name);
        if (detail) {
          setAncestors(detail.ancestors ?? []);
          setDescendants(detail.descendants ?? []);
        }
      }
    },
    [selectedNodeId, rawNodes, rawEdges],
  );

  /* Click background → deselect */
  const handlePaneClick = useCallback(() => {
    setSelectedNodeId(null);
    setHighlightedIds(new Set());
    setDetailNode(null);
    setAncestors([]);
    setDescendants([]);
  }, []);

  /* Counts */
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const n of rawNodes) {
      c[n.type] = (c[n.type] ?? 0) + 1;
    }
    return c;
  }, [rawNodes]);

  if (loading) {
    return (
      <div style={{ padding: 16, color: t.textMuted, fontSize: 12, height: '100%' }}>
        Loading lineage graph...
      </div>
    );
  }

  if (rawNodes.length === 0) {
    return (
      <div style={{ padding: 16, color: t.textMuted, fontSize: 12, height: '100%' }}>
        No lineage data. Add DQL blocks or run <code>dql compile</code> to generate lineage.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0d1117' }}>
      {/* Filter bar */}
      <div
        style={{
          display: 'flex',
          gap: 4,
          padding: '6px 8px',
          flexWrap: 'wrap',
          borderBottom: `1px solid ${t.headerBorder}`,
          background: t.sidebarBg,
          flexShrink: 0,
        }}
      >
        <FilterChip label="Tables" color={NODE_TYPE_COLORS.source_table} active={showTables} count={counts.source_table ?? 0} onClick={() => setShowTables(!showTables)} />
        <FilterChip label="Blocks" color={NODE_TYPE_COLORS.block} active={showBlocks} count={counts.block ?? 0} onClick={() => setShowBlocks(!showBlocks)} />
        <FilterChip label="Metrics" color={NODE_TYPE_COLORS.metric} active={showMetrics} count={counts.metric ?? 0} onClick={() => setShowMetrics(!showMetrics)} />
        <FilterChip label="Dims" color={NODE_TYPE_COLORS.dimension} active={showDimensions} count={counts.dimension ?? 0} onClick={() => setShowDimensions(!showDimensions)} />
        <FilterChip label="Charts" color={NODE_TYPE_COLORS.chart} active={showCharts} count={counts.chart ?? 0} onClick={() => setShowCharts(!showCharts)} />
      </div>

      {/* Graph */}
      <div style={{ flex: 1, position: 'relative' }}>
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={handleNodeClick}
          onPaneClick={handlePaneClick}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.1}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          style={{ background: '#0d1117' }}
        >
          <Background color="#21262d" gap={24} size={1} />
          <Controls
            showInteractive={false}
            style={{
              button: { background: '#161b22', color: '#e6edf3', border: '1px solid #30363d' },
            } as any}
          />
          <MiniMap
            nodeColor={(n) => {
              const nt = n.data?.nodeType as string;
              return NODE_TYPE_COLORS[nt] ?? '#8b949e';
            }}
            maskColor="rgba(0,0,0,0.6)"
            style={{ background: '#0d1117', border: '1px solid #30363d' }}
          />

          {/* Legend */}
          <Panel position="bottom-left">
            <div
              style={{
                display: 'flex',
                gap: 10,
                background: 'rgba(22,27,34,0.9)',
                padding: '4px 10px',
                borderRadius: 6,
                border: '1px solid #30363d',
                fontSize: 9,
                color: '#8b949e',
              }}
            >
              {Object.entries(EDGE_TYPE_COLORS).map(([type, color]) => (
                <span key={type} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                  <span style={{ width: 12, height: 2, background: color, borderRadius: 1 }} />
                  {type.replace(/_/g, ' ')}
                </span>
              ))}
            </div>
          </Panel>
        </ReactFlow>
      </div>

      {/* Detail panel (when node selected) */}
      {detailNode && (
        <div
          style={{
            flexShrink: 0,
            maxHeight: 180,
            overflow: 'auto',
            borderTop: `1px solid ${t.headerBorder}`,
            background: t.sidebarBg,
            padding: 8,
            fontSize: 11,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
            <span
              style={{
                fontSize: 9,
                fontWeight: 700,
                color: '#0d1117',
                background: NODE_TYPE_COLORS[detailNode.type] ?? '#8b949e',
                borderRadius: 3,
                padding: '1px 5px',
              }}
            >
              {TYPE_LABELS[detailNode.type] ?? detailNode.type}
            </span>
            <span style={{ fontWeight: 600, color: t.textPrimary, flex: 1 }}>{detailNode.name}</span>
            <button
              onClick={() => {
                setSelectedNodeId(null);
                setHighlightedIds(new Set());
                setDetailNode(null);
              }}
              style={{ background: 'transparent', border: 'none', color: t.textMuted, cursor: 'pointer', fontSize: 14 }}
            >
              ×
            </button>
          </div>

          {detailNode.domain && (
            <div style={{ color: t.textMuted, marginBottom: 2 }}>
              Domain: <span style={{ color: '#d2a8ff' }}>{detailNode.domain}</span>
            </div>
          )}
          {detailNode.owner && (
            <div style={{ color: t.textMuted, marginBottom: 2 }}>
              Owner: <span style={{ color: t.textSecondary }}>{detailNode.owner}</span>
            </div>
          )}
          {detailNode.status && (
            <div style={{ color: t.textMuted, marginBottom: 4 }}>
              Status: <span style={{ color: STATUS_COLORS[detailNode.status] ?? t.textSecondary }}>{detailNode.status}</span>
            </div>
          )}

          {ancestors.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <div style={{ color: t.textMuted, fontSize: 9, fontWeight: 600, textTransform: 'uppercase', marginBottom: 2 }}>
                Upstream ({ancestors.length})
              </div>
              {ancestors.slice(0, 8).map((n) => (
                <div key={n.id} style={{ padding: '1px 0', color: t.textSecondary, display: 'flex', alignItems: 'center', gap: 3 }}>
                  <span style={{ color: NODE_TYPE_COLORS[n.type], fontSize: 8, fontWeight: 700 }}>
                    {TYPE_LABELS[n.type]?.slice(0, 3) ?? '???'}
                  </span>
                  {n.name}
                </div>
              ))}
              {ancestors.length > 8 && (
                <div style={{ color: t.textMuted, fontSize: 10 }}>+{ancestors.length - 8} more</div>
              )}
            </div>
          )}

          {descendants.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <div style={{ color: t.textMuted, fontSize: 9, fontWeight: 600, textTransform: 'uppercase', marginBottom: 2 }}>
                Downstream ({descendants.length})
              </div>
              {descendants.slice(0, 8).map((n) => (
                <div key={n.id} style={{ padding: '1px 0', color: t.textSecondary, display: 'flex', alignItems: 'center', gap: 3 }}>
                  <span style={{ color: NODE_TYPE_COLORS[n.type], fontSize: 8, fontWeight: 700 }}>
                    {TYPE_LABELS[n.type]?.slice(0, 3) ?? '???'}
                  </span>
                  {n.name}
                </div>
              ))}
              {descendants.length > 8 && (
                <div style={{ color: t.textMuted, fontSize: 10 }}>+{descendants.length - 8} more</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
