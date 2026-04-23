import type { Theme } from '../../themes/notebook-theme';
import React, { useState } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import type { NotebookFile } from '../../store/types';

interface FilesPanelProps {
  onOpenFile: (file: NotebookFile) => void;
}

type FolderKey = 'notebooks' | 'workbooks' | 'blocks' | 'dashboards';

const FOLDER_LABELS: Record<FolderKey, string> = {
  notebooks: 'Notebooks',
  workbooks: 'Workbooks',
  blocks: 'Blocks',
  dashboards: 'Dashboards',
};

function FileTypeIcon({ type }: { type: NotebookFile['type'] }) {
  switch (type) {
    case 'notebook':
      return (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
          <path d="M0 1.75A.75.75 0 0 1 .75 1h4.253c1.227 0 2.317.59 3 1.501A3.743 3.743 0 0 1 11.006 1h4.245a.75.75 0 0 1 .75.75v10.5a.75.75 0 0 1-.75.75h-4.507a2.25 2.25 0 0 0-1.591.659l-.622.621a.75.75 0 0 1-1.063 0L7.597 13.66A2.25 2.25 0 0 0 6.007 13H.75a.75.75 0 0 1-.75-.75Zm7.251 10.324.004-5.073-.002-2.253A2.25 2.25 0 0 0 5.003 2.5H1.5v9h4.507c.656 0 1.287.169 1.744.324Zm1.499.004c.457-.155 1.088-.324 1.744-.324H15v-9h-3.495a2.25 2.25 0 0 0-2.252 2.247l-.002 9.077Z" />
        </svg>
      );
    case 'workbook':
      return (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
          <path d="M2 1.75C2 .784 2.784 0 3.75 0h8.5C13.216 0 14 .784 14 1.75v12.5A1.75 1.75 0 0 1 12.25 16h-8.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25V1.75a.25.25 0 0 0-.25-.25Zm2 3.5a.75.75 0 0 1 .75-.75h3a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1-.75-.75ZM6.5 7.25a.75.75 0 0 0 0 1.5h3a.75.75 0 0 0 0-1.5Zm-.75 3.5a.75.75 0 0 1 .75-.75h3a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1-.75-.75Z" />
        </svg>
      );
    case 'block':
      return (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
          <path d="M10.5 0l5.25 4-5.25 4V6H9.25A1.75 1.75 0 0 0 7.5 7.75v2.5A1.75 1.75 0 0 0 9.25 12h1.25v8H9v-6.5A3.25 3.25 0 0 1 5.75 10h-2A3.25 3.25 0 0 1 .5 6.75v-2.5A3.25 3.25 0 0 1 3.75 1h2A3.25 3.25 0 0 1 9 4.5V6h1.5V0z" />
        </svg>
      );
    default:
      return (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
          <path d="M.24 2.375C.24 1.064 1.225.001 2.409.001h6.451a1.17 1.17 0 0 1 .828.344l3.311 3.312a1.17 1.17 0 0 1 .344.828v9.14c0 1.31-.985 2.374-2.169 2.374H2.41C1.225 16 .24 14.937.24 13.625Zm2.169-1a.846.846 0 0 0-.844.86v11.39c0 .47.38.86.844.86h8.774a.847.847 0 0 0 .844-.86V5.157L8.688 1.373H2.41Z" />
        </svg>
      );
  }
}

function FolderIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
      {expanded ? (
        <path d="M1.75 2.5a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V4.25a.25.25 0 0 0-.25-.25H7.5A1.75 1.75 0 0 1 5.75 2.5h-4ZM0 2.75C0 1.784.784 1 1.75 1h4c.966 0 1.75.784 1.75 1.75H14.25c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25Z" />
      ) : (
        <path d="M1.75 2.5a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V4.25a.25.25 0 0 0-.25-.25H7.5A1.75 1.75 0 0 1 5.75 2.5h-4ZM0 2.75C0 1.784.784 1 1.75 1h4c.966 0 1.75.784 1.75 1.75H14.25c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25Z" />
      )}
    </svg>
  );
}

function displayName(file: NotebookFile): string {
  return file.name.replace(/\.(dqlnb|dql)$/, '');
}

export function FilesPanel({ onOpenFile }: FilesPanelProps) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];

  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({
    notebooks: true,
    workbooks: true,
    blocks: false,
    dashboards: false,
  });
  const [newBtnHover, setNewBtnHover] = useState(false);

  const grouped: Record<FolderKey, NotebookFile[]> = {
    notebooks: [],
    workbooks: [],
    blocks: [],
    dashboards: [],
  };

  for (const f of state.files) {
    const key = f.folder.toLowerCase() as FolderKey;
    if (key in grouped) {
      grouped[key].push(f);
    }
  }

  const toggleFolder = (key: string) => {
    setExpandedFolders((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div
      style={{
        flex: 1,
        overflow: 'auto',
        padding: '8px 0',
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
      }}
    >
      {/* New Notebook button */}
      <div style={{ padding: '0 8px 8px' }}>
        <button
          onClick={() => dispatch({ type: 'OPEN_NEW_NOTEBOOK_MODAL' })}
          onMouseEnter={() => setNewBtnHover(true)}
          onMouseLeave={() => setNewBtnHover(false)}
          style={{
            width: '100%',
            height: 30,
            background: 'transparent',
            border: `1px dashed ${newBtnHover ? t.accent : t.cellBorder}`,
            borderRadius: 6,
            color: newBtnHover ? t.accent : t.textSecondary,
            cursor: 'pointer',
            fontSize: 12,
            fontFamily: t.font,
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            transition: 'border-color 0.15s, color 0.15s',
          }}
        >
          <span style={{ fontSize: 16, lineHeight: 1 }}>+</span>
          New Notebook
        </button>
      </div>

      {/* Loading state */}
      {state.filesLoading && (
        <div style={{ padding: '8px 14px', color: t.textMuted, fontSize: 12, fontFamily: t.font }}>
          Loading files…
        </div>
      )}

      {/* Folder groups */}
      {(Object.keys(FOLDER_LABELS) as FolderKey[]).map((key) => {
        const files = grouped[key];
        const expanded = expandedFolders[key];
        const onAdd = key === 'notebooks'
          ? () => dispatch({ type: 'OPEN_NEW_NOTEBOOK_MODAL' })
          : key === 'blocks'
            ? () => dispatch({ type: 'OPEN_NEW_BLOCK_MODAL' })
            : undefined;

        return (
          <div key={key}>
            <FolderHeader
              label={FOLDER_LABELS[key]}
              count={files.length}
              expanded={expanded}
              onToggle={() => toggleFolder(key)}
              onAdd={onAdd}
              deprecated={key === 'workbooks'}
              deprecationTitle={key === 'workbooks' ? 'Workbook is deprecated — will be removed in v1.3. Use dashboard with tabs. See docs/migrations/workbook-to-dashboard.md' : undefined}
              t={t}
            />
            {expanded && (
              <div>
                {files.length === 0 ? (
                  <div
                    style={{
                      padding: '4px 14px 4px 32px',
                      fontSize: 12,
                      color: t.textMuted,
                      fontFamily: t.font,
                      fontStyle: 'italic',
                    }}
                  >
                    No {FOLDER_LABELS[key].toLowerCase()}
                  </div>
                ) : (
                  files.map((file) => (
                    <FileRow
                      key={file.path}
                      file={file}
                      active={state.activeFile?.path === file.path}
                      onClick={() => onOpenFile(file)}
                      t={t}
                    />
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function FolderHeader({
  label,
  count,
  expanded,
  onToggle,
  onAdd,
  deprecated,
  deprecationTitle,
  t,
}: {
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  onAdd?: () => void;
  deprecated?: boolean;
  deprecationTitle?: string;
  t: Theme;
}) {
  const [hovered, setHovered] = useState(false);
  const [addHover, setAddHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        background: hovered ? t.sidebarItemHover : 'transparent',
        transition: 'background 0.1s',
      }}
    >
      <button
        onClick={onToggle}
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '3px 0 3px 10px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: t.textSecondary,
          fontSize: 11,
          fontWeight: 600,
          fontFamily: t.font,
          letterSpacing: '0.04em',
          textTransform: 'uppercase' as const,
          textAlign: 'left' as const,
        }}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="currentColor"
          style={{
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s',
            flexShrink: 0,
          }}
        >
          <path d="M3 2l4 3-4 3V2Z" />
        </svg>
        <FolderIcon expanded={expanded} />
        <span style={{ flex: 1 }}>{label}</span>
        {deprecated && (
          <span
            title={deprecationTitle}
            style={{
              background: '#d29922',
              color: '#1c1d20',
              borderRadius: 10,
              padding: '0 6px',
              fontSize: 9,
              fontWeight: 600,
              letterSpacing: '0.04em',
              marginRight: 4,
              textTransform: 'uppercase' as const,
            }}
          >
            deprecated
          </span>
        )}
        {count > 0 && (
          <span
            style={{
              background: t.pillBg,
              color: t.textMuted,
              borderRadius: 10,
              padding: '0 5px',
              fontSize: 10,
              fontWeight: 500,
            }}
          >
            {count}
          </span>
        )}
      </button>
      {onAdd && hovered && (
        <button
          onClick={(e) => { e.stopPropagation(); onAdd(); }}
          onMouseEnter={() => setAddHover(true)}
          onMouseLeave={() => setAddHover(false)}
          title={`New ${label.slice(0, -1)}`}
          style={{
            background: addHover ? t.btnHover : 'transparent',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            color: addHover ? t.accent : t.textMuted,
            fontSize: 14,
            lineHeight: 1,
            padding: '2px 8px',
            marginRight: 4,
            flexShrink: 0,
            transition: 'color 0.1s',
          }}
        >
          +
        </button>
      )}
    </div>
  );
}

function FileRow({
  file,
  active,
  onClick,
  t,
}: {
  file: NotebookFile;
  active: boolean;
  onClick: () => void;
  t: Theme;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 8px 4px 26px',
        background: active ? t.sidebarItemActive : hovered ? t.sidebarItemHover : 'transparent',
        border: 'none',
        borderLeft: active ? `2px solid ${t.accent}` : '2px solid transparent',
        cursor: 'pointer',
        color: active ? t.textPrimary : hovered ? t.textPrimary : t.textSecondary,
        fontSize: 13,
        fontFamily: t.font,
        textAlign: 'left' as const,
        transition: 'background 0.1s, color 0.1s',
        overflow: 'hidden',
      }}
    >
      <span style={{ flexShrink: 0, color: active ? t.accent : t.textMuted }}>
        <FileTypeIcon type={file.type} />
      </span>
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
        }}
      >
        {displayName(file)}
      </span>
      {file.isNew && (
        <span
          style={{
            fontSize: 9,
            fontWeight: 600,
            color: t.accent,
            background: t.sidebarItemActive,
            borderRadius: 4,
            padding: '1px 4px',
            flexShrink: 0,
          }}
        >
          NEW
        </span>
      )}
    </button>
  );
}
