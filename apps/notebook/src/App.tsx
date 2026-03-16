import { useState, useEffect, useCallback, useRef } from 'react';
import { initDuckDB, loadCSV, runQuery, type QueryResult } from './duckdb.js';
import { parseDQL, type NotebookBlock } from './notebook-engine.js';
import { buildVegaSpec } from './vega-builder.js';
import { SAMPLES, SAMPLE_CSV, type Sample } from './samples/index.js';
import vegaEmbed from 'vega-embed';

interface BlockResult {
  block: NotebookBlock;
  data: QueryResult | null;
  error: string | null;
  spec: ReturnType<typeof buildVegaSpec> | null;
}

interface LoadedTable {
  name: string;
  rowCount?: number;
  source: 'sample' | 'upload' | 'cli';
}

const INITIAL_DQL = SAMPLES[0].dql;

export default function App() {
  const [dql, setDql] = useState(INITIAL_DQL);
  const [activeSample, setActiveSample] = useState<string>(SAMPLES[0].id);
  const [dbReady, setDbReady] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<BlockResult[]>([]);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [tables, setTables] = useState<LoadedTable[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chartRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Init DuckDB, then try to load CLI-provided data, then fall back to sample
  useEffect(() => {
    initDuckDB()
      .then(async () => {
        // Check if CLI pre-loaded a data file via the /api/local-data endpoint
        try {
          const res = await fetch('/api/local-data');
          if (res.ok && res.status !== 204) {
            const text = await res.text();
            const tableName = res.headers.get('X-Table-Name') || 'data';
            await loadCSV(tableName, text);
            setTables([{ name: tableName, source: 'cli' }]);
            setDbReady(true);
            return;
          }
        } catch {
          // not running from CLI server — that's fine
        }
        // Fall back to the built-in sample data
        await loadCSV('data', SAMPLE_CSV['sales']);
        setTables([{ name: 'data', source: 'sample', rowCount: SAMPLE_CSV['sales'].split('\n').length - 2 }]);
        setDbReady(true);
      })
      .catch(e => setDbError(e.message));
  }, []);

  // Render Vega charts after results change
  useEffect(() => {
    results.forEach((r, i) => {
      const el = chartRefs.current[i];
      if (el && r.spec) {
        vegaEmbed(el, r.spec as any, {
          actions: false,
          theme: 'dark',
          renderer: 'svg',
        }).catch(() => {});
      }
    });
  }, [results]);

  const run = useCallback(async () => {
    if (!dbReady) return;
    setRunning(true);
    setParseErrors([]);

    const { blocks, errors } = parseDQL(dql);
    if (errors.length || !blocks.length) {
      setParseErrors(errors.length ? errors : ['No blocks found in DQL']);
      setResults([]);
      setRunning(false);
      return;
    }

    const blockResults: BlockResult[] = [];
    for (const block of blocks) {
      try {
        const data = await runQuery(block.sql);
        const spec = block.viz ? buildVegaSpec(block.viz, data.rows, data.columns) : null;
        blockResults.push({ block, data, error: null, spec });
      } catch (e: any) {
        blockResults.push({ block, data: null, error: e.message, spec: null });
      }
    }
    setResults(blockResults);
    setRunning(false);
  }, [dql, dbReady]);

  const loadSample = (sample: Sample) => {
    setActiveSample(sample.id);
    setDql(sample.dql);
    setResults([]);
    setParseErrors([]);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !dbReady) return;
    const text = await file.text();
    const tableName = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_]/g, '_') || 'data';
    try {
      await loadCSV(tableName, text);
      const rowCount = text.split('\n').filter(l => l.trim()).length - 1;
      setTables(prev => {
        const next = prev.filter(t => t.name !== tableName);
        return [...next, { name: tableName, rowCount, source: 'upload' }];
      });
      setResults([]);
      // Show a quick hint DQL for the uploaded table
      setDql(prev => {
        const hint = `\n\n-- Loaded: ${file.name} → table "${tableName}"\n-- Replace "data" with "${tableName}" in your queries\n`;
        return prev.includes(hint) ? prev : prev + hint;
      });
    } catch (err: any) {
      setDbError(`Failed to load ${file.name}: ${err.message}`);
    }
    // reset input so same file can be re-uploaded
    e.target.value = '';
  };

  // ─── Styles ───────────────────────────────────────────────────────────────
  const s = {
    root: { display: 'flex', flexDirection: 'column' as const, height: '100vh', background: '#0f1117', fontFamily: 'system-ui, sans-serif' },
    header: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 20px', borderBottom: '1px solid #1e2533', background: '#0a0d14', flexShrink: 0 },
    logo: { display: 'flex', alignItems: 'center', gap: 8 },
    badge: { fontSize: 11, color: '#64748b', background: '#1e2533', padding: '2px 7px', borderRadius: 4 },
    samplesRow: { display: 'flex', gap: 6, marginLeft: 'auto', alignItems: 'center' },
    sampleBtn: (active: boolean) => ({
      padding: '4px 10px', borderRadius: 6, border: 'none', cursor: 'pointer',
      fontSize: 12, fontWeight: 500 as const,
      background: active ? '#6366f1' : '#1e2533',
      color: active ? '#fff' : '#94a3b8',
    }),
    dataBar: {
      display: 'flex', alignItems: 'center', gap: 10, padding: '6px 16px',
      background: '#0a0d14', borderBottom: '1px solid #1e2533', flexShrink: 0,
    },
    pill: (source: LoadedTable['source']) => ({
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 500 as const,
      background: source === 'sample' ? '#1e2533' : source === 'cli' ? '#1a2a1a' : '#1a1a2e',
      color: source === 'sample' ? '#64748b' : source === 'cli' ? '#4ade80' : '#818cf8',
      border: `1px solid ${source === 'sample' ? '#2d3748' : source === 'cli' ? '#2d4a2d' : '#2d2d5a'}`,
    }),
    uploadBtn: {
      display: 'flex', alignItems: 'center', gap: 5,
      padding: '3px 10px', borderRadius: 6, border: '1px solid #2d3748',
      background: '#1e2533', color: '#94a3b8', cursor: 'pointer',
      fontSize: 12, fontWeight: 500 as const,
    },
    main: { display: 'flex', flex: 1, overflow: 'hidden' },
    editorPane: { width: '44%', minWidth: 300, display: 'flex', flexDirection: 'column' as const, borderRight: '1px solid #1e2533' },
    editorTop: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 14px', borderBottom: '1px solid #1e2533', background: '#0a0d14' },
    label: { fontSize: 11, color: '#475569', fontWeight: 600 as const, letterSpacing: '0.06em' },
    runBtn: (disabled: boolean) => ({
      display: 'flex', alignItems: 'center', gap: 5, padding: '5px 16px', borderRadius: 6, border: 'none',
      background: disabled ? '#374151' : '#6366f1', color: '#fff', fontWeight: 600 as const,
      fontSize: 13, cursor: disabled ? 'not-allowed' : 'pointer',
    }),
    textarea: {
      flex: 1, padding: '14px 16px', resize: 'none' as const, border: 'none', outline: 'none',
      background: '#0f1117', color: '#e2e8f0',
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      fontSize: 13, lineHeight: 1.75, tabSize: 2,
    },
    errBar: { padding: '7px 14px', background: '#1a0a0a', borderTop: '1px solid #3d1515' },
    hint: { padding: '5px 14px', borderTop: '1px solid #1e2533', background: '#0a0d14', fontSize: 11, color: '#475569' },
    results: { flex: 1, overflow: 'auto', padding: 18, display: 'flex', flexDirection: 'column' as const, gap: 16 },
    empty: { flex: 1, display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center', color: '#475569', gap: 10 },
    card: { background: '#0a0d14', border: '1px solid #1e2533', borderRadius: 10, overflow: 'hidden' },
    cardHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 14px', borderBottom: '1px solid #1e2533' },
  };

  return (
    <div style={s.root}>
      {/* ── Header ── */}
      <header style={s.header}>
        <div style={s.logo}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span style={{ fontWeight: 700, fontSize: 15, color: '#e2e8f0' }}>DQL Notebook</span>
          <span style={s.badge}>
            {dbReady ? '● DuckDB ready' : dbError ? '✗ error' : '○ loading…'}
          </span>
        </div>
        <div style={s.samplesRow}>
          <span style={{ fontSize: 12, color: '#64748b' }}>Examples:</span>
          {SAMPLES.map(sample => (
            <button key={sample.id} onClick={() => loadSample(sample)} style={s.sampleBtn(activeSample === sample.id)}>
              {sample.label}
            </button>
          ))}
        </div>
      </header>

      {/* ── Data bar ── */}
      <div style={s.dataBar}>
        <span style={{ fontSize: 11, color: '#475569', fontWeight: 600, letterSpacing: '0.06em' }}>DATA TABLES</span>
        {tables.map(t => (
          <span key={t.name} style={s.pill(t.source)}>
            {t.source === 'sample' ? '⊙' : t.source === 'cli' ? '⊕' : '⊞'} {t.name}
            {t.rowCount != null && <span style={{ opacity: 0.7 }}> · {t.rowCount.toLocaleString()} rows</span>}
            {t.source === 'sample' && <span style={{ opacity: 0.6 }}> (sample)</span>}
            {t.source === 'cli'    && <span style={{ opacity: 0.6 }}> (--data)</span>}
          </span>
        ))}
        <button style={s.uploadBtn} onClick={() => fileInputRef.current?.click()} disabled={!dbReady}>
          ↑ Load CSV
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.tsv"
          style={{ display: 'none' }}
          onChange={handleFileUpload}
        />
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#334155' }}>
          Use <code style={{ color: '#6366f1' }}>FROM &lt;table-name&gt;</code> in your SQL
        </span>
      </div>

      {/* ── Main split pane ── */}
      <div style={s.main}>
        {/* Editor */}
        <div style={s.editorPane}>
          <div style={s.editorTop}>
            <span style={s.label}>DQL EDITOR</span>
            <button onClick={run} disabled={!dbReady || running} style={s.runBtn(!dbReady || running)}>
              {running ? '⟳ Running…' : '▶ Run'}
            </button>
          </div>
          <textarea
            value={dql}
            onChange={e => setDql(e.target.value)}
            spellCheck={false}
            onKeyDown={e => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
              if (e.key === 'Tab') {
                e.preventDefault();
                const s = e.currentTarget.selectionStart;
                const end = e.currentTarget.selectionEnd;
                setDql(d => d.slice(0, s) + '  ' + d.slice(end));
              }
            }}
            style={s.textarea}
          />
          {parseErrors.length > 0 && (
            <div style={s.errBar}>
              {parseErrors.map((e, i) => (
                <div key={i} style={{ color: '#f87171', fontSize: 12, fontFamily: 'monospace' }}>⚠ {e}</div>
              ))}
            </div>
          )}
          {dbError && (
            <div style={{ ...s.errBar, borderTop: '1px solid #3d1515' }}>
              <div style={{ color: '#f87171', fontSize: 12, fontFamily: 'monospace' }}>✗ DuckDB: {dbError}</div>
            </div>
          )}
          <div style={s.hint}>
            ⌘↩ run &nbsp;·&nbsp; Tab indent &nbsp;·&nbsp; Upload CSV to query your own data
          </div>
        </div>

        {/* Results */}
        <div style={s.results}>
          {results.length === 0 && !running && (
            <div style={s.empty}>
              <svg width="44" height="44" viewBox="0 0 24 24" fill="none" opacity={0.35}>
                <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3z" stroke="#6366f1" strokeWidth="1.5" strokeLinecap="round"/>
                <circle cx="17.5" cy="17.5" r="2.5" stroke="#6366f1" strokeWidth="1.5"/>
              </svg>
              <p style={{ fontSize: 14, margin: 0 }}>
                Press <kbd style={{ background: '#1e2533', padding: '2px 7px', borderRadius: 4, color: '#94a3b8' }}>▶ Run</kbd> to see your chart
              </p>
              <p style={{ fontSize: 12, margin: 0, color: '#334155', textAlign: 'center', maxWidth: 360 }}>
                Write a <code style={{ color: '#6366f1' }}>block</code> with a <code style={{ color: '#6366f1' }}>query</code> + <code style={{ color: '#6366f1' }}>visualization</code>.<br/>
                Use the sample data or upload your own CSV above.
              </p>
            </div>
          )}

          {running && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#64748b', fontSize: 14 }}>
              <span>⟳</span> Executing…
            </div>
          )}

          {results.map((r, i) => (
            <div key={r.block.id} style={s.card}>
              <div style={s.cardHead}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: 14, color: '#e2e8f0' }}>{r.block.name}</span>
                  {r.block.viz && (
                    <span style={{ fontSize: 11, color: '#6366f1', background: '#1e1f3a', padding: '2px 7px', borderRadius: 4 }}>
                      {r.block.viz.chart}
                    </span>
                  )}
                </div>
                {r.data && (
                  <span style={{ fontSize: 11, color: '#475569' }}>{r.data.rows.length} rows</span>
                )}
              </div>

              {r.error && (
                <div style={{ padding: '10px 14px', color: '#f87171', fontFamily: 'monospace', fontSize: 12, background: '#1a0a0a' }}>
                  {r.error}
                </div>
              )}

              {r.spec && !r.error && (
                <div style={{ padding: 16 }}>
                  <div
                    ref={el => { chartRefs.current[i] = el; }}
                    style={{ width: '100%', background: 'transparent' }}
                  />
                </div>
              )}

              {/* Table view for blocks without a visualization */}
              {r.data && r.data.rows.length > 0 && !r.block.viz && !r.error && (
                <div style={{ overflow: 'auto', maxHeight: 300 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: '#111827' }}>
                        {r.data.columns.map(c => (
                          <th key={c.name} style={{ padding: '6px 12px', textAlign: 'left', color: '#64748b', fontWeight: 500, borderBottom: '1px solid #1e2533' }}>
                            {c.name}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {r.data.rows.slice(0, 50).map((row, ri) => (
                        <tr key={ri} style={{ borderBottom: '1px solid #111827' }}>
                          {r.data!.columns.map(c => (
                            <td key={c.name} style={{ padding: '5px 12px', color: '#94a3b8', fontFamily: 'monospace' }}>
                              {String(row[c.name] ?? '')}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {r.data.rows.length > 50 && (
                    <div style={{ padding: '6px 12px', fontSize: 11, color: '#475569', borderTop: '1px solid #1e2533' }}>
                      Showing 50 of {r.data.rows.length} rows
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
