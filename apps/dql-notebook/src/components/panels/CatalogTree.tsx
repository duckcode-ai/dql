import React, { useState } from 'react';
import {
  Bookmark, Box, Boxes, ChevronDown, ChevronRight, Clock, Filter, Folder,
  Gauge, GitBranch, Layers, Sigma, Sparkles, Tag,
} from 'lucide-react';
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

/**
 * Collapse duplicate siblings. The backend semantic tree can emit the same object
 * under two groups (e.g. a cube's measures appear both as `measure` and `metric`
 * leaves in two "Measures" groups), which shows every item twice. Merge same-label
 * groups (combining their children) and drop leaves that insert the same reference.
 * Runs recursively so the whole subtree is de-duplicated.
 */
export function dedupeSiblings(nodes: SemanticTreeNode[]): SemanticTreeNode[] {
  const out: SemanticTreeNode[] = [];
  const index = new Map<string, SemanticTreeNode>();
  for (const node of nodes) {
    const isGroup = (node.children?.length ?? 0) > 0;
    const key = isGroup ? `group:${node.label.toLowerCase()}` : `leaf:${nodeRef(node).toLowerCase()}`;
    const existing = index.get(key);
    if (existing) {
      // Same-label group seen again → merge its children into the first.
      if (isGroup && existing.children) existing.children = existing.children.concat(node.children ?? []);
      continue; // duplicate leaf, or already-merged group
    }
    const copy: SemanticTreeNode = node.children ? { ...node, children: [...node.children] } : node;
    index.set(key, copy);
    out.push(copy);
  }
  for (const node of out) {
    if (node.children) node.children = dedupeSiblings(node.children);
  }
  return out;
}

// Per-type icon + tone, so each semantic object reads at a glance — the same
// icon-led style as the Database tab's table/column rows.
const KIND_ICON: Record<string, { Icon: React.ComponentType<any>; tone: (t: Theme) => string }> = {
  metric: { Icon: Gauge, tone: (t) => t.accent },
  measure: { Icon: Sigma, tone: (t) => t.accent },
  dimension: { Icon: Tag, tone: (t) => t.success },
  time_dimension: { Icon: Clock, tone: (t) => t.warning },
  entity: { Icon: Box, tone: (t) => t.textSecondary },
  segment: { Icon: Filter, tone: (t) => t.textMuted },
  hierarchy: { Icon: GitBranch, tone: (t) => t.textMuted },
  pre_aggregation: { Icon: Layers, tone: (t) => t.textMuted },
  cube: { Icon: Boxes, tone: (t) => t.textSecondary },
  semantic_model: { Icon: Boxes, tone: (t) => t.textSecondary },
  saved_query: { Icon: Bookmark, tone: (t) => t.textMuted },
  provider: { Icon: Folder, tone: (t) => t.textMuted },
  domain: { Icon: Folder, tone: (t) => t.textMuted },
  group: { Icon: Folder, tone: (t) => t.textMuted },
};

// A group node ("Measures", "Dimensions", …) carries its content type in
// meta.objectKind — icon it by that so the group header matches its leaves.
function resolveNodeIcon(node: SemanticTreeNode): { Icon: React.ComponentType<any>; tone: (t: Theme) => string } | undefined {
  if (node.kind === 'group') {
    const objectKind = typeof node.meta?.objectKind === 'string' ? node.meta.objectKind : '';
    return KIND_ICON[objectKind] ?? KIND_ICON.group;
  }
  return KIND_ICON[node.kind];
}

export function SemanticTreeView({
  tree,
  themeMode,
  search = '',
  onInsert,
  onSeedBlock,
}: {
  tree: SemanticTreeNode;
  themeMode: ThemeMode;
  search?: string;
  onInsert: (ref: string) => void;
  /** When set, insertable leaves show a "Build block" action (AI, governed). */
  onSeedBlock?: (ref: string, label: string) => void;
}) {
  const t = themes[themeMode];
  const q = search.trim().toLowerCase();
  const roots = dedupeSiblings(tree.children ?? []).filter((node) => matchesTree(node, q));
  if (roots.length === 0) {
    return <div style={{ padding: '16px 12px', fontSize: 11.5, color: t.textMuted, textAlign: 'center' }}>{q ? 'No matches.' : 'No semantic objects.'}</div>;
  }
  return <>{roots.map((node) => <TreeNodeRow key={node.id} node={node} t={t} q={q} onInsert={onInsert} onSeedBlock={onSeedBlock} depth={0} />)}</>;
}

function TreeNodeRow({ node, t, q, onInsert, onSeedBlock, depth }: { node: SemanticTreeNode; t: Theme; q: string; onInsert: (ref: string) => void; onSeedBlock?: (ref: string, label: string) => void; depth: number }) {
  const hasChildren = (node.children?.length ?? 0) > 0;
  const [open, setOpen] = useState(depth < 1 || Boolean(q));
  const insertable = INSERTABLE.has(node.kind);
  const icon = resolveNodeIcon(node);
  const Icon = icon?.Icon;
  const pad = 10 + depth * 13;

  if (!hasChildren) {
    // A flex row (not a nested button) so an optional "Build block" action can sit
    // beside the insert action without invalid button-in-button markup.
    return (
      <div style={{ display: 'flex', alignItems: 'center', width: '100%', minWidth: 0, borderBottom: `1px solid ${t.cellBorder}` }}>
        <button
          type="button"
          onClick={() => insertable && onInsert(nodeRef(node))}
          title={insertable ? `Insert ${nodeRef(node)}` : node.label}
          style={{
            display: 'flex', alignItems: 'center', gap: 7, flex: 1, minWidth: 0, boxSizing: 'border-box',
            padding: `5px 6px 5px ${pad + 15}px`, border: 'none', background: 'transparent',
            cursor: insertable ? 'pointer' : 'default', textAlign: 'left', fontFamily: t.font, color: t.textPrimary,
          }}
        >
          {Icon && <Icon size={13} color={icon.tone(t)} style={{ flexShrink: 0 }} />}
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5, fontFamily: t.fontMono }}>{node.label}</span>
        </button>
        {onSeedBlock && insertable ? (
          <button
            type="button"
            title={`Build a governed block from ${node.label}`}
            onClick={() => onSeedBlock(nodeRef(node), node.label)}
            className="dql-hover"
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: t.accent, display: 'flex', padding: '4px 8px', flexShrink: 0 }}
          >
            <Sparkles size={12} strokeWidth={2.2} />
          </button>
        ) : null}
      </div>
    );
  }
  const children = (node.children ?? []).filter((child) => matchesTree(child, q));
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, width: '100%', minWidth: 0, boxSizing: 'border-box',
          padding: `6px 10px 6px ${pad}px`, border: 'none', borderBottom: `1px solid ${t.cellBorder}`,
          background: 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: t.font, color: t.textPrimary,
        }}
      >
        {open ? <ChevronDown size={13} color={t.textMuted} style={{ flexShrink: 0 }} /> : <ChevronRight size={13} color={t.textMuted} style={{ flexShrink: 0 }} />}
        {Icon && <Icon size={13} color={icon.tone(t)} style={{ flexShrink: 0 }} />}
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, fontWeight: 600 }}>{node.label}</span>
        <span style={{ fontSize: 10, color: t.textMuted, flexShrink: 0 }}>{node.count ?? children.length}</span>
      </button>
      {open && children.map((child) => <TreeNodeRow key={child.id} node={child} t={t} q={q} onInsert={onInsert} onSeedBlock={onSeedBlock} depth={depth + 1} />)}
    </div>
  );
}
