import type { Theme } from '../../themes/notebook-theme';
import React, { useState } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import type { NotebookFile } from '../../store/types';

interface WelcomeScreenProps {
  onOpenFile: (file: NotebookFile) => void;
}

export function WelcomeScreen({ onOpenFile }: WelcomeScreenProps) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];

  const recentFiles = state.files.slice(0, 3);

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: t.appBg,
        padding: 40,
        overflow: 'auto',
      }}
    >
      <div
        style={{
          maxWidth: 720,
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 48,
        }}
      >
        {/* Hero */}
        <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: 16,
              background: 'linear-gradient(135deg, #5b8cff 0%, #7c5cff 60%, #4a34a8 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 8px 32px rgba(91,140,255,0.28)',
            }}
          >
            <span
              style={{
                color: '#fff',
                fontSize: 26,
                fontWeight: 800,
                fontFamily: t.fontMono,
                letterSpacing: '-1px',
              }}
            >
              DQL
            </span>
          </div>
          <div>
            <h1
              style={{
                fontSize: 32,
                fontWeight: 700,
                color: t.textPrimary,
                fontFamily: t.font,
                marginBottom: 8,
                letterSpacing: '-0.5px',
              }}
            >
              DQL Notebook
            </h1>
            <p
              style={{
                fontSize: 15,
                color: t.textSecondary,
                fontFamily: t.font,
                letterSpacing: '0.02em',
              }}
            >
              Analytics as Code
            </p>
          </div>
        </div>

        {/* Action cards */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 16,
            width: '100%',
          }}
        >
          <ActionCard
            title="New Notebook"
            description="Start a fresh analysis with an empty notebook."
            icon={<NewIcon />}
            accent={t.accent}
            onClick={() => dispatch({ type: 'OPEN_NEW_NOTEBOOK_MODAL' })}
            t={t}
          />

          <OpenRecentCard
            recentFiles={recentFiles}
            onOpenFile={onOpenFile}
            t={t}
          />

          <ActionCard
            title="New Block"
            description="Create a reusable SQL block file."
            icon={<BlockIcon />}
            accent="#ffc857"
            onClick={() => dispatch({ type: 'OPEN_NEW_BLOCK_MODAL' })}
            t={t}
          />
        </div>

        {/* Quick tips */}
        <div
          style={{
            width: '100%',
            borderRadius: 10,
            border: `1px solid ${t.cellBorder}`,
            padding: '16px 20px',
            background: t.cellBg,
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase' as const,
              color: t.textMuted,
              fontFamily: t.font,
              marginBottom: 12,
            }}
          >
            Quick Tips
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: 8,
            }}
          >
            {[
              ['Shift + Enter', 'Run cell'],
              ['\u2318 + S', 'Save notebook'],
              ['\u2318 + B', 'Toggle sidebar'],
              ['\u2318 + D', 'Dashboard mode'],
              ['\u2318 + Shift + Enter', 'Run all cells'],
              ['\u2318 + J', 'Toggle dev panel'],
              ['Click +', 'Add a new cell'],
              ['Drag handle', 'Reorder cells'],
            ].map(([key, desc]) => (
              <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <kbd
                  style={{
                    background: t.pillBg,
                    border: `1px solid ${t.cellBorder}`,
                    borderRadius: 4,
                    padding: '2px 6px',
                    fontSize: 11,
                    fontFamily: t.fontMono,
                    color: t.textSecondary,
                    whiteSpace: 'nowrap' as const,
                  }}
                >
                  {key}
                </kbd>
                <span style={{ fontSize: 12, color: t.textMuted, fontFamily: t.font }}>{desc}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ActionCard({
  title,
  description,
  icon,
  accent,
  onClick,
  t,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  accent: string;
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
        background: hovered ? t.cellBg : 'transparent',
        border: `1px solid ${hovered ? accent : t.cellBorder}`,
        borderRadius: 10,
        padding: '20px 16px',
        cursor: 'pointer',
        textAlign: 'left' as const,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        transition: 'border-color 0.2s, background 0.2s, box-shadow 0.2s',
        boxShadow: hovered ? `0 0 0 1px ${accent}30, 0 4px 16px rgba(0,0,0,0.15)` : 'none',
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: 8,
          background: `${accent}18`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: accent,
        }}
      >
        {icon}
      </div>
      <div>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: t.textPrimary,
            fontFamily: t.font,
            marginBottom: 4,
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontSize: 12,
            color: t.textSecondary,
            fontFamily: t.font,
            lineHeight: 1.5,
          }}
        >
          {description}
        </div>
      </div>
    </button>
  );
}

function OpenRecentCard({
  recentFiles,
  onOpenFile,
  t,
}: {
  recentFiles: NotebookFile[];
  onOpenFile: (f: NotebookFile) => void;
  t: Theme;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? t.cellBg : 'transparent',
        border: `1px solid ${hovered ? t.textMuted : t.cellBorder}`,
        borderRadius: 10,
        padding: '20px 16px',
        textAlign: 'left' as const,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        transition: 'border-color 0.2s, background 0.2s',
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: 8,
          background: `${t.warning}18`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: t.warning,
        }}
      >
        <ClockIcon />
      </div>
      <div>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: t.textPrimary,
            fontFamily: t.font,
            marginBottom: 8,
          }}
        >
          Open Recent
        </div>
        {recentFiles.length === 0 ? (
          <div style={{ fontSize: 12, color: t.textMuted, fontFamily: t.font, fontStyle: 'italic' }}>
            No recent files.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {recentFiles.map((f) => (
              <RecentFileLink key={f.path} file={f} onClick={() => onOpenFile(f)} t={t} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RecentFileLink({
  file,
  onClick,
  t,
}: {
  file: NotebookFile;
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
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        color: hovered ? t.accent : t.textSecondary,
        fontSize: 12,
        fontFamily: t.font,
        textAlign: 'left' as const,
        padding: '2px 0',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap' as const,
        transition: 'color 0.15s',
      }}
    >
      {file.name.replace(/\.(dqlnb|dql)$/, '')}
    </button>
  );
}

function NewIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
      <path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 8.75 4.25V1.5ZM8.75 5.5h2.836L10.25 3.664V4.25c0 .138.112.25.25.25H8.75Zm.5 3.25a.75.75 0 0 1 .75.75v.75h.75a.75.75 0 0 1 0 1.5H10v.75a.75.75 0 0 1-1.5 0V11.5H7.75a.75.75 0 0 1 0-1.5H8.5V9.5a.75.75 0 0 1 .75-.75Z" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm7-3.25v2.992l2.028.812a.75.75 0 0 1-.557 1.392l-2.5-1A.751.751 0 0 1 7 8.25v-3.5a.75.75 0 0 1 1.5 0Z" />
    </svg>
  );
}

function BlockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8.75 1.75a.75.75 0 0 0-1.5 0V6.5H2.75a.75.75 0 0 0 0 1.5H7.25v4.75a.75.75 0 0 0 1.5 0V8H13.25a.75.75 0 0 0 0-1.5H8.75V1.75Z" />
    </svg>
  );
}
