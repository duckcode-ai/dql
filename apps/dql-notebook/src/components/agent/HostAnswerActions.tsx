import { useState } from 'react';
import type { AgentRun } from '../../api/client';
import { runHostAnswerAction, useHostUi } from '../../host/host-ui';
import type { Theme } from '../../themes/notebook-theme';

/** Whether an answer needs a person's review before anyone relies on it. */
export function answerNeedsReview(run: Pick<AgentRun, 'status' | 'trustState'>): boolean {
  return run.status === 'needs_review' || run.trustState === 'review_required';
}

/**
 * The host's actions on an answer that needs review (RFC 0010 HH-9), e.g.
 * "Make this a certified answer" or "Ask an analyst to check this". Nothing
 * without a host, or on answers that are already certified or governed.
 */
export function HostAnswerActions({ run, t }: { run: AgentRun; t: Theme }) {
  const hostUi = useHostUi();
  const [sending, setSending] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  if (!hostUi.host || !hostUi.answerActions.length || !answerNeedsReview(run)) return null;

  return (
    <div style={{ display: 'grid', gap: 6, padding: '8px 10px', border: `1px solid ${t.cellBorder}`, borderRadius: 8, background: t.cellBg }} data-testid="host-answer-actions">
      <span style={{ fontSize: 11.5, color: t.textSecondary }}>No certified source answers this yet.</span>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {hostUi.answerActions.map((action, index) => (
          <button
            key={action.id}
            type="button"
            className="dql-hover"
            disabled={sending !== null}
            title={action.description}
            onClick={async () => {
              setSending(action.id);
              setMessage(null);
              try {
                const text = await runHostAnswerAction(action, { runId: run.id, question: run.question, ...(run.trustState ? { trustState: run.trustState } : {}) });
                setMessage({ text, failed: false });
              } catch (error) {
                setMessage({ text: error instanceof Error ? error.message : 'The request was not sent.', failed: true });
              } finally {
                setSending(null);
              }
            }}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 6, cursor: 'pointer',
              fontSize: 12, fontFamily: t.font, fontWeight: 600,
              border: `1px solid ${index === 0 ? t.accent : t.cellBorder}`,
              background: index === 0 ? t.accent : 'transparent',
              color: index === 0 ? '#fff' : t.textPrimary,
            }}
          >
            {sending === action.id ? 'Sending…' : action.label}
          </button>
        ))}
      </div>
      {message ? <span role="status" style={{ fontSize: 12, color: message.failed ? t.error : t.textSecondary }}>{message.text}</span> : null}
    </div>
  );
}
