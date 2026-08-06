import type { api, AppAskResponse, LocalAppInvestigation } from '../../api/client';

/**
 * Types shared between the App shell and the analysis (Research) surface split
 * out of it.
 */
type AppAskDecision = Extract<AppAskResponse, { ok: true }>['decision'];

export interface AppResearchSeed {
  question: string;
  title?: string;
  dashboardId?: string;
  sourceTileId?: string;
  sourceBlockId?: string;
  context?: unknown;
  intent?: LocalAppInvestigation['intent'];
  generatedSql?: string;
  nonce: number;
}

export type AppAnalysisHandoff = {
  mode: 'research' | 'evidence' | 'block';
  question: string;
  context: string;
  decision?: Partial<AppAskDecision> & { reason?: string; nextAction?: string };
};

export type CreateInvestigationResult = Awaited<ReturnType<typeof api.createAppInvestigation>>;
