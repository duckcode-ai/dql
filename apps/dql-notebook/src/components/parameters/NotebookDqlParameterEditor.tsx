import React, { useMemo, useState } from 'react';
import type { Theme } from '../../themes/notebook-theme';
import {
  ensureNotebookDqlBlockSource,
  inferVisualParameterType,
  parseSemanticVisualFields,
  parseVisualBlockParameters,
  removeVisualBlockParameter,
  setSemanticRuntimeFilters,
  upsertVisualBlockParameter,
  visualParameterDefaultText,
  type VisualBlockParameter,
  type VisualBlockParameterType,
} from '../../utils/block-studio';

const TYPES: VisualBlockParameterType[] = ['string', 'number', 'boolean', 'date', 'string[]', 'number[]', 'date[]'];
const POLICIES: VisualBlockParameter['policy'][] = ['dynamic', 'optional', 'static', 'business', 'derived'];

export function NotebookDqlParameterEditor({
  source,
  onSourceChange,
  t,
}: {
  source: string;
  onSourceChange: (source: string) => void;
  t: Theme;
}) {
  const parameters = useMemo(() => parseVisualBlockParameters(source), [source]);
  const semantic = /\btype\s*=\s*"semantic"/i.test(source);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [defaultText, setDefaultText] = useState('');
  const [required, setRequired] = useState(false);
  const [type, setType] = useState<VisualBlockParameterType>('string');

  const update = (parameter: VisualBlockParameter, changes: Partial<VisualBlockParameter> & { defaultText?: string }) => {
    onSourceChange(upsertVisualBlockParameter(ensureNotebookDqlBlockSource(source), {
      name: parameter.name,
      type: changes.type ?? parameter.type,
      required: changes.required ?? parameter.required,
      defaultText: changes.defaultText ?? visualParameterDefaultText(parameter),
      policy: changes.policy ?? parameter.policy,
    }));
  };

  const addParameter = () => {
    const cleanName = name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    if (!cleanName) return;
    const blockSource = ensureNotebookDqlBlockSource(source);
    const parameterSource = semantic
      ? setSemanticRuntimeFilters(blockSource, [...parseSemanticVisualFields(blockSource).requestedFilters, cleanName])
      : blockSource;
    onSourceChange(upsertVisualBlockParameter(parameterSource, {
      name: cleanName,
      type,
      required,
      defaultText,
      policy: required ? 'dynamic' : 'optional',
    }));
    setName('');
    setDefaultText('');
    setRequired(false);
    setType('string');
    setAdding(false);
  };

  return (
    <div style={{ padding: '7px 10px', borderBottom: `1px solid ${t.cellBorder}`, background: `${t.tableHeaderBg}35` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, minHeight: 24 }}>
        <span style={{ fontSize: 10.5, fontWeight: 800, color: t.textSecondary }}>Parameters</span>
        {parameters.length > 0 && <span style={{ fontSize: 9.5, color: t.textMuted }}>{parameters.length}</span>}
        {semantic && <span style={{ fontSize: 9.5, color: t.textMuted }}>New parameters bind to semantic filters with the same field name.</span>}
        <span style={{ flex: 1 }} />
        <button type="button" onClick={() => setAdding((value) => !value)} style={buttonStyle(t)}>
          {adding ? 'Cancel' : '+ Add'}
        </button>
      </div>

      {parameters.length > 0 && (
        <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
          {parameters.map((parameter) => (
            <div key={parameter.name} style={{ display: 'grid', gridTemplateColumns: 'minmax(110px, 1fr) 92px minmax(115px, 1.2fr) auto 92px auto', gap: 6, alignItems: 'center', overflowX: 'auto' }}>
              <span title="Parameter names are stable; remove and add again to rename." style={{ fontFamily: t.fontMono, fontSize: 10.5, color: t.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis' }}>{parameter.name}</span>
              <select aria-label={`${parameter.name} type`} value={parameter.type} onChange={(event) => update(parameter, { type: event.target.value as VisualBlockParameterType })} style={controlStyle(t)}>
                {TYPES.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
              <input
                aria-label={`${parameter.name} default`}
                value={visualParameterDefaultText(parameter)}
                disabled={parameter.required}
                placeholder={parameter.required ? 'Required at run time' : 'Default value'}
                onChange={(event) => update(parameter, { defaultText: event.target.value })}
                style={{ ...controlStyle(t), opacity: parameter.required ? 0.6 : 1 }}
              />
              <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 9.5, color: t.textMuted, whiteSpace: 'nowrap' }}>
                <input type="checkbox" checked={parameter.required} onChange={(event) => update(parameter, { required: event.target.checked })} /> Req
              </label>
              <select aria-label={`${parameter.name} policy`} value={parameter.policy} onChange={(event) => update(parameter, { policy: event.target.value as VisualBlockParameter['policy'] })} style={controlStyle(t)}>
                {POLICIES.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
              <button
                type="button"
                title={`Remove ${parameter.name}`}
                onClick={() => {
                  const withoutParameter = removeVisualBlockParameter(source, parameter.name);
                  onSourceChange(parameter.binding?.kind === 'semantic_filter'
                    ? setSemanticRuntimeFilters(withoutParameter, parseSemanticVisualFields(source).requestedFilters.filter((name) => name !== parameter.name))
                    : withoutParameter);
                }}
                style={removeButtonStyle(t)}
              >Remove</button>
            </div>
          ))}
        </div>
      )}

      {adding && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(110px, 1fr) 92px minmax(115px, 1.2fr) auto auto', gap: 6, alignItems: 'center', marginTop: 7 }}>
          <input aria-label="New parameter name" autoFocus value={name} placeholder={semantic ? 'semantic_field' : 'parameter_name'} onChange={(event) => { setName(event.target.value); if (!defaultText) setType(inferVisualParameterType('', event.target.value)); }} style={controlStyle(t)} />
          <select aria-label="New parameter type" value={type} onChange={(event) => setType(event.target.value as VisualBlockParameterType)} style={controlStyle(t)}>
            {TYPES.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <input
            aria-label="New parameter default"
            value={defaultText}
            disabled={required}
            placeholder={required ? 'Required at run time' : 'Default value'}
            onChange={(event) => {
              setDefaultText(event.target.value);
              setType(inferVisualParameterType(event.target.value, name));
            }}
            style={{ ...controlStyle(t), opacity: required ? 0.6 : 1 }}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9.5, color: t.textMuted, whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={required} onChange={(event) => setRequired(event.target.checked)} /> Required
          </label>
          <button type="button" disabled={!name.trim()} onClick={addParameter} style={{ ...buttonStyle(t), opacity: name.trim() ? 1 : 0.5 }}>Add</button>
        </div>
      )}
    </div>
  );
}

function controlStyle(t: Theme): React.CSSProperties {
  return {
    width: '100%', minWidth: 0, boxSizing: 'border-box',
    background: t.inputBg, border: `1px solid ${t.inputBorder}`, borderRadius: 5,
    color: t.textPrimary, padding: '4px 6px', fontSize: 10.5, fontFamily: t.font,
  };
}

function buttonStyle(t: Theme): React.CSSProperties {
  return {
    border: `1px solid ${t.btnBorder}`, borderRadius: 4, background: 'transparent',
    color: t.accent, padding: '2px 7px', fontSize: 10, fontWeight: 700, cursor: 'pointer',
  };
}

function removeButtonStyle(t: Theme): React.CSSProperties {
  return { ...buttonStyle(t), color: t.textMuted, paddingInline: 5 };
}
