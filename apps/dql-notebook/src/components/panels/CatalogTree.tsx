import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { SemanticTreeNode } from '../../store/types';
import type { Theme, ThemeMode } from '../../themes/notebook-theme';
import { themes } from '../../themes/notebook-theme';

/**
 * Shared "object display" tree — a clean, database-studio-style expandable list:
 * a parent name that expands to reveal its children (metrics, dimensions, time
 * dimensions, …). Used by both the notebook Build sidebar and Block Studio so the
 * semantic catalog looks and behaves identically in both places.
 */

const INSERTABLE = new Set(['metric', 'measure', 'dimension', 'time_dimension']);

function nodeName(node: SemanticTreeNode): string {
  const prefix = `${node.kind}:`;
  if (node.id.startsWith(prefix)) return node.id.slice(prefix.length);
  const idx = node.id.lastIndexOf(':');
  return idx >= 0 ? node.id.slice(idx + 1) : node.id;
}

function nodeRef(node: SemanticTreeNode): string {
  const name = nodeName(node);
  return node.kind === 'metric' || node.kind === 'measure' ? `@metric(${name})` : `@dim(${name})`;
}

function matchesTree(node: SemanticTreeNode, q: string): boolean {
  if (!q) return true;
  if (node.label.toLowerCase().includes(q) || node.id.toLowerCase().includes(q)) return true;
  return (node.children ?? []).some((child) => matchesTree(child, q));
}

const KIND_BADGE: Record<string, { label: string; tone: (t: Theme) => string }> = {
  metric: { label: 'MET', tone: (t) => t.accent },
  measure: { label: 'MEA', tone: (t) => t.accent },
  dimension: { label: 'DIM', tone: (t) => t.success },
  time_dimension: { label: 'TIME', tone: (t) => t.warning },
  entity: { label: 'ENT', tone: (t) => t.textMuted },
  segment: { label: 'SEG', tone: (t) => t.textMuted },
  hierarchy: { label: 'HIER', tone: (t) => t.textMuted },
  pre_aggregation: { label: 'AGG', tone: (t) => t.textMuted },
};

export function SemanticTreeView({
  tree,
  themeMode,
  search = '',
  onInsert,
}: {
  tree: SemanticTreeNode;
  themeMode: ThemeMode;
  search?: string;
  onInsert: (ref: string) => void;
}) {
  const t = themes[themeMode];
  const q = search.trim().toLowerCase();
  const roots = (tree.children ?? []).filter((node) => matchesTree(node, q));
  if (roots.length === 0) {
    return <div style={{ padding: '16px 12px', fontSize: 11.5, color: t.textMuted, textAlign: 'center' }}>{q ? 'No matches.' : 'No semantic objects.'}</div>;
  }
  return <>{roots.map((node) => <TreeNodeRow key={node.id} node={node} t={t} q={q} onInsert={onInsert} depth={0} />)}</>;
}

function TreeNodeRow({ node, t, q, onInsert, depth }: { node: SemanticTreeNode; t: Theme; q: string; onInsert: (ref: string) => void; depth: number }) {
  const hasChildren = (node.children?.length ?? 0) > 0;
  const [open, setOpen] = useState(depth < 1 || Boolean(q));
  const insertable = INSERTABLE.has(node.kind);
  const badge = KIND_BADGE[node.kind];
  const pad = 10 + depth * 13;

  if (!hasChildren) {
    return (
      <button
        type="button"
        onClick={() => insertable && onInsert(nodeRef(node))}
        title={insertable ? `Insert ${nodeRef(node)}` : node.label}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, width: '100%', boxSizing: 'border-box',
          padding: `5px 10px 5px ${pad + 15}px`, border: 'none', borderBottom: `1px solid ${t.cellBorder}`,
          background: 'transparent', cursor: insertable ? 'pointer' : 'default', textAlign: 'left', fontFamily: t.font, color: t.textPrimary,
        }}
      >
        {badge && <span style={{ fontSize: 8.5, fontWeight: 800, color: badge.tone(t), width: 28, flexShrink: 0 }}>{badge.label}</span>}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5, fontFamily: t.fontMono }}>{node.label}</span>
      </button>
    );
  }
  const children = (node.children ?? []).filter((child) => matchesTree(child, q));
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 5, width: '100%', boxSizing: 'border-box',
          padding: `6px 10px 6px ${pad}px`, border: 'none', borderBottom: `1px solid ${t.cellBorder}`,
          background: 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: t.font, color: t.textPrimary,
        }}
      >
        {open ? <ChevronDown size={13} color={t.textMuted} /> : <ChevronRight size={13} color={t.textMuted} />}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, fontWeight: 600 }}>{node.label}</span>
        <span style={{ marginLeft: 'auto', fontSize: 10, color: t.textMuted, flexShrink: 0 }}>{node.count ?? children.length}</span>
      </button>
      {open && children.map((child) => <TreeNodeRow key={child.id} node={child} t={t} q={q} onInsert={onInsert} depth={depth + 1} />)}
    </div>
  );
}
