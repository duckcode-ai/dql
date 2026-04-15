/**
 * MiniLineageGraph — a compact, embeddable ReactFlow DAG for lineage visualization.
 *
 * Used in Block Studio lineage tab, CellLineage, and anywhere a quick graph view is needed.
 * Does NOT include MiniMap, Controls, or filter chips — those are in the fullscreen LineageDAG.
 */

import React, { useEffect, useMemo } from 'react';
import {
  Background,
  Handle,
  MarkerType,
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
import {
  NODE_TYPE_COLORS,
  TYPE_LABELS,
  TYPE_TITLES,
  EDGE_TYPE_COLORS,
  LAYER_COLORS,
  LAYER_LABELS,
  LAYER_ORDER,
  getNodeLayer,
  type LineageNode,
  type LineageEdge,
  type LineageLayerName,
} from './lineage-constants';

// ---- Layout ----

interface LayoutOptions {
  /** 'flow' = standard dagre LR, 'layered' = grouped by lineage layer */
  mode?: 'flow' | 'layered';
}

function layoutGraph(nodes: Node[], edges: Edge[], options: LayoutOptions = {}): Node[] {
  if (nodes.length === 0) return nodes;

  const graph = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: 'LR', ranksep: 60, nodesep: 30, marginx: 20, marginy: 20 });

  for (const node of nodes) {
    const opts: Record<string, unknown> = { width: 170, height: 52 };
    if (options.mode === 'layered' && node.data?.layer) {
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
      position: { x: position.x - 85, y: position.y - 26 },
    };
  });
}

// ---- Compact DAG Node ----

function MiniDagNode({ data, selected }: NodeProps) {
  const nodeType = data.nodeType as string;
  const isFocal = data.isFocal as boolean;
  const color = NODE_TYPE_COLORS[nodeType] ?? '#8b949e';
  const label = TYPE_LABELS[nodeType] ?? nodeType.toUpperCase();

  return (
    <div
      style={{
        minWidth: 140,
        maxWidth: 190,
        background: '#161b22',
        border: `2px solid ${isFocal ? '#58a6ff' : selected ? '#58a6ff' : color}`,
        borderRadius: 8,
        padding: '6px 8px',
        boxShadow: isFocal ? '0 0 0 2px rgba(88, 166, 255, 0.25)' : 'none',
      }}
    >
      <Handle type="target" position={Position.Left} style={{ width: 6, height: 6, background: color, border: 'none' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
        <span
          style={{
            fontSize: 8,
            fontWeight: 700,
            letterSpacing: '0.04em',
            color: '#0d1117',
            background: color,
            borderRadius: 3,
            padding: '1px 4px',
          }}
        >
          {label}
        </span>
        {(data.domain as string | undefined) && (
          <span style={{ color: '#8b949e', fontSize: 9 }}>{data.domain as string}</span>
        )}
      </div>
      <div
        style={{
          color: '#e6edf3',
          fontSize: 10,
          fontWeight: 600,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={data.label as string}
      >
        {data.label as string}
      </div>
      <Handle type="source" position={Position.Right} style={{ width: 6, height: 6, background: color, border: 'none' }} />
    </div>
  );
}

const nodeTypes = { miniDagNode: MiniDagNode };

// ---- Swim Lane Background (for layered mode) ----

function SwimLaneBands({ nodes }: { nodes: Node[] }) {
  // Group nodes by layer and compute x-bounds for each layer
  const layerBounds = useMemo(() => {
    const bounds: Record<string, { minX: number; maxX: number }> = {};
    for (const node of nodes) {
      const layer = (node.data?.layer as string) ?? 'answer';
      const x = node.position.x;
      const w = 170;
      if (!bounds[layer]) {
        bounds[layer] = { minX: x, maxX: x + w };
      } else {
        bounds[layer].minX = Math.min(bounds[layer].minX, x);
        bounds[layer].maxX = Math.max(bounds[layer].maxX, x + w);
      }
    }
    return bounds;
  }, [nodes]);

  return (
    <>
      {LAYER_ORDER.map((layer) => {
        const b = layerBounds[layer];
        if (!b) return null;
        const color = LAYER_COLORS[layer];
        return (
          <div
            key={layer}
            style={{
              position: 'absolute',
              left: b.minX - 16,
              top: -4,
              width: b.maxX - b.minX + 32,
              height: '100%',
              background: `${color}08`,
              borderLeft: `2px solid ${color}20`,
              pointerEvents: 'none',
              zIndex: -1,
            }}
          >
            <div
              style={{
                position: 'absolute',
                top: 4,
                left: 4,
                fontSize: 9,
                fontWeight: 700,
                color: `${color}80`,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              {LAYER_LABELS[layer]}
            </div>
          </div>
        );
      })}
    </>
  );
}

// ---- Main Component ----

export interface MiniLineageGraphProps {
  nodes: LineageNode[];
  edges: LineageEdge[];
  /** Node ID to highlight as the focal point */
  focalNodeId?: string;
  /** Height in pixels (default 250) */
  height?: number;
  /** Called when a node is clicked */
  onNodeClick?: (nodeId: string) => void;
  /** Whether the graph is interactive (pan/zoom). Default true */
  interactive?: boolean;
  /** Layout mode: 'flow' (default dagre LR) or 'layered' (grouped by lineage layer) */
  layoutMode?: 'flow' | 'layered';
}

export function MiniLineageGraph({
  nodes: inputNodes,
  edges: inputEdges,
  focalNodeId,
  height = 250,
  onNodeClick,
  interactive = true,
  layoutMode = 'flow',
}: MiniLineageGraphProps) {
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([]);

  useEffect(() => {
    const flowNodes: Node[] = inputNodes.map((node) => ({
      id: node.id,
      type: 'miniDagNode',
      position: { x: 0, y: 0 },
      data: {
        label: node.name,
        nodeType: node.type,
        domain: node.domain,
        layer: getNodeLayer(node),
        isFocal: node.id === focalNodeId,
      },
    }));

    const flowEdges: Edge[] = inputEdges.map((edge, index) => ({
      id: `mini-edge-${index}-${edge.source}-${edge.target}`,
      source: edge.source,
      target: edge.target,
      style: {
        stroke: EDGE_TYPE_COLORS[edge.type] ?? '#8b949e',
        strokeWidth: 1.4,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: EDGE_TYPE_COLORS[edge.type] ?? '#8b949e',
        width: 10,
        height: 10,
      },
    }));

    setRfNodes(layoutGraph(flowNodes, flowEdges, { mode: layoutMode }));
    setRfEdges(flowEdges);
  }, [inputNodes, inputEdges, focalNodeId, layoutMode, setRfNodes, setRfEdges]);

  if (inputNodes.length === 0) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8b949e', fontSize: 11 }}>
        No lineage nodes to display
      </div>
    );
  }

  return (
    <div style={{ height, width: '100%', borderRadius: 8, overflow: 'hidden', border: '1px solid #30363d' }}>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        onNodesChange={interactive ? onNodesChange : undefined}
        onEdgesChange={interactive ? onEdgesChange : undefined}
        onNodeClick={onNodeClick ? (_event, node) => onNodeClick(node.id) : undefined}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={interactive}
        nodesConnectable={false}
        zoomOnScroll={interactive}
        panOnDrag={interactive}
        style={{ background: '#0d1117' }}
      >
        <Background color="#21262d" gap={20} size={1} />
      </ReactFlow>
    </div>
  );
}
