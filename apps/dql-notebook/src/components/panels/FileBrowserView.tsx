import React, { useEffect, useMemo, useState } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { api } from '../../api/client';
import type { NotebookFile, NotebookFileFolder } from '../../store/types';
import {
  NODE_TYPE_COLORS,
  TYPE_LABELS,
  type LineageNode,
} from '../lineage/lineage-constants';

interface FileBrowserViewProps {
  onOpenFile: (file: NotebookFile) => void;
}

const FOLDER_ORDER: NotebookFileFolder[] = ['all', 'notebooks', 'blocks', 'terms', 'business-views', 'dashboards'];

const FOLDER_META: Record<NotebookFileFolder, { label: string; description: string; empty: string }> = {
  all: {
    label: 'Project Explorer',
    description: 'All DQL project artifacts grouped by the way they create business value.',
    empty: 'No project files found.',
  },
  notebooks: {
    label: 'Notebooks',
    description: 'Analysis workspaces that combine SQL, DQL blocks, narrative, charts, and outputs.',
    empty: 'No notebooks found.',
  },
  blocks: {
    label: 'Blocks',
    description: 'Reusable DQL query blocks backed by SQL and governed metadata.',
    empty: 'No blocks found.',
  },
  terms: {
    label: 'Business Terms',
    description: 'Certified vocabulary such as Customer, Order, Revenue, and Lifetime Value.',
    empty: 'No business terms found.',
  },
  'business-views': {
    label: 'Business Views',
    description: 'Business compositions that connect terms, blocks, and other views into outcomes.',
    empty: 'No business views found.',
  },
  dashboards: {
    label: 'Dashboards',
    description: 'Published views and dashboard artifacts that consume trusted DQL blocks.',
    empty: 'No dashboards found.',
  },
};

function displayName(file: NotebookFile): string {
  return file.name.replace(/\.(dqlnb|dql)$/i, '');
}

function lineageNodeIdForFile(file: NotebookFile): string {
  const name = displayName(file);
  switch (file.type) {
    case 'block':
      return `block:${name}`;
    case 'dashboard':
      return `dashboard:${name}`;
    case 'notebook':
    case 'workbook':
      return `notebook:${name}`;
    case 'term':
      return `term:${name}`;
    case 'business_view':
      return `business_view:${name}`;
    default:
      return name;
  }
}

function folderForFile(file: NotebookFile): NotebookFileFolder | null {
  const folder = file.folder.toLowerCase();
  if (folder === 'notebooks' || folder === 'blocks' || folder === 'terms' || folder === 'business-views' || folder === 'dashboards') {
    return folder;
  }
  return null;
}

function primaryActionLabel(file: NotebookFile): string {
  if (file.type === 'term' || file.type === 'business_view') return 'Details';
  if (file.type === 'block') return 'Open Block';
  if (file.type === 'dashboard') return 'Open';
  return 'Open Notebook';
}

function metadataLine(file: NotebookFile, node?: LineageNode): string {
  const metadata = node?.metadata ?? {};
  const parts: string[] = [];
  if (node?.domain) parts.push(node.domain);
  if (node?.owner) parts.push(node.owner);
  if (node?.status) parts.push(node.status);
  if (file.type === 'term' && typeof metadata.termType === 'string') parts.push(metadata.termType);
  if (file.type === 'business_view' && typeof metadata.reviewCadence === 'string') parts.push(metadata.reviewCadence);
  return parts.join(' · ');
}

function descriptionFor(file: NotebookFile, node?: LineageNode): string {
  const metadata = node?.metadata ?? {};
  if (typeof metadata.description === 'string' && metadata.description.trim()) return metadata.description;
  if (file.type === 'term') return 'Business vocabulary used to define DQL blocks and business views.';
  if (file.type === 'business_view') return 'Business composition assembled from trusted terms, blocks, and views.';
  if (file.type === 'block') return 'Reusable SQL-backed DQL block.';
  if (file.type === 'dashboard') return 'Dashboard artifact that consumes DQL outputs.';
  return file.path;
}

export function FileBrowserView({ onOpenFile }: FileBrowserViewProps) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const selectedFolder = state.activeFileFolder;
  const [lineageNodes, setLineageNodes] = useState<LineageNode[]>([]);

  useEffect(() => {
    let cancelled = false;
    void api.fetchLineage().then((data) => {
      if (!cancelled) setLineageNodes((data.nodes ?? []) as LineageNode[]);
    });
    return () => {
      cancelled = true;
    };
  }, [state.files]);

  const nodesById = useMemo(() => {
    const map = new Map<string, LineageNode>();
    for (const node of lineageNodes) map.set(node.id, node);
    return map;
  }, [lineageNodes]);

  const grouped = useMemo(() => {
    const next: Record<Exclude<NotebookFileFolder, 'all'>, NotebookFile[]> = {
      notebooks: [],
      blocks: [],
      terms: [],
      'business-views': [],
      dashboards: [],
    };
    for (const file of state.files) {
      const folder = folderForFile(file);
      if (folder && folder !== 'all') next[folder].push(file);
    }
    for (const files of Object.values(next)) {
      files.sort((a, b) => displayName(a).localeCompare(displayName(b)));
    }
    return next;
  }, [state.files]);

  const foldersToRender = selectedFolder === 'all'
    ? (FOLDER_ORDER.filter((folder) => folder !== 'all' && grouped[folder as Exclude<NotebookFileFolder, 'all'>].length > 0) as Exclude<NotebookFileFolder, 'all'>[])
    : [selectedFolder as Exclude<NotebookFileFolder, 'all'>];

  const total = selectedFolder === 'all'
    ? Object.values(grouped).reduce((sum, files) => sum + files.length, 0)
    : grouped[selectedFolder as Exclude<NotebookFileFolder, 'all'>]?.length ?? 0;

  const openFolder = (folder: NotebookFileFolder) => {
    dispatch({ type: 'OPEN_FILE_FOLDER', folder });
  };

  const showLineage = (file: NotebookFile) => {
    const nodeId = lineageNodeIdForFile(file);
    dispatch({ type: 'SET_LINEAGE_FOCUS', nodeId });
    dispatch({ type: 'OPEN_LINEAGE_DRAWER', nodeId });
  };

  return (
    <div style={{ flex: 1, overflow: 'auto', background: 'var(--color-bg-primary)' }}>
      <div style={{ padding: '22px 28px 16px', borderBottom: `1px solid ${t.headerBorder}` }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <div style={{ fontSize: 24, fontWeight: 800, color: t.textPrimary }}>{FOLDER_META[selectedFolder].label}</div>
            <div style={{ marginTop: 6, fontSize: 13, color: t.textMuted, lineHeight: 1.5, maxWidth: 780 }}>
              {FOLDER_META[selectedFolder].description}
            </div>
          </div>
          <div style={{ textAlign: 'right', flexShrink: 0 }}>
            <div style={{ fontSize: 26, fontWeight: 800, color: t.textPrimary }}>{total}</div>
            <div style={{ fontSize: 11, color: t.textMuted, textTransform: 'uppercase', fontWeight: 700 }}>Artifacts</div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
          {FOLDER_ORDER.map((folder) => {
            const active = folder === selectedFolder;
            const count = folder === 'all'
              ? Object.values(grouped).reduce((sum, files) => sum + files.length, 0)
              : grouped[folder as Exclude<NotebookFileFolder, 'all'>].length;
            if (folder !== 'all' && count === 0) return null;
            return (
              <button
                key={folder}
                onClick={() => openFolder(folder)}
                style={{
                  border: `1px solid ${active ? t.accent : t.headerBorder}`,
                  background: active ? t.sidebarItemActive : t.sidebarBg,
                  color: active ? t.textPrimary : t.textSecondary,
                  borderRadius: 6,
                  padding: '6px 9px',
                  fontSize: 12,
                  fontWeight: 650,
                  cursor: 'pointer',
                }}
              >
                {FOLDER_META[folder].label} {count}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 18 }}>
        {total === 0 ? (
          <div style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 8, padding: 18, color: t.textMuted, background: t.sidebarBg }}>
            {FOLDER_META[selectedFolder].empty}
          </div>
        ) : (
          foldersToRender.map((folder) => (
            <section key={folder}>
              {selectedFolder === 'all' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <div style={{ fontSize: 15, fontWeight: 800, color: t.textPrimary }}>{FOLDER_META[folder].label}</div>
                  <div style={{ fontSize: 11, color: t.textMuted }}>{grouped[folder].length}</div>
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
                {grouped[folder].map((file) => {
                  const node = nodesById.get(lineageNodeIdForFile(file));
                  const color = NODE_TYPE_COLORS[node?.type ?? file.type] ?? t.accent;
                  const secondary = metadataLine(file, node);
                  return (
                    <article
                      key={file.path}
                      style={{
                        border: `1px solid ${t.headerBorder}`,
                        borderRadius: 8,
                        background: t.sidebarBg,
                        padding: 12,
                        minHeight: 136,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 10,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
                        <span
                          style={{
                            color,
                            border: `1px solid ${color}`,
                            borderRadius: 5,
                            padding: '2px 5px',
                            fontSize: 10,
                            fontWeight: 800,
                            lineHeight: 1.2,
                            flexShrink: 0,
                          }}
                        >
                          {TYPE_LABELS[node?.type ?? file.type] ?? file.type.toUpperCase()}
                        </span>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontSize: 14, fontWeight: 800, color: t.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={displayName(file)}>
                            {displayName(file)}
                          </div>
                          {secondary && (
                            <div style={{ marginTop: 3, fontSize: 11, color: t.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={secondary}>
                              {secondary}
                            </div>
                          )}
                        </div>
                      </div>

                      <div style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.45, flex: 1 }}>
                        {descriptionFor(file, node)}
                      </div>

                      <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
                        <button
                          onClick={() => onOpenFile(file)}
                          style={{
                            flex: 1,
                            border: `1px solid ${t.headerBorder}`,
                            background: t.inputBg,
                            color: t.textPrimary,
                            borderRadius: 6,
                            padding: '7px 8px',
                            fontSize: 12,
                            fontWeight: 700,
                            cursor: 'pointer',
                          }}
                        >
                          {primaryActionLabel(file)}
                        </button>
                        <button
                          onClick={() => showLineage(file)}
                          style={{
                            border: `1px solid ${t.headerBorder}`,
                            background: 'transparent',
                            color: t.textSecondary,
                            borderRadius: 6,
                            padding: '7px 8px',
                            fontSize: 12,
                            fontWeight: 700,
                            cursor: 'pointer',
                          }}
                        >
                          Lineage
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
