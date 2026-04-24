import React, { useState } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import type { Cell, ParamConfig, ThemeMode } from '../../store/types';

interface ParamCellProps {
  cell: Cell;
  themeMode: ThemeMode;
  onApplyParam?: (paramName: string) => void;
}

export function ParamCell({ cell, themeMode, onApplyParam }: ParamCellProps) {
  const { dispatch } = useNotebook();
  const t = themes[themeMode];
  const [configOpen, setConfigOpen] = useState(false);

  const cfg: ParamConfig = cell.paramConfig ?? {
    paramType: 'text',
    label: 'Parameter',
    defaultValue: '',
    options: [],
  };

  const currentValue = cell.paramValue ?? cfg.defaultValue;

  const updateConfig = (patch: Partial<ParamConfig>) => {
    dispatch({
      type: 'UPDATE_CELL',
      id: cell.id,
      updates: { paramConfig: { ...cfg, ...patch } },
    });
  };

  const handleWidgetChange = (value: string) => {
    dispatch({ type: 'SET_PARAM_VALUE', id: cell.id, value });
  };

  const selectOptions = (cfg.options ?? [])
    .map((o) => o.trim())
    .filter(Boolean);

  const varRef = cell.name ? `{{${cell.name}}}` : null;

  return (
    <div
      style={{
        background: t.cellBg,
        border: `1px solid ${t.cellBorder}`,
        borderLeft: `3px solid ${t.warning}`,
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      {/* Config panel */}
      {configOpen && (
        <div
          style={{
            background: t.tableHeaderBg,
            borderBottom: `1px solid ${t.cellBorder}`,
            padding: '12px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 2,
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: '0.06em',
                color: t.warning,
                fontFamily: t.fontMono,
                textTransform: 'uppercase',
              }}
            >
              Configure Parameter
            </span>
            <button
              onClick={() => setConfigOpen(false)}
              title="Done"
              style={{
                background: t.warning,
                border: 'none',
                borderRadius: 5,
                cursor: 'pointer',
                color: '#000',
                fontSize: 11,
                fontWeight: 700,
                fontFamily: t.font,
                padding: '3px 10px',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              ✓ Done
            </button>
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' as const }}>
            {/* Name */}
            <label style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: '1 1 120px' }}>
              <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.font }}>
                Variable name
              </span>
              <input
                value={cell.name ?? ''}
                onChange={(e) =>
                  dispatch({
                    type: 'UPDATE_CELL',
                    id: cell.id,
                    updates: { name: e.target.value || undefined },
                  })
                }
                placeholder="e.g. start_date"
                style={{
                  background: t.inputBg,
                  border: `1px solid ${t.inputBorder}`,
                  borderRadius: 4,
                  color: t.textPrimary,
                  fontSize: 12,
                  fontFamily: t.fontMono,
                  padding: '4px 7px',
                  outline: 'none',
                }}
              />
            </label>

            {/* Label */}
            <label style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: '1 1 120px' }}>
              <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.font }}>
                Display label
              </span>
              <input
                value={cfg.label}
                onChange={(e) => updateConfig({ label: e.target.value })}
                placeholder="e.g. Start Date"
                style={{
                  background: t.inputBg,
                  border: `1px solid ${t.inputBorder}`,
                  borderRadius: 4,
                  color: t.textPrimary,
                  fontSize: 12,
                  fontFamily: t.font,
                  padding: '4px 7px',
                  outline: 'none',
                }}
              />
            </label>

            {/* Type */}
            <label style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: '1 1 100px' }}>
              <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.font }}>Type</span>
              <select
                value={cfg.paramType}
                onChange={(e) =>
                  updateConfig({ paramType: e.target.value as ParamConfig['paramType'] })
                }
                style={{
                  background: t.inputBg,
                  border: `1px solid ${t.inputBorder}`,
                  borderRadius: 4,
                  color: t.textPrimary,
                  fontSize: 12,
                  fontFamily: t.font,
                  padding: '4px 7px',
                  outline: 'none',
                }}
              >
                <option value="text">Text</option>
                <option value="number">Number</option>
                <option value="date">Date</option>
                <option value="select">Select</option>
              </select>
            </label>

            {/* Default value */}
            <label style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: '1 1 120px' }}>
              <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.font }}>
                Default value
              </span>
              <input
                type={cfg.paramType === 'number' ? 'number' : cfg.paramType === 'date' ? 'date' : 'text'}
                value={cfg.defaultValue}
                onChange={(e) => updateConfig({ defaultValue: e.target.value })}
                style={{
                  background: t.inputBg,
                  border: `1px solid ${t.inputBorder}`,
                  borderRadius: 4,
                  color: t.textPrimary,
                  fontSize: 12,
                  fontFamily: t.font,
                  padding: '4px 7px',
                  outline: 'none',
                }}
              />
            </label>
          </div>

          {/* Options textarea — only for select */}
          {cfg.paramType === 'select' && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.font }}>
                Options (one per line)
              </span>
              <textarea
                value={(cfg.options ?? []).join('\n')}
                onChange={(e) =>
                  updateConfig({ options: e.target.value.split('\n') })
                }
                rows={4}
                placeholder="Option A&#10;Option B&#10;Option C"
                style={{
                  background: t.inputBg,
                  border: `1px solid ${t.inputBorder}`,
                  borderRadius: 4,
                  color: t.textPrimary,
                  fontSize: 12,
                  fontFamily: t.fontMono,
                  padding: '5px 7px',
                  outline: 'none',
                  resize: 'vertical' as const,
                }}
              />
            </label>
          )}
        </div>
      )}

      {/* Widget panel */}
      <div
        style={{
          padding: '12px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap' as const,
        }}
      >
        {/* Gear toggle */}
        <button
          onClick={() => setConfigOpen((o) => !o)}
          title={configOpen ? 'Close config' : 'Configure parameter'}
          style={{
            background: configOpen ? `${t.warning}18` : 'transparent',
            border: `1px solid ${configOpen ? t.warning : t.cellBorder}`,
            borderRadius: 5,
            cursor: 'pointer',
            color: configOpen ? t.warning : t.textMuted,
            width: 26,
            height: 26,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            transition: 'all 0.15s',
          }}
        >
          {configOpen ? (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.749.749 0 1 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.103-.303c.644-.176 1.392.021 1.82.63.27.385.506.792.704 1.218.315.675.111 1.422-.364 1.891l-.814.806c-.049.048-.098.147-.088.294.016.257.016.515 0 .772-.01.147.038.246.088.294l.814.806c.475.469.679 1.216.364 1.891a7.977 7.977 0 0 1-.704 1.217c-.428.61-1.176.807-1.82.63l-1.102-.302c-.067-.019-.177-.011-.3.071a5.909 5.909 0 0 1-.668.386c-.133.066-.194.158-.211.224l-.29 1.106c-.168.646-.715 1.196-1.458 1.26a8.006 8.006 0 0 1-1.402 0c-.743-.064-1.289-.614-1.458-1.26l-.289-1.106c-.018-.066-.079-.158-.212-.224a5.738 5.738 0 0 1-.668-.386c-.123-.082-.233-.09-.299-.071l-1.103.303c-.644.176-1.392-.021-1.82-.63a8.12 8.12 0 0 1-.704-1.218c-.315-.675-.111-1.422.363-1.891l.815-.806c.05-.048.098-.147.088-.294a6.214 6.214 0 0 1 0-.772c.01-.147-.038-.246-.088-.294l-.815-.806C.635 6.045.431 5.298.746 4.623a7.92 7.92 0 0 1 .704-1.217c.428-.61 1.176-.807 1.82-.63l1.102.302c.067.019.177.011.3-.071.214-.143.437-.272.668-.386.133-.066.194-.158.211-.224l.29-1.106C6.009.645 6.556.095 7.299.03 7.53.01 7.764 0 8 0Zm-.571 1.525c-.036.003-.108.036-.137.146l-.289 1.105c-.147.561-.549.967-.998 1.189-.173.086-.34.183-.5.29-.417.278-.97.423-1.529.27l-1.103-.303c-.109-.03-.175.016-.195.045-.22.312-.412.644-.573.99-.014.031-.021.11.059.19l.815.806c.411.406.562.957.53 1.456a4.709 4.709 0 0 0 0 .582c.032.499-.119 1.05-.53 1.456l-.815.806c-.081.08-.073.159-.059.19.162.346.353.677.573.989.02.03.085.076.195.046l1.102-.303c.56-.153 1.113-.008 1.53.27.161.107.328.204.501.29.447.222.85.629.997 1.189l.289 1.105c.029.109.101.143.137.146a6.6 6.6 0 0 0 1.142 0c.036-.003.108-.036.137-.146l.289-1.105c.147-.561.549-.967.998-1.189.173-.086.34-.183.5-.29.417-.278.97-.423 1.529-.27l1.103.303c.109.029.175-.016.195-.045.22-.313.411-.644.573-.99.014-.031.021-.11-.059-.19l-.815-.806c-.411-.406-.562-.957-.53-1.456a4.709 4.709 0 0 0 0-.582c-.032-.499.119-1.05.53-1.456l.815-.806c.081-.08.073-.159.059-.19a6.464 6.464 0 0 0-.573-.989c-.02-.03-.085-.076-.195-.046l-1.102.303c-.56.153-1.113.008-1.53-.27a4.44 4.44 0 0 0-.501-.29c-.447-.222-.85-.629-.997-1.189l-.289-1.105c-.029-.11-.101-.143-.137-.146a6.6 6.6 0 0 0-1.142 0ZM8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM8 7a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z" />
            </svg>
          )}
        </button>

        {/* Label */}
        <span
          style={{
            fontSize: 13,
            fontWeight: 500,
            fontFamily: t.font,
            color: t.textSecondary,
            flexShrink: 0,
          }}
        >
          {cfg.label}
        </span>

        {/* Widget */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {cfg.paramType === 'select' ? (
            <select
              value={currentValue}
              onChange={(e) => handleWidgetChange(e.target.value)}
              style={{
                background: t.inputBg,
                border: `1px solid ${t.inputBorder}`,
                borderRadius: 5,
                color: t.textPrimary,
                fontSize: 13,
                fontFamily: t.font,
                padding: '5px 10px',
                outline: 'none',
                minWidth: 160,
              }}
            >
              {selectOptions.length === 0 ? (
                <option value="">— no options configured —</option>
              ) : (
                selectOptions.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))
              )}
            </select>
          ) : (
            <input
              type={cfg.paramType}
              value={currentValue}
              onChange={(e) => handleWidgetChange(e.target.value)}
              style={{
                background: t.inputBg,
                border: `1px solid ${t.inputBorder}`,
                borderRadius: 5,
                color: t.textPrimary,
                fontSize: 13,
                fontFamily: cfg.paramType === 'number' ? t.fontMono : t.font,
                padding: '5px 10px',
                outline: 'none',
                minWidth: 160,
              }}
            />
          )}

          {varRef && (
            <span
              style={{
                fontSize: 10,
                fontFamily: t.fontMono,
                color: t.warning,
                opacity: 0.8,
              }}
            >
              {varRef}
            </span>
          )}
        </div>

        {/* Current value badge */}
        {currentValue && (
          <span
            style={{
              fontSize: 12,
              fontFamily: t.fontMono,
              color: t.textPrimary,
              background: `${t.warning}18`,
              border: `1px solid ${t.warning}40`,
              borderRadius: 4,
              padding: '2px 8px',
              flexShrink: 0,
            }}
          >
            {currentValue}
          </span>
        )}

        {/* Apply button — re-runs downstream cells that reference this param */}
        {cell.name && onApplyParam && (
          <button
            onClick={() => onApplyParam(cell.name!)}
            title={`Re-run cells that use {{${cell.name}}}`}
            style={{
              background: t.warning,
              border: 'none',
              borderRadius: 5,
              cursor: 'pointer',
              color: '#000',
              fontSize: 11,
              fontWeight: 600,
              fontFamily: t.font,
              padding: '4px 12px',
              flexShrink: 0,
              transition: 'opacity 0.15s',
            }}
          >
            Apply
          </button>
        )}
      </div>
    </div>
  );
}
