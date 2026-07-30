import React from 'react';
import type { Theme } from '../../themes/notebook-theme';

export type DomainScopeOption = {
  value: string;
  label?: string;
};

export function DomainScopeSelect({
  id,
  ariaLabel,
  value,
  options,
  onChange,
  summary,
  t,
}: {
  id: string;
  ariaLabel: string;
  value: string;
  options: Array<string | DomainScopeOption>;
  onChange: (domain: string) => void;
  summary?: React.ReactNode;
  t: Theme;
}) {
  return (
    <div style={{ padding: 8, borderBottom: `1px solid ${t.headerBorder}`, display: 'grid', gap: 5 }}>
      <label htmlFor={id} style={{ color: t.textMuted, fontSize: 9, fontWeight: 750, letterSpacing: '.06em', textTransform: 'uppercase' }}>
        Domain
      </label>
      <select
        id={id}
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        style={{
          width: '100%',
          background: t.inputBg,
          border: `1px solid ${t.inputBorder}`,
          borderRadius: 6,
          color: t.textPrimary,
          fontFamily: t.font,
          fontSize: 12,
          padding: '7px 8px',
        }}
      >
        <option value="">All domains</option>
        {options.map((option) => {
          const normalized = typeof option === 'string' ? { value: option, label: option } : option;
          return <option key={normalized.value} value={normalized.value}>{normalized.label ?? normalized.value}</option>;
        })}
      </select>
      {summary !== undefined ? <span style={{ color: t.textMuted, fontSize: 10 }}>{summary}</span> : null}
    </div>
  );
}
