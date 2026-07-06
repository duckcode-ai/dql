import { looksLikeComposeApp } from '../intent-controller.js';

export type CascadeRequestedMode = 'auto' | 'ask' | 'research' | 'sql' | 'block' | 'app';

export type CascadeRunRoute =
  | 'conversation'
  | 'certified_answer'
  | 'generated_answer'
  | 'research'
  | 'sql_cell'
  | 'dql_block_draft'
  | 'app_build'
  | 'clarify'
  | 'blocked';

export type CascadeAction = 'answer' | 'clarify' | 'investigate' | 'compose_app' | 'converse';
export type CascadeAnswerRouteTier =
  | 'certified_block'
  | 'semantic_metric'
  | 'generated_sql'
  | 'business_context'
  | 'no_answer';

export interface CascadeRouteRequest {
  question: string;
  requestedMode?: CascadeRequestedMode;
}

export interface CascadeRouteDecision {
  action: CascadeAction;
}

export function selectCascadeRunRoute(
  request: CascadeRouteRequest,
  decision: CascadeRouteDecision,
): CascadeRunRoute {
  const mode = request.requestedMode ?? 'auto';
  if (mode === 'research') return 'research';
  if (mode === 'sql') return 'sql_cell';
  if (mode === 'block') return 'dql_block_draft';
  if (mode === 'app') return 'app_build';

  if (decision.action === 'converse') return 'conversation';

  const question = request.question;
  if (looksLikeDqlBlockRequest(question)) return 'dql_block_draft';
  if (looksLikeSqlCellRequest(question)) return 'sql_cell';
  if (looksLikeComposeApp(question)) return 'app_build';

  if (decision.action === 'compose_app') return 'app_build';
  if (decision.action === 'investigate') return 'research';
  if (decision.action === 'clarify') return 'clarify';

  return 'generated_answer';
}

export function routeForCascadeAnswerTier(tier: CascadeAnswerRouteTier | undefined): CascadeRunRoute | undefined {
  switch (tier) {
    case 'certified_block':
    case 'business_context':
      return 'certified_answer';
    case 'semantic_metric':
    case 'generated_sql':
    case 'no_answer':
      return 'generated_answer';
    default:
      return undefined;
  }
}

function looksLikeSqlCellRequest(question: string): boolean {
  return /\b(sql|query|notebook cell|cell draft|write a select|generate a query)\b/i.test(question);
}

function looksLikeDqlBlockRequest(question: string): boolean {
  return /\b(dql block|block draft|draft block|create.*block|turn .* into .*block|promote .* block)\b/i.test(question);
}
