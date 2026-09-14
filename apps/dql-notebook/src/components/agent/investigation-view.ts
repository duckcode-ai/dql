/**
 * HOW A RESEARCH RUN INVESTIGATED, IN ORDER.
 *
 * A pure model over an investigation: the report on the `research_run`
 * artifact (`payload.investigation`) and the receipt on the run
 * (`diagnosticReceiptV9.investigation`). The frame, each program with the
 * queries it ran, and for each query the same explanation Ask gives an answer.
 * Runs made by the older hypothesis Research carry neither, and keep their
 * own views.
 */
import { explainAskRun, type RunExplanation } from './ask-run-explanation';

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : undefined);
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const strings = (value: unknown): string[] => arr(value).filter((item): item is string => typeof item === 'string');

export interface InvestigationFigure { value: string; formatted: string }

export type InvestigationVerdict = 'change' | 'no_material_change' | 'seasonal' | 'no_data' | 'incomplete';
export type InvestigationConfidence = 'high' | 'medium' | 'low';

export interface InvestigationQueryView {
  id: string;
  purpose: string;
  label: string;
  programId: string;
  outcome: string;
  tier?: string;
  trust?: string;
  sql?: string;
  message?: string;
  result?: { columns: string[]; rows: Rec[]; rowCount: number; columnsMeta?: Rec[] };
}

export interface InvestigationDriverView {
  /** Dimension and member at each level, outermost first. */
  path: Array<{ dimension: string; member: string }>;
  current: InvestigationFigure;
  prior: InvestigationFigure;
  delta: InvestigationFigure;
  /** Signed fraction of the change (1 = all of it). */
  share?: number;
  /** For a drilled member: fraction of the whole change. */
  globalShare?: number;
  excess?: number;
  status: 'both' | 'new' | 'gone';
  role: 'driver' | 'offset';
  verdict: 'supported' | 'partial' | 'offset';
  queryIds: string[];
}

export interface InvestigationReportView {
  question: string;
  status: 'answered' | 'no_data' | 'incomplete';
  headline: {
    text: string;
    metricLabel: string;
    current?: InvestigationFigure;
    prior?: InvestigationFigure;
    delta?: InvestigationFigure;
    pct?: string;
    yearAgo?: InvestigationFigure;
    yoyDelta?: InvestigationFigure;
    yoyPct?: string;
    verdict: InvestigationVerdict;
    queryIds: string[];
  };
  periods: { current: string; prior: string; yearAgo: string };
  windowBasis: string;
  observedThrough?: string;
  lane: 'governed' | 'ai';
  caveats: Array<{ code: string; text: string; queryIds: string[] }>;
  confidence: { level: InvestigationConfidence; reasons: string[] };
  trend?: { columns: string[]; rows: Rec[]; columnsMeta?: Rec[] };
  drivers: InvestigationDriverView[];
  ruledOut: Array<{ dimension: string; text: string; queryIds: string[] }>;
  inconclusive: Array<{ dimension: string; reason: string; queryIds: string[] }>;
  notInvestigated: Array<{ dimension?: string; reason: string }>;
  mixRate?: { mix: InvestigationFigure; rate: InvestigationFigure; queryIds: string[] };
  queries: InvestigationQueryView[];
  text: string;
}

const fraction = (value: unknown): number | undefined => {
  const number = typeof value === 'string' && value.trim() ? Number(value) : typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
};

const DRIVER_VERDICTS = ['supported', 'partial', 'offset'] as const;

function driverView(value: unknown): InvestigationDriverView | undefined {
  const driver = rec(value);
  const current = figure(driver?.current);
  const prior = figure(driver?.prior);
  const delta = figure(driver?.delta);
  const verdict = str(driver?.verdict) as InvestigationDriverView['verdict'] | undefined;
  if (!driver || !current || !prior || !delta || !verdict || !DRIVER_VERDICTS.includes(verdict)) return undefined;
  const status = str(driver.status);
  return {
    path: arr(driver.path).map(rec).filter((step): step is Rec => Boolean(step))
      .map((step) => ({ dimension: str(rec(step.dimension)?.label) ?? 'Dimension', member: str(rec(step.member)?.label) ?? '(not set)' })),
    current, prior, delta,
    ...(fraction(driver.share) !== undefined ? { share: fraction(driver.share) } : {}),
    ...(fraction(driver.globalShare) !== undefined ? { globalShare: fraction(driver.globalShare) } : {}),
    ...(fraction(driver.excess) !== undefined ? { excess: fraction(driver.excess) } : {}),
    status: status === 'new' || status === 'gone' ? status : 'both',
    role: driver.role === 'offset' ? 'offset' : 'driver',
    verdict,
    queryIds: strings(driver.queryIds),
  };
}

const dimensionLabel = (entry: Rec) => str(rec(entry.dimension)?.label);

const figure = (value: unknown): InvestigationFigure | undefined => {
  const record = rec(value);
  const raw = str(record?.value);
  return raw !== undefined ? { value: raw, formatted: str(record?.formatted) ?? raw } : undefined;
};

const VERDICTS: InvestigationVerdict[] = ['change', 'no_material_change', 'seasonal', 'no_data', 'incomplete'];
const LEVELS: InvestigationConfidence[] = ['high', 'medium', 'low'];

function queryView(value: unknown): InvestigationQueryView | undefined {
  const query = rec(value);
  const id = str(query?.id);
  if (!query || !id) return undefined;
  const result = rec(query.result);
  return {
    id,
    purpose: str(query.purpose) ?? 'query',
    label: str(query.label) ?? id,
    programId: str(query.programId) ?? '',
    outcome: str(query.outcome) ?? 'failed',
    ...(str(query.tier) ? { tier: str(query.tier) } : {}),
    ...(str(query.trust) ? { trust: str(query.trust) } : {}),
    ...(str(query.sql) ? { sql: str(query.sql) } : {}),
    ...(str(query.message) ? { message: str(query.message) } : {}),
    ...(result ? {
      result: {
        columns: strings(result.columns),
        rows: arr(result.rows).map(rec).filter((row): row is Rec => Boolean(row)),
        rowCount: num(result.rowCount) ?? arr(result.rows).length,
        ...(Array.isArray(result.columnsMeta) ? { columnsMeta: arr(result.columnsMeta).map(rec).filter((meta): meta is Rec => Boolean(meta)) } : {}),
      },
    } : {}),
  };
}

/** The investigation report a Research artifact carries, or undefined for any other payload. */
export function investigationReportOf(payload: unknown): InvestigationReportView | undefined {
  const outer = rec(payload);
  const report = outer?.kind === 'investigation' ? rec(outer.investigation) : undefined;
  const headline = rec(report?.headline);
  const frame = rec(report?.frame);
  const windows = rec(frame?.windows);
  if (!report || report.version !== 1 || !headline || !frame || !windows) return undefined;
  const confidence = rec(report.confidence);
  const level = str(confidence?.level) as InvestigationConfidence | undefined;
  const verdict = str(headline.verdict) as InvestigationVerdict | undefined;
  const status = str(report.status);
  const trend = rec(rec(report.chart)?.trend);
  return {
    question: str(report.question) ?? '',
    status: status === 'no_data' || status === 'incomplete' ? status : 'answered',
    headline: {
      text: str(headline.text) ?? '',
      metricLabel: str(rec(headline.metric)?.label) ?? str(rec(frame.metric)?.label) ?? 'the metric',
      ...(figure(headline.current) ? { current: figure(headline.current) } : {}),
      ...(figure(headline.prior) ? { prior: figure(headline.prior) } : {}),
      ...(figure(headline.delta) ? { delta: figure(headline.delta) } : {}),
      ...(str(headline.pct) ? { pct: str(headline.pct) } : {}),
      ...(figure(headline.yearAgo) ? { yearAgo: figure(headline.yearAgo) } : {}),
      ...(figure(headline.yoyDelta) ? { yoyDelta: figure(headline.yoyDelta) } : {}),
      ...(str(headline.yoyPct) ? { yoyPct: str(headline.yoyPct) } : {}),
      verdict: verdict && VERDICTS.includes(verdict) ? verdict : 'no_data',
      queryIds: strings(headline.queryIds),
    },
    periods: {
      current: str(rec(windows.current)?.label) ?? '',
      prior: str(rec(windows.prior)?.label) ?? '',
      yearAgo: str(rec(windows.yearAgo)?.label) ?? '',
    },
    windowBasis: str(frame.windowBasis) ?? 'stated',
    ...(str(frame.observedThrough) ? { observedThrough: str(frame.observedThrough) } : {}),
    lane: frame.lane === 'ai' ? 'ai' : 'governed',
    caveats: arr(report.caveats).map(rec).filter((caveat): caveat is Rec => Boolean(caveat && str(caveat.text)))
      .map((caveat) => ({ code: str(caveat.code) ?? 'note', text: str(caveat.text)!, queryIds: strings(caveat.queryIds) })),
    confidence: { level: level && LEVELS.includes(level) ? level : 'low', reasons: strings(confidence?.reasons) },
    ...(trend && Array.isArray(trend.rows) ? {
      trend: {
        columns: strings(trend.columns),
        rows: arr(trend.rows).map(rec).filter((row): row is Rec => Boolean(row)),
        ...(Array.isArray(trend.columnsMeta) ? { columnsMeta: arr(trend.columnsMeta).map(rec).filter((meta): meta is Rec => Boolean(meta)) } : {}),
      },
    } : {}),
    drivers: arr(report.drivers).map(driverView).filter((driver): driver is InvestigationDriverView => Boolean(driver)),
    ruledOut: arr(report.ruledOut).map(rec).filter((entry): entry is Rec => Boolean(entry && str(entry.text)))
      .map((entry) => ({ dimension: dimensionLabel(entry) ?? 'A dimension', text: str(entry.text)!, queryIds: strings(entry.queryIds) })),
    inconclusive: arr(report.inconclusive).map(rec).filter((entry): entry is Rec => Boolean(entry))
      .map((entry) => ({ dimension: dimensionLabel(entry) ?? 'A dimension', reason: str(entry.reason) ?? 'no clear concentration', queryIds: strings(entry.queryIds) })),
    notInvestigated: arr(report.notInvestigated).map(rec).filter((entry): entry is Rec => Boolean(entry))
      .map((entry) => ({ ...(dimensionLabel(entry) ? { dimension: dimensionLabel(entry) } : {}), reason: str(entry.reason) ?? 'not_started' })),
    ...(figure(rec(report.mixRate)?.mix) && figure(rec(report.mixRate)?.rate)
      ? { mixRate: { mix: figure(rec(report.mixRate)!.mix)!, rate: figure(rec(report.mixRate)!.rate)!, queryIds: strings(rec(report.mixRate)!.queryIds) } }
      : {}),
    queries: arr(report.queries).map(queryView).filter((query): query is InvestigationQueryView => Boolean(query)),
    text: str(report.text) ?? str(headline.text) ?? '',
  };
}

/** A run receipt that records an investigation. */
export function isInvestigationReceipt(value: unknown): boolean {
  return Array.isArray(rec(rec(value)?.investigation)?.programs);
}

export type InvestigationProgramOutcome = 'done' | 'skipped' | 'failed' | 'not_reached';

export interface InvestigationProgramStep {
  id: string;
  n: number;
  kind: string;
  title: string;
  outcome: InvestigationProgramOutcome;
  ms?: number;
  reason?: string;
  queries: Array<{ id: string; label: string; purpose: string; outcome: string; tier?: string; explanation?: RunExplanation }>;
}

export interface InvestigationExplanation {
  reading?: string;
  periods?: InvestigationReportView['periods'];
  windowBasis?: string;
  lane?: 'governed' | 'ai';
  programs: InvestigationProgramStep[];
  budget: { statementsUsed: number; statementsCap: number; aiCalls: number; stoppedBy?: string };
  contextSources: Array<{ id: string; items: number; ms: number; error?: string }>;
  totalMs?: number;
}

const OUTCOMES: InvestigationProgramOutcome[] = ['done', 'skipped', 'failed', 'not_reached'];

/**
 * Each program of the investigation with the queries it ran. A query's own
 * explanation comes from its pipeline receipt, with the SQL and rows the report
 * kept for it; a query that never reached the pipeline has none.
 */
export function explainInvestigation(input: { receipt: unknown; report?: InvestigationReportView }): InvestigationExplanation | undefined {
  const root = rec(input.receipt);
  const investigation = rec(root?.investigation);
  if (!root || !investigation || !Array.isArray(investigation.programs)) return undefined;
  const reportQueries = new Map((input.report?.queries ?? []).map((query) => [query.id, query]));
  const receipts = new Map(arr(investigation.queries).map(rec).filter((entry): entry is Rec => Boolean(entry && str(entry.id)))
    .map((entry) => [str(entry.id)!, entry.receipt]));
  const frame = rec(investigation.frame);
  const budget = rec(investigation.budget);
  const programs = arr(investigation.programs).map(rec).filter((program): program is Rec => Boolean(program)).map((program, index): InvestigationProgramStep => {
    const outcome = str(program.outcome) as InvestigationProgramOutcome | undefined;
    return {
      id: str(program.id) ?? `program-${index + 1}`,
      n: index + 1,
      kind: str(program.kind) ?? 'program',
      title: str(program.title) ?? 'Step',
      outcome: outcome && OUTCOMES.includes(outcome) ? outcome : 'done',
      ...(num(program.ms) !== undefined ? { ms: num(program.ms) } : {}),
      ...(str(program.reason) ? { reason: str(program.reason) } : {}),
      queries: strings(program.queryIds).map((id) => {
        const query = reportQueries.get(id);
        const receipt = receipts.get(id);
        const explanation = receipt ? explainAskRun({
          receipt,
          payload: {
            ...(query?.sql ? { sql: query.sql } : {}),
            ...(query?.result ? { result: query.result } : {}),
          },
          status: query?.outcome === 'answered' ? 'completed' : 'blocked',
        }) : undefined;
        return {
          id,
          label: query?.label ?? id,
          purpose: query?.purpose ?? 'query',
          outcome: query?.outcome ?? (receipt ? 'answered' : 'failed'),
          ...(query?.tier ? { tier: query.tier } : {}),
          ...(explanation ? { explanation } : {}),
        };
      }),
    };
  });
  const timings = rec(root.timings);
  return {
    ...(str(frame?.reading) ?? str(root.reading) ? { reading: str(frame?.reading) ?? str(root.reading) } : {}),
    ...(input.report ? { periods: input.report.periods, windowBasis: input.report.windowBasis, lane: input.report.lane } : {}),
    programs,
    budget: {
      statementsUsed: num(budget?.statementsUsed) ?? 0,
      statementsCap: num(budget?.statementsCap) ?? 0,
      aiCalls: num(budget?.aiCalls) ?? 0,
      ...(str(budget?.stoppedBy) ? { stoppedBy: str(budget?.stoppedBy) } : {}),
    },
    contextSources: arr(investigation.contextSources).map(rec).filter((entry): entry is Rec => Boolean(entry && str(entry.id))).map((entry) => ({
      id: str(entry.id)!, items: num(entry.items) ?? 0, ms: num(entry.ms) ?? 0, ...(str(entry.error) ? { error: str(entry.error) } : {}),
    })),
    ...(num(timings?.total) !== undefined ? { totalMs: num(timings?.total) } : {}),
  };
}

/** What Research is doing now, named from the last step it finished. */
export function investigationActiveLabel(last: { phase: string; title: string; state: string } | undefined): string | undefined {
  if (!last) return undefined;
  switch (last.phase) {
    case 'frame': return last.title.startsWith('Comparing') ? 'Measuring the change'
      : last.title.startsWith('Framed the change') ? 'Checking how far the data runs'
      : 'Framing the change to investigate';
    case 'check': return last.title.startsWith('The data runs') || last.title.startsWith('Could not read how far') || last.title.startsWith('The latest') ? 'Framing the periods to compare'
      : last.title.startsWith('Data covers') ? 'Breaking the change down'
      : 'Writing the report';
    case 'analyze': return /^(Broke|Chose|Kept|Could not break)/.test(last.title) ? 'Breaking the change down' : 'Checking the data covers both periods';
    case 'drill': return 'Looking one level deeper';
    case 'verdict': return 'Writing the report';
    case 'report': return 'Finishing';
    default: return undefined;
  }
}
