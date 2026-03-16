import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect, useCallback, useRef } from 'react';
import { initDuckDB, loadCSV, runQuery } from './duckdb.js';
import { parseDQL } from './notebook-engine.js';
import { buildVegaSpec } from './vega-builder.js';
import { SAMPLES, SAMPLE_CSV } from './samples/index.js';
import vegaEmbed from 'vega-embed';
const INITIAL_DQL = SAMPLES[0].dql;
export default function App() {
    const [dql, setDql] = useState(INITIAL_DQL);
    const [activeSample, setActiveSample] = useState(SAMPLES[0].id);
    const [dbReady, setDbReady] = useState(false);
    const [dbError, setDbError] = useState(null);
    const [running, setRunning] = useState(false);
    const [results, setResults] = useState([]);
    const [parseErrors, setParseErrors] = useState([]);
    const chartRefs = useRef([]);
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
                vegaEmbed(el, r.spec, {
                    actions: false,
                    theme: 'dark',
                    renderer: 'svg',
                }).catch(() => { });
            }
        });
    }, [results]);
    const run = useCallback(async () => {
        if (!dbReady)
            return;
        setRunning(true);
        setParseErrors([]);
        const { blocks, errors } = parseDQL(dql);
        if (errors.length || !blocks.length) {
            setParseErrors(errors.length ? errors : ['No blocks found in DQL']);
            setResults([]);
            setRunning(false);
            return;
        }
        const blockResults = [];
        for (const block of blocks) {
            try {
                const data = await runQuery(block.sql);
                const spec = block.viz ? buildVegaSpec(block.viz, data.rows, data.columns) : null;
                blockResults.push({ block, data, error: null, spec });
            }
            catch (e) {
                blockResults.push({ block, data: null, error: e.message, spec: null });
            }
        }
        setResults(blockResults);
        setRunning(false);
    }, [dql, dbReady]);
    const loadSample = (sample) => {
        setActiveSample(sample.id);
        setDql(sample.dql);
        setResults([]);
        setParseErrors([]);
    };
    return (_jsxs("div", { style: { display: 'flex', flexDirection: 'column', height: '100vh', background: '#0f1117' }, children: [_jsxs("header", { style: {
                    display: 'flex', alignItems: 'center', gap: 16, padding: '12px 20px',
                    borderBottom: '1px solid #1e2533', background: '#0a0d14',
                    flexShrink: 0,
                }, children: [_jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: 8 }, children: [_jsx("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: "none", children: _jsx("path", { d: "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5", stroke: "#6366f1", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" }) }), _jsx("span", { style: { fontWeight: 700, fontSize: 16, color: '#e2e8f0' }, children: "DQL Notebook" }), _jsx("span", { style: { fontSize: 11, color: '#64748b', background: '#1e2533', padding: '2px 6px', borderRadius: 4 }, children: dbReady ? '● DuckDB ready' : dbError ? '✗ DuckDB error' : '○ Loading…' })] }), _jsxs("div", { style: { display: 'flex', gap: 8, marginLeft: 'auto', alignItems: 'center' }, children: [_jsx("span", { style: { fontSize: 12, color: '#64748b' }, children: "Examples:" }), SAMPLES.map(s => (_jsx("button", { onClick: () => loadSample(s), style: {
                                    padding: '4px 10px', borderRadius: 6, border: 'none', cursor: 'pointer',
                                    fontSize: 12, fontWeight: 500,
                                    background: activeSample === s.id ? '#6366f1' : '#1e2533',
                                    color: activeSample === s.id ? '#fff' : '#94a3b8',
                                    transition: 'all 0.15s',
                                }, children: s.label }, s.id)))] })] }), _jsxs("div", { style: { display: 'flex', flex: 1, overflow: 'hidden' }, children: [_jsxs("div", { style: {
                            width: '44%', minWidth: 320, display: 'flex', flexDirection: 'column',
                            borderRight: '1px solid #1e2533',
                        }, children: [_jsxs("div", { style: {
                                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                    padding: '8px 16px', borderBottom: '1px solid #1e2533',
                                    background: '#0a0d14',
                                }, children: [_jsx("span", { style: { fontSize: 12, color: '#64748b', fontWeight: 500, letterSpacing: '0.05em' }, children: "DQL EDITOR" }), _jsx("button", { onClick: run, disabled: !dbReady || running, style: {
                                            display: 'flex', alignItems: 'center', gap: 6,
                                            padding: '6px 16px', borderRadius: 6, border: 'none', cursor: 'pointer',
                                            background: !dbReady || running ? '#374151' : '#6366f1',
                                            color: '#fff', fontWeight: 600, fontSize: 13,
                                            transition: 'background 0.15s',
                                        }, children: running ? '⟳ Running…' : '▶ Run' })] }), _jsx("textarea", { value: dql, onChange: e => setDql(e.target.value), spellCheck: false, onKeyDown: e => {
                                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                                        e.preventDefault();
                                        run();
                                    }
                                    if (e.key === 'Tab') {
                                        e.preventDefault();
                                        setDql(d => d.slice(0, e.currentTarget.selectionStart) + '  ' + d.slice(e.currentTarget.selectionEnd));
                                    }
                                }, style: {
                                    flex: 1, padding: '16px', resize: 'none', border: 'none', outline: 'none',
                                    background: '#0f1117', color: '#e2e8f0', fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
                                    fontSize: 13, lineHeight: 1.7, tabSize: 2,
                                } }), parseErrors.length > 0 && (_jsx("div", { style: { padding: '8px 16px', background: '#1a0a0a', borderTop: '1px solid #3d1515' }, children: parseErrors.map((e, i) => (_jsxs("div", { style: { color: '#f87171', fontSize: 12, fontFamily: 'monospace' }, children: ["\u26A0 ", e] }, i))) })), _jsx("div", { style: { padding: '6px 16px', borderTop: '1px solid #1e2533', background: '#0a0d14' }, children: _jsxs("span", { style: { fontSize: 11, color: '#475569' }, children: ["\u2318\u21A9 to run \u00B7 Tab for indent \u00B7 DuckDB sample data loaded as ", _jsx("code", { style: { color: '#6366f1' }, children: "data" })] }) })] }), _jsxs("div", { style: { flex: 1, overflow: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 20 }, children: [results.length === 0 && !running && (_jsxs("div", { style: {
                                    flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                                    color: '#475569', gap: 12,
                                }, children: [_jsxs("svg", { width: "48", height: "48", viewBox: "0 0 24 24", fill: "none", opacity: 0.4, children: [_jsx("path", { d: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3z", stroke: "#6366f1", strokeWidth: "1.5", strokeLinecap: "round" }), _jsx("path", { d: "M17.5 17.5m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0", stroke: "#6366f1", strokeWidth: "1.5" })] }), _jsxs("p", { style: { fontSize: 14 }, children: ["Press ", _jsx("kbd", { style: { background: '#1e2533', padding: '2px 6px', borderRadius: 4, color: '#94a3b8' }, children: "\u25B6 Run" }), " to execute your DQL and see the visualization"] }), _jsxs("p", { style: { fontSize: 12 }, children: ["Sample data: ", SAMPLE_CSV.sales.split('\n').length - 1, " rows of sales data across 4 regions, 3 products, 12 months"] })] })), running && (_jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: 8, color: '#64748b', fontSize: 14 }, children: [_jsx("span", { style: { animation: 'spin 1s linear infinite' }, children: "\u27F3" }), " Executing\u2026"] })), results.map((r, i) => (_jsxs("div", { style: {
                                    background: '#0a0d14', border: '1px solid #1e2533', borderRadius: 10, overflow: 'hidden',
                                }, children: [_jsxs("div", { style: {
                                            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                            padding: '10px 16px', borderBottom: '1px solid #1e2533',
                                        }, children: [_jsxs("div", { children: [_jsx("span", { style: { fontWeight: 600, fontSize: 14, color: '#e2e8f0' }, children: r.block.name }), r.block.viz && (_jsx("span", { style: { marginLeft: 8, fontSize: 11, color: '#6366f1', background: '#1e1f3a', padding: '2px 6px', borderRadius: 4 }, children: r.block.viz.chart }))] }), r.data && (_jsxs("span", { style: { fontSize: 11, color: '#475569' }, children: [r.data.rows.length, " rows"] }))] }), r.error && (_jsx("div", { style: { padding: '12px 16px', color: '#f87171', fontFamily: 'monospace', fontSize: 12, background: '#1a0a0a' }, children: r.error })), r.spec && !r.error && (_jsx("div", { style: { padding: 16 }, children: _jsx("div", { ref: el => { chartRefs.current[i] = el; }, style: { width: '100%', background: 'transparent' } }) })), r.data && r.data.rows.length > 0 && !r.block.viz && (_jsx("div", { style: { overflow: 'auto', maxHeight: 300 }, children: _jsxs("table", { style: { width: '100%', borderCollapse: 'collapse', fontSize: 12 }, children: [_jsx("thead", { children: _jsx("tr", { style: { background: '#111827' }, children: r.data.columns.map(c => (_jsx("th", { style: { padding: '6px 12px', textAlign: 'left', color: '#64748b', fontWeight: 500, borderBottom: '1px solid #1e2533' }, children: c.name }, c.name))) }) }), _jsx("tbody", { children: r.data.rows.slice(0, 10).map((row, ri) => (_jsx("tr", { style: { borderBottom: '1px solid #1e2533' }, children: r.data.columns.map(c => (_jsx("td", { style: { padding: '5px 12px', color: '#94a3b8', fontFamily: 'monospace' }, children: String(row[c.name] ?? '') }, c.name))) }, ri))) })] }) }))] }, r.block.id)))] })] })] }));
}
