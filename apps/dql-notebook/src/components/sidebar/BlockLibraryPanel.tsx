import React, { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { STATUS_COLORS, type BlockEntry } from '../blocks/block-types';

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

  const selectStyle = {
    background: t.inputBg,
    border: `1px solid ${t.inputBorder}`,
    borderRadius: 4,
    color: t.textPrimary,
    fontSize: 11,
    fontFamily: t.font,
    padding: '4px 6px',
    outline: 'none',
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        padding: '10px 12px', borderBottom: `1px solid ${t.headerBorder}`,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: t.textPrimary, fontFamily: t.font }}>
          Blocks
        </span>
        <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
          {filtered.length}
        </span>
        <span style={{ flex: 1 }} />
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
          onClick={() => { setLoading(true); api.getBlockLibrary().then((r) => setBlocks(r.blocks)).finally(() => setLoading(false)); }}
          style={{
            background: 'transparent', border: `1px solid ${t.cellBorder}`, borderRadius: 4,
            color: t.textSecondary, cursor: 'pointer', fontSize: 10, fontFamily: t.font, padding: '3px 8px',
          }}
        >
          Refresh
        </button>
      </div>

      {/* Filters */}
      <div style={{ padding: '8px 12px', borderBottom: `1px solid ${t.headerBorder}`, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search blocks..."
          style={{
            ...selectStyle,
            flex: 1, minWidth: 100,
          }}
        />
        <select value={domainFilter} onChange={(e) => setDomainFilter(e.target.value)} style={selectStyle}>
          <option value="">All domains</option>
          {domains.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="">All statuses</option>
          {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {/* Block list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: t.textMuted, fontFamily: t.font }}>
            Loading blocks...
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: t.textMuted, fontFamily: t.font }}>
            {blocks.length === 0 ? 'No blocks found. Create your first block to get started.' : 'No blocks match your filters.'}
          </div>
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
                <span style={{
                  fontSize: 9, fontWeight: 600, color: STATUS_COLORS[block.status] ?? t.textMuted,
                  background: `${STATUS_COLORS[block.status] ?? t.textMuted}18`,
                  padding: '1px 6px', borderRadius: 4, textTransform: 'uppercase',
                  letterSpacing: '0.04em', fontFamily: t.font,
                }}>
                  {block.status}
                </span>
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
                <span style={{
                  background: t.pillBg, padding: '1px 6px', borderRadius: 4,
                }}>{block.domain}</span>
                {block.owner && <span>by {block.owner}</span>}
                {block.llmContext && (
                  <span
                    title={block.llmContext}
                    style={{
                      color: t.accent,
                      fontWeight: 600,
                      letterSpacing: '0.04em',
                    }}
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
      </div>
    </div>
  );
}
