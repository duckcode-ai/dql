import { describe, expect, it } from 'vitest';
import { ProjectSnapshotMismatchError, ProjectSnapshotService } from './project-snapshot.js';

describe('ProjectSnapshotService (CTX-002)', () => {
  it('publishes a complete candidate atomically and never exposes mixed state', () => {
    const service = new ProjectSnapshotService<{ models: string[]; domains: string[] }>();
    const first = service.refresh('snapshot-a', () => ({ models: ['a'], domains: ['commerce'] }));
    let observedDuringBuild = service.current();
    const second = service.refresh('snapshot-b', () => {
      observedDuringBuild = service.current();
      return { models: ['b'], domains: ['growth'] };
    });

    expect(observedDuringBuild).toBe(first);
    expect(second).toEqual(expect.objectContaining({ snapshotId: 'snapshot-b', value: { models: ['b'], domains: ['growth'] } }));
    expect(service.current()).toBe(second);
  });

  it('keeps the last good snapshot when a candidate fails', () => {
    const service = new ProjectSnapshotService<{ generation: number }>();
    const first = service.refresh('snapshot-a', () => ({ generation: 1 }));
    const stale = service.refresh('snapshot-b', () => { throw new Error('candidate failed'); });

    expect(stale.snapshotId).toBe(first.snapshotId);
    expect(stale.value).toBe(first.value);
    expect(stale.stale).toBe(true);
    expect(stale.error).toBe('candidate failed');
  });

  it('rejects a final guard when the project moved to another snapshot', () => {
    const service = new ProjectSnapshotService<{ generation: number }>();
    service.refresh('snapshot-a', () => ({ generation: 1 }));
    service.refresh('snapshot-b', () => ({ generation: 2 }));
    expect(() => service.assertCurrent('snapshot-a')).toThrow(ProjectSnapshotMismatchError);
    expect(() => service.assertCurrent('snapshot-b')).not.toThrow();
  });
});
