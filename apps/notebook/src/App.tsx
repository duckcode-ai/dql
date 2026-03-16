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

const INITIAL_DQL = SAMPLES[0].dql;

export default function App() {
  const [dql, setDql] = useState(INITIAL_DQL);
  const [activeSample, setActiveSample] = useState(SAMPLES[0].id);
  const [dbReady, setDbReady] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<BlockResult[]>([]);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const chartRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Init DuckDB + load sample data
  useEffect(() => {
    initDuckDB()
      .then(async () => {
        await loadCSV('data', SAMPLE_CSV['sales']);
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#0f1117' }}>
      {/* Header */}
      <header style={{
        display: 'flex', alignItems: 'center', gap: 16, padding: '12px 20px',
        borderBottom: '1px solid #1e2533', background: '#0a0d14',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span style={{ fontWeight: 700, fontSize: 16, color: '#e2e8f0' }}>DQL Notebook</span>
          <span style={{ fontSize: 11, color: '#64748b', background: '#1e2533', padding: '2px 6px', borderRadius: 4 }}>
            {dbReady ? '● DuckDB ready' : dbError ? '✗ DuckDB error' : '○ Loading…'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, marginLeft: 'auto', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#64748b' }}>Examples:</span>
          {SAMPLES.map(s => (
            <button key={s.id}
              onClick={() => loadSample(s)}
              style={{
                padding: '4px 10px', borderRadius: 6, border: 'none', cursor: 'pointer',
                fontSize: 12, fontWeight: 500,
                background: activeSample === s.id ? '#6366f1' : '#1e2533',
                color: activeSample === s.id ? '#fff' : '#94a3b8',
                transition: 'all 0.15s',
              }}>
              {s.label}
            </button>
          ))}
        </div>
      </header>

      {/* Main content */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Editor pane */}
        <div style={{
          width: '44%', minWidth: 320, display: 'flex', flexDirection: 'column',
          borderRight: '1px solid #1e2533',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '8px 16px', borderBottom: '1px solid #1e2533',
            background: '#0a0d14',
          }}>
            <span style={{ fontSize: 12, color: '#64748b', fontWeight: 500, letterSpacing: '0.05em' }}>
              DQL EDITOR
            </span>
            <button
              onClick={run}
              disabled={!dbReady || running}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '6px 16px', borderRadius: 6, border: 'none', cursor: 'pointer',
                background: !dbReady || running ? '#374151' : '#6366f1',
                color: '#fff', fontWeight: 600, fontSize: 13,
                transition: 'background 0.15s',
              }}>
              {running ? '⟳ Running…' : '▶ Run'}
            </button>
          </div>
          <textarea
            value={dql}
            onChange={e => setDql(e.target.value)}
            spellCheck={false}
            onKeyDown={e => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
              if (e.key === 'Tab') { e.preventDefault(); setDql(d => d.slice(0, e.currentTarget.selectionStart) + '  ' + d.slice(e.currentTarget.selectionEnd)); }
            }}
            style={{
              flex: 1, padding: '16px', resize: 'none', border: 'none', outline: 'none',
              background: '#0f1117', color: '#e2e8f0', fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
              fontSize: 13, lineHeight: 1.7, tabSize: 2,
            }}
          />
          {parseErrors.length > 0 && (
            <div style={{ padding: '8px 16px', background: '#1a0a0a', borderTop: '1px solid #3d1515' }}>
              {parseErrors.map((e, i) => (
                <div key={i} style={{ color: '#f87171', fontSize: 12, fontFamily: 'monospace' }}>⚠ {e}</div>
              ))}
            </div>
          )}
          <div style={{ padding: '6px 16px', borderTop: '1px solid #1e2533', background: '#0a0d14' }}>
            <span style={{ fontSize: 11, color: '#475569' }}>⌘↩ to run · Tab for indent · DuckDB sample data loaded as <code style={{ color: '#6366f1' }}>data</code></span>
          </div>
        </div>

        {/* Results pane */}
        <div style={{ flex: 1, overflow: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 20 }}>
          {results.length === 0 && !running && (
            <div style={{
              flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              color: '#475569', gap: 12,
            }}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" opacity={0.4}>
                <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3z" stroke="#6366f1" strokeWidth="1.5" strokeLinecap="round"/>
                <path d="M17.5 17.5m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0" stroke="#6366f1" strokeWidth="1.5"/>
              </svg>
              <p style={{ fontSize: 14 }}>Press <kbd style={{ background: '#1e2533', padding: '2px 6px', borderRadius: 4, color: '#94a3b8' }}>▶ Run</kbd> to execute your DQL and see the visualization</p>
              <p style={{ fontSize: 12 }}>Sample data: {SAMPLE_CSV.sales.split('\n').length - 1} rows of sales data across 4 regions, 3 products, 12 months</p>
            </div>
          )}

          {running && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#64748b', fontSize: 14 }}>
              <span style={{ animation: 'spin 1s linear infinite' }}>⟳</span> Executing…
            </div>
          )}

          {results.map((r, i) => (
            <div key={r.block.id} style={{
              background: '#0a0d14', border: '1px solid #1e2533', borderRadius: 10, overflow: 'hidden',
            }}>
              {/* Block header */}
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 16px', borderBottom: '1px solid #1e2533',
              }}>
                <div>
                  <span style={{ fontWeight: 600, fontSize: 14, color: '#e2e8f0' }}>{r.block.name}</span>
                  {r.block.viz && (
                    <span style={{ marginLeft: 8, fontSize: 11, color: '#6366f1', background: '#1e1f3a', padding: '2px 6px', borderRadius: 4 }}>
                      {r.block.viz.chart}
                    </span>
                  )}
                </div>
                {r.data && (
                  <span style={{ fontSize: 11, color: '#475569' }}>{r.data.rows.length} rows</span>
                )}
              </div>

              {r.error && (
                <div style={{ padding: '12px 16px', color: '#f87171', fontFamily: 'monospace', fontSize: 12, background: '#1a0a0a' }}>
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

              {/* Data table (collapsed by default) */}
              {r.data && r.data.rows.length > 0 && !r.block.viz && (
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
                      {r.data.rows.slice(0, 10).map((row, ri) => (
                        <tr key={ri} style={{ borderBottom: '1px solid #1e2533' }}>
                          {r.data!.columns.map(c => (
                            <td key={c.name} style={{ padding: '5px 12px', color: '#94a3b8', fontFamily: 'monospace' }}>
                              {String(row[c.name] ?? '')}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
