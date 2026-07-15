// Spec 16 — Skills authoring & management.
//
// A "skill" is a shared business-context file (`skills/*.skill.md`) the agent
// applies per question: definitions ("revenue = recognized, not bookings"),
// rules ("always exclude test accounts"), vocabulary, and preferred
// metrics/blocks. This page lets users author them without touching raw
// markdown, and tags each as Project (shared) or Personal (me).
//
// The page calls the shared Skills CRUD contract via `api.*`. The endpoints may
// not exist in every build — every load/save path degrades gracefully to an
// inline message and never crashes.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { GraduationCap, Plus, Pencil, Trash2, X, Sparkles, Loader2, AlertTriangle, RefreshCw, BookMarked, Tags, ChevronDown, ChevronUp } from 'lucide-react';
import { api } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import { themes, type Theme } from '../../themes/notebook-theme';
import type { Skill, Domain } from '../../store/types';

type FormMode = { kind: 'create' } | { kind: 'edit'; skill: Skill };

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function emptyDraft(): Skill {
  return {
    id: '',
    scope: 'project',
    description: '',
    body: '',
    preferredMetrics: [],
    preferredBlocks: [],
    vocabulary: {},
    sourcePath: '',
  };
}

export function SkillsPage({ embedded = false, domainFilter = null }: { embedded?: boolean; domainFilter?: string | null } = {}): JSX.Element {
  const { state } = useNotebook();
  const t = themes[state.themeMode];

  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [options, setOptions] = useState<{
    metrics: string[];
    blocks: string[];
  }>({ metrics: [], blocks: [] });
  // Spec 17 (part B) — domains feed the form's domain picker. Best-effort.
  const [domains, setDomains] = useState<Domain[]>([]);
  const [form, setForm] = useState<FormMode | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Skill | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void api
      .getSkills()
      .then((res) => {
        if (cancelled) return;
        setSkills(Array.isArray(res?.skills) ? res.skills : []);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setSkills([]);
        setLoadError(error instanceof Error && error.message ? error.message : 'Could not load skills. Is the local DQL server running?');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    // Options are best-effort — a failure just leaves the multi-selects empty.
    void api
      .getSkillOptions()
      .then((res) => {
        if (cancelled) return;
        setOptions({
          metrics: Array.isArray(res?.metrics) ? res.metrics : [],
          blocks: Array.isArray(res?.blocks) ? res.blocks : [],
        });
      })
      .catch(() => {
        if (!cancelled) setOptions({ metrics: [], blocks: [] });
      });
    // Domains are best-effort — a failure just leaves the picker with no options.
    void api
      .getDomains()
      .then((res) => {
        if (!cancelled) setDomains(Array.isArray(res?.domains) ? res.domains : []);
      })
      .catch(() => {
        if (!cancelled) setDomains([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => load(), [load]);

  const sorted = useMemo(() => skills.filter((skill) => !domainFilter || skill.domain === domainFilter || skill.domains?.includes(domainFilter)).sort((a, b) => a.id.localeCompare(b.id)), [skills, domainFilter]);

  const handleSaved = useCallback((saved: Skill) => {
    setSkills((prev) => {
      const idx = prev.findIndex((s) => s.id === saved.id);
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
      await api.deleteSkill(pendingDelete.id);
      setSkills((prev) => prev.filter((s) => s.id !== pendingDelete.id));
      setPendingDelete(null);
    } catch (error) {
      setDeleteError(error instanceof Error && error.message ? error.message : 'Could not delete this skill.');
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete]);

  return (
    <div style={{ flex: 1, minWidth: 0, overflow: 'auto', background: t.appBg }}>
      <div
        style={{
          maxWidth: 980,
          margin: '0 auto',
          padding: embedded ? '18px 20px 40px' : '22px 28px 40px',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 18,
            marginBottom: 18,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <GraduationCap size={20} strokeWidth={1.9} color={t.accent} />
              <div
                style={{
                  fontSize: embedded ? 18 : 22,
                  fontWeight: 700,
                  color: t.textPrimary,
                }}
              >
                {domainFilter ? `${domainFilter} skills` : 'Skills'}
              </div>
            </div>
            <div
              style={{
                fontSize: 13,
                color: t.textMuted,
                marginTop: 6,
                maxWidth: 680,
                lineHeight: 1.5,
              }}
            >
              Teach the AI your business context — definitions, rules, vocabulary, and the metrics and blocks it should prefer. Skills are Git-backed project guidance and are applied only when their domain and triggers match.
            </div>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexShrink: 0,
            }}
          >
            <button type="button" onClick={() => load()} title="Refresh" style={ghostButton(t)}>
              <RefreshCw size={13} strokeWidth={2} /> Refresh
            </button>
            <button type="button" onClick={() => setForm({ kind: 'create' })} style={primaryButton(t)}>
              <Plus size={14} strokeWidth={2.2} /> Add skill
            </button>
          </div>
        </div>

        {/* Body states */}
        {loading ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              color: t.textMuted,
              fontSize: 13,
              padding: '40px 0',
            }}
          >
            <Loader2 size={15} strokeWidth={2} /> Loading skills…
          </div>
        ) : loadError ? (
          <ErrorPanel t={t} message={loadError} onRetry={() => load()} />
        ) : sorted.length === 0 ? (
          <EmptyState t={t} onAdd={() => setForm({ kind: 'create' })} />
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {sorted.map((skill) => (
              <SkillRow
                key={skill.id}
                skill={skill}
                t={t}
                onEdit={() => setForm({ kind: 'edit', skill })}
                onDelete={() => {
                  setDeleteError(null);
                  setPendingDelete(skill);
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Add / Edit drawer */}
      {form ? <SkillFormDrawer mode={form} options={options} domains={domains} existingIds={skills.map((s) => s.id)} t={t} onClose={() => setForm(null)} onSaved={handleSaved} /> : null}

      {/* Delete confirm */}
      {pendingDelete ? (
        <ConfirmDeleteDialog
          skill={pendingDelete}
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

function SkillRow({ skill, t, onEdit, onDelete }: { skill: Skill; t: Theme; onEdit: () => void; onDelete: () => void }): JSX.Element {
  const vocabCount = Object.keys(skill.vocabulary ?? {}).length;
  const [expanded, setExpanded] = useState(false);
  const domains = skill.domains?.length ? skill.domains : skill.domain ? [skill.domain] : [];
  return (
    <section
      style={{
        border: '1px solid var(--border-subtle)',
        borderRadius: 11,
        background: t.cellBg,
        padding: '12px 14px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
      }}
    >
      <span style={{ width: 28, height: 28, borderRadius: 7, background: 'var(--accent-dim)', color: t.accent, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <GraduationCap size={14} strokeWidth={1.75} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <span
            style={{
              fontSize: 13.5,
              fontWeight: 750,
              color: t.textPrimary,
              fontFamily: t.fontMono,
            }}
          >
            {skill.id}
          </span>
          {skill.status === 'draft' ? <span style={starterBadge(t)}>draft — inactive</span> : null}
          {skill.status === 'active' || !skill.status ? <span style={activeBadge(t)}>active</span> : null}
          {domains.map((domain) => (
            <span key={domain} style={domainBadge(t)}>
              {domain}
            </span>
          ))}
          {skill.isStarter ? (
            <span style={starterBadge(t)} title="A dbt-seeded starter — edit it to make it yours">
              <Sparkles size={10} strokeWidth={2.2} /> starter — edit me
            </span>
          ) : null}
        </div>
        {skill.description ? (
          <div
            style={{
              fontSize: 12.5,
              color: t.textSecondary,
              marginTop: 5,
              lineHeight: 1.5,
            }}
          >
            {skill.description}
          </div>
        ) : (
          <div
            style={{
              fontSize: 12,
              color: t.textMuted,
              marginTop: 5,
              fontStyle: 'italic',
            }}
          >
            No description yet.
          </div>
        )}
        <div style={{ display: 'flex', gap: 7, marginTop: 9, flexWrap: 'wrap' }}>
          <CountPill t={t} icon={<BookMarked size={11} strokeWidth={2} />} label="metrics" count={skill.preferredMetrics?.length ?? 0} />
          <CountPill t={t} icon={<BookMarked size={11} strokeWidth={2} />} label="blocks" count={skill.preferredBlocks?.length ?? 0} />
          <CountPill t={t} icon={<Tags size={11} strokeWidth={2} />} label="vocabulary" count={vocabCount} />
        </div>
        {expanded ? (
          <div
            style={{
              display: 'grid',
              gap: 9,
              marginTop: 12,
              paddingTop: 11,
              borderTop: `1px solid ${t.btnBorder}`,
            }}
          >
            <SkillChipField t={t} label="Use these metrics" values={skill.preferredMetrics} empty="No preferred metrics" />
            <SkillChipField t={t} label="Reuse these blocks" values={skill.preferredBlocks} empty="No preferred blocks" />
            <SkillChipField t={t} label="Focus on model areas" values={skill.modelAreaRefs} empty="All areas in the skill domain" />
            <SkillChipField t={t} label="Apply when" values={skill.triggers} empty="No trigger phrases defined" />
            <SkillChipField t={t} label="Ask first when" values={skill.clarifyWhen} empty="No clarification rule defined" />
            <SkillChipField t={t} label="Avoid when" values={skill.exclusions} empty="No exclusion rule defined" />
            {skill.body ? (
              <div style={{ display: 'grid', gap: 5 }}>
                <strong style={{ color: t.textMuted, fontSize: 11.5 }}>Guidance the agent reads</strong>
                <pre
                  style={{
                    margin: 0,
                    padding: '10px 11px',
                    borderRadius: 7,
                    background: t.appBg,
                    color: t.textSecondary,
                    fontFamily: t.font,
                    fontSize: 12,
                    whiteSpace: 'pre-wrap',
                    lineHeight: 1.5,
                    maxHeight: 220,
                    overflow: 'auto',
                  }}
                >
                  {skill.body}
                </pre>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        <button type="button" onClick={() => setExpanded((value) => !value)} style={{ ...ghostButton(t), padding: '5px 7px', fontSize: 11.5 }} title={expanded ? 'Hide skill details' : 'Show skill details'}>
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          {expanded ? 'Less' : 'Details'}
        </button>
        <button type="button" onClick={onEdit} style={iconButton(t)} title="Edit skill">
          <Pencil size={13} strokeWidth={2} />
        </button>
        <button type="button" onClick={onDelete} style={iconButton(t)} title="Delete skill">
          <Trash2 size={13} strokeWidth={2} />
        </button>
      </div>
    </section>
  );
}

// ── Form drawer (add / edit) ─────────────────────────────────────────────────

function SkillFormDrawer({ mode, options, domains, existingIds, t, onClose, onSaved }: { mode: FormMode; options: { metrics: string[]; blocks: string[] }; domains: Domain[]; existingIds: string[]; t: Theme; onClose: () => void; onSaved: (skill: Skill) => void }): JSX.Element {
  const { dispatch } = useNotebook();
  const editing = mode.kind === 'edit';
  const [draft, setDraft] = useState<Skill>(() => (mode.kind === 'edit' ? { ...mode.skill } : emptyDraft()));
  // Track whether the user has manually edited the id slug so name→slug
  // auto-fill stops once they take control (create only).
  const [idTouched, setIdTouched] = useState(editing);
  const [name, setName] = useState(() => (mode.kind === 'edit' ? mode.skill.id : ''));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = useCallback(<K extends keyof Skill>(key: K, value: Skill[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  const onNameChange = (value: string) => {
    setName(value);
    if (!editing && !idTouched) set('id', slugify(value));
  };

  const idCollision = !editing && draft.id.length > 0 && existingIds.includes(draft.id);
  const canSave = draft.id.trim().length > 0 && draft.body.trim().length > 0 && !idCollision && !saving;

  const onSave = useCallback(async () => {
    const payload: Skill = {
      ...draft,
      id: draft.id.trim(),
      description: draft.description?.trim() ? draft.description.trim() : undefined,
      body: draft.body,
      domain: draft.domain?.trim() ? draft.domain.trim() : undefined,
      domains: (draft.domains ?? (draft.domain ? [draft.domain] : [])).map((value) => value.trim()).filter(Boolean),
      modelAreaRefs: (draft.modelAreaRefs ?? []).map((value) => value.trim()).filter(Boolean),
      triggers: (draft.triggers ?? []).map((value) => value.trim()).filter(Boolean),
      exclusions: (draft.exclusions ?? []).map((value) => value.trim()).filter(Boolean),
      preferredDimensions: (draft.preferredDimensions ?? []).map((value) => value.trim()).filter(Boolean),
      requiredFilters: (draft.requiredFilters ?? []).map((value) => value.trim()).filter(Boolean),
      clarifyWhen: (draft.clarifyWhen ?? []).map((value) => value.trim()).filter(Boolean),
      examples: (draft.examples ?? []).map((value) => value.trim()).filter(Boolean),
    };
    setSaving(true);
    setError(null);
    try {
      const res = editing ? await api.updateSkill(payload.id, payload) : await api.createSkill(payload);
      onSaved(res.skill ?? payload);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not save this skill. Try again.');
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
            <GraduationCap size={16} strokeWidth={2} color={t.accent} />
            <div style={{ fontSize: 15, fontWeight: 700, color: t.textPrimary }}>{editing ? 'Edit skill' : 'New skill'}</div>
          </div>
          <button type="button" onClick={() => !saving && onClose()} style={iconButton(t)} title="Close">
            <X size={15} strokeWidth={2} />
          </button>
        </div>

        {/* Drawer body */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflow: 'auto',
            padding: '16px 18px',
            display: 'grid',
            gap: 16,
          }}
        >
          {/* Name + id */}
          <Field label="Name" t={t} hint={editing ? undefined : 'A short, human label for this skill.'}>
            <input type="text" value={name} onChange={(e) => onNameChange(e.target.value)} placeholder="Metrics glossary" style={inputStyle(t)} />
          </Field>
          <Field label="ID (slug)" t={t} hint="Used as the file name. Letters, numbers, and dashes.">
            <input
              type="text"
              value={draft.id}
              disabled={editing}
              onChange={(e) => {
                setIdTouched(true);
                set('id', slugify(e.target.value));
              }}
              placeholder="metrics-glossary"
              style={{
                ...inputStyle(t),
                fontFamily: t.fontMono,
                opacity: editing ? 0.7 : 1,
              }}
            />
            {idCollision ? (
              <InlineNote t={t} tone="error">
                A skill with this id already exists.
              </InlineNote>
            ) : null}
          </Field>

          {/* Description */}
          <Field label="Description" t={t} hint="One line shown in the list and in the 'guided by' note on AI results.">
            <input type="text" value={draft.description ?? ''} onChange={(e) => set('description', e.target.value)} placeholder="How we define and name our core revenue metrics." style={inputStyle(t)} />
          </Field>

          {/* Domain picker (Spec 17 part B) */}
          <Field label="Domain" t={t} hint="Which business domain this skill belongs to. Domains are the top of the hierarchy.">
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
              }}
            >
              <select
                value={draft.domain ?? ''}
                onChange={(e) => {
                  const domain = e.target.value || undefined;
                  set('domain', domain);
                  set('domains', domain ? [domain] : []);
                }}
                style={{
                  ...inputStyle(t),
                  flex: 1,
                  cursor: 'pointer',
                  color: draft.domain ? t.textPrimary : t.textMuted,
                }}
              >
                <option value="">{domains.length === 0 ? 'No domains yet' : 'No domain'}</option>
                {domains.map((domain) => (
                  <option key={domain.id} value={domain.id}>
                    {domain.name}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => dispatch({ type: 'SET_MAIN_VIEW', view: 'domains' })} style={ghostButton(t)} title="Create a new domain on the Domains page">
                <Plus size={12} strokeWidth={2.2} /> New domain
              </button>
            </div>
          </Field>

          <Field label="Focused model areas (optional)" t={t} hint="Comma-separated area ids from the Model workspace. This boosts the skill only inside its selected domain; it never expands access.">
            <input
              value={(draft.modelAreaRefs ?? []).join(', ')}
              onChange={(e) => set('modelAreaRefs', e.target.value.split(',').map((value) => value.trim()).filter(Boolean))}
              placeholder="customer_lifecycle, revenue_reporting"
              style={inputStyle(t)}
            />
          </Field>

          <Field label="Skill type" t={t} hint="Domain references provide broad context; policies encode a focused, reusable rule.">
            <select value={draft.kind ?? 'custom'} onChange={(e) => set('kind', e.target.value as Skill['kind'])} style={inputStyle(t)}>
              <option value="custom">Custom guidance</option>
              <option value="domain_reference">Domain reference</option>
              <option value="metric_policy">Metric policy</option>
              <option value="glossary">Glossary</option>
              <option value="analysis_pattern">Analysis pattern</option>
              <option value="sql_policy">SQL policy</option>
            </select>
          </Field>

          <Field label="Lifecycle" t={t} hint="Draft skills are stored in Git but do not affect agent answers until activated.">
            <select value={draft.status ?? 'active'} onChange={(e) => set('status', e.target.value as Skill['status'])} style={inputStyle(t)}>
              <option value="active">Active</option>
              <option value="draft">Draft — inactive</option>
              <option value="deprecated">Deprecated</option>
            </select>
          </Field>

          {/* Business-context body */}
          <Field label="Business context" t={t} hint="The guidance the AI follows — definitions, rules, and how to interpret a question.">
            <textarea value={draft.body} onChange={(e) => set('body', e.target.value)} rows={7} placeholder={'e.g. "Revenue means recognized revenue, not bookings. Always exclude test accounts (account_type = \'test\'). When someone asks for ARR, use the arr metric."'} style={textareaStyle(t)} />
          </Field>

          {/* Preferred metrics + blocks */}
          <Field label="Preferred metrics" t={t} hint="Metrics the AI should reach for first when answering.">
            <MultiSelect t={t} options={options.metrics} optionKind="metrics" selected={draft.preferredMetrics} onChange={(next) => set('preferredMetrics', next)} placeholder="Add a metric…" emptyOptionsHint="No metrics available from the project yet." />
          </Field>
          <Field label="Preferred blocks" t={t} hint="Certified blocks the AI should prefer to reuse.">
            <MultiSelect t={t} options={options.blocks} optionKind="blocks" selected={draft.preferredBlocks} onChange={(next) => set('preferredBlocks', next)} placeholder="Add a block…" emptyOptionsHint="No blocks available from the project yet." />
          </Field>

          <Field label="Triggers" t={t} hint="Comma-separated phrases that make this skill relevant.">
            <input
              value={(draft.triggers ?? []).join(', ')}
              onChange={(e) =>
                set(
                  'triggers',
                  e.target.value
                    .split(',')
                    .map((value) => value.trim())
                    .filter(Boolean),
                )
              }
              placeholder="recognized revenue, net sales"
              style={inputStyle(t)}
            />
          </Field>
          <Field label="Preferred dimensions" t={t} hint="Business-safe dimensions the agent should prefer when they are compatible.">
            <input
              value={(draft.preferredDimensions ?? []).join(', ')}
              onChange={(e) =>
                set(
                  'preferredDimensions',
                  e.target.value
                    .split(',')
                    .map((value) => value.trim())
                    .filter(Boolean),
                )
              }
              placeholder="region, month"
              style={inputStyle(t)}
            />
          </Field>
          <Field label="Clarify when" t={t} hint="Ambiguities that should prompt one focused follow-up question.">
            <input
              value={(draft.clarifyWhen ?? []).join(', ')}
              onChange={(e) =>
                set(
                  'clarifyWhen',
                  e.target.value
                    .split(',')
                    .map((value) => value.trim())
                    .filter(Boolean),
                )
              }
              placeholder="currency is not specified"
              style={inputStyle(t)}
            />
          </Field>

          {/* Vocabulary editor */}
          <Field label="Vocabulary" t={t} hint="Map your terms to a target, e.g. arr → metric:arr or revenue → block:revenue_by_region.">
            <VocabularyEditor t={t} value={draft.vocabulary} onChange={(next) => set('vocabulary', next)} />
          </Field>

          {error ? (
            <InlineNote t={t} tone="error">
              {error}
            </InlineNote>
          ) : null}
        </div>

        {/* Drawer footer */}
        <div style={drawerFooter(t)}>
          <span style={{ fontSize: 10.5, color: t.textMuted, flex: 1, textAlign: 'left' }}>Saved to Git — review in source control before merging.</span>
          <button type="button" onClick={() => !saving && onClose()} style={ghostButton(t)}>
            Cancel
          </button>
          <button type="button" onClick={onSave} disabled={!canSave} style={{ ...primaryButton(t), opacity: canSave ? 1 : 0.55 }}>
            {saving ? <Loader2 size={13} strokeWidth={2} /> : null}
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create skill'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Multi-select (preferred metrics / blocks) ────────────────────────────────

function MultiSelect({ t, options, optionKind, selected, onChange, placeholder, emptyOptionsHint }: { t: Theme; options: string[]; optionKind: 'metrics' | 'blocks'; selected: string[]; onChange: (next: string[]) => void; placeholder: string; emptyOptionsHint: string }): JSX.Element {
  const [query, setQuery] = useState('');
  const [remoteOptions, setRemoteOptions] = useState<string[]>(options);
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void api
        .getSkillOptions(query)
        .then((result) => {
          if (!cancelled) setRemoteOptions(optionKind === 'metrics' ? result.metrics : result.blocks);
        })
        .catch(() => {
          if (!cancelled) setRemoteOptions(options);
        });
    }, 160);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [optionKind, options, query]);
  const available = useMemo(
    () =>
      remoteOptions
        .filter((o) => !selected.includes(o))
        .filter((o) => (query ? o.toLowerCase().includes(query.toLowerCase()) : true))
        .slice(0, 8),
    [remoteOptions, selected, query],
  );

  const add = (value: string) => {
    const v = value.trim();
    if (!v || selected.includes(v)) return;
    onChange([...selected, v]);
    setQuery('');
  };

  return (
    <div style={{ display: 'grid', gap: 7 }}>
      {selected.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {selected.map((value) => (
            <span key={value} style={selectedChip(t)}>
              {value}
              <button type="button" onClick={() => onChange(selected.filter((s) => s !== value))} style={chipRemoveButton(t)} title="Remove">
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
      {available.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {available.map((option) => (
            <button key={option} type="button" onClick={() => add(option)} style={suggestionChip(t)}>
              <Plus size={10} strokeWidth={2.4} /> {option}
            </button>
          ))}
        </div>
      ) : remoteOptions.length === 0 ? (
        <div style={{ fontSize: 11, color: t.textMuted }}>{emptyOptionsHint} You can still type a value and press Enter.</div>
      ) : null}
    </div>
  );
}

// ── Vocabulary editor (term → target rows) ───────────────────────────────────

function VocabularyEditor({ t, value, onChange }: { t: Theme; value: Record<string, string>; onChange: (next: Record<string, string>) => void }): JSX.Element {
  // Edit as an ordered row list so empty/duplicate terms don't collapse while typing.
  const [rows, setRows] = useState<Array<{ term: string; target: string }>>(() => Object.entries(value ?? {}).map(([term, target]) => ({ term, target })));

  const commit = (next: Array<{ term: string; target: string }>) => {
    setRows(next);
    const map: Record<string, string> = {};
    for (const row of next) {
      const term = row.term.trim();
      if (term) map[term] = row.target.trim();
    }
    onChange(map);
  };

  const update = (index: number, patch: Partial<{ term: string; target: string }>) => {
    commit(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  return (
    <div style={{ display: 'grid', gap: 7 }}>
      {rows.map((row, index) => (
        <div key={index} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="text" value={row.term} onChange={(e) => update(index, { term: e.target.value })} placeholder="arr" style={{ ...inputStyle(t), flex: 1 }} />
          <span style={{ color: t.textMuted, fontSize: 13 }}>→</span>
          <input type="text" value={row.target} onChange={(e) => update(index, { target: e.target.value })} placeholder="metric:arr" style={{ ...inputStyle(t), flex: 1.3, fontFamily: t.fontMono }} />
          <button type="button" onClick={() => commit(rows.filter((_, i) => i !== index))} style={iconButton(t)} title="Remove row">
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      ))}
      <button type="button" onClick={() => setRows([...rows, { term: '', target: '' }])} style={{ ...ghostButton(t), justifySelf: 'start' }}>
        <Plus size={12} strokeWidth={2.2} /> Add term
      </button>
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
        <GraduationCap size={22} strokeWidth={1.9} />
      </div>
      <div style={{ fontSize: 15, fontWeight: 700, color: t.textPrimary }}>Teach the AI your business rules</div>
      <div
        style={{
          fontSize: 13,
          color: t.textMuted,
          maxWidth: 460,
          lineHeight: 1.55,
        }}
      >
        Skills are the definitions, rules, and vocabulary the AI follows when it answers — like "revenue = recognized, not bookings" or "always exclude test accounts." Add your first one to start guiding every answer.
      </div>
      <button type="button" onClick={onAdd} style={{ ...primaryButton(t), marginTop: 4 }}>
        <Plus size={14} strokeWidth={2.2} /> Add your first skill
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
        <div style={{ fontSize: 13, fontWeight: 650, color: t.textPrimary }}>Skills are not available right now</div>
        <div
          style={{
            fontSize: 12.5,
            color: t.textSecondary,
            marginTop: 4,
            lineHeight: 1.5,
          }}
        >
          {message}
        </div>
        <button type="button" onClick={onRetry} style={{ ...ghostButton(t), marginTop: 10 }}>
          <RefreshCw size={13} strokeWidth={2} /> Retry
        </button>
      </div>
    </div>
  );
}

// ── Delete confirm dialog ────────────────────────────────────────────────────

function ConfirmDeleteDialog({ skill, t, deleting, error, onCancel, onConfirm }: { skill: Skill; t: Theme; deleting: boolean; error: string | null; onCancel: () => void; onConfirm: () => void }): JSX.Element {
  return (
    <div style={modalScrim} onClick={onCancel}>
      <div style={modalCard(t)} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <Trash2 size={16} strokeWidth={2} color={t.error} />
          <div style={{ fontSize: 15, fontWeight: 700, color: t.textPrimary }}>Delete this skill?</div>
        </div>
        <div style={{ fontSize: 13, color: t.textSecondary, lineHeight: 1.55 }}>
          <span style={{ fontFamily: t.fontMono, color: t.textPrimary }}>{skill.id}</span> will be removed and the AI will stop following it. This can't be undone.
        </div>
        {error ? (
          <InlineNote t={t} tone="error">
            {error}
          </InlineNote>
        ) : null}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            marginTop: 4,
          }}
        >
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

function SkillChipField({ t, label, values, empty }: { t: Theme; label: string; values?: string[]; empty: string }): JSX.Element {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '118px minmax(0, 1fr)',
        gap: 10,
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      <strong style={{ color: t.textMuted }}>{label}</strong>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
        {values?.length ? (
          values.map((value) => (
            <span key={value} style={skillChip(t)}>
              {value}
            </span>
          ))
        ) : (
          <span style={{ color: t.textMuted, fontStyle: 'italic' }}>{empty}</span>
        )}
      </div>
    </div>
  );
}

function Field({ label, hint, t, children }: { label: string; hint?: string; t: Theme; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <label style={{ fontSize: 12, fontWeight: 700, color: t.textPrimary }}>{label}</label>
      {hint ? (
        <div
          style={{
            fontSize: 11.5,
            color: t.textMuted,
            lineHeight: 1.45,
            marginTop: -2,
          }}
        >
          {hint}
        </div>
      ) : null}
      {children}
    </div>
  );
}

function InlineNote({ t, tone, children }: { t: Theme; tone: 'error' | 'muted'; children: React.ReactNode }): JSX.Element {
  const color = tone === 'error' ? t.error : t.textMuted;
  return <div style={{ fontSize: 11.5, color, lineHeight: 1.45 }}>{children}</div>;
}

function skillChip(t: Theme): CSSProperties {
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

function activeBadge(t: Theme): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    fontSize: 10.5,
    fontWeight: 700,
    color: t.success,
    background: `${t.success}14`,
    border: `1px solid ${t.success}38`,
    borderRadius: 999,
    padding: '2px 7px',
  };
}

function domainBadge(t: Theme): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    fontSize: 10.5,
    fontWeight: 700,
    color: t.accent,
    background: `${t.accent}14`,
    border: `1px solid ${t.accent}38`,
    borderRadius: 999,
    padding: '2px 7px',
  };
}

// ── Styles ───────────────────────────────────────────────────────────────────

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

function starterBadge(t: Theme): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.02em',
    color: t.warning,
    background: `${t.warning}16`,
    border: `1px solid ${t.warning}40`,
    borderRadius: 999,
    padding: '2px 8px',
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

function suggestionChip(t: Theme): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 11,
    fontWeight: 600,
    color: t.textSecondary,
    background: t.btnBg,
    border: `1px solid ${t.btnBorder}`,
    borderRadius: 6,
    padding: '3px 8px',
    cursor: 'pointer',
    fontFamily: t.fontMono,
  };
}

// Prototype skill form: a centered modal (min(860px,94vw) × min(640px,90vh),
// radius 14, light scrim) instead of the old right-hand drawer.
const drawerScrim: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(26, 26, 26, 0.22)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 60,
};

function drawerPanel(t: Theme): CSSProperties {
  return {
    width: 'min(860px, 94vw)',
    height: 'min(640px, 90vh)',
    background: t.cellBg,
    border: `1px solid ${t.headerBorder}`,
    borderRadius: 14,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    boxShadow: '0 24px 70px rgba(26,26,26,0.22)',
  };
}

function drawerHeader(t: Theme): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '14px 18px',
    borderBottom: '1px solid var(--border-subtle)',
    flexShrink: 0,
  };
}

function drawerFooter(t: Theme): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
    padding: '12px 18px',
    borderTop: '1px solid var(--border-subtle)',
    background: 'var(--bg-1)',
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
