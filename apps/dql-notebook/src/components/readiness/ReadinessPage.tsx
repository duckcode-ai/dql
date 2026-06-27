// Readiness / Get Started surface — the "AI drafts, humans certify" first-run
// backbone (classify → plan → approve → generate → review).
//
// It calls `/api/propose` (the propose engine, in dryRun preview mode), which
// now returns a DETERMINISTIC, business-only PLAN: the cascade classifier picks
// the small set of business models worth governing, bounded per-domain, and
// reports what it WILL generate vs SKIP — nothing is written by the preview.
// The human reviews the plan, picks a scope, and clicks "Approve & Generate":
// only then are DRAFT blocks materialized (POST /api/propose/generate), and the
// flow routes into the existing per-block review/certify queue. Nothing here
// certifies or auto-promotes — promotion is a separate human action.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { ShieldCheck, Sparkles, ArrowRight, AlertTriangle, RefreshCw, Filter, Loader2 } from 'lucide-react';
import { TrustBadge } from '@duckcodeailabs/dql-ui';
import { api } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import type { ProposeReadiness, ProposePlanDomain, ProposePlanCandidate } from '../../store/types';

export function ReadinessPage(): JSX.Element {
  const { dispatch } = useNotebook();
  const [readiness, setReadiness] = useState<ProposeReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    void api.getProposeReadiness().then((result) => {
      if (cancelled) return;
      setReadiness(result);
      // Default the approved scope to the entire planned selection.
      const allSlugs = result.ready ? result.plan.domains.flatMap((d) => d.candidates.map((c) => c.slug)) : [];
      setSelected(new Set(allSlugs));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => load(), [load]);

  const openReview = useCallback(() => {
    dispatch({ type: 'SET_MAIN_VIEW', view: 'review' });
  }, [dispatch]);

  const toggleSlug = useCallback((slug: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }, []);

  const toggleDomain = useCallback((domain: ProposePlanDomain) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const slugs = domain.candidates.map((c) => c.slug);
      const allOn = slugs.every((s) => next.has(s));
      for (const s of slugs) {
        if (allOn) next.delete(s);
        else next.add(s);
      }
      return next;
    });
  }, []);

  // Approve & Generate: materialize drafts for ONLY the approved scope, then
  // route into the existing review/certify queue. Never certifies.
  const approveAndGenerate = useCallback(async () => {
    const slugs = [...selected];
    if (slugs.length === 0) return;
    setGenerating(true);
    setGenerateError(null);
    const result = await api.generateProposeDrafts({ slugs });
    setGenerating(false);
    if (!result.ready) {
      setGenerateError(result.reason ?? 'Could not generate drafts.');
      return;
    }
    openReview();
  }, [selected, openReview]);

  const summary = readiness?.summary;
  const plan = readiness?.ready ? readiness.plan : null;

  return (
    <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '22px 28px 40px', display: 'grid', gap: 16 }}>
        <header style={{ display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Sparkles size={20} />
            <div style={{ fontSize: 22, fontWeight: 750 }}>Get Started</div>
          </div>
          <div style={{ fontSize: 13, opacity: 0.72, maxWidth: 720, lineHeight: 1.55 }}>
            AI drafts, humans certify. We classified your dbt models and planned a small,
            business-focused seed of governance blocks — plumbing and low-value models are
            excluded. Review the plan, approve the scope, and we'll draft only what you pick.
            Nothing is generated or certified until you say so.
          </div>
        </header>

        {loading ? (
          <div style={emptyStyle}>Classifying dbt models and planning the business seed…</div>
        ) : !readiness ? (
          <div style={emptyStyle}>Could not load readiness.</div>
        ) : !readiness.ready ? (
          <div style={{ ...emptyStyle, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: 1 }} />
            <div style={{ display: 'grid', gap: 8 }}>
              <div style={{ fontWeight: 650 }}>Not ready to propose yet</div>
              <div style={{ opacity: 0.8 }}>{readiness.reason}</div>
              <button type="button" onClick={load} style={refreshBtnStyle}>
                <RefreshCw size={13} /> Re-check
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Plan totals — honest counts: scanned vs business vs excluded. */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
              <Stat label="dbt models scanned" value={summary!.modelsScanned} />
              <Stat label="Business models" value={summary!.businessModels} tone="success" />
              <Stat label="Plumbing excluded" value={summary!.plumbingExcluded} />
              <Stat label="Metrics found" value={summary!.metricsFound} />
            </div>

            {/* Approve gate header */}
            <div style={planBarStyle}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Filter size={16} />
                <div style={{ fontSize: 13 }}>
                  <strong>Will generate {selected.size}</strong>
                  <span style={{ opacity: 0.65 }}>
                    {' '}
                    of {plan!.willGenerate} planned · skipping {plan!.willSkip} · ≤ {plan!.config.maxPerDomain} per domain
                  </span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button type="button" onClick={load} style={refreshBtnStyle}>
                  <RefreshCw size={13} /> Refresh
                </button>
                <button
                  type="button"
                  onClick={() => void approveAndGenerate()}
                  disabled={generating || selected.size === 0}
                  style={{ ...approveBtnStyle, opacity: generating || selected.size === 0 ? 0.6 : 1 }}
                >
                  {generating ? <Loader2 size={13} className="spin" /> : <ShieldCheck size={13} />}
                  Approve &amp; Generate {selected.size > 0 ? `(${selected.size})` : ''}
                </button>
              </div>
            </div>

            {generateError ? (
              <div style={{ ...emptyStyle, display: 'flex', gap: 8, alignItems: 'center', borderColor: 'var(--status-error, #cf222e)' }}>
                <AlertTriangle size={16} /> {generateError}
              </div>
            ) : null}

            {/* Planned domains + per-candidate evidence (approve gate) */}
            <div style={{ display: 'grid', gap: 12 }}>
              {plan!.domains.length === 0 ? (
                <div style={emptyStyle}>
                  No business models found to govern. Tag a layer in <code>dql.config.json</code>{' '}
                  (<code>propose.businessLayers</code>) or add <code>meta.dql.business</code> to your dbt models.
                </div>
              ) : (
                plan!.domains.map((domain) => (
                  <DomainGroup
                    key={domain.name}
                    domain={domain}
                    selected={selected}
                    onToggleSlug={toggleSlug}
                    onToggleDomain={toggleDomain}
                  />
                ))
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button type="button" onClick={openReview} style={reviewQueueBtnStyle}>
                Open review queue <ArrowRight size={13} />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function DomainGroup({
  domain,
  selected,
  onToggleSlug,
  onToggleDomain,
}: {
  domain: ProposePlanDomain;
  selected: Set<string>;
  onToggleSlug: (slug: string) => void;
  onToggleDomain: (domain: ProposePlanDomain) => void;
}): JSX.Element {
  const slugs = domain.candidates.map((c) => c.slug);
  const allOn = slugs.every((s) => selected.has(s));
  const someOn = slugs.some((s) => selected.has(s));
  return (
    <div style={domainStyle}>
      <div style={domainHeaderStyle}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={allOn}
            ref={(el) => {
              if (el) el.indeterminate = !allOn && someOn;
            }}
            onChange={() => onToggleDomain(domain)}
          />
          <span style={{ fontSize: 13, fontWeight: 700 }}>{domain.name}</span>
          <span style={{ fontSize: 11, opacity: 0.6 }}>
            {domain.modelCount} model{domain.modelCount === 1 ? '' : 's'}
          </span>
        </label>
        {domain.owner ? <span style={{ fontSize: 11, opacity: 0.6 }}>owner {domain.owner}</span> : null}
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        {domain.candidates.map((candidate) => (
          <CandidateRow
            key={candidate.slug}
            candidate={candidate}
            checked={selected.has(candidate.slug)}
            onToggle={() => onToggleSlug(candidate.slug)}
          />
        ))}
      </div>
    </div>
  );
}

function CandidateRow({
  candidate,
  checked,
  onToggle,
}: {
  candidate: ProposePlanCandidate;
  checked: boolean;
  onToggle: () => void;
}): JSX.Element {
  const evidence = useMemo(() => candidate.evidence.slice(0, 3), [candidate.evidence]);
  return (
    <label style={{ ...rowStyle, opacity: checked ? 1 : 0.62 }}>
      <input type="checkbox" checked={checked} onChange={onToggle} style={{ marginTop: 3 }} />
      <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, fontWeight: 700 }}>{candidate.model}</span>
          <TrustBadge state="ai_generated" />
          {candidate.pattern ? <Pill>{candidate.pattern}</Pill> : null}
          <span style={{ fontSize: 11, opacity: 0.6 }}>score {candidate.score}</span>
          {candidate.grain ? <span style={{ fontSize: 11, opacity: 0.6 }}>grain {candidate.grain}</span> : null}
        </div>
        {evidence.length > 0 ? (
          <div style={{ fontSize: 11, opacity: 0.66 }}>
            <span style={{ opacity: 0.8 }}>why: </span>
            {evidence.join(' · ')}
          </div>
        ) : null}
      </div>
    </label>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'success' }) {
  return (
    <div style={{ ...statStyle, borderTop: `2px solid ${tone === 'success' ? 'var(--status-success, #1f883d)' : 'var(--border-color, rgba(0,0,0,0.10))'}` }}>
      <div style={{ fontSize: 11, opacity: 0.62 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800 }}>{value}</div>
    </div>
  );
}

function Pill({ children }: { children: string }) {
  return (
    <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, background: 'var(--surface-hover, rgba(0,0,0,0.06))', opacity: 0.82 }}>
      {children}
    </span>
  );
}

const domainStyle: CSSProperties = {
  border: '1px solid var(--border-color, rgba(0,0,0,0.10))',
  borderRadius: 8,
  background: 'var(--surface, rgba(0,0,0,0.02))',
  padding: 12,
  display: 'grid',
  gap: 8,
};

const domainHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  paddingBottom: 6,
  borderBottom: '1px solid var(--border-color, rgba(0,0,0,0.08))',
};

const rowStyle: CSSProperties = {
  width: '100%',
  border: '1px solid var(--border-color, rgba(0,0,0,0.10))',
  borderLeft: '3px solid var(--status-warning, #9a6700)',
  borderRadius: 7,
  background: 'var(--surface, rgba(0,0,0,0.02))',
  padding: 10,
  display: 'grid',
  gridTemplateColumns: 'auto minmax(0, 1fr)',
  gap: 10,
  alignItems: 'start',
  cursor: 'pointer',
};

const statStyle: CSSProperties = {
  border: '1px solid var(--border-color, rgba(0,0,0,0.10))',
  borderRadius: 7,
  background: 'var(--surface, rgba(0,0,0,0.02))',
  padding: 12,
};

const planBarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  border: '1px solid var(--border-color, rgba(0,0,0,0.10))',
  borderRadius: 8,
  background: 'var(--surface, rgba(0,0,0,0.02))',
  padding: '10px 12px',
};

const reviewQueueBtnStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '6px 11px',
  borderRadius: 6,
  border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
  background: 'var(--surface, transparent)',
  color: 'inherit',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const approveBtnStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '7px 13px',
  borderRadius: 6,
  border: '1px solid var(--status-success, #1f883d)',
  background: 'var(--status-success, #1f883d)',
  color: '#fff',
  fontSize: 12,
  fontWeight: 650,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const refreshBtnStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '6px 11px',
  borderRadius: 6,
  border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
  background: 'transparent',
  color: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
};

const emptyStyle: CSSProperties = {
  border: '1px dashed var(--border-color, rgba(0,0,0,0.16))',
  borderRadius: 8,
  padding: 24,
  fontSize: 13,
  opacity: 0.85,
};
