import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

export type LocalAppVisibility = 'mine' | 'shared' | 'template';
export type LocalAiPinRefreshCadence = 'none' | 'daily';
export type LocalAiPinReviewStatus = 'needs_review' | 'draft_created' | 'certified' | 'rejected';

export interface LocalAiPin {
  id: string;
  appId: string;
  dashboardId: string;
  tileId?: string;
  title: string;
  answer: string;
  sql?: string;
  sourceTier?: string;
  certification: 'certified' | 'ai_generated';
  reviewStatus: LocalAiPinReviewStatus;
  refreshCadence: LocalAiPinRefreshCadence;
  chartConfig?: Record<string, unknown>;
  result?: unknown;
  citations?: unknown[];
  createdAt: string;
  updatedAt: string;
  lastRefreshedAt?: string;
  lastRefreshError?: string;
  promotedBlockPath?: string;
}

export interface CreateLocalAiPinInput {
  id?: string;
  appId: string;
  dashboardId: string;
  tileId?: string;
  title: string;
  answer: string;
  sql?: string;
  sourceTier?: string;
  certification?: 'certified' | 'ai_generated';
  reviewStatus?: LocalAiPinReviewStatus;
  refreshCadence?: LocalAiPinRefreshCadence;
  chartConfig?: Record<string, unknown>;
  result?: unknown;
  citations?: unknown[];
}

export function defaultLocalAppsDbPath(projectRoot: string): string {
  return `${projectRoot}/.dql/local/apps.sqlite`;
}

/**
 * Local-only App state. Shared Apps remain file-backed under apps/<id>/;
 * this store is intentionally for personal/private overlays and AI pins.
 */
export class LocalAppStorage {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  close(): void {
    this.db.close();
  }

  createAiPin(input: CreateLocalAiPinInput): LocalAiPin {
    const now = new Date().toISOString();
    const pin: LocalAiPin = {
      id: input.id ?? `pin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      appId: input.appId,
      dashboardId: input.dashboardId,
      tileId: input.tileId,
      title: input.title,
      answer: input.answer,
      sql: input.sql,
      sourceTier: input.sourceTier,
      certification: input.certification ?? 'ai_generated',
      reviewStatus: input.reviewStatus ?? 'needs_review',
      refreshCadence: input.refreshCadence ?? 'none',
      chartConfig: input.chartConfig,
      result: input.result,
      citations: input.citations,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO ai_pins (
        id, app_id, dashboard_id, tile_id, title, answer, sql, source_tier,
        certification, review_status, refresh_cadence, chart_config, result,
        citations, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      pin.id,
      pin.appId,
      pin.dashboardId,
      pin.tileId ?? null,
      pin.title,
      pin.answer,
      pin.sql ?? null,
      pin.sourceTier ?? null,
      pin.certification,
      pin.reviewStatus,
      pin.refreshCadence,
      json(pin.chartConfig),
      json(pin.result),
      json(pin.citations ?? []),
      pin.createdAt,
      pin.updatedAt,
    );
    return pin;
  }

  getAiPin(id: string): LocalAiPin | null {
    const row = this.db.prepare('SELECT * FROM ai_pins WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToAiPin(row) : null;
  }

  listAiPins(appId?: string, dashboardId?: string): LocalAiPin[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (appId) {
      clauses.push('app_id = ?');
      params.push(appId);
    }
    if (dashboardId) {
      clauses.push('dashboard_id = ?');
      params.push(dashboardId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM ai_pins ${where} ORDER BY updated_at DESC`).all(...params) as Record<string, unknown>[];
    return rows.map(rowToAiPin);
  }

  updateAiPinResult(id: string, result: unknown, error?: string): LocalAiPin | null {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE ai_pins
      SET result = ?, last_refreshed_at = ?, last_refresh_error = ?, updated_at = ?
      WHERE id = ?
    `).run(json(result), now, error ?? null, now, id);
    return this.getAiPin(id);
  }

  markAiPinPromoted(id: string, blockPath: string): LocalAiPin | null {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE ai_pins
      SET review_status = 'draft_created', promoted_block_path = ?, updated_at = ?
      WHERE id = ?
    `).run(blockPath, now, id);
    return this.getAiPin(id);
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS personal_apps (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        domain TEXT NOT NULL,
        description TEXT,
        visibility TEXT NOT NULL DEFAULT 'mine',
        payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS personal_dashboards (
        id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        title TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (app_id, id)
      );

      CREATE TABLE IF NOT EXISTS layout_overrides (
        app_id TEXT NOT NULL,
        dashboard_id TEXT NOT NULL,
        user_id TEXT NOT NULL DEFAULT 'local',
        layout TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (app_id, dashboard_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS ai_pins (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        dashboard_id TEXT NOT NULL,
        tile_id TEXT,
        title TEXT NOT NULL,
        answer TEXT NOT NULL,
        sql TEXT,
        source_tier TEXT,
        certification TEXT NOT NULL,
        review_status TEXT NOT NULL,
        refresh_cadence TEXT NOT NULL DEFAULT 'none',
        chart_config TEXT,
        result TEXT,
        citations TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_refreshed_at TEXT,
        last_refresh_error TEXT,
        promoted_block_path TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_ai_pins_app_dashboard ON ai_pins(app_id, dashboard_id);
      CREATE INDEX IF NOT EXISTS idx_ai_pins_review ON ai_pins(review_status);
    `);
  }
}

function rowToAiPin(row: Record<string, unknown>): LocalAiPin {
  return {
    id: String(row.id),
    appId: String(row.app_id),
    dashboardId: String(row.dashboard_id),
    tileId: optionalString(row.tile_id),
    title: String(row.title),
    answer: String(row.answer),
    sql: optionalString(row.sql),
    sourceTier: optionalString(row.source_tier),
    certification: row.certification === 'certified' ? 'certified' : 'ai_generated',
    reviewStatus: parseReviewStatus(row.review_status),
    refreshCadence: row.refresh_cadence === 'daily' ? 'daily' : 'none',
    chartConfig: parseJson(row.chart_config) as Record<string, unknown> | undefined,
    result: parseJson(row.result),
    citations: (parseJson(row.citations) as unknown[] | undefined) ?? [],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastRefreshedAt: optionalString(row.last_refreshed_at),
    lastRefreshError: optionalString(row.last_refresh_error),
    promotedBlockPath: optionalString(row.promoted_block_path),
  };
}

function parseReviewStatus(value: unknown): LocalAiPinReviewStatus {
  if (value === 'draft_created' || value === 'certified' || value === 'rejected') return value;
  return 'needs_review';
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
