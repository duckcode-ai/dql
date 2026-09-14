import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { themes } from '../../themes/notebook-theme';
import type * as ViewModule from './investigation-view';
import type * as ReportModule from './InvestigationReport';
import type * as FlowModule from './InvestigationFlow';

let view: typeof ViewModule;
let reportModule: typeof ReportModule;
let flowModule: typeof FlowModule;

beforeAll(async () => {
  vi.stubGlobal('window', { location: { origin: 'http://localhost', pathname: '/' } });
  view = await import('./investigation-view');
  reportModule = await import('./InvestigationReport');
  flowModule = await import('./InvestigationFlow');
});

const t = Object.values(themes)[0]!;

const queryReceipt = {
  version: 1, vocabularyFingerprint: 'v', dispatches: [], refusals: [], timings: {}, reuse: 'interpretation', story: [],
  candidates: [{ tier: 'semantic', trust: 'governed', proof: ['compiled on the semantic layer'] }],
  tiers: [{ round: 0, tier: 'certified', outcome: 'skipped' }, { round: 0, tier: 'semantic', outcome: 'prepared' }],
  executed: { tier: 'semantic', sqlFingerprint: 'sha256:x', rowCount: 14, ms: 40, proofs: [] },
  intent: { reading: 'Revenue by month from July 2024 to August 2025.' },
};

const payload = {
  kind: 'investigation',
  investigation: {
    version: 1,
    question: 'Why did revenue drop in August 2025?',
    status: 'answered',
    frame: {
      reading: 'Revenue in August 2025.', lane: 'governed', windowBasis: 'source_run', metric: { ref: 'metric:orders.revenue', label: 'Revenue' },
      windows: { current: { label: 'August 2025' }, prior: { label: 'July 2025' }, yearAgo: { label: 'August 2024' }, yearAgoPrior: { label: 'July 2024' } },
    },
    headline: {
      text: 'Revenue fell 930.00 (30.0%) in August 2025 compared with July 2025: 2170.00 against 3100.00.',
      metric: { ref: 'metric:orders.revenue', label: 'Revenue' },
      current: { value: '2170', formatted: '2170.00' }, prior: { value: '3100', formatted: '3100.00' },
      delta: { value: '-930', formatted: '-930.00' }, pct: '-30.0', yearAgo: { value: '3100', formatted: '3100.00' },
      verdict: 'change', queryIds: ['q1'],
    },
    caveats: [{ code: 'coverage_gap', text: 'August 2025 has data on 65% of its days against 100% for July 2025.', queryIds: ['q2'] }],
    confidence: { level: 'low', reasons: ['the current period has data on far fewer days than the prior one'] },
    chart: { trend: { columns: ['ordered_at__month', 'value'], rows: [{ ordered_at__month: '2025-07-01', value: 3100 }, { ordered_at__month: '2025-08-01', value: 2170 }] } },
    queries: [
      { id: 'q1', purpose: 'headline', label: 'Revenue by month from July 2024 to August 2025', programId: 'headline', outcome: 'answered', tier: 'semantic', trust: 'governed', sql: 'SELECT 1', result: { columns: ['value'], rows: [{ value: 1 }], rowCount: 1 } },
      { id: 'q2', purpose: 'coverage', label: 'Revenue by day across both periods', programId: 'coverage', outcome: 'answered', tier: 'semantic' },
    ],
    text: 'Revenue fell 930.00 (30.0%) in August 2025 compared with July 2025.',
  },
};

const rootReceipt = {
  version: 1, dispatches: [], tiers: [], timings: { total: 4_200 },
  investigation: {
    version: 1,
    frame: { reading: 'Revenue in August 2025.' },
    programs: [
      { id: 'frame', kind: 'frame', title: 'Framed the change to investigate', outcome: 'done', queryIds: [] },
      { id: 'headline', kind: 'headline', title: 'Measured Revenue in each period', outcome: 'done', queryIds: ['q1'], ms: 1_200 },
      { id: 'coverage', kind: 'coverage', title: 'Checked the data covers both periods', outcome: 'failed', queryIds: ['q2'], reason: 'the result does not show which column holds the period' },
    ],
    queries: [{ id: 'q1', programId: 'headline', receipt: queryReceipt }],
    budget: { statementsCap: 20, statementsUsed: 2, aiCalls: 0 },
    contextSources: [],
  },
};

describe('the investigation view model', () => {
  it('reads the report from a Research artifact and leaves every other payload alone', () => {
    const report = view.investigationReportOf(payload)!;
    expect(report).toMatchObject({
      status: 'answered', lane: 'governed', windowBasis: 'source_run',
      periods: { current: 'August 2025', prior: 'July 2025', yearAgo: 'August 2024' },
      headline: { metricLabel: 'Revenue', verdict: 'change', pct: '-30.0', current: { formatted: '2170.00' }, queryIds: ['q1'] },
      confidence: { level: 'low' },
    });
    expect(report.trend?.rows).toHaveLength(2);
    expect(report.queries.map((query) => query.id)).toEqual(['q1', 'q2']);
    expect(view.investigationReportOf({ plan: { steps: [] }, researchLedgerV2: {} })).toBeUndefined();
    expect(view.investigationReportOf({ kind: 'investigation', investigation: { version: 2 } })).toBeUndefined();
  });

  it('explains each program with the queries it ran, and a query from its own receipt', () => {
    const report = view.investigationReportOf(payload)!;
    const explanation = view.explainInvestigation({ receipt: rootReceipt, report })!;
    expect(view.isInvestigationReceipt(rootReceipt)).toBe(true);
    expect(explanation.programs.map((program) => [program.n, program.kind, program.outcome])).toEqual([[1, 'frame', 'done'], [2, 'headline', 'done'], [3, 'coverage', 'failed']]);
    expect(explanation.programs[1]!.queries[0]).toMatchObject({ id: 'q1', label: 'Revenue by month from July 2024 to August 2025', tier: 'semantic' });
    expect(explanation.programs[1]!.queries[0]!.explanation).toBeDefined();
    // A query whose receipt was not kept has no explanation, never a made-up one.
    expect(explanation.programs[2]!.queries[0]!.explanation).toBeUndefined();
    expect(explanation).toMatchObject({ reading: 'Revenue in August 2025.', totalMs: 4_200, budget: { statementsUsed: 2, statementsCap: 20 } });
    expect(view.explainInvestigation({ receipt: queryReceipt })).toBeUndefined();
  });

  it('reads the drivers, what was ruled out, what was inconclusive and what was not broken down', () => {
    const withDrivers = {
      kind: 'investigation',
      investigation: {
        ...payload.investigation,
        drivers: [
          {
            path: [{ dimension: { ref: 'dimension:orders.category', label: 'Category' }, member: { value: 'beverage', label: 'beverage' } }],
            current: { value: '150', formatted: '150.00' }, prior: { value: '300', formatted: '300.00' }, delta: { value: '-150', formatted: '-150.00' },
            share: '1', excess: '0.7', status: 'both', role: 'driver', verdict: 'supported', factIds: ['f-driver-1'], queryIds: ['q3'],
          },
          { path: [], current: { value: '1', formatted: '1' }, prior: { value: '1', formatted: '1' }, delta: { value: '0', formatted: '0' }, verdict: 'made_up' },
        ],
        ruledOut: [{ dimension: { ref: 'dimension:orders.location', label: 'Location' }, maxExcess: '0', text: "By Location, the change was spread in line with each member's size.", queryIds: ['q4'] }],
        inconclusive: [{ dimension: { ref: 'dimension:orders.channel', label: 'Channel' }, reason: 'no member moved far enough beyond its size to stand out', queryIds: ['q5'] }],
        notInvestigated: [{ dimension: { ref: 'dimension:orders.brand', label: 'Brand' }, reason: 'budget' }],
        narration: { text: 'Revenue fell 930.00 in August 2025, most of it in beverage.', verified: true },
      },
    };
    const report = view.investigationReportOf(withDrivers)!;
    expect(report.drivers).toEqual([{
      path: [{ dimension: 'Category', member: 'beverage' }],
      current: { value: '150', formatted: '150.00' }, prior: { value: '300', formatted: '300.00' }, delta: { value: '-150', formatted: '-150.00' },
      share: 1, excess: 0.7, status: 'both', role: 'driver', verdict: 'supported', queryIds: ['q3'],
    }]);
    expect(report.ruledOut).toEqual([{ dimension: 'Location', text: "By Location, the change was spread in line with each member's size.", queryIds: ['q4'] }]);
    expect(report.notInvestigated).toEqual([{ dimension: 'Brand', reason: 'budget' }]);
    // A report from before drivers existed reads with none.
    expect(view.investigationReportOf(payload)!.drivers).toEqual([]);

    const html = renderToStaticMarkup(createElement(reportModule.InvestigationReport, { report: { ...report, trend: undefined }, t, themeMode: 'light' }));
    expect(html).toContain('Where the change came from');
    expect(html).toContain('Category: beverage');
    expect(html).toContain('Supported');
    expect(html).toContain('300.00 → 150.00');
    expect(html).toContain('100.0%');
    expect(html).toContain('Ruled out · </span>By Location');
    expect(html).toContain('Inconclusive · </span>Channel: no member moved far enough beyond its size to stand out');
    expect(html).toContain('Not broken down: Brand (query budget ran out)');
    expect(html).toContain('Revenue fell 930.00 in August 2025, most of it in beverage.');
    expect(html).toContain('every number was checked against them');
    // A wording that was not verified is never shown.
    expect(view.investigationReportOf({ ...withDrivers, investigation: { ...withDrivers.investigation, narration: { text: 'Unchecked words', verified: false } } })!.narration).toBeUndefined();
  });

  it('names what Research is doing from its last step', () => {
    expect(view.investigationActiveLabel({ phase: 'check', title: 'Data covers 100% of the days in August 2025 and 100% in July 2025', state: 'done' })).toBe('Breaking the change down');
    expect(view.investigationActiveLabel({ phase: 'analyze', title: 'Broke the change down by Category: the change is concentrated in some members', state: 'done' })).toBe('Breaking the change down');
    expect(view.investigationActiveLabel({ phase: 'drill', title: 'Broke beverage by Location down', state: 'done' })).toBe('Looking one level deeper');
    expect(view.investigationActiveLabel({ phase: 'frame', title: 'Framed', state: 'done' })).toBe('Framing the change to investigate');
    expect(view.investigationActiveLabel({ phase: 'frame', title: 'Framed the change in net arr', state: 'done' })).toBe('Checking how far the data runs');
    expect(view.investigationActiveLabel({ phase: 'analyze', title: 'Measured', state: 'done' })).toBe('Checking the data covers both periods');
    expect(view.investigationActiveLabel({ phase: 'read', title: 'Read', state: 'done' })).toBeUndefined();
  });
});

describe('the investigation report and flow render', () => {
  it('the report shows the verdict, the periods, the confidence and what limits the figures', () => {
    const report = { ...view.investigationReportOf(payload)!, trend: undefined };
    const html = renderToStaticMarkup(createElement(reportModule.InvestigationReport, { report, t, themeMode: 'light', onOpenQuery: () => undefined }));
    expect(html).toContain('Changed');
    expect(html).toContain('Low confidence');
    expect(html).toContain('August 2025');
    expect(html).toContain('-930.00 (-30.0%)');
    expect(html).toContain('65% of its days');
    expect(html).toContain('Review required');
    expect(html).toContain('Revenue by month from July 2024 to August 2025');
  });

  it('"How it was researched" lists the steps in order and opens a failed one by itself', () => {
    const explanation = view.explainInvestigation({ receipt: rootReceipt, report: view.investigationReportOf(payload)! })!;
    const html = renderToStaticMarkup(createElement(flowModule.InvestigationFlow, { explanation, t }));
    expect(html).toContain('How it was researched');
    expect(html).toContain('2 of 20 queries');
    expect(html).toContain('Compared August 2025 with July 2025 and August 2024');
    expect(html.indexOf('Framed the change to investigate')).toBeLessThan(html.indexOf('Measured Revenue in each period'));
    expect(html).toContain('the result does not show which column holds the period');
  });
});
