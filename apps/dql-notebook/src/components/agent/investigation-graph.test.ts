import { describe, expect, it } from 'vitest';
import { investigationDecisionFlow } from './investigation-graph';
import type { InvestigationExplanation, InvestigationProgramStep } from './investigation-view';

const CATEGORY = 'dimension:orders.category';
const LOCATION = 'dimension:orders.location';
const program = (id: string, kind: string, extra: Partial<InvestigationProgramStep> = {}): InvestigationProgramStep => ({ id, n: 0, kind, title: id, outcome: 'done', queries: [], ...extra });
const explanation = (programs: InvestigationProgramStep[]): InvestigationExplanation => ({
  programs, budget: { statementsUsed: 6, statementsCap: 20, aiCalls: 0 }, contextSources: [],
});

describe('an investigation as a branching flow', () => {
  it('runs the frame and headline in a line, the breakdowns side by side, the drill and the year-earlier check after their breakdown, and ends every branch at the report', () => {
    const flow = investigationDecisionFlow(explanation([
      program('frame', 'frame'),
      program('headline', 'headline'),
      program('coverage', 'coverage'),
      program(`contribution:${CATEGORY}`, 'contribution', { dimension: CATEGORY, verdict: 'supported' }),
      program(`contribution:${LOCATION}`, 'contribution', { dimension: LOCATION, verdict: 'ruled_out' }),
      program(`drill:beverage:${LOCATION}`, 'drill', { dimension: LOCATION, parentId: `contribution:${CATEGORY}`, verdict: 'ruled_out' }),
      program('seasonality', 'seasonality', { dimension: CATEGORY }),
      program('report', 'report'),
    ]));
    expect(flow.edges.map((edge) => [edge.source, edge.target, edge.label ?? null])).toEqual([
      ['frame', 'headline', null],
      ['headline', 'coverage', null],
      ['coverage', `contribution:${CATEGORY}`, null],
      ['coverage', `contribution:${LOCATION}`, null],
      [`contribution:${CATEGORY}`, `drill:beverage:${LOCATION}`, 'drill'],
      [`contribution:${CATEGORY}`, 'seasonality', 'a year earlier'],
      [`contribution:${LOCATION}`, 'report', null],
      [`drill:beverage:${LOCATION}`, 'report', null],
      ['seasonality', 'report', null],
    ]);
    expect(flow.nodes.map((node) => [node.id, node.kind, node.subtitle ?? null])).toEqual([
      ['frame', 'step', null], ['headline', 'step', null], ['coverage', 'step', null],
      [`contribution:${CATEGORY}`, 'step', 'Drivers found'], [`contribution:${LOCATION}`, 'step', 'Ruled out'],
      [`drill:beverage:${LOCATION}`, 'step', 'Ruled out'], ['seasonality', 'step', null], ['report', 'end', 'Report'],
    ]);
  });

  it('an investigation with no breakdowns is a line that ends at the report', () => {
    const flow = investigationDecisionFlow(explanation([program('frame', 'frame'), program('headline', 'headline'), program('report', 'report')]));
    expect(flow.edges.map((edge) => [edge.source, edge.target])).toEqual([['frame', 'headline'], ['headline', 'report']]);
  });
});
