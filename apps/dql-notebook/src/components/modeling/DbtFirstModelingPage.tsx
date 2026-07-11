import React, { useEffect, useMemo, useState } from 'react';
import type { ManifestDbtNodeProvenance } from '@duckcodeailabs/dql-core';
import { api, type DbtFirstModelingResponse } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';

/**
 * The modeling surface intentionally separates dbt truth from DQL analytical
 * policy. It never renders copied schema.yml text as editable DQL metadata.
 */
export function DbtFirstModelingPage() {
  const { state } = useNotebook();
  const t = themes[state.themeMode];
  const [data, setData] = useState<DbtFirstModelingResponse | null>(null);
  const [selectedNode, setSelectedNode] = useState<ManifestDbtNodeProvenance | null>(null);

  useEffect(() => {
    let active = true;
    api.getDbtFirstModeling().then((result) => {
      if (!active) return;
      setData(result);
      if (result) setSelectedNode(Object.values(result.dbtProvenance.nodes)[0] ?? null);
    });
    return () => { active = false; };
  }, []);

  const sourcePatch = useMemo(() => selectedNode ? previewDbtPatch(selectedNode) : '', [selectedNode]);
  if (!data) {
    return (
      <PageShell t={t}>
        <h1 style={{ margin: 0, fontSize: 22 }}>dbt-first modeling</h1>
        <p style={{ margin: '8px 0 0', color: t.textSecondary, lineHeight: 1.5 }}>
          Enable <code>manifestVersion: 3</code> and <code>modeling.mode: "dbt-first"</code>, then compile with a dbt manifest to inspect the analytical overlay here.
        </p>
      </PageShell>
    );
  }

  const relationships = Object.values(data.modeling.relationships);
  return (
    <PageShell t={t}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 20, alignItems: 'flex-start' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>dbt-first modeling</h1>
          <p style={{ margin: '8px 0 0', color: t.textSecondary, lineHeight: 1.5, maxWidth: 760 }}>
            dbt owns physical models, schema, tests, descriptions, and MetricFlow. DQL owns only the sparse analytical overlay: domains, relationship safety, contracts, conformance, blocks, and apps.
          </p>
        </div>
        <span style={{ border: `1px solid ${t.accent}`, color: t.accent, borderRadius: 999, padding: '4px 9px', fontSize: 12, fontWeight: 700 }}>Manifest v3</span>
      </div>

      <section style={sectionStyle(t)}>
        <SectionTitle title="dbt-owned provenance" subtitle={`Source: ${data.dbtProvenance.manifestPath}`} t={t} />
        <div style={gridStyle}>
          <div>
            {Object.values(data.dbtProvenance.nodes).map((node) => (
              <button key={node.uniqueId} onClick={() => setSelectedNode(node)} style={rowButton(t, selectedNode?.uniqueId === node.uniqueId)}>
                <strong>{node.name}</strong>
                <span>{node.relation ?? node.uniqueId}</span>
                <small>{node.sourcePath ?? 'source path unavailable'}</small>
              </button>
            ))}
          </div>
          <div style={detailCard(t)}>
            <strong>{selectedNode?.name ?? 'Select a dbt model'}</strong>
            {selectedNode ? <>
              <p style={{ color: t.textSecondary, fontSize: 13, lineHeight: 1.45 }}>This metadata is read from dbt artifacts on demand. DQL does not duplicate it into a Domain Package.</p>
              <Availability node={selectedNode} t={t} />
              <div style={{ fontSize: 12, color: t.textMuted, marginTop: 12 }}>Preview a dbt source patch (review before applying):</div>
              <pre style={patchStyle(t)}>{sourcePatch}</pre>
            </> : null}
          </div>
        </div>
      </section>

      <section style={sectionStyle(t)}>
        <SectionTitle title="DQL-owned analytical overlay" subtitle="Relationship and contract changes are saved in Domain Packages, not dbt schema copies." t={t} />
        <div style={gridStyle}>
          <div style={detailCard(t)}>
            <strong>Domain Packages</strong>
            {Object.values(data.modeling.packages).map((pkg) => <div key={pkg.id} style={listItem(t)}><b>{pkg.id}</b><span>{pkg.filePath}</span></div>)}
            <div style={{ marginTop: 16 }}><strong>Entities</strong></div>
            {Object.values(data.modeling.entities).map((entity) => <div key={entity.id} style={listItem(t)}><b>{entity.id}</b><span>{entity.domain} · {entity.dbtUniqueId}</span></div>)}
          </div>
          <div style={detailCard(t)}>
            <strong>Relationship proof</strong>
            {relationships.map((relationship) => <div key={relationship.id} style={{ ...listItem(t), borderLeft: `3px solid ${relationship.automaticJoinAllowed ? '#2e9b63' : relationship.staleCertification ? '#d47822' : '#9a6b2f'}` }}>
              <b>{relationship.id}</b>
              <span>{relationship.from} → {relationship.to} · {relationship.cardinality} · {relationship.fanout}</span>
              <small>{relationship.automaticJoinAllowed ? 'Certified safe join proof' : relationship.staleCertification ? 'Stale certification — blocked until reviewed' : 'Not automatic join proof'}</small>
              <small>{relationship.sourcePath}</small>
            </div>)}
          </div>
        </div>
      </section>
    </PageShell>
  );
}

function Availability({ node, t }: { node: ManifestDbtNodeProvenance; t: (typeof themes)['dark'] }) {
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{Object.entries(node.available).map(([name, present]) => <span key={name} style={{ fontSize: 11, padding: '3px 6px', borderRadius: 4, color: present ? '#2e9b63' : t.textMuted, background: present ? '#2e9b6318' : t.textPrimary + '09' }}>{present ? '✓' : '—'} {name}</span>)}</div>;
}

function SectionTitle({ title, subtitle, t }: { title: string; subtitle: string; t: (typeof themes)['dark'] }) {
  return <div style={{ marginBottom: 14 }}><h2 style={{ margin: 0, fontSize: 16 }}>{title}</h2><div style={{ marginTop: 4, color: t.textSecondary, fontSize: 12 }}>{subtitle}</div></div>;
}

function PageShell({ children, t }: { children: React.ReactNode; t: (typeof themes)['dark'] }) {
  return <div style={{ flex: 1, overflow: 'auto', padding: '24px 28px 40px', background: t.appBg, color: t.textPrimary }}>{children}</div>;
}

function previewDbtPatch(node: ManifestDbtNodeProvenance): string {
  return `# ${node.sourcePath ?? 'dbt schema YAML'}\nmodels:\n  - name: ${node.name}\n    # Add or edit dbt-owned descriptions/tests here.\n    # DQL relationship policies remain in ${node.sourcePath ? 'the Domain Package' : 'domains/<domain>/modeling/'}.`;
}

const gridStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(260px, 0.9fr) minmax(340px, 1.1fr)', gap: 14 };
const sectionStyle = (t: (typeof themes)['dark']): React.CSSProperties => ({ marginTop: 22, border: `1px solid ${t.headerBorder}`, background: t.cellBg, borderRadius: 10, padding: 16 });
const detailCard = (t: (typeof themes)['dark']): React.CSSProperties => ({ border: `1px solid ${t.headerBorder}`, background: t.appBg, borderRadius: 8, padding: 12, minHeight: 120 });
const listItem = (t: (typeof themes)['dark']): React.CSSProperties => ({ display: 'flex', flexDirection: 'column', gap: 3, padding: '9px 0', borderBottom: `1px solid ${t.headerBorder}`, fontSize: 12, color: t.textSecondary });
const rowButton = (t: (typeof themes)['dark'], active: boolean): React.CSSProperties => ({ width: '100%', textAlign: 'left', border: `1px solid ${active ? t.accent : t.headerBorder}`, background: active ? `${t.accent}14` : 'transparent', color: t.textPrimary, borderRadius: 7, padding: '9px 10px', marginBottom: 7, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12 });
const patchStyle = (t: (typeof themes)['dark']): React.CSSProperties => ({ margin: '8px 0 0', whiteSpace: 'pre-wrap', fontSize: 11, lineHeight: 1.45, padding: 10, borderRadius: 6, background: t.activityBarBg, color: t.textSecondary, overflowX: 'auto' });
