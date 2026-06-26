import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import type {
  BlockStudioOpenPayload,
  BlockStudioPreview,
  BlockStudioValidation,
} from '../../store/types';
import { themes, type ThemeMode } from '../../themes/notebook-theme';
import { ChartOutput } from '../output/ChartOutput';
import { TableOutput } from '../output/TableOutput';
import { MiniLineageGraph } from '../lineage/MiniLineageGraph';
import { CloudFocusHeader } from './CloudFocusHeader';
import { extractSqlFromText } from '../../utils/block-studio';

interface CloudBlockViewerProps {
  path: string;
  name?: string | null;
  themeMode: ThemeMode;
}

type TabId = 'results' | 'visualization' | 'lineage' | 'validation';

export function CloudBlockViewer({ path, name, themeMode }: CloudBlockViewerProps) {
  const t = themes[themeMode];
  const [payload, setPayload] = useState<BlockStudioOpenPayload | null>(null);
  const [validation, setValidation] = useState<BlockStudioValidation | null>(null);
  const [preview, setPreview] = useState<BlockStudioPreview | null>(null);
  const [lineage, setLineage] = useState<{ nodes: any[]; edges: any[] } | null>(null);
  const [tab, setTab] = useState<TabId>('results');
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!path) {
      setError('Missing DQL block path.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    void api.openBlockStudio(path)
      .then(async (next) => {
        setPayload(next);
        setValidation(next.validation);
        const blockName = next.metadata.name || name;
        if (blockName) {
          try {
            const focused = await api.queryLineage({ focus: `block:${blockName}` });
            setLineage(focused.graph ?? null);
          } catch {
            setLineage(null);
          }
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [name, path]);

  const diagnostics = validation?.diagnostics ?? payload?.validation?.diagnostics ?? [];
  const blockTitle = payload?.metadata.name || name || path.split('/').pop()?.replace(/\.dql$/i, '') || 'DQL block';
  const source = payload?.source ?? '';
  const query = extractSqlFromText(source) ?? source;
  const chartConfig = preview?.chartConfig ?? validation?.chartConfig ?? payload?.validation.chartConfig;
  const canRun = Boolean(payload?.source);

  const runBlock = async () => {
    if (!payload) return;
    setRunning(true);
    setError(null);
    try {
      const result = await api.executeQuery(query);
      setPreview({
        sql: query,
        result,
        chartConfig: payload.validation.chartConfig,
      });
      setValidation(payload.validation);
      setTab('results');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setTab('validation');
    } finally {
      setRunning(false);
    }
  };

  const metaRows = useMemo(() => {
    if (!payload) return [];
    return [
      ['Domain', payload.metadata.domain],
      ['Owner', payload.metadata.owner],
      ['Status', payload.metadata.reviewStatus ?? 'draft'],
      ['Path', payload.path],
    ].filter(([, value]) => Boolean(value));
  }, [payload]);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#ffffff', overflow: 'hidden' }}>
      <CloudFocusHeader
        title={blockTitle}
        subtitle={payload?.metadata.description || 'Read-only block view with run, visualization, validation, and lineage.'}
        themeMode={themeMode}
        right={
          <button
            onClick={() => void runBlock()}
            disabled={!canRun || running}
            style={{
              height: 34,
              border: '1px solid #fb923c',
              borderRadius: 7,
              background: '#f97316',
              color: '#ffffff',
              cursor: canRun && !running ? 'pointer' : 'not-allowed',
              fontFamily: t.font,
              fontSize: 13,
              fontWeight: 800,
              padding: '0 14px',
              opacity: canRun && !running ? 1 : 0.65,
            }}
          >
            {running ? 'Running...' : 'Run'}
          </button>
        }
      />

      {loading ? (
        <div style={{ padding: 24, color: t.textMuted, fontSize: 13 }}>Loading block...</div>
      ) : error && !payload ? (
        <div style={{ padding: 24, color: '#dc2626', fontSize: 13 }}>{error}</div>
      ) : (
        <main style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#f8fafc' }}>
          <div style={{ borderBottom: `1px solid ${t.headerBorder}`, background: '#ffffff', padding: '8px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {metaRows.map(([label, value]) => (
                <MetaPill key={label} label={label} value={value} />
              ))}
              {payload?.metadata.tags?.map((tag) => (
                <span key={tag} style={{ borderRadius: 999, background: '#f1f5f9', color: t.textSecondary, fontSize: 11, fontWeight: 700, padding: '4px 8px' }}>
                  {tag}
                </span>
              ))}
            </div>
          </div>

          <section style={{ minHeight: 0, height: '48%', padding: '14px 16px 10px', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: t.textMuted, letterSpacing: '0.06em', textTransform: 'uppercase' }}>DQL block source</div>
              <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontMono }}>{payload?.path}</div>
            </div>
            <CodeViewer code={query} themeMode={themeMode} />
          </section>

          <section style={{ minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column', borderTop: `1px solid ${t.headerBorder}`, background: '#ffffff' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 16px', borderBottom: `1px solid ${t.headerBorder}`, overflowX: 'auto' }}>
              {(['results', 'visualization', 'lineage', 'validation'] as TabId[]).map((id) => (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  style={{
                    border: `1px solid ${tab === id ? '#f97316' : t.btnBorder}`,
                    background: tab === id ? '#fff7ed' : '#ffffff',
                    color: tab === id ? '#c2410c' : t.textSecondary,
                    borderRadius: 999,
                    cursor: 'pointer',
                    fontFamily: t.font,
                    fontSize: 12,
                    fontWeight: 800,
                    padding: '6px 10px',
                    textTransform: 'capitalize',
                  }}
                >
                  {id}
                </button>
              ))}
              <div style={{ flex: 1 }} />
              {preview && <span style={{ color: t.textMuted, fontSize: 11 }}>{preview.result.rows.length} rows</span>}
            </div>
            {error && <div style={{ padding: '8px 16px', color: '#dc2626', fontSize: 12, borderBottom: `1px solid ${t.headerBorder}` }}>{error}</div>}
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 16 }}>
              {tab === 'results' && (
                preview ? (
                  <div style={{ display: 'grid', gap: 12 }}>
                    <TableOutput result={preview.result} themeMode={themeMode} />
                  </div>
                ) : (
                  <EmptyState text="Run the block to preview rows." />
                )
              )}
              {tab === 'visualization' && (
                preview ? (
                  <ChartOutput result={preview.result} chartConfig={chartConfig} themeMode={themeMode} />
                ) : (
                  <EmptyState text="Run the block to render its visualization." />
                )
              )}
              {tab === 'lineage' && (
                lineage && lineage.nodes.length > 0 ? (
                  <MiniLineageGraph
                    nodes={lineage.nodes}
                    edges={lineage.edges}
                    focalNodeId={`block:${blockTitle}`}
                    height={520}
                    layoutMode="layered"
                  />
                ) : (
                  <EmptyState text="No lineage graph is available for this block yet." />
                )
              )}
              {tab === 'validation' && (
                <div style={{ display: 'grid', gap: 8 }}>
                  {diagnostics.length > 0 ? diagnostics.map((item, index) => (
                    <div key={`${item.code ?? item.severity}-${index}`} style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 8, padding: 10, background: '#ffffff' }}>
                      <div style={{ fontSize: 11, fontWeight: 800, color: item.severity === 'error' ? '#dc2626' : item.severity === 'warning' ? '#ca8a04' : '#2563eb', textTransform: 'uppercase' }}>{item.severity}</div>
                      <div style={{ marginTop: 4, fontSize: 13, color: t.textPrimary }}>{item.message}</div>
                    </div>
                  )) : (
                    <EmptyState text="No validation diagnostics." />
                  )}
                </div>
              )}
            </div>
          </section>
        </main>
      )}
    </div>
  );
}

function MetaPill({ label, value }: { label: string; value: string }) {
  return (
    <span
      title={`${label}: ${value}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        maxWidth: 360,
        border: '1px solid #e2e8f0',
        borderRadius: 999,
        background: '#ffffff',
        padding: '4px 9px',
        color: '#334155',
        fontSize: 12,
        lineHeight: 1.2,
      }}
    >
      <span style={{ color: '#64748b', fontSize: 10, fontWeight: 800, textTransform: 'uppercase' }}>{label}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
    </span>
  );
}

function CodeViewer({ code, themeMode }: { code: string; themeMode: ThemeMode }) {
  const t = themes[themeMode];
  const lines = code.split('\n');
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
        border: `1px solid ${t.headerBorder}`,
        borderRadius: 8,
        background: '#0f172a',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
      }}
    >
      <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 760, fontFamily: t.fontMono, fontSize: 12, lineHeight: 1.6 }}>
        <tbody>
          {lines.map((line, index) => (
            <tr key={index}>
              <td
                style={{
                  width: 44,
                  userSelect: 'none',
                  textAlign: 'right',
                  color: '#64748b',
                  background: '#111827',
                  borderRight: '1px solid #1e293b',
                  padding: '0 10px',
                  verticalAlign: 'top',
                }}
              >
                {index + 1}
              </td>
              <td style={{ color: '#e2e8f0', whiteSpace: 'pre', padding: '0 14px', verticalAlign: 'top' }}>
                {line || ' '}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div style={{ minHeight: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b', fontSize: 13 }}>
      {text}
    </div>
  );
}
