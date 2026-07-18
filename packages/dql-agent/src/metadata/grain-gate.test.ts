import { describe, expect, it } from 'vitest';
import { buildAnalysisQuestionPlan } from './analysis-planner.js';
import { grainMatches, requestedGrainFromPlan } from './grain-gate.js';
import type { MetadataObject } from './catalog.js';

function block(grain: string, extra: Partial<MetadataObject['payload']> = {}): MetadataObject {
  return {
    objectKey: `dql:block:${grain}`,
    objectType: 'dql_block',
    name: `block ${grain}`,
    status: 'certified',
    payload: { grain, declaredOutputs: [], entities: [], ...extra },
  };
}

function gate(question: string, certifiedBlock: MetadataObject) {
  const plan = buildAnalysisQuestionPlan(question);
  const requested = requestedGrainFromPlan(plan);
  return grainMatches(certifiedBlock, requested);
}

describe('grain gate', () => {
  it('demotes a certified block whose entity grain differs from the requested grain', () => {
    const result = gate('Show revenue by region', block('account_id', { entities: ['Account'] }));
    expect(result.allow).toBe(false);
    expect(result.kind).toBe('mismatch');
    expect(result.reason).toMatch(/account.*region.*Tier 2/i);
  });

  it('allows an exact entity-grain match', () => {
    const result = gate('Show revenue by region', block('region', { entities: ['Region'] }));
    expect(result.allow).toBe(true);
    expect(result.kind).toBe('exact');
  });

  it('treats account_id and account as the same entity grain', () => {
    const result = gate('Show total revenue by account', block('account_id', { entities: ['Account'] }));
    expect(result.allow).toBe(true);
    expect(result.kind).toBe('exact');
  });

  it('allows a finer time grain to roll up to a coarser requested grain', () => {
    // Daily-grain block can answer a weekly question.
    const result = gate('Show revenue by week', block('day'));
    expect(result.allow).toBe(true);
    expect(result.kind).toBe('compatible_rollup');
    expect(result.reason).toMatch(/finer.*roll-up/i);
  });

  it('demotes a coarser time grain that cannot answer a finer requested grain', () => {
    // Monthly-grain block cannot answer a daily question.
    const result = gate('Show revenue by day', block('month'));
    expect(result.allow).toBe(false);
    expect(result.kind).toBe('mismatch');
    expect(result.reason).toMatch(/month.*day.*Tier 2/i);
  });

  it('allows an exact time-grain match', () => {
    const result = gate('Show revenue by week', block('week'));
    expect(result.allow).toBe(true);
    expect(result.kind).toBe('exact');
  });

  it('does not demote when the question carries no clearly-extractable grain', () => {
    const result = gate('Run revenue total', block('account_id', { entities: ['Account'] }));
    expect(result.allow).toBe(true);
    expect(result.kind).toBe('no_requested_grain');
  });

  it('does not demote when the block declares no grain to gate against', () => {
    const noGrain: MetadataObject = {
      objectKey: 'dql:block:no-grain',
      objectType: 'dql_block',
      name: 'no grain block',
      status: 'certified',
      payload: {},
    };
    const result = gate('Show revenue by region', noGrain);
    expect(result.allow).toBe(true);
    expect(result.kind).toBe('block_grain_unknown');
  });

  it('uses declared output id columns as a row-grain signal', () => {
    const outputs = block('', { declaredOutputs: ['account_id', 'total_revenue'] });
    const result = gate('Show revenue by region', outputs);
    expect(result.allow).toBe(false);
    expect(result.kind).toBe('mismatch');
  });

  it('canonicalizes customer synonyms to a shared grain group', () => {
    const result = gate('Show revenue by customer', block('client_id', { entities: ['Client'] }));
    expect(result.allow).toBe(true);
    expect(result.kind).toBe('exact');
  });

  it('does not confuse joined business entities with the certified result grain', () => {
    const result = gate('Show revenue by product type', block('one row per customer', {
      entities: ['Order Item', 'Product'],
      dimensions: ['customer_name'],
      declaredOutputs: ['customer_name', 'beverage_revenue', 'beverage_product_types'],
    }));

    expect(result.allow).toBe(false);
    expect(result.kind).toBe('mismatch');
    expect(result.reason).toMatch(/customer.*product.*Tier 2/i);
  });
});
