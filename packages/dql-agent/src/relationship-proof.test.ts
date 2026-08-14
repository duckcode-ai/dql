import { describe, expect, it } from 'vitest';
import type { MetricCapabilityContract } from '@duckcodeailabs/dql-core';
import {
  buildResolvedRelationshipProofsV1,
  resolvedRelationshipProofMatches,
} from './relationship-proof.js';

const capability: MetricCapabilityContract = {
  metricId: 'semantic:uncategorized:metric:order_item.revenue',
  measureIds: ['semantic:uncategorized:measure:order_item.revenue'],
  primaryEntityId: 'semantic:uncategorized:entity:order_item',
  defaultResultGrainId: 'semantic:uncategorized:entity:order_item',
  resultGrainIds: ['semantic:uncategorized:entity:order_item', 'semantic:uncategorized:entity:customer'],
  aggregation: 'sum',
  additivity: { entities: 'additive', time: 'additive' },
  dimensions: [{
    dimensionId: 'semantic:uncategorized:dimension:customers.customer_name',
    entityId: 'semantic:uncategorized:entity:customer',
    supportedRoles: ['group_by', 'filter', 'display', 'rank_entity'],
    nativeGroupingReference: 'order_id__customer__customer_name',
    nativeGroupingPath: ['order_id', 'customer'],
  }],
  timeDimensions: [],
  operations: ['filter', 'group', 'rank'],
  supportedOutputKinds: ['dimension', 'metric_value', 'rank'],
  executionCapabilities: [{ route: 'semantic', adapterId: 'metricflow-cli' }],
  sourceFingerprint: 'sha256:jaffle-revenue-capability',
};

describe('ResolvedRelationshipProofV1', () => {
  it('pins the exact native grouping path, adapter, snapshot, capability and dimension', () => {
    const [proof] = buildResolvedRelationshipProofsV1({
      capability,
      dimensionIds: [capability.dimensions[0]!.dimensionId],
      route: 'semantic',
      adapterId: 'metricflow-cli',
      executionId: capability.metricId,
      snapshotId: 'snapshot-jaffle',
    });
    expect(proof).toMatchObject({
      kind: 'semantic_native_grouping',
      nativeGroupingReference: 'order_id__customer__customer_name',
      nativeGroupingPath: ['order_id', 'customer'],
      relationshipPathIds: [],
      adapterId: 'metricflow-cli',
      snapshotId: 'snapshot-jaffle',
      capabilityFingerprint: capability.sourceFingerprint,
    });
    expect(resolvedRelationshipProofMatches({
      proof: proof!, capability, route: 'semantic', adapterId: 'metricflow-cli',
      executionId: capability.metricId, snapshotId: 'snapshot-jaffle',
    })).toBe(true);
  });

  it('rejects changed path, capability fingerprint, adapter, and non-semantic native use', () => {
    const [proof] = buildResolvedRelationshipProofsV1({
      capability,
      dimensionIds: [capability.dimensions[0]!.dimensionId],
      route: 'semantic',
      adapterId: 'metricflow-cli',
      executionId: capability.metricId,
      snapshotId: 'snapshot-jaffle',
    });
    expect(resolvedRelationshipProofMatches({
      proof: { ...proof!, nativeGroupingPath: ['customer'] },
      capability, route: 'semantic', adapterId: 'metricflow-cli',
      executionId: capability.metricId, snapshotId: 'snapshot-jaffle',
    })).toBe(false);
    expect(resolvedRelationshipProofMatches({
      proof: proof!, capability: { ...capability, sourceFingerprint: 'sha256:other' },
      route: 'semantic', adapterId: 'metricflow-cli', executionId: capability.metricId,
      snapshotId: 'snapshot-jaffle',
    })).toBe(false);
    expect(resolvedRelationshipProofMatches({
      proof: proof!, capability, route: 'semantic', adapterId: 'native',
      executionId: capability.metricId, snapshotId: 'snapshot-jaffle',
    })).toBe(false);
    expect(buildResolvedRelationshipProofsV1({
      capability: { ...capability, executionCapabilities: [{ route: 'governed_sql', adapterId: 'sql-ast-v1' }] },
      dimensionIds: [capability.dimensions[0]!.dimensionId],
      route: 'governed_sql', adapterId: 'sql-ast-v1', executionId: capability.metricId,
      snapshotId: 'snapshot-jaffle',
    })).toEqual([]);
  });
});
