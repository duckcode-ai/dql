import { createHash } from 'node:crypto';
import type {
  AppBuildSourceCapabilities,
  AppBuildSourceLifecycle,
  AppBuildSourcePolicy,
} from '@duckcodeailabs/dql-core';
import {
  acquireActiveKnowledgeSnapshot,
  type MetadataObject,
} from './metadata/catalog.js';

export type AppSourceTrust = 'certified' | 'review_required';

export interface AppSourceEligibility {
  discoverable: boolean;
  localPreview: boolean;
  projectPublish: boolean;
  reasonCodes: string[];
}

export interface AppSourceCatalogRecord {
  sourceId: string;
  qualifiedIdentity: string;
  sourceRevision: string;
  snapshotId: string;
  kind: 'block';
  lifecycle: AppBuildSourceLifecycle;
  trust: AppSourceTrust;
  executable: boolean;
  name: string;
  title: string;
  description?: string;
  domain?: string;
  owner?: string;
  sourcePath: string;
  executionRef: string;
  tags: string[];
  capabilities: AppBuildSourceCapabilities;
  eligibility: AppSourceEligibility;
  score?: number;
  reasons: string[];
}

export interface AppSourceCatalogQuery {
  query?: string;
  cursor?: string;
  limit?: number;
  lifecycles?: AppBuildSourceLifecycle[];
  domains?: string[];
  kinds?: Array<'block'>;
  sourcePolicy?: AppBuildSourcePolicy;
  includeDeprecated?: boolean;
}

export interface AppSourceCatalogPage {
  version: 1;
  snapshotId: string;
  items: AppSourceCatalogRecord[];
  nextCursor?: string;
  total: number;
  pageSize: number;
  facets: {
    lifecycles: Record<string, number>;
    domains: Record<string, number>;
    kinds: Record<string, number>;
  };
}

type AppSourceCursor = {
  version: 1;
  snapshotId: string;
  offset: number;
  queryHash: string;
};

const APP_SOURCE_OBJECT_TYPE = 'dql_block_source';
const DEFAULT_LIFECYCLES: AppBuildSourceLifecycle[] = [
  'certified',
  'review',
  'draft',
  'pending_recertification',
  'unknown',
];

/**
 * Query the immutable project snapshot used by the App Builder request. The
 * caller is responsible for preparing/activating the project snapshot once;
 * this function performs no source-artifact reads.
 *
 * Acceptance: PRD-007, AGT-026, API-014, PERF-003.
 */
export function queryAppSourceCatalog(
  projectRoot: string,
  input: AppSourceCatalogQuery = {},
): AppSourceCatalogPage {
  const lease = acquireActiveKnowledgeSnapshot(projectRoot);
  try {
    const query = input.query?.trim() ?? '';
    // A cursor is valid only for the exact result set it was issued for. This
    // prevents a browser from accidentally reusing page two after a trust or
    // domain facet changes and composing sources the user did not review.
    const queryHash = hashText(JSON.stringify({
      query,
      lifecycles: [...(input.lifecycles ?? [])].sort(),
      domains: [...(input.domains ?? [])].sort(),
      kinds: [...(input.kinds ?? [])].sort(),
      sourcePolicy: input.sourcePolicy ?? 'governed_only',
      includeDeprecated: input.includeDeprecated === true,
    }));
    const cursor = decodeCursor(input.cursor);
    if (cursor && (cursor.snapshotId !== lease.snapshotId || cursor.queryHash !== queryHash)) {
      throw new AppSourceCatalogError(
        'APP_SOURCE_CURSOR_STALE',
        'The App source catalog changed. Refresh the source list before continuing.',
      );
    }
    const offset = cursor?.offset ?? 0;
    const pageSize = Math.min(100, Math.max(1, Math.floor(input.limit ?? 50)));
    const lifecycles = input.lifecycles?.length
      ? input.lifecycles
      : input.includeDeprecated
        ? [...DEFAULT_LIFECYCLES, 'deprecated']
        : DEFAULT_LIFECYCLES;
    const result = lease.catalog.queryObjectsPage({
      query,
      objectTypes: [APP_SOURCE_OBJECT_TYPE],
      domains: input.domains,
      statuses: lifecycles,
      offset,
      limit: pageSize,
    });
    const policy = input.sourcePolicy ?? 'governed_only';
    const items = result.items.map((object) => appSourceFromMetadata(object, lease.snapshotId, policy));
    const nextOffset = offset + items.length;
    const inventory = lease.catalog.listAllObjects({ objectTypes: [APP_SOURCE_OBJECT_TYPE] })
      .filter((object) => input.includeDeprecated || object.status !== 'deprecated');
    return {
      version: 1,
      snapshotId: lease.snapshotId,
      items,
      ...(nextOffset < result.total
        ? { nextCursor: encodeCursor({ version: 1, snapshotId: lease.snapshotId, offset: nextOffset, queryHash }) }
        : {}),
      total: result.total,
      pageSize,
      facets: buildFacets(inventory),
    };
  } finally {
    lease.release();
  }
}

/** Exact, snapshot-bound batch resolution used before server composition. */
export function resolveAppSourceCatalogRecords(
  projectRoot: string,
  sourceIds: string[],
  sourcePolicy: AppBuildSourcePolicy = 'governed_only',
): { snapshotId: string; items: AppSourceCatalogRecord[]; missingSourceIds: string[] } {
  const uniqueIds = Array.from(new Set(sourceIds.map((id) => id.trim()).filter(Boolean)));
  if (uniqueIds.length > 100) {
    throw new AppSourceCatalogError('APP_SOURCE_RESOLVE_LIMIT', 'At most 100 App sources can be resolved at once.');
  }
  const lease = acquireActiveKnowledgeSnapshot(projectRoot);
  try {
    const objects = lease.catalog.getObjectsByKeys(uniqueIds)
      .filter((object) => object.objectType === APP_SOURCE_OBJECT_TYPE);
    const byId = new Map(objects.map((object) => [object.objectKey, object]));
    return {
      snapshotId: lease.snapshotId,
      items: uniqueIds.flatMap((id) => {
        const object = byId.get(id);
        return object ? [appSourceFromMetadata(object, lease.snapshotId, sourcePolicy)] : [];
      }),
      missingSourceIds: uniqueIds.filter((id) => !byId.has(id)),
    };
  } finally {
    lease.release();
  }
}

/** Return a bounded candidate-card set for one App-specific planning call. */
export function shortlistAppSources(
  projectRoot: string,
  prompt: string,
  options: { sourcePolicy?: AppBuildSourcePolicy; limit?: number; domains?: string[] } = {},
): AppSourceCatalogPage {
  const limit = Math.min(12, Math.max(8, Math.floor(options.limit ?? 12)));
  const primary = queryAppSourceCatalog(projectRoot, {
    query: prompt,
    limit,
    domains: options.domains,
    sourcePolicy: options.sourcePolicy,
  });
  if (primary.items.length >= limit) return primary;
  const fallback = queryAppSourceCatalog(projectRoot, {
    limit,
    domains: options.domains,
    sourcePolicy: options.sourcePolicy,
  });
  const seen = new Set(primary.items.map((item) => item.sourceId));
  const items = [...primary.items, ...fallback.items.filter((item) => !seen.has(item.sourceId))].slice(0, limit);
  return { ...primary, items, nextCursor: undefined };
}

export class AppSourceCatalogError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AppSourceCatalogError';
  }
}

function appSourceFromMetadata(
  object: MetadataObject,
  snapshotId: string,
  sourcePolicy: AppBuildSourcePolicy,
): AppSourceCatalogRecord {
  const payload = object.payload ?? {};
  const lifecycle = appSourceLifecycle(object.status);
  const certified = lifecycle === 'certified';
  const policyAllowsPreview = certified || sourcePolicy === 'include_review_required';
  const deprecated = lifecycle === 'deprecated';
  const reasonCodes = deprecated
    ? ['SOURCE_DEPRECATED']
    : certified
      ? []
      : sourcePolicy === 'governed_only'
        ? ['ENABLE_REVIEW_REQUIRED_SOURCES']
        : ['REVIEW_REQUIRED_SOURCE'];
  const sourcePath = stringValue(object.sourcePath) ?? stringValue(payload.executionRef) ?? '';
  const capabilities: AppBuildSourceCapabilities = {
    measures: stringArray(payload.measures),
    dimensions: stringArray(payload.dimensions),
    outputs: stringArray(payload.declaredOutputs),
    filters: stringArray(payload.allowedFilters),
    ...(stringValue(payload.grain) ? { grain: stringValue(payload.grain) } : {}),
    ...(stringValue(payload.chartType) ? { chartType: stringValue(payload.chartType) } : {}),
    allowedVisualizations: stringArray(payload.allowedVisualizations),
    parameters: Array.isArray(payload.parameters)
      ? payload.parameters.flatMap((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
        const parameter = value as Record<string, unknown>;
        const name = stringValue(parameter.name);
        if (!name) return [];
        return [{
          name,
          ...(stringValue(parameter.type) ? { type: stringValue(parameter.type) } : {}),
          required: parameter.required === true,
          hasDefault: parameter.hasDefault === true,
        }];
      })
      : [],
  };
  return {
    sourceId: object.objectKey,
    qualifiedIdentity: stringValue(payload.qualifiedId) ?? object.fullName ?? object.objectKey,
    sourceRevision: stringValue(payload.sourceRevision) ?? stringValue(payload.fingerprint) ?? 'unknown',
    snapshotId,
    kind: 'block',
    lifecycle,
    trust: certified ? 'certified' : 'review_required',
    executable: Boolean(sourcePath),
    name: object.name,
    title: object.name,
    description: object.description,
    domain: object.domain,
    owner: object.owner,
    sourcePath,
    executionRef: stringValue(payload.executionRef) ?? sourcePath,
    tags: stringArray(payload.tags),
    capabilities,
    eligibility: {
      discoverable: !deprecated,
      localPreview: !deprecated && policyAllowsPreview,
      projectPublish: !deprecated && certified,
      reasonCodes,
    },
    score: object.score,
    reasons: object.snippet ? [object.snippet] : [],
  };
}

function buildFacets(objects: MetadataObject[]): AppSourceCatalogPage['facets'] {
  const facets: AppSourceCatalogPage['facets'] = { lifecycles: {}, domains: {}, kinds: { block: objects.length } };
  for (const object of objects) {
    const lifecycle = appSourceLifecycle(object.status);
    facets.lifecycles[lifecycle] = (facets.lifecycles[lifecycle] ?? 0) + 1;
    const domain = object.domain ?? 'Unassigned';
    facets.domains[domain] = (facets.domains[domain] ?? 0) + 1;
  }
  return facets;
}

function appSourceLifecycle(value: string | undefined): AppBuildSourceLifecycle {
  if (value === 'certified' || value === 'review' || value === 'draft'
    || value === 'pending_recertification' || value === 'deprecated') return value;
  return 'unknown';
}

function encodeCursor(cursor: AppSourceCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string | undefined): AppSourceCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<AppSourceCursor>;
    if (parsed.version !== 1 || typeof parsed.snapshotId !== 'string'
      || typeof parsed.offset !== 'number' || typeof parsed.queryHash !== 'string') throw new Error('invalid');
    return parsed as AppSourceCursor;
  } catch {
    throw new AppSourceCatalogError('APP_SOURCE_CURSOR_INVALID', 'The App source cursor is invalid. Refresh the source list.');
  }
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim()))).sort()
    : [];
}
