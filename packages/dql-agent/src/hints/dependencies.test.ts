import { describe, expect, it } from 'vitest';
import {
  assessHintFreshness,
  collectHintDependencies,
  currentHintDependencyFingerprints,
} from './dependencies.js';

function dbtModel(checksum: string) {
  return {
    objectKey: 'dbt:model:orders',
    objectType: 'dbt_model',
    name: 'orders',
    fullName: 'jaffle_shop.dev.orders',
    sourcePath: 'models/marts/orders.sql',
    payload: {
      checksum: { name: 'sha256', checksum },
      relation: 'jaffle_shop.dev.orders',
    },
  };
}

describe('governed hint dependency freshness', () => {
  it('invalidates a dbt-scoped hint when dbt model content changes', () => {
    const captured = collectHintDependencies({
      scope: { dbtModel: 'orders' },
      objects: [dbtModel('model-v1')],
      relations: [],
    });
    const current = currentHintDependencyFingerprints({
      objects: [dbtModel('model-v2')],
      relations: [],
    });

    const freshness = assessHintFreshness({
      dependencies: captured.dependencies,
      snapshotId: 'project-v1',
      currentDependencies: current,
      currentSnapshotId: 'project-v2',
    });

    expect(freshness.current).toBe(false);
    expect(freshness.staleDependencies.map((item) => item.id)).toContain('dbt_model:dbt:model:orders');
  });

  it('keeps a scoped hint current across unrelated project snapshot drift', () => {
    const captured = collectHintDependencies({
      scope: { dbtModel: 'orders' },
      objects: [dbtModel('model-v1')],
      relations: [],
    });
    const current = currentHintDependencyFingerprints({
      objects: [dbtModel('model-v1')],
      relations: [],
    });

    expect(assessHintFreshness({
      dependencies: captured.dependencies,
      snapshotId: 'project-v1',
      currentDependencies: current,
      currentSnapshotId: 'project-v2',
    })).toMatchObject({
      snapshotCurrent: false,
      dependenciesCurrent: true,
      current: true,
      staleDependencies: [],
    });
  });

  it('fails closed on snapshot drift for legacy hints without dependencies', () => {
    expect(assessHintFreshness({
      snapshotId: 'project-v1',
      currentSnapshotId: 'project-v2',
    }).current).toBe(false);
  });

  it('preserves pre-v3 unversioned approved-hint retrieval compatibility', () => {
    expect(assessHintFreshness({
      currentSnapshotId: 'project-v2',
    }).current).toBe(true);
  });
});
