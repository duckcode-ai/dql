/**
 * LineagePathBreadcrumb — renders a single lineage path as a horizontal
 * breadcrumb trail of clickable node pills connected by arrows.
 *
 * Example: [SRC] raw_orders → [DBT] stg_orders → [DBT] dim_orders → [BLK] revenue → [DASH] Sales
 */

import React from 'react';
import {
  NODE_TYPE_COLORS,
  TYPE_LABELS,
  type LineageNode,
  type LineagePath,
} from './lineage-constants';
import type { Theme } from '../../themes/notebook-theme';

// ---- Path Breadcrumb ----

export interface LineagePathBreadcrumbProps {
  path: LineagePath;
  /** Called when a node pill is clicked */
  onNodeClick?: (nodeId: string) => void;
  /** Optional focal node ID — will be visually highlighted */
  focalNodeId?: string;
  t: Theme;
}

export function LineagePathBreadcrumb({ path, onNodeClick, focalNodeId, t }: LineagePathBreadcrumbProps) {
  if (path.nodes.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
      {path.nodes.map((node, index) => (
        <React.Fragment key={node.id}>
          <NodePill
            node={node}
            isFocal={node.id === focalNodeId}
            onClick={onNodeClick ? () => onNodeClick(node.id) : undefined}
            t={t}
          />
          {index < path.nodes.length - 1 && (
            <span style={{ color: t.textMuted, fontSize: 10, lineHeight: 1 }}>→</span>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

// ---- Multiple Paths Section ----

export interface LineagePathSectionProps {
  title: string;
  paths: LineagePath[];
  onNodeClick?: (nodeId: string) => void;
  focalNodeId?: string;
  /** Maximum paths to show before "show more" (default 4) */
  maxVisible?: number;
  t: Theme;
}

export function LineagePathSection({
  title,
  paths,
  onNodeClick,
  focalNodeId,
  maxVisible = 4,
  t,
}: LineagePathSectionProps) {
  const [showAll, setShowAll] = React.useState(false);
  const visiblePaths = showAll ? paths : paths.slice(0, maxVisible);
  const hasMore = paths.length > maxVisible;

  if (paths.length === 0) return null;

  return (
    <div style={{ border: `1px solid ${t.cellBorder}`, borderRadius: 10, overflow: 'hidden', background: t.inputBg }}>
      <div
        style={{
          padding: '8px 12px',
          borderBottom: `1px solid ${t.cellBorder}`,
          fontSize: 11,
          fontWeight: 700,
          color: t.textMuted,
          fontFamily: t.font,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span>{title}</span>
        <span style={{ fontWeight: 400, fontSize: 10 }}>{paths.length} path{paths.length !== 1 ? 's' : ''}</span>
      </div>
      <div style={{ display: 'grid', gap: 8, padding: 10 }}>
        {visiblePaths.map((path, index) => (
          <LineagePathBreadcrumb
            key={`path-${index}`}
            path={path}
            onNodeClick={onNodeClick}
            focalNodeId={focalNodeId}
            t={t}
          />
        ))}
        {hasMore && !showAll && (
          <button
            onClick={() => setShowAll(true)}
            style={{
              background: 'none',
              border: 'none',
              color: t.accent,
              cursor: 'pointer',
              fontSize: 11,
              fontFamily: t.font,
              padding: '2px 0',
              textAlign: 'left',
            }}
          >
            Show {paths.length - maxVisible} more path{paths.length - maxVisible !== 1 ? 's' : ''}...
          </button>
        )}
      </div>
    </div>
  );
}

// ---- Node Pill ----

function NodePill({
  node,
  isFocal,
  onClick,
  t,
}: {
  node: LineageNode;
  isFocal?: boolean;
  onClick?: () => void;
  t: Theme;
}) {
  const color = NODE_TYPE_COLORS[node.type] ?? '#8b949e';
  const label = TYPE_LABELS[node.type] ?? node.type.slice(0, 3).toUpperCase();

  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        background: isFocal ? `${color}18` : t.pillBg ?? `${t.cellBg}`,
        border: `1px solid ${isFocal ? color : t.cellBorder}`,
        borderRadius: 999,
        color: t.textPrimary,
        cursor: onClick ? 'pointer' : 'default',
        fontSize: 10,
        fontFamily: t.font,
        padding: '3px 8px',
        transition: 'border-color 0.15s',
        whiteSpace: 'nowrap',
        maxWidth: 180,
      }}
      title={`${node.type}: ${node.name}${node.domain ? ` (${node.domain})` : ''}`}
    >
      <span
        style={{
          fontSize: 8,
          fontWeight: 700,
          color: '#0d1117',
          background: color,
          borderRadius: 3,
          padding: '1px 3px',
          flexShrink: 0,
        }}
      >
        {label}
      </span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {node.name}
      </span>
    </button>
  );
}

// ---- Layer Summary Bar ----

export interface LayerSummaryProps {
  layerSummary: Record<string, number>;
  t: Theme;
}

export function LayerSummary({ layerSummary, t }: LayerSummaryProps) {
  const layers = ['source', 'transform', 'answer', 'consumption'] as const;
  const total = Object.values(layerSummary).reduce((sum, count) => sum + count, 0);
  if (total === 0) return null;

  const layerColors: Record<string, string> = {
    source: '#79c0ff',
    transform: '#ff7b72',
    answer: '#56d364',
    consumption: '#d2a8ff',
  };
  const layerLabels: Record<string, string> = {
    source: 'Sources',
    transform: 'Transform',
    answer: 'Answer',
    consumption: 'Consumption',
  };

  return (
    <div style={{ display: 'flex', gap: 10, fontSize: 10, color: t.textMuted, fontFamily: t.font }}>
      {layers.map((layer) => {
        const count = layerSummary[layer] ?? 0;
        if (count === 0) return null;
        return (
          <span key={layer} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: layerColors[layer], display: 'inline-block' }} />
            {layerLabels[layer]}: {count}
          </span>
        );
      })}
    </div>
  );
}
