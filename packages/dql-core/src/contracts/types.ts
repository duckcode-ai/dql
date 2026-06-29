/**
 * TypeScript types for the DataLex manifest, mirroring the v1 schema published
 * at duckcode-ai/manifest-spec
 * (`schemas/v1/datalex-manifest.schema.json`).
 *
 * These types are the consumer-side contract: dql-core treats incoming
 * DataLex manifests as untrusted input and validates them before use. The
 * source of truth is the JSON Schema; if these types drift, the schema wins.
 */

/** Identifier of a DataLex contract, e.g. `commerce.Customer.monthly_active_customers`. */
export type ContractId = string;

/**
 * Pinned reference to a contract from a DQL block. May include a major
 * version pin like `commerce.Customer.monthly_active_customers@1`.
 */
export type ContractRef = string;

export interface ContractParam {
  name: string;
  type: string;
  description?: string;
  constraints?: string[];
}

export interface ContractSignature {
  inputs?: ContractParam[];
  outputs?: ContractParam[];
}

export interface DataLexContract {
  id: ContractId;
  name: string;
  description?: string;
  /** Integer version, monotonic per contract id. */
  version: number;
  signature?: ContractSignature;
  owner?: string;
  tags?: string[];
}

export interface DataLexBinding {
  kind: 'dbt_model' | 'dbt_source' | 'view' | 'table' | 'external';
  ref: string;
}

export interface DataLexField {
  name: string;
  type?: string;
  description?: string;
  primary_key?: boolean;
  nullable?: boolean;
  unique?: boolean;
  tags?: string[];
  classification?: string;
}

export interface DataLexEntity {
  name: string;
  description?: string;
  tags?: string[];
  fields?: DataLexField[];
  contracts?: DataLexContract[];
  binding?: DataLexBinding;
}

export interface DataLexGlossaryTerm {
  term: string;
  definition: string;
  tags?: string[];
  related_fields?: string[];
}

export interface DataLexDomain {
  name: string;
  description?: string;
  owners?: string[];
  entities: DataLexEntity[];
  glossary?: DataLexGlossaryTerm[];
}

export interface DataLexManifestProject {
  name: string;
  description?: string;
  dialect?: string;
  owners?: string[];
}

export interface DataLexDiagnostic {
  severity: 'info' | 'warning' | 'error';
  message: string;
  path?: string;
  code?: string;
}

export interface DataLexRelationshipEndpoint {
  domain?: string;
  entity: string;
  column?: string;
  role?: string;
}

export type RelationshipCardinality =
  | 'one_to_one'
  | 'one_to_many'
  | 'many_to_one'
  | 'many_to_many';

export interface DataLexRelationship {
  name: string;
  type?: 'reference' | 'associative' | 'subtype' | 'supertype';
  layer?: 'conceptual' | 'logical' | 'physical';
  from: DataLexRelationshipEndpoint;
  to: DataLexRelationshipEndpoint;
  cardinality?: RelationshipCardinality;
  optional?: boolean;
  identifying?: boolean;
  verb?: string;
  role_name?: string;
  description?: string;
}

export interface DataLexConformancePhysical {
  entity: string;
  binding?: DataLexBinding;
}

export interface DataLexConformance {
  concept: string;
  domain?: string;
  layer?: 'conceptual' | 'logical';
  canonical_key?: string[];
  business_key?: string[];
  implements?: string[];
  physical?: DataLexConformancePhysical[];
}

export interface DataLexManifest {
  /** Manifest spec major.minor.patch this artifact validates against (v1.x). */
  manifestSpecVersion: string;
  /** DataLex compiler version that produced this manifest. */
  datalexVersion: string;
  /** RFC3339 timestamp when the manifest was emitted. */
  generatedAt: string;
  project: DataLexManifestProject;
  domains: DataLexDomain[];
  /** Typed cross-entity relationships (any layer) for grain-safe join planning. */
  relationships?: DataLexRelationship[];
  /** Concept-to-physical conformance records (canonical key + realizing models). */
  conformance?: DataLexConformance[];
  diagnostics?: DataLexDiagnostic[];
}

/**
 * Result of resolving a contract id against a registry. Carries either the
 * resolved contract + its location in the manifest, or a structured error
 * suitable for emitting as a DQL compiler diagnostic.
 */
export type ContractResolution =
  | {
      ok: true;
      contract: DataLexContract;
      domain: string;
      entity: string;
    }
  | {
      ok: false;
      reason: 'not_found' | 'version_mismatch' | 'malformed_ref';
      message: string;
      requestedRef: ContractRef;
      requestedVersion?: number;
      availableVersions?: number[];
    };

/**
 * Result of resolving a grain-safe join path between two entities, oriented so
 * `base` is the grain to preserve and `target` is the entity being joined in.
 * `fansOut` is true when the join can multiply base rows (one_to_many /
 * many_to_many) — the signal Tier-2 SQL generation needs to stay grain-safe.
 */
export type JoinPathResolution =
  | {
      ok: true;
      relationship: DataLexRelationship;
      base: DataLexRelationshipEndpoint;
      target: DataLexRelationshipEndpoint;
      cardinality?: RelationshipCardinality;
      fansOut: boolean;
    }
  | {
      ok: false;
      reason: 'no_relationship' | 'ambiguous';
      message: string;
    };

/** Parse a contract reference like `domain.Entity.contract@1` into its parts. */
export function parseContractRef(ref: ContractRef): {
  ok: boolean;
  id?: ContractId;
  version?: number;
  reason?: string;
} {
  if (typeof ref !== 'string' || ref.trim() === '') {
    return { ok: false, reason: 'empty contract reference' };
  }
  const [idPart, versionPart] = ref.split('@', 2);
  const idMatch = /^[a-zA-Z][a-zA-Z0-9_]*\.[A-Z][A-Za-z0-9]*\.[a-z][a-z0-9_]*$/.test(idPart);
  if (!idMatch) {
    return {
      ok: false,
      reason: `contract id must be <domain>.<Entity>.<contract_name>; got "${idPart}"`,
    };
  }
  if (versionPart === undefined) {
    return { ok: true, id: idPart };
  }
  const version = Number.parseInt(versionPart, 10);
  if (!Number.isInteger(version) || version < 1 || String(version) !== versionPart) {
    return {
      ok: false,
      reason: `contract version must be a positive integer; got "${versionPart}"`,
    };
  }
  return { ok: true, id: idPart, version };
}
