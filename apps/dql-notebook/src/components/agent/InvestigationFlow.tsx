/**
 * "How it was researched": the investigation's programs in order, each with
 * its outcome, time and the queries it ran. A query opens into the same "How
 * it was answered" an Ask answer has, from that query's own receipt.
 */
import { useState } from 'react';
import { Check, ChevronDown, ChevronRight, Minus, X } from 'lucide-react';
import type { Theme } from '../../themes/notebook-theme';
import { AskRunFlow } from './AskRunFlow';
import { formatRunMs } from './ask-run-explanation';
import type { InvestigationExplanation, InvestigationProgramOutcome } from './investigation-view';

const PROGRAM_OUTCOME_WORDS: Record<InvestigationProgramOutcome, string> = { done: 'Done', skipped: 'Skipped', failed: 'Failed', not_reached: 'Not reached' };

const BASIS_WORDS: Record<string, string> = {
  stated: 'the periods the question named',
  latest_complete: 'the latest complete period in the data',
  source_run: 'the periods the earlier answer read',
  shifted_to_data: 'the latest complete period, because the question asked about a period after the data ends',
};

const STOP_WORDS: Record<string, string> = {
  budget: 'It used its query budget before it finished.',
  deadline: 'It ran out of time before it finished.',
  cancelled: 'It was stopped before it finished.',
};

export function InvestigationFlow({ explanation, t, onOpenTrace }: { explanation: InvestigationExplanation; t: Theme; onOpenTrace?: () => void }): JSX.Element {
  const [openPrograms, setOpenPrograms] = useState<Record<string, boolean>>(() => Object.fromEntries(explanation.programs.filter((program) => program.outcome === 'failed').map((program) => [program.id, true])));
  const [openQuery, setOpenQuery] = useState<string>();
  const { budget } = explanation;
  const summary = [
    explanation.totalMs !== undefined ? `Worked for ${formatRunMs(explanation.totalMs) || 'under a second'}` : '',
    `${explanation.programs.length} step${explanation.programs.length === 1 ? '' : 's'}`,
    budget.statementsCap ? `${budget.statementsUsed} of ${budget.statementsCap} queries` : '',
    budget.aiCalls ? `${budget.aiCalls} AI call${budget.aiCalls === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ');

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'grid', gap: 4 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: t.textPrimary }}>How it was researched</div>
        <div style={{ fontSize: 11.5, color: t.textMuted }}>{summary}</div>
        {explanation.reading ? <div style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.45 }}>Read as: {explanation.reading}</div> : null}
        {explanation.periods?.current ? (
          <div style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.45 }}>
            Compared {explanation.periods.current} with {explanation.periods.prior} and {explanation.periods.yearAgo}, {BASIS_WORDS[explanation.windowBasis ?? 'stated'] ?? BASIS_WORDS.stated}.
          </div>
        ) : null}
        {budget.stoppedBy ? <div role="status" style={{ fontSize: 11.5, color: t.warning }}>{STOP_WORDS[budget.stoppedBy] ?? 'It did not finish.'}</div> : null}
      </div>

      <ol aria-label="Research steps" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
        {explanation.programs.map((program) => {
          const open = Boolean(openPrograms[program.id]);
          const color = program.outcome === 'failed' ? t.error : program.outcome === 'done' ? t.success : t.textMuted;
          return (
            <li key={program.id} style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '8px 10px', display: 'grid', gap: 6 }}>
              <button
                type="button"
                className="dql-hover"
                aria-expanded={open}
                onClick={() => setOpenPrograms((current) => ({ ...current, [program.id]: !current[program.id] }))}
                style={{ display: 'grid', gridTemplateColumns: '20px 16px minmax(0, 1fr) auto', alignItems: 'center', gap: 8, background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', fontFamily: t.font }}
              >
                <span style={{ fontSize: 11, color: t.textMuted, fontVariantNumeric: 'tabular-nums' }}>{program.n}.</span>
                <span aria-hidden="true" style={{ color, display: 'inline-flex' }}>
                  {program.outcome === 'done' ? <Check size={12} /> : program.outcome === 'failed' ? <X size={12} /> : <Minus size={12} />}
                </span>
                <span style={{ fontSize: 12.5, color: t.textPrimary, display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
                  {program.title}
                  {program.queries.length || program.reason ? (open ? <ChevronDown size={11} /> : <ChevronRight size={11} />) : null}
                </span>
                <span style={{ fontSize: 10.5, color: t.textMuted }}>{[PROGRAM_OUTCOME_WORDS[program.outcome], formatRunMs(program.ms)].filter(Boolean).join(' · ')}</span>
              </button>
              {open && program.reason ? <div style={{ fontSize: 11.5, color: t.textSecondary, lineHeight: 1.45, paddingLeft: 44 }}>{program.reason}</div> : null}
              {open && program.queries.length ? (
                <ul style={{ listStyle: 'none', margin: 0, padding: '0 0 0 44px', display: 'grid', gap: 6 }}>
                  {program.queries.map((query) => (
                    <li key={query.id} style={{ display: 'grid', gap: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 12, color: t.textSecondary }}>{query.label}</span>
                        <span style={{ fontSize: 10.5, color: t.textMuted }}>{[query.tier, query.outcome === 'answered' ? 'ran' : query.outcome].filter(Boolean).join(' · ')}</span>
                        {query.explanation ? (
                          <button
                            type="button"
                            className="dql-hover"
                            aria-expanded={openQuery === query.id}
                            onClick={() => setOpenQuery((current) => (current === query.id ? undefined : query.id))}
                            style={{ fontSize: 11, color: t.accent, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: t.font }}
                          >
                            {openQuery === query.id ? 'Hide how this query ran' : 'How this query ran'}
                          </button>
                        ) : null}
                      </div>
                      {openQuery === query.id && query.explanation ? (
                        <div style={{ borderLeft: '2px solid var(--border-default)', paddingLeft: 10 }}>
                          <AskRunFlow explanation={query.explanation} t={t} />
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ol>

      {explanation.contextSources.length ? (
        <div style={{ fontSize: 11.5, color: t.textMuted }}>
          Context sources: {explanation.contextSources.map((source) => `${source.id} (${source.error ? 'unavailable' : `${source.items} item${source.items === 1 ? '' : 's'}`})`).join(', ')}
        </div>
      ) : null}

      {onOpenTrace ? (
        <button type="button" className="dql-hover" onClick={onOpenTrace} style={{ justifySelf: 'start', fontSize: 11.5, color: t.accent, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: t.font }}>
          Open the full trace
        </button>
      ) : null}
    </div>
  );
}
