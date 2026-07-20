import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Boxes, CheckCircle2, CircleAlert, GraduationCap, Loader2, Network, ShieldCheck, Sparkles } from 'lucide-react';
import { api, type DomainKnowledgeResponse } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import type { Domain, Skill } from '../../store/types';
import { themes, type Theme } from '../../themes/notebook-theme';
import { DomainsPage } from './DomainsPage';
import { SkillsPage } from '../skills/SkillsPage';

type ContextTab = 'overview' | 'domains' | 'skills' | 'knowledge';

/** One home for the business context that guides the governed agent. */
export function GovernedContextPage({ initialTab = 'overview' }: { initialTab?: ContextTab }): JSX.Element {
  const { state } = useNotebook();
  const t = themes[state.themeMode];
  const [tab, setTab] = useState<ContextTab>(initialTab);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => setTab(initialTab), [initialTab]);
  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([api.getDomains(), api.getSkills()])
      .then(([domainResult, skillResult]) => {
        if (cancelled) return;
        setDomains(Array.isArray(domainResult.domains) ? domainResult.domains : []);
        setSkills(Array.isArray(skillResult.skills) ? skillResult.skills : []);
      })
      .catch(() => {
        if (!cancelled) { setDomains([]); setSkills([]); }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => load(), [load]);

  const status = useMemo(() => {
    const ownedDomains = domains.filter((domain) => Boolean(domain.businessOwner || domain.owner)).length;
    const activeSkills = skills.filter((skill) => !skill.status || skill.status === 'active').length;
    const draftSkills = skills.filter((skill) => skill.status === 'draft').length;
    return { ownedDomains, activeSkills, draftSkills };
  }, [domains, skills]);

  const startAiDraft = useCallback(() => {
    setTab('domains');
    window.setTimeout(() => window.dispatchEvent(new Event('dql:context-build')), 50);
  }, []);

  const tabs: Array<{ id: ContextTab; label: string; count?: number }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'domains', label: 'Domains', count: domains.length },
    { id: 'skills', label: 'Skills', count: skills.length },
    { id: 'knowledge', label: 'Knowledge 360' },
  ];
  return (
    <div style={{ flex: 1, minWidth: 0, overflow: 'auto', background: t.appBg }}>
      <div style={{ maxWidth: 1040, margin: '0 auto', padding: '22px 28px 40px' }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 18, marginBottom: 15 }}>
          <div>
            <div style={{ display: 'flex', gap: 9, alignItems: 'center' }}><Boxes size={20} color={t.accent} /><h1 style={{ fontSize: 22, color: t.textPrimary }}>Governed context</h1></div>
            <p style={{ marginTop: 6, fontSize: 13, lineHeight: 1.5, color: t.textMuted, maxWidth: 700 }}>Domains define business boundaries. Skills teach the agent approved vocabulary, reuse rules, and when to ask for clarification.</p>
          </div>
          <button type="button" onClick={startAiDraft} style={primaryButton(t)}><Sparkles size={14} /> Build with AI</button>
        </header>
        <nav aria-label="Governed context sections" style={{ display: 'flex', gap: 3, borderBottom: `1px solid ${t.headerBorder}`, marginBottom: 18 }}>
          {tabs.map((item) => <button key={item.id} type="button" onClick={() => setTab(item.id)} style={{ border: 'none', borderBottom: `2px solid ${tab === item.id ? t.accent : 'transparent'}`, background: 'transparent', padding: '9px 12px', color: tab === item.id ? t.textPrimary : t.textMuted, fontWeight: tab === item.id ? 700 : 600, cursor: 'pointer', fontFamily: t.font, fontSize: 12.5 }}>
            {item.label}{item.count !== undefined ? ` · ${item.count}` : ''}
          </button>)}
        </nav>
        {tab === 'overview' ? <ContextOverview t={t} loading={loading} domains={domains} skills={skills} status={status} onBuild={startAiDraft} onTab={setTab} /> : null}
        {tab === 'domains' ? <DomainsPage embedded /> : null}
        {tab === 'skills' ? <SkillsPage embedded /> : null}
        {tab === 'knowledge' ? <Knowledge360 t={t} domains={domains} /> : null}
      </div>
    </div>
  );
}

export function Knowledge360({ t, domains, initialDomainId }: {
  t: Theme;
  domains: Array<Pick<Domain, 'id' | 'name'>>;
  initialDomainId?: string | null;
}): JSX.Element {
  const [domainId, setDomainId] = useState(initialDomainId ?? domains[0]?.id ?? '');
  const [knowledge, setKnowledge] = useState<DomainKnowledgeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!domainId && domains[0]?.id) setDomainId(domains[0].id);
  }, [domainId, domains]);
  useEffect(() => {
    if (initialDomainId && domains.some((domain) => domain.id === initialDomainId)) setDomainId(initialDomainId);
  }, [domains, initialDomainId]);
  useEffect(() => {
    if (!domainId) { setKnowledge(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api.getDomainKnowledge(domainId)
      .then((result) => { if (!cancelled) setKnowledge(result); })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setKnowledge(null);
          setError(reason instanceof Error ? reason.message : 'Could not load the compiled knowledge capsule.');
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [domainId]);

  const kindCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const object of knowledge?.objects ?? []) counts[object.kind] = (counts[object.kind] ?? 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [knowledge]);

  return <div style={{ display: 'grid', gap: 14 }}>
    <section style={{ border: `1px solid ${t.cellBorder}`, borderRadius: 10, background: t.cellBg, padding: 15 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div><div style={{ display: 'flex', gap: 7, alignItems: 'center', color: t.textPrimary, fontWeight: 700, fontSize: 13 }}><Network size={16} color={t.accent} /> Compiled Domain 360</div><div style={{ marginTop: 4, color: t.textMuted, fontSize: 12 }}>The same qualified graph, route policy, and skill snapshot used by Ask.</div></div>
        <select aria-label="Domain knowledge capsule" value={domainId} onChange={(event) => setDomainId(event.target.value)} style={{ minWidth: 210, border: `1px solid ${t.inputBorder}`, borderRadius: 7, background: t.inputBg, color: t.textPrimary, padding: '7px 9px', fontFamily: t.font }}>
          <option value="">Select a domain</option>
          {[...domains].sort((a, b) => a.name.localeCompare(b.name)).map((domain) => <option key={domain.id} value={domain.id}>{domain.name}</option>)}
        </select>
      </div>
    </section>
    {loading ? <div style={{ color: t.textMuted, display: 'flex', gap: 8, alignItems: 'center', padding: 24 }}><Loader2 size={15} /> Loading compiled knowledge…</div> : null}
    {error ? <div style={{ border: `1px solid ${t.error}`, background: t.cellBg, color: t.error, borderRadius: 8, padding: 12, fontSize: 12.5 }}>{error}</div> : null}
    {knowledge ? <>
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 9 }}>
        <StatCard t={t} label="Objects" value={knowledge.counts.objects} detail="qualified knowledge" icon={<Boxes size={16} />} />
        <StatCard t={t} label="Relations" value={knowledge.counts.edges} detail="provenance + policy" icon={<Network size={16} />} />
        <StatCard t={t} label="Authorized" value={knowledge.counts.routeStates.authorized ?? 0} detail="safe cross-domain routes" icon={<ShieldCheck size={16} />} />
        <StatCard t={t} label="Blocked / stale" value={(knowledge.counts.routeStates.blocked ?? 0) + (knowledge.counts.routeStates.stale ?? 0)} detail="never auto-joined" icon={<CircleAlert size={16} />} />
      </section>
      <section style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)', gap: 12 }}>
        <div style={{ border: `1px solid ${t.cellBorder}`, borderRadius: 9, background: t.cellBg, padding: 14 }}>
          <strong style={{ color: t.textPrimary, fontSize: 13 }}>Knowledge capsule</strong>
          <p style={{ color: t.textSecondary, fontSize: 12.5, lineHeight: 1.5, margin: '7px 0 11px' }}>{knowledge.capsule?.description || 'Compiled domain boundary and governed references.'}</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{kindCounts.map(([kind, count]) => <span key={kind} style={{ border: `1px solid ${t.cellBorder}`, background: t.pillBg, color: t.textSecondary, borderRadius: 999, padding: '3px 7px', fontSize: 11 }}>{kind.replace(/_/g, ' ')} · {count}</span>)}</div>
          <div style={{ marginTop: 11, color: t.textMuted, fontSize: 11 }}>Snapshot {knowledge.snapshotId.slice(0, 12)} · graph {knowledge.sourceFingerprint.slice(0, 12)}{knowledge.truncated ? ' · bounded response' : ''}</div>
        </div>
        <div style={{ border: `1px solid ${t.cellBorder}`, borderRadius: 9, background: t.cellBg, padding: 14 }}>
          <strong style={{ color: t.textPrimary, fontSize: 13 }}>Cross-domain routes</strong>
          <div style={{ display: 'grid', gap: 7, marginTop: 9 }}>{knowledge.routes.length ? knowledge.routes.map((route) => <div key={route.id} style={{ borderTop: `1px solid ${t.headerBorder}`, paddingTop: 7 }}><div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, color: t.textSecondary, fontSize: 12 }}><span>{route.providerDomainId} → {route.consumerDomainId}</span><span style={{ color: route.state === 'authorized' ? t.success : route.state === 'observed' ? t.textMuted : t.warning, fontWeight: 700 }}>{route.state}</span></div><div style={{ marginTop: 3, color: t.textMuted, fontSize: 11 }}>{route.purpose || route.reasonCodes.join(', ') || 'governed route'}</div></div>) : <div style={{ color: t.textMuted, fontSize: 12, marginTop: 8 }}>No cross-domain routes declared.</div>}</div>
        </div>
      </section>
    </> : null}
  </div>;
}

function ContextOverview({ t, loading, domains, skills, status, onBuild, onTab }: {
  t: Theme;
  loading: boolean; domains: Domain[]; skills: Skill[];
  status: { ownedDomains: number; activeSkills: number; draftSkills: number };
  onBuild: () => void; onTab: (tab: ContextTab) => void;
}): JSX.Element {
  if (loading) return <div style={{ padding: '42px 0', color: t.textMuted, display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}><Loader2 size={15} /> Loading governed context…</div>;
  const gaps: string[] = [];
  if (!domains.length) gaps.push('Create a business domain before relying on AI guidance.');
  else if (status.ownedDomains < domains.length) gaps.push(`${domains.length - status.ownedDomains} domain${domains.length - status.ownedDomains === 1 ? '' : 's'} still need an owner.`);
  if (!skills.length) gaps.push('Draft a domain skill so the agent has governed business guidance.');
  if (status.draftSkills) gaps.push(`${status.draftSkills} skill${status.draftSkills === 1 ? ' is' : 's are'} still draft-only and will not guide answers.`);
  return <div style={{ display: 'grid', gap: 16 }}>
    <section style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
      <StatCard t={t} label="Domains" value={domains.length} detail={`${status.ownedDomains} with an owner`} icon={<Boxes size={17} />} />
      <StatCard t={t} label="Active skills" value={status.activeSkills} detail="available to the agent" icon={<GraduationCap size={17} />} />
      <StatCard t={t} label="Draft skills" value={status.draftSkills} detail="review before activation" icon={<Sparkles size={17} />} />
    </section>
    <section style={{ border: `1px solid ${t.cellBorder}`, borderRadius: 10, background: t.cellBg, padding: 16, display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><CheckCircle2 size={16} color={gaps.length ? t.warning : t.success} /><strong style={{ color: t.textPrimary, fontSize: 13 }}>Readiness</strong></div>
      {gaps.length ? <div style={{ display: 'grid', gap: 6 }}>{gaps.map((gap) => <div key={gap} style={{ display: 'flex', gap: 7, color: t.textSecondary, fontSize: 12.5 }}><CircleAlert size={14} color={t.warning} />{gap}</div>)}</div> : <div style={{ color: t.success, fontSize: 12.5 }}>Your agent has owned domains and active governed skills available for retrieval.</div>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
        <button type="button" onClick={onBuild} style={primaryButton(t)}><Sparkles size={13} /> Build domains & skills with AI</button>
        <button type="button" onClick={() => onTab('domains')} style={secondaryButton(t)}>Manage domains</button>
        <button type="button" onClick={() => onTab('skills')} style={secondaryButton(t)}>Manage skills</button>
      </div>
    </section>
  </div>;
}

function StatCard({ t, label, value, detail, icon }: { t: Theme; label: string; value: number; detail: string; icon: React.ReactNode }): JSX.Element {
  return <div style={{ border: `1px solid ${t.cellBorder}`, borderRadius: 9, background: t.cellBg, padding: 13 }}><div style={{ display: 'flex', justifyContent: 'space-between', color: t.textMuted, fontSize: 12 }}>{label}{icon}</div><div style={{ color: t.textPrimary, fontSize: 25, fontWeight: 750, marginTop: 7 }}>{value}</div><div style={{ color: t.textMuted, fontSize: 11.5, marginTop: 3 }}>{detail}</div></div>;
}

function primaryButton(t: Theme): React.CSSProperties {
  return { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 7, border: `1px solid ${t.accent}`, background: t.accent, color: '#fff', fontWeight: 700, fontSize: 12.5, fontFamily: t.font, cursor: 'pointer' };
}
function secondaryButton(t: Theme): React.CSSProperties {
  return { display: 'inline-flex', alignItems: 'center', padding: '7px 12px', borderRadius: 7, border: `1px solid ${t.btnBorder}`, background: t.btnBg, color: t.textSecondary, fontWeight: 650, fontSize: 12.5, fontFamily: t.font, cursor: 'pointer' };
}
