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
  ANALYTICAL_FAILURE_VERSION,
  ANALYTICAL_QUESTION_FRAME_VERSION,
  analyticalRepairTrustTransition,
  normalizeAnalyticalFailureV1,
  normalizeAnalyticalQuestionFrameV2,
  normalizeMetricCapabilityContract,
  type AnalyticalAmbiguityV2,
  type AnalyticalComparisonV2,
  type AnalyticalDimensionBindingV2,
  type AnalyticalDimensionRole,
  type AnalyticalFailureCode,
  type AnalyticalFailurePhase,
  type AnalyticalFailureRecoverability,
  type AnalyticalFailureV1,
  type AnalyticalMemberBindingV2,
  type AnalyticalOperation,
  type AnalyticalPeriodKind,
  type AnalyticalPeriodV2,
  type AnalyticalPolicyContract,
  type AnalyticalQuestionFrameV2,
  type AnalyticalQuestionType,
  type AnalyticalRankingV2,
  type AnalyticalRepairChange,
  type AnalyticalRepairTrustTransition,
  type AnalyticalRequestedOutputV2,
  type AnalyticalTimeContextV2,
  type AnalyticalTrustState,
  type MetricCapabilityContract,
} from './analytical.js';
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
