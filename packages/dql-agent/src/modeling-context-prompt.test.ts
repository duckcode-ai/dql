import { describe, expect, it } from 'vitest';
import { relationshipValidationProofFingerprint, type DQLManifest } from '@duckcodeailabs/dql-core';
import { renderAnalyticalPlanPrompt, renderSingleEntityModelingPrompt } from './answer-loop.js';
import { planAnalyticalPath } from './metadata/analytical-policy.js';
import { toAgentRetrievalEvidence } from './metadata/meaning-evidence.js';
import { buildSkillsPrompt, type Skill } from './skills/loader.js';

/**
 * CTX-008 regression cover. Authored modeling is only worth the effort if it
 * reaches the model, so these assert on the exact rendered prompt text rather
 * than on intermediate structures.
 */

const entity = (localId: string, dbtUniqueId: string, extra: Record<string, unknown> = {}) => ({
  id: `commerce::entity::${localId}`,
  localId,
  qualifiedId: `commerce::entity::${localId}`,
  domain: 'commerce',
  dbtUniqueId,
  keys: [],
  sourcePath: 'domains/commerce/modeling/model.dql.yaml',
  identityFingerprint: `fp-${localId}`,
  ...extra,
});

function manifestWith(overrides: { entities: Record<string, unknown>; relationships?: Record<string, unknown> }): DQLManifest {
  return {
    manifestVersion: 3,
    dbtProvenance: {
      manifestPath: 'target/manifest.json',
      manifestFingerprint: 'snapshot-1',
      nodes: {
        'model.shop.fct_orders': { uniqueId: 'model.shop.fct_orders', resourceType: 'model', name: 'fct_orders', relation: 'analytics.fct_orders', identityFingerprint: 'a', available: {} },
        'model.shop.dim_customers': { uniqueId: 'model.shop.dim_customers', resourceType: 'model', name: 'dim_customers', relation: 'analytics.dim_customers', identityFingerprint: 'b', available: {} },
      },
      metricFlow: {},
    },
    modeling: {
      mode: 'dbt-first',
      packages: { commerce: { id: 'commerce', filePath: 'domains/commerce/domain.dql', exports: [] } },
      areas: {},
      entities: overrides.entities,
      relationships: overrides.relationships ?? {},
      contracts: {}, conformance: {}, rules: {}, domainLineage: [],
      interfaces: { exports: {}, imports: {} },
    },
  } as unknown as DQLManifest;
}

describe('modeling context reaches the model prompt (CTX-008)', () => {
  const certifiedRelationship = {
    id: 'order_to_customer',
    localId: 'order_to_customer',
    qualifiedId: 'commerce::relationship::order_to_customer',
    from: 'commerce::entity::order',
    to: 'commerce::entity::customer',
    keys: [{ from: 'customer_id', to: 'customer_id' }],
    cardinality: 'many_to_one',
    fanout: 'safe',
    status: 'certified',
    crossDomain: false,
    ownerDomain: 'commerce',
    verb: 'placed by',
    description: 'Each order is placed by exactly one customer',
    rationale: 'Validated against the warehouse on 2026-07-11',
    sourcePath: 'domains/commerce/modeling/model.dql.yaml',
    fingerprint: 'rel-1',
    certificationFingerprint: 'rel-1',
    // REL-002: certification is only real with matching warehouse proof, so the
    // fixture carries genuine evidence rather than asserting the happy path.
    validation: {
      status: 'passed',
      checkedAt: '2026-07-11T00:00:00.000Z',
      queryFingerprint: 'fixture-order-customer-proof',
      proofFingerprint: relationshipValidationProofFingerprint({
        fromRelation: 'analytics.fct_orders',
        toRelation: 'analytics.dim_customers',
        keys: [{ from: 'customer_id', to: 'customer_id' }],
        cardinality: 'many_to_one',
        fanout: 'safe',
        queryFingerprint: 'fixture-order-customer-proof',
      }),
      fromRows: 8, toRows: 5, joinedRows: 8,
      fromNullKeys: 0, toNullKeys: 0, unmatchedFrom: 0,
      maxFromPerKey: 3, maxToPerKey: 1,
    },
    staleCertification: false,
    automaticJoinAllowed: true,
  };

  const twoEntityManifest = manifestWith({
    entities: {
      'commerce::entity::order': entity('order', 'model.shop.fct_orders', { businessName: 'Order', grain: 'order_id' }),
      'commerce::entity::customer': entity('customer', 'model.shop.dim_customers', { businessName: 'Customer', grain: 'customer_id' }),
    },
    relationships: { 'commerce::relationship::order_to_customer': certifiedRelationship },
  });

  it('renders the exact key columns, cardinality, and fanout for a two-entity question', () => {
    const plan = planAnalyticalPath(twoEntityManifest, {
      entityIds: ['commerce::entity::order', 'commerce::entity::customer'],
      ownerDomain: 'commerce',
    });
    const prompt = renderAnalyticalPlanPrompt(plan);

    expect(prompt).toBeDefined();
    // The literal key pair is the property that must never silently regress.
    expect(prompt).toContain('keys=customer_id=customer_id');
    expect(prompt).toContain('cardinality=many_to_one');
    expect(prompt).toContain('fanout=safe');
  });

  it('carries the authored business meaning alongside the keys', () => {
    const plan = planAnalyticalPath(twoEntityManifest, {
      entityIds: ['commerce::entity::order', 'commerce::entity::customer'],
      ownerDomain: 'commerce',
    });
    const prompt = renderAnalyticalPlanPrompt(plan)!;

    // Keys tell the model how to join; meaning tells it what the join is for.
    expect(prompt).toContain('means: placed by — Each order is placed by exactly one customer');
    expect(prompt).toContain('Validated against the warehouse on 2026-07-11');
  });

  it('gives a single-entity question its grain and business context', () => {
    const manifest = manifestWith({
      entities: {
        'commerce::entity::order': entity('order', 'model.shop.fct_orders', {
          businessName: 'Order',
          businessContext: 'One completed customer purchase, excluding cancellations.',
          grain: 'order_id',
          keys: ['order_id'],
          analyticalRole: 'event',
        }),
      },
    });
    const plan = planAnalyticalPath(manifest, { entityIds: ['commerce::entity::order'], ownerDomain: 'commerce' });

    // The join planner declines a single entity, which used to mean the most
    // common question shape received no modeling context whatsoever.
    expect(renderAnalyticalPlanPrompt(plan)).toBeUndefined();

    const prompt = renderSingleEntityModelingPrompt(plan, manifest);
    expect(prompt).toBeDefined();
    expect(prompt).toContain('Order (analytics.fct_orders)');
    expect(prompt).toContain('meaning: One completed customer purchase, excluding cancellations.');
    expect(prompt).toContain('grain: one row per order_id');
    expect(prompt).toContain('role: event');
  });

  it('does not offer a single-entity block when nothing was authored', () => {
    const manifest = manifestWith({
      entities: { 'commerce::entity::order': entity('order', 'model.shop.fct_orders') },
    });
    const plan = planAnalyticalPath(manifest, { entityIds: ['commerce::entity::order'], ownerDomain: 'commerce' });
    expect(renderSingleEntityModelingPrompt(plan, manifest)).toBeUndefined();
  });

  it('populates relationshipEvidence so the governed relational compiler can join', () => {
    // `AgentEvidenceCandidate.relationshipEvidence` was declared, rendered into
    // the meaning prompt, and read by `compileGovernedRelationalPlan` via
    // `plan.relationshipPathIds` — but no producer set it, so every
    // multi-relation governed compile returned RELATIONSHIP_PROOF_REQUIRED.
    const evidence = toAgentRetrievalEvidence(
      {
        candidates: [{
          objectKey: 'dbt:column:orders.amount',
          qualifiedId: 'dbt:column:orders.amount',
          objectType: 'sql_column',
          trustTier: 'governed_sql',
          name: 'Revenue Amount',
          aliases: ['revenue'],
          relevanceScore: 1,
          relevanceReasons: ['measure'],
          businessShape: { aggregation: 'sum', entities: ['commerce::entity::order'], dimensions: [], timeGrains: [], parameters: [], sourceRelations: ['commerce::entity::order'] },
        }],
        diagnostics: {},
      } as never,
      { requestedShape: { measures: ['revenue'], dimensions: [], filters: [] }, valueMentions: [], timeTerms: [] } as never,
      {
        contextObjects: [{
          objectKey: 'relationship:commerce::relationship::order_to_customer',
          objectType: 'relationship',
          name: 'order_to_customer',
          fullName: 'commerce::relationship::order_to_customer',
          payload: {
            qualifiedId: 'commerce::relationship::order_to_customer',
            id: 'order_to_customer',
            localId: 'order_to_customer',
            from: 'commerce::entity::order',
            to: 'commerce::entity::customer',
          },
        }] as never,
      },
    );

    expect(evidence.candidates[0]?.relationshipEvidence).toContain('commerce::relationship::order_to_customer');
  });

  it('renders the reporting policy a skill declares instead of dropping it', () => {
    const skill: Skill = {
      id: 'revenue_reporting',
      scope: 'project',
      status: 'active',
      description: 'Govern commerce revenue reporting',
      triggers: ['revenue'],
      exclusions: [],
      preferredMetrics: [],
      preferredBlocks: [],
      vocabulary: {},
      body: 'Use the published gross-revenue metric.',
      analyticalPolicy: {
        timeRole: 'report_as_of',
        calendarId: 'calendar:gregorian',
        timezone: 'America/Chicago',
        completenessPolicy: 'latest_complete',
        comparisonAlignment: 'elapsed_period',
        defaultRankingPeriod: 'current',
        narrativeGuidance: ['State the covered reporting period'],
      },
    } as unknown as Skill;

    const prompt = buildSkillsPrompt([skill], null);

    // Previously only `{policyId, sourceHash}` survived downstream, so every
    // answer re-derived conventions the project had already settled.
    expect(prompt).toContain('time role: report_as_of');
    expect(prompt).toContain('period completeness: latest_complete');
    expect(prompt).toContain('comparison alignment: elapsed_period');
    expect(prompt).toContain('When narrating: State the covered reporting period');
  });
});
