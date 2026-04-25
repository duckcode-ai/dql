import React, { useEffect, useState } from 'react';
import { PanelFrame, PanelToolbar, PanelEmpty, StatusPill } from '@duckcodeailabs/dql-ui';
import { api } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { STATUS_COLORS, type BlockEntry } from '../blocks/block-types';

const STATUS_TONE: Record<string, 'success' | 'warning' | 'accent' | 'neutral' | 'error'> = {
  certified: 'success',
  published: 'success',
  deprecated: 'error',
  draft: 'warning',
  pending: 'warning',
  review: 'accent',
};

export function BlockLibraryPanel() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];

  const [blocks, setBlocks] = useState<BlockEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [domainFilter, setDomainFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  useEffect(() => {
    setLoading(true);
    api.getBlockLibrary()
      .then((result) => setBlocks(result.blocks))
      .finally(() => setLoading(false));
  }, []);

  const domains = [...new Set(blocks.map((b) => b.domain))].sort();
  const statuses = [...new Set(blocks.map((b) => b.status))].sort();

  const filtered = blocks.filter((b) => {
    if (search && !b.name.toLowerCase().includes(search.toLowerCase()) && !b.description.toLowerCase().includes(search.toLowerCase())) return false;
    if (domainFilter && b.domain !== domainFilter) return false;
    if (statusFilter && b.status !== statusFilter) return false;
    return true;
  });

  const handleOpen = (block: BlockEntry) => {
    const file = {
      name: block.path.split('/').pop() ?? block.name,
      path: block.path,
      type: 'block' as const,
      folder: 'blocks',
    };
    if (!state.files.some((f) => f.path === block.path)) {
      dispatch({ type: 'FILE_ADDED', file });
    }
    void api.openBlockStudio(block.path).then((payload) => {
      dispatch({ type: 'OPEN_BLOCK_STUDIO', file, payload });
    });
  };

  const refresh = () => {
    setLoading(true);
    api.getBlockLibrary()
      .then((r) => setBlocks(r.blocks))
      .finally(() => setLoading(false));
  };

  const inputStyle: React.CSSProperties = {
    background: t.inputBg,
    border: `1px solid ${t.inputBorder}`,
    borderRadius: 6,
    color: t.textPrimary,
    fontSize: 11,
    fontFamily: t.font,
    padding: '6px 10px',
    outline: 'none',
  };
  // Custom select with embedded SVG chevron — replaces the native dropdown
  // arrow which doesn't honor the theme.
  const chevronSvg = `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'><path fill='none' stroke='${t.textMuted}' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round' d='M2 4l3 3 3-3'/></svg>`
  )}`;
  const selectStyle: React.CSSProperties = {
    ...inputStyle,
    appearance: 'none' as const,
    WebkitAppearance: 'none' as const,
    MozAppearance: 'none' as const,
    backgroundImage: `url("${chevronSvg}")`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'right 8px center',
    paddingRight: 24,
    cursor: 'pointer',
  };

  const actions = (
    <>
      <button
        onClick={() => dispatch({ type: 'OPEN_NEW_BLOCK_MODAL' })}
        style={{
          background: t.accent, border: 'none', borderRadius: 4,
          color: '#fff', cursor: 'pointer', fontSize: 10, fontWeight: 600,
          fontFamily: t.font, padding: '3px 10px',
        }}
      >
        + New
      </button>
      <button
        onClick={refresh}
        style={{
          background: 'transparent', border: `1px solid ${t.cellBorder}`, borderRadius: 4,
          color: t.textSecondary, cursor: 'pointer', fontSize: 10, fontFamily: t.font, padding: '3px 8px',
        }}
      >
        Refresh
      </button>
    </>
  );

  const toolbar = (
    <PanelToolbar>
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search blocks..."
        style={{ ...inputStyle, flex: 1, minWidth: 100 }}
      />
      <select value={domainFilter} onChange={(e) => setDomainFilter(e.target.value)} style={selectStyle}>
        <option value="">All domains</option>
        {domains.map((d) => <option key={d} value={d}>{d}</option>)}
      </select>
      <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
        <option value="">All statuses</option>
        {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
    </PanelToolbar>
  );

  return (
    <PanelFrame
      title="Blocks"
      status={<span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>{filtered.length}</span>}
      actions={actions}
      toolbar={toolbar}
      bodyPadding={0}
    >
      {loading ? (
        <PanelEmpty title="Loading blocks…" />
      ) : filtered.length === 0 ? (
        <PanelEmpty
          title={blocks.length === 0 ? 'No blocks yet' : 'No matches'}
          description={
            blocks.length === 0
              ? 'Create your first block to get started.'
              : 'No blocks match your filters.'
          }
        />
      ) : (
        filtered.map((block) => (
          <button
            key={block.path}
            onClick={() => handleOpen(block)}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              background: 'transparent', border: 'none', borderBottom: `1px solid ${t.cellBorder}`,
              cursor: 'pointer', padding: '10px 12px',
              transition: 'background 0.1s',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = `${t.accent}0a`; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: t.textPrimary, fontFamily: t.font }}>
                {block.name}
              </span>
              <StatusPill tone={STATUS_TONE[block.status] ?? 'neutral'}>
                {block.status}
              </StatusPill>
            </div>
            {block.description && (
              <div style={{
                fontSize: 11, color: t.textMuted, fontFamily: t.font, lineHeight: 1.3,
                marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {block.description}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, color: t.textMuted, fontFamily: t.font }}>
              <span style={{ background: t.pillBg, padding: '1px 6px', borderRadius: 4 }}>
                {block.domain}
              </span>
              {block.owner && <span>by {block.owner}</span>}
              {block.llmContext && (
                <span
                  title={block.llmContext}
                  style={{ color: t.accent, fontWeight: 600, letterSpacing: '0.04em' }}
                >
                  AI
                </span>
              )}
              <span style={{ marginLeft: 'auto' }}>
                {new Date(block.lastModified).toLocaleDateString()}
              </span>
            </div>
          </button>
        ))
      )}
    </PanelFrame>
  );
}
