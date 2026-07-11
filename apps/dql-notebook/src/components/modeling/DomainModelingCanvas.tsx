import React, { useMemo } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import Dagre from '@dagrejs/dagre';
import type { ManifestDbtFirstModeling, ManifestModelEntity } from '@duckcodeailabs/dql-core';
import { themes } from '../../themes/notebook-theme';

type Theme = (typeof themes)['dark'];
type EntityNodeData = { entity: ManifestModelEntity; relation?: string; selected: boolean; theme: Theme };

export function DomainModelingCanvas({
  modeling,
  relationByDbtId,
  selectedDomain,
  selectedId,
  onSelectEntity,
  onSelectRelationship,
  theme,
}: {
  modeling: ManifestDbtFirstModeling;
  relationByDbtId: Record<string, string | undefined>;
  selectedDomain: string | null;
  selectedId: string | null;
  onSelectEntity: (id: string) => void;
  onSelectRelationship: (id: string) => void;
  theme: Theme;
}) {
  const { nodes, edges } = useMemo(() => buildGraph(modeling, relationByDbtId, selectedDomain, selectedId, theme), [modeling, relationByDbtId, selectedDomain, selectedId, theme]);
  if (!nodes.length) return <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: theme.textMuted }}>Bind a dbt model to this domain to begin the analytical graph.</div>;
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={{ entity: EntityNode }}
      fitView
      fitViewOptions={{ padding: 0.25 }}
      minZoom={0.25}
      maxZoom={1.7}
      nodesDraggable
      nodesConnectable={false}
      onNodeClick={(_, node) => onSelectEntity(node.id)}
      onEdgeClick={(_, edge) => onSelectRelationship(edge.id)}
      colorMode={theme.appBg.toLowerCase().includes('0') ? 'dark' : 'light'}
      proOptions={{ hideAttribution: true }}
    >
      <Background color={theme.headerBorder} gap={20} size={1} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeColor={(node) => domainColor(String((node.data as EntityNodeData).entity.domain))} maskColor={`${theme.appBg}bb`} />
    </ReactFlow>
  );
}

function EntityNode({ data }: NodeProps<Node<EntityNodeData>>) {
  const { entity, relation, selected, theme } = data;
  const color = domainColor(entity.domain);
  return (
    <div style={{ width: 232, borderRadius: 10, overflow: 'hidden', border: `1px solid ${selected ? theme.accent : theme.headerBorder}`, boxShadow: selected ? `0 0 0 2px ${theme.accent}2b` : '0 8px 24px #00000012', background: theme.cellBg, color: theme.textPrimary }}>
      <Handle type="target" position={Position.Left} style={{ background: color, border: 0, width: 8, height: 8 }} />
      <div style={{ height: 5, background: color }} />
      <div style={{ padding: '11px 12px 10px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
          <strong style={{ fontSize: 13 }}>{entity.id}</strong>
          <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color, background: `${color}18`, borderRadius: 999, padding: '3px 6px' }}>{entity.domain}</span>
        </div>
        <div style={{ fontSize: 11, color: theme.textSecondary, marginTop: 7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{relation ?? entity.dbtUniqueId}</div>
        <div style={{ display: 'flex', gap: 10, marginTop: 9, fontSize: 10, color: theme.textMuted }}>
          <span>grain: {entity.grain ?? 'dbt'}</span>
          <span>keys: {entity.keys.length || 'dbt'}</span>
        </div>
      </div>
      <Handle type="source" position={Position.Right} style={{ background: color, border: 0, width: 8, height: 8 }} />
    </div>
  );
}

function buildGraph(
  modeling: ManifestDbtFirstModeling,
  relationByDbtId: Record<string, string | undefined>,
  selectedDomain: string | null,
  selectedId: string | null,
  theme: Theme,
): { nodes: Node<EntityNodeData>[]; edges: Edge[] } {
  const visibleRelationships = Object.values(modeling.relationships).filter((relationship) => {
    if (!selectedDomain) return true;
    const from = modeling.entities[relationship.from];
    const to = modeling.entities[relationship.to];
    return from?.domain === selectedDomain || to?.domain === selectedDomain;
  });
  const relatedIds = new Set(visibleRelationships.flatMap((relationship) => [relationship.from, relationship.to]));
  const entities = Object.values(modeling.entities).filter((entity) => !selectedDomain || entity.domain === selectedDomain || relatedIds.has(entity.id));
  const domains = [...new Set(entities.map((entity) => entity.domain))].sort();
  const nodes: Node<EntityNodeData>[] = [];
  domains.forEach((domain, domainIndex) => {
    entities.filter((entity) => entity.domain === domain).sort((a, b) => a.id.localeCompare(b.id)).forEach((entity, index) => {
      nodes.push({
        id: entity.id,
        type: 'entity',
        position: { x: domainIndex * 350, y: index * 150 },
        data: { entity, relation: relationByDbtId[entity.dbtUniqueId], selected: selectedId === entity.id, theme },
      });
    });
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges: Edge[] = visibleRelationships.filter((relationship) => nodeIds.has(relationship.from) && nodeIds.has(relationship.to)).map((relationship) => {
    const passed = relationship.validation?.status === 'passed';
    const color = relationship.automaticJoinAllowed ? '#2e9b63' : relationship.staleCertification ? '#d47822' : passed ? '#5b73d6' : '#9a6b2f';
    return {
      id: relationship.id,
      source: relationship.from,
      target: relationship.to,
      label: `${relationship.cardinality.replace(/_/g, ' ')} · ${relationship.status}`,
      animated: relationship.status === 'review',
      markerEnd: { type: MarkerType.ArrowClosed, color },
      style: { stroke: color, strokeWidth: selectedId === relationship.id ? 3 : 2, cursor: 'pointer' },
      labelStyle: { fill: theme.textSecondary, fontSize: 10, fontWeight: 600 },
      labelBgStyle: { fill: theme.appBg, fillOpacity: 0.92 },
      labelBgPadding: [5, 3] as [number, number],
      labelBgBorderRadius: 4,
    };
  });
  const graph = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: 'LR', ranksep: 105, nodesep: 55, marginx: 35, marginy: 35 });
  nodes.forEach((node) => graph.setNode(node.id, { width: 232, height: 96 }));
  edges.forEach((edge) => graph.setEdge(edge.source, edge.target));
  Dagre.layout(graph);
  nodes.forEach((node) => {
    const position = graph.node(node.id) as { x: number; y: number } | undefined;
    if (position) node.position = { x: position.x - 116, y: position.y - 48 };
  });
  return { nodes, edges };
}

function domainColor(domain: string): string {
  const colors = ['#6d5ce7', '#2e9b63', '#d47822', '#377cc8', '#bd4f8b', '#8a6d3b'];
  let hash = 0;
  for (const char of domain) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return colors[Math.abs(hash) % colors.length]!;
}
