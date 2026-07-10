// Spec 17 (part B) — Domains authoring & management.
//
// A "domain" is the top of the domain→term→block hierarchy: a first-class
// business area (e.g. "Revenue", "Customer", "Marketing") that owns terms,
// skills, and blocks. This page lets users author domains without touching
// raw files, and surfaces rollup counts of the blocks/skills/terms inside each.
//
// The page calls the shared Domains CRUD contract via `api.*`. The endpoints
// may not exist in every build — every load/save path degrades gracefully to an
// inline message and never crashes. The style mirrors the Skills page so the
// two read as a pair.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  Boxes,
  Plus,
  Pencil,
  Trash2,
  X,
  Loader2,
  AlertTriangle,
  RefreshCw,
  Blocks as BlocksIcon,
  GraduationCap,
  Tags,
  UserRound,
  Sparkles,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { api, type ContextBootstrapCandidate, type ContextBootstrapSession } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import { themes, type Theme } from '../../themes/notebook-theme';
import type { Domain } from '../../store/types';

type FormMode = { kind: 'create' } | { kind: 'edit'; domain: Domain };
const BOOTSTRAP_SESSION_KEY = 'dql-context-bootstrap-session';
const BOOTSTRAP_SELECTION_KEY = 'dql-context-bootstrap-selection';

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function emptyDraft(): Domain {
  return {
    id: '',
    name: '',
    owner: '',
    boundedContext: '',
    sourceSystems: [],
    description: '',
  };
}

export function DomainsPage({ embedded = false }: { embedded?: boolean } = {}): JSX.Element {
  const { state } = useNotebook();
  const t = themes[state.themeMode];

  const [domains, setDomains] = useState<Domain[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormMode | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Domain | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [bootstrap, setBootstrap] = useState<ContextBootstrapSession | null>(null);
  const [bootstrapLoading, setBootstrapLoading] = useState(false);
  const [bootstrapSaving, setBootstrapSaving] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapSelected, setBootstrapSelected] = useState<string[]>([]);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void api
      .getDomains()
      .then((res) => {
        if (cancelled) return;
        setDomains(Array.isArray(res?.domains) ? res.domains : []);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setDomains([]);
        setLoadError(
          error instanceof Error && error.message
            ? error.message
            : 'Could not load domains. Is the local DQL server running?',
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => load(), [load]);

  // A repository draft is local-only until save, but it must survive a reload
  // or a user moving between pages while AI is still working.
  useEffect(() => {
    const id = window.sessionStorage.getItem(BOOTSTRAP_SESSION_KEY);
    let cancelled = false;
    const applySession = (session: ContextBootstrapSession | null) => {
      if (!session) return;
      if (cancelled) return;
      setBootstrap(session);
      try {
        const saved = JSON.parse(window.sessionStorage.getItem(BOOTSTRAP_SELECTION_KEY) ?? '[]');
        setBootstrapSelected(Array.isArray(saved) ? saved.filter((value): value is string => typeof value === 'string') : session.candidates.filter((candidate) => candidate.action !== 'unchanged').map((candidate) => candidate.id));
      } catch {
        setBootstrapSelected(session.candidates.filter((candidate) => candidate.action !== 'unchanged').map((candidate) => candidate.id));
      }
    };
    const restore = id ? api.getContextBootstrap(id) : api.getLatestContextBootstrap();
    void restore.then(applySession).catch(async () => {
      window.sessionStorage.removeItem(BOOTSTRAP_SESSION_KEY);
      window.sessionStorage.removeItem(BOOTSTRAP_SELECTION_KEY);
      if (id) applySession(await api.getLatestContextBootstrap().catch(() => null));
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!bootstrap) return;
    window.sessionStorage.setItem(BOOTSTRAP_SESSION_KEY, bootstrap.id);
    window.sessionStorage.setItem(BOOTSTRAP_SELECTION_KEY, JSON.stringify(bootstrapSelected));
  }, [bootstrap?.id, bootstrapSelected]);

  const sorted = useMemo(() => [...domains].sort((a, b) => a.name.localeCompare(b.name)), [domains]);

  const handleSaved = useCallback((saved: Domain) => {
    setDomains((prev) => {
      const idx = prev.findIndex((d) => d.id === saved.id);
      if (idx === -1) return [...prev, saved];
      const next = [...prev];
      next[idx] = saved;
      return next;
    });
    setForm(null);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteDomain(pendingDelete.id);
      setDomains((prev) => prev.filter((d) => d.id !== pendingDelete.id));
      setPendingDelete(null);
    } catch (error) {
      setDeleteError(error instanceof Error && error.message ? error.message : 'Could not delete this domain.');
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete]);

  const startBootstrap = useCallback(async () => {
    setBootstrapLoading(true);
    setBootstrapError(null);
    try {
      const session = await api.startContextBootstrap({ ai: true });
      setBootstrap(session);
      const selected = session.candidates.filter((candidate) => candidate.action !== 'unchanged').map((candidate) => candidate.id);
      setBootstrapSelected(selected);
      window.sessionStorage.setItem(BOOTSTRAP_SESSION_KEY, session.id);
      window.sessionStorage.setItem(BOOTSTRAP_SELECTION_KEY, JSON.stringify(selected));
    } catch (error) {
      setBootstrapError(error instanceof Error ? error.message : 'Could not draft repository context.');
    } finally {
      setBootstrapLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!embedded) return;
    const onBuild = () => { void startBootstrap(); };
    window.addEventListener('dql:context-build', onBuild);
    return () => window.removeEventListener('dql:context-build', onBuild);
  }, [embedded, startBootstrap]);

  useEffect(() => {
    if (!bootstrap || ['ready', 'needs_attention'].includes(bootstrap.status)) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await api.getContextBootstrap(bootstrap.id);
        if (!cancelled) setBootstrap(next);
      } catch (error) {
        if (!cancelled) setBootstrapError(error instanceof Error ? error.message : 'Could not update AI draft progress.');
      }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), 750);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [bootstrap?.id, bootstrap?.status]);

  const saveBootstrap = useCallback(async () => {
    if (!bootstrap || bootstrapSelected.length === 0) return;
    setBootstrapSaving(true);
    setBootstrapError(null);
    try {
      await api.saveContextBootstrapSelected(bootstrap.id, bootstrapSelected);
      setBootstrap(null);
      setBootstrapSelected([]);
      window.sessionStorage.removeItem(BOOTSTRAP_SESSION_KEY);
      window.sessionStorage.removeItem(BOOTSTRAP_SELECTION_KEY);
      load();
    } catch (error) {
      setBootstrapError(error instanceof Error ? error.message : 'Could not save selected drafts.');
    } finally {
      setBootstrapSaving(false);
    }
  }, [bootstrap, bootstrapSelected, load]);

  return (
    <div style={{ flex: 1, minWidth: 0, overflow: 'auto', background: t.appBg }}>
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '22px 28px 40px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 18, marginBottom: 18 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <Boxes size={20} strokeWidth={1.9} color={t.accent} />
              <div style={{ fontSize: 22, fontWeight: 700, color: t.textPrimary }}>Domains</div>
            </div>
            <div style={{ fontSize: 13, color: t.textMuted, marginTop: 6, maxWidth: 680, lineHeight: 1.5 }}>
              Domains are the top of your business model — each one owns the terms, skills, and blocks beneath it. Name
              the business area, who owns it, the bounded context, and the source systems it draws from.
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <button type="button" onClick={() => load()} title="Refresh" style={ghostButton(t)}>
              <RefreshCw size={13} strokeWidth={2} /> Refresh
            </button>
            <button type="button" onClick={() => void startBootstrap()} disabled={bootstrapLoading} style={ghostButton(t)}>
              {bootstrapLoading ? <Loader2 size={13} strokeWidth={2} /> : <Sparkles size={13} strokeWidth={2} />} Draft with AI
            </button>
            <button type="button" onClick={() => setForm({ kind: 'create' })} style={primaryButton(t)}>
              <Plus size={14} strokeWidth={2.2} /> Add domain
            </button>
          </div>
        </div>

        {/* Body states */}
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: t.textMuted, fontSize: 13, padding: '40px 0' }}>
            <Loader2 size={15} strokeWidth={2} /> Loading domains…
          </div>
        ) : loadError ? (
          <ErrorPanel t={t} message={loadError} onRetry={() => load()} />
        ) : sorted.length === 0 ? (
          <EmptyState t={t} onAdd={() => setForm({ kind: 'create' })} />
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {sorted.map((domain) => (
              <DomainRow
                key={domain.id}
                domain={domain}
                t={t}
                onEdit={() => setForm({ kind: 'edit', domain })}
                onDelete={() => {
                  setDeleteError(null);
                  setPendingDelete(domain);
                }}
              />
            ))}
          </div>
        )}

        {bootstrapError ? <div style={{ marginTop: 12 }}><InlineNote t={t} tone="error">{bootstrapError}</InlineNote></div> : null}
        {bootstrap ? (
          <section style={{ marginTop: 18, border: `1px solid ${t.cellBorder}`, borderRadius: 10, background: t.cellBg, padding: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 750, color: t.textPrimary }}>Repository-guided AI draft</div>
                <div style={{ fontSize: 12, color: t.textMuted, marginTop: 3 }}>Inventory is deterministic; AI may enrich only grounded prose and guidance. Nothing is written to Git until you save.</div>
              </div>
              <button type="button" disabled={bootstrapSaving || bootstrapSelected.length === 0 || !['ready', 'needs_attention'].includes(bootstrap.status)} onClick={() => void saveBootstrap()} style={{ ...primaryButton(t), opacity: bootstrapSaving || bootstrapSelected.length === 0 || !['ready', 'needs_attention'].includes(bootstrap.status) ? 0.55 : 1 }}>
                {bootstrapSaving ? <Loader2 size={13} strokeWidth={2} /> : <Plus size={13} strokeWidth={2} />} Save selected drafts
              </button>
            </div>
            <BootstrapProgress t={t} session={bootstrap} />
            <div style={{ display: 'grid', gap: 9, marginTop: 12 }}>
              {bootstrap.candidates.map((candidate) => {
                const selectable = candidate.action !== 'unchanged';
                const selected = bootstrapSelected.includes(candidate.id);
                return <BootstrapCandidateCard key={candidate.id} candidate={candidate} selected={selected} selectable={selectable} disabled={bootstrapSaving} t={t} onToggle={() => setBootstrapSelected((current) => selected ? current.filter((id) => id !== candidate.id) : [...current, candidate.id])} />;
              })}
            </div>
          </section>
        ) : null}
      </div>

      {/* Add / Edit drawer */}
      {form ? (
        <DomainFormDrawer
          mode={form}
          existingIds={domains.map((d) => d.id)}
          domains={domains}
          t={t}
          onClose={() => setForm(null)}
          onSaved={handleSaved}
        />
      ) : null}

      {/* Delete confirm */}
      {pendingDelete ? (
        <ConfirmDeleteDialog
          domain={pendingDelete}
          t={t}
          deleting={deleting}
          error={deleteError}
          onCancel={() => {
            if (!deleting) setPendingDelete(null);
          }}
          onConfirm={confirmDelete}
        />
      ) : null}
    </div>
  );
}

// ── List row ─────────────────────────────────────────────────────────────────

function DomainRow({
  domain,
  t,
  onEdit,
  onDelete,
}: {
  domain: Domain;
  t: Theme;
  onEdit: () => void;
  onDelete: () => void;
}): JSX.Element {
  const sources = domain.sourceSystems ?? [];
  const [expanded, setExpanded] = useState(false);
  return (
    <section
      style={{
        border: `1px solid ${t.cellBorder}`,
        borderRadius: 10,
        background: t.cellBg,
        padding: '13px 15px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 14,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13.5, fontWeight: 750, color: t.textPrimary }}>{domain.name}</span>
          {domain.parent ? <span style={contextBadge(t)}>↳ {domain.parent}</span> : null}
          {domain.owner ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: t.textMuted }}>
              <UserRound size={11} strokeWidth={2} /> {domain.owner}
            </span>
          ) : null}
          {domain.businessOwner ? <span style={contextBadge(t)}><UserRound size={10} strokeWidth={2.2} /> Business owner: {domain.businessOwner}</span> : null}
        </div>
        {domain.description ? (
          <div style={{ fontSize: 12.5, color: t.textSecondary, marginTop: 5, lineHeight: 1.5 }}>{domain.description}</div>
        ) : (
          <div style={{ fontSize: 12, color: t.textMuted, marginTop: 5, fontStyle: 'italic' }}>No description yet.</div>
        )}
        {sources.length > 0 ? (
          <div style={{ display: 'flex', gap: 5, marginTop: 9, flexWrap: 'wrap' }}>
            {sources.map((source) => (
              <span key={source} style={sourceChip(t)}>{source}</span>
            ))}
          </div>
        ) : null}
        <div style={{ display: 'flex', gap: 7, marginTop: 9, flexWrap: 'wrap' }}>
          <CountPill t={t} icon={<BlocksIcon size={11} strokeWidth={2} />} label="blocks" count={domain.blockCount ?? 0} />
          <CountPill t={t} icon={<GraduationCap size={11} strokeWidth={2} />} label="skills" count={domain.skillCount ?? 0} />
          <CountPill t={t} icon={<Tags size={11} strokeWidth={2} />} label="terms" count={domain.termCount ?? 0} />
        </div>
        {expanded ? <div style={{ display: 'grid', gap: 9, marginTop: 12, paddingTop: 11, borderTop: `1px solid ${t.btnBorder}` }}>
          {domain.boundedContext ? <ReadableField t={t} label="Business boundary">{domain.boundedContext}</ReadableField> : null}
          {domain.businessOutcome ? <ReadableField t={t} label="Decision outcome">{domain.businessOutcome}</ReadableField> : null}
          <ReadableChipField t={t} label="In scope" values={domain.inScope} empty="Not defined yet" />
          <ReadableChipField t={t} label="Out of scope" values={domain.outOfScope} empty="Not defined yet" />
          <ReadableChipField t={t} label="Primary terms" values={domain.primaryTerms} empty="No terms linked yet" />
          <ReadableChipField t={t} label="Tags" values={domain.tags} empty="No tags" />
        </div> : null}
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        <button type="button" onClick={() => setExpanded((value) => !value)} style={{ ...ghostButton(t), padding: '5px 7px', fontSize: 11.5 }} title={expanded ? 'Hide domain details' : 'Show domain details'}>{expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}{expanded ? 'Less' : 'Details'}</button>
        <button type="button" onClick={onEdit} style={iconButton(t)} title="Edit domain">
          <Pencil size={13} strokeWidth={2} />
        </button>
        <button type="button" onClick={onDelete} style={iconButton(t)} title="Delete domain">
          <Trash2 size={13} strokeWidth={2} />
        </button>
      </div>
    </section>
  );
}

// ── Form drawer (add / edit) ─────────────────────────────────────────────────

function DomainFormDrawer({
  mode,
  existingIds,
  domains,
  t,
  onClose,
  onSaved,
}: {
  mode: FormMode;
  existingIds: string[];
  domains: Domain[];
  t: Theme;
  onClose: () => void;
  onSaved: (domain: Domain) => void;
}): JSX.Element {
  const editing = mode.kind === 'edit';
  const [draft, setDraft] = useState<Domain>(() => (mode.kind === 'edit' ? { ...mode.domain } : emptyDraft()));
  // Track whether the user took control of the id slug so name→slug auto-fill
  // stops once they edit it directly (create only).
  const [idTouched, setIdTouched] = useState(editing);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = useCallback(<K extends keyof Domain>(key: K, value: Domain[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  const onNameChange = (value: string) => {
    setDraft((prev) => ({
      ...prev,
      name: value,
      ...(!editing && !idTouched ? { id: slugify(value) } : {}),
    }));
  };

  const idCollision = !editing && draft.id.length > 0 && existingIds.includes(draft.id);
  const canSave = draft.id.trim().length > 0 && draft.name.trim().length > 0 && !idCollision && !saving;

  const onSave = useCallback(async () => {
    const payload: Domain = {
      ...draft,
      id: draft.id.trim(),
      name: draft.name.trim(),
      owner: draft.owner?.trim() ? draft.owner.trim() : undefined,
      businessOwner: draft.businessOwner?.trim() ? draft.businessOwner.trim() : undefined,
      parent: draft.parent?.trim() ? draft.parent.trim() : undefined,
      boundedContext: draft.boundedContext?.trim() ? draft.boundedContext.trim() : undefined,
      description: draft.description?.trim() ? draft.description.trim() : undefined,
      sourceSystems: (draft.sourceSystems ?? []).map((s) => s.trim()).filter(Boolean),
      primaryTerms: (draft.primaryTerms ?? []).map((s) => s.trim()).filter(Boolean),
      tags: (draft.tags ?? []).map((s) => s.trim()).filter(Boolean),
      inScope: (draft.inScope ?? []).map((s) => s.trim()).filter(Boolean),
      outOfScope: (draft.outOfScope ?? []).map((s) => s.trim()).filter(Boolean),
      dbtGroups: (draft.dbtGroups ?? []).map((s) => s.trim()).filter(Boolean),
      dbtPaths: (draft.dbtPaths ?? []).map((s) => s.trim()).filter(Boolean),
      dbtTags: (draft.dbtTags ?? []).map((s) => s.trim()).filter(Boolean),
      semanticDomains: (draft.semanticDomains ?? []).map((s) => s.trim()).filter(Boolean),
      semanticTags: (draft.semanticTags ?? []).map((s) => s.trim()).filter(Boolean),
    };
    setSaving(true);
    setError(null);
    try {
      const res = editing ? await api.updateDomain(payload.id, payload) : await api.createDomain(payload);
      onSaved(res.domain ?? payload);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not save this domain. Try again.');
    } finally {
      setSaving(false);
    }
  }, [draft, editing, onSaved]);

  return (
    <div style={drawerScrim} onClick={() => !saving && onClose()}>
      <div style={drawerPanel(t)} onClick={(e) => e.stopPropagation()}>
        {/* Drawer header */}
        <div style={drawerHeader(t)}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Boxes size={16} strokeWidth={2} color={t.accent} />
            <div style={{ fontSize: 15, fontWeight: 700, color: t.textPrimary }}>
              {editing ? 'Edit domain' : 'New domain'}
            </div>
          </div>
          <button type="button" onClick={() => !saving && onClose()} style={iconButton(t)} title="Close">
            <X size={15} strokeWidth={2} />
          </button>
        </div>

        {/* Drawer body */}
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '16px 18px', display: 'grid', gap: 16 }}>
          {/* Name + id */}
          <Field label="Name" t={t} hint={editing ? undefined : 'A short, human label for this business area.'}>
            <input
              type="text"
              value={draft.name}
              onChange={(e) => onNameChange(e.target.value)}
              placeholder="Revenue"
              style={inputStyle(t)}
            />
          </Field>
          <Field label="ID (slug)" t={t} hint="Used as the on-disk identifier. Letters, numbers, and dashes.">
            <input
              type="text"
              value={draft.id}
              disabled={editing}
              onChange={(e) => {
                setIdTouched(true);
                set('id', slugify(e.target.value));
              }}
              placeholder="revenue"
              style={{ ...inputStyle(t), fontFamily: t.fontMono, opacity: editing ? 0.7 : 1 }}
            />
            {idCollision ? <InlineNote t={t} tone="error">A domain with this id already exists.</InlineNote> : null}
          </Field>

          <Field label="Parent domain" t={t} hint="Optional. Depth becomes Domain, Subdomain, Microdomain, and beyond.">
            <select value={draft.parent ?? ''} onChange={(e) => set('parent', e.target.value || undefined)} style={inputStyle(t)}>
              <option value="">Top-level domain</option>
              {domains.filter((domain) => domain.id !== draft.id).map((domain) => (
                <option key={domain.id} value={domain.id}>{domain.name}</option>
              ))}
            </select>
          </Field>

          {/* Owner */}
          <Field label="Owner" t={t} hint="The team or person accountable for this domain.">
            <input
              type="text"
              value={draft.owner ?? ''}
              onChange={(e) => set('owner', e.target.value)}
              placeholder="finance-analytics"
              style={inputStyle(t)}
            />
          </Field>

          <Field label="Business owner" t={t} hint="The stakeholder accountable for business use and definitions.">
            <input type="text" value={draft.businessOwner ?? ''} onChange={(e) => set('businessOwner', e.target.value)} placeholder="Revenue Operations" style={inputStyle(t)} />
          </Field>

          {/* Bounded context */}
          <Field label="Bounded context" t={t} hint="The conceptual boundary this domain owns, e.g. 'recognized revenue and invoicing'.">
            <input
              type="text"
              value={draft.boundedContext ?? ''}
              onChange={(e) => set('boundedContext', e.target.value)}
              placeholder="Recognized revenue and invoicing"
              style={inputStyle(t)}
            />
          </Field>

          {/* Source systems */}
          <Field label="Source systems" t={t} hint="The upstream systems this domain draws from — type a name and press Enter.">
            <TagInput
              t={t}
              values={draft.sourceSystems ?? []}
              onChange={(next) => set('sourceSystems', next)}
              placeholder="Add a source system…"
            />
          </Field>

          <Field label="Primary terms" t={t} hint="Business concepts the agent should use to recognize this domain.">
            <TagInput t={t} values={draft.primaryTerms ?? []} onChange={(next) => set('primaryTerms', next)} placeholder="Add a term…" />
          </Field>

          <Field label="Scope tags" t={t} hint="Short labels used for routing and discovery.">
            <TagInput t={t} values={draft.tags ?? []} onChange={(next) => set('tags', next)} placeholder="Add a tag…" />
          </Field>

          {/* Description */}
          <Field label="Description" t={t} hint="What this domain covers and how it's used.">
            <textarea
              value={draft.description ?? ''}
              onChange={(e) => set('description', e.target.value)}
              rows={5}
              placeholder="All recognized-revenue metrics and the blocks that report them, sourced from the billing warehouse."
              style={textareaStyle(t)}
            />
          </Field>

          {error ? <InlineNote t={t} tone="error">{error}</InlineNote> : null}
        </div>

        {/* Drawer footer */}
        <div style={drawerFooter(t)}>
          <button type="button" onClick={() => !saving && onClose()} style={ghostButton(t)}>
            Cancel
          </button>
          <button type="button" onClick={onSave} disabled={!canSave} style={{ ...primaryButton(t), opacity: canSave ? 1 : 0.55 }}>
            {saving ? <Loader2 size={13} strokeWidth={2} /> : null}
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create domain'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Tag input (source systems) ───────────────────────────────────────────────

function TagInput({
  t,
  values,
  onChange,
  placeholder,
}: {
  t: Theme;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const add = (value: string) => {
    const v = value.trim();
    if (!v || values.includes(v)) return;
    onChange([...values, v]);
    setQuery('');
  };
  return (
    <div style={{ display: 'grid', gap: 7 }}>
      {values.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {values.map((value) => (
            <span key={value} style={selectedChip(t)}>
              {value}
              <button
                type="button"
                onClick={() => onChange(values.filter((s) => s !== value))}
                style={chipRemoveButton(t)}
                title="Remove"
              >
                <X size={11} strokeWidth={2.4} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add(query);
          }
        }}
        placeholder={placeholder}
        style={inputStyle(t)}
      />
    </div>
  );
}

// ── Empty / error states ─────────────────────────────────────────────────────

function EmptyState({ t, onAdd }: { t: Theme; onAdd: () => void }): JSX.Element {
  return (
    <div
      style={{
        border: `1px dashed ${t.cellBorder}`,
        borderRadius: 12,
        background: t.cellBg,
        padding: '34px 28px',
        textAlign: 'center',
        display: 'grid',
        gap: 12,
        justifyItems: 'center',
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 10,
          background: `${t.accent}18`,
          color: t.accent,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Boxes size={22} strokeWidth={1.9} />
      </div>
      <div style={{ fontSize: 15, fontWeight: 700, color: t.textPrimary }}>Name your business domains</div>
      <div style={{ fontSize: 13, color: t.textMuted, maxWidth: 460, lineHeight: 1.55 }}>
        Domains organize everything below them — terms, skills, and blocks. Add your first one, like "Revenue" or
        "Customer", and you'll be able to pick it when authoring blocks and skills.
      </div>
      <button type="button" onClick={onAdd} style={{ ...primaryButton(t), marginTop: 4 }}>
        <Plus size={14} strokeWidth={2.2} /> Add your first domain
      </button>
    </div>
  );
}

function ErrorPanel({ t, message, onRetry }: { t: Theme; message: string; onRetry: () => void }): JSX.Element {
  return (
    <div
      style={{
        border: `1px solid ${t.warning}55`,
        borderRadius: 10,
        background: `${t.warning}12`,
        padding: '16px 18px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 11,
      }}
    >
      <AlertTriangle size={16} strokeWidth={2} color={t.warning} style={{ marginTop: 1, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 650, color: t.textPrimary }}>Domains are not available right now</div>
        <div style={{ fontSize: 12.5, color: t.textSecondary, marginTop: 4, lineHeight: 1.5 }}>{message}</div>
        <button type="button" onClick={onRetry} style={{ ...ghostButton(t), marginTop: 10 }}>
          <RefreshCw size={13} strokeWidth={2} /> Retry
        </button>
      </div>
    </div>
  );
}

function BootstrapProgress({ t, session }: { t: Theme; session: ContextBootstrapSession }): JSX.Element {
  const active = !['ready', 'needs_attention'].includes(session.status);
  const mode = session.ai.mode === 'evidence_only'
    ? 'Evidence-only'
    : session.ai.provider
      ? `${session.ai.provider} grounded`
      : 'Preparing AI';
  return (
    <div style={{ marginTop: 14, padding: '10px 11px', borderRadius: 8, background: t.appBg, border: `1px solid ${t.btnBorder}` }}>
      <div style={{ display: 'flex', gap: 9, alignItems: 'center', flexWrap: 'wrap', fontSize: 12, color: t.textSecondary }}>
        {active ? <Loader2 size={14} strokeWidth={2} color={t.accent} /> : <Sparkles size={14} strokeWidth={2} color={t.accent} />}
        <strong style={{ color: t.textPrimary, textTransform: 'capitalize' }}>{session.status.replace('_', ' ')}</strong>
        <span>{mode}</span>
        <span>{session.progress.domains.ready}/{session.progress.domains.total} domains</span>
        <span>{session.progress.skills.ready}/{session.progress.skills.total} skills</span>
      </div>
      <div style={{ height: 5, borderRadius: 999, background: t.btnBg, overflow: 'hidden', marginTop: 9 }}>
        <div style={{ width: `${Math.max(3, Math.min(100, session.progress.percent))}%`, height: '100%', background: t.accent, transition: 'width 260ms ease' }} />
      </div>
      <div style={{ marginTop: 7, fontSize: 11.5, color: t.textMuted, lineHeight: 1.45 }}>{session.progress.message}</div>
      {session.warnings?.length ? <div style={{ marginTop: 7, fontSize: 11.5, color: t.warning, lineHeight: 1.45 }}>{session.warnings.slice(-2).join(' ')}</div> : null}
    </div>
  );
}

function BootstrapCandidateCard({ candidate, selected, selectable, disabled, t, onToggle }: {
  candidate: ContextBootstrapCandidate;
  selected: boolean;
  selectable: boolean;
  disabled: boolean;
  t: Theme;
  onToggle: () => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const isDomain = candidate.kind === 'domain';
  const title = candidate.domain?.name ?? candidate.skill?.id ?? candidate.id.replace(/^(domain|skill):/, '');
  const summary = isDomain
    ? candidate.domain?.description ?? candidate.domain?.boundedContext
    : candidate.skill?.description ?? candidate.skill?.body?.split('\n').find(Boolean);
  const details = isDomain
    ? [
        ['Business outcome', candidate.domain?.businessOutcome],
        ['In scope', candidate.domain?.inScope?.join(' · ')],
        ['Out of scope', candidate.domain?.outOfScope?.join(' · ')],
        ['Primary terms', candidate.domain?.primaryTerms?.join(' · ')],
      ]
    : [
        ['Applies when', candidate.skill?.triggers?.join(' · ')],
        ['Ask first when', candidate.skill?.clarifyWhen?.join(' · ')],
        ['Avoid when', candidate.skill?.exclusions?.join(' · ')],
        ['Preferred metrics', candidate.skill?.preferredMetrics?.join(' · ')],
        ['Preferred blocks', candidate.skill?.preferredBlocks?.join(' · ')],
      ];
  return <article style={{ border: `1px solid ${selected ? `${t.accent}66` : t.btnBorder}`, background: selected ? `${t.accent}08` : t.appBg, borderRadius: 8, padding: '10px 11px', opacity: selectable ? 1 : 0.72 }}>
    <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
      <input aria-label={`Select ${isDomain ? 'domain' : 'skill'} ${title}`} type="checkbox" disabled={!selectable || disabled} checked={selected} onChange={onToggle} style={{ marginTop: 3 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong style={{ color: t.textPrimary, fontSize: 12.5 }}>{isDomain ? 'Domain' : 'Skill'} · {title}</strong>
          <span style={contextBadge(t)}>{candidate.action.replace('_', ' ')}</span>
          <span style={{ fontSize: 11, color: t.textMuted }}>{Math.round(candidate.confidence * 100)}% evidence confidence</span>
        </div>
        {summary ? <p style={{ marginTop: 5, color: t.textSecondary, fontSize: 12, lineHeight: 1.45 }}>{summary}</p> : <p style={{ marginTop: 5, color: t.textMuted, fontSize: 12, fontStyle: 'italic' }}>Waiting for grounded guidance…</p>}
        <div style={{ display: 'flex', gap: 5, marginTop: 7, flexWrap: 'wrap' }}>{candidate.evidence.map((item) => <span key={item} style={sourceChip(t)}>{item}</span>)}</div>
        {expanded ? <div style={{ marginTop: 9, display: 'grid', gap: 6, borderTop: `1px solid ${t.btnBorder}`, paddingTop: 9 }}>
          {details.filter(([, value]) => Boolean(value)).map(([label, value]) => <div key={label} style={{ display: 'grid', gridTemplateColumns: '116px minmax(0, 1fr)', gap: 8, fontSize: 11.5, lineHeight: 1.45 }}><strong style={{ color: t.textMuted }}>{label}</strong><span style={{ color: t.textSecondary }}>{value}</span></div>)}
          {!isDomain && candidate.skill?.body ? <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: t.font, fontSize: 11.5, color: t.textSecondary, background: t.cellBg, padding: 9, borderRadius: 6, maxHeight: 180, overflow: 'auto' }}>{candidate.skill.body}</pre> : null}
          {candidate.notes?.length ? <div style={{ fontSize: 11.5, color: t.accent }}>{candidate.notes.join(' ')}</div> : null}
        </div> : null}
      </div>
      <button type="button" onClick={() => setExpanded((value) => !value)} style={{ ...ghostButton(t), padding: '4px 6px', fontSize: 11.5 }} aria-expanded={expanded}>{expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}{expanded ? 'Less' : 'Review'}</button>
    </div>
  </article>;
}

// ── Delete confirm dialog ────────────────────────────────────────────────────

function ConfirmDeleteDialog({
  domain,
  t,
  deleting,
  error,
  onCancel,
  onConfirm,
}: {
  domain: Domain;
  t: Theme;
  deleting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  return (
    <div style={modalScrim} onClick={onCancel}>
      <div style={modalCard(t)} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <Trash2 size={16} strokeWidth={2} color={t.error} />
          <div style={{ fontSize: 15, fontWeight: 700, color: t.textPrimary }}>Delete this domain?</div>
        </div>
        <div style={{ fontSize: 13, color: t.textSecondary, lineHeight: 1.55 }}>
          <span style={{ fontWeight: 700, color: t.textPrimary }}>{domain.name}</span> will be removed. Blocks, skills,
          and terms that referenced it will become unassigned. This can't be undone.
        </div>
        {error ? <InlineNote t={t} tone="error">{error}</InlineNote> : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button type="button" onClick={onCancel} disabled={deleting} style={ghostButton(t)}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={deleting} style={{ ...dangerButton(t), opacity: deleting ? 0.6 : 1 }}>
            {deleting ? <Loader2 size={13} strokeWidth={2} /> : <Trash2 size={13} strokeWidth={2} />}
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Small shared pieces ──────────────────────────────────────────────────────

function CountPill({ t, icon, label, count }: { t: Theme; icon: React.ReactNode; label: string; count: number }): JSX.Element {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 11,
        fontWeight: 600,
        color: count > 0 ? t.textSecondary : t.textMuted,
        background: t.btnBg,
        border: `1px solid ${t.btnBorder}`,
        borderRadius: 6,
        padding: '3px 8px',
      }}
    >
      {icon}
      {count} {label}
    </span>
  );
}

function ReadableField({ t, label, children }: { t: Theme; label: string; children: React.ReactNode }): JSX.Element {
  return <div style={{ display: 'grid', gridTemplateColumns: '118px minmax(0, 1fr)', gap: 10, fontSize: 12, lineHeight: 1.5 }}><strong style={{ color: t.textMuted }}>{label}</strong><span style={{ color: t.textSecondary }}>{children}</span></div>;
}

function ReadableChipField({ t, label, values, empty }: { t: Theme; label: string; values?: string[]; empty: string }): JSX.Element {
  return <div style={{ display: 'grid', gridTemplateColumns: '118px minmax(0, 1fr)', gap: 10, fontSize: 12, lineHeight: 1.5 }}><strong style={{ color: t.textMuted }}>{label}</strong><div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>{values?.length ? values.map((value) => <span key={value} style={sourceChip(t)}>{value}</span>) : <span style={{ color: t.textMuted, fontStyle: 'italic' }}>{empty}</span>}</div></div>;
}

function Field({
  label,
  hint,
  t,
  children,
}: {
  label: string;
  hint?: string;
  t: Theme;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <label style={{ fontSize: 12, fontWeight: 700, color: t.textPrimary }}>{label}</label>
      {hint ? <div style={{ fontSize: 11.5, color: t.textMuted, lineHeight: 1.45, marginTop: -2 }}>{hint}</div> : null}
      {children}
    </div>
  );
}

function InlineNote({ t, tone, children }: { t: Theme; tone: 'error' | 'muted'; children: React.ReactNode }): JSX.Element {
  const color = tone === 'error' ? t.error : t.textMuted;
  return <div style={{ fontSize: 11.5, color, lineHeight: 1.45 }}>{children}</div>;
}

// ── Styles (mirrors SkillsPage) ──────────────────────────────────────────────

function primaryButton(t: Theme): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '7px 13px',
    borderRadius: 7,
    border: `1px solid ${t.accent}`,
    background: t.accent,
    color: '#ffffff',
    fontSize: 12.5,
    fontWeight: 700,
    fontFamily: t.font,
    cursor: 'pointer',
  };
}

function ghostButton(t: Theme): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '7px 11px',
    borderRadius: 7,
    border: `1px solid ${t.btnBorder}`,
    background: t.btnBg,
    color: t.textSecondary,
    fontSize: 12,
    fontWeight: 600,
    fontFamily: t.font,
    cursor: 'pointer',
  };
}

function dangerButton(t: Theme): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '7px 13px',
    borderRadius: 7,
    border: `1px solid ${t.error}`,
    background: t.error,
    color: '#ffffff',
    fontSize: 12.5,
    fontWeight: 700,
    fontFamily: t.font,
    cursor: 'pointer',
  };
}

function iconButton(t: Theme): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 30,
    height: 30,
    borderRadius: 7,
    border: `1px solid ${t.btnBorder}`,
    background: t.btnBg,
    color: t.textSecondary,
    cursor: 'pointer',
    flexShrink: 0,
  };
}

function inputStyle(t: Theme): CSSProperties {
  return {
    width: '100%',
    border: `1px solid ${t.btnBorder}`,
    borderRadius: 7,
    background: t.cellBg,
    color: t.textPrimary,
    fontSize: 12.5,
    fontFamily: t.font,
    padding: '8px 10px',
    boxSizing: 'border-box',
  };
}

function textareaStyle(t: Theme): CSSProperties {
  return {
    ...inputStyle(t),
    resize: 'vertical',
    lineHeight: 1.5,
    padding: '9px 11px',
  };
}

function contextBadge(t: Theme): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 10.5,
    fontWeight: 700,
    color: t.accent,
    background: `${t.accent}14`,
    border: `1px solid ${t.accent}38`,
    borderRadius: 999,
    padding: '2px 8px',
  };
}

function sourceChip(t: Theme): CSSProperties {
  return {
    fontSize: 11,
    fontWeight: 600,
    color: t.textSecondary,
    background: t.btnBg,
    border: `1px solid ${t.btnBorder}`,
    borderRadius: 6,
    padding: '3px 8px',
    fontFamily: t.fontMono,
  };
}

function selectedChip(t: Theme): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 11.5,
    fontWeight: 600,
    color: t.textPrimary,
    background: `${t.accent}14`,
    border: `1px solid ${t.accent}38`,
    borderRadius: 6,
    padding: '3px 4px 3px 9px',
    fontFamily: t.fontMono,
  };
}

function chipRemoveButton(t: Theme): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: 'transparent',
    color: t.textMuted,
    cursor: 'pointer',
    padding: 2,
    borderRadius: 4,
  };
}

const drawerScrim: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.42)',
  display: 'flex',
  justifyContent: 'flex-end',
  zIndex: 60,
};

function drawerPanel(t: Theme): CSSProperties {
  return {
    width: 'min(560px, 100%)',
    height: '100%',
    background: t.appBg,
    borderLeft: `1px solid ${t.headerBorder}`,
    display: 'flex',
    flexDirection: 'column',
    boxShadow: '-8px 0 28px rgba(0,0,0,0.18)',
  };
}

function drawerHeader(t: Theme): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '14px 18px',
    borderBottom: `1px solid ${t.headerBorder}`,
    flexShrink: 0,
  };
}

function drawerFooter(t: Theme): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
    padding: '13px 18px',
    borderTop: `1px solid ${t.headerBorder}`,
    flexShrink: 0,
  };
}

const modalScrim: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.42)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 70,
  padding: 20,
};

function modalCard(t: Theme): CSSProperties {
  return {
    width: 'min(420px, 100%)',
    background: t.cellBg,
    border: `1px solid ${t.cellBorder}`,
    borderRadius: 12,
    padding: 20,
    display: 'grid',
    gap: 13,
    boxShadow: '0 18px 48px rgba(0,0,0,0.3)',
  };
}
