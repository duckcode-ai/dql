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
  block: '#56d364',
  metric: '#388bfd',
  dimension: '#e3b341',
  domain: '#d2a8ff',
  chart: '#f778ba',
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
      {type === 'source_table' ? 'TBL' : type === 'block' ? 'BLK' : type === 'metric' ? 'MET' : type === 'dimension' ? 'DIM' : type === 'chart' ? 'CHT' : type.slice(0, 3).toUpperCase()}
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
  const [selectedBlock, setSelectedBlock] = useState<string | null>(null);
  const [blockDetail, setBlockDetail] = useState<{ ancestors: LineageNode[]; descendants: LineageNode[] } | null>(null);

  const [showBlocks, setShowBlocks] = useState(true);
  const [showMetrics, setShowMetrics] = useState(true);
  const [showTables, setShowTables] = useState(true);
  const [showDomains, setShowDomains] = useState(true);

  const loadLineage = useCallback(async () => {
    setLoading(true);
    const data = await api.fetchLineage();
    setNodes(data.nodes);
    setEdges(data.edges);
    setLoading(false);
  }, []);

  useEffect(() => { loadLineage(); }, [loadLineage]);

  const handleBlockClick = useCallback(async (blockName: string) => {
    if (selectedBlock === blockName) {
      setSelectedBlock(null);
      setBlockDetail(null);
      return;
    }
    setSelectedBlock(blockName);
    const detail = await api.fetchBlockLineage(blockName);
    if (detail) {
      setBlockDetail({ ancestors: detail.ancestors, descendants: detail.descendants });
    }
  }, [selectedBlock]);

  const blocks = nodes.filter((n) => n.type === 'block');
  const metrics = nodes.filter((n) => n.type === 'metric');
  const tables = nodes.filter((n) => n.type === 'source_table');
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

  return (
    <div style={{ overflow: 'auto', flex: 1, fontSize: 12 }}>
      {/* Graph view button + Summary bar */}
      <div style={{
        padding: '6px 8px',
        borderBottom: `1px solid ${t.headerBorder}`,
      }}>
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
          <span>{tables.length} tables</span>
          {crossDomainEdges.length > 0 && (
            <span style={{ color: '#d2a8ff' }}>{crossDomainEdges.length} cross-domain</span>
          )}
        </div>
      </div>

      {/* Block detail view */}
      {selectedBlock && blockDetail && (
        <div style={{ padding: 8, borderBottom: `1px solid ${t.headerBorder}` }}>
          <div style={{ fontWeight: 600, color: t.textPrimary, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
            <NodeTypeIcon type="block" />
            {selectedBlock}
            <button
              onClick={() => { setSelectedBlock(null); setBlockDetail(null); }}
              style={{
                marginLeft: 'auto', background: 'transparent', border: 'none',
                color: t.textMuted, cursor: 'pointer', fontSize: 14,
              }}
            >
              ×
            </button>
          </div>
          {blockDetail.ancestors.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <div style={{ color: t.textMuted, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', marginBottom: 2 }}>
                Upstream ({blockDetail.ancestors.length})
              </div>
              {blockDetail.ancestors.map((n) => (
                <NodeRow key={n.id} node={n} t={t} />
              ))}
            </div>
          )}
          {blockDetail.descendants.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <div style={{ color: t.textMuted, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', marginBottom: 2 }}>
                Downstream ({blockDetail.descendants.length})
              </div>
              {blockDetail.descendants.map((n) => (
                <NodeRow key={n.id} node={n} t={t} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Blocks section */}
      <SectionHeader label="Blocks" count={blocks.length} expanded={showBlocks} onToggle={() => setShowBlocks(!showBlocks)} t={t} />
      {showBlocks && blocks.map((node) => (
        <NodeRow
          key={node.id}
          node={node}
          t={t}
          onClick={() => handleBlockClick(node.name)}
        />
      ))}

      {/* Metrics section */}
      <SectionHeader label="Metrics" count={metrics.length} expanded={showMetrics} onToggle={() => setShowMetrics(!showMetrics)} t={t} />
      {showMetrics && metrics.map((node) => (
        <NodeRow key={node.id} node={node} t={t} />
      ))}

      {/* Source Tables section */}
      <SectionHeader label="Source Tables" count={tables.length} expanded={showTables} onToggle={() => setShowTables(!showTables)} t={t} />
      {showTables && tables.map((node) => (
        <NodeRow key={node.id} node={node} t={t} />
      ))}

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
