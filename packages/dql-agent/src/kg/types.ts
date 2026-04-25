/**
 * Knowledge graph node + edge shapes for the DQL agent.
 *
 * The KG is built from the compiled `dql-manifest.json` (blocks, dashboards,
 * apps, metrics, dimensions, sources) plus dbt manifest data and the project's
 * Skills folder. It is stored in SQLite at `.dql/cache/agent-kg.sqlite` with
 * an FTS5 index for keyword search and structured filters for domain/kind.
 */

export type KGNodeKind =
  | 'block'
  | 'metric'
  | 'dimension'
  | 'domain'
  | 'dbt_model'
  | 'dbt_source'
  | 'dashboard'
  | 'app'
  | 'skill';

export interface KGNode {
  /** Stable identifier — `${kind}:${name}` (lower-cased). */
  nodeId: string;
  kind: KGNodeKind;
  name: string;
  domain?: string;
  status?: string;
  owner?: string;
  description?: string;
  tags?: string[];
  /** Free-form natural-language context for the LLM (block.llmContext, skill body, etc.). */
  llmContext?: string;
  /** Question/SQL pairs the agent can few-shot on. */
  examples?: Array<{ question: string; sql?: string }>;
  /** Path on disk so the UI can deep-link. */
  sourcePath?: string;
  /** Pinned git SHA at index time. */
  gitSha?: string;
}

export interface KGEdge {
  src: string;
  dst: string;
  kind: 'feeds_into' | 'reads_from' | 'aggregates' | 'visualizes' | 'depends_on' | 'contains' | 'related_to';
  weight?: number;
}

export interface KGSearchHit {
  node: KGNode;
  /** BM25-derived score (lower is better in raw FTS5; we expose 1/(1+rank) so higher is better). */
  score: number;
  /** Match snippets per field, useful for UI surfacing. */
  snippet?: string;
}

export interface KGFeedbackRow {
  id: string;
  ts: string; // ISO-8601
  user: string;
  question: string;
  answerKind: 'certified' | 'uncertified';
  blockId?: string;
  rating: 'up' | 'down';
  comment?: string;
}

export interface KGSearchOptions {
  query: string;
  /** Restrict to specific kinds. Defaults to all. */
  kinds?: KGNodeKind[];
  /** Restrict to a domain. */
  domain?: string;
  /** Maximum hits to return. */
  limit?: number;
}
