/**
 * `dql propose` — turn dbt evidence into a ranked queue of DRAFT blocks.
 * AI drafts, humans certify. Nothing here is ever written as certified.
 */
export { propose, proposePlan } from './propose.js';
export type {
  ProposeOptions,
  ProposeSummary,
  ProposalResult,
  ProposalInference,
  ProposalRanking,
  ProposedPattern,
  ProposePlan,
  ProposePlanOptions,
  ProposePlanDomain,
  ProposePlanCandidate,
} from './propose.js';
export {
  resolveProposeConfig,
  DEFAULT_PROPOSE_CONFIG,
} from './config.js';
export type { ProposeConfig, ProposeConfigInput } from './config.js';
export { classifyModel, resolveDomain } from './classify.js';
export type { Classification, ClassificationResult } from './classify.js';
export { loadDbtArtifacts } from './dbt-artifacts.js';
export type {
  DbtArtifacts,
  DbtModelNode,
  DbtSourceNode,
  DbtColumn,
  SemanticMetricRef,
  SemanticModelRef,
} from './dbt-artifacts.js';
export { buildBusinessQuery } from './generate-sql.js';
export {
  upsertProposedDraft,
  renderProposedDraft,
  blockSlug,
} from './write-draft.js';
export type { ProposedDraftRecord, WrittenDraft } from './write-draft.js';
