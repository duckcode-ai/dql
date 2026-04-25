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

import React, { useEffect, useRef, useState } from 'react';
import { ExternalLink, Maximize2, X } from '@duckcodeailabs/dql-ui/icons';
import { useNotebook } from '../../store/NotebookStore';
import { themes, type Theme } from '../../themes/notebook-theme';
import { api } from '../../api/client';
import { MiniLineageGraph } from './MiniLineageGraph';
import {
  NODE_TYPE_COLORS,
  TYPE_LABELS,
  TYPE_TITLES,
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

  if (!nodeId) return null;

  const focal = graph.focalNode;
  const upstreamCount = focal
    ? graph.edges.filter((e) => e.target === focal.id).length
    : 0;
  const downstreamCount = focal
    ? graph.edges.filter((e) => e.source === focal.id).length
    : 0;
  const focalColor = focal ? NODE_TYPE_COLORS[focal.type] ?? t.textSecondary : t.textSecondary;
  const focalLabel = focal ? TYPE_LABELS[focal.type] ?? focal.type.toUpperCase() : '';

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

      {/* Footer hint */}
      {focal?.metadata?.path != null && typeof focal.metadata.path === 'string' && (
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
            title={focal.metadata.path as string}
          >
            {focal.metadata.path as string}
          </span>
        </div>
      )}
    </aside>
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
