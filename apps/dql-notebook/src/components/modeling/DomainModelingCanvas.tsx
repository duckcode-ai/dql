import React, { useEffect, useMemo, useState } from 'react';
import { Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, useNodesState, type Connection, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import Dagre from '@dagrejs/dagre';
import { KeyRound, Link2, Plus, ShieldCheck } from 'lucide-react';
import type { DbtNodeAuthoringDetail, ManifestDbtFirstModeling, ManifestModelEntity } from '@duckcodeailabs/dql-core';
import { themes } from '../../themes/notebook-theme';

/** Progressive detail for one Domain Model, never separate model graphs. */
export type ModelingLayer = 'business' | 'analytics' | 'implementation';
export type ColumnDisplayMode = 'keys' | 'relevant' | 'all';
export type DiagramLayoutMode = 'auto' | 'grid' | 'star';
export type DiagramDensity = 'compact' | 'normal' | 'wide';
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
  columnMode: ColumnDisplayMode;
  density: DiagramDensity;
  theme: Theme;
  onAddRelatedModel: (origin: { from: string; fromColumn?: string }) => void;
};

export function DomainModelingCanvas({ modeling, relationByDbtId, detailsByDbtId, selectedDomain, selectedId, layer, columnMode, search, layoutMode, density, visibleLimit, dimUnrelated, showEdgeLabels, resetLayoutToken, onSelectEntity, onSelectRelationship, onDraftRelationship, onAddRelatedModel, onDropDbtModel, onCreateDomain, onEditEntity, onOpenAi, theme }: { modeling: ManifestDbtFirstModeling; relationByDbtId: Record<string, string | undefined>; detailsByDbtId: Record<string, DbtNodeAuthoringDetail | undefined>; selectedDomain: string | null; selectedId: string | null; layer: ModelingLayer; columnMode: ColumnDisplayMode; search: string; layoutMode: DiagramLayoutMode; density: DiagramDensity; visibleLimit: number; dimUnrelated: boolean; showEdgeLabels: boolean; resetLayoutToken: number; onSelectEntity: (id: string) => void; onSelectRelationship: (id: string) => void; onDraftRelationship: (draft: RelationshipDraft) => void; onAddRelatedModel: (origin: { from: string; fromColumn?: string }) => void; onDropDbtModel: (uniqueId: string) => void; onCreateDomain: () => void; onEditEntity: (id: string) => void; onOpenAi: (id: string) => void; theme: Theme }) {
  const layoutKey = `dql-model-layout:${selectedDomain ?? 'all'}:${layer}`;
  const [savedPositions, setSavedPositions] = useState<Record<string, { x: number; y: number }>>(() => readPositions(layoutKey));
  useEffect(() => setSavedPositions(readPositions(layoutKey)), [layoutKey]);
  useEffect(() => {
    if (!resetLayoutToken) return;
    localStorage.removeItem(layoutKey);
    setSavedPositions({});
  }, [resetLayoutToken]);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null);
  const { nodes: graphNodes, edges } = useMemo(() => buildGraph(modeling, relationByDbtId, detailsByDbtId, selectedDomain, selectedId, layer, columnMode, search, layoutMode, density, visibleLimit, dimUnrelated, showEdgeLabels, savedPositions, onAddRelatedModel, theme), [modeling, relationByDbtId, detailsByDbtId, selectedDomain, selectedId, layer, columnMode, search, layoutMode, density, visibleLimit, dimUnrelated, showEdgeLabels, savedPositions, onAddRelatedModel, theme]);
  const [nodes, setNodes, onNodesChange] = useNodesState(graphNodes);
  useEffect(() => setNodes(graphNodes), [graphNodes, setNodes]);
  if (!graphNodes.length)
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          placeItems: 'center',
          justifyContent: 'center',
          alignItems: 'center',
          gap: 12,
          height: '100%',
          color: theme.textMuted,
        }}
      >
        <strong style={{ color: theme.textPrimary }}>{search.trim() ? `No models or columns match “${search.trim()}”.` : 'Start your Domain Model'}</strong>
        {!search.trim() && <><span>Bind a dbt model, then connect its columns to define governed analytical relationships.</span><div style={{ display: 'flex', gap: 8 }}><button onClick={onCreateDomain} style={emptyAction(theme)}><Plus size={13} /> Create domain</button><button onClick={() => onDropDbtModel('')} style={emptyAction(theme, true)}><Link2 size={13} /> Bind first model</button></div></>}
      </div>
    );
  const handleConnect = (connection: Connection) => {
    if (layer === 'business' || !connection.source || !connection.target) return;
    onDraftRelationship({
      from: connection.source,
      to: connection.target,
      fromColumn: parseColumnHandle(connection.sourceHandle),
      toColumn: parseColumnHandle(connection.targetHandle),
    });
  };
  return (
    <div style={{ height: '100%', position: 'relative' }} onClick={() => setContextMenu(null)}>
    <ReactFlow key={`${layoutMode}:${density}:${visibleLimit}:${resetLayoutToken}:${search}`} nodes={nodes} edges={edges} onNodesChange={onNodesChange} nodeTypes={{ entity: EntityNode }} fitView fitViewOptions={{ padding: 0.2 }} minZoom={0.2} maxZoom={1.8} nodesDraggable nodesConnectable={layer !== 'business'} onConnect={handleConnect} onNodeDragStop={(_, node) => { const next = { ...savedPositions, [node.id]: node.position }; setSavedPositions(next); localStorage.setItem(layoutKey, JSON.stringify(next)); }} onDragOver={(event) => { if (event.dataTransfer.types.includes('application/x-dql-dbt-model')) event.preventDefault(); }} onDrop={(event) => { const uniqueId = event.dataTransfer.getData('application/x-dql-dbt-model'); if (uniqueId) { event.preventDefault(); onDropDbtModel(uniqueId); } }} onNodeClick={(_, node) => onSelectEntity(node.id)} onNodeDoubleClick={(_, node) => onEditEntity(node.id)} onNodeContextMenu={(event, node) => { event.preventDefault(); setContextMenu({ x: event.clientX, y: event.clientY, nodeId: node.id }); }} onEdgeClick={(_, edge) => onSelectRelationship(edge.id)} colorMode={theme.appBg.toLowerCase().includes('0') ? 'dark' : 'light'} proOptions={{ hideAttribution: true }}>
      <Background color={theme.headerBorder} gap={20} size={1} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeColor={(node) => domainColor(String((node.data as EntityNodeData).entity.domain))} maskColor={`${theme.appBg}bb`} />
    </ReactFlow>
    {contextMenu && <div style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y, zIndex: 50, width: 178, border: `1px solid ${theme.headerBorder}`, borderRadius: 7, background: theme.cellBg, boxShadow: '0 12px 32px #0004', padding: 4 }} onClick={(event) => event.stopPropagation()}><MenuAction label="Inspect entity" onClick={() => { onSelectEntity(contextMenu.nodeId); setContextMenu(null); }} theme={theme} /><MenuAction label="Edit Domain Model binding" onClick={() => { onEditEntity(contextMenu.nodeId); setContextMenu(null); }} theme={theme} /><MenuAction label="Ask AI about entity" onClick={() => { onOpenAi(contextMenu.nodeId); setContextMenu(null); }} theme={theme} /><MenuAction label="Start relationship" onClick={() => { onDraftRelationship({ from: contextMenu.nodeId, to: '' }); setContextMenu(null); }} theme={theme} /></div>}
    </div>
  );
}

function EntityNode({ data }: NodeProps<Node<EntityNodeData>>) {
  const { entity, detail, relation, selected, layer, columnMode, density, theme, onAddRelatedModel } = data;
  const [collapsed, setCollapsed] = useState(density === 'compact');
  const color = domainColor(entity.domain);
  const columns = detail?.columns ?? [];
  const keys = new Set(entity.keys.length ? entity.keys : (detail?.dqlMeta?.keys ?? []));
  const visibleColumns = collapsed || layer === 'business' ? [] : layer === 'implementation' || columnMode === 'all' ? columns.slice(0, 16) : columnMode === 'keys' ? columns.filter((column) => keys.has(column.name)).slice(0, 10) : columns.filter((column) => keys.has(column.name) || column.tests.length > 0).slice(0, 10);
  const concepts = entity.conceptRefs?.length ? entity.conceptRefs.join(', ') : titleCase(entity.id);
  return (
    <div
      style={{
        position: 'relative',
        width: layer === 'business' ? 250 : 292,
        borderRadius: 10,
        overflow: 'hidden',
        border: `1px solid ${selected ? theme.accent : theme.headerBorder}`,
        boxShadow: selected ? `0 0 0 2px ${theme.accent}2b` : '0 8px 24px #00000012',
        background: theme.cellBg,
        color: theme.textPrimary,
      }}
    >
      {layer !== 'business' && <Handle id="entity-target" type="target" position={Position.Left} style={handleStyle(color)} />}
      {layer !== 'business' && <button className="nodrag" title="Add a related model" onClick={(event) => { event.stopPropagation(); onAddRelatedModel({ from: entity.id }); }} style={{ position: 'absolute', right: -11, top: 18, zIndex: 5, width: 22, height: 22, display: 'grid', placeItems: 'center', padding: 0, borderRadius: 999, border: '2px solid #fff', background: color, color: '#fff', cursor: 'pointer', boxShadow: `0 0 0 1px ${color}66` }}><Plus size={12} /></button>}
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
          <strong style={{ fontSize: 13 }}>{layer === 'business' ? concepts : titleCase(entity.id)}</strong><button className="nodrag" title={collapsed ? 'Expand columns' : 'Collapse columns'} onClick={(event) => { event.stopPropagation(); setCollapsed((value) => !value); }} style={{ marginLeft: 'auto', border: 0, background: 'transparent', color: theme.textMuted, cursor: 'pointer' }}>{collapsed ? '▾' : '▴'}</button>
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
        {layer === 'business' ? (
          <div style={{ fontSize: 11, color: theme.textSecondary, marginTop: 8, lineHeight: 1.45 }}>{detail?.description || `Business concept backed by ${entity.id}`}</div>
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
            <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}><NodeBadge text={entity.analyticalRole ?? 'unknown'} color={color} /><NodeBadge text={entity.status ?? 'draft'} color={entity.status === 'certified' ? '#2e9b63' : '#9a6b2f'} />{detail?.tests.length ? <NodeBadge text={`${detail.tests.length} tests`} color="#377cc8" /> : null}</div>
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
              {layer !== 'business' && <Handle id={`target:${column.name}`} type="target" position={Position.Left} style={{ ...handleStyle(color), top: '50%' }} />}
              <span style={{ fontWeight: keys.has(column.name) ? 700 : 500, display: 'flex', gap: 5, alignItems: 'center' }}>
                {keys.has(column.name) ? <KeyRound size={10} color="#d49a22" /> : null}{column.name}
              </span>
              <span style={{ color: theme.textMuted, display: 'flex', gap: 3, alignItems: 'center' }}>{column.type ?? ''}{constraintBadges(column.tests, keys.has(column.name))}</span>
              {layer !== 'business' && <Handle id={`source:${column.name}`} type="source" position={Position.Right} style={{ ...handleStyle(color), top: '50%' }} />}
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
      {layer !== 'business' && <Handle id="entity-source" type="source" position={Position.Right} style={handleStyle(color)} />}
    </div>
  );
}

function buildGraph(modeling: ManifestDbtFirstModeling, relationByDbtId: Record<string, string | undefined>, detailsByDbtId: Record<string, DbtNodeAuthoringDetail | undefined>, selectedDomain: string | null, selectedId: string | null, layer: ModelingLayer, columnMode: ColumnDisplayMode, search: string, layoutMode: DiagramLayoutMode, density: DiagramDensity, visibleLimit: number, dimUnrelated: boolean, showEdgeLabels: boolean, savedPositions: Record<string, { x: number; y: number }>, onAddRelatedModel: (origin: { from: string; fromColumn?: string }) => void, theme: Theme): { nodes: Node<EntityNodeData>[]; edges: Edge[] } {
  const visibleRelationships = Object.values(modeling.relationships).filter((relationship) => {
    if (!selectedDomain) return true;
    const from = modeling.entities[relationship.from];
    const to = modeling.entities[relationship.to];
    return from?.domain === selectedDomain || to?.domain === selectedDomain;
  });
  const relatedIds = new Set(visibleRelationships.flatMap((relationship) => [relationship.from, relationship.to]));
  const normalizedSearch = search.trim().toLowerCase();
  let entities = Object.values(modeling.entities).filter((entity) => {
    if (selectedDomain && entity.domain !== selectedDomain && !relatedIds.has(entity.id)) return false;
    if (!normalizedSearch) return true;
    const detail = detailsByDbtId[entity.dbtUniqueId];
    return [entity.id, entity.domain, detail?.relation, ...(detail?.columns.map((column) => column.name) ?? [])].some((value) => String(value ?? '').toLowerCase().includes(normalizedSearch));
  });
  if (visibleLimit > 0 && entities.length > visibleLimit) {
    const degree = new Map<string, number>();
    for (const relationship of visibleRelationships) { degree.set(relationship.from, (degree.get(relationship.from) ?? 0) + 1); degree.set(relationship.to, (degree.get(relationship.to) ?? 0) + 1); }
    entities = [...entities].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.id.localeCompare(b.id)).slice(0, visibleLimit);
  }
  const domains = [...new Set(entities.map((entity) => entity.domain))].sort();
  const nodes: Node<EntityNodeData>[] = [];
  domains.forEach((domain, domainIndex) =>
    entities
      .filter((entity) => entity.domain === domain)
      .sort((a, b) => a.id.localeCompare(b.id))
      .forEach((entity, index) => {
        const detail = detailsByDbtId[entity.dbtUniqueId];
        const columnCount = visibleColumnCount(entity, detail, layer, columnMode);
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
            columnMode,
            density,
            theme,
            onAddRelatedModel,
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
      const keyLabel = relationship.keys.map((key) => `${key.from} → ${key.to}`).join(', ');
      const firstKey = relationship.keys[0];
      const fromEntity = modeling.entities[relationship.from];
      const toEntity = modeling.entities[relationship.to];
      const fromColumns = fromEntity ? visibleColumnNames(fromEntity, detailsByDbtId[fromEntity.dbtUniqueId], layer, columnMode) : new Set<string>();
      const toColumns = toEntity ? visibleColumnNames(toEntity, detailsByDbtId[toEntity.dbtUniqueId], layer, columnMode) : new Set<string>();
      const label = layer === 'business' ? `${relationship.verb || relationship.description || titleCase(relationship.id)} · ${keyLabel}` : layer === 'implementation' ? `${keyLabel} · ${relationship.status}` : `${keyLabel} · ${relationship.fanout}`;
      return {
        id: relationship.id,
        source: relationship.from,
        target: relationship.to,
        sourceHandle: firstKey && fromColumns.has(firstKey.from) ? `source:${firstKey.from}` : undefined,
        targetHandle: firstKey && toColumns.has(firstKey.to) ? `target:${firstKey.to}` : undefined,
        type: 'smoothstep',
        label: showEdgeLabels ? `${cardinalitySymbol(relationship.cardinality)}  ${label}` : undefined,
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
    ranksep: density === 'compact' ? 105 : density === 'wide' ? 230 : 170,
    nodesep: density === 'compact' ? 35 : density === 'wide' ? 90 : 60,
    marginx: 35,
    marginy: 35,
  });
  nodes.forEach((node) =>
    graph.setNode(node.id, {
      width: layer === 'business' ? 250 : 292,
      height: Number(node.style?.height ?? 100),
    }),
  );
  edges.forEach((edge) => graph.setEdge(edge.source, edge.target));
  if (layoutMode === 'auto') Dagre.layout(graph);
  nodes.forEach((node) => {
    const saved = savedPositions[node.id];
    if (saved) { node.position = saved; return; }
    if (layoutMode === 'grid') { const index = nodes.indexOf(node); const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length))); node.position = { x: (index % cols) * 360, y: Math.floor(index / cols) * 260 }; return; }
    if (layoutMode === 'star') { const index = nodes.indexOf(node); if (index === 0) { node.position = { x: 0, y: 0 }; return; } const angle = ((index - 1) / Math.max(1, nodes.length - 1)) * Math.PI * 2; node.position = { x: Math.cos(angle) * 460, y: Math.sin(angle) * 330 }; return; }
    const p = graph.node(node.id) as { x: number; y: number } | undefined;
    if (p)
      node.position = {
        x: p.x - (layer === 'business' ? 125 : 146),
        y: p.y - Number(node.style?.height ?? 100) / 2,
      };
  });
  if (dimUnrelated && selectedId && modeling.entities[selectedId]) {
    const connected = new Set<string>([selectedId]);
    for (const relationship of visibleRelationships) { if (relationship.from === selectedId) connected.add(relationship.to); if (relationship.to === selectedId) connected.add(relationship.from); }
    for (const node of nodes) node.style = { ...node.style, opacity: connected.has(node.id) ? 1 : 0.18, transition: 'opacity 160ms ease' };
  }
  return { nodes, edges };
}

function cardinalitySymbol(value: string): string { return value === 'one_to_one' ? '1:1' : value === 'one_to_many' ? '1:N' : value === 'many_to_one' ? 'N:1' : value === 'many_to_many' ? 'N:N' : '?'; }
function NodeBadge({ text, color }: { text: string; color: string }) { return <span style={{ border: `1px solid ${color}55`, color, background: `${color}12`, borderRadius: 999, padding: '2px 5px', fontSize: 8, fontWeight: 700 }}>{text}</span>; }
function constraintBadges(tests: string[], primary: boolean): React.ReactNode {
  const normalized = tests.map((test) => test.toLowerCase());
  const badges: React.ReactNode[] = [];
  if (primary) badges.push(<ConstraintBadge key="pk" label="PK" color="#d49a22" icon={<KeyRound size={7} />} />);
  if (normalized.some((test) => test.includes('relationship'))) badges.push(<ConstraintBadge key="fk" label="FK" color="#7b61d1" icon={<Link2 size={7} />} />);
  if (normalized.some((test) => test.includes('unique'))) badges.push(<ConstraintBadge key="uq" label="UQ" color="#2c8f9e" icon={<ShieldCheck size={7} />} />);
  if (normalized.some((test) => test.includes('not_null'))) badges.push(<ConstraintBadge key="nn" label="NN" color="#c9515d" />);
  return badges;
}
function ConstraintBadge({ label, color, icon }: { label: string; color: string; icon?: React.ReactNode }) { return <span title={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 1, color, border: `1px solid ${color}55`, background: `${color}12`, borderRadius: 3, padding: '1px 2px', fontSize: 7, fontWeight: 800 }}>{icon}{label}</span>; }
function MenuAction({ label, onClick, theme }: { label: string; onClick: () => void; theme: Theme }) { return <button onClick={onClick} style={{ width: '100%', textAlign: 'left', border: 0, borderRadius: 4, padding: '7px 8px', background: 'transparent', color: theme.textPrimary, fontSize: 11, cursor: 'pointer' }}>{label}</button>; }

function visibleColumnCount(entity: ManifestModelEntity, detail: DbtNodeAuthoringDetail | undefined, layer: ModelingLayer, mode: ColumnDisplayMode): number {
  return visibleColumnNames(entity, detail, layer, mode).size;
}

function visibleColumnNames(entity: ManifestModelEntity, detail: DbtNodeAuthoringDetail | undefined, layer: ModelingLayer, mode: ColumnDisplayMode): Set<string> {
  if (layer === 'business') return new Set();
  const columns = detail?.columns ?? [];
  if (layer === 'implementation' || mode === 'all') return new Set(columns.slice(0, 16).map((column) => column.name));
  const keys = new Set(entity.keys.length ? entity.keys : detail?.dqlMeta?.keys ?? []);
  if (mode === 'keys') return new Set(columns.filter((column) => keys.has(column.name)).slice(0, 10).map((column) => column.name));
  return new Set(columns.filter((column) => keys.has(column.name) || column.tests.length > 0).slice(0, 10).map((column) => column.name));
}

function readPositions(key: string): Record<string, { x: number; y: number }> {
  try { const value = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, { x?: unknown; y?: unknown }>; return Object.fromEntries(Object.entries(value).filter(([, point]) => typeof point.x === 'number' && typeof point.y === 'number')) as Record<string, { x: number; y: number }>; }
  catch { return {}; }
}

function parseColumnHandle(handle: string | null): string | undefined {
  return handle?.includes(':') ? handle.slice(handle.indexOf(':') + 1) : undefined;
}
function handleStyle(color: string): React.CSSProperties {
  return { background: color, border: '2px solid #fff', width: 12, height: 12, boxShadow: `0 0 0 1px ${color}66`, cursor: 'crosshair' };
}
function emptyAction(theme: Theme, primary = false): React.CSSProperties {
  return { display: 'inline-flex', alignItems: 'center', gap: 6, border: `1px solid ${primary ? theme.accent : theme.headerBorder}`, borderRadius: 6, padding: '7px 10px', color: primary ? theme.accent : theme.textSecondary, background: primary ? `${theme.accent}12` : theme.cellBg, cursor: 'pointer', fontSize: 11, fontWeight: 650 };
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
