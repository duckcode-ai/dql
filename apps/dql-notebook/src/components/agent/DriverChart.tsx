/**
 * Drivers as bars: each one's name, its value and a line of explanation, the
 * bars scaled to the largest value. Shared by the Research report card and the
 * App research panel; the styles are inline so it reads the same in both.
 */

export interface DriverChartItem { title: string; value: string; explanation: string }

const DEFAULT_EMPTY_MESSAGE = 'No ranked drivers are available yet. Refresh the report after adding a clearer metric, time grain, or comparison group.';

/** The first number in a value as written ("+12.4%", "1,204 orders"). */
export function numberFromReportValue(value: string): number {
  const match = value.replace(/,/g, '').match(/-?\+?\d+(?:\.\d+)?/);
  if (!match) return 0;
  const number = Number(match[0].replace(/^\+/, ''));
  return Number.isFinite(number) ? number : 0;
}

export function DriverChart({ drivers, emptyMessage = DEFAULT_EMPTY_MESSAGE, limit = 6 }: {
  drivers: DriverChartItem[];
  /** Shown when there are no drivers; an empty string shows nothing. */
  emptyMessage?: string;
  limit?: number;
}): JSX.Element | null {
  if (!drivers.length) return emptyMessage ? <p className="dql-app-report-muted">{emptyMessage}</p> : null;
  const rows = drivers.slice(0, limit).map((driver) => ({ ...driver, numericValue: Math.abs(numberFromReportValue(driver.value)) }));
  const maxValue = Math.max(...rows.map((row) => row.numericValue), 0);
  return (
    <div className="dql-app-report-driver-chart" aria-label="Report driver chart" style={{ display: 'grid', gap: 12 }}>
      {rows.map((driver, index) => {
        const width = maxValue > 0 ? Math.max(8, Math.round((driver.numericValue / maxValue) * 100)) : 28;
        return (
          <div key={`${driver.title}-${index}`} className="dql-app-report-driver-bar" style={{ display: 'grid', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, minWidth: 0 }}>
              <b title={driver.title} style={{ minWidth: 0, color: 'var(--dql-app-ink, var(--color-text-primary))', fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{driver.title}</b>
              <span style={{ flex: 'none', color: 'var(--dql-app-accent, var(--color-accent-blue))', font: '800 11px var(--font-mono, ui-monospace, monospace)' }}>{driver.value}</span>
            </div>
            <i style={{ display: 'block', width: `${width}%`, minWidth: 28, height: 8, borderRadius: 999, background: 'linear-gradient(90deg, var(--dql-app-accent, var(--color-accent-blue)), rgba(79, 99, 215, 0.42))' }} />
            <p style={{ margin: 0, color: 'var(--dql-app-muted, var(--color-text-secondary))', fontSize: 11.5, lineHeight: 1.45 }}>{driver.explanation}</p>
          </div>
        );
      })}
    </div>
  );
}
