import React, { useEffect, useMemo, useState } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes, type Theme } from '../../themes/notebook-theme';
import { api } from '../../api/client';
import { MiniLineageGraph } from '../lineage/MiniLineageGraph';
import {
  EDGE_TITLES,
  NODE_TYPE_COLORS,
  TYPE_LABELS,
  TYPE_TITLES,
  type LineageEdge,
  type LineageNode,
} from '../lineage/lineage-constants';

interface FocusedGraph {
  nodes: LineageNode[];
  edges: LineageEdge[];
  focalNode: LineageNode | null;
}

function labelFromKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatMetadataValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const values = value
      .map((entry) => {
        if (entry == null) return null;
        if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') return String(entry);
        return null;
      })
      .filter((entry): entry is string => Boolean(entry));
    return values.length > 0 ? values.join(', ') : null;
  }
  return null;
}

function contextForNode(node: LineageNode | null): string {
  if (!node) return 'Focused technical and business lineage for the selected item.';
  if (node.type === 'term') return 'Business definition used by blocks, views, dashboards, and AI agents.';
  if (node.type === 'business_view') return 'Business composition built from trusted terms, DQL blocks, and other business views.';
  if (node.type === 'block') return 'Reusable DQL block with its technical inputs and business consumption paths.';
  if (node.type === 'dbt_model' || node.type === 'dbt_source' || node.type === 'source_table') {
    return 'Technical data asset connected to semantic, business, and consumption lineage.';
  }
  if (node.type === 'dashboard' || node.type === 'notebook' || node.type === 'app' || node.type === 'chart') {
    return 'Consumption surface showing which trusted blocks and business concepts feed the experience.';
  }
  return 'Focused technical and business lineage for the selected item.';
}

export function LineageDetailView() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const nodeId = state.lineageFocusNodeId;

  const [graph, setGraph] = useState<FocusedGraph>({ nodes: [], edges: [], focalNode: null });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!nodeId) return;
    let cancelled = false;
    setLoading(true);
    api
      .queryLineage({ focus: nodeId, upstreamDepth: 3, downstreamDepth: 3 })
      .then((res) => {
        if (cancelled) return;
        setGraph({
          nodes: (res.graph?.nodes ?? []) as LineageNode[],
          edges: (res.graph?.edges ?? []) as LineageEdge[],
          focalNode: (res.focalNode as LineageNode) ?? null,
        });
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nodeId]);

  const focal = graph.focalNode;
  const nodeById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);
  const upstream = useMemo(() => {
    if (!focal) return [];
    return graph.edges
      .filter((edge) => edge.target === focal.id)
      .map((edge) => ({ edge, node: nodeById.get(edge.source) }))
      .filter((entry): entry is { edge: LineageEdge; node: LineageNode } => Boolean(entry.node));
  }, [focal, graph.edges, nodeById]);
  const downstream = useMemo(() => {
    if (!focal) return [];
    return graph.edges
      .filter((edge) => edge.source === focal.id)
      .map((edge) => ({ edge, node: nodeById.get(edge.target) }))
      .filter((entry): entry is { edge: LineageEdge; node: LineageNode } => Boolean(entry.node));
  }, [focal, graph.edges, nodeById]);

  if (!nodeId) {
    return (
      <div style={{ flex: 1, padding: 24, color: t.textMuted }}>
        Select a lineage item from the Lineage index.
      </div>
    );
  }

  const nodeType = focal?.type ?? nodeId.split(':')[0] ?? 'node';
  const color = NODE_TYPE_COLORS[nodeType] ?? t.accent;
  const label = TYPE_LABELS[nodeType] ?? nodeType.slice(0, 4).toUpperCase();
  const metadata = focal?.metadata ?? {};
  const filePath = metadata.path ?? metadata.filePath;
  const title = focal?.name ?? nodeId;

  return (
    <div style={{ flex: 1, minWidth: 0, overflow: 'auto', background: 'var(--color-bg-primary)' }}>
      <div style={{ padding: '22px 28px 18px', borderBottom: `1px solid ${t.headerBorder}`, background: t.appBg }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <span
                style={{
                  color: t.appBg,
                  background: color,
                  borderRadius: 5,
                  padding: '3px 7px',
                  fontSize: 10,
                  fontWeight: 800,
                  letterSpacing: 0,
                }}
                title={TYPE_TITLES[nodeType] ?? nodeType}
              >
                {label}
              </span>
              <span style={{ color: t.textMuted, fontSize: 12 }}>
                Focused lineage · ↑ {upstream.length} · ↓ {downstream.length}
              </span>
            </div>
            <h1 style={{ margin: 0, fontSize: 26, lineHeight: 1.15, color: t.textPrimary }}>
              {title}
            </h1>
            <div style={{ marginTop: 7, color: t.textMuted, fontSize: 13, maxWidth: 760, lineHeight: 1.45 }}>
              {contextForNode(focal)}
            </div>
          </div>
        </div>
      </div>

      <div
        style={{
          padding: 24,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
          gap: 18,
        }}
      >
        <section
          style={{
            minHeight: 500,
            border: `1px solid ${t.headerBorder}`,
            borderRadius: 8,
            background: t.sidebarBg,
            overflow: 'hidden',
          }}
        >
          <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.headerBorder}` }}>
            <div style={{ fontWeight: 800, color: t.textPrimary, fontSize: 14 }}>Focused lineage</div>
            <div style={{ color: t.textMuted, fontSize: 12, marginTop: 3 }}>
              Technical chain, business concepts, and consumption endpoints for this item.
            </div>
          </div>
          <div style={{ height: 450, padding: 12 }}>
            {loading ? (
              <div style={{ color: t.textMuted, fontSize: 12 }}>Loading lineage...</div>
            ) : graph.nodes.length === 0 ? (
              <div style={{ color: t.textMuted, fontSize: 12 }}>No lineage available.</div>
            ) : (
              <MiniLineageGraph
                nodes={graph.nodes}
                edges={graph.edges}
                focalNodeId={nodeId}
                height="100%"
                onNodeClick={(clickedId) => {
                  dispatch({ type: 'OPEN_LINEAGE_DETAIL', nodeId: clickedId });
                }}
                interactive
              />
            )}
          </div>
        </section>

        {focal && <MetadataPanel node={focal} t={t} />}
        <ConnectionPanel title="Upstream" connections={upstream} t={t} />
        <ConnectionPanel title="Downstream" connections={downstream} t={t} />
        {typeof filePath === 'string' && filePath.trim() && (
          <div style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 8, padding: 12, color: t.textMuted, fontSize: 12, background: t.sidebarBg }}>
            <div style={{ fontWeight: 800, color: t.textSecondary, marginBottom: 6 }}>Source file</div>
            <div style={{ overflowWrap: 'anywhere' }}>{filePath}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function MetadataPanel({ node, t }: { node: LineageNode; t: Theme }) {
  const metadata = node.metadata ?? {};
  const seen = new Set<string>();
  const rows: Array<{ label: string; value: string }> = [];

  const add = (label: string, value: unknown, key = label) => {
    const formatted = formatMetadataValue(value);
    if (!formatted || seen.has(key)) return;
    seen.add(key);
    rows.push({ label, value: formatted });
  };

  add('Type', TYPE_TITLES[node.type] ?? node.type, 'type');
  add('Domain', node.domain, 'domain');
  add('Owner', node.owner, 'owner');
  add('Status', node.status, 'status');
  add('Term Type', metadata.termType, 'termType');
  add('Block Type', metadata.blockType, 'blockType');
  add('Materialized As', metadata.materializedAs, 'materializedAs');
  add('Identifiers', metadata.identifiers, 'identifiers');
  add('Synonyms', metadata.synonyms, 'synonyms');
  add('Description', metadata.description, 'description');
  add('Business Outcome', metadata.businessOutcome, 'businessOutcome');
  add('Decision Use', metadata.decisionUse, 'decisionUse');
  add('Review Cadence', metadata.reviewCadence, 'reviewCadence');

  for (const [key, value] of Object.entries(metadata)) {
    if (key === 'path' || key === 'filePath' || key === 'sql' || key === 'compiledSql') continue;
    add(labelFromKey(key), value, key);
  }

  return (
    <div style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 8, background: t.sidebarBg, padding: 12 }}>
      <div style={{ fontWeight: 800, color: t.textPrimary, marginBottom: 10 }}>Lineage metadata</div>
      {rows.length === 0 ? (
        <div style={{ color: t.textMuted, fontSize: 12 }}>No metadata available for this node.</div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {rows.map((row) => (
            <div key={row.label} style={{ display: 'grid', gap: 3 }}>
              <div style={{ color: t.textMuted, fontSize: 10, fontWeight: 800, textTransform: 'uppercase' }}>{row.label}</div>
              <div style={{ color: t.textSecondary, fontSize: 12, lineHeight: 1.45 }}>{row.value}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ConnectionPanel({
  title,
  connections,
  t,
}: {
  title: string;
  connections: Array<{ edge: LineageEdge; node: LineageNode }>;
  t: Theme;
}) {
  return (
    <div style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 8, background: t.sidebarBg, padding: 12 }}>
      <div style={{ fontWeight: 800, color: t.textPrimary, marginBottom: 10 }}>{title}</div>
      {connections.length === 0 ? (
        <div style={{ color: t.textMuted, fontSize: 12 }}>No {title.toLowerCase()} connections in this focused window.</div>
      ) : (
        <div style={{ display: 'grid', gap: 7 }}>
          {connections.slice(0, 10).map(({ edge, node }) => {
            const color = NODE_TYPE_COLORS[node.type] ?? t.textMuted;
            return (
              <div key={`${edge.source}-${edge.target}-${edge.type}`} style={{ display: 'grid', gridTemplateColumns: '92px 1fr', gap: 8, minWidth: 0, fontSize: 12 }}>
                <span style={{ color: t.textMuted }}>{EDGE_TITLES[edge.type] ?? edge.type}</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span
                    style={{
                      color: t.appBg,
                      background: color,
                      borderRadius: 3,
                      padding: '1px 4px',
                      fontSize: 9,
                      fontWeight: 800,
                      flexShrink: 0,
                    }}
                  >
                    {TYPE_LABELS[node.type] ?? node.type.slice(0, 4).toUpperCase()}
                  </span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={node.name}>
                    {node.name}
                  </span>
                </span>
              </div>
            );
          })}
          {connections.length > 10 && (
            <div style={{ color: t.textMuted, fontSize: 12 }}>
              {connections.length - 10} more connection{connections.length - 10 === 1 ? '' : 's'} in the graph
            </div>
          )}
        </div>
      )}
    </div>
  );
}
