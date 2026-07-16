import { useState } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { UnifiedAgentRunPanel, usePersistedAgentThreadId } from './UnifiedAgentRunPanel';
import type { AgentRunSelectedObject } from '../../api/client';
import { AiSidePanel, AI_SIDE_PANEL_EXPANDED_WIDTH, AI_SIDE_PANEL_WIDTH } from './AiSidePanel';

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
  // One rolling server-persisted conversation for the global rail — a page
  // refresh resumes the same thread.
  const agentThread = usePersistedAgentThreadId('global-rail');
  const [expanded, setExpanded] = useState(false);

  return (
    <AiSidePanel
      t={t}
      title={context.title ?? 'AI copilot'}
      subtitle={context.scopeHint ?? 'Ask a follow-up about what you are viewing'}
      expanded={expanded}
      onToggleExpanded={() => setExpanded((value) => !value)}
      onClose={() => dispatch({ type: 'CLOSE_GLOBAL_AI' })}
      ariaLabel="App AI"
      style={{
        width: expanded
          ? `min(${AI_SIDE_PANEL_EXPANDED_WIDTH}px, calc(100vw - 96px))`
          : `min(${AI_SIDE_PANEL_WIDTH}px, calc(100vw - 64px))`,
        maxWidth: expanded ? '62vw' : '46vw',
        minWidth: 320,
        flex: '0 0 auto',
      }}
    >
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
        threadId={agentThread.threadId}
        onThreadIdChange={agentThread.onThreadIdChange}
        initialMode="auto"
      />
    </AiSidePanel>
  );
}
