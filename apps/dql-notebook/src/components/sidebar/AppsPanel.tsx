import React, { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import type { NotebookFile } from '../../store/types';

interface AppsPanelProps {
  onOpenFile: (file: NotebookFile) => void;
}

interface AppEntry {
  path: string;
  manifest: {
    name: string;
    domain: string;
    owner?: string;
    description?: string;
    cadence?: string;
    consumers?: string[];
    entryPoints?: string[];
  };
  notebooks: string[];
  dashboards: string[];
  hasDigest: boolean;
}

export function AppsPanel({ onOpenFile }: AppsPanelProps) {
  const { state } = useNotebook();
  const t = themes[state.themeMode];

  const [apps, setApps] = useState<AppEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [domainFilter, setDomainFilter] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const refresh = () => {
    setLoading(true);
    api.getApps()
      .then((r) => setApps(r.apps))
      .finally(() => setLoading(false));
  };

  useEffect(() => { refresh(); }, []);

  const domains = [...new Set(apps.map((a) => a.manifest.domain))].sort();
  const filtered = apps.filter((a) => {
    const s = search.toLowerCase();
    if (s && !a.manifest.name.toLowerCase().includes(s) && !(a.manifest.description ?? '').toLowerCase().includes(s)) return false;
    if (domainFilter && a.manifest.domain !== domainFilter) return false;
    return true;
  });

  const toggle = (name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const openNotebook = (app: AppEntry, notebook: string) => {
    const fullPath = `${app.path}/notebooks/${notebook}`;
    const file: NotebookFile = {
      name: notebook,
      path: fullPath,
      type: 'notebook',
      folder: 'notebooks',
    };
    onOpenFile(file);
  };

  const openDashboard = (app: AppEntry, dashboard: string) => {
    const fullPath = `${app.path}/dashboards/${dashboard}`;
    const file: NotebookFile = {
      name: dashboard,
      path: fullPath,
      type: 'dashboard',
      folder: 'dashboards',
    };
    onOpenFile(file);
  };

  const selectStyle: React.CSSProperties = {
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
          Apps
        </span>
        <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
          {filtered.length}
        </span>
        <span style={{ flex: 1 }} />
        <button
          onClick={refresh}
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
          placeholder="Search apps..."
          style={{ ...selectStyle, flex: 1, minWidth: 100 }}
        />
        <select value={domainFilter} onChange={(e) => setDomainFilter(e.target.value)} style={selectStyle}>
          <option value="">All domains</option>
          {domains.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>

      {/* App list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: t.textMuted, fontFamily: t.font }}>
            Loading apps...
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: t.textMuted, fontFamily: t.font, lineHeight: 1.5 }}>
            {apps.length === 0 ? (
              <>
                No apps yet.
                <br />
                <span style={{ fontSize: 11 }}>
                  Create one from the CLI:
                </span>
                <br />
                <code style={{
                  display: 'inline-block', marginTop: 6, padding: '2px 6px',
                  background: t.inputBg, borderRadius: 3, fontSize: 10,
                }}>
                  dql app new &lt;name&gt; --domain &lt;domain&gt;
                </code>
              </>
            ) : 'No apps match your filters.'}
          </div>
        ) : (
          filtered.map((app) => {
            const isOpen = expanded.has(app.manifest.name);
            return (
              <div key={app.path} style={{ borderBottom: `1px solid ${t.cellBorder}` }}>
                <button
                  onClick={() => toggle(app.manifest.name)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    background: 'transparent', border: 'none',
                    cursor: 'pointer', padding: '10px 12px',
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = `${t.accent}0a`; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.font, width: 10 }}>
                      {isOpen ? '▾' : '▸'}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: t.textPrimary, fontFamily: t.font }}>
                      {app.manifest.name}
                    </span>
                    <span style={{
                      fontSize: 9, fontWeight: 600, color: t.accent,
                      background: `${t.accent}18`,
                      padding: '1px 6px', borderRadius: 4, textTransform: 'uppercase',
                      letterSpacing: '0.04em', fontFamily: t.font,
                    }}>
                      {app.manifest.domain}
                    </span>
                  </div>
                  {app.manifest.description && (
                    <div style={{
                      fontSize: 11, color: t.textMuted, fontFamily: t.font, lineHeight: 1.3,
                      marginBottom: 4, marginLeft: 16,
                    }}>
                      {app.manifest.description}
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, color: t.textMuted, fontFamily: t.font, marginLeft: 16 }}>
                    {app.manifest.owner && <span>by {app.manifest.owner}</span>}
                    <span>{app.notebooks.length} notebook{app.notebooks.length === 1 ? '' : 's'}</span>
                    <span>{app.dashboards.length} dashboard{app.dashboards.length === 1 ? '' : 's'}</span>
                    {app.hasDigest && <span style={{ color: t.accent }}>digest</span>}
                  </div>
                </button>
                {isOpen && (
                  <div style={{ padding: '4px 0 10px 28px', background: `${t.accent}04` }}>
                    {app.notebooks.length === 0 && app.dashboards.length === 0 && !app.hasDigest && (
                      <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font, padding: '4px 0' }}>
                        (empty app scaffold)
                      </div>
                    )}
                    {app.notebooks.map((nb) => (
                      <button
                        key={nb}
                        onClick={() => openNotebook(app, nb)}
                        style={{
                          display: 'block', width: '100%', textAlign: 'left',
                          background: 'transparent', border: 'none',
                          padding: '3px 12px',
                          cursor: 'pointer', fontSize: 11, color: t.textSecondary, fontFamily: t.font,
                        }}
                      >
                        📓 {nb}
                      </button>
                    ))}
                    {app.dashboards.map((d) => (
                      <div key={d} style={{ padding: '3px 12px', fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
                        📊 {d}
                      </div>
                    ))}
                    {app.hasDigest && (
                      <div style={{ padding: '3px 12px', fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
                        📰 digest.dql
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
