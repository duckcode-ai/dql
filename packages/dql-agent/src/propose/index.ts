/**
 * `dql propose` — turn dbt evidence into a ranked queue of DRAFT blocks.
 * AI drafts, humans certify. Nothing here is ever written as certified.
 */
export { propose } from './propose.js';
export type {
  ProposeOptions,
  ProposeSummary,
  ProposalResult,
  ProposalInference,
  ProposalRanking,
  ProposedPattern,
} from './propose.js';
export { loadDbtArtifacts } from './dbt-artifacts.js';
export type {
  DbtArtifacts,
  DbtModelNode,
  DbtSourceNode,
  DbtColumn,
} from './dbt-artifacts.js';
export {
  upsertProposedDraft,
  renderProposedDraft,
  blockSlug,
} from './write-draft.js';
export type { ProposedDraftRecord, WrittenDraft } from './write-draft.js';
