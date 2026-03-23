import type { Theme } from '../../themes/notebook-theme';
import React, { useState, useEffect, useMemo } from 'react';
import { useNotebook, makeCell } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { api } from '../../api/client';
import type { SemanticMetric, SemanticDimension, SemanticHierarchy } from '../../store/types';

const METRIC_TYPE_COLORS: Record<string, string> = {
  sum: '#56d364',
  count: '#388bfd',
  count_distinct: '#388bfd',
  avg: '#e3b341',
  min: '#f778ba',
  max: '#f778ba',
  custom: '#d2a8ff',
};

function MetricIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm0 1.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11Zm0 2a.75.75 0 0 1 .75.75v2h2a.75.75 0 0 1 0 1.5h-2v2a.75.75 0 0 1-1.5 0v-2h-2a.75.75 0 0 1 0-1.5h2v-2A.75.75 0 0 1 8 4.5Z" />
    </svg>
  );
}

function DimensionIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 13.25 15H2.75A1.75 1.75 0 0 1 1 13.25Zm1.75-.25a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25ZM8 4a.75.75 0 0 1 .75.75v6.5a.75.75 0 0 1-1.5 0v-6.5A.75.75 0 0 1 8 4Zm-3 3a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 5 7Zm6-1a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0v-4.5A.75.75 0 0 1 11 6Z" />
    </svg>
  );
}

function HierarchyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 1a1 1 0 0 1 1 1v2.586l2.293-2.293a1 1 0 0 1 1.414 1.414L10.414 6H13a1 1 0 1 1 0 2h-2.586l2.293 2.293a1 1 0 0 1-1.414 1.414L9 9.414V12a1 1 0 1 1-2 0V9.414l-2.293 2.293a1 1 0 0 1-1.414-1.414L5.586 8H3a1 1 0 0 1 0-2h2.586L3.293 3.707a1 1 0 0 1 1.414-1.414L7 4.586V2a1 1 0 0 1 1-1Z" />
    </svg>
  );
}

function SectionHeader({
  label,
  count,
  expanded,
  onToggle,
  t,
}: {
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  t: Theme;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onToggle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 8px 3px 10px',
        background: hovered ? t.sidebarItemHover : 'transparent',
        border: 'none',
        cursor: 'pointer',
        color: t.textSecondary,
        fontSize: 11,
        fontWeight: 600,
        fontFamily: t.font,
        letterSpacing: '0.04em',
        textTransform: 'uppercase' as const,
        textAlign: 'left' as const,
        transition: 'background 0.1s',
      }}
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 10 10"
        fill="currentColor"
        style={{
          transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform 0.15s',
          flexShrink: 0,
        }}
      >
        <path d="M3 2l4 3-4 3V2Z" />
      </svg>
      <span style={{ flex: 1 }}>{label}</span>
      {count > 0 && (
        <span
          style={{
            background: t.pillBg,
            color: t.textMuted,
            borderRadius: 10,
            padding: '0 5px',
            fontSize: 10,
            fontWeight: 500,
          }}
        >
          {count}
        </span>
      )}
    </button>
  );
}

function MetricRow({ metric, t }: { metric: SemanticMetric; t: Theme }) {
  const [hovered, setHovered] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const typeColor = METRIC_TYPE_COLORS[metric.type] ?? t.accent;

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 8px 4px 22px',
          background: hovered ? t.sidebarItemHover : 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: t.textPrimary,
          fontSize: 12,
          fontFamily: t.font,
          textAlign: 'left' as const,
          transition: 'background 0.1s',
        }}
      >
        <span style={{ color: typeColor, flexShrink: 0 }}>
          <MetricIcon />
        </span>
        <span
          style={{
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {metric.label || metric.name}
        </span>
        <span
          style={{
            fontSize: 9,
            fontFamily: t.fontMono,
            color: typeColor,
            background: `${typeColor}18`,
            borderRadius: 4,
            padding: '1px 4px',
            flexShrink: 0,
          }}
        >
          {metric.type}
        </span>
      </button>
      {expanded && (
        <div style={{ padding: '2px 8px 6px 40px', fontSize: 11, color: t.textMuted, fontFamily: t.font, lineHeight: 1.5 }}>
          {metric.description && <div>{metric.description}</div>}
          <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textSecondary, marginTop: 2 }}>
            table: {metric.table}
          </div>
          {metric.domain && (
            <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textSecondary }}>
              domain: {metric.domain}
            </div>
          )}
          {metric.tags.length > 0 && (
            <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginTop: 3 }}>
              {metric.tags.map((tag) => (
                <span
                  key={tag}
                  style={{
                    fontSize: 9,
                    background: t.pillBg,
                    color: t.textMuted,
                    borderRadius: 3,
                    padding: '1px 4px',
                  }}
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DimensionRow({ dimension, t }: { dimension: SemanticDimension; t: Theme }) {
  const [hovered, setHovered] = useState(false);
  const typeColor = dimension.type === 'date' ? '#e3b341' : dimension.type === 'number' ? '#56d364' : '#388bfd';

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 8px 4px 22px',
        background: hovered ? t.sidebarItemHover : 'transparent',
        cursor: 'default',
        transition: 'background 0.1s',
      }}
    >
      <span style={{ color: t.textMuted, flexShrink: 0 }}>
        <DimensionIcon />
      </span>
      <span
        style={{
          flex: 1,
          fontSize: 12,
          fontFamily: t.font,
          color: t.textSecondary,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={dimension.description}
      >
        {dimension.label || dimension.name}
      </span>
      <span
        style={{
          fontSize: 9,
          fontFamily: t.fontMono,
          color: typeColor,
          background: `${typeColor}18`,
          borderRadius: 4,
          padding: '1px 4px',
          flexShrink: 0,
        }}
      >
        {dimension.type}
      </span>
    </div>
  );
}

function HierarchyRow({ hierarchy, t }: { hierarchy: SemanticHierarchy; t: Theme }) {
  const [hovered, setHovered] = useState(false);
  const [expanded, setExpanded] = useState(false);

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 8px 4px 22px',
          background: hovered ? t.sidebarItemHover : 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: t.textSecondary,
          fontSize: 12,
          fontFamily: t.font,
          textAlign: 'left' as const,
          transition: 'background 0.1s',
        }}
      >
        <span style={{ color: '#d2a8ff', flexShrink: 0 }}>
          <HierarchyIcon />
        </span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {hierarchy.label || hierarchy.name}
        </span>
        <span style={{ fontSize: 10, color: t.textMuted, background: t.pillBg, borderRadius: 8, padding: '1px 5px', flexShrink: 0 }}>
          {hierarchy.levels.length}
        </span>
      </button>
      {expanded && (
        <div style={{ paddingLeft: 40 }}>
          {hierarchy.levels.map((level, i) => (
            <div
              key={level.name}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 0',
                fontSize: 11,
                fontFamily: t.fontMono,
                color: t.textMuted,
              }}
            >
              <span style={{ color: t.textMuted, fontSize: 9 }}>{i + 1}.</span>
              {level.label || level.name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const GRANULARITIES = ['day', 'week', 'month', 'quarter', 'year'] as const;
type Granularity = typeof GRANULARITIES[number];

function ComposeQuerySection({ t, metrics, dimensions, onInsertCell }: { t: Theme; metrics: SemanticMetric[]; dimensions: SemanticDimension[]; onInsertCell?: (sql: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [selectedMetrics, setSelectedMetrics] = useState<Set<string>>(new Set());
  const [selectedDims, setSelectedDims] = useState<Set<string>>(new Set());
  const [selectedTimeDim, setSelectedTimeDim] = useState<string>('');
  const [granularity, setGranularity] = useState<Granularity>('month');
  const [composedSql, setComposedSql] = useState<string | null>(null);
  const [composeError, setComposeError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [copied, setCopied] = useState(false);

  const dateDimensions = dimensions.filter(d => d.type === 'date');

  const toggleMetric = (name: string) => {
    setSelectedMetrics(prev => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
    setComposedSql(null);
  };

  const toggleDim = (name: string) => {
    setSelectedDims(prev => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
    setComposedSql(null);
  };

  const handleCompose = async () => {
    if (selectedMetrics.size === 0) return;
    setComposing(true);
    setComposeError(null);
    try {
      const timeDimension = selectedTimeDim ? { name: selectedTimeDim, granularity } : undefined;
      const result = await api.composeQuery(
        Array.from(selectedMetrics),
        Array.from(selectedDims),
        timeDimension,
      );
      if ('error' in result) {
        setComposeError(result.error);
      } else {
        setComposedSql(result.sql);
      }
    } catch (e: any) {
      setComposeError(e.message ?? 'Failed to compose');
    } finally {
      setComposing(false);
    }
  };

  const handleCopy = () => {
    if (composedSql) {
      navigator.clipboard.writeText(composedSql);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const checkboxStyle = (selected: boolean) => ({
    width: 14,
    height: 14,
    borderRadius: 3,
    border: `1.5px solid ${selected ? t.accent : t.cellBorder}`,
    background: selected ? t.accent : 'transparent',
    cursor: 'pointer' as const,
    display: 'flex' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    flexShrink: 0 as const,
    transition: 'all 0.15s',
  });

  return (
    <div style={{ borderBottom: `1px solid ${t.headerBorder}` }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          background: expanded ? `${t.accent}10` : 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: t.accent,
          fontSize: 11,
          fontWeight: 600,
          fontFamily: t.font,
          textAlign: 'left' as const,
        }}
      >
        <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm6.5-2a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0Zm-2 4.5a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0Zm5 0a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0Z" />
        </svg>
        Compose Query
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="currentColor"
          style={{ marginLeft: 'auto', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}
        >
          <path d="M3 2l4 3-4 3V2Z" />
        </svg>
      </button>

      {expanded && (
        <div style={{ padding: '6px 10px 10px', fontSize: 11, fontFamily: t.font }}>
          {/* Metric selection */}
          <div style={{ fontSize: 10, fontWeight: 600, color: t.textSecondary, marginBottom: 4, textTransform: 'uppercase' as const, letterSpacing: '0.04em' }}>
            Select Metrics
          </div>
          <div style={{ maxHeight: 120, overflowY: 'auto', marginBottom: 8 }}>
            {metrics.map(m => (
              <label
                key={m.name}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', cursor: 'pointer', color: t.textPrimary, fontSize: 11 }}
                onClick={() => toggleMetric(m.name)}
              >
                <div style={checkboxStyle(selectedMetrics.has(m.name))}>
                  {selectedMetrics.has(m.name) && (
                    <svg width="8" height="8" viewBox="0 0 10 10" fill="#fff"><path d="M8.5 2.5L4 7 1.5 4.5" stroke="#fff" strokeWidth="1.5" fill="none" /></svg>
                  )}
                </div>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.label || m.name}</span>
                <span style={{ fontSize: 9, color: METRIC_TYPE_COLORS[m.type] ?? t.accent, marginLeft: 'auto', flexShrink: 0 }}>{m.type}</span>
              </label>
            ))}
          </div>

          {/* Dimension selection */}
          <div style={{ fontSize: 10, fontWeight: 600, color: t.textSecondary, marginBottom: 4, textTransform: 'uppercase' as const, letterSpacing: '0.04em' }}>
            Select Dimensions (optional)
          </div>
          <div style={{ maxHeight: 120, overflowY: 'auto', marginBottom: 8 }}>
            {dimensions.map(d => (
              <label
                key={d.name}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', cursor: 'pointer', color: t.textPrimary, fontSize: 11 }}
                onClick={() => toggleDim(d.name)}
              >
                <div style={checkboxStyle(selectedDims.has(d.name))}>
                  {selectedDims.has(d.name) && (
                    <svg width="8" height="8" viewBox="0 0 10 10" fill="#fff"><path d="M8.5 2.5L4 7 1.5 4.5" stroke="#fff" strokeWidth="1.5" fill="none" /></svg>
                  )}
                </div>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.label || d.name}</span>
              </label>
            ))}
          </div>

          {/* Time dimension picker — only shown when date dimensions exist */}
          {dateDimensions.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: t.textSecondary, marginBottom: 4, textTransform: 'uppercase' as const, letterSpacing: '0.04em' }}>
                Time Dimension (optional)
              </div>
              <select
                value={selectedTimeDim}
                onChange={e => { setSelectedTimeDim(e.target.value); setComposedSql(null); }}
                style={{
                  width: '100%',
                  padding: '3px 6px',
                  background: t.editorBg,
                  border: `1px solid ${t.cellBorder}`,
                  borderRadius: 4,
                  color: selectedTimeDim ? t.textPrimary : t.textMuted,
                  fontSize: 11,
                  fontFamily: t.font,
                  marginBottom: 4,
                  cursor: 'pointer',
                }}
              >
                <option value="">None</option>
                {dateDimensions.map(d => (
                  <option key={d.name} value={d.name}>{d.label || d.name}</option>
                ))}
              </select>
              {selectedTimeDim && (
                <div style={{ display: 'flex', gap: 4 }}>
                  {GRANULARITIES.map(g => (
                    <button
                      key={g}
                      onClick={() => { setGranularity(g); setComposedSql(null); }}
                      style={{
                        flex: 1,
                        padding: '2px 0',
                        background: granularity === g ? t.accent : t.pillBg,
                        border: 'none',
                        borderRadius: 3,
                        color: granularity === g ? '#fff' : t.textMuted,
                        fontSize: 9,
                        fontWeight: 600,
                        fontFamily: t.font,
                        cursor: 'pointer',
                        textTransform: 'capitalize' as const,
                      }}
                    >
                      {g}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Compose button */}
          <button
            onClick={handleCompose}
            disabled={selectedMetrics.size === 0 || composing}
            style={{
              width: '100%',
              padding: '5px 12px',
              background: selectedMetrics.size === 0 ? t.pillBg : t.accent,
              color: selectedMetrics.size === 0 ? t.textMuted : '#fff',
              border: 'none',
              borderRadius: 5,
              cursor: selectedMetrics.size === 0 ? 'not-allowed' : 'pointer',
              fontSize: 11,
              fontWeight: 600,
              fontFamily: t.font,
              opacity: composing ? 0.7 : 1,
            }}
          >
            {composing ? 'Composing...' : `Compose SQL (${selectedMetrics.size} metric${selectedMetrics.size !== 1 ? 's' : ''})`}
          </button>

          {/* Error */}
          {composeError && (
            <div style={{ marginTop: 6, padding: '4px 8px', background: '#f8514922', border: '1px solid #f8514944', borderRadius: 4, fontSize: 10, color: '#f85149' }}>
              {composeError}
            </div>
          )}

          {/* Composed SQL output */}
          {composedSql && (
            <div style={{ marginTop: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 10, fontWeight: 600, color: t.textSecondary, textTransform: 'uppercase' as const, letterSpacing: '0.04em' }}>
                  Generated SQL
                </span>
                <div style={{ display: 'flex', gap: 4 }}>
                  {onInsertCell && (
                    <button
                      onClick={() => composedSql && onInsertCell(composedSql)}
                      style={{
                        background: t.accent,
                        border: 'none',
                        borderRadius: 3,
                        color: '#fff',
                        cursor: 'pointer',
                        fontSize: 9,
                        fontWeight: 600,
                        fontFamily: t.font,
                        padding: '2px 8px',
                      }}
                    >
                      + Insert as Cell
                    </button>
                  )}
                  <button
                    onClick={handleCopy}
                    style={{
                      background: 'transparent',
                      border: `1px solid ${t.cellBorder}`,
                      borderRadius: 3,
                      color: copied ? '#56d364' : t.textMuted,
                      cursor: 'pointer',
                      fontSize: 9,
                      fontFamily: t.font,
                      padding: '1px 6px',
                    }}
                  >
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>
              <pre style={{
                margin: 0,
                padding: '6px 8px',
                background: t.editorBg,
                border: `1px solid ${t.cellBorder}`,
                borderRadius: 4,
                fontFamily: t.fontMono,
                fontSize: 10,
                color: t.textSecondary,
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap' as const,
                wordBreak: 'break-all' as const,
                maxHeight: 200,
                overflowY: 'auto' as const,
              }}>
                {composedSql}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function SemanticPanel() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const [searchQuery, setSearchQuery] = useState('');
  const [refreshHover, setRefreshHover] = useState(false);

  const [expandedSections, setExpandedSections] = useState({
    metrics: true,
    dimensions: true,
    hierarchies: false,
  });

  const sl = state.semanticLayer;

  const handleRefresh = async () => {
    dispatch({ type: 'SET_SEMANTIC_LOADING', loading: true });
    try {
      const layer = await api.getSemanticLayer();
      dispatch({ type: 'SET_SEMANTIC_LAYER', layer });
    } catch (err) {
      console.error('Semantic layer refresh failed:', err);
    } finally {
      dispatch({ type: 'SET_SEMANTIC_LOADING', loading: false });
    }
  };

  // Load on mount if not already loaded
  useEffect(() => {
    if (sl.metrics.length === 0 && !sl.loading) {
      handleRefresh();
    }
  }, []);

  // Filter by search
  const q = searchQuery.toLowerCase();
  const filteredMetrics = useMemo(() =>
    q ? sl.metrics.filter((m) =>
      m.name.toLowerCase().includes(q) ||
      m.label.toLowerCase().includes(q) ||
      m.description.toLowerCase().includes(q) ||
      m.tags.some((tag) => tag.toLowerCase().includes(q))
    ) : sl.metrics,
    [sl.metrics, q]
  );

  const filteredDimensions = useMemo(() =>
    q ? sl.dimensions.filter((d) =>
      d.name.toLowerCase().includes(q) ||
      d.label.toLowerCase().includes(q) ||
      d.description.toLowerCase().includes(q)
    ) : sl.dimensions,
    [sl.dimensions, q]
  );

  const filteredHierarchies = useMemo(() =>
    q ? sl.hierarchies.filter((h) =>
      h.name.toLowerCase().includes(q) ||
      h.label.toLowerCase().includes(q)
    ) : sl.hierarchies,
    [sl.hierarchies, q]
  );

  const toggleSection = (key: keyof typeof expandedSections) => {
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const codeStyle = { background: t.pillBg, padding: '1px 4px', borderRadius: 3, fontSize: 10, fontFamily: t.fontMono } as const;
  const stepLabelStyle = { fontSize: 11, fontWeight: 600, color: t.textPrimary, fontFamily: t.font, marginBottom: 4 } as const;
  const stepDescStyle = { fontSize: 11, color: t.textMuted, fontFamily: t.font, lineHeight: 1.6, marginBottom: 2 } as const;
  const preStyle = {
    margin: '4px 0 0',
    padding: '6px 8px',
    background: t.editorBg,
    border: `1px solid ${t.cellBorder}`,
    borderRadius: 4,
    fontFamily: t.fontMono,
    fontSize: 10,
    color: t.textSecondary,
    lineHeight: 1.5,
    whiteSpace: 'pre' as const,
    overflowX: 'auto' as const,
  };

  if (!sl.available && !sl.loading) {
    return (
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', fontFamily: t.font }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 14 }}>
          <svg width="28" height="28" viewBox="0 0 16 16" fill={t.accent} style={{ opacity: 0.7 }}>
            <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm6.5-2a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0Zm-2 4.5a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0Zm5 0a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0Z" />
          </svg>
          <div style={{ fontSize: 12, fontWeight: 600, color: t.textPrimary, marginTop: 6 }}>
            Set Up Semantic Layer
          </div>
          <div style={{ fontSize: 11, color: t.textMuted, marginTop: 2, lineHeight: 1.5 }}>
            Choose a provider below, then click Retry.
          </div>
        </div>

        {/* Step 1 — Choose Provider */}
        <div style={{ marginBottom: 12 }}>
          <div style={stepLabelStyle}>Step 1: Pick a provider</div>
          <div style={stepDescStyle}>
            Add <code style={codeStyle}>semanticLayer</code> to your <code style={codeStyle}>dql.config.json</code>:
          </div>

          <div style={{ fontSize: 10, fontWeight: 600, color: t.accent, marginTop: 8, letterSpacing: '0.03em' }}>
            A) DQL Native — write YAML files directly
          </div>
          <pre style={preStyle}>{`"semanticLayer": {
  "provider": "dql"
}`}</pre>

          <div style={{ fontSize: 10, fontWeight: 600, color: t.accent, marginTop: 8, letterSpacing: '0.03em' }}>
            B) dbt — point to your dbt project
          </div>
          <pre style={preStyle}>{`"semanticLayer": {
  "provider": "dbt",
  "projectPath": "/path/to/dbt-project"
}`}</pre>

          <div style={{ fontSize: 10, fontWeight: 600, color: t.accent, marginTop: 8, letterSpacing: '0.03em' }}>
            C) Cube.js — point to your Cube project
          </div>
          <pre style={preStyle}>{`"semanticLayer": {
  "provider": "cubejs",
  "projectPath": "/path/to/cube-project"
}`}</pre>

          <div style={{ fontSize: 10, fontWeight: 600, color: t.accent, marginTop: 8, letterSpacing: '0.03em' }}>
            D) Snowflake — introspects Snowflake semantic views
          </div>
          <pre style={preStyle}>{`"semanticLayer": {
  "provider": "snowflake",
  "projectPath": "MY_DATABASE"
}`}</pre>
          <div style={{ fontSize: 10, color: t.textMuted, fontFamily: t.font, marginTop: 3, lineHeight: 1.5 }}>
            Requires a Snowflake <code style={{ fontFamily: t.fontMono, fontSize: 9 }}>defaultConnection</code>. DQL introspects semantic views automatically.
          </div>
        </div>

        {/* Step 2 — Add YAML (for DQL native) */}
        <div style={{ marginBottom: 12 }}>
          <div style={stepLabelStyle}>Step 2: Add definitions (DQL native only)</div>
          <div style={stepDescStyle}>
            Create YAML files in your project:
          </div>
          <pre style={preStyle}>{`semantic-layer/
  metrics/total_revenue.yaml
  dimensions/segment.yaml
  hierarchies/time.yaml     (optional)
  cubes/revenue_cube.yaml   (optional)`}</pre>

          <div style={{ ...stepDescStyle, marginTop: 6 }}>
            Minimal metric example:
          </div>
          <pre style={preStyle}>{`name: total_revenue
label: Total Revenue
sql: SUM(amount)
type: sum
table: fct_revenue`}</pre>
        </div>

        {/* Step 3 — Restart */}
        <div style={{ marginBottom: 14 }}>
          <div style={stepLabelStyle}>Step 3: Restart & refresh</div>
          <div style={stepDescStyle}>
            Restart <code style={codeStyle}>dql notebook</code>, then click Retry below.
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
          <button
            onClick={handleRefresh}
            style={{
              background: t.accent,
              border: 'none',
              borderRadius: 6,
              color: '#fff',
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 600,
              fontFamily: t.font,
              padding: '6px 16px',
            }}
          >
            Retry
          </button>
          <button
            onClick={() => dispatch({ type: 'SET_SIDEBAR_PANEL', panel: 'reference' })}
            style={{
              background: 'transparent',
              border: `1px solid ${t.cellBorder}`,
              borderRadius: 6,
              color: t.textSecondary,
              cursor: 'pointer',
              fontSize: 11,
              fontFamily: t.font,
              padding: '6px 12px',
            }}
          >
            Full Reference
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
      {/* Toolbar */}
      <div
        style={{
          padding: '8px 10px',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          borderBottom: `1px solid ${t.headerBorder}`,
        }}
      >
        {sl.provider && (
          <span
            style={{
              fontSize: 9,
              fontWeight: 600,
              color: t.accent,
              background: `${t.accent}18`,
              borderRadius: 4,
              padding: '1px 5px',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >
            {sl.provider}
          </span>
        )}
        <span style={{ flex: 1, fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
          {sl.metrics.length} metrics
        </span>
        <button
          onClick={handleRefresh}
          onMouseEnter={() => setRefreshHover(true)}
          onMouseLeave={() => setRefreshHover(false)}
          title="Refresh semantic layer"
          style={{
            background: refreshHover ? t.btnHover : 'transparent',
            border: `1px solid ${refreshHover ? t.btnBorder : 'transparent'}`,
            borderRadius: 4,
            cursor: 'pointer',
            color: refreshHover ? t.textSecondary : t.textMuted,
            fontSize: 11,
            fontFamily: t.font,
            padding: '2px 6px',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            transition: 'all 0.15s',
          }}
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z" />
          </svg>
        </button>
      </div>

      {/* Compose Query */}
      <ComposeQuerySection
        t={t}
        metrics={sl.metrics}
        dimensions={sl.dimensions}
        onInsertCell={(sql) => {
          const cell = makeCell('sql', sql);
          dispatch({ type: 'ADD_CELL', cell });
        }}
      />

      {/* Search */}
      <div style={{ padding: '6px 8px', borderBottom: `1px solid ${t.headerBorder}` }}>
        <input
          type="text"
          placeholder="Search metrics, dimensions..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{
            width: '100%',
            padding: '4px 8px',
            background: t.cellBg,
            border: `1px solid ${t.cellBorder}`,
            borderRadius: 4,
            color: t.textPrimary,
            fontSize: 11,
            fontFamily: t.font,
            outline: 'none',
          }}
        />
      </div>

      {sl.loading ? (
        <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              style={{
                height: 28,
                borderRadius: 4,
                background: t.pillBg,
                opacity: 0.6,
                animation: 'pulse 1.5s ease-in-out infinite',
              }}
            />
          ))}
          <style>{`@keyframes pulse { 0%,100%{opacity:.6} 50%{opacity:.3} }`}</style>
        </div>
      ) : (
        <div style={{ overflow: 'auto', flex: 1 }}>
          {/* Metrics */}
          <SectionHeader
            label="Metrics"
            count={filteredMetrics.length}
            expanded={expandedSections.metrics}
            onToggle={() => toggleSection('metrics')}
            t={t}
          />
          {expandedSections.metrics && (
            <div>
              {filteredMetrics.length === 0 ? (
                <div style={{ padding: '4px 14px 4px 32px', fontSize: 12, color: t.textMuted, fontFamily: t.font, fontStyle: 'italic' }}>
                  {q ? 'No matching metrics' : 'No metrics defined'}
                </div>
              ) : (
                filteredMetrics.map((m) => <MetricRow key={m.name} metric={m} t={t} />)
              )}
            </div>
          )}

          {/* Dimensions */}
          <SectionHeader
            label="Dimensions"
            count={filteredDimensions.length}
            expanded={expandedSections.dimensions}
            onToggle={() => toggleSection('dimensions')}
            t={t}
          />
          {expandedSections.dimensions && (
            <div>
              {filteredDimensions.length === 0 ? (
                <div style={{ padding: '4px 14px 4px 32px', fontSize: 12, color: t.textMuted, fontFamily: t.font, fontStyle: 'italic' }}>
                  {q ? 'No matching dimensions' : 'No dimensions defined'}
                </div>
              ) : (
                filteredDimensions.map((d) => <DimensionRow key={d.name} dimension={d} t={t} />)
              )}
            </div>
          )}

          {/* Hierarchies */}
          {sl.hierarchies.length > 0 && (
            <>
              <SectionHeader
                label="Hierarchies"
                count={filteredHierarchies.length}
                expanded={expandedSections.hierarchies}
                onToggle={() => toggleSection('hierarchies')}
                t={t}
              />
              {expandedSections.hierarchies && (
                <div>
                  {filteredHierarchies.map((h) => (
                    <HierarchyRow key={h.name} hierarchy={h} t={t} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
