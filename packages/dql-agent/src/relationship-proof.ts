import { createHash } from 'node:crypto';
import type {
  MetricCapabilityContract,
  ResolvedRelationshipProofV1,
} from '@duckcodeailabs/dql-core';

/** Build the sole normalized relationship authority for already selected dimensions. */
export function buildResolvedRelationshipProofsV1(input: {
  capability: MetricCapabilityContract;
  dimensionIds: string[];
  route: MetricCapabilityContract['executionCapabilities'][number]['route'];
  adapterId?: string;
  executionId: string;
  snapshotId: string;
}): ResolvedRelationshipProofV1[] {
  const route = input.capability.executionCapabilities.find((candidate) =>
    candidate.route === input.route && candidate.adapterId === input.adapterId);
  if (!route) return [];
  const dimensionIds = new Set(input.dimensionIds);
  return input.capability.dimensions
    .filter((dimension) => dimensionIds.has(dimension.dimensionId))
    .filter((dimension) => dimension.entityId !== input.capability.primaryEntityId)
    .flatMap((dimension) => {
      const relationshipPathIds = uniqueSorted(dimension.relationshipPathIds ?? []);
      const nativeGroupingReference = dimension.nativeGroupingReference?.trim();
      const nativeGroupingPath = dimension.nativeGroupingPath === undefined
        ? undefined
        : [...dimension.nativeGroupingPath];
      const kind = relationshipPathIds.length > 0
        ? 'dql_relationship_path' as const
        : input.route === 'semantic' && Boolean(input.adapterId)
          && Boolean(nativeGroupingReference) && nativeGroupingPath !== undefined
          ? 'semantic_native_grouping' as const
          : undefined;
      if (!kind) return [];
      const body = {
        version: 1 as const,
        kind,
        metricId: input.capability.metricId,
        dimensionId: dimension.dimensionId,
        sourceEntityId: input.capability.primaryEntityId,
        targetEntityId: dimension.entityId,
        route: input.route,
        ...(input.adapterId ? { adapterId: input.adapterId } : {}),
        executionId: input.executionId,
        snapshotId: input.snapshotId,
        capabilityFingerprint: input.capability.sourceFingerprint,
        relationshipPathIds,
        ...(nativeGroupingReference ? { nativeGroupingReference } : {}),
        ...(nativeGroupingPath !== undefined ? { nativeGroupingPath } : {}),
      };
      return [{ ...body, authorityFingerprint: fingerprint(body) }];
    })
    .sort((left, right) => left.dimensionId.localeCompare(right.dimensionId));
}

export function resolvedRelationshipProofMatches(input: {
  proof: ResolvedRelationshipProofV1;
  capability: MetricCapabilityContract;
  route: MetricCapabilityContract['executionCapabilities'][number]['route'];
  adapterId?: string;
  executionId: string;
  snapshotId: string;
}): boolean {
  const expected = buildResolvedRelationshipProofsV1({
    capability: input.capability,
    dimensionIds: [input.proof.dimensionId],
    route: input.route,
    ...(input.adapterId ? { adapterId: input.adapterId } : {}),
    executionId: input.executionId,
    snapshotId: input.snapshotId,
  });
  return expected.length === 1
    && expected[0]!.authorityFingerprint === input.proof.authorityFingerprint
    && stableStringify(expected[0]) === stableStringify(input.proof);
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}
