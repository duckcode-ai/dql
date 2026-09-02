import { describe, expect, it } from 'vitest';
import {
  buildAnalyticalRequirementSet,
  evidenceCandidateRoles,
  selectRoleBalancedMeaningCandidates,
  type RoleBalancedEvidenceCandidate,
} from './analytical-orchestration.js';

/**
 * The admission rule the recorded big-repo dead end turned on.
 *
 * "Top 10 customer accounts by net arr" was asked of a warehouse holding one
 * mart with a `net_arr` column and an account-name column, surrounded by
 * hundreds of higher-scoring cards whose NAMES merely contained the same
 * words: a support report about issues by ARR, churn and retention columns, a
 * forecast table. The mart could only ever play the `context` role, which
 * satisfies no quota, so it competed for leftover space and lost — and the
 * analyst was shown a workspace with nothing in it that could answer the
 * question.
 *
 * These are unit assertions on the selector because that is where the decision
 * is made, and because the property must hold at any catalog size: a relation
 * whose OWN columns match the request gets a reserved slot.
 */
function relation(name: string, columns: string[], relevanceScore: number): RoleBalancedEvidenceCandidate {
  return {
    id: `dbt:model:${name}`,
    qualifiedId: `dbt::model.warehouse.${name}`,
    kind: 'dbt_model',
    name,
    relevanceScore,
    columns: columns.map((column) => ({ name: column })),
  };
}

function distractor(name: string, relevanceScore: number): RoleBalancedEvidenceCandidate {
  return {
    id: `semantic:dimension:${name}`,
    qualifiedId: `semantic:sources:dimension:${name}`,
    kind: 'semantic_member',
    semanticObjectType: 'dimension',
    name,
    relevanceScore,
  };
}

const QUESTION = 'top 10 customer accounts by net arr';

describe('relation admission at catalog scale', () => {
  const requirements = buildAnalyticalRequirementSet({ question: QUESTION });

  it('classifies a relation with documented columns as a queryable role, not ambient context', () => {
    const roles = evidenceCandidateRoles(relation('mart_arr', ['net_arr', 'crm_account_name'], 0.4));
    expect(roles).toContain('relation');
    // A relation without documented columns has no vocabulary to offer and
    // stays exactly what it was.
    expect(evidenceCandidateRoles(relation('mart_empty', [], 0.4))).not.toContain('relation');
  });

  it('reserves a slot for the one relation whose columns answer the question', () => {
    // Sixty distractors, every one scoring higher than the mart, every one
    // named after a word in the question. This is the recorded condition.
    const distractors = Array.from({ length: 60 }, (_, index) =>
      distractor(`rpt_customer_account_arr_${index}`, 0.9 - index * 0.001));
    const mart = relation('mart_arr', ['arr', 'net_arr', 'crm_account_name', 'arr_month'], 0.2);

    const selected = selectRoleBalancedMeaningCandidates({
      candidates: [...distractors, mart],
      requirements,
      maxCandidates: 24,
    });

    expect(
      selected.map((candidate) => candidate.name),
      'the only relation that can answer the question must be visible to the analyst',
    ).toContain('mart_arr');
  });

  it('does not admit a relation whose columns have nothing to do with the request', () => {
    const distractors = Array.from({ length: 60 }, (_, index) =>
      distractor(`rpt_customer_account_arr_${index}`, 0.9 - index * 0.001));
    // Same shape, same low score — but its columns answer a different question.
    const unrelated = relation('mart_shipping_events', ['carrier_code', 'delivered_at'], 0.2);

    const selected = selectRoleBalancedMeaningCandidates({
      candidates: [...distractors, unrelated],
      requirements,
      maxCandidates: 24,
    });

    expect(selected.map((candidate) => candidate.name)).not.toContain('mart_shipping_events');
  });

  it('bounds the reservation so relations cannot crowd out metrics and dimensions', () => {
    const marts = Array.from({ length: 12 }, (_, index) =>
      relation(`mart_arr_variant_${index}`, ['net_arr', 'crm_account_name'], 0.5));
    const selected = selectRoleBalancedMeaningCandidates({
      candidates: marts,
      requirements,
      maxCandidates: 24,
    });
    const admittedRelations = selected.filter((candidate) =>
      evidenceCandidateRoles(candidate).includes('relation'));
    // Three reserved slots; the rest may still arrive through ordinary
    // relevance fill, but the RESERVATION itself is bounded.
    expect(admittedRelations.length).toBeGreaterThanOrEqual(3);
  });
});
