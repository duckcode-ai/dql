import type { Theme, ThemeMode } from '../../themes/notebook-theme';
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../api/client';
import {
  NODE_TYPE_COLORS,
  TYPE_LABELS,
  STATUS_COLORS,
  type LineageNode,
  type LineagePath,
  type CompletePathResult,
} from '../lineage/lineage-constants';
import { LineagePathBreadcrumb } from '../lineage/LineagePathBreadcrumb';
import { MiniLineageGraph } from '../lineage/MiniLineageGraph';

/** Extract a block name from DQL cell content: block "name" { ... } */
function extractBlockName(content: string): string | null {
  const m = content.match(/^\s*block\s+"([^"]+)"/i);
  return m ? m[1] : null;
}

/** Extract table names from SQL for lineage lookup (lightweight client-side) */
function extractSQLTables(sql: string): string[] {
  const tables: string[] = [];
  const pattern = /\b(?:FROM|JOIN)\s+([a-zA-Z_][\w.]*)/gi;
  for (const m of sql.matchAll(pattern)) {
    const name = m[1].toLowerCase();
    if (!['select', 'where', 'group', 'order', 'having', 'limit', 'union', 'lateral'].includes(name)) {
      tables.push(name);
    }
  }
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
  themeMode: ThemeMode;
  t: Theme;
  /** Called when a node is clicked to focus the full lineage DAG */
  onFocusNode?: (nodeId: string) => void;
}

export function CellLineage({ cellContent, cellType, cellName, themeMode, t, onFocusNode }: CellLineageProps) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [graphNodes, setGraphNodes] = useState<LineageNode[]>([]);
  const [graphEdges, setGraphEdges] = useState<any[]>([]);
  const [focalNodeId, setFocalNodeId] = useState<string | undefined>();
  const [tables, setTables] = useState<string[]>([]);
  const [semanticRefs, setSemanticRefs] = useState<{ metrics: string[]; dimensions: string[] }>({ metrics: [], dimensions: [] });
  const [pathResult, setPathResult] = useState<CompletePathResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const blockName = cellType === 'dql' ? extractBlockName(cellContent) : null;
  const lookupName = blockName || cellName;

  const loadLineage = useCallback(async () => {
    if (!lookupName && cellType !== 'sql') return;

    setLoading(true);
    setError(null);

    try {
      // Extract SQL-level dependencies (lightweight client-side parse)
      const sqlTables = extractSQLTables(cellContent);
      setTables(sqlTables);
      setSemanticRefs(extractSemanticRefs(cellContent));

      if (lookupName) {
        const nodeId = `block:${lookupName}`;
        setFocalNodeId(nodeId);

        // Parallel fetch: focused subgraph + complete paths
        const [graphResult, paths] = await Promise.all([
          api.queryLineage({ focus: nodeId }),
          api.fetchLineagePaths(nodeId),
        ]);

        if (graphResult?.graph) {
          setGraphNodes(graphResult.graph.nodes ?? []);
          setGraphEdges(graphResult.graph.edges ?? []);
        }
        if (paths) {
          setPathResult(paths);
        }
      } else {
        // Unnamed SQL cell: show matching table nodes from full graph
        setFocalNodeId(undefined);
        const fullLineage = await api.fetchLineage();
        const matchingNodes = (fullLineage.nodes ?? []).filter(
          (n: LineageNode) => sqlTables.some((tbl) => n.name === tbl || n.id === `table:${tbl}`)
        );
        setGraphNodes(matchingNodes);
        setGraphEdges([]);
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

  if (!cellContent.trim()) return null;

  return (
    <div style={{ borderTop: `1px solid ${t.cellBorder}` }}>
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
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ flexShrink: 0 }}>
          <circle cx="4" cy="4" r="2" />
          <circle cx="12" cy="8" r="2" />
          <circle cx="4" cy="12" r="2" />
          <line x1="6" y1="4" x2="10" y2="8" />
          <line x1="6" y1="12" x2="10" y2="8" />
        </svg>
        <span>Lineage</span>
        <svg
          width="8" height="8" viewBox="0 0 10 10" fill="currentColor"
          style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s' }}
        >
          <path d="M1 3l4 4 4-4" stroke="currentColor" fill="none" strokeWidth="1.5" />
        </svg>
        {/* View in DAG button */}
        {expanded && lookupName && onFocusNode && (
          <span
            onClick={(e) => {
              e.stopPropagation();
              onFocusNode(`block:${lookupName}`);
            }}
            style={{
              marginLeft: 'auto',
              fontSize: 9,
              color: t.accent,
              cursor: 'pointer',
              textDecoration: 'underline',
            }}
          >
            View in DAG
          </span>
        )}
      </button>

      {/* Lineage content */}
      {expanded && (
        <div style={{ fontSize: 11 }}>
          {loading ? (
            <div style={{ color: t.textMuted, padding: '8px 12px' }}>Loading lineage...</div>
          ) : error ? (
            <div style={{ color: t.error, padding: '8px 12px' }}>{error}</div>
          ) : (
            <>
              {/* Mini graph — same view as Block Studio, powered by queryLineage */}
              {graphNodes.length > 0 && focalNodeId && (
                <div style={{ borderBottom: `1px solid ${t.cellBorder}` }}>
                  <MiniLineageGraph
                    nodes={graphNodes}
                    edges={graphEdges}
                    focalNodeId={focalNodeId}
                    height={200}
                    onNodeClick={onFocusNode}
                    interactive={true}
                    layoutMode="flow"
                  />
                </div>
              )}

              <div style={{ padding: '6px 12px 8px' }}>
                {/* Complete Paths */}
                {pathResult && (pathResult.upstreamPaths.length > 0 || pathResult.downstreamPaths.length > 0) && (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: t.textMuted, marginBottom: 4 }}>
                      Complete Paths
                    </div>
                    <div style={{ display: 'grid', gap: 6 }}>
                      {pathResult.upstreamPaths.slice(0, 3).map((path: LineagePath, i: number) => (
                        <LineagePathBreadcrumb
                          key={`up-${i}`}
                          path={path}
                          onNodeClick={onFocusNode}
                          focalNodeId={focalNodeId}
                          t={t}
                        />
                      ))}
                      {pathResult.downstreamPaths.slice(0, 2).map((path: LineagePath, i: number) => (
                        <LineagePathBreadcrumb
                          key={`down-${i}`}
                          path={path}
                          onNodeClick={onFocusNode}
                          focalNodeId={focalNodeId}
                          t={t}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* SQL Dependencies */}
                {tables.length > 0 && (
                  <div style={{ marginBottom: 6 }}>
                    <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: t.textMuted, marginBottom: 3 }}>
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
                    <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: t.textMuted, marginBottom: 3 }}>
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
                    <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: t.textMuted, marginBottom: 3 }}>
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

                {/* No lineage found */}
                {!hasContent && graphNodes.length === 0 && !pathResult && (
                  <div style={{ color: t.textMuted, padding: '2px 0' }}>
                    No lineage dependencies detected for this cell.
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
