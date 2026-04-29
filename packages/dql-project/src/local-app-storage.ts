import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

export type LocalAppVisibility = 'mine' | 'shared' | 'template';
export type LocalAiPinRefreshCadence = 'none' | 'daily';
export type LocalAiPinReviewStatus = 'needs_review' | 'draft_created' | 'certified' | 'rejected';
export type LocalAppConversationRole = 'user' | 'assistant';

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

export interface LocalAppConversationMessage {
  id: string;
  role: LocalAppConversationRole;
  content: string;
  events?: unknown[];
  createdAt: string;
}

export interface LocalAppConversation {
  id: string;
  appId: string;
  dashboardId?: string;
  notebookPath?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessage?: string;
  messages?: LocalAppConversationMessage[];
}

export interface CreateLocalAppConversationInput {
  id?: string;
  appId: string;
  dashboardId?: string;
  notebookPath?: string;
  title?: string;
  messages?: Array<Pick<LocalAppConversationMessage, 'role' | 'content'> & { id?: string; events?: unknown[]; createdAt?: string }>;
}

export interface UpdateLocalAppConversationInput {
  title?: string;
  dashboardId?: string;
  notebookPath?: string;
  messages?: Array<Pick<LocalAppConversationMessage, 'role' | 'content'> & { id?: string; events?: unknown[]; createdAt?: string }>;
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

  createAppConversation(input: CreateLocalAppConversationInput): LocalAppConversation {
    const now = new Date().toISOString();
    const conversation: LocalAppConversation = {
      id: input.id ?? `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      appId: input.appId,
      dashboardId: cleanOptionalString(input.dashboardId),
      notebookPath: cleanOptionalString(input.notebookPath),
      title: cleanOptionalString(input.title) ?? titleFromMessages(input.messages) ?? 'New conversation',
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    };
    this.db.prepare(`
      INSERT INTO app_conversations (
        id, app_id, dashboard_id, notebook_path, title, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      conversation.id,
      conversation.appId,
      conversation.dashboardId ?? null,
      conversation.notebookPath ?? null,
      conversation.title,
      conversation.createdAt,
      conversation.updatedAt,
    );
    if (input.messages?.length) {
      this.replaceAppConversationMessages(conversation.id, input.messages);
    }
    return this.getAppConversation(conversation.id) ?? conversation;
  }

  listAppConversations(appId: string): LocalAppConversation[] {
    const rows = this.db.prepare(`
      SELECT * FROM app_conversations
      WHERE app_id = ?
      ORDER BY updated_at DESC
    `).all(appId) as Record<string, unknown>[];
    return rows.map((row) => this.rowToConversation(row));
  }

  getAppConversation(id: string): LocalAppConversation | null {
    const row = this.db.prepare('SELECT * FROM app_conversations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      ...this.rowToConversation(row),
      messages: this.listAppConversationMessages(id),
    };
  }

  updateAppConversation(id: string, input: UpdateLocalAppConversationInput): LocalAppConversation | null {
    const current = this.getAppConversation(id);
    if (!current) return null;
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE app_conversations
      SET title = ?, dashboard_id = ?, notebook_path = ?, updated_at = ?
      WHERE id = ?
    `).run(
      cleanOptionalString(input.title) ?? current.title,
      input.dashboardId === undefined ? (current.dashboardId ?? null) : (cleanOptionalString(input.dashboardId) ?? null),
      input.notebookPath === undefined ? (current.notebookPath ?? null) : (cleanOptionalString(input.notebookPath) ?? null),
      now,
      id,
    );
    if (input.messages) {
      this.replaceAppConversationMessages(id, input.messages);
    }
    return this.getAppConversation(id);
  }

  deleteAppConversation(id: string): boolean {
    this.db.prepare('DELETE FROM app_conversation_messages WHERE conversation_id = ?').run(id);
    const result = this.db.prepare('DELETE FROM app_conversations WHERE id = ?').run(id);
    return result.changes > 0;
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

      CREATE TABLE IF NOT EXISTS app_conversations (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        dashboard_id TEXT,
        notebook_path TEXT,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_conversation_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        events TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_app_conversations_app ON app_conversations(app_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_app_conversation_messages ON app_conversation_messages(conversation_id, position);
    `);
  }

  private replaceAppConversationMessages(
    conversationId: string,
    messages: Array<Pick<LocalAppConversationMessage, 'role' | 'content'> & { id?: string; events?: unknown[]; createdAt?: string }>,
  ): void {
    const now = new Date().toISOString();
    this.db.prepare('DELETE FROM app_conversation_messages WHERE conversation_id = ?').run(conversationId);
    const insert = this.db.prepare(`
      INSERT INTO app_conversation_messages (
        id, conversation_id, position, role, content, events, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    messages.forEach((message, index) => {
      insert.run(
        message.id ?? `msg_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`,
        conversationId,
        index,
        message.role === 'assistant' ? 'assistant' : 'user',
        message.content,
        json(message.events ?? []),
        message.createdAt ?? now,
      );
    });
    this.db.prepare('UPDATE app_conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);
  }

  private listAppConversationMessages(conversationId: string): LocalAppConversationMessage[] {
    const rows = this.db.prepare(`
      SELECT * FROM app_conversation_messages
      WHERE conversation_id = ?
      ORDER BY position ASC
    `).all(conversationId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      role: row.role === 'assistant' ? 'assistant' : 'user',
      content: String(row.content),
      events: (parseJson(row.events) as unknown[] | undefined) ?? [],
      createdAt: String(row.created_at),
    }));
  }

  private rowToConversation(row: Record<string, unknown>): LocalAppConversation {
    const summary = this.db.prepare(`
      SELECT
        COUNT(*) AS message_count,
        (SELECT content FROM app_conversation_messages WHERE conversation_id = ? ORDER BY position DESC LIMIT 1) AS last_message
      FROM app_conversation_messages
      WHERE conversation_id = ?
    `).get(String(row.id), String(row.id)) as Record<string, unknown>;
    return {
      id: String(row.id),
      appId: String(row.app_id),
      dashboardId: optionalString(row.dashboard_id),
      notebookPath: optionalString(row.notebook_path),
      title: String(row.title),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      messageCount: typeof summary.message_count === 'number' ? summary.message_count : Number(summary.message_count ?? 0),
      lastMessage: optionalString(summary.last_message),
    };
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

function cleanOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function titleFromMessages(messages: CreateLocalAppConversationInput['messages']): string | undefined {
  const firstUserMessage = messages?.find((message) => message.role === 'user' && message.content.trim());
  if (!firstUserMessage) return undefined;
  return firstUserMessage.content.trim().replace(/\s+/g, ' ').slice(0, 80);
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
