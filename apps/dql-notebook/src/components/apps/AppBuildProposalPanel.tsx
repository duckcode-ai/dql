import React, { useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, Code2, FileSearch, Loader2, ShieldAlert, ShieldCheck, Sparkles } from 'lucide-react';
import type { Theme } from '../../themes/notebook-theme';
import type { AppBuildProposal, AppBuildProposalTile } from '../../api/client';

/** Tile ids that start checked: everything selectable the planner recommends. */
export function defaultProposalSelection(proposal: AppBuildProposal): Set<string> {
  return new Set(proposal.tiles.filter((tile) => !tile.error && tile.selectedByDefault).map((tile) => tile.id));
}

/**
 * The confirmable pre-create content list for the two-phase app build: every
 * proposed tile with a trust badge and an include/exclude toggle, uncovered
 * questions listed as gaps, and a single "Create app" confirm. Shared by the
 * Apps hero builder and the chat `app_proposal` artifact card.
 */
export function AppBuildProposalPanel({
  proposal,
  t,
  selected,
  onToggle,
  onCreate,
  busy,
  error,
  compact,
}: {
  proposal: AppBuildProposal;
  t: Theme;
  selected: Set<string>;
  onToggle: (tileId: string) => void;
  onCreate: () => void;
  busy?: boolean;
  error?: string | null;
  compact?: boolean;
}) {
  const selectable = proposal.tiles.filter((tile) => !tile.error);
  const failed = proposal.tiles.filter((tile) => tile.error);
  const selectedCount = selectable.filter((tile) => selected.has(tile.id)).length;
  const generatedSelected = selectable.filter((tile) => selected.has(tile.id) && tile.certification === 'ai_generated').length;
  // An app must be anchored by at least one certified tile (commit enforces this too).
  const certifiedSelected = selectable.filter((tile) => selected.has(tile.id) && tile.certification === 'certified').length;
  const canCreate = certifiedSelected > 0;

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12.5, fontWeight: 800, color: t.textPrimary }}>Proposed app content</span>
        <span style={{ fontSize: 11, color: t.textMuted }}>
          {proposal.coverage.certifiedTiles} certified
          {proposal.coverage.generatedTiles > 0 ? ` · ${proposal.coverage.generatedTiles} AI-generated` : ''}
          {proposal.coverage.gaps > 0 ? ` · ${proposal.coverage.gaps} uncovered` : ''}
        </span>
      </div>

      <div style={{ display: 'grid', gap: 6 }}>
        {selectable.map((tile) => (
          <ProposalTileRow
            key={tile.id}
            tile={tile}
            t={t}
            checked={selected.has(tile.id)}
            onToggle={() => onToggle(tile.id)}
            compact={compact}
          />
        ))}
        {failed.map((tile) => (
          <div key={tile.id} style={{ ...tileRowStyle(t), opacity: 0.75 }}>
            <ShieldAlert size={13} color={t.warning} style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: t.textSecondary }}>{tile.title}</div>
              <div style={{ fontSize: 11, color: t.textMuted, marginTop: 1 }}>{tile.error}</div>
            </div>
          </div>
        ))}
      </div>

      {proposal.gaps.length > 0 ? (
        <div style={{ display: 'grid', gap: 4 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: t.textMuted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Not covered yet
          </div>
          {proposal.gaps.map((gap) => (
            <div key={gap.id} style={{ display: 'flex', gap: 7, alignItems: 'flex-start', fontSize: 11.5, color: t.textMuted }}>
              <FileSearch size={12} style={{ flexShrink: 0, marginTop: 2 }} />
              <span style={{ lineHeight: 1.4 }}>{gap.question}</span>
            </div>
          ))}
        </div>
      ) : null}

      {error ? <div style={{ fontSize: 12, color: t.error }}>{error}</div> : null}

      <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="dql-hover"
          onClick={onCreate}
          disabled={busy || !canCreate}
          style={createButtonStyle(t, canCreate && !busy)}
        >
          {busy ? <Loader2 size={13} style={{ animation: 'dql-agent-run-spin 0.8s linear infinite' }} /> : <CheckCircle2 size={13} />}
          <span>{busy ? 'Creating app…' : `Create app (${selectedCount} tile${selectedCount === 1 ? '' : 's'})`}</span>
        </button>
        <span style={{ fontSize: 11, color: t.textMuted }}>
          {!canCreate
            ? 'Select at least one certified tile — an app needs a certified anchor.'
            : generatedSelected > 0
              ? `${generatedSelected} AI-generated tile${generatedSelected === 1 ? '' : 's'} will stay review-required until certified.`
              : 'Nothing is created until you confirm.'}
        </span>
      </div>
    </div>
  );
}

function ProposalTileRow({
  tile,
  t,
  checked,
  onToggle,
  compact,
}: {
  tile: AppBuildProposalTile;
  t: Theme;
  checked: boolean;
  onToggle: () => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const certified = tile.certification === 'certified';
  const hasDetail = Boolean(tile.sql || tile.answer || (tile.preview && tile.preview.rows.length > 0));
  return (
    <div style={tileRowStyle(t)}>
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        aria-label={`Include ${tile.title}`}
        style={{ marginTop: 2, accentColor: t.accent, cursor: 'pointer', flexShrink: 0 }}
      />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12.5, fontWeight: 750, color: t.textPrimary }}>{tile.title}</span>
          {certified ? (
            <span style={badgeStyle(t.success)}>
              <ShieldCheck size={10} /> certified
            </span>
          ) : (
            <span style={badgeStyle(t.warning)}>
              <Sparkles size={10} /> AI-generated · needs review
            </span>
          )}
          <span style={{ fontSize: 10, color: t.textMuted }}>{tile.viz}</span>
        </div>
        {tile.description && !compact ? (
          <div style={{ fontSize: 11.5, color: t.textSecondary, marginTop: 2, lineHeight: 1.4 }}>{tile.description}</div>
        ) : null}
        {tile.question && tile.question !== tile.title ? (
          <div style={{ fontSize: 11, color: t.textMuted, marginTop: 2 }}>Answers: {tile.question}</div>
        ) : null}
        {hasDetail ? (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            style={{ border: 'none', background: 'transparent', color: t.accent, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10.5, fontWeight: 700, padding: 0, marginTop: 4, fontFamily: t.font }}
          >
            {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            <Code2 size={11} /> {open ? 'Hide details' : 'Show SQL & preview'}
          </button>
        ) : null}
        {open && tile.answer ? (
          <div style={{ fontSize: 11.5, color: t.textSecondary, marginTop: 5, lineHeight: 1.4 }}>{tile.answer}</div>
        ) : null}
        {open && tile.sql ? (
          <pre style={sqlStyle(t)}>{tile.sql}</pre>
        ) : null}
        {open && tile.preview && tile.preview.rows.length > 0 ? (
          <MiniPreviewTable preview={tile.preview} t={t} />
        ) : null}
      </div>
    </div>
  );
}

function MiniPreviewTable({ preview, t }: { preview: NonNullable<AppBuildProposalTile['preview']>; t: Theme }) {
  const columns = preview.columns.slice(0, 5);
  const rows = preview.rows.slice(0, 5);
  return (
    <div style={{ marginTop: 5, overflow: 'auto', border: `1px solid ${t.headerBorder}`, borderRadius: 6 }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 10.5, fontFamily: t.fontMono, width: '100%' }}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} style={{ textAlign: 'left', padding: '3px 8px', color: t.textMuted, borderBottom: `1px solid ${t.headerBorder}`, fontWeight: 700, whiteSpace: 'nowrap' }}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td key={column} style={{ padding: '3px 8px', color: t.textSecondary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 160 }}>
                  {formatCell(row[column])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {typeof preview.rowCount === 'number' && preview.rowCount > rows.length ? (
        <div style={{ fontSize: 10, color: t.textMuted, padding: '3px 8px' }}>{preview.rowCount} rows total</div>
      ) : null}
    </div>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return String(value);
}

function tileRowStyle(t: Theme): React.CSSProperties {
  return {
    display: 'flex',
    gap: 9,
    alignItems: 'flex-start',
    border: `1px solid ${t.cellBorder}`,
    background: t.cellBg,
    borderRadius: 8,
    padding: '9px 11px',
  };
}

function badgeStyle(color: string): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    border: `1px solid ${color}55`,
    color,
    background: `${color}12`,
    borderRadius: 999,
    padding: '1px 7px',
    fontSize: 9.5,
    fontWeight: 800,
  };
}

function sqlStyle(t: Theme): React.CSSProperties {
  return {
    margin: '5px 0 0',
    maxHeight: 140,
    overflow: 'auto',
    border: `1px solid ${t.headerBorder}`,
    background: t.editorBg,
    borderRadius: 6,
    padding: 8,
    fontSize: 10.5,
    fontFamily: t.fontMono,
    color: t.textSecondary,
    lineHeight: 1.45,
    whiteSpace: 'pre-wrap',
  };
}

function createButtonStyle(t: Theme, enabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    border: 'none',
    borderRadius: 8,
    padding: '8px 14px',
    fontSize: 12.5,
    fontWeight: 800,
    fontFamily: t.font,
    cursor: enabled ? 'pointer' : 'default',
    background: enabled ? t.accent : `${t.accent}55`,
    color: '#fff',
  };
}
