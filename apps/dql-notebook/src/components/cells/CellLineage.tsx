import type { Theme } from '../../themes/notebook-theme';
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../api/client';

interface LineageNode {
  id: string;
  type: string;
  name: string;
  domain?: string;
  status?: string;
  owner?: string;
}

const NODE_TYPE_COLORS: Record<string, string> = {
  source_table: '#8b949e',
  block: '#56d364',
  metric: '#388bfd',
  dimension: '#e3b341',
  domain: '#d2a8ff',
  chart: '#f778ba',
};

const TYPE_LABELS: Record<string, string> = {
  source_table: 'TBL',
  block: 'BLK',
  metric: 'MET',
  dimension: 'DIM',
  chart: 'CHT',
  domain: 'DOM',
};

const STATUS_COLORS: Record<string, string> = {
  certified: '#56d364',
  draft: '#8b949e',
  review: '#e3b341',
  deprecated: '#f85149',
};

/** Extract a block name from DQL cell content: block "name" { ... } */
function extractBlockName(content: string): string | null {
  const m = content.match(/^\s*block\s+"([^"]+)"/i);
  return m ? m[1] : null;
}

/** Extract table names from SQL for lineage lookup */
function extractSQLTables(sql: string): string[] {
  const tables: string[] = [];
  // FROM / JOIN table references
  const pattern = /\b(?:FROM|JOIN)\s+([a-zA-Z_][\w.]*)/gi;
  for (const m of sql.matchAll(pattern)) {
    const name = m[1].toLowerCase();
    if (!['select', 'where', 'group', 'order', 'having', 'limit', 'union', 'lateral'].includes(name)) {
      tables.push(name);
    }
  }
  // ref("block_name") references
  const refPattern = /\bref\s*\(\s*"([^"]+)"\s*\)/gi;
  for (const m of sql.matchAll(refPattern)) {
    tables.push(m[1]);
  }
  return [...new Set(tables)];
}

/** Extract @metric() and @dim() references from SQL */
function extractSemanticRefs(sql: string): { metrics: string[]; dimensions: string[] } {
  const metrics: string[] = [];
  const dimensions: string[] = [];
  for (const m of sql.matchAll(/@metric\s*\(\s*([^)]+)\s*\)/gi)) {
    metrics.push(m[1].replace(/['"]/g, '').trim());
  }
  for (const m of sql.matchAll(/@dim\s*\(\s*([^)]+)\s*\)/gi)) {
    dimensions.push(m[1].replace(/['"]/g, '').trim());
  }
  return { metrics, dimensions };
}

function MiniNode({ node, t }: { node: LineageNode; t: Theme }) {
  const color = NODE_TYPE_COLORS[node.type] ?? '#8b949e';
  const label = TYPE_LABELS[node.type] ?? node.type.slice(0, 3).toUpperCase();
  const statusColor = node.status ? STATUS_COLORS[node.status] : undefined;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 0',
        fontSize: 11,
        color: t.textPrimary,
      }}
    >
      <span style={{ color, fontSize: 9, fontWeight: 700, width: 26, flexShrink: 0 }}>{label}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
        {node.name}
      </span>
      {node.domain && (
        <span style={{ fontSize: 9, color: t.textMuted }}>{node.domain}</span>
      )}
      {statusColor && (
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: statusColor, flexShrink: 0 }} />
      )}
    </div>
  );
}

interface CellLineageProps {
  cellContent: string;
  cellType: 'sql' | 'dql';
  cellName?: string;
  themeMode: 'dark' | 'light';
  t: Theme;
}

export function CellLineage({ cellContent, cellType, cellName, themeMode, t }: CellLineageProps) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [ancestors, setAncestors] = useState<LineageNode[]>([]);
  const [descendants, setDescendants] = useState<LineageNode[]>([]);
  const [tables, setTables] = useState<string[]>([]);
  const [semanticRefs, setSemanticRefs] = useState<{ metrics: string[]; dimensions: string[] }>({ metrics: [], dimensions: [] });
  const [error, setError] = useState<string | null>(null);

  // Determine the block/table name to look up
  const blockName = cellType === 'dql' ? extractBlockName(cellContent) : null;
  const lookupName = blockName || cellName;

  const loadLineage = useCallback(async () => {
    if (!lookupName && cellType !== 'sql') return;

    setLoading(true);
    setError(null);

    try {
      // Extract SQL-level dependencies
      const sqlTables = extractSQLTables(cellContent);
      setTables(sqlTables);
      setSemanticRefs(extractSemanticRefs(cellContent));

      // Try to fetch block-level lineage from API
      if (lookupName) {
        const data = await api.fetchBlockLineage(lookupName);
        if (data) {
          setAncestors(data.ancestors ?? []);
          setDescendants(data.descendants ?? []);
        }
      } else {
        // For unnamed SQL cells, fetch full lineage and find matching tables
        const fullLineage = await api.fetchLineage();
        const matchingNodes = fullLineage.nodes.filter(
          (n: LineageNode) => sqlTables.some((t) => n.name === t || n.id === `table:${t}` || n.id === `block:${t}`)
        );
        setAncestors(matchingNodes);
        setDescendants([]);
      }
    } catch {
      setError('Failed to load lineage');
    } finally {
      setLoading(false);
    }
  }, [lookupName, cellContent, cellType]);

  useEffect(() => {
    if (expanded) {
      loadLineage();
    }
  }, [expanded, loadLineage]);

  const hasContent = tables.length > 0 || semanticRefs.metrics.length > 0 || semanticRefs.dimensions.length > 0;

  // Don't show the toggle for empty/trivial cells
  if (!cellContent.trim()) return null;

  return (
    <div
      style={{
        borderTop: `1px solid ${t.cellBorder}`,
      }}
    >
      {/* Toggle bar */}
      <button
        onClick={() => setExpanded((e) => !e)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 12px',
          background: expanded ? `${t.tableHeaderBg}60` : 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: t.textMuted,
          fontSize: 10,
          fontFamily: t.font,
          transition: 'background 0.15s',
        }}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          style={{ flexShrink: 0 }}
        >
          {/* Lineage icon: connected nodes */}
          <circle cx="4" cy="4" r="2" />
          <circle cx="12" cy="8" r="2" />
          <circle cx="4" cy="12" r="2" />
          <line x1="6" y1="4" x2="10" y2="8" />
          <line x1="6" y1="12" x2="10" y2="8" />
        </svg>
        <span>Lineage</span>
        <svg
          width="8"
          height="8"
          viewBox="0 0 10 10"
          fill="currentColor"
          style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s' }}
        >
          <path d="M1 3l4 4 4-4" stroke="currentColor" fill="none" strokeWidth="1.5" />
        </svg>
      </button>

      {/* Lineage content */}
      {expanded && (
        <div style={{ padding: '6px 12px 8px', fontSize: 11 }}>
          {loading ? (
            <div style={{ color: t.textMuted, padding: '4px 0' }}>Loading lineage...</div>
          ) : error ? (
            <div style={{ color: t.error, padding: '4px 0' }}>{error}</div>
          ) : (
            <>
              {/* SQL Dependencies */}
              {tables.length > 0 && (
                <div style={{ marginBottom: 6 }}>
                  <div style={{
                    fontSize: 9,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                    color: t.textMuted,
                    marginBottom: 3,
                  }}>
                    Reads From ({tables.length})
                  </div>
                  {tables.map((table) => (
                    <div key={table} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '1px 0', fontSize: 11, color: t.textPrimary }}>
                      <span style={{ color: NODE_TYPE_COLORS.source_table, fontSize: 9, fontWeight: 700, width: 26 }}>TBL</span>
                      <span>{table}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Semantic References */}
              {semanticRefs.metrics.length > 0 && (
                <div style={{ marginBottom: 6 }}>
                  <div style={{
                    fontSize: 9,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                    color: t.textMuted,
                    marginBottom: 3,
                  }}>
                    Metrics ({semanticRefs.metrics.length})
                  </div>
                  {semanticRefs.metrics.map((m) => (
                    <div key={m} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '1px 0', fontSize: 11, color: t.textPrimary }}>
                      <span style={{ color: NODE_TYPE_COLORS.metric, fontSize: 9, fontWeight: 700, width: 26 }}>MET</span>
                      <span>{m}</span>
                    </div>
                  ))}
                </div>
              )}

              {semanticRefs.dimensions.length > 0 && (
                <div style={{ marginBottom: 6 }}>
                  <div style={{
                    fontSize: 9,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                    color: t.textMuted,
                    marginBottom: 3,
                  }}>
                    Dimensions ({semanticRefs.dimensions.length})
                  </div>
                  {semanticRefs.dimensions.map((d) => (
                    <div key={d} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '1px 0', fontSize: 11, color: t.textPrimary }}>
                      <span style={{ color: NODE_TYPE_COLORS.dimension, fontSize: 9, fontWeight: 700, width: 26 }}>DIM</span>
                      <span>{d}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Upstream (from API) */}
              {ancestors.length > 0 && (
                <div style={{ marginBottom: 6 }}>
                  <div style={{
                    fontSize: 9,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                    color: t.textMuted,
                    marginBottom: 3,
                  }}>
                    Upstream ({ancestors.length})
                  </div>
                  {ancestors.map((n) => (
                    <MiniNode key={n.id} node={n} t={t} />
                  ))}
                </div>
              )}

              {/* Downstream (from API) */}
              {descendants.length > 0 && (
                <div style={{ marginBottom: 6 }}>
                  <div style={{
                    fontSize: 9,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                    color: t.textMuted,
                    marginBottom: 3,
                  }}>
                    Downstream ({descendants.length})
                  </div>
                  {descendants.map((n) => (
                    <MiniNode key={n.id} node={n} t={t} />
                  ))}
                </div>
              )}

              {/* No lineage found */}
              {!hasContent && ancestors.length === 0 && descendants.length === 0 && (
                <div style={{ color: t.textMuted, padding: '2px 0' }}>
                  No lineage dependencies detected for this cell.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
