import { useState, useRef, useEffect } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { api, type AppDocumentSummary } from '../../api/client';

/**
 * Persona switcher — top-right dropdown that lets the local owner preview
 * the current App as a different member. Drives `activePersona` in the
 * store and on the server (which feeds RLS template variables into block
 * execution).
 */
export function PersonaSwitcher({ app }: { app: AppDocumentSummary['app'] | null }): JSX.Element {
  const { state, dispatch } = useNotebook();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const label = state.activePersona
    ? `${state.activePersona.displayName ?? state.activePersona.userId} [${state.activePersona.roles.join(', ')}]`
    : 'View as: Owner';

  if (!app || app.members.length === 0) {
    return (
      <span style={{ fontSize: 12, opacity: 0.6 }}>
        {label}
      </span>
    );
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          padding: '6px 12px',
          fontSize: 12,
          background: 'var(--surface, rgba(0,0,0,0.04))',
          border: '1px solid var(--border-color, rgba(0,0,0,0.1))',
          borderRadius: 6,
          cursor: 'pointer',
          color: 'inherit',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
        }}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span style={{ fontSize: 11, opacity: 0.65 }}>View as:</span>
        <span style={{ fontWeight: 600 }}>
          {state.activePersona?.displayName ?? state.activePersona?.userId ?? 'Owner'}
        </span>
        {state.activePersona && (
          <span style={{ fontSize: 11, opacity: 0.7 }}>
            [{state.activePersona.roles.join(', ')}]
          </span>
        )}
        <span style={{ fontSize: 10, opacity: 0.6 }}>▾</span>
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            minWidth: 240,
            background: 'var(--surface-elevated, #fff)',
            border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
            borderRadius: 6,
            boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
            zIndex: 50,
          }}
        >
          <button
            role="menuitem"
            onClick={async () => {
              await api.clearPersona();
              dispatch({ type: 'SET_ACTIVE_PERSONA', persona: null });
              setOpen(false);
            }}
            style={menuItemStyle(state.activePersona === null)}
          >
            <div style={{ fontWeight: 500 }}>Owner (local)</div>
            <div style={{ fontSize: 11, opacity: 0.65 }}>Default — no RLS narrowing</div>
          </button>
          <div style={{ height: 1, background: 'var(--border-color, rgba(0,0,0,0.08))', margin: '4px 0' }} />
          {app.members.map((m) => (
            <button
              key={m.userId}
              role="menuitem"
              onClick={async () => {
                const persona = await api.setPersona(m.userId, app.id);
                dispatch({ type: 'SET_ACTIVE_PERSONA', persona });
                setOpen(false);
              }}
              style={menuItemStyle(state.activePersona?.userId === m.userId)}
            >
              <div style={{ fontWeight: 500 }}>{m.displayName ?? m.userId}</div>
              <div style={{ fontSize: 11, opacity: 0.65 }}>
                [{m.roles.join(', ')}]
                {m.attributes && Object.keys(m.attributes).length > 0
                  ? ` · ${Object.entries(m.attributes).map(([k, v]) => `${k}=${v}`).join(', ')}`
                  : ''}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function menuItemStyle(active: boolean): React.CSSProperties {
  return {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    padding: '8px 12px',
    background: active ? 'var(--surface-hover, rgba(0,0,0,0.06))' : 'transparent',
    border: 'none',
    cursor: 'pointer',
    color: 'inherit',
    fontSize: 13,
  };
}
