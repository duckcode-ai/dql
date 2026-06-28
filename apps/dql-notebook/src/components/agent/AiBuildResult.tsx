// Spec 14 (part B) — the unified AI BUILD surface.
//
// Build is split from Ask. Ask answers a question through the governed Q&A
// loop (`AgentChatPanel`, unchanged). Build *generates* SQL/DQL and renders a
// clean ARTIFACT CARD — never a chat transcript, never the answer loop's
// internals. This component owns:
//   • a target toggle  Cell ⇄ Block
//   • a prompt box (+ optional context: active cell SQL / selection)
//   • the POST /api/ai/build call (api.aiBuild, coded to the shared contract)
//   • two result cards:
//       - target:'cell'  → SQL + "Insert into cell" / "Refine" / "Discard"
//       - target:'block' → semantic name, "AI-generated · draft" badge, one-line
//         description, collapsible SQL, outputs chips, grain, examples,
//         "what's missing to certify", "Open in Block Studio" / "Refine" /
//         "Discard"
//
// The Build card NEVER shows self-correction text, evidence-tier tables,
// reviewStatus, "USE EXISTING DRAFT" / "DRAFT REVIEW" / "No draft file path
// returned", or "Continuing from …". On failure it shows one plain sentence and
// a Refine affordance.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Blocks,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Hammer,
  Loader2,
  RotateCcw,
  Sparkles,
  SquarePlus,
  Trash2,
  UserRound,
} from 'lucide-react';
import { api } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import { themes, type Theme, type ThemeMode } from '../../themes/notebook-theme';
import type { AiBuildResult as AiBuildResultPayload, AiBuildTarget, NotebookFile } from '../../store/types';

interface AiBuildResultProps {
  themeMode: ThemeMode;
  /** Initial Build target (the front doors choose this). */
  initialTarget?: AiBuildTarget;
  /** Lock the target toggle (e.g. a "Build DQL block" front door). */
  lockTarget?: boolean;
  /** Optional pre-filled prompt (e.g. "Refine with AI" from a proposal row). */
  initialPrompt?: string;
  /** Context handed to the build: the active SQL cell + any selection. */
  context?: { cellSql?: string; selection?: string };
  /** Insert/replace the active SQL cell's source (target:'cell'). */
  onInsertCell?: (sql: string) => void;
  /** Open the generated draft block in Block Studio (target:'block'). */
  onOpenBlock?: (path: string, name: string) => void;
  /**
   * Preset prompts shown as one-click chips above the box. Each may pin a
   * target (e.g. "Build DQL block" → 'block'); clicking runs the build.
   */
  quickActions?: Array<{ label: string; prompt: string; target?: AiBuildTarget }>;
}

type BuildPhase = 'idle' | 'building' | 'ready' | 'error';

const TARGET_LABEL: Record<AiBuildTarget, string> = {
  cell: 'Cell',
  block: 'Block',
};

export function AiBuildResult({
  themeMode,
  initialTarget = 'cell',
  lockTarget = false,
  initialPrompt = '',
  context,
  onInsertCell,
  onOpenBlock,
  quickActions,
}: AiBuildResultProps): JSX.Element {
  const t = themes[themeMode];
  const [target, setTarget] = useState<AiBuildTarget>(initialTarget);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [phase, setPhase] = useState<BuildPhase>('idle');
  const [result, setResult] = useState<AiBuildResultPayload | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [inserted, setInserted] = useState(false);
  const lastPromptRef = useRef('');

  // "drafting as <owner>" — best-effort, never blocks (spec part D).
  useEffect(() => {
    let cancelled = false;
    api.getIdentity()
      .then((id) => { if (!cancelled && id?.owner) setOwner(id.owner); })
      .catch(() => { /* identity is optional */ });
    return () => { cancelled = true; };
  }, []);

  const runBuild = useCallback(async (text: string, buildTarget: AiBuildTarget) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    lastPromptRef.current = trimmed;
    setPhase('building');
    setErrorText(null);
    setInserted(false);
    try {
      const built = await api.aiBuild({
        prompt: trimmed,
        context,
        target: buildTarget,
        ...(owner ? { owner } : {}),
      });
      setResult(built);
      setPhase('ready');
    } catch (error) {
      // One plain sentence — no stack, no internals.
      setErrorText(error instanceof Error && error.message ? error.message : 'Could not build that. Try rewording the request.');
      setResult(null);
      setPhase('error');
    }
  }, [context, owner]);

  const onSubmit = useCallback(() => { void runBuild(prompt, target); }, [prompt, runBuild, target]);

  const onQuickAction = useCallback((action: { prompt: string; target?: AiBuildTarget }) => {
    const nextTarget = action.target && !lockTarget ? action.target : target;
    if (action.target && !lockTarget) setTarget(action.target);
    setPrompt(action.prompt);
    void runBuild(action.prompt, nextTarget);
  }, [lockTarget, runBuild, target]);

  // "Refine" re-prompts from the current text, keeping the same target.
  const onRefine = useCallback(() => {
    setPhase('idle');
    setResult(null);
    setErrorText(null);
    setInserted(false);
    if (!prompt.trim() && lastPromptRef.current) setPrompt(lastPromptRef.current);
  }, [prompt]);

  const onDiscard = useCallback(() => {
    setResult(null);
    setErrorText(null);
    setInserted(false);
    setPhase('idle');
  }, []);

  const building = phase === 'building';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%', overflow: 'auto' }}>
      <div style={{ padding: 12, display: 'grid', gap: 10 }}>
        {/* Target toggle: Cell ⇄ Block */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div role="group" aria-label="Build target" style={segmentGroupStyle(t)}>
            {(['cell', 'block'] as AiBuildTarget[]).map((value) => {
              const active = target === value;
              return (
                <button
                  key={value}
                  type="button"
                  disabled={lockTarget && !active}
                  onClick={() => { if (!lockTarget) { setTarget(value); onDiscard(); } }}
                  aria-pressed={active}
                  style={segmentButtonStyle(t, active, lockTarget && !active)}
                >
                  {value === 'cell' ? <SquarePlus size={13} strokeWidth={2} /> : <Blocks size={13} strokeWidth={2} />}
                  {TARGET_LABEL[value]}
                </button>
              );
            })}
          </div>
          <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
            {target === 'cell' ? 'Generate SQL into a notebook cell.' : 'Generate a reusable draft DQL block.'}
          </span>
          {owner && (
            <span
              title="Drafts are attributed to you"
              style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: t.textMuted, fontFamily: t.font }}
            >
              <UserRound size={12} strokeWidth={2} />
              drafting as {owner}
            </span>
          )}
        </div>

        {/* Quick actions (preset prompts) */}
        {quickActions && quickActions.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {quickActions.map((action) => (
              <button
                key={action.label}
                type="button"
                disabled={building}
                onClick={() => onQuickAction(action)}
                style={{ ...ghostButtonStyle(t), opacity: building ? 0.6 : 1 }}
              >
                <Sparkles size={12} strokeWidth={2} /> {action.label}
              </button>
            ))}
          </div>
        ) : null}

        {/* Prompt box */}
        <div style={{ display: 'grid', gap: 7 }}>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                onSubmit();
              }
            }}
            rows={3}
            placeholder={target === 'cell'
              ? 'Describe the SQL you want, e.g. "monthly revenue by region for the last 12 months".'
              : 'Describe the reusable block, e.g. "active customers by signup cohort".'}
            style={textareaStyle(t)}
          />
          {context?.cellSql ? (
            <div style={{ fontSize: 10.5, color: t.textMuted, fontFamily: t.font }}>
              Using the active SQL cell{context.selection ? ' and your selection' : ''} as context.
            </div>
          ) : null}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button
              type="button"
              onClick={onSubmit}
              disabled={building || !prompt.trim()}
              style={{ ...primaryButtonStyle(t), opacity: building || !prompt.trim() ? 0.6 : 1 }}
            >
              {building ? <Loader2 size={13} strokeWidth={2} /> : <Hammer size={13} strokeWidth={2} />}
              {building ? 'Building…' : 'Build'}
            </button>
          </div>
        </div>

        {/* Result / error */}
        {phase === 'error' && (
          <BuildErrorCard t={t} message={errorText ?? 'Could not build that.'} onRefine={onRefine} />
        )}
        {phase === 'ready' && result?.target === 'cell' && (
          <CellResultCard
            t={t}
            sql={result.sql}
            explanation={result.explanation}
            inserted={inserted}
            onInsert={() => { onInsertCell?.(result.sql); setInserted(true); }}
            onRefine={onRefine}
            onDiscard={onDiscard}
          />
        )}
        {phase === 'ready' && result?.target === 'block' && (
          <BlockResultCard
            t={t}
            result={result}
            owner={owner}
            onOpen={() => onOpenBlock?.(result.path, result.name)}
            onRefine={onRefine}
            onDiscard={onDiscard}
          />
        )}
      </div>
    </div>
  );
}

// ── Cell result ────────────────────────────────────────────────────────────

function CellResultCard({
  t,
  sql,
  explanation,
  inserted,
  onInsert,
  onRefine,
  onDiscard,
}: {
  t: Theme;
  sql: string;
  explanation?: string;
  inserted: boolean;
  onInsert: () => void;
  onRefine: () => void;
  onDiscard: () => void;
}): JSX.Element {
  return (
    <section style={cardStyle(t)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Sparkles size={14} strokeWidth={2} color={t.accent} />
        <div style={{ fontSize: 12.5, fontWeight: 800, color: t.textPrimary, fontFamily: t.font }}>Generated SQL</div>
        <span style={aiDraftBadgeStyle(t)}>AI-generated</span>
      </div>
      {explanation ? (
        <div style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.5, fontFamily: t.font }}>{explanation}</div>
      ) : null}
      <CodeBlock t={t} code={sql} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" onClick={onInsert} disabled={inserted} style={{ ...primaryButtonStyle(t), opacity: inserted ? 0.65 : 1 }}>
          {inserted ? <CheckCircle2 size={13} strokeWidth={2} /> : <SquarePlus size={13} strokeWidth={2} />}
          {inserted ? 'Inserted' : 'Insert into cell'}
        </button>
        <button type="button" onClick={onRefine} style={ghostButtonStyle(t)}>
          <RotateCcw size={13} strokeWidth={2} /> Refine
        </button>
        <button type="button" onClick={onDiscard} style={ghostButtonStyle(t)}>
          <Trash2 size={13} strokeWidth={2} /> Discard
        </button>
      </div>
    </section>
  );
}

// ── Block result ─────────────────────────────────────────────────────────────

function BlockResultCard({
  t,
  result,
  owner,
  onOpen,
  onRefine,
  onDiscard,
}: {
  t: Theme;
  result: Extract<AiBuildResultPayload, { target: 'block' }>;
  owner: string | null;
  onOpen: () => void;
  onRefine: () => void;
  onDiscard: () => void;
}): JSX.Element {
  const [sqlOpen, setSqlOpen] = useState(false);
  const { name, description, sqlPreview, grain, outputs, examples, certifierVerdict } = result;
  return (
    <section style={cardStyle(t)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Blocks size={14} strokeWidth={2} color={t.accent} />
        <div style={{ fontSize: 13, fontWeight: 850, color: t.textPrimary, fontFamily: t.font }}>{name}</div>
        <span style={aiDraftBadgeStyle(t)}>AI-generated · draft</span>
        {grain ? <span style={metaPillStyle(t)}>grain {grain}</span> : null}
      </div>
      {description ? (
        <div style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.5, fontFamily: t.font }}>{description}</div>
      ) : null}

      {/* Collapsible SQL */}
      <div>
        <button type="button" onClick={() => setSqlOpen((open) => !open)} style={disclosureToggleStyle(t)}>
          {sqlOpen ? <ChevronDown size={13} strokeWidth={2} /> : <ChevronRight size={13} strokeWidth={2} />}
          {sqlOpen ? 'Hide SQL this block will run' : 'Show SQL this block will run'}
        </button>
        {sqlOpen ? <div style={{ marginTop: 7 }}><CodeBlock t={t} code={sqlPreview} /></div> : null}
      </div>

      {outputs.length > 0 ? (
        <div style={{ display: 'grid', gap: 5 }}>
          <SectionLabel t={t}>Outputs</SectionLabel>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {outputs.map((output) => <span key={output} style={chipStyle(t)}>{output}</span>)}
          </div>
        </div>
      ) : null}

      {examples.length > 0 ? (
        <div style={{ display: 'grid', gap: 5 }}>
          <SectionLabel t={t}>Answers questions like</SectionLabel>
          <ul style={{ margin: 0, padding: '0 0 0 16px', display: 'grid', gap: 3 }}>
            {examples.slice(0, 3).map((example) => (
              <li key={example} style={{ fontSize: 11.5, color: t.textSecondary, lineHeight: 1.45, fontFamily: t.font }}>{example}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <CertifierVerdictBlock t={t} verdict={certifierVerdict} />

      {owner ? (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
          <UserRound size={12} strokeWidth={2} /> drafting as {owner}
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" onClick={onOpen} style={primaryButtonStyle(t)}>
          <Blocks size={13} strokeWidth={2} /> Open in Block Studio
        </button>
        <button type="button" onClick={onRefine} style={ghostButtonStyle(t)}>
          <RotateCcw size={13} strokeWidth={2} /> Refine
        </button>
        <button type="button" onClick={onDiscard} style={ghostButtonStyle(t)}>
          <Trash2 size={13} strokeWidth={2} /> Discard
        </button>
      </div>
    </section>
  );
}

// ── Shared "what's missing to certify" ───────────────────────────────────────

export function CertifierVerdictBlock({
  t,
  verdict,
}: {
  t: Theme;
  verdict?: { blocking: string[]; warnings: string[]; ready: boolean };
}): JSX.Element | null {
  if (!verdict) return null;
  const ready = verdict.ready && verdict.blocking.length === 0;
  const notes = ready ? [] : [...verdict.blocking, ...verdict.warnings];
  return (
    <div style={{ display: 'grid', gap: 5 }}>
      <SectionLabel t={t}>What's missing to certify</SectionLabel>
      {ready ? (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: t.success, fontFamily: t.font }}>
          <CheckCircle2 size={14} strokeWidth={2} />
          Grain, outputs, and context are set.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 4 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: t.warning, fontFamily: t.font }}>
            <AlertTriangle size={14} strokeWidth={2} />
            Needs an owner and passing tests before it can be certified.
          </div>
          {notes.length > 0 ? (
            <ul style={{ margin: 0, padding: '0 0 0 16px', display: 'grid', gap: 2 }}>
              {notes.map((note) => (
                <li key={note} style={{ fontSize: 11, color: t.textSecondary, lineHeight: 1.4, fontFamily: t.font }}>{note}</li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ── Error ────────────────────────────────────────────────────────────────────

function BuildErrorCard({ t, message, onRefine }: { t: Theme; message: string; onRefine: () => void }): JSX.Element {
  return (
    <section style={{ ...cardStyle(t), borderColor: `${t.error}66` }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <AlertTriangle size={15} strokeWidth={2} color={t.error} style={{ marginTop: 1, flexShrink: 0 }} />
        <div style={{ fontSize: 12.5, color: t.textPrimary, lineHeight: 1.5, fontFamily: t.font }}>{message}</div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={onRefine} style={ghostButtonStyle(t)}>
          <RotateCcw size={13} strokeWidth={2} /> Refine and try again
        </button>
      </div>
    </section>
  );
}

// ── Small building blocks ────────────────────────────────────────────────────

function CodeBlock({ t, code }: { t: Theme; code: string }): JSX.Element {
  return (
    <pre style={codeBlockStyle(t)}>
      <code style={{ fontFamily: t.fontMono, fontSize: 11.5, color: t.textPrimary, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {code.trim()}
      </code>
    </pre>
  );
}

function SectionLabel({ t, children }: { t: Theme; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: t.textMuted, fontFamily: t.font }}>
      {children}
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

function segmentGroupStyle(t: Theme): React.CSSProperties {
  return {
    display: 'inline-flex',
    padding: 2,
    gap: 2,
    border: `1px solid ${t.btnBorder}`,
    borderRadius: 8,
    background: t.btnBg,
  };
}

function segmentButtonStyle(t: Theme, active: boolean, disabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '5px 11px',
    borderRadius: 6,
    border: '1px solid transparent',
    background: active ? t.accent : 'transparent',
    color: active ? '#ffffff' : t.textSecondary,
    fontSize: 12,
    fontWeight: active ? 800 : 600,
    fontFamily: t.font,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.45 : 1,
  };
}

function textareaStyle(t: Theme): React.CSSProperties {
  return {
    width: '100%',
    resize: 'vertical',
    border: `1px solid ${t.btnBorder}`,
    borderRadius: 8,
    background: t.cellBg,
    color: t.textPrimary,
    fontSize: 12.5,
    fontFamily: t.font,
    lineHeight: 1.5,
    padding: '9px 11px',
    boxSizing: 'border-box',
  };
}

function cardStyle(t: Theme): React.CSSProperties {
  return {
    border: `1px solid ${t.cellBorder}`,
    borderRadius: 10,
    background: t.cellBg,
    padding: 12,
    display: 'grid',
    gap: 10,
  };
}

function codeBlockStyle(t: Theme): React.CSSProperties {
  return {
    margin: 0,
    border: `1px solid ${t.cellBorder}`,
    borderRadius: 8,
    background: t.appBg,
    padding: '9px 11px',
    overflow: 'auto',
    maxHeight: 280,
  };
}

function primaryButtonStyle(t: Theme): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '7px 12px',
    borderRadius: 7,
    border: `1px solid ${t.accent}`,
    background: t.accent,
    color: '#ffffff',
    fontSize: 12,
    fontWeight: 750,
    fontFamily: t.font,
    cursor: 'pointer',
  };
}

function ghostButtonStyle(t: Theme): React.CSSProperties {
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

function disclosureToggleStyle(t: Theme): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: 0,
    border: 'none',
    background: 'transparent',
    color: t.accent,
    fontSize: 11.5,
    fontWeight: 700,
    fontFamily: t.font,
    cursor: 'pointer',
  };
}

function aiDraftBadgeStyle(t: Theme): React.CSSProperties {
  return {
    fontSize: 10,
    fontWeight: 800,
    letterSpacing: '0.03em',
    textTransform: 'uppercase',
    color: t.accent,
    background: `${t.accent}18`,
    border: `1px solid ${t.accent}40`,
    borderRadius: 999,
    padding: '2px 8px',
    fontFamily: t.font,
  };
}

function metaPillStyle(t: Theme): React.CSSProperties {
  return {
    fontSize: 10.5,
    fontWeight: 600,
    color: t.textMuted,
    background: t.btnBg,
    border: `1px solid ${t.btnBorder}`,
    borderRadius: 999,
    padding: '2px 8px',
    fontFamily: t.font,
  };
}

function chipStyle(t: Theme): React.CSSProperties {
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

/** Shared helper: open a draft block path in Block Studio via the canonical flow. */
export function useOpenBlockInStudio(): (path: string, name: string) => Promise<void> {
  const { state, dispatch } = useNotebook();
  return useCallback(async (path: string, name: string) => {
    const file: NotebookFile = {
      name: path.split('/').pop() ?? `${name}.dql`,
      path,
      type: 'block',
      folder: 'blocks',
    };
    if (!state.files.some((f) => f.path === path)) {
      dispatch({ type: 'FILE_ADDED', file });
    }
    const payload = await api.openBlockStudio(path);
    dispatch({ type: 'OPEN_BLOCK_STUDIO', file, payload });
  }, [dispatch, state.files]);
}
