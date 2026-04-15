import type { Theme } from '../../themes/notebook-theme';
import React, { useState, useEffect, useCallback } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { api } from '../../api/client';

interface LineageNode {
  id: string;
  type: string;
  name: string;
  domain?: string;
  status?: string;
  owner?: string;
  metadata?: Record<string, unknown>;
}

interface LineageEdge {
  source: string;
  target: string;
  type: string;
  sourceDomain?: string;
  targetDomain?: string;
}

const NODE_TYPE_COLORS: Record<string, string> = {
  source_table: '#8b949e',
  dbt_model: '#ff7b72',
  dbt_source: '#79c0ff',
  block: '#56d364',
  metric: '#388bfd',
  dimension: '#e3b341',
  domain: '#d2a8ff',
  chart: '#f778ba',
  dashboard: '#d2a8ff',
};

const STATUS_BADGES: Record<string, { label: string; color: string }> = {
  certified: { label: 'CERTIFIED', color: '#56d364' },
  draft: { label: 'DRAFT', color: '#8b949e' },
  review: { label: 'REVIEW', color: '#e3b341' },
  deprecated: { label: 'DEPRECATED', color: '#f85149' },
  pending_recertification: { label: 'PENDING', color: '#d29922' },
};

function NodeTypeIcon({ type }: { type: string }) {
  const color = NODE_TYPE_COLORS[type] ?? '#8b949e';
  return (
    <span style={{ color, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', marginRight: 4 }}>
      {type === 'source_table' ? 'TBL' : type === 'dbt_model' ? 'DBT' : type === 'dbt_source' ? 'SRC' : type === 'block' ? 'BLK' : type === 'metric' ? 'MET' : type === 'dimension' ? 'DIM' : type === 'chart' ? 'CHT' : type === 'dashboard' ? 'DASH' : type.slice(0, 3).toUpperCase()}
    </span>
  );
}

function StatusBadge({ status }: { status?: string }) {
  if (!status) return null;
  const badge = STATUS_BADGES[status];
  if (!badge) return null;
  return (
    <span style={{
      fontSize: 9,
      fontWeight: 600,
      color: badge.color,
      border: `1px solid ${badge.color}`,
      borderRadius: 3,
      padding: '0 3px',
      marginLeft: 4,
    }}>
      {badge.label}
    </span>
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
        gap: 4,
        padding: '6px 8px',
        background: hovered ? t.sidebarItemHover : 'transparent',
        border: 'none',
        cursor: 'pointer',
        color: t.textPrimary,
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
        textAlign: 'left',
      }}
    >
      <span style={{ fontSize: 10 }}>{expanded ? '\u25BC' : '\u25B6'}</span>
      <span style={{ flex: 1 }}>{label}</span>
      <span style={{ color: t.textMuted, fontWeight: 400 }}>{count}</span>
    </button>
  );
}

function NodeRow({ node, t, onClick }: { node: LineageNode; t: Theme; onClick?: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: '3px 8px 3px 20px',
        cursor: onClick ? 'pointer' : 'default',
        background: hovered ? t.sidebarItemHover : 'transparent',
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        fontSize: 12,
        color: t.textPrimary,
      }}
    >
      <NodeTypeIcon type={node.type} />
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {node.name}
      </span>
      <StatusBadge status={node.status} />
    </div>
  );
}

export function LineagePanel() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];

  const [loading, setLoading] = useState(true);
  const [nodes, setNodes] = useState<LineageNode[]>([]);
  const [edges, setEdges] = useState<LineageEdge[]>([]);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [nodeDetail, setNodeDetail] = useState<{ node: LineageNode; ancestors: LineageNode[]; descendants: LineageNode[] } | null>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{ node: LineageNode; score: number }>>([]);
  const [isSearching, setIsSearching] = useState(false);

  // Focused view state
  const [focusedView, setFocusedView] = useState<{ focalNode: LineageNode; nodes: LineageNode[]; edges: LineageEdge[] } | null>(null);

  const [showBlocks, setShowBlocks] = useState(true);
  const [showMetrics, setShowMetrics] = useState(true);
  const [showTables, setShowTables] = useState(true);
  const [showDbtModels, setShowDbtModels] = useState(true);
  const [showDashboards, setShowDashboards] = useState(true);
  const [showDomains, setShowDomains] = useState(true);

  const loadLineage = useCallback(async () => {
    setLoading(true);
    const data = await api.fetchLineage();
    setNodes(data.nodes);
    setEdges(data.edges);
    setLoading(false);
  }, []);

  useEffect(() => { loadLineage(); }, [loadLineage]);

  // Debounced search
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    const timeout = setTimeout(async () => {
      const result = await api.searchLineage(searchQuery.trim());
      setSearchResults(result.matches);
      setIsSearching(false);
    }, 200);
    return () => clearTimeout(timeout);
  }, [searchQuery]);

  const handleNodeClick = useCallback(async (nodeId: string) => {
    if (selectedNode === nodeId) {
      setSelectedNode(null);
      setNodeDetail(null);
      return;
    }
    setSelectedNode(nodeId);
    const detail = await api.fetchNodeLineage(nodeId);
    if (detail) {
      setNodeDetail({ node: detail.node, ancestors: detail.ancestors, descendants: detail.descendants });
    }
  }, [selectedNode]);

  const handleFocusNode = useCallback(async (nodeName: string) => {
    const result = await api.queryLineage({ focus: nodeName });
    if (result.focalNode && result.graph.nodes.length > 0) {
      setFocusedView({
        focalNode: result.focalNode,
        nodes: result.graph.nodes,
        edges: result.graph.edges,
      });
      setSearchQuery('');
      setSearchResults([]);
    }
  }, []);

  const clearFocusedView = useCallback(() => {
    setFocusedView(null);
    setSelectedNode(null);
    setNodeDetail(null);
  }, []);

  const blocks = nodes.filter((n) => n.type === 'block');
  const metrics = nodes.filter((n) => n.type === 'metric');
  const tables = nodes.filter((n) => n.type === 'source_table');
  const dbtModels = nodes.filter((n) => n.type === 'dbt_model' || n.type === 'dbt_source');
  const dashboards = nodes.filter((n) => n.type === 'dashboard');
  const domains = [...new Set(nodes.map((n) => n.domain).filter(Boolean))] as string[];
  const crossDomainEdges = edges.filter((e) => e.type === 'crosses_domain');

  if (loading) {
    return (
      <div style={{ padding: 16, color: t.textMuted, fontSize: 12 }}>
        Loading lineage...
      </div>
    );
  }

  if (nodes.length === 0) {
    return (
      <div style={{ padding: 16, color: t.textMuted, fontSize: 12 }}>
        No lineage data found. Add blocks and semantic layer definitions to see the lineage graph.
      </div>
    );
  }

  // Focused view mode
  if (focusedView) {
    const focusBlocks = focusedView.nodes.filter((n) => ['block', 'metric', 'chart', 'dashboard'].includes(n.type));
    const focusSources = focusedView.nodes.filter((n) => ['source_table', 'dbt_model', 'dbt_source'].includes(n.type));
    const upstream = focusedView.nodes.filter((n) => n.id !== focusedView.focalNode.id && focusSources.some((s) => s.id === n.id));
    const downstream = focusedView.nodes.filter((n) => n.id !== focusedView.focalNode.id && !focusSources.some((s) => s.id === n.id));

    return (
      <div style={{ overflow: 'auto', flex: 1, fontSize: 12 }}>
        {/* Back button */}
        <div style={{ padding: '6px 8px', borderBottom: `1px solid ${t.headerBorder}` }}>
          <button
            onClick={clearFocusedView}
            style={{
              width: '100%',
              padding: '6px 10px',
              background: 'transparent',
              border: `1px solid #30363d`,
              borderRadius: 5,
              color: t.textPrimary,
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
            }}
          >
            ← Show All Lineage
          </button>
          <div style={{ marginTop: 6, fontSize: 11, color: t.textMuted }}>
            {focusedView.nodes.length} nodes, {focusedView.edges.length} edges
          </div>
        </div>

        {/* Focal node */}
        <div style={{ padding: 8, borderBottom: `1px solid ${t.headerBorder}`, background: t.sidebarItemHover }}>
          <div style={{ fontWeight: 600, color: t.textPrimary, display: 'flex', alignItems: 'center', gap: 4 }}>
            <NodeTypeIcon type={focusedView.focalNode.type} />
            {focusedView.focalNode.name}
            <StatusBadge status={focusedView.focalNode.status} />
          </div>
          {focusedView.focalNode.domain && (
            <div style={{ color: t.textMuted, fontSize: 10, marginTop: 2 }}>
              Domain: {focusedView.focalNode.domain}
            </div>
          )}
        </div>

        {/* Upstream */}
        {upstream.length > 0 && (
          <>
            <div style={{ padding: '6px 8px', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', color: t.textMuted }}>
              Upstream ({upstream.length})
            </div>
            {upstream.map((n) => (
              <NodeRow key={n.id} node={n} t={t} onClick={() => handleFocusNode(n.name)} />
            ))}
          </>
        )}

        {/* Downstream */}
        {downstream.length > 0 && (
          <>
            <div style={{ padding: '6px 8px', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', color: t.textMuted }}>
              Downstream ({downstream.length})
            </div>
            {downstream.map((n) => (
              <NodeRow key={n.id} node={n} t={t} onClick={() => handleFocusNode(n.name)} />
            ))}
          </>
        )}
      </div>
    );
  }

  return (
    <div style={{ overflow: 'auto', flex: 1, fontSize: 12 }}>
      {/* Search bar + Graph view button + Summary */}
      <div style={{
        padding: '6px 8px',
        borderBottom: `1px solid ${t.headerBorder}`,
      }}>
        {/* Search input */}
        <div style={{ position: 'relative', marginBottom: 6 }}>
          <input
            type="text"
            placeholder="Search lineage..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              width: '100%',
              padding: '6px 8px 6px 28px',
              background: t.inputBg,
              border: `1px solid ${t.inputBorder}`,
              borderRadius: 5,
              color: t.textPrimary,
              fontSize: 11,
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
          <svg
            width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={t.textMuted}
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            style={{ position: 'absolute', left: 8, top: 8 }}
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          {searchQuery && (
            <button
              onClick={() => { setSearchQuery(''); setSearchResults([]); }}
              style={{
                position: 'absolute', right: 6, top: 5, background: 'transparent',
                border: 'none', color: t.textMuted, cursor: 'pointer', fontSize: 14, padding: 0,
              }}
            >
              ×
            </button>
          )}
        </div>

        {/* Search results */}
        {searchQuery.trim() && (
          <div style={{ marginBottom: 6 }}>
            {isSearching ? (
              <div style={{ fontSize: 11, color: t.textMuted, padding: '4px 0' }}>Searching...</div>
            ) : searchResults.length === 0 ? (
              <div style={{ fontSize: 11, color: t.textMuted, padding: '4px 0' }}>No results</div>
            ) : (
              <>
                <div style={{ fontSize: 10, color: t.textMuted, marginBottom: 2 }}>
                  {searchResults.length} result{searchResults.length === 1 ? '' : 's'} — click to focus
                </div>
                {searchResults.slice(0, 10).map(({ node }) => (
                  <NodeRow key={node.id} node={node} t={t} onClick={() => handleFocusNode(node.name)} />
                ))}
              </>
            )}
          </div>
        )}

        {/* Graph view toggle */}
        {!searchQuery.trim() && (
          <>
            <button
              onClick={() => dispatch({ type: 'TOGGLE_LINEAGE_FULLSCREEN' })}
              style={{
                width: '100%',
                padding: '6px 10px',
                marginBottom: 6,
                background: state.lineageFullscreen ? '#388bfd' : 'transparent',
                border: `1px solid ${state.lineageFullscreen ? '#388bfd' : '#30363d'}`,
                borderRadius: 5,
                color: state.lineageFullscreen ? '#fff' : t.textPrimary,
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                transition: 'all 0.15s',
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="6" cy="6" r="3" />
                <circle cx="18" cy="6" r="3" />
                <circle cx="18" cy="18" r="3" />
                <line x1="8.6" y1="7.4" x2="15.4" y2="16.6" />
                <line x1="9" y1="6" x2="15" y2="6" />
              </svg>
              {state.lineageFullscreen ? 'Close Graph View' : 'Open Graph View'}
            </button>
            <div style={{
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
              fontSize: 11,
              color: t.textMuted,
            }}>
              <span>{blocks.length} blocks</span>
              <span>{metrics.length} metrics</span>
              <span>{tables.length + dbtModels.length} tables</span>
              {dbtModels.length > 0 && (
                <span style={{ color: '#ff7b72' }}>{dbtModels.length} dbt</span>
              )}
              {dashboards.length > 0 && (
                <span style={{ color: '#d2a8ff' }}>{dashboards.length} dashboards</span>
              )}
              {crossDomainEdges.length > 0 && (
                <span style={{ color: '#d2a8ff' }}>{crossDomainEdges.length} cross-domain</span>
              )}
            </div>
          </>
        )}
      </div>

      {/* Node detail view */}
      {selectedNode && nodeDetail && (
        <div style={{ padding: 8, borderBottom: `1px solid ${t.headerBorder}` }}>
          <div style={{ fontWeight: 600, color: t.textPrimary, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
            <NodeTypeIcon type={nodeDetail.node.type} />
            {nodeDetail.node.name}
            <StatusBadge status={nodeDetail.node.status} />
            <button
              onClick={() => { setSelectedNode(null); setNodeDetail(null); }}
              style={{
                marginLeft: 'auto', background: 'transparent', border: 'none',
                color: t.textMuted, cursor: 'pointer', fontSize: 14,
              }}
            >
              ×
            </button>
          </div>
          <button
            onClick={() => handleFocusNode(nodeDetail.node.name)}
            style={{
              padding: '3px 8px', fontSize: 10, background: '#388bfd22', border: `1px solid #388bfd`,
              borderRadius: 3, color: '#388bfd', cursor: 'pointer', marginBottom: 4, fontWeight: 600,
            }}
          >
            Focus View
          </button>
          {nodeDetail.ancestors.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <div style={{ color: t.textMuted, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', marginBottom: 2 }}>
                Upstream ({nodeDetail.ancestors.length})
              </div>
              {nodeDetail.ancestors.map((n) => (
                <NodeRow key={n.id} node={n} t={t} onClick={() => handleNodeClick(n.id)} />
              ))}
            </div>
          )}
          {nodeDetail.descendants.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <div style={{ color: t.textMuted, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', marginBottom: 2 }}>
                Downstream ({nodeDetail.descendants.length})
              </div>
              {nodeDetail.descendants.map((n) => (
                <NodeRow key={n.id} node={n} t={t} onClick={() => handleNodeClick(n.id)} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* dbt Models section */}
      {dbtModels.length > 0 && (
        <>
          <SectionHeader label="dbt Models" count={dbtModels.length} expanded={showDbtModels} onToggle={() => setShowDbtModels(!showDbtModels)} t={t} />
          {showDbtModels && dbtModels.map((node) => (
            <NodeRow key={node.id} node={node} t={t} onClick={() => handleNodeClick(node.id)} />
          ))}
        </>
      )}

      {/* Blocks section */}
      <SectionHeader label="Blocks" count={blocks.length} expanded={showBlocks} onToggle={() => setShowBlocks(!showBlocks)} t={t} />
      {showBlocks && blocks.map((node) => (
        <NodeRow key={node.id} node={node} t={t} onClick={() => handleNodeClick(node.id)} />
      ))}

      {/* Metrics section */}
      <SectionHeader label="Metrics" count={metrics.length} expanded={showMetrics} onToggle={() => setShowMetrics(!showMetrics)} t={t} />
      {showMetrics && metrics.map((node) => (
        <NodeRow key={node.id} node={node} t={t} onClick={() => handleNodeClick(node.id)} />
      ))}

      {/* Source Tables section */}
      <SectionHeader label="Source Tables" count={tables.length} expanded={showTables} onToggle={() => setShowTables(!showTables)} t={t} />
      {showTables && tables.map((node) => (
        <NodeRow key={node.id} node={node} t={t} onClick={() => handleNodeClick(node.id)} />
      ))}

      {/* Dashboards section */}
      {dashboards.length > 0 && (
        <>
          <SectionHeader label="Dashboards" count={dashboards.length} expanded={showDashboards} onToggle={() => setShowDashboards(!showDashboards)} t={t} />
          {showDashboards && dashboards.map((node) => (
            <NodeRow key={node.id} node={node} t={t} onClick={() => handleNodeClick(node.id)} />
          ))}
        </>
      )}

      {/* Domain Trust section */}
      <SectionHeader label="Domains" count={domains.length} expanded={showDomains} onToggle={() => setShowDomains(!showDomains)} t={t} />
      {showDomains && domains.map((domain) => {
        const domainBlocks = blocks.filter((b) => b.domain === domain);
        const certified = domainBlocks.filter((b) => b.status === 'certified').length;
        const trustPct = domainBlocks.length > 0 ? Math.round((certified / domainBlocks.length) * 100) : 0;
        return (
          <div key={domain} style={{ padding: '3px 8px 3px 20px', fontSize: 12, color: t.textPrimary, display: 'flex', gap: 4, alignItems: 'center' }}>
            <span style={{ color: NODE_TYPE_COLORS.domain, fontSize: 10, fontWeight: 600 }}>DOM</span>
            <span style={{ flex: 1 }}>{domain}</span>
            <span style={{ color: t.textMuted, fontSize: 10 }}>
              {certified}/{domainBlocks.length} ({trustPct}%)
            </span>
          </div>
        );
      })}

      {/* Cross-domain flows */}
      {crossDomainEdges.length > 0 && (
        <>
          <div style={{ padding: '6px 8px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: t.textPrimary }}>
            Cross-Domain Flows
          </div>
          {crossDomainEdges.map((edge, i) => (
            <div key={i} style={{ padding: '2px 8px 2px 20px', fontSize: 11, color: t.textMuted }}>
              {edge.sourceDomain} → {edge.targetDomain}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
