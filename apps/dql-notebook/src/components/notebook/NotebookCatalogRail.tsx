import React, { useState } from 'react';
import { Blocks, Database, Layers } from 'lucide-react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { SemanticPanel } from '../panels/SemanticPanel';
import { SchemaPanel } from '../panels/SchemaPanel';
import { BlockLibraryPanel } from '../panels/BlockLibraryPanel';

const RAIL_TABS = [
  { id: 'semantic', label: 'Semantic', icon: Layers },
  { id: 'database', label: 'Database', icon: Database },
  { id: 'blocks', label: 'Blocks', icon: Blocks },
] as const;
type RailTab = (typeof RAIL_TABS)[number]['id'];

const COLLAPSE_KEY = 'dql-notebook-catalog-rail-collapsed';
const TAB_KEY = 'dql-notebook-catalog-rail-tab';

function readCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
}
function readTab(): RailTab {
  try {
    const v = localStorage.getItem(TAB_KEY);
    if (v === 'semantic' || v === 'database' || v === 'blocks') return v;
  } catch { /* ignore */ }
  return 'semantic';
}

/**
 * Persistent, collapsible left rail for the Notebook page. Mounts the same
 * catalog browsers used on the Blocks page (Semantic metrics/dimensions, Database
 * objects, Block library) so developers can research and build cells from governed
 * assets without leaving the notebook. The panels self-load, search, virtualize,
 * and insert-to-cell — no props needed.
 */
export function NotebookCatalogRail() {
  const { state } = useNotebook();
  const t = themes[state.themeMode];
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [tab, setTab] = useState<RailTab>(readTab);

  const persistCollapsed = (next: boolean) => {
    setCollapsed(next);
    try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0'); } catch { /* ignore */ }
  };
  const persistTab = (next: RailTab) => {
    setTab(next);
    try { localStorage.setItem(TAB_KEY, next); } catch { /* ignore */ }
  };

  if (collapsed) {
    return (
      <div
        style={{
          width: 38, flex: '0 0 38px', borderRight: `1px solid ${t.headerBorder}`, background: t.cellBg,
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '8px 0',
        }}
      >
        <button
          type="button"
          title="Show catalog"
          onClick={() => persistCollapsed(false)}
          style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: t.textMuted, fontSize: 15, lineHeight: 1, padding: 4 }}
        >
          ›
        </button>
        {RAIL_TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            title={label}
            onClick={() => { persistTab(id); persistCollapsed(false); }}
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: t.textMuted, padding: 5, borderRadius: 5, display: 'flex' }}
          >
            <Icon size={15} />
          </button>
        ))}
      </div>
    );
  }

  return (
    <aside
      style={{
        width: 300, flex: '0 0 300px', maxWidth: '32vw', minWidth: 240,
        borderRight: `1px solid ${t.headerBorder}`, background: t.cellBg,
        display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '4px 4px 4px 6px', borderBottom: `1px solid ${t.headerBorder}` }}>
        {RAIL_TABS.map(({ id, label, icon: Icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => persistTab(id)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5, border: 'none', cursor: 'pointer',
                background: active ? `${t.accent}18` : 'transparent', color: active ? t.accent : t.textMuted,
                fontFamily: t.font, fontSize: 11, fontWeight: 700, padding: '4px 8px', borderRadius: 6,
              }}
            >
              <Icon size={13} />{label}
            </button>
          );
        })}
        <button
          type="button"
          title="Hide catalog"
          onClick={() => persistCollapsed(true)}
          style={{ marginLeft: 'auto', border: 'none', background: 'transparent', cursor: 'pointer', color: t.textMuted, fontSize: 15, lineHeight: 1, padding: 4 }}
        >
          ‹
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {tab === 'semantic' && <SemanticPanel />}
        {tab === 'database' && <SchemaPanel />}
        {tab === 'blocks' && <BlockLibraryPanel />}
      </div>
    </aside>
  );
}
