import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DbtSourceAuthoringInput,
  ModelingAuthoringChange,
} from '@duckcodeailabs/dql-core';
import type { WriteSkillInput } from './skills/loader.js';

export type ContextAuthoringOrigin =
  | 'manual'
  | 'yaml_import'
  | 'dbt_discovery'
  | 'ai'
  | 'correction';

export type ContextAuthoringOperation =
  | {
      id: string;
      kind: 'modeling_change';
      change: ModelingAuthoringChange;
      dependsOn?: string[];
      evidence?: string[];
    }
  | {
      id: string;
      kind: 'skill_change';
      operation: 'create' | 'update' | 'move';
      value: WriteSkillInput;
      /** Required for update/move so duplicate local ids never collide. */
      targetQualifiedId?: string;
      expectedSourceHash?: string;
      dependsOn?: string[];
      evidence?: string[];
    }
  | {
      id: string;
      kind: 'dbt_source_change';
      change: DbtSourceAuthoringInput;
      dependsOn?: string[];
      evidence?: string[];
    };

export interface ContextAuthoringPatchV1 {
  path: string;
  before: string;
  after: string;
  changed: boolean;
  owner: 'dql' | 'dbt';
  operationId: string;
}

export interface ContextAuthoringDiagnosticV1 {
  code: string;
  severity: 'info' | 'warning' | 'blocking';
  message: string;
  operationId?: string;
}

export interface ContextAuthoringProposalV1 {
  version: 1;
  id: string;
  origin: ContextAuthoringOrigin;
  status: 'proposed' | 'committed' | 'conflicted';
  trustState: 'review_required';
  createdAt: string;
  baseSnapshotId: string;
  dependencyFingerprints: Record<string, string>;
  operations: ContextAuthoringOperation[];
  patches: ContextAuthoringPatchV1[];
  diagnostics: ContextAuthoringDiagnosticV1[];
  impact: {
    files: number;
    modelingChanges: number;
    skillChanges: number;
    dbtSourceChanges: number;
  };
  proposalHash: string;
  sourceRunId?: string;
  sourceArtifactId?: string;
  revision?: number;
  committedAt?: string;
  committedSnapshotId?: string;
}

export type ContextAuthoringProposalInput = Omit<
  ContextAuthoringProposalV1,
  'version' | 'id' | 'status' | 'trustState' | 'createdAt' | 'impact' | 'proposalHash'
> & { id?: string; createdAt?: string };

/** Build an immutable, hash-bound proposal. This function never writes governed source. */
export function buildContextAuthoringProposal(
  input: ContextAuthoringProposalInput,
): ContextAuthoringProposalV1 {
  const proposal = {
    version: 1 as const,
    id: input.id ?? randomUUID(),
    origin: input.origin,
    status: 'proposed' as const,
    trustState: 'review_required' as const,
    createdAt: input.createdAt ?? new Date().toISOString(),
    baseSnapshotId: input.baseSnapshotId,
    dependencyFingerprints: sortRecord(input.dependencyFingerprints),
    operations: input.operations,
    patches: input.patches,
    diagnostics: input.diagnostics,
    impact: {
      files: new Set(input.patches.filter((patch) => patch.changed).map((patch) => patch.path)).size,
      modelingChanges: input.operations.filter((operation) => operation.kind === 'modeling_change').length,
      skillChanges: input.operations.filter((operation) => operation.kind === 'skill_change').length,
      dbtSourceChanges: input.operations.filter((operation) => operation.kind === 'dbt_source_change').length,
    },
    sourceRunId: input.sourceRunId,
    sourceArtifactId: input.sourceArtifactId,
    revision: input.revision,
  };
  return { ...proposal, proposalHash: contextAuthoringProposalHash(proposal) };
}

export function contextAuthoringProposalHash(
  proposal: Omit<ContextAuthoringProposalV1, 'proposalHash'>,
): string {
  return createHash('sha256').update(stableJson({
    version: proposal.version,
    id: proposal.id,
    origin: proposal.origin,
    baseSnapshotId: proposal.baseSnapshotId,
    dependencyFingerprints: proposal.dependencyFingerprints,
    operations: proposal.operations,
    patches: proposal.patches.map(({ path, before, after, owner, operationId }) => ({ path, before, after, owner, operationId })),
    diagnostics: proposal.diagnostics,
    sourceRunId: proposal.sourceRunId,
    sourceArtifactId: proposal.sourceArtifactId,
    revision: proposal.revision,
  })).digest('hex');
}

/**
 * Expand a checkbox selection to the exact dependency closure. The caller must
 * repreview this returned operation set and issue a new proposal hash.
 */
export function contextAuthoringDependencyClosure(
  operations: ContextAuthoringOperation[],
  selectedIds: string[],
): ContextAuthoringOperation[] {
  const byId = new Map(operations.map((operation) => [operation.id, operation]));
  const selected = new Set(selectedIds);
  const visit = (id: string, trail: string[]): void => {
    const operation = byId.get(id);
    if (!operation) throw new Error(`Unknown proposal operation: ${id}`);
    if (trail.includes(id)) throw new Error(`Circular proposal dependency: ${[...trail, id].join(' -> ')}`);
    selected.add(id);
    for (const dependency of operation.dependsOn ?? []) visit(dependency, [...trail, id]);
  };
  for (const id of [...selected]) visit(id, []);
  return operations.filter((operation) => selected.has(operation.id));
}

export class FileContextAuthoringProposalStore {
  readonly directory: string;

  constructor(projectRoot: string) {
    this.directory = join(projectRoot, '.dql', 'local', 'context-proposals');
  }

  save(proposal: ContextAuthoringProposalV1): void {
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(this.path(proposal.id), `${JSON.stringify(proposal, null, 2)}\n`, 'utf8');
  }

  get(id: string): ContextAuthoringProposalV1 | undefined {
    const path = this.path(id);
    if (!existsSync(path)) return undefined;
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as ContextAuthoringProposalV1;
      return value?.version === 1 && value.id === id ? value : undefined;
    } catch {
      return undefined;
    }
  }

  list(): ContextAuthoringProposalV1[] {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory)
      .filter((name) => name.endsWith('.json'))
      .flatMap((name) => {
        const id = name.slice(0, -5);
        const value = this.get(id);
        return value ? [value] : [];
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getCommitReceipt(idempotencyKey: string): { proposalId: string; proposalHash: string; snapshotId: string } | undefined {
    const path = this.receiptPath(idempotencyKey);
    if (!existsSync(path)) return undefined;
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as { proposalId?: unknown; proposalHash?: unknown; snapshotId?: unknown };
      return typeof value.proposalId === 'string' && typeof value.proposalHash === 'string' && typeof value.snapshotId === 'string'
        ? { proposalId: value.proposalId, proposalHash: value.proposalHash, snapshotId: value.snapshotId }
        : undefined;
    } catch {
      return undefined;
    }
  }

  saveCommitReceipt(idempotencyKey: string, receipt: { proposalId: string; proposalHash: string; snapshotId: string }): void {
    mkdirSync(join(this.directory, 'commit-receipts'), { recursive: true });
    writeFileSync(this.receiptPath(idempotencyKey), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  }

  deleteCommitReceipt(idempotencyKey: string): void {
    rmSync(this.receiptPath(idempotencyKey), { force: true });
  }

  private path(id: string): string {
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safe || safe !== id) throw new Error('Invalid context proposal id.');
    return join(this.directory, `${safe}.json`);
  }

  private receiptPath(idempotencyKey: string): string {
    const digest = createHash('sha256').update(idempotencyKey).digest('hex');
    return join(this.directory, 'commit-receipts', `${digest}.json`);
  }
}

function sortRecord(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
