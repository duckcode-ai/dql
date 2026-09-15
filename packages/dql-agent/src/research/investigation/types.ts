/**
 * RESEARCH AS AN INVESTIGATION OF A CHANGE.
 *
 * A question is framed once (which metric, over which date field, which
 * periods), and every figure the report states comes from a settled reading
 * run through the Ask pipeline: the same policies, tiers, proofs and receipts
 * as an ordinary answer. These are the shapes the frame, the queries, the
 * report and the receipt share.
 */
import type { AnalyticalIntentV1, Grain, IntentMeasure, IntentPredicate } from '../../ask-pipeline/intent.js';
import type { AskStoryStepV1, PipelineOutcome, PipelineReceipt } from '../../ask-pipeline/outcomes.js';
import type { ResultColumnMeta } from '../../ask-pipeline/execute.js';
import type { VocabularyIndex } from '../../ask-pipeline/vocabulary.js';
import type { AskNarrationFactSetV1 } from '../../ask-result-narration.js';

/** A half-open date window, `YYYY-MM-DD`, with the words a reader sees. */
export interface InvestigationWindow { start: string; end: string; label: string }

export type MetricAdditivity = 'additive' | 'ratio' | 'non_additive';

export interface InvestigationMetric {
  ref: string;
  label: string;
  additivity: MetricAdditivity;
  /** How a physical column is aggregated (a `column:` ref); governed metrics carry their own. */
  aggregation?: IntentMeasure['aggregation'];
  /** A ratio's parts, when the reading or the vocabulary names them. */
  ratio?: { numeratorRef: string; denominatorRef: string; numeratorAggregation?: string; denominatorAggregation?: string };
}

export interface InvestigationFrameV1 {
  version: 1;
  question: string;
  reading: string;
  source: { kind: 'question' } | { kind: 'run'; runId: string };
  metric: InvestigationMetric;
  timeRef: string;
  grain: Grain;
  windows: { current: InvestigationWindow; prior: InvestigationWindow; yearAgo: InvestigationWindow; yearAgoPrior: InvestigationWindow };
  /** Where the current window came from. */
  windowBasis: 'stated' | 'latest_complete' | 'source_run' | 'shifted_to_data';
  /** The exclusive day after the last day with data, when it was observed. */
  observedThrough?: string;
  baseFilters: IntentPredicate[];
  /** `change`: the question compares periods; `level`: it asks about one period, compared anyway. */
  shape: 'change' | 'level';
  /** `ai`: the metric is not a certified block or authored semantics, so its figures come from AI-written SQL. */
  lane: 'governed' | 'ai';
  notes: string[];
  /**
   * When the period is a numeric field (a season, a fiscal year) because no
   * date field is known: each window's start and end are its values ("2017",
   * "2018"), and `timeRef` is that field.
   */
  periodAxis?: { ref: string; name: string };
}

/** An exact decimal and how it reads. */
export interface InvestigationNumber { value: string; formatted: string }

export type InvestigationQueryPurpose = 'source' | 'freshness' | 'headline' | 'coverage' | 'contribution' | 'drill' | 'mix_rate' | 'seasonality';

export interface InvestigationQueryV1 {
  id: string;
  purpose: InvestigationQueryPurpose;
  label: string;
  programId: string;
  intent: AnalyticalIntentV1;
  outcome: PipelineOutcome['kind'];
  tier?: string;
  trust?: string;
  sql?: string;
  dqlArtifact?: unknown;
  /** The relations the answering statement read. */
  relations?: string[];
  result?: { columns: string[]; rows: Array<Record<string, unknown>>; rowCount: number; columnsMeta?: ResultColumnMeta[]; truncated?: boolean };
  /** Why a query did not answer, in the pipeline's words. */
  message?: string;
  /** Index into the receipt's `queries`. */
  receiptIndex: number;
}

export type InvestigationCaveatCode =
  | 'partial_period' | 'coverage_gap' | 'seasonal' | 'ai_sql' | 'reconciliation' | 'non_additive' | 'relabel'
  | 'budget' | 'deadline' | 'cancelled' | 'truncated_members' | 'shifted_to_data' | 'stale_data' | 'null_member'
  | 'source_mismatch' | 'no_data' | 'freshness_unknown';

export interface InvestigationCaveatV1 { code: InvestigationCaveatCode; text: string; queryIds?: string[] }

export interface InvestigationDimensionRef { ref: string; label: string }

export interface InvestigationDriverV1 {
  path: Array<{ dimension: InvestigationDimensionRef; member: { value: unknown; label: string } }>;
  current: InvestigationNumber;
  prior: InvestigationNumber;
  delta: InvestigationNumber;
  /** Signed share of the total change. */
  share?: string;
  /** For a drilled member: share of the whole change. */
  globalShare?: string;
  /** Share of the change beyond the member's share of the prior period. */
  excess?: string;
  status: 'both' | 'new' | 'gone';
  role: 'driver' | 'offset';
  verdict: 'supported' | 'partial' | 'offset';
  factIds: string[];
  queryIds: string[];
}

export interface InvestigationReportV1 {
  version: 1;
  question: string;
  /** `incomplete`: the run was stopped (budget, deadline, cancellation) before the headline was measured. */
  status: 'answered' | 'no_data' | 'incomplete';
  frame: InvestigationFrameV1;
  headline: {
    text: string;
    metric: { ref: string; label: string };
    current?: InvestigationNumber;
    prior?: InvestigationNumber;
    delta?: InvestigationNumber;
    pct?: string;
    yearAgo?: InvestigationNumber;
    yoyDelta?: InvestigationNumber;
    yoyPct?: string;
    verdict: 'change' | 'no_material_change' | 'seasonal' | 'no_data' | 'incomplete';
    factIds: string[];
    queryIds: string[];
  };
  drivers: InvestigationDriverV1[];
  mixRate?: { mix: InvestigationNumber; rate: InvestigationNumber; queryIds: string[] };
  /** Every breakdown that was measured: its verdict and whether its members add up to the change. */
  breakdowns?: Array<{
    dimension: InvestigationDimensionRef;
    /** A drilled breakdown: the member it is inside. */
    within?: { dimension: InvestigationDimensionRef; member: string };
    verdict: 'explains' | 'ruled_out' | 'inconclusive';
    /** Absent for a metric that does not add up across members. */
    reconciles?: boolean;
    residual?: string;
    members: number;
    queryIds: string[];
  }>;
  /** The same change from the period before, a year earlier (`pct` now, `yearAgoPct` then). */
  seasonality?: { seasonal: boolean; pct?: string; yearAgoPct?: string };
  ruledOut: Array<{ dimension: InvestigationDimensionRef; maxExcess: string; text: string; queryIds: string[] }>;
  inconclusive: Array<{ dimension: InvestigationDimensionRef; reason: string; queryIds: string[] }>;
  notInvestigated: Array<{ dimension?: InvestigationDimensionRef; reason: 'budget' | 'deadline' | 'cancelled' | 'truncated_members' | 'not_expressible' | 'failed' | 'not_started'; detail?: string }>;
  caveats: InvestigationCaveatV1[];
  confidence: { level: 'high' | 'medium' | 'low'; reasons: string[] };
  chart?: { trend?: { columns: string[]; rows: Array<Record<string, unknown>>; columnsMeta?: ResultColumnMeta[] } };
  /** Context gathered from outside the data (MCP and other sources); never used in a verdict. */
  context: InvestigationContextItemV1[];
  queries: InvestigationQueryV1[];
  facts: AskNarrationFactSetV1;
  /** Deterministic prose written from the facts. */
  text: string;
  /** AI wording, only with consent and only after every number was checked against the facts. */
  narration?: { text: string; verified: true };
}

export type InvestigationProgramKind = 'frame' | 'freshness' | 'headline' | 'coverage' | 'contribution' | 'drill' | 'mix_rate' | 'seasonality' | 'context' | 'verdict' | 'report';

export interface InvestigationProgramRecordV1 {
  id: string;
  kind: InvestigationProgramKind;
  title: string;
  dimension?: string;
  parentId?: string;
  outcome: 'done' | 'skipped' | 'failed' | 'not_reached';
  verdict?: 'supported' | 'partial' | 'ruled_out' | 'inconclusive';
  queryIds: string[];
  ms?: number;
  reason?: string;
}

export interface InvestigationReceiptV1 {
  version: 1;
  frame?: InvestigationFrameV1;
  programs: InvestigationProgramRecordV1[];
  /** One pipeline receipt per query, with AI replies left out. */
  queries: Array<{ id: string; programId: string; receipt: PipelineReceipt }>;
  budget: { statementsCap: number; statementsUsed: number; aiCalls: number; stoppedBy?: 'cancelled' | 'deadline' | 'budget' };
  contextSources: Array<{ id: string; items: number; ms: number; error?: string }>;
}

/** An outside source of context (an MCP server, documents). Nothing implements one yet. */
export interface InvestigationContextSource {
  id: string;
  kind: 'mcp' | 'document' | 'other';
  gather(input: { frame: InvestigationFrameV1; stage: 'after_frame' | 'after_drivers'; budgetMs: number; signal?: AbortSignal }): Promise<InvestigationContextItemV1[]>;
}

export interface InvestigationContextItemV1 {
  sourceId: string;
  title: string;
  excerpt: string;
  url?: string;
  observedAt?: string;
  provenance: 'external';
}

/** What an investigation needs from its host: one request's pipeline, its clock and a place for steps. */
export interface InvestigationRuntime {
  read(question: string): Promise<PipelineOutcome>;
  runIntent(intent: AnalyticalIntentV1, options: { allowAiSql: boolean }): Promise<PipelineOutcome>;
  vocabulary(): VocabularyIndex;
  remainingMs(): number;
  signal?: AbortSignal;
  onStep(step: AskStoryStepV1): void;
  contextSources?: InvestigationContextSource[];
  /** Dimension refs the semantic layer says the metric can be grouped by, when the host has a semantic layer. */
  compatibleDimensionRefs?(metricRef: string): string[] | undefined;
  /** Relations the headline's relations reach through a validated or certified relationship, without multiplying their rows. */
  joinableRelations?(relations: string[]): string[];
  /** One small AI call choosing dimensions from a ranked list; the reply is validated against the list, never trusted. */
  selectDimensions?(prompt: string): Promise<string>;
}

export interface InvestigationLimits {
  /** Warehouse statements across the whole investigation. */
  maxStatements: number;
  /** No query starts with less time left than this. */
  minRemainingMs: number;
}

export type InvestigationFrameSource =
  | { kind: 'question' }
  | { kind: 'run'; runId: string; intent: AnalyticalIntentV1 };

export type InvestigationOutcome =
  | { kind: 'report'; report: InvestigationReportV1; receipt: InvestigationReceiptV1 }
  /** The reading ended the turn (a conversation, a clarification, a gap, a failure): the host answers it as Ask would. */
  | { kind: 'reading_ended'; outcome: PipelineOutcome; receipt: InvestigationReceiptV1 }
  | { kind: 'clarify'; question: string; options: string[]; receipt: InvestigationReceiptV1 }
  | { kind: 'not_investigable'; reason: string; receipt: InvestigationReceiptV1 };
