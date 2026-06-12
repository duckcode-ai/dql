/**
 * LineageDrawer — right-side overlay panel that shows a focused lineage graph
 * for the currently selected node, without yanking the user out of the
 * notebook / block / files view they were working in.
 *
 * Triggered by:
 *  - clicking a node in LineagePanel (sidebar list)
 *  - "View lineage" from the Files panel context menu
 *  - any other "show lineage for X" entry point
 *
 * Closes via the × button. Independent of `lineageFullscreen` (full-page DAG).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, Maximize2, X } from '@duckcodeailabs/dql-ui/icons';
import { useNotebook } from '../../store/NotebookStore';
import { themes, type Theme } from '../../themes/notebook-theme';
import { api } from '../../api/client';
import { MiniLineageGraph } from './MiniLineageGraph';
import {
  NODE_TYPE_COLORS,
  TYPE_LABELS,
  TYPE_TITLES,
  EDGE_TITLES,
  type LineageNode,
  type LineageEdge,
} from './lineage-constants';

interface FocusedGraph {
  nodes: LineageNode[];
  edges: LineageEdge[];
  focalNode: LineageNode | null;
}

const DRAWER_WIDTH = 380;

export function LineageDrawer() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const nodeId = state.lineageDrawerNodeId;

  const [graph, setGraph] = useState<FocusedGraph>({ nodes: [], edges: [], focalNode: null });
  const [loading, setLoading] = useState(false);
  // ReactFlow needs an explicit pixel height — measuring the flex container
  // ensures the graph fills available space instead of collapsing to 0.
  const graphHostRef = useRef<HTMLDivElement>(null);
  const [graphHeight, setGraphHeight] = useState(360);

  useEffect(() => {
    const el = graphHostRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const next = Math.max(160, entry.contentRect.height);
        setGraphHeight(next);
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!nodeId) return;
    let cancelled = false;
    setLoading(true);
    api
      .queryLineage({ focus: nodeId, upstreamDepth: 2, downstreamDepth: 2 })
      .then((res) => {
        if (cancelled) return;
        setGraph({
          nodes: (res.graph?.nodes ?? []) as LineageNode[],
          edges: (res.graph?.edges ?? []) as LineageEdge[],
          focalNode: (res.focalNode as LineageNode) ?? null,
        });
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nodeId]);

  const focal = graph.focalNode;
  const upstreamCount = focal
    ? graph.edges.filter((e) => e.target === focal.id).length
    : 0;
  const downstreamCount = focal
    ? graph.edges.filter((e) => e.source === focal.id).length
    : 0;
  const focalColor = focal ? NODE_TYPE_COLORS[focal.type] ?? t.textSecondary : t.textSecondary;
  const focalLabel = focal ? TYPE_LABELS[focal.type] ?? focal.type.toUpperCase() : '';
  const nodeById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);
  const upstreamConnections = useMemo(() => {
    if (!focal) return [];
    return graph.edges
      .filter((edge) => edge.target === focal.id)
      .map((edge) => ({ edge, node: nodeById.get(edge.source) }))
      .filter((entry): entry is { edge: LineageEdge; node: LineageNode } => Boolean(entry.node));
  }, [focal, graph.edges, nodeById]);
  const downstreamConnections = useMemo(() => {
    if (!focal) return [];
    return graph.edges
      .filter((edge) => edge.source === focal.id)
      .map((edge) => ({ edge, node: nodeById.get(edge.target) }))
      .filter((entry): entry is { edge: LineageEdge; node: LineageNode } => Boolean(entry.node));
  }, [focal, graph.edges, nodeById]);
  const filePath = focal?.metadata?.path ?? focal?.metadata?.filePath;

  if (!nodeId) return null;

  const handleNodeClick = (clickedId: string) => {
    if (clickedId === nodeId) return;
    dispatch({ type: 'OPEN_LINEAGE_DRAWER', nodeId: clickedId });
  };

  const openFullscreen = () => {
    dispatch({ type: 'SET_LINEAGE_FOCUS', nodeId });
    dispatch({ type: 'CLOSE_LINEAGE_DRAWER' });
    if (!state.lineageFullscreen) {
      dispatch({ type: 'TOGGLE_LINEAGE_FULLSCREEN' });
    }
  };

  return (
    <aside
      aria-label="Lineage drawer"
      style={{
        width: DRAWER_WIDTH,
        flexShrink: 0,
        borderLeft: `1px solid ${t.headerBorder}`,
        background: t.appBg,
        color: t.textPrimary,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        animation: 'dql-drawer-slide-in 180ms cubic-bezier(0.22, 0.61, 0.36, 1)',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '12px 14px',
          borderBottom: `1px solid ${t.headerBorder}`,
        }}
      >
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: 38,
            padding: '2px 6px',
            background: focalColor,
            color: t.appBg,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.04em',
            borderRadius: 4,
          }}
          title={focal ? TYPE_TITLES[focal.type] ?? focal.type : ''}
        >
          {focalLabel || 'NODE'}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: t.textPrimary,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={focal?.name ?? nodeId}
          >
            {focal?.name ?? nodeId}
          </div>
          <div style={{ fontSize: 11, color: t.textMuted, marginTop: 2 }}>
            Lineage · ↑ {upstreamCount} · ↓ {downstreamCount}
          </div>
        </div>
        <IconButton title="Open full graph" onClick={openFullscreen} t={t}>
          <Maximize2 size={14} strokeWidth={1.75} />
        </IconButton>
        <IconButton
          title="Close"
          onClick={() => dispatch({ type: 'CLOSE_LINEAGE_DRAWER' })}
          t={t}
        >
          <X size={14} strokeWidth={2} />
        </IconButton>
      </div>

      {focal && <NodeMetadataSummary node={focal} t={t} />}

      {/* Graph */}
      <div
        ref={graphHostRef}
        style={{ flex: 1, minHeight: 0, padding: 12, overflow: 'hidden', display: 'flex' }}
      >
        {loading ? (
          <div style={{ color: t.textMuted, fontSize: 12, padding: 8 }}>Loading lineage…</div>
        ) : graph.nodes.length === 0 ? (
          <div style={{ color: t.textMuted, fontSize: 12, padding: 8 }}>
            No lineage available for this node.
          </div>
        ) : (
          <div style={{ flex: 1, minWidth: 0 }}>
            <MiniLineageGraph
              nodes={graph.nodes}
              edges={graph.edges}
              focalNodeId={nodeId}
              height={Math.max(0, graphHeight - 24)}
              onNodeClick={handleNodeClick}
              interactive
            />
          </div>
        )}
      </div>

      {focal && (
        <div style={{ borderTop: `1px solid ${t.headerBorder}`, padding: '10px 12px', display: 'grid', gap: 8 }}>
          <ConnectionList title="Upstream" connections={upstreamConnections} t={t} />
          <ConnectionList title="Downstream" connections={downstreamConnections} t={t} />
        </div>
      )}

      {/* Footer hint */}
      {typeof filePath === 'string' && (
        <div
          style={{
            padding: '8px 14px',
            borderTop: `1px solid ${t.headerBorder}`,
            fontSize: 11,
            color: t.textMuted,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <ExternalLink size={11} strokeWidth={1.75} />
          <span
            style={{
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={filePath}
          >
            {filePath}
          </span>
        </div>
      )}
    </aside>
  );
}

function NodeMetadataSummary({ node, t }: { node: LineageNode; t: Theme }) {
  const metadata = node.metadata ?? {};
  const rows: Array<{ label: string; value: string }> = [];

  if (node.domain) rows.push({ label: 'Domain', value: node.domain });
  if (node.owner) rows.push({ label: 'Owner', value: node.owner });
  if (node.status) rows.push({ label: 'Status', value: node.status });
  if (node.type === 'term' && typeof metadata.termType === 'string') rows.push({ label: 'Term Type', value: metadata.termType });
  if (node.type === 'block' && typeof metadata.blockType === 'string') rows.push({ label: 'Block Type', value: metadata.blockType });
  if (typeof metadata.materializedAs === 'string') rows.push({ label: 'Materialized As', value: metadata.materializedAs });
  if (Array.isArray(metadata.identifiers) && metadata.identifiers.length > 0) {
    rows.push({ label: 'Identifiers', value: metadata.identifiers.map(String).join(', ') });
  }
  if (Array.isArray(metadata.synonyms) && metadata.synonyms.length > 0) {
    rows.push({ label: 'Synonyms', value: metadata.synonyms.map(String).join(', ') });
  }
  if (typeof metadata.description === 'string' && metadata.description.trim()) {
    rows.push({ label: 'Description', value: metadata.description });
  }
  if (typeof metadata.businessOutcome === 'string' && metadata.businessOutcome.trim()) {
    rows.push({ label: 'Business Outcome', value: metadata.businessOutcome });
  }

  if (rows.length === 0) return null;

  return (
    <div
      style={{
        padding: '10px 14px',
        borderBottom: `1px solid ${t.headerBorder}`,
        display: 'grid',
        gap: 6,
        background: t.sidebarBg,
      }}
    >
      {rows.slice(0, 6).map((row) => (
        <div key={row.label} style={{ display: 'grid', gridTemplateColumns: '92px 1fr', gap: 8, minWidth: 0 }}>
          <span style={{ color: t.textMuted, fontSize: 10, fontWeight: 700, textTransform: 'uppercase' }}>{row.label}</span>
          <span
            style={{
              color: t.textSecondary,
              fontSize: 11,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: row.value.length > 90 ? 'normal' : 'nowrap',
            }}
            title={row.value}
          >
            {row.value}
          </span>
        </div>
      ))}
    </div>
  );
}

function ConnectionList({
  title,
  connections,
  t,
}: {
  title: string;
  connections: Array<{ edge: LineageEdge; node: LineageNode }>;
  t: Theme;
}) {
  if (connections.length === 0) {
    return (
      <div style={{ color: t.textMuted, fontSize: 11 }}>
        {title}: none in this focused window
      </div>
    );
  }

  return (
    <div>
      <div style={{ color: t.textMuted, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', marginBottom: 5 }}>
        {title}
      </div>
      <div style={{ display: 'grid', gap: 4 }}>
        {connections.slice(0, 5).map(({ edge, node }) => {
          const color = NODE_TYPE_COLORS[node.type] ?? t.textMuted;
          return (
            <div
              key={`${edge.source}-${edge.target}-${edge.type}`}
              style={{
                display: 'grid',
                gridTemplateColumns: '76px 1fr',
                gap: 8,
                alignItems: 'center',
                fontSize: 11,
                minWidth: 0,
              }}
            >
              <span style={{ color: t.textMuted }}>{EDGE_TITLES[edge.type] ?? edge.type}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                <span
                  style={{
                    color: t.appBg,
                    background: color,
                    borderRadius: 3,
                    padding: '1px 4px',
                    fontSize: 8,
                    fontWeight: 700,
                    flexShrink: 0,
                  }}
                >
                  {TYPE_LABELS[node.type] ?? node.type.slice(0, 4).toUpperCase()}
                </span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={node.name}>
                  {node.name}
                </span>
              </span>
            </div>
          );
        })}
        {connections.length > 5 && (
          <div style={{ color: t.textMuted, fontSize: 11 }}>
            {connections.length - 5} more connection{connections.length - 5 === 1 ? '' : 's'} in the graph
          </div>
        )}
      </div>
    </div>
  );
}

function IconButton({
  title,
  onClick,
  children,
  t,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  t: Theme;
}) {
  return (
    <button
      aria-label={title}
      title={title}
      onClick={onClick}
      style={{
        width: 26,
        height: 26,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        border: `1px solid ${t.headerBorder}`,
        borderRadius: 5,
        color: t.textSecondary,
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = t.textPrimary;
        e.currentTarget.style.background = t.textPrimary + '0f';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = t.textSecondary;
        e.currentTarget.style.background = 'transparent';
      }}
    >
      {children}
    </button>
  );
}
