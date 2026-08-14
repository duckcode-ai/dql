import type { KGNode } from './kg/types.js';

interface MetadataIdentityCarrier {
  objectKey: string;
  fullName?: string;
  payload?: Record<string, unknown>;
}

/**
 * Canonical identities admitted at execution boundaries. A registry-qualified
 * identity supersedes the older domain-only qualified ID; aliases never gain
 * execution authority.
 */
export function authorityIdentitiesForKGNode(node: KGNode): string[] {
  return authorityIdentities(node.nodeId, node.payload);
}

export function authorityIdentitiesForMetadataObject(object: MetadataIdentityCarrier): string[] {
  return unique([
    object.objectKey,
    object.fullName,
    ...authorityIdentities(undefined, object.payload),
  ]);
}

/** Retrieval/display aliases are deliberately separate from authority. */
export function retrievalAliasesForKGNode(node: KGNode): string[] {
  const payload = node.payload ?? {};
  const registryQualifiedId = stringValue(payload.registryQualifiedId);
  const qualifiedId = stringValue(payload.qualifiedId);
  return unique([
    node.name,
    stringValue(payload.localId),
    stringValue(payload.registryReference),
    ...(registryQualifiedId && qualifiedId !== registryQualifiedId ? [qualifiedId] : []),
    ...stringArray(payload.aliases),
  ]);
}

export function semanticRuntimeReferencesForKGNode(node: KGNode): string[] {
  const payload = node.payload ?? {};
  return unique([
    node.name,
    stringValue(payload.localId),
    stringValue(payload.registryReference),
    stringValue(payload.sourceNativeId),
  ]);
}

function authorityIdentities(
  primary: string | undefined,
  payload: Record<string, unknown> | undefined,
): string[] {
  const record = payload ?? {};
  const registryQualifiedId = stringValue(record.registryQualifiedId);
  const qualifiedId = stringValue(record.qualifiedId);
  return unique([
    primary,
    registryQualifiedId,
    ...(!registryQualifiedId ? [qualifiedId] : []),
    stringValue(record.sourceNativeId),
  ]);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    : [];
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
