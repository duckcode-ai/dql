/**
 * A Research investigation, as a report: whether the metric changed, the
 * figures for each period, how sure the investigation is and why, what limits
 * the figures, and the queries every figure came from.
 */
import type React from 'react';
import type { QueryResult } from '../../store/types';
import type { Theme, ThemeMode } from '../../themes/notebook-theme';
import { ResultView } from '../output/ResultView';
import type { InvestigationConfidence, InvestigationReportView, InvestigationVerdict } from './investigation-view';

export const INVESTIGATION_VERDICT_WORDS: Record<InvestigationVerdict, string> = {
  change: 'Changed',
  no_material_change: 'No material change',
  seasonal: 'Seasonal',
  no_data: 'No data',
  incomplete: 'Stopped early',
};

export const INVESTIGATION_CONFIDENCE_WORDS: Record<InvestigationConfidence, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
};

const pill = (color: string, t: Theme): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 999,
  fontSize: 11, fontWeight: 650, color, border: `1px solid ${color}40`, background: `${color}12`, fontFamily: t.font,
});

function Figure({ label, value, t, tone, emphasis }: { label: string; value: string; t: Theme; tone?: 'up' | 'down'; emphasis?: boolean }): JSX.Element {
  return (
    <div style={{ display: 'grid', gap: 2, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-2)', minWidth: 0 }}>
      <span style={{ fontSize: 10.5, color: t.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ fontSize: emphasis ? 16 : 14, fontWeight: emphasis ? 700 : 620, fontVariantNumeric: 'tabular-nums', color: tone === 'down' ? t.error : tone === 'up' ? t.success : t.textPrimary }}>{value}</span>
    </div>
  );
}

const signedPercent = (pct: string | undefined) => (pct === undefined ? '' : ` (${Number(pct) > 0 ? '+' : ''}${pct}%)`);

export function InvestigationReport({ report, t, themeMode, onOpenQuery }: {
  report: InvestigationReportView;
  t: Theme;
  themeMode: ThemeMode;
  onOpenQuery?: (queryId: string) => void;
}): JSX.Element {
  const { headline, periods, confidence } = report;
  const confidenceColor = confidence.level === 'high' ? t.success : confidence.level === 'medium' ? t.warning : t.error;
  const verdictColor = headline.verdict === 'change' ? t.accent : headline.verdict === 'no_data' || headline.verdict === 'incomplete' ? t.warning : t.textSecondary;
  const falling = headline.delta?.value.trim().startsWith('-');
  // The trend is drawn when it is one period column and one value column; a
  // ratio's parts are read in the table instead.
  const trend: QueryResult | undefined = report.trend && report.trend.columns.length === 2 && report.trend.rows.length > 1
    ? {
      columns: report.trend.columns,
      rows: report.trend.rows,
      rowCount: report.trend.rows.length,
      ...(report.trend.columnsMeta ? { columnsMeta: report.trend.columnsMeta as unknown as NonNullable<QueryResult['columnsMeta']> } : {}),
    }
    : undefined;
  const labelOf = (queryId: string) => report.queries.find((query) => query.id === queryId)?.label ?? queryId;

  return (
    <section aria-label="Investigation report" style={{ display: 'grid', gap: 10, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={pill(verdictColor, t)}>{INVESTIGATION_VERDICT_WORDS[headline.verdict]}</span>
        <span style={pill(confidenceColor, t)} title={confidence.reasons.join('; ') || undefined}>{INVESTIGATION_CONFIDENCE_WORDS[confidence.level]}</span>
        <span style={{ fontSize: 11, color: t.textMuted }}>
          Review required{report.lane === 'ai' ? ' · figures from AI-written SQL' : ''}
        </span>
      </div>

      {headline.current || headline.prior ? (
        <div role="group" aria-label={`${headline.metricLabel} by period`} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(118px, 1fr))', gap: 8 }}>
          {headline.current ? <Figure label={periods.current} value={headline.current.formatted} t={t} emphasis /> : null}
          {headline.prior ? <Figure label={periods.prior} value={headline.prior.formatted} t={t} /> : null}
          {headline.delta ? <Figure label="Change" value={`${headline.delta.formatted}${signedPercent(headline.pct)}`} t={t} tone={falling ? 'down' : 'up'} /> : null}
          {headline.yearAgo ? <Figure label={periods.yearAgo} value={`${headline.yearAgo.formatted}`} t={t} /> : null}
        </div>
      ) : null}

      {trend ? (
        <ResultView result={trend} themeMode={themeMode} t={t} embedded tabLabels={{ chart: 'Trend', table: 'Table' }} contentMaxHeight={220} />
      ) : null}

      {report.caveats.length ? (
        <ul aria-label="What limits these figures" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 5 }}>
          {report.caveats.map((caveat, index) => (
            <li key={`${caveat.code}-${index}`} style={{ fontSize: 11.5, lineHeight: 1.45, color: t.textSecondary, borderLeft: `2px solid ${t.warning}`, paddingLeft: 8 }}>
              {caveat.text}
            </li>
          ))}
        </ul>
      ) : null}

      {confidence.reasons.length ? (
        <div style={{ fontSize: 11, lineHeight: 1.45, color: t.textMuted }}>
          {INVESTIGATION_CONFIDENCE_WORDS[confidence.level]} because {confidence.reasons.join('; ')}.
        </div>
      ) : null}

      {onOpenQuery && headline.queryIds.length ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: t.textMuted }}>Evidence</span>
          {headline.queryIds.map((queryId) => (
            <button
              key={queryId}
              type="button"
              className="dql-hover"
              onClick={() => onOpenQuery(queryId)}
              style={{ fontSize: 11, color: t.accent, background: 'none', border: '1px solid var(--border-default)', borderRadius: 999, padding: '2px 8px', cursor: 'pointer', fontFamily: t.font }}
            >
              {labelOf(queryId)}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
