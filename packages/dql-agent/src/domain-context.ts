import type { DQLManifest } from '@duckcodeailabs/dql-core';

export interface DomainContextEnvelope {
  activeDomain: string | null;
  ancestors: string[];
  allowedImports: Array<{
    providerDomain: string;
    exportRef: string;
    purpose: string;
  }>;
  purpose?: string;
  source: 'explicit_ui' | 'explicit_api' | 'inferred';
  confidence: 'high' | 'medium' | 'low';
  snapshotId: string;
}

export interface ResolveDomainContextInput {
  manifest: DQLManifest;
  activeDomain?: string | null;
  purpose?: string;
  source?: DomainContextEnvelope['source'];
  confidence?: DomainContextEnvelope['confidence'];
  snapshotId?: string;
}

/** Resolve ancestry and certified imports from server-owned manifest state. */
export function resolveDomainContextEnvelope(input: ResolveDomainContextInput): DomainContextEnvelope {
  const activeDomain = input.activeDomain?.trim() || null;
  const packages = input.manifest.modeling?.packages ?? {};
  if (activeDomain && !packages[activeDomain]) throw new Error(`Unknown domain: ${activeDomain}`);
  const ancestors: string[] = [];
  const visited = new Set<string>();
  let parent = activeDomain ? packages[activeDomain]?.parent : undefined;
  while (parent) {
    if (visited.has(parent)) throw new Error(`Domain hierarchy cycle involving ${parent}`);
    visited.add(parent);
    ancestors.unshift(parent);
    parent = packages[parent]?.parent;
  }
  const purpose = input.purpose?.trim() || undefined;
  const imports = Object.values(input.manifest.modeling?.interfaces?.imports ?? {});
  const exports = input.manifest.modeling?.interfaces?.exports ?? {};
  const contracts = Object.values(input.manifest.modeling?.contracts ?? {});
  const allowedImports = activeDomain ? imports.flatMap((imported) => {
    const exported = exports[imported.exportRef];
    const purposeAllowed = Boolean(purpose && imported.purpose === purpose);
    if (imported.domain !== activeDomain || imported.status !== 'certified' || exported?.status !== 'certified' || !purposeAllowed) return [];
    if (exported.consumerDomains.length > 0 && !exported.consumerDomains.includes(activeDomain)) return [];
    if (exported.purposes.length > 0 && !exported.purposes.includes(imported.purpose)) return [];
    const contract = exported.contract
      ? contracts.find((value) => value.qualifiedId === exported.contract
        || value.id === exported.contract
        || (value.domain === exported.domain && value.localId === exported.contract))
      : undefined;
    if (!contract || contract.status !== 'certified') return [];
    if (contract.purpose && contract.purpose !== imported.purpose) return [];
    if (exported.entity && !contract.entities.includes(exported.entity)) return [];
    return [{ providerDomain: exported.domain, exportRef: imported.exportRef, purpose: imported.purpose }];
  }) : [];
  return {
    activeDomain,
    ancestors,
    allowedImports,
    purpose,
    source: input.source ?? (activeDomain ? 'explicit_api' : 'inferred'),
    confidence: input.confidence ?? (activeDomain ? 'high' : 'low'),
    snapshotId: input.snapshotId ?? input.manifest.dbtProvenance?.manifestFingerprint ?? 'manifest-v2',
  };
}

export function domainContextSearchDomains(context: DomainContextEnvelope | undefined): string[] {
  if (!context?.activeDomain) return [];
  return [...new Set([context.activeDomain, ...context.ancestors, ...context.allowedImports.map((item) => item.providerDomain)])];
}
