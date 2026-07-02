import React from 'react';
import { X } from 'lucide-react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { UnifiedAgentRunPanel } from './UnifiedAgentRunPanel';
import type { AgentRunSelectedObject } from '../../api/client';

/**
 * The global, context-aware stakeholder copilot rail. Mounted once at the shell
 * so follow-ups work across Apps and Research; opened with the active object's
 * context (e.g. a selected dashboard tile) via the OPEN_GLOBAL_AI action.
 */
export function GlobalAiRail() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const { audience, context } = state.globalAi;
  const selectedObject = context.selectedObject as AgentRunSelectedObject | undefined;

  return (
    <aside
      style={{
        width: 380,
        maxWidth: '42vw',
        minWidth: 320,
        borderLeft: `1px solid ${t.headerBorder}`,
        background: t.cellBg,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', borderBottom: `1px solid ${t.headerBorder}` }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: t.textSecondary }}>
          {context.title ?? 'AI copilot'}
        </span>
        <button
          type="button"
          aria-label="Close copilot"
          onClick={() => dispatch({ type: 'CLOSE_GLOBAL_AI' })}
          style={{ border: 'none', background: 'transparent', color: t.textMuted, cursor: 'pointer', display: 'inline-flex', padding: 4, borderRadius: 6 }}
        >
          <X size={15} />
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <UnifiedAgentRunPanel
          themeMode={state.themeMode}
          title={context.title ?? 'AI copilot'}
          scopeHint={context.scopeHint ?? 'Ask a follow-up about what you are viewing'}
          audience={audience}
          selectedObject={selectedObject}
          workspaceContext={context.workspaceContext}
          examplePrompts={Array.isArray(context.suggestedQuestions) && context.suggestedQuestions.length > 0
            ? context.suggestedQuestions
                .filter((question): question is string => typeof question === 'string')
                .slice(0, 4)
                .map((question) => ({ label: question, prompt: question }))
            : undefined}
          autoRun={state.globalAi.autoRun
            ? { text: state.globalAi.autoRun.text, mode: state.globalAi.autoRun.mode as never, nonce: state.globalAi.autoRun.nonce }
            : undefined}
          initialMode="auto"
        />
      </div>
    </aside>
  );
}
