import React, { useMemo } from 'react';
import { Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, type Connection, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import Dagre from '@dagrejs/dagre';
import type { DbtNodeAuthoringDetail, ManifestDbtFirstModeling, ManifestModelEntity } from '@duckcodeailabs/dql-core';
import { themes } from '../../themes/notebook-theme';

export type ModelingLayer = 'conceptual' | 'analytical' | 'physical';
export type RelationshipDraft = {
  from: string;
  to: string;
  fromColumn?: string;
  toColumn?: string;
};

type Theme = (typeof themes)['dark'];
type EntityNodeData = {
  entity: ManifestModelEntity;
  detail?: DbtNodeAuthoringDetail;
  relation?: string;
  selected: boolean;
  layer: ModelingLayer;
  theme: Theme;
};

export function DomainModelingCanvas({ modeling, relationByDbtId, detailsByDbtId, selectedDomain, selectedId, layer, onSelectEntity, onSelectRelationship, onDraftRelationship, theme }: { modeling: ManifestDbtFirstModeling; relationByDbtId: Record<string, string | undefined>; detailsByDbtId: Record<string, DbtNodeAuthoringDetail | undefined>; selectedDomain: string | null; selectedId: string | null; layer: ModelingLayer; onSelectEntity: (id: string) => void; onSelectRelationship: (id: string) => void; onDraftRelationship: (draft: RelationshipDraft) => void; theme: Theme }) {
  const { nodes, edges } = useMemo(() => buildGraph(modeling, relationByDbtId, detailsByDbtId, selectedDomain, selectedId, layer, theme), [modeling, relationByDbtId, detailsByDbtId, selectedDomain, selectedId, layer, theme]);
  if (!nodes.length)
    return (
      <div
        style={{
          display: 'grid',
          placeItems: 'center',
          height: '100%',
          color: theme.textMuted,
        }}
      >
        Bind a dbt model to this domain to begin the analytical graph.
      </div>
    );
  const handleConnect = (connection: Connection) => {
    if (layer !== 'analytical' || !connection.source || !connection.target) return;
    onDraftRelationship({
      from: connection.source,
      to: connection.target,
      fromColumn: parseColumnHandle(connection.sourceHandle),
      toColumn: parseColumnHandle(connection.targetHandle),
    });
  };
  return (
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={{ entity: EntityNode }} fitView fitViewOptions={{ padding: 0.2 }} minZoom={0.2} maxZoom={1.8} nodesDraggable nodesConnectable={layer === 'analytical'} onConnect={handleConnect} onNodeClick={(_, node) => onSelectEntity(node.id)} onEdgeClick={(_, edge) => onSelectRelationship(edge.id)} colorMode={theme.appBg.toLowerCase().includes('0') ? 'dark' : 'light'} proOptions={{ hideAttribution: true }}>
      <Background color={theme.headerBorder} gap={20} size={1} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeColor={(node) => domainColor(String((node.data as EntityNodeData).entity.domain))} maskColor={`${theme.appBg}bb`} />
    </ReactFlow>
  );
}

function EntityNode({ data }: NodeProps<Node<EntityNodeData>>) {
  const { entity, detail, relation, selected, layer, theme } = data;
  const color = domainColor(entity.domain);
  const columns = detail?.columns ?? [];
  const keys = new Set(entity.keys.length ? entity.keys : (detail?.dqlMeta?.keys ?? []));
  const visibleColumns = layer === 'conceptual' ? [] : layer === 'analytical' ? columns.filter((column) => keys.has(column.name) || column.tests.length > 0).slice(0, 10) : columns.slice(0, 16);
  const concepts = entity.conceptRefs?.length ? entity.conceptRefs.join(', ') : titleCase(entity.id);
  return (
    <div
      style={{
        width: layer === 'conceptual' ? 250 : 292,
        borderRadius: 10,
        overflow: 'hidden',
        border: `1px solid ${selected ? theme.accent : theme.headerBorder}`,
        boxShadow: selected ? `0 0 0 2px ${theme.accent}2b` : '0 8px 24px #00000012',
        background: theme.cellBg,
        color: theme.textPrimary,
      }}
    >
      {layer === 'analytical' && <Handle id="entity-target" type="target" position={Position.Left} style={handleStyle(color)} />}
      <div style={{ height: 5, background: color }} />
      <div style={{ padding: '10px 12px 9px' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 8,
            alignItems: 'center',
          }}
        >
          <strong style={{ fontSize: 13 }}>{layer === 'conceptual' ? concepts : entity.id}</strong>
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              textTransform: 'uppercase',
              color,
              background: `${color}18`,
              borderRadius: 999,
              padding: '3px 6px',
            }}
          >
            {entity.domain}
          </span>
        </div>
        {layer === 'conceptual' ? (
          <div style={{ fontSize: 11, color: theme.textSecondary, marginTop: 8 }}>Business concept backed by {entity.id}</div>
        ) : (
          <>
            <div
              style={{
                fontSize: 10.5,
                color: theme.textSecondary,
                marginTop: 7,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {relation ?? entity.dbtUniqueId}
            </div>
            <div
              style={{
                display: 'flex',
                gap: 10,
                marginTop: 7,
                fontSize: 9.5,
                color: theme.textMuted,
              }}
            >
              <span>grain: {entity.grain ?? detail?.dqlMeta?.grain ?? 'dbt'}</span>
              <span>{columns.length} dbt columns</span>
            </div>
          </>
        )}
      </div>
      {visibleColumns.length > 0 && (
        <div
          style={{
            borderTop: `1px solid ${theme.headerBorder}`,
            maxHeight: 242,
            overflow: 'auto',
          }}
        >
          {visibleColumns.map((column) => (
            <div
              key={column.name}
              style={{
                position: 'relative',
                display: 'grid',
                gridTemplateColumns: '1fr auto',
                gap: 7,
                padding: '6px 13px',
                borderBottom: `1px solid ${theme.headerBorder}`,
                fontSize: 10,
              }}
            >
              {layer === 'analytical' && <Handle id={`target:${column.name}`} type="target" position={Position.Left} style={{ ...handleStyle(color), top: '50%' }} />}
              <span style={{ fontWeight: keys.has(column.name) ? 700 : 500 }}>
                {keys.has(column.name) ? '🔑 ' : ''}
                {column.name}
              </span>
              <span style={{ color: theme.textMuted }}>{column.type ?? (column.tests.length ? column.tests[0] : '')}</span>
              {layer === 'analytical' && <Handle id={`source:${column.name}`} type="source" position={Position.Right} style={{ ...handleStyle(color), top: '50%' }} />}
            </div>
          ))}
          {columns.length > visibleColumns.length && (
            <div
              style={{
                padding: '6px 12px',
                color: theme.textMuted,
                fontSize: 9,
              }}
            >
              + {columns.length - visibleColumns.length} more dbt-owned columns
            </div>
          )}
        </div>
      )}
      {layer === 'analytical' && <Handle id="entity-source" type="source" position={Position.Right} style={handleStyle(color)} />}
    </div>
  );
}

function buildGraph(modeling: ManifestDbtFirstModeling, relationByDbtId: Record<string, string | undefined>, detailsByDbtId: Record<string, DbtNodeAuthoringDetail | undefined>, selectedDomain: string | null, selectedId: string | null, layer: ModelingLayer, theme: Theme): { nodes: Node<EntityNodeData>[]; edges: Edge[] } {
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
  domains.forEach((domain, domainIndex) =>
    entities
      .filter((entity) => entity.domain === domain)
      .sort((a, b) => a.id.localeCompare(b.id))
      .forEach((entity, index) => {
        const detail = detailsByDbtId[entity.dbtUniqueId];
        const columnCount = layer === 'conceptual' ? 0 : layer === 'physical' ? Math.min(detail?.columns.length ?? 0, 16) : Math.min(detail?.columns.filter((c) => entity.keys.includes(c.name) || c.tests.length > 0).length ?? 0, 10);
        nodes.push({
          id: entity.id,
          type: 'entity',
          position: { x: domainIndex * 390, y: index * 190 },
          data: {
            entity,
            detail,
            relation: relationByDbtId[entity.dbtUniqueId],
            selected: selectedId === entity.id,
            layer,
            theme,
          },
          style: { height: 92 + columnCount * 29 },
        });
      }),
  );
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges: Edge[] = visibleRelationships
    .filter((r) => nodeIds.has(r.from) && nodeIds.has(r.to))
    .map((relationship) => {
      const passed = relationship.validation?.status === 'passed';
      const color = relationship.automaticJoinAllowed ? '#2e9b63' : relationship.staleCertification ? '#d47822' : passed ? '#5b73d6' : '#9a6b2f';
      const label = layer === 'conceptual' ? relationship.verb || relationship.description || relationship.id : layer === 'physical' ? relationship.keys.map((key) => `${key.from} = ${key.to}`).join(', ') : `${relationship.cardinality.replace(/_/g, ' ')} · ${relationship.fanout} · ${relationship.status}`;
      return {
        id: relationship.id,
        source: relationship.from,
        target: relationship.to,
        label,
        animated: relationship.status === 'review',
        markerEnd: { type: MarkerType.ArrowClosed, color },
        style: {
          stroke: color,
          strokeWidth: selectedId === relationship.id ? 3 : 2,
          cursor: 'pointer',
        },
        labelStyle: {
          fill: theme.textSecondary,
          fontSize: 10,
          fontWeight: 600,
        },
        labelBgStyle: { fill: theme.appBg, fillOpacity: 0.92 },
        labelBgPadding: [5, 3] as [number, number],
        labelBgBorderRadius: 4,
      };
    });
  const graph = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: 'LR',
    ranksep: 115,
    nodesep: 60,
    marginx: 35,
    marginy: 35,
  });
  nodes.forEach((node) =>
    graph.setNode(node.id, {
      width: layer === 'conceptual' ? 250 : 292,
      height: Number(node.style?.height ?? 100),
    }),
  );
  edges.forEach((edge) => graph.setEdge(edge.source, edge.target));
  Dagre.layout(graph);
  nodes.forEach((node) => {
    const p = graph.node(node.id) as { x: number; y: number } | undefined;
    if (p)
      node.position = {
        x: p.x - (layer === 'conceptual' ? 125 : 146),
        y: p.y - Number(node.style?.height ?? 100) / 2,
      };
  });
  return { nodes, edges };
}

function parseColumnHandle(handle: string | null): string | undefined {
  return handle?.includes(':') ? handle.slice(handle.indexOf(':') + 1) : undefined;
}
function handleStyle(color: string): React.CSSProperties {
  return { background: color, border: '1px solid #fff', width: 9, height: 9 };
}
function titleCase(value: string): string {
  return value.replace(/[._-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}
function domainColor(domain: string): string {
  const colors = ['#6d5ce7', '#2e9b63', '#d47822', '#377cc8', '#bd4f8b', '#8a6d3b'];
  let hash = 0;
  for (const char of domain) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return colors[Math.abs(hash) % colors.length]!;
}
