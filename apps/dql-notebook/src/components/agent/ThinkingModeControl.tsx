import React, { useEffect, useRef, useState } from 'react';
import { Zap, ChevronDown, Check, Circle } from 'lucide-react';
import { api, type AgentThinkingMode, type ProviderSettings } from '../../api/client';
import type { Theme } from '../../themes/notebook-theme';

/**
 * The chat-composer chip: shows the connected active model and a "thinking"
 * selector the user can change mid-conversation. `auto` (default) defers to the
 * engine's shape-adaptive routing; the manual modes trade speed against rigor for
 * the thread. Each option states its tradeoff so the choice explains itself.
 */
const THINKING_OPTIONS: Array<{ mode: AgentThinkingMode; label: string; hint: string }> = [
  { mode: 'auto', label: 'Auto', hint: 'Adapts per question — fast for lookups, thorough for hard ones' },
  { mode: 'low', label: 'Low · fast', hint: 'Fewer thinking tokens, skips extra verification' },
  { mode: 'medium', label: 'Medium · balanced', hint: 'More thinking, still skips the heavy verification' },
  { mode: 'high', label: 'High · thorough', hint: 'Most thinking, cross-checks the number — slower' },
];

export function ThinkingModeControl({ t, value, onChange }: {
  t: Theme;
  value: AgentThinkingMode;
  onChange: (mode: AgentThinkingMode) => void;
}): JSX.Element {
  const [provider, setProvider] = useState<ProviderSettings | null>(null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getProviderSettings()
      .then(({ providers }) => {
        if (!cancelled) setProvider(providers.find((p) => p.active) ?? null);
      })
      .catch(() => { /* provider status is best-effort chrome */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  const active = THINKING_OPTIONS.find((option) => option.mode === value) ?? THINKING_OPTIONS[0];
  const modelLabel = provider ? [provider.label, provider.model].filter(Boolean).join(' · ') : null;
  // Show the thinking selector unless the active model has no reasoning surface —
  // matching how the settings page gates its reasoning-effort control.
  const showThinking = provider ? provider.supportsReasoningEffort !== false : true;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      {modelLabel ? (
        <span title="Connected model" style={chipStyle(t)}>
          <Circle size={7} fill={t.success} color={t.success} />
          <span style={{ color: t.textSecondary }}>{modelLabel}</span>
        </span>
      ) : null}

      {showThinking ? (
        <div ref={rootRef} style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            title="How hard the model thinks for this thread"
            style={{ ...chipStyle(t), cursor: 'pointer' }}
          >
            <Zap size={12} color={t.textMuted} />
            <span style={{ color: t.textSecondary }}>Thinking: {active.label}</span>
            <ChevronDown size={12} color={t.textMuted} />
          </button>
          {open ? (
            <div role="menu" style={menuStyle(t)}>
              {THINKING_OPTIONS.map((option) => {
                const selected = option.mode === value;
                return (
                  <button
                    key={option.mode}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    onClick={() => { onChange(option.mode); setOpen(false); }}
                    style={menuItemStyle(t, selected)}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <span style={{ fontWeight: selected ? 600 : 500, color: t.textPrimary }}>{option.label}</span>
                      {selected ? <Check size={13} color={t.accent} /> : null}
                    </span>
                    <span style={{ display: 'block', fontSize: 11, color: t.textMuted, marginTop: 2 }}>{option.hint}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function chipStyle(t: Theme): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 9px',
    borderRadius: 8,
    border: `1px solid ${t.btnBorder}`,
    background: t.btnBg,
    fontSize: 12,
    lineHeight: 1.2,
    whiteSpace: 'nowrap',
  };
}

function menuStyle(t: Theme): React.CSSProperties {
  return {
    position: 'absolute',
    bottom: 'calc(100% + 6px)',
    left: 0,
    zIndex: 30,
    width: 264,
    background: t.cellBg,
    border: `1px solid ${t.cellBorder}`,
    borderRadius: 10,
    padding: 4,
    boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
  };
}

function menuItemStyle(t: Theme, selected: boolean): React.CSSProperties {
  return {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    padding: '8px 10px',
    borderRadius: 7,
    border: 'none',
    background: selected ? t.pillBg : 'transparent',
    cursor: 'pointer',
  };
}
