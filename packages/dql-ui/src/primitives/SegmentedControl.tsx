// v1.3 Track 4 — SegmentedControl primitive.
//
// Used by the Studio/App shell toggle (Track 5) and by output-view
// switchers inside CellChrome (Track 6). Luna-token styled via inline
// CSS vars so theming tracks [data-theme] on <html>.

import React from 'react';

export interface SegmentedControlOption<V extends string = string> {
  value: V;
  label: React.ReactNode;
  icon?: React.ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<V extends string = string> {
  options: SegmentedControlOption<V>[];
  value: V;
  onChange: (value: V) => void;
  size?: 'sm' | 'md';
  ariaLabel?: string;
}

export function SegmentedControl<V extends string = string>({
  options,
  value,
  onChange,
  size = 'md',
  ariaLabel,
}: SegmentedControlProps<V>) {
  const pad = size === 'sm' ? '4px 10px' : '6px 12px';
  const font = size === 'sm' ? 11 : 12;
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      style={{
        display: 'inline-flex',
        padding: 2,
        gap: 2,
        background: 'var(--bg-2)',
        border: '1px solid var(--border-default)',
        borderRadius: 8,
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            role="tab"
            aria-selected={active}
            disabled={opt.disabled}
            onClick={() => onChange(opt.value)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: pad,
              border: 'none',
              borderRadius: 6,
              background: active ? 'var(--bg-0)' : 'transparent',
              color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
              fontSize: font,
              fontWeight: active ? 600 : 500,
              cursor: opt.disabled ? 'not-allowed' : 'pointer',
              opacity: opt.disabled ? 0.5 : 1,
              boxShadow: active ? '0 1px 2px rgba(0,0,0,0.12)' : 'none',
              transition: 'background 120ms var(--ease), color 120ms var(--ease)',
              whiteSpace: 'nowrap',
            }}
          >
            {opt.icon && <span style={{ display: 'inline-flex' }}>{opt.icon}</span>}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
