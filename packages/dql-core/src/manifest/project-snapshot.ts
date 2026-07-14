/**
 * Atomic, immutable project snapshots for long-running runtime operations.
 *
 * A candidate is built completely before it replaces the current snapshot.
 * Failed candidates never expose partially-built state; callers may continue to
 * read the last good snapshot with `stale: true` and an attached failure.
 *
 * Acceptance: CTX-002, PERF-001.
 */

export interface ProjectSnapshot<T> {
  readonly snapshotId: string;
  readonly sourceVersion: string;
  readonly value: T;
  readonly stale: boolean;
  readonly error?: string;
}

export class ProjectSnapshotMismatchError extends Error {
  readonly code = 'PROJECT_SNAPSHOT_MISMATCH';

  constructor(readonly expectedSnapshotId: string, readonly currentSnapshotId: string) {
    super(`Project snapshot changed during the operation (expected ${expectedSnapshotId}, current ${currentSnapshotId}). Retry against the current snapshot.`);
    this.name = 'ProjectSnapshotMismatchError';
  }
}

export class ProjectSnapshotService<T> {
  #current: ProjectSnapshot<T> | null = null;
  #invalidated = false;

  current(): ProjectSnapshot<T> | null {
    return this.#current;
  }

  invalidate(): void {
    this.#invalidated = true;
  }

  refresh(sourceVersion: string, buildCandidate: () => T): ProjectSnapshot<T> {
    if (!this.#invalidated && this.#current?.sourceVersion === sourceVersion) return this.#current;

    try {
      // Do not mutate #current until the candidate is complete. `buildCandidate`
      // may safely call current() and will observe the prior coherent snapshot.
      const value = buildCandidate();
      const candidate = Object.freeze({
        snapshotId: sourceVersion,
        sourceVersion,
        value,
        stale: false,
      }) satisfies ProjectSnapshot<T>;
      this.#current = candidate;
      this.#invalidated = false;
      return candidate;
    } catch (error) {
      if (!this.#current) throw error;
      // Preserve the last good value and identity. The wrapper is new and
      // immutable so no reader can observe a half-updated snapshot.
      this.#current = Object.freeze({
        ...this.#current,
        stale: true,
        error: error instanceof Error ? error.message : String(error),
      });
      this.#invalidated = true;
      return this.#current;
    }
  }

  assertCurrent(snapshotId: string): void {
    const current = this.#current;
    if (!current || current.snapshotId !== snapshotId || current.stale) {
      throw new ProjectSnapshotMismatchError(snapshotId, current?.snapshotId ?? 'none');
    }
  }
}
