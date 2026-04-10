import React from 'react';
import type { SemanticObjectDetail } from '../../store/types';
import type { Theme } from '../../themes/notebook-theme';

interface MetricDetailPanelProps {
  item: SemanticObjectDetail | null;
  favorite: boolean;
  onInsert: () => void;
  onPreview: () => void;
  onCopySql: () => void;
  onToggleFavorite: () => void;
  t: Theme;
}

export function MetricDetailPanel({
  item,
  favorite,
  onInsert,
  onPreview,
  onCopySql,
  onToggleFavorite,
  t,
}: MetricDetailPanelProps) {
  if (!item) return null;

  const isInsertable = item.kind === 'metric' || item.kind === 'dimension';
  const isPreviewable = Boolean(item.sql);
  const sourceLabel = item.source ? `${item.source.provider} · ${item.source.objectType}` : null;

  return (
    <div
      style={{
        borderTop: `1px solid ${t.headerBorder}`,
        padding: '12px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        background: `${t.cellBg}cc`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: t.textPrimary, fontFamily: t.font }}>
            {item.label || item.name}
          </div>
          <div style={{ fontSize: 10, color: t.textMuted, fontFamily: t.fontMono }}>
            {item.kind} · {item.name}
          </div>
        </div>
        <button
          onClick={onToggleFavorite}
          style={{
            background: favorite ? '#e3b34122' : 'transparent',
            border: `1px solid ${favorite ? '#e3b34166' : t.cellBorder}`,
            borderRadius: 6,
            color: favorite ? '#e3b341' : t.textMuted,
            cursor: 'pointer',
            fontSize: 11,
            fontFamily: t.font,
            padding: '4px 8px',
          }}
        >
          {favorite ? 'Favorited' : 'Favorite'}
        </button>
      </div>

      {item.description && (
        <div style={{ fontSize: 12, color: t.textSecondary, fontFamily: t.font, lineHeight: 1.5 }}>
          {item.description}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 11, fontFamily: t.fontMono, color: t.textMuted }}>
        <div>domain: {item.domain || 'uncategorized'}</div>
        <div>owner: {item.owner ?? 'unassigned'}</div>
        {item.table ? <div>table: {item.table}</div> : <div />}
        {item.cube ? <div>cube: {item.cube}</div> : <div />}
        {item.type ? <div>type: {item.type}</div> : <div />}
        {sourceLabel ? <div>source: {sourceLabel}</div> : <div />}
      </div>

      {item.tags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {item.tags.map((tag) => (
            <span
              key={tag}
              style={{
                fontSize: 10,
                color: t.textMuted,
                background: t.pillBg,
                borderRadius: 999,
                padding: '2px 8px',
                fontFamily: t.font,
              }}
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {item.sql && (
        <pre
          style={{
            margin: 0,
            padding: '8px 10px',
            background: t.editorBg,
            border: `1px solid ${t.cellBorder}`,
            borderRadius: 6,
            fontSize: 10,
            fontFamily: t.fontMono,
            color: t.textSecondary,
            overflowX: 'auto',
            whiteSpace: 'pre-wrap',
          }}
        >
          {item.sql}
        </pre>
      )}

      {item.joins && item.joins.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: t.textSecondary, fontFamily: t.font }}>Joins</div>
          {item.joins.map((join) => (
            <div key={join.name} style={{ fontSize: 10, color: t.textMuted, fontFamily: t.fontMono }}>
              {join.left} {join.type} {join.right}
            </div>
          ))}
        </div>
      )}

      {item.levels && item.levels.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: t.textSecondary, fontFamily: t.font }}>Levels</div>
          {item.levels.map((level) => (
            <div key={level.name} style={{ fontSize: 10, color: t.textMuted, fontFamily: t.fontMono }}>
              {level.order}. {level.label} → {level.dimension}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={onPreview}
          disabled={!isPreviewable}
          style={{ flex: 1, background: t.btnBg, border: `1px solid ${t.btnBorder}`, borderRadius: 6, color: t.textSecondary, cursor: 'pointer', fontSize: 11, fontFamily: t.font, padding: '6px 10px' }}
        >
          Preview Data
        </button>
        <button
          onClick={onCopySql}
          disabled={!item.sql}
          style={{ flex: 1, background: t.btnBg, border: `1px solid ${t.btnBorder}`, borderRadius: 6, color: t.textSecondary, cursor: 'pointer', fontSize: 11, fontFamily: t.font, padding: '6px 10px' }}
        >
          Copy SQL
        </button>
        <button
          onClick={onInsert}
          disabled={!isInsertable}
          style={{ flex: 1, background: t.accent, border: `1px solid ${t.accent}`, borderRadius: 6, color: '#fff', cursor: 'pointer', fontSize: 11, fontFamily: t.font, padding: '6px 10px' }}
        >
          {isInsertable ? 'Insert' : 'Inspect'}
        </button>
      </div>
    </div>
  );
}
