/**
 * DataLex contract resolution for DQL.
 *
 * Public surface for the consumer side of the manifest-spec
 * `datalex_contract` interop pattern. Keeps DQL's compile-time check on
 * `datalex_contract = "..."` references decoupled from DataLex's compiler:
 * we only depend on the published manifest schema.
 */

export { DataLexContractRegistry } from './registry.js';
export {
  parseContractRef,
  type ContractId,
  type ContractParam,
  type ContractRef,
  type ContractResolution,
  type ContractSignature,
  type DataLexBinding,
  type DataLexConformance,
  type DataLexConformancePhysical,
  type DataLexContract,
  type DataLexDiagnostic,
  type DataLexDomain,
  type DataLexEntity,
  type DataLexField,
  type DataLexGlossaryTerm,
  type DataLexManifest,
  type DataLexManifestProject,
  type DataLexRelationship,
  type DataLexRelationshipEndpoint,
  type JoinPathResolution,
  type RelationshipCardinality,
} from './types.js';
