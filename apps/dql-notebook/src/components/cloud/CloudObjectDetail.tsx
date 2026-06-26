import React, { useEffect, useMemo, useState } from 'react';
import { openCloudLineage, getCloudEmbedConfig } from '../../cloud/cloud-mode';
import { useNotebook } from '../../store/NotebookStore';
import { themes, type Theme } from '../../themes/notebook-theme';
import { CloudFocusHeader } from './CloudFocusHeader';

interface CloudObjectDetailProps {
  objectType: string;
  objectKey: string;
  label?: string | null;
}

interface ObjectResponse {
  object: {
    object_type: string;
    object_key: string;
    metadata: Record<string, any> | null;
    product: Record<string, any> | null;
    lineage_edges: Array<Record<string, any>>;
  };
}

async function fetchCloudObject(projectId: string, objectType: string, objectKey: string): Promise<ObjectResponse> {
  const response = await fetch(
    `/v1/projects/${encodeURIComponent(projectId)}/objects/${encodeURIComponent(objectType)}/${encodeURIComponent(objectKey)}`,
    { headers: { accept: 'application/json' } },
  );
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<ObjectResponse>;
}

export function CloudObjectDetail({ objectType, objectKey, label }: CloudObjectDetailProps) {
  const { state } = useNotebook();
  const t = themes[state.themeMode];
  const cloud = getCloudEmbedConfig();
  const [data, setData] = useState<ObjectResponse['object'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!cloud?.project_id || !objectKey) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetchCloudObject(cloud.project_id, objectType, objectKey)
      .then((result) => {
        if (!cancelled) setData(result.object);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cloud?.project_id, objectKey, objectType]);

  const title = data?.metadata?.name ?? data?.product?.name ?? label ?? objectKey;
  const payload = useMemo(() => {
    const value = data?.metadata?.payload;
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
  }, [data?.metadata?.payload]);
  const product = data?.product ?? {};
  const description = data?.metadata?.description ?? product.description ?? payload.business_definition ?? '';
  const status = data?.metadata?.status ?? product.status ?? payload.status ?? 'detail';
  const owner = data?.metadata?.owner ?? product.owner ?? product.owner_id ?? payload.owner ?? 'unassigned';
  const domain = data?.metadata?.domain ?? product.domain ?? payload.domain ?? cloud?.warehouse_context?.business_domain ?? 'project';
  const sources = asStringList(payload.accepted_sources);
  const metrics = asStringList(payload.metrics);
  const dimensions = asStringList(payload.dimensions);
  const tests = asStringList(payload.required_tests);
  const grain = asStringList(payload.grain);
  const query = typeof product.body_text === 'string' ? extractQuery(product.body_text) : '';

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#ffffff', color: t.textPrimary }}>
      <CloudFocusHeader
        title={String(title)}
        subtitle={`${labelForType(objectType)} detail from the connected Cloud project.`}
        themeMode={state.themeMode}
      />
      <div style={{ flex: 1, overflow: 'auto', padding: 18 }}>
        {loading && <Muted>Loading object detail...</Muted>}
        {error && <Muted>Unable to load detail: {error}</Muted>}
        {!loading && !error && (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.4fr) minmax(280px, 0.7fr)', gap: 16 }}>
            <section style={card(t)}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
                <Badge>{String(status)}</Badge>
                <Badge>{String(domain)}</Badge>
                <Badge>{labelForType(objectType)}</Badge>
              </div>
              <h2 style={{ margin: 0, fontSize: 18 }}>{String(title)}</h2>
              {description && <p style={{ color: t.textSecondary, fontSize: 13, lineHeight: 1.55, marginTop: 10 }}>{String(description)}</p>}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10, marginTop: 16 }}>
                <Fact label="Owner" value={String(owner)} />
                <Fact label="Domain" value={String(domain)} />
                <Fact label="Lineage edges" value={String(data?.lineage_edges.length ?? 0)} />
              </div>
              {query && (
                <div style={{ marginTop: 16 }}>
                  <SectionLabel>Query</SectionLabel>
                  <pre style={codeBlock}>{query}</pre>
                </div>
              )}
              <button
                onClick={() => openCloudLineage({ objectType, objectKey, label: String(title) })}
                style={primaryButton}
              >
                Show lineage
              </button>
            </section>

            <aside style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <section style={card(t)}>
                <SectionLabel>Governance</SectionLabel>
                <Fact label="Object key" value={objectKey} />
                <Fact label="Visibility" value={String(product.visibility ?? payload.visibility ?? 'project')} />
                <Fact label="Lifecycle" value={String(product.status ?? payload.status ?? status)} />
              </section>
              <ListCard title="Accepted sources" values={sources} empty="No accepted sources declared." />
              <ListCard title="Grain" values={grain} empty="No grain declared." />
              <ListCard title="Metrics" values={metrics} empty="No metrics declared." />
              <ListCard title="Dimensions" values={dimensions} empty="No dimensions declared." />
              <ListCard title="Required tests" values={tests} empty="No required tests declared." />
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}

function labelForType(type: string): string {
  return type.replace(/_/g, ' ');
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function extractQuery(source: string): string {
  const triple = source.match(/\bquery\s*=\s*"""\s*([\s\S]*?)\s*"""/);
  if (triple?.[1]) return triple[1].trim();
  return source.trim();
}

function card(t: Theme): React.CSSProperties {
  return {
    border: `1px solid ${t.headerBorder}`,
    borderRadius: 8,
    background: '#ffffff',
    padding: 16,
  };
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ color: '#64748b', fontSize: 10, fontWeight: 800, textTransform: 'uppercase', marginBottom: 8 }}>{children}</div>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ color: '#64748b', fontSize: 10, fontWeight: 800, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ color: '#0f172a', fontSize: 12, fontWeight: 700, marginTop: 3, overflowWrap: 'anywhere' }}>{value || '-'}</div>
    </div>
  );
}

function ListCard({ title, values, empty }: { title: string; values: string[]; empty: string }) {
  return (
    <section style={{ border: '1px solid #e2e8f0', borderRadius: 8, background: '#ffffff', padding: 14 }}>
      <SectionLabel>{title}</SectionLabel>
      {values.length === 0 ? (
        <Muted>{empty}</Muted>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {values.map((value) => <Badge key={value}>{value}</Badge>)}
        </div>
      )}
    </section>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return <span style={{ border: '1px solid #fed7aa', background: '#fff7ed', color: '#c2410c', borderRadius: 999, padding: '2px 7px', fontSize: 10, fontWeight: 800 }}>{children}</span>;
}

function Muted({ children }: { children: React.ReactNode }) {
  return <div style={{ color: '#64748b', fontSize: 12, lineHeight: 1.5 }}>{children}</div>;
}

const primaryButton: React.CSSProperties = {
  marginTop: 16,
  border: '1px solid #f97316',
  background: '#f97316',
  color: '#ffffff',
  borderRadius: 7,
  padding: '8px 11px',
  fontSize: 12,
  fontWeight: 800,
  cursor: 'pointer',
};

const codeBlock: React.CSSProperties = {
  margin: 0,
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  background: '#0f172a',
  color: '#e2e8f0',
  padding: 12,
  overflow: 'auto',
  fontSize: 12,
  lineHeight: 1.5,
};
