// Readiness / Get Started surface — the "AI drafts, humans certify" first-run
// backbone (Stages 1–3: readiness → propose → review queue).
//
// It calls the `/api/propose` endpoint (the existing propose engine, in dryRun
// preview mode), shows a readiness summary, and lists the ranked DRAFT
// proposals. Each draft carries its stored Certifier verdict ("what's missing
// to certify") and an AI-Generated TrustBadge, plus a "Review & Certify"
// affordance that routes into the EXISTING review/certify flow. Nothing here
// certifies or auto-promotes — promotion is a separate human action.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { ShieldCheck, Sparkles, ArrowRight, AlertTriangle, RefreshCw } from 'lucide-react';
import { TrustBadge } from '@duckcodeailabs/dql-ui';
import { api } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import type { ProposeReadiness, ReadinessProposal } from '../../store/types';

export function ReadinessPage(): JSX.Element {
  const { dispatch } = useNotebook();
  const [readiness, setReadiness] = useState<ProposeReadiness | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    void api.getProposeReadiness().then((result) => {
      if (cancelled) return;
      setReadiness(result);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => load(), [load]);

  // Route a proposal into the EXISTING human review/certify flow. The review
  // queue (ReviewPage) is the certify entry point; we do not rebuild it here.
  const openReview = useCallback(() => {
    dispatch({ type: 'SET_MAIN_VIEW', view: 'review' });
  }, [dispatch]);

  const summary = readiness?.summary;

  return (
    <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '22px 28px 40px', display: 'grid', gap: 16 }}>
        <header style={{ display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Sparkles size={20} />
            <div style={{ fontSize: 22, fontWeight: 750 }}>Get Started</div>
          </div>
          <div style={{ fontSize: 13, opacity: 0.72, maxWidth: 720, lineHeight: 1.55 }}>
            AI drafts, humans certify. We scanned your dbt evidence and proposed a ranked queue of
            draft governance blocks. Each draft is <strong>AI-Generated</strong> and was checked by
            the Certifier — review and certify the ones you trust. Nothing is certified automatically.
          </div>
        </header>

        {loading ? (
          <div style={emptyStyle}>Scanning dbt evidence and ranking proposals…</div>
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
            {/* Readiness summary */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
              <Stat label="dbt models scanned" value={summary!.modelsScanned} />
              <Stat label="Proposals ranked" value={summary!.proposalsRanked} />
              <Stat label="Ready for review" value={summary!.readyForReview} tone="success" />
              <Stat label="Already drafted" value={summary!.draftsExisting} />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 650 }}>
                Ranked draft proposals
                {summary!.projectName ? <span style={{ opacity: 0.6, fontWeight: 400 }}> · {summary!.projectName}</span> : null}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" onClick={load} style={refreshBtnStyle}>
                  <RefreshCw size={13} /> Refresh
                </button>
                <button type="button" onClick={openReview} style={reviewQueueBtnStyle}>
                  Open review queue <ArrowRight size={13} />
                </button>
              </div>
            </div>

            {/* Ranked DRAFT proposals */}
            <div style={{ display: 'grid', gap: 8 }}>
              {readiness.proposals.length === 0 ? (
                <div style={emptyStyle}>No proposable models found in the dbt manifest.</div>
              ) : (
                readiness.proposals.map((proposal) => (
                  <ProposalRow key={proposal.slug} proposal={proposal} onReview={openReview} />
                ))
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ProposalRow({ proposal, onReview }: { proposal: ReadinessProposal; onReview: () => void }): JSX.Element {
  const blocking = proposal.certification.errors.length;
  const warnings = proposal.certification.warnings.length;
  // What's missing to certify: blocking errors gate certification; warnings are
  // advisory. We surface the first few so the reviewer knows what to fix.
  const gaps = useMemo(
    () => [...proposal.certification.errors, ...proposal.certification.warnings].slice(0, 3),
    [proposal.certification.errors, proposal.certification.warnings],
  );

  return (
    <div style={rowStyle}>
      <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, fontWeight: 700 }}>{proposal.model}</span>
          {/* AI-Generated draft — never certified. */}
          <TrustBadge state="ai_generated" />
          <Pill>{proposal.inference.pattern}</Pill>
          <span style={{ fontSize: 11, opacity: 0.6 }}>score {proposal.ranking.score}</span>
        </div>
        <div style={{ fontSize: 12, opacity: 0.7 }}>
          domain {proposal.domain} · fan-out {proposal.ranking.fanOut}
          {proposal.ranking.exposureLinked ? ' · exposure' : ''}
          {proposal.inference.grain ? ` · grain ${proposal.inference.grain}` : ''}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11 }}>
          {blocking > 0 ? (
            <span style={{ ...gapPill, color: 'var(--status-error, #cf222e)' }}>
              {blocking} blocking
            </span>
          ) : (
            <span style={{ ...gapPill, color: 'var(--status-success, #1f883d)' }}>
              <ShieldCheck size={12} /> no blockers
            </span>
          )}
          {warnings > 0 ? <span style={gapPill}>{warnings} warning{warnings === 1 ? '' : 's'}</span> : null}
          <span style={{ opacity: 0.55 }}>what's missing to certify</span>
        </div>
        {gaps.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11, opacity: 0.66, display: 'grid', gap: 2 }}>
            {gaps.map((gap, index) => (
              <li key={`${gap.rule}-${index}`}>
                <span style={{ opacity: 0.8 }}>{gap.rule}</span>: {gap.message}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
        <button type="button" onClick={onReview} style={reviewBtnStyle}>
          Review &amp; Certify <ArrowRight size={13} />
        </button>
      </div>
    </div>
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

const rowStyle: CSSProperties = {
  width: '100%',
  border: '1px solid var(--border-color, rgba(0,0,0,0.10))',
  borderLeft: '3px solid var(--status-warning, #9a6700)',
  borderRadius: 7,
  background: 'var(--surface, rgba(0,0,0,0.02))',
  padding: 12,
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: 12,
  alignItems: 'center',
};

const statStyle: CSSProperties = {
  border: '1px solid var(--border-color, rgba(0,0,0,0.10))',
  borderRadius: 7,
  background: 'var(--surface, rgba(0,0,0,0.02))',
  padding: 12,
};

const gapPill: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 3,
  padding: '1px 6px',
  borderRadius: 4,
  background: 'var(--surface-hover, rgba(0,0,0,0.05))',
};

const reviewBtnStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '7px 12px',
  borderRadius: 6,
  border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
  background: 'var(--surface, transparent)',
  color: 'inherit',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const reviewQueueBtnStyle: CSSProperties = {
  ...reviewBtnStyle,
  padding: '6px 11px',
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
