import React from 'react';
import { Sparkles } from 'lucide-react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { UnifiedAgentRunPanel } from '../agent/UnifiedAgentRunPanel';

/**
 * Analytics Home — the stakeholder ChatGPT-style entry. Text→SQL questions run
 * through the governed agent loop; answers, research reports, and app drafts render
 * as rich messages. Authoring stays in the Notebook; this surface is consumption.
 */
export function AnalyticsHome() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];

  const openResearch = (researchRunId: string, notebookPath?: string) => {
    dispatch({
      type: 'OPEN_GLOBAL_AI',
      audience: 'stakeholder',
      context: {
        title: 'Research',
        scopeHint: 'Follow up on this research',
        selectedObject: { kind: 'research', id: researchRunId, path: notebookPath },
      },
    });
  };

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: t.appBg }}>
      <div style={{ padding: '16px 24px 10px', borderBottom: `1px solid ${t.headerBorder}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: `${t.accent}14`, border: `1px solid ${t.accent}36`, color: t.accent, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
            <Sparkles size={16} />
          </div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: t.textPrimary }}>Ask your data</div>
            <div style={{ fontSize: 12.5, color: t.textMuted, marginTop: 2 }}>
              Governed answers, deep research, and apps — grounded in your certified metrics and dbt lineage.
            </div>
          </div>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', justifyContent: 'center' }}>
        <div style={{ width: 'min(860px, 100%)', minHeight: 0, display: 'flex' }}>
          <UnifiedAgentRunPanel
            themeMode={state.themeMode}
            title="Analytics copilot"
            scopeHint="Ask a question, request research, or build an app"
            audience="stakeholder"
            initialMode="auto"
            onOpenResearch={openResearch}
          />
        </div>
      </div>
    </div>
  );
}
