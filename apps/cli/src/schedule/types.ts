import type { ScheduleIR, NotificationIR, AlertIR } from '@duckcodeailabs/dql-compiler';

export interface ScheduledBlock {
  /** Absolute path to the .dql file. */
  path: string;
  /** Name derived from the path, e.g. "finance/revenue_by_month". */
  name: string;
  schedule: ScheduleIR;
  notifications: NotificationIR[];
  alerts: AlertIR[];
}

export interface AlertEvaluation {
  alert: AlertIR;
  breached: boolean;
  observedValue?: number;
  reason?: string;
  error?: string;
}

export interface QueryRunResult {
  chartId: string;
  sql: string;
  rowCount: number;
  durationMs: number;
  error?: string;
  preview?: Array<Record<string, unknown>>;
}

export interface RunRecord {
  startedAt: string;
  finishedAt: string;
  block: string;
  path: string;
  trigger: 'manual' | 'cron';
  queries: QueryRunResult[];
  alerts: AlertEvaluation[];
  notifications: Array<{ type: string; recipients: string[]; delivered: boolean; error?: string }>;
  error?: string;
}

export interface NotifierPayload {
  block: string;
  path: string;
  startedAt: string;
  alerts: AlertEvaluation[];
  queries: QueryRunResult[];
  trigger: 'manual' | 'cron';
}

export interface Notifier {
  type: 'email' | 'slack' | 'file';
  send(recipients: string[], payload: NotifierPayload): Promise<{ delivered: boolean; error?: string }>;
}
