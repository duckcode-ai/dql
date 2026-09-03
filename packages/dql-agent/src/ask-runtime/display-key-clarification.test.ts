import { describe, expect, it } from 'vitest';
import type { AgentEvidenceCandidate } from '../meaning-resolution.js';
import { deterministicDisplayKeyClarification } from './display-key-clarification.js';

function revenueMetric(rankDimensions: Array<{ id: string; label?: string; rank?: boolean }>): AgentEvidenceCandidate {
  return {
    id: 'semantic:metric:orders.revenue',
    qualifiedId: 'semantic:metric:orders.revenue',
    kind: 'semantic_metric',
    semanticObjectType: 'metric',
    trustTier: 'semantic',
    name: 'orders.revenue',
    relevanceScore: 1,
    matchReasons: ['exact'],
    compatibility: 'compatible',
    analyticalCapability: {
      metricId: 'semantic:metric:orders.revenue',
      measureIds: ['semantic:measure:orders.revenue'],
      primaryEntityId: 'order',
      defaultResultGrainId: 'scalar',
      resultGrainIds: ['scalar', 'customer', 'company'],
      aggregation: 'sum',
      additivity: { entities: 'additive', time: 'additive' },
      dimensions: rankDimensions.map((dimension) => ({
        dimensionId: dimension.id,
        entityId: dimension.id.replace('semantic:dimension:', ''),
        supportedRoles: dimension.rank === false ? ['group_by', 'filter'] : ['group_by', 'filter', 'display', 'rank_entity'],
        ...(dimension.label ? { label: dimension.label } : {}),
      })),
      timeDimensions: [],
      operations: ['filter', 'group', 'rank'],
      supportedOutputKinds: ['dimension', 'metric_value', 'rank'],
      executionCapabilities: [{ route: 'semantic', adapterId: 'native' }],
      sourceFingerprint: 'sha256:orders-revenue',
    },
  } as AgentEvidenceCandidate;
}

function member(id: string, name: string): AgentEvidenceCandidate {
  return {
    id,
    qualifiedId: id,
    kind: 'semantic_member',
    semanticObjectType: 'dimension',
    trustTier: 'semantic',
    name,
    relevanceScore: 0.8,
    matchReasons: ['name'],
    compatibility: 'compatible',
  } as AgentEvidenceCandidate;
}

const CUSTOMER = 'semantic:dimension:customers.customer_name';
const COMPANY = 'semantic:dimension:companies.company_name';

describe('deterministicDisplayKeyClarification', () => {
  it('offers the rank-entity display keys the metric declares when the question names no entity', () => {
    const clarification = deterministicDisplayKeyClarification({
      question: 'Show the top names by revenue',
      candidates: [
        revenueMetric([{ id: CUSTOMER, label: 'Customer Name' }, { id: COMPANY, label: 'Company Name' }]),
        member(CUSTOMER, 'customer name'),
        member(COMPANY, 'company name'),
      ],
    });
    expect(clarification).toMatchObject({
      reasonCode: 'ASK_V2_DISPLAY_KEY_AMBIGUOUS',
      metricId: 'semantic:metric:orders.revenue',
    });
    expect(clarification?.options.map((option) => [option.id, option.label])).toEqual([
      [COMPANY, 'Company Name'],
      [CUSTOMER, 'Customer Name'],
    ]);
    expect(clarification?.options[0]?.question).toBe('Show the top names by revenue — clarification: Company Name');
  });

  it('stays silent when the question already names the entity', () => {
    expect(deterministicDisplayKeyClarification({
      question: 'Show the top customer names by revenue',
      candidates: [
        revenueMetric([{ id: CUSTOMER }, { id: COMPANY }]),
        member(CUSTOMER, 'customer name'),
        member(COMPANY, 'company name'),
      ],
    })).toBeUndefined();
  });

  it('stays silent without a ranking, with one rank entity, or when the metric declares none', () => {
    const candidates = [
      revenueMetric([{ id: CUSTOMER }, { id: COMPANY }]),
      member(CUSTOMER, 'customer name'),
      member(COMPANY, 'company name'),
    ];
    expect(deterministicDisplayKeyClarification({ question: 'What are the names?', candidates })).toBeUndefined();
    expect(deterministicDisplayKeyClarification({
      question: 'Show the top names by revenue',
      candidates: [revenueMetric([{ id: CUSTOMER }, { id: COMPANY, rank: false }]), member(CUSTOMER, 'customer name'), member(COMPANY, 'company name')],
    })).toBeUndefined();
    expect(deterministicDisplayKeyClarification({
      question: 'Show the top names by revenue',
      candidates: [revenueMetric([]), member(CUSTOMER, 'customer name'), member(COMPANY, 'company name')],
    })).toBeUndefined();
  });
});
