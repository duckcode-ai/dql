export interface CascadeMissingContext {
  kind?: string;
  severity?: string;
  message?: string;
}

export interface CascadeRouteDecisionLike {
  route?: string;
  missingContext?: CascadeMissingContext[];
}

export interface CascadeClarifyInput {
  intent?: string;
  routeDecision?: CascadeRouteDecisionLike;
  hasSemanticMetricMatch?: boolean;
  schemaContextCount?: number;
  allowedRelationCount?: number;
  sourceBlockSqlCount?: number;
  metadataObjectCount?: number;
}

export function shouldClarifyBeforeGeneration(input: CascadeClarifyInput): boolean {
  if (input.hasSemanticMetricMatch) return false;
  const routeClarify = input.routeDecision?.route === 'clarify';
  const intentClarify = input.intent === 'clarify';
  if (!routeClarify && !intentClarify) return false;

  const missing = input.routeDecision?.missingContext ?? [];
  if (missing.some(isActionableBlockingMissingContext)) return true;

  const hasUsableContext =
    (input.schemaContextCount ?? 0) > 0 ||
    (input.allowedRelationCount ?? 0) > 0 ||
    (input.sourceBlockSqlCount ?? 0) > 0 ||
    (input.metadataObjectCount ?? 0) > 0;

  return !hasUsableContext;
}

function isActionableBlockingMissingContext(item: CascadeMissingContext): boolean {
  if (item.severity !== 'blocking') return false;
  if (item.kind !== 'metadata') return true;
  const message = item.message ?? '';
  return !/^No certified block, semantic metric, dbt model, or runtime schema matched strongly enough to answer safely\./i.test(message);
}
