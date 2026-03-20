import React, { useState } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import type { SidebarPanel } from '../../store/types';

interface IconButtonProps {
  title: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  t: (typeof themes)['dark'];
}

function IconButton({ title, active, onClick, children, t }: IconButtonProps) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 32,
        height: 32,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        border: 'none',
        borderLeft: active ? `2px solid ${t.accent}` : '2px solid transparent',
        cursor: 'pointer',
        color: active ? t.textPrimary : hovered ? t.textSecondary : t.textMuted,
        transition: 'color 0.15s, border-color 0.15s',
        padding: 0,
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}

// SVG icons
function FilesIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
    </svg>
  );
}

function SchemaIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 0C3.58 0 0 1.567 0 3.5v9C0 14.433 3.58 16 8 16s8-1.567 8-3.5v-9C16 1.567 12.42 0 8 0ZM1.5 7.784V5.716C3.05 6.51 5.404 7 8 7s4.95-.49 6.5-1.284v2.068C12.95 8.578 10.596 9 8 9s-4.95-.422-6.5-1.216ZM8 1.5c3.17 0 5.854 1.116 6.357 2.5H1.643C2.146 2.616 4.83 1.5 8 1.5Zm0 13c-3.17 0-5.854-1.116-6.357-2.5h12.714C13.854 13.384 11.17 14.5 8 14.5Zm6.5-3.284C12.95 11.01 10.596 11.5 8 11.5s-4.95-.49-6.5-1.284V8.216C3.05 9.01 5.404 9.5 8 9.5s4.95-.49 6.5-1.284v2.5Z" />
    </svg>
  );
}

function OutlineIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M2 2h12a1 1 0 0 1 0 2H2a1 1 0 0 1 0-2Zm0 4h8a1 1 0 0 1 0 2H2a1 1 0 0 1 0-2Zm0 4h10a1 1 0 0 1 0 2H2a1 1 0 0 1 0-2Z" />
    </svg>
  );
}

function HelpIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.92 6.085h.001a.749.749 0 1 1-1.342-.67C6.03 4.26 6.88 3.75 8 3.75c1.463 0 2.5 1.008 2.5 2.25 0 1.133-.67 1.8-1.4 2.25-.487.3-.6.47-.6.75V9.5a.75.75 0 0 1-1.5 0v-.5c0-.833.585-1.33 1.1-1.65.387-.24.9-.597.9-1.35 0-.65-.53-1.25-1.5-1.25-.74 0-1.163.353-1.58.835ZM8 12a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.103-.303c.644-.176 1.392.021 1.82.63.27.385.506.792.704 1.218.315.675.111 1.422-.364 1.891l-.814.806c-.049.048-.098.147-.088.294.016.257.016.515 0 .772-.01.147.038.246.088.294l.814.806c.475.469.679 1.216.364 1.891a7.977 7.977 0 0 1-.704 1.217c-.428.61-1.176.807-1.82.63l-1.103-.303c-.066-.019-.176-.011-.299.071a5.909 5.909 0 0 1-.668.386c-.133.066-.194.158-.211.224l-.29 1.106c-.168.646-.715 1.196-1.458 1.26a8.006 8.006 0 0 1-1.402 0c-.743-.064-1.289-.614-1.458-1.26l-.289-1.106c-.018-.066-.079-.158-.212-.224a5.738 5.738 0 0 1-.668-.386c-.123-.082-.233-.09-.299-.071l-1.103.303c-.644.176-1.392-.021-1.82-.63a8.12 8.12 0 0 1-.704-1.218c-.315-.675-.111-1.422.363-1.891l.815-.806c.05-.048.098-.147.088-.294a6.214 6.214 0 0 1 0-.772c.01-.147-.038-.246-.088-.294l-.815-.806C.635 6.045.431 5.298.746 4.623a7.92 7.92 0 0 1 .704-1.217c.428-.61 1.176-.807 1.82-.63l1.103.303c.066.019.176.011.299-.071.214-.143.437-.272.668-.386.133-.066.194-.158.211-.224l.29-1.106C6.009.645 6.556.095 7.299.03 7.53.01 7.764 0 8 0Zm-.571 1.525c-.036.003-.108.036-.137.146l-.289 1.105c-.147.561-.549.967-.998 1.189-.173.086-.34.183-.5.29-.417.278-.97.423-1.529.27l-1.103-.303c-.109-.03-.175.016-.195.045-.22.312-.412.644-.573.99-.014.031-.021.11.059.19l.815.806c.411.406.562.957.53 1.456a4.709 4.709 0 0 0 0 .582c.032.499-.119 1.05-.53 1.456l-.815.806c-.081.08-.073.159-.059.19.162.346.353.677.573.989.02.03.085.076.195.046l1.102-.303c.56-.153 1.113-.008 1.53.27.161.107.328.204.501.29.447.222.85.629.997 1.189l.289 1.105c.029.109.101.143.137.146a6.6 6.6 0 0 0 1.142 0c.036-.003.108-.036.137-.146l.289-1.105c.147-.561.549-.967.998-1.189.173-.086.34-.183.5-.29.417-.278.97-.423 1.529-.27l1.103.303c.109.029.175-.016.195-.045.22-.313.411-.644.573-.99.014-.031.021-.11-.059-.19l-.815-.806c-.411-.406-.562-.957-.53-1.456a4.709 4.709 0 0 0 0-.582c-.032-.499.119-1.05.53-1.456l.815-.806c.081-.08.073-.159.059-.19a6.464 6.464 0 0 0-.573-.989c-.02-.03-.085-.076-.195-.046l-1.102.303c-.56.153-1.113.008-1.53-.27a4.44 4.44 0 0 0-.501-.29c-.447-.222-.85-.629-.997-1.189l-.289-1.105c-.029-.11-.101-.143-.137-.147a6.6 6.6 0 0 0-1.142 0ZM8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM8 7a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z" />
    </svg>
  );
}

export function ActivityBar() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];

  function handlePanelClick(panel: SidebarPanel) {
    if (state.sidebarPanel === panel && state.sidebarOpen) {
      dispatch({ type: 'TOGGLE_SIDEBAR' });
    } else {
      dispatch({ type: 'SET_SIDEBAR_PANEL', panel });
    }
  }

  return (
    <div
      style={{
        width: 32,
        flexShrink: 0,
        background: t.activityBarBg,
        borderRight: `1px solid ${t.headerBorder}`,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        paddingTop: 8,
        paddingBottom: 8,
        gap: 2,
        userSelect: 'none',
      }}
    >
      <IconButton
        title="Files"
        active={state.sidebarPanel === 'files' && state.sidebarOpen}
        onClick={() => handlePanelClick('files')}
        t={t}
      >
        <FilesIcon />
      </IconButton>

      <IconButton
        title="Schema"
        active={state.sidebarPanel === 'schema' && state.sidebarOpen}
        onClick={() => handlePanelClick('schema')}
        t={t}
      >
        <SchemaIcon />
      </IconButton>

      <IconButton
        title="Outline"
        active={state.sidebarPanel === 'outline' && state.sidebarOpen}
        onClick={() => handlePanelClick('outline')}
        t={t}
      >
        <OutlineIcon />
      </IconButton>

      {/* Spacer pushes remaining items to bottom */}
      <div style={{ flex: 1 }} />

      <IconButton
        title="Help"
        active={false}
        onClick={() => {}}
        t={t}
      >
        <HelpIcon />
      </IconButton>

      <IconButton
        title="Settings"
        active={false}
        onClick={() => {}}
        t={t}
      >
        <SettingsIcon />
      </IconButton>
    </div>
  );
}
