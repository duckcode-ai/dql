import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Theme } from '../../themes/notebook-theme';
import {
  api,
  type DbtOnboardingJob,
  type DbtOnboardingPreviewResponse,
  type DbtOnboardingStatusResponse,
  type DomainDiscoveryApplyResponse,
  type DomainDiscoveryProposal,
  type DomainDiscoveryResponse,
  type OnboardingCapabilities,
} from '../../api/client';
import {
  normalizeOnboardingJob,
  onboardingErrorView,
  resolveDbtResumeStage,
  type DbtOnboardingStage,
} from './setup-wizard-model';

type StartTarget = 'modeling' | 'skills' | 'ask' | 'block';

interface DbtOnboardingFlowProps {
  t: Theme;
  initialProjectDir?: string;
  onBack: () => void;
  onClose: () => void;
  onComplete: () => void;
  onOpen: (target: StartTarget) => void;
}

const STAGES: Array<{ id: DbtOnboardingStage; label: string }> = [
  { id: 'connect', label: 'Connect' },
  { id: 'inspect', label: 'Artifacts' },
  { id: 'domains', label: 'Domains' },
  { id: 'domain-model', label: 'Model' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'ready', label: 'Start' },
];

function progressIndex(stage: DbtOnboardingStage): number {
  if (stage === 'building') return 1;
  return Math.max(0, STAGES.findIndex((item) => item.id === stage));
}

function confidenceLabel(value: DomainDiscoveryProposal['confidence']): string {
  return typeof value === 'number' ? `${Math.round(value * (value <= 1 ? 100 : 1))}%` : value;
}

function artifactLabel(path: string | null | undefined): string {
  return path ? path : 'Optional · not available';
}

function proposalIsSafeDefault(proposal: DomainDiscoveryProposal): boolean {
  const highConfidence = proposal.confidence === 'high'
    || (typeof proposal.confidence === 'number' && proposal.confidence >= 0.8);
  return highConfidence && !proposal.requiresHumanDecision && (proposal.conflicts?.length ?? 0) === 0;
}

function optionalCapabilityMessages(capabilities?: OnboardingCapabilities): string[] {
  const messages: string[] = [];
  const ai = capabilities?.ai;
  const warehouse = capabilities?.warehouse;
  if (ai === false || (typeof ai === 'object' && !ai.available)) {
    messages.push(typeof ai === 'object' && ai.message ? ai.message : 'AI assistance is unavailable; deterministic discovery remains available.');
  }
  if (warehouse === false || (typeof warehouse === 'object' && !warehouse.available)) {
    messages.push(typeof warehouse === 'object' && warehouse.message ? warehouse.message : 'Warehouse validation can be connected later; certification remains incomplete until then.');
  }
  return messages;
}

export function DbtOnboardingFlow({
  t,
  initialProjectDir = '',
  onBack,
  onClose,
  onComplete,
  onOpen,
}: DbtOnboardingFlowProps) {
  const [stage, setStage] = useState<DbtOnboardingStage>('connect');
  const [status, setStatus] = useState<DbtOnboardingStatusResponse | null>(null);
  const [projectDir, setProjectDir] = useState(initialProjectDir || '.');
  const [manifestPath, setManifestPath] = useState('target/manifest.json');
  const [preview, setPreview] = useState<DbtOnboardingPreviewResponse | null>(null);
  const [job, setJob] = useState<DbtOnboardingJob | null>(null);
  const [discovery, setDiscovery] = useState<DomainDiscoveryResponse | null>(null);
  const [domainApply, setDomainApply] = useState<DomainDiscoveryApplyResponse | null>(null);
  const [selectedProposals, setSelectedProposals] = useState<Set<string>>(new Set());
  const [useAi, setUseAi] = useState(true);
  const [loading, setLoading] = useState(false);
  const [statusLoading, setStatusLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [setupSkipped, setSetupSkipped] = useState(false);
  const mounted = useRef(true);

  const inputStyle: React.CSSProperties = {
    background: t.inputBg,
    border: `1px solid ${t.inputBorder}`,
    borderRadius: 7,
    color: t.textPrimary,
    fontSize: 13,
    fontFamily: t.font,
    padding: '9px 11px',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
  };

  const capabilities = discovery?.capabilities ?? preview?.capabilities ?? status?.capabilities;
  const capabilityMessages = optionalCapabilityMessages(capabilities);
  const errorView = error ? onboardingErrorView(error, projectDir, manifestPath) : null;
  const activeIndex = progressIndex(stage);

  useEffect(() => {
    mounted.current = true;
    void api.getOnboardingStatus()
      .then((result) => {
        if (!mounted.current) return;
        setStatus(result);
        if (result.dbt?.projectDir) setProjectDir(result.dbt.projectDir);
        if (result.dbt?.manifestPath) setManifestPath(result.dbt.manifestPath);
        setStage(resolveDbtResumeStage(result));
      })
      .catch(() => {
        // A missing status endpoint does not block the deterministic connect path.
      })
      .finally(() => { if (mounted.current) setStatusLoading(false); });
    return () => { mounted.current = false; };
  }, []);

  const inspect = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.previewDbtOnboarding({ projectDir: projectDir || '.', manifestPath });
      if (!mounted.current) return;
      setPreview(result);
      setProjectDir(result.projectDir || projectDir || '.');
      setManifestPath(result.manifestPath || manifestPath);
      setStage('inspect');
    } catch (nextError) {
      if (mounted.current) setError(nextError);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [manifestPath, projectDir]);

  const discoverDomains = useCallback(async (preferAi = useAi) => {
    setLoading(true);
    setError(null);
    try {
      let result: DomainDiscoveryResponse;
      try {
        result = await api.discoverOnboardingDomains({
          snapshotId: status?.snapshotId,
          useAi: preferAi,
        });
      } catch (nextError) {
        const code = (nextError as { code?: string })?.code;
        if (preferAi && code === 'AI_PROVIDER_UNAVAILABLE') {
          setUseAi(false);
          result = await api.discoverOnboardingDomains({ snapshotId: status?.snapshotId, useAi: false });
        } else {
          throw nextError;
        }
      }
      if (!mounted.current) return;
      const proposals = (result.proposals ?? []).map((proposal) => ({ ...proposal, lifecycle: 'draft' as const }));
      const normalized = { ...result, proposals };
      setDiscovery(normalized);
      setSelectedProposals(new Set(proposals.filter(proposalIsSafeDefault).map((proposal) => proposal.id)));
      setStage('domains');
    } catch (nextError) {
      if (mounted.current) setError(nextError);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [status?.snapshotId, useAi]);

  const pollJob = useCallback(async (jobId: string) => {
    for (;;) {
      const response = await api.getOnboardingJob(jobId);
      const nextJob = normalizeOnboardingJob(response);
      if (!mounted.current) return;
      setJob(nextJob);
      if (nextJob.status === 'completed') {
        await discoverDomains(useAi);
        return;
      }
      if (nextJob.status === 'failed' || nextJob.status === 'cancelled') {
        throw new Error(nextJob.error || nextJob.message || `Onboarding ${nextJob.status}.`);
      }
      await new Promise((resolve) => window.setTimeout(resolve, 700));
    }
  }, [discoverDomains, useAi]);

  const buildSnapshot = useCallback(async (buildArtifacts: boolean) => {
    setLoading(true);
    setError(null);
    setStage('building');
    try {
      const applied = await api.applyDbtOnboarding({
        projectDir: projectDir || '.',
        manifestPath,
        expectedFingerprint: preview?.fingerprint,
        buildArtifacts,
      });
      const refreshed = await api.refreshDbtOnboarding({
        expectedFingerprint: applied.fingerprint ?? preview?.fingerprint,
        buildArtifacts,
      });
      const jobId = refreshed.jobId ?? refreshed.id;
      if (jobId) {
        setJob({ id: jobId, status: (refreshed.status as DbtOnboardingJob['status']) ?? 'queued' });
        await pollJob(jobId);
      } else {
        await discoverDomains(useAi);
      }
    } catch (nextError) {
      if (mounted.current) {
        setError(nextError);
        setStage(preview ? 'inspect' : 'connect');
      }
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [discoverDomains, manifestPath, pollJob, preview, projectDir, useAi]);

  useEffect(() => {
    if (stage === 'domains' && !discovery && !loading && !statusLoading && !error) void discoverDomains(useAi);
  }, [discoverDomains, discovery, error, loading, stage, statusLoading, useAi]);

  const saveDomains = useCallback(async (mode: 'preview' | 'apply') => {
    if (!discovery) return;
    const selected = discovery.proposals
      .filter((proposal) => selectedProposals.has(proposal.id))
      .map((proposal) => ({ ...proposal, lifecycle: 'draft' as const }));
    if (selected.length === 0) {
      setSetupSkipped(true);
      setStage('domain-model');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await api.applyOnboardingDomains({
        proposals: selected,
        expectedSourceFingerprint: discovery.sourceFingerprint,
        mode,
      });
      if (!mounted.current) return;
      setDomainApply(result);
      if (mode === 'apply' || result.applied) setStage('domain-model');
    } catch (nextError) {
      if (mounted.current) setError(nextError);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [discovery, selectedProposals]);

  const cancelJob = useCallback(async () => {
    if (!job) return;
    try {
      await api.cancelOnboardingJob(job.id);
    } finally {
      setJob((current) => current ? { ...current, status: 'cancelled' } : current);
      setStage('inspect');
      setLoading(false);
    }
  }, [job]);

  const selectedCount = selectedProposals.size;
  const appliedNames = useMemo(
    () => domainApply?.domains?.map((domain) => domain.id) ?? discovery?.proposals.filter((proposal) => selectedProposals.has(proposal.id)).map((proposal) => proposal.name) ?? [],
    [discovery, domainApply, selectedProposals],
  );

  const completeAndOpen = (target: StartTarget) => {
    onComplete();
    onOpen(target);
  };

  return (
    <div style={{
      background: t.modalBg,
      border: `1px solid ${t.cellBorder}`,
      borderRadius: 12,
      width: 760,
      maxWidth: 'calc(100vw - 48px)',
      maxHeight: 'calc(100vh - 60px)',
      display: 'flex',
      flexDirection: 'column',
      boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
      overflow: 'hidden',
    }} role="dialog" aria-modal="true" aria-labelledby="dbt-onboarding-title">
      <div style={{ padding: '18px 22px 14px', borderBottom: `1px solid ${t.cellBorder}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start' }}>
          <div>
            <h2 id="dbt-onboarding-title" style={{ margin: 0, color: t.textPrimary, font: `600 17px ${t.font}` }}>
              Connect dbt to DQL
            </h2>
            <div style={{ marginTop: 5, color: t.textMuted, font: `12px/1.45 ${t.font}` }}>
              dbt owns models, schema, tests, descriptions, and MetricFlow. DQL adds only governed analytical context.
            </div>
          </div>
          <button aria-label="Close setup" onClick={onClose} style={{ border: 0, background: 'transparent', color: t.textMuted, cursor: 'pointer', fontSize: 20 }}>×</button>
        </div>
        <ol aria-label="dbt onboarding progress" style={{ listStyle: 'none', display: 'grid', gridTemplateColumns: `repeat(${STAGES.length}, 1fr)`, gap: 6, padding: 0, margin: '16px 0 0' }}>
          {STAGES.map((item, index) => (
            <li key={item.id} aria-current={index === activeIndex ? 'step' : undefined} style={{ minWidth: 0 }}>
              <div style={{ height: 3, borderRadius: 3, background: index <= activeIndex ? t.accent : t.cellBorder }} />
              <div style={{ marginTop: 5, color: index <= activeIndex ? t.textPrimary : t.textMuted, font: `${index === activeIndex ? 600 : 400} 10px ${t.font}` }}>{item.label}</div>
            </li>
          ))}
        </ol>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 22px' }}>
        {statusLoading && <Notice t={t} title="Checking existing setup…" body="You can resume from the first incomplete step." />}

        {stage === 'connect' && !statusLoading && (
          <Section title="1. Connect the dbt project" description="Point DQL at the existing dbt project and artifact. DQL reads these files in place; it does not create a second semantic copy." t={t}>
            <Field label="dbt project directory" hint="Folder containing dbt_project.yml" t={t}>
              <input aria-label="dbt project directory" value={projectDir} onChange={(event) => setProjectDir(event.target.value)} placeholder="." style={inputStyle} />
            </Field>
            <Field label="Manifest path" hint="Relative to the dbt project directory" t={t}>
              <input aria-label="dbt manifest path" value={manifestPath} onChange={(event) => setManifestPath(event.target.value)} placeholder="target/manifest.json" style={inputStyle} />
            </Field>
            <OwnershipCallout t={t} />
          </Section>
        )}

        {stage === 'inspect' && preview && (
          <Section title="2. Review dbt artifacts" description="DQL will enable Manifest v3 and dbt-first modeling, then build an immutable snapshot from these sources." t={t}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
              {Object.entries(preview.counts).map(([label, value]) => <CountCard key={label} label={label} value={value} t={t} />)}
            </div>
            <div style={{ border: `1px solid ${t.cellBorder}`, borderRadius: 8, overflow: 'hidden' }}>
              <ArtifactRow label="manifest.json" value={artifactLabel(preview.artifacts.manifest)} required t={t} />
              <ArtifactRow label="catalog.json" value={artifactLabel(preview.artifacts.catalog)} t={t} />
              <ArtifactRow label="semantic_manifest.json" value={artifactLabel(preview.artifacts.semanticManifest)} t={t} />
            </div>
            <Notice t={t} title="What changes" body="DQL writes project configuration and a rebuildable snapshot. dbt SQL/YAML and MetricFlow formulas remain the source of truth and are never copied into Domain Packages." />
          </Section>
        )}

        {stage === 'building' && (
          <Section title="Building the dbt-first snapshot" description="Artifact generation, validation, compile, and indexing are handled as one resumable job. The previous active snapshot remains usable until this completes." t={t}>
            <div style={{ border: `1px solid ${t.cellBorder}`, borderRadius: 10, padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: t.textPrimary, font: `600 13px ${t.font}` }}>
                <span>{job?.stage ?? 'Preparing project'}</span><span>{typeof job?.progress === 'number' ? `${job.progress}%` : job?.status ?? 'running'}</span>
              </div>
              <div style={{ height: 7, borderRadius: 8, background: t.cellBorder, marginTop: 12, overflow: 'hidden' }}>
                <div style={{ width: `${Math.max(8, job?.progress ?? 15)}%`, height: '100%', background: t.accent, transition: 'width .2s' }} />
              </div>
              {job?.message && <div style={{ marginTop: 10, color: t.textSecondary, font: `12px/1.5 ${t.font}` }}>{job.message}</div>}
            </div>
          </Section>
        )}

        {stage === 'domains' && (
          <Section title="3. Review discovered domains" description="Proposals use dbt groups, tags, paths, owners, exposures, packages, and MetricFlow evidence. Nothing is certified automatically." t={t}>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, color: t.textSecondary, font: `12px/1.45 ${t.font}` }}>
              <input type="checkbox" checked={useAi} onChange={(event) => { setUseAi(event.target.checked); setDiscovery(null); setError(null); }} />
              <span><strong style={{ color: t.textPrimary }}>Use AI to summarize repository evidence</strong><br />Optional and review-only. AI cannot invent membership or set certified lifecycle.</span>
            </label>
            {discovery?.warnings?.map((warning) => <Notice key={warning} t={t} title="Discovery note" body={warning} />)}
            {discovery && discovery.proposals.length === 0 && (
              <Notice t={t} title="No confident domains found" body="Continue to create domains manually in Domain Studio. Ask remains available in limited-context, review-required mode." />
            )}
            {discovery?.proposals.map((proposal) => {
              const selected = selectedProposals.has(proposal.id);
              return (
                <label key={proposal.id} style={{ display: 'block', border: `1px solid ${selected ? t.accent : t.cellBorder}`, background: selected ? `${t.accent}0d` : t.inputBg, borderRadius: 9, padding: 13, cursor: 'pointer' }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <input type="checkbox" checked={selected} onChange={() => {
                      setDomainApply(null);
                      setSelectedProposals((current) => {
                        const next = new Set(current);
                        if (next.has(proposal.id)) next.delete(proposal.id); else next.add(proposal.id);
                        return next;
                      });
                    }} aria-label={`Select ${proposal.name}`} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, alignItems: 'center' }}>
                        <strong style={{ color: t.textPrimary, font: `600 13px ${t.font}` }}>{proposal.name}</strong>
                        <Pill text={`${confidenceLabel(proposal.confidence)} confidence`} t={t} />
                        <Pill text="Draft only" t={t} tone="warning" />
                        {proposal.requiresHumanDecision && <Pill text="Decision required" t={t} tone="warning" />}
                      </div>
                      {proposal.description && <p style={{ margin: '6px 0 0', color: t.textSecondary, font: `12px/1.45 ${t.font}` }}>{proposal.description}</p>}
                      <div style={{ marginTop: 8, color: t.textMuted, font: `11px/1.45 ${t.font}` }}>
                        Evidence: {proposal.evidence.length > 0 ? proposal.evidence.slice(0, 4).map((item) => `${item.kind}: ${item.value}`).join(' · ') : 'No evidence supplied — manual review required'}
                      </div>
                      {(proposal.conflicts?.length ?? 0) > 0 && <div style={{ marginTop: 6, color: t.warning, font: `11px/1.45 ${t.font}` }}>Conflicts: {proposal.conflicts?.join(' · ')}</div>}
                    </div>
                  </div>
                </label>
              );
            })}
            {(domainApply?.preview?.length ?? 0) > 0 && (
              <div style={{ border: `1px solid ${t.accent}55`, background: `${t.accent}09`, borderRadius: 9, padding: 12 }}>
                <div style={{ color: t.textPrimary, font: `600 12px ${t.font}` }}>Review Domain Package source changes</div>
                <div style={{ marginTop: 4, color: t.textMuted, font: `11px/1.45 ${t.font}` }}>Only sparse DQL domain declarations and bindings will be written. Confirm after reviewing these target files.</div>
                <div style={{ display: 'grid', gap: 6, marginTop: 9 }}>
                  {domainApply?.preview?.map((change) => <div key={`${change.operation}:${change.path}`} style={{ display: 'grid', gridTemplateColumns: '60px 1fr', gap: 8, color: t.textSecondary, font: `11px ${t.font}` }}><strong>{change.operation}</strong><code style={{ color: t.textPrimary }}>{change.path}</code>{change.summary && <span style={{ gridColumn: '2', color: t.textMuted }}>{change.summary}</span>}</div>)}
                </div>
              </div>
            )}
          </Section>
        )}

        {stage === 'domain-model' && (
          <Section title="4. Build the Domain Model" description="The unified canvas adds analytical meaning over dbt provenance. Start small: bind high-value entities and prove only the joins agents may use." t={t}>
            {appliedNames.length > 0 && <Notice t={t} title={`${appliedNames.length} draft domain${appliedNames.length === 1 ? '' : 's'} created`} body={appliedNames.join(' · ')} />}
            {setupSkipped && <Notice t={t} title="Domain setup skipped" body="You can continue, but Ask is limited-context and all generated output requires review until governed paths exist." />}
            <Checklist t={t} items={[
              ['Bind business entities', 'Reference dbt unique IDs; do not duplicate columns or descriptions.'],
              ['Declare analytical grain', 'Add grain only where dbt metadata is insufficient.'],
              ['Prove relationships', 'Cardinality, fanout, key mapping, evidence, and lifecycle control agent joins.'],
              ['Export cross-domain paths', 'Provider exports and consumer imports are required in addition to relationship proof.'],
            ]} />
            <button onClick={() => completeAndOpen('modeling')} style={secondaryButton(t)}>Open Domain Model now</button>
          </Section>
        )}

        {stage === 'knowledge' && (
          <Section title="5. Add domain knowledge" description="Skills and terms teach agents vocabulary, policies, examples, exclusions, and when to ask for clarification." t={t}>
            <Checklist t={t} items={[
              ['Terms', 'Define business vocabulary and map synonyms to domain-qualified concepts.'],
              ['Domain skills', 'Add policies, examples, exclusions, and required clarifications for this domain.'],
              ['Evaluations', 'Test retrieval, metric selection, safe joins, refusal, and clarification behavior.'],
              ['Review lifecycle', 'AI may draft from repository evidence, but a person reviews and certifies.'],
            ]} />
            <button onClick={() => completeAndOpen('skills')} style={secondaryButton(t)}>Open Skills now</button>
          </Section>
        )}

        {stage === 'ready' && (
          <Section title="Your dbt-first workspace is ready to continue" description="Choose the next task. Setup is resumable, and trust improves as relationships, skills, evaluations, and certified assets are completed." t={t}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
              <StartCard title="Ask AI" body={setupSkipped ? 'Limited-context and review-required until domains are governed.' : 'Use the governed cascade; unsafe paths clarify or refuse.'} action="Open Ask" onClick={() => completeAndOpen('ask')} t={t} />
              <StartCard title="Build a Block" body="Turn reviewed analysis into a reusable domain asset and evaluate it." action="New Block" onClick={() => completeAndOpen('block')} t={t} />
              <StartCard title="Domain Studio" body="Continue bindings, relationships, knowledge, readiness, and dbt scope." action="Open Studio" onClick={() => completeAndOpen('modeling')} t={t} />
            </div>
          </Section>
        )}

        {capabilityMessages.map((message) => <Notice key={message} t={t} title="Optional capability" body={message} />)}
        {errorView && (
          <div role="alert" style={{ border: `1px solid ${errorView.optional ? t.warning : t.error}`, background: errorView.optional ? `${t.warning}0d` : `${t.error}0d`, borderRadius: 9, padding: 13, marginTop: 14 }}>
            <div style={{ color: errorView.optional ? t.warning : t.error, font: `600 13px ${t.font}` }}>{errorView.title}</div>
            <div style={{ color: t.textSecondary, font: `12px/1.5 ${t.font}`, marginTop: 5 }}>{errorView.message}</div>
            {errorView.command && <code style={{ display: 'block', marginTop: 9, padding: '8px 10px', borderRadius: 6, background: t.inputBg, color: t.textPrimary, fontSize: 11, overflowX: 'auto' }}>{errorView.command}</code>}
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, color: t.textMuted, font: `11px/1.5 ${t.font}` }}>{errorView.nextActions.map((action) => <li key={action}>{action}</li>)}</ul>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '13px 22px', borderTop: `1px solid ${t.cellBorder}` }}>
        <div style={{ display: 'flex', gap: 8 }}>
          {stage === 'connect' && <button onClick={onBack} style={secondaryButton(t)}>Back</button>}
          {stage !== 'building' && <button onClick={onClose} style={secondaryButton(t)}>Save & close</button>}
          {stage === 'building' && job && <button onClick={() => void cancelJob()} style={secondaryButton(t)}>Cancel job</button>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {stage === 'connect' && errorView?.code === 'DBT_MANIFEST_MISSING' && <button disabled={loading} onClick={() => void buildSnapshot(true)} style={secondaryButton(t)}>Build artifacts with DQL</button>}
          {stage === 'connect' && <button disabled={loading || !projectDir.trim()} onClick={() => void inspect()} style={primaryButton(t, loading || !projectDir.trim())}>{loading ? 'Inspecting…' : errorView?.code === 'DBT_MANIFEST_MISSING' ? 'I ran dbt parse — retry' : 'Inspect artifacts'}</button>}
          {stage === 'inspect' && <button disabled={loading} onClick={() => void buildSnapshot(false)} style={primaryButton(t, loading)}>{loading ? 'Building…' : 'Apply & build snapshot'}</button>}
          {stage === 'domains' && !discovery && <button disabled={loading} onClick={() => { setError(null); void discoverDomains(useAi); }} style={primaryButton(t, loading)}>{loading ? 'Discovering…' : 'Retry discovery'}</button>}
          {stage === 'domains' && discovery && (domainApply?.preview?.length ?? 0) === 0 && <button disabled={loading} onClick={() => void saveDomains('preview')} style={primaryButton(t, loading)}>{loading ? 'Preparing preview…' : selectedCount > 0 ? `Review ${selectedCount} draft domain${selectedCount === 1 ? '' : 's'}` : 'Continue without domains'}</button>}
          {stage === 'domains' && discovery && (domainApply?.preview?.length ?? 0) > 0 && <button disabled={loading} onClick={() => void saveDomains('apply')} style={primaryButton(t, loading)}>{loading ? 'Applying…' : 'Apply reviewed drafts'}</button>}
          {stage === 'domain-model' && <button onClick={() => setStage('knowledge')} style={primaryButton(t)}>Continue to knowledge</button>}
          {stage === 'knowledge' && <button onClick={() => setStage('ready')} style={primaryButton(t)}>Continue</button>}
          {stage === 'ready' && <button onClick={onClose} style={secondaryButton(t)}>Done</button>}
        </div>
      </div>
    </div>
  );
}

function Section({ title, description, t, children }: { title: string; description: string; t: Theme; children: React.ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}><div><h3 style={{ margin: 0, color: t.textPrimary, font: `600 15px ${t.font}` }}>{title}</h3><p style={{ margin: '5px 0 0', color: t.textSecondary, font: `12px/1.5 ${t.font}` }}>{description}</p></div>{children}</div>;
}

function Field({ label, hint, t, children }: { label: string; hint: string; t: Theme; children: React.ReactNode }) {
  return <label style={{ display: 'block' }}><span style={{ display: 'block', marginBottom: 5, color: t.textSecondary, font: `600 11px ${t.font}` }}>{label}</span>{children}<span style={{ display: 'block', marginTop: 5, color: t.textMuted, font: `10px ${t.font}` }}>{hint}</span></label>;
}

function OwnershipCallout({ t }: { t: Theme }) {
  return <Notice t={t} title="Read-only dbt ownership" body="Models, columns, descriptions, tests, lineage, catalog types, and MetricFlow formulas stay in dbt. DQL stores sparse domains, bindings, relationship safety, contracts, skills, blocks, and evaluations." />;
}

function Notice({ title, body, t }: { title: string; body: string; t: Theme }) {
  return <div style={{ border: `1px solid ${t.cellBorder}`, background: t.inputBg, borderRadius: 8, padding: '10px 12px', marginTop: 10 }}><div style={{ color: t.textPrimary, font: `600 11px ${t.font}` }}>{title}</div><div style={{ marginTop: 3, color: t.textMuted, font: `11px/1.5 ${t.font}` }}>{body}</div></div>;
}

function CountCard({ label, value, t }: { label: string; value: number; t: Theme }) {
  return <div style={{ border: `1px solid ${t.cellBorder}`, background: t.inputBg, borderRadius: 8, padding: 12 }}><div style={{ color: t.textPrimary, font: `700 20px ${t.font}` }}>{value}</div><div style={{ color: t.textMuted, font: `11px ${t.font}`, textTransform: 'capitalize' }}>{label}</div></div>;
}

function ArtifactRow({ label, value, required = false, t }: { label: string; value: string; required?: boolean; t: Theme }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr auto', gap: 10, padding: '10px 12px', borderBottom: `1px solid ${t.cellBorder}`, color: t.textSecondary, font: `11px ${t.font}` }}><strong style={{ color: t.textPrimary }}>{label}</strong><span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</span><span>{required ? 'Required' : 'Optional'}</span></div>;
}

function Pill({ text, t, tone }: { text: string; t: Theme; tone?: 'warning' }) {
  const color = tone === 'warning' ? t.warning : t.accent;
  return <span style={{ border: `1px solid ${color}55`, color, background: `${color}0d`, borderRadius: 20, padding: '2px 7px', font: `600 9px ${t.font}` }}>{text}</span>;
}

function Checklist({ items, t }: { items: Array<[string, string]>; t: Theme }) {
  return <div style={{ display: 'grid', gap: 8 }}>{items.map(([title, body], index) => <div key={title} style={{ display: 'grid', gridTemplateColumns: '24px 1fr', gap: 10, border: `1px solid ${t.cellBorder}`, borderRadius: 8, padding: 11 }}><span style={{ width: 22, height: 22, display: 'grid', placeItems: 'center', borderRadius: '50%', background: `${t.accent}18`, color: t.accent, font: `600 10px ${t.font}` }}>{index + 1}</span><div><strong style={{ color: t.textPrimary, font: `600 12px ${t.font}` }}>{title}</strong><div style={{ marginTop: 2, color: t.textMuted, font: `11px/1.45 ${t.font}` }}>{body}</div></div></div>)}</div>;
}

function StartCard({ title, body, action, onClick, t }: { title: string; body: string; action: string; onClick: () => void; t: Theme }) {
  return <div style={{ display: 'flex', flexDirection: 'column', minHeight: 145, border: `1px solid ${t.cellBorder}`, borderRadius: 9, padding: 13 }}><strong style={{ color: t.textPrimary, font: `600 13px ${t.font}` }}>{title}</strong><div style={{ flex: 1, marginTop: 6, color: t.textMuted, font: `11px/1.5 ${t.font}` }}>{body}</div><button onClick={onClick} style={{ ...primaryButton(t), width: '100%', marginTop: 12 }}>{action}</button></div>;
}

function primaryButton(t: Theme, disabled = false): React.CSSProperties {
  return { border: `1px solid ${t.accent}`, background: t.accent, color: '#fff', borderRadius: 7, padding: '8px 14px', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1, font: `600 12px ${t.font}` };
}

function secondaryButton(t: Theme): React.CSSProperties {
  return { border: `1px solid ${t.cellBorder}`, background: t.btnBg, color: t.textSecondary, borderRadius: 7, padding: '8px 13px', cursor: 'pointer', font: `500 12px ${t.font}` };
}
