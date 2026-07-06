import { describe, expect, it } from 'vitest';
import {
  cascadeTraceToEvidenceRouteSteps,
  createCascadeAnswerResult,
  createCascadeTrace,
  terminalLaneForRouteTier,
} from './cascade.js';

describe('cascade trace', () => {
  it('short-circuits lower lanes after a certified answer', () => {
    const trace = createCascadeTrace({
      terminalLane: 'certified',
      lanes: {
        certified: { detail: 'top_products' },
        generated: { status: 'selected', detail: 'should not win' },
      },
    });

    expect(trace).toMatchObject([
      { lane: 'triage', status: 'checked' },
      { lane: 'certified', status: 'selected', terminal: true, detail: 'top_products' },
      { lane: 'semantic', status: 'skipped' },
      { lane: 'generated', status: 'skipped', detail: 'should not win' },
      { lane: 'refusal', status: 'skipped' },
    ]);
  });

  it('marks semantic compile as terminal before generated SQL when it answers', () => {
    const trace = createCascadeTrace({
      terminalLane: 'semantic',
      lanes: {
        certified: { label: 'Certified blocks were context only' },
        semantic: { label: 'Semantic layer compiled monthly revenue by channel' },
      },
    });

    expect(trace.map((step) => [step.lane, step.status, step.label])).toEqual([
      ['triage', 'checked', 'Lane 0 triage checked request intent and ambiguity'],
      ['certified', 'checked', 'Certified blocks were context only'],
      ['semantic', 'selected', 'Semantic layer compiled monthly revenue by channel'],
      ['generated', 'skipped', 'Lane 3 checked generated DQL artifact with SQL preview skipped because semantic lane already produced a terminal outcome'],
      ['refusal', 'skipped', 'Lane 4 checked honest refusal and redirect skipped because semantic lane already produced a terminal outcome'],
    ]);
  });

  it('maps trace entries into existing evidence route steps', () => {
    expect(cascadeTraceToEvidenceRouteSteps(createCascadeTrace({ terminalLane: 'generated' }))[3]).toEqual({
      tool: 'cascade_generated',
      status: 'selected',
      label: 'Lane 3 generated DQL artifact was terminal',
    });
  });

  it('maps answer route tiers to terminal cascade lanes', () => {
    expect(terminalLaneForRouteTier('certified_block')).toBe('certified');
    expect(terminalLaneForRouteTier('business_context')).toBe('certified');
    expect(terminalLaneForRouteTier('semantic_metric')).toBe('semantic');
    expect(terminalLaneForRouteTier('generated_sql')).toBe('generated');
    expect(terminalLaneForRouteTier('no_answer')).toBe('refusal');
  });

  it('creates a structured terminal answer result', () => {
    expect(createCascadeAnswerResult({
      routeTier: 'generated_sql',
      label: 'Prepared review-required DQL artifact with SQL preview.',
      ref: 'product_supply_top_10_value',
      artifactKind: 'sql_block',
      draftBlockId: 'blocks/_drafts/product_supply_top_10_value.dql',
      hasSqlPreview: true,
      executionStatus: 'executed',
      rowCount: 10,
    })).toMatchObject({
      terminalLane: 'generated',
      routeTier: 'generated_sql',
      label: 'Prepared review-required DQL artifact with SQL preview.',
      ref: 'product_supply_top_10_value',
      artifactKind: 'sql_block',
      outcome: {
        lane: 'generated',
        routeTier: 'generated_sql',
        artifactKind: 'sql_block',
        draftBlockId: 'blocks/_drafts/product_supply_top_10_value.dql',
        hasSqlPreview: true,
        executionStatus: 'executed',
        rowCount: 10,
      },
    });
  });

  it('creates semantic and refusal lane outcomes', () => {
    expect(createCascadeAnswerResult({
      routeTier: 'semantic_metric',
      label: 'Answered from metric total_revenue',
      ref: 'total_revenue',
      artifactKind: 'semantic_block',
      metrics: ['total_revenue'],
      dimensions: ['channel'],
      rowCount: 3,
    }).outcome).toEqual({
      lane: 'semantic',
      routeTier: 'semantic_metric',
      ref: 'total_revenue',
      artifactKind: 'semantic_block',
      metrics: ['total_revenue'],
      dimensions: ['channel'],
      rowCount: 3,
    });

    expect(createCascadeAnswerResult({
      routeTier: 'no_answer',
      label: 'No governed answer.',
      refusalCode: 'grounding_gap',
      reason: 'Unknown relation dev.supplies',
    }).outcome).toEqual({
      lane: 'refusal',
      routeTier: 'no_answer',
      refusalCode: 'grounding_gap',
      reason: 'Unknown relation dev.supplies',
    });
  });
});
