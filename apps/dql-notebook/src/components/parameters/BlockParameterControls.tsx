import React from 'react';
import type { BlockParameterDefinition } from '../../store/types';
import type { Theme } from '../../themes/notebook-theme';

export function isRuntimeEditableParameter(parameter: BlockParameterDefinition): boolean {
  return parameter.policy === 'dynamic' || parameter.policy === 'optional';
}

export function BlockParameterControls({
  parameters,
  values,
  onChange,
  onReset,
  t,
  includeNonRuntime = false,
  card = false,
}: {
  parameters: BlockParameterDefinition[];
  values: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
  onReset?: (name: string) => void;
  t: Theme;
  includeNonRuntime?: boolean;
  card?: boolean;
}) {
  const visible = parameters.filter((parameter) => includeNonRuntime || isRuntimeEditableParameter(parameter));
  if (visible.length === 0) return null;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 8 }}>
      {visible.map((parameter) => {
        const hasOverride = Object.prototype.hasOwnProperty.call(values, parameter.name);
        const value = hasOverride ? values[parameter.name] : parameter.default;
        const setValue = (next: unknown) => onChange(parameter.name, next);
        const control = parameter.type === 'boolean' ? (
          <select
            aria-label={parameter.name}
            value={String(value ?? '')}
            onChange={(event) => setValue(event.target.value)}
            style={controlStyle(t)}
          >
            <option value="">Select…</option>
            <option value="true">True</option>
            <option value="false">False</option>
          </select>
        ) : (
          <input
            aria-label={parameter.name}
            type={parameter.type === 'number' ? 'number' : parameter.type === 'date' ? 'date' : 'text'}
            value={Array.isArray(value) ? value.join(', ') : value == null ? '' : String(value)}
            placeholder={parameter.type.endsWith('[]') ? 'Comma-separated values' : parameter.required ? 'Required value' : 'Use default'}
            onChange={(event) => setValue(event.target.value)}
            style={controlStyle(t)}
          />
        );
        return (
          <label
            key={parameter.name}
            style={{
              display: 'grid', gap: 4, minWidth: 0,
              ...(card ? { padding: 9, border: `1px solid ${t.cellBorder}`, borderRadius: 7, background: t.appBg } : {}),
            }}
          >
            <span style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 10.5, fontWeight: 750, color: t.textSecondary }}>
              {businessLabel(parameter.name)}
              {parameter.required ? <span style={{ color: t.error }}>*</span> : null}
            </span>
            {control}
            <span style={{ display: 'flex', alignItems: 'center', gap: 5, minHeight: 14, fontSize: 9.5, color: t.textMuted }}>
              <span>{parameter.type}{includeNonRuntime ? ` · ${parameter.policy}` : ''}</span>
              {hasOverride && onReset ? (
                <button type="button" onClick={() => onReset(parameter.name)} style={{ marginLeft: 'auto', border: 0, padding: 0, background: 'transparent', color: t.accent, fontSize: 9.5, cursor: 'pointer' }}>
                  Reset
                </button>
              ) : null}
            </span>
          </label>
        );
      })}
    </div>
  );
}

function businessLabel(name: string): string {
  return name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function controlStyle(t: Theme): React.CSSProperties {
  return {
    width: '100%', minWidth: 0, boxSizing: 'border-box',
    background: t.inputBg, border: `1px solid ${t.inputBorder}`, borderRadius: 5,
    color: t.textPrimary, padding: '5px 7px', fontSize: 11, fontFamily: t.font,
  };
}
