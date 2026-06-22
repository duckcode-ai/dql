import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
let databaseCtor: typeof Database | null = null;

function loadDatabase(): typeof Database {
  databaseCtor ??= require('better-sqlite3') as typeof Database;
  return databaseCtor;
}

export type LocalAppVisibility = 'mine' | 'shared' | 'template';
export type LocalAiPinRefreshCadence = 'none' | 'daily';
export type LocalAiPinReviewStatus = 'needs_review' | 'draft_created' | 'certified' | 'rejected';
export type LocalAppConversationRole = 'user' | 'assistant';
export type LocalAppInvestigationIntent =
  | 'diagnose_change'
  | 'driver_breakdown'
  | 'segment_compare'
  | 'entity_drilldown'
  | 'anomaly_investigation'
  | 'trust_gap_review';
export type LocalAppInvestigationStatus = 'draft' | 'running' | 'ready' | 'error';
export type LocalAppInvestigationReviewStatus = LocalAiPinReviewStatus;
export type LocalAppInvestigationReportSectionKind =
  | 'executive_answer'
  | 'business_interpretation'
  | 'key_numbers'
  | 'recommended_next_step'
  | 'review_boundary'
  | 'validation'
  | 'reusable_logic'
  | 'custom';

export interface LocalAppInvestigationReportSection {
  id: string;
  kind: LocalAppInvestigationReportSectionKind;
  title: string;
  body: string;
  tone?: 'answer' | 'insight' | 'warning' | 'review' | 'neutral';
  bullets?: string[];
  evidenceRefs?: string[];
}

export interface LocalAppConversationContext {
  activeSurface?: string;
  sourceCertifiedBlock?: string;
  sourceQuestion?: string;
  sourceAnswerSummary?: string;
  followupKind?: 'generic' | 'drilldown';
  requestedFilters?: string[];
  requestedDimensions?: string[];
  outputColumns?: string[];
  trustLabel?: string;
  reviewStatus?: string;
  certification?: string;
  route?: string;
  contextPackId?: string;
  draftBlockPath?: string;
  selectedEvidence?: unknown[];
  updatedAt?: string;
}

export interface LocalAiPin {
  id: string;
  appId: string;
  dashboardId: string;
  tileId?: string;
  title: string;
  answer: string;
  question?: string;
  sql?: string;
  sourceTier?: string;
  certification: 'certified' | 'ai_generated';
  reviewStatus: LocalAiPinReviewStatus;
  refreshCadence: LocalAiPinRefreshCadence;
  chartConfig?: Record<string, unknown>;
  result?: unknown;
  citations?: unknown[];
  analysisPlan?: unknown;
  evidence?: unknown;
  followUps?: string[];
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
  question?: string;
  sql?: string;
  sourceTier?: string;
  certification?: 'certified' | 'ai_generated';
  reviewStatus?: LocalAiPinReviewStatus;
  refreshCadence?: LocalAiPinRefreshCadence;
  chartConfig?: Record<string, unknown>;
  result?: unknown;
  citations?: unknown[];
  analysisPlan?: unknown;
  evidence?: unknown;
  followUps?: string[];
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
  context?: LocalAppConversationContext;
  messages?: LocalAppConversationMessage[];
}

export interface CreateLocalAppConversationInput {
  id?: string;
  appId: string;
  dashboardId?: string;
  notebookPath?: string;
  title?: string;
  context?: LocalAppConversationContext;
  messages?: Array<Pick<LocalAppConversationMessage, 'role' | 'content'> & { id?: string; events?: unknown[]; createdAt?: string }>;
}

export interface UpdateLocalAppConversationInput {
  title?: string;
  dashboardId?: string;
  notebookPath?: string;
  context?: LocalAppConversationContext | null;
  messages?: Array<Pick<LocalAppConversationMessage, 'role' | 'content'> & { id?: string; events?: unknown[]; createdAt?: string }>;
}

export interface LocalAppInvestigation {
  id: string;
  appId: string;
  dashboardId?: string;
  sourceTileId?: string;
  sourceBlockId?: string;
  title: string;
  question: string;
  intent: LocalAppInvestigationIntent;
  context?: unknown;
  status: LocalAppInvestigationStatus;
  summary?: string;
  recommendation?: string;
  metrics?: unknown;
  driverCards?: unknown[];
  resultPreviews?: unknown[];
  evidence?: unknown;
  reportSections?: LocalAppInvestigationReportSection[];
  generatedSql?: string;
  reviewStatus: LocalAppInvestigationReviewStatus;
  error?: string;
  pinnedAiPinId?: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
}

export interface CreateLocalAppInvestigationInput {
  id?: string;
  appId: string;
  dashboardId?: string;
  sourceTileId?: string;
  sourceBlockId?: string;
  title?: string;
  question: string;
  intent?: LocalAppInvestigationIntent;
  context?: unknown;
  generatedSql?: string;
}

export type FindReusableLocalAppInvestigationInput = Pick<
  CreateLocalAppInvestigationInput,
  'appId' | 'dashboardId' | 'sourceTileId' | 'sourceBlockId' | 'question' | 'intent' | 'context'
>;

export interface UpdateLocalAppInvestigationInput {
  dashboardId?: string;
  sourceTileId?: string;
  sourceBlockId?: string;
  title?: string;
  question?: string;
  intent?: LocalAppInvestigationIntent;
  context?: unknown;
  status?: LocalAppInvestigationStatus;
  summary?: string;
  recommendation?: string;
  metrics?: unknown;
  driverCards?: unknown[];
  resultPreviews?: unknown[];
  evidence?: unknown;
  reportSections?: LocalAppInvestigationReportSection[];
  generatedSql?: string;
  reviewStatus?: LocalAppInvestigationReviewStatus;
  error?: string;
  pinnedAiPinId?: string;
  lastRunAt?: string;
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
    const Database = loadDatabase();
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
      question: input.question,
      sql: input.sql,
      sourceTier: input.sourceTier,
      certification: input.certification ?? 'ai_generated',
      reviewStatus: input.reviewStatus ?? 'needs_review',
      refreshCadence: input.refreshCadence ?? 'none',
      chartConfig: input.chartConfig,
      result: input.result,
      citations: input.citations,
      analysisPlan: input.analysisPlan,
      evidence: input.evidence,
      followUps: input.followUps,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO ai_pins (
        id, app_id, dashboard_id, tile_id, title, answer, question, sql, source_tier,
        certification, review_status, refresh_cadence, chart_config, result,
        citations, analysis_plan, evidence, follow_ups, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      pin.id,
      pin.appId,
      pin.dashboardId,
      pin.tileId ?? null,
      pin.title,
      pin.answer,
      pin.question ?? null,
      pin.sql ?? null,
      pin.sourceTier ?? null,
      pin.certification,
      pin.reviewStatus,
      pin.refreshCadence,
      json(pin.chartConfig),
      json(pin.result),
      json(pin.citations ?? []),
      json(pin.analysisPlan),
      json(pin.evidence),
      json(pin.followUps ?? []),
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

  createAppInvestigation(input: CreateLocalAppInvestigationInput): LocalAppInvestigation {
    const now = new Date().toISOString();
    const question = cleanOptionalString(input.question) ?? 'Investigate this dashboard';
    const investigation: LocalAppInvestigation = {
      id: input.id ?? `inv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      appId: input.appId,
      dashboardId: cleanOptionalString(input.dashboardId),
      sourceTileId: cleanOptionalString(input.sourceTileId),
      sourceBlockId: cleanOptionalString(input.sourceBlockId),
      title: cleanOptionalString(input.title) ?? titleFromQuestion(question),
      question,
      intent: input.intent ?? 'driver_breakdown',
      context: input.context,
      status: 'draft',
      generatedSql: cleanOptionalString(input.generatedSql),
      reviewStatus: 'needs_review',
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO app_investigations (
        id, app_id, dashboard_id, source_tile_id, source_block_id, title, question,
        intent, context, status, summary, recommendation, metrics, driver_cards,
        result_previews, evidence, report_sections, generated_sql, review_status, error, pinned_ai_pin_id,
        created_at, updated_at, last_run_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      investigation.id,
      investigation.appId,
      investigation.dashboardId ?? null,
      investigation.sourceTileId ?? null,
      investigation.sourceBlockId ?? null,
      investigation.title,
      investigation.question,
      investigation.intent,
      json(investigation.context),
      investigation.status,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      investigation.generatedSql ?? null,
      investigation.reviewStatus,
      null,
      null,
      investigation.createdAt,
      investigation.updatedAt,
      null,
    );
    return investigation;
  }

  listAppInvestigations(appId: string, dashboardId?: string): LocalAppInvestigation[] {
    return dedupeAppInvestigations(this.listRawAppInvestigations(appId, dashboardId));
  }

  private listRawAppInvestigations(appId: string, dashboardId?: string): LocalAppInvestigation[] {
    const params: unknown[] = [appId];
    const dashboardClause = dashboardId ? ' AND dashboard_id = ?' : '';
    if (dashboardId) params.push(dashboardId);
    const rows = this.db.prepare(`
      SELECT * FROM app_investigations
      WHERE app_id = ?${dashboardClause}
      ORDER BY updated_at DESC
    `).all(...params) as Record<string, unknown>[];
    return rows.map(rowToInvestigation);
  }

  findReusableAppInvestigation(input: FindReusableLocalAppInvestigationInput): LocalAppInvestigation | null {
    const target = appInvestigationReuseFingerprint(input);
    const candidates = this.listRawAppInvestigations(input.appId, cleanOptionalString(input.dashboardId));
    return candidates.find((item) => {
      if (item.reviewStatus === 'rejected') return false;
      return appInvestigationReuseFingerprint(item) === target;
    }) ?? null;
  }

  getAppInvestigation(id: string): LocalAppInvestigation | null {
    const row = this.db.prepare('SELECT * FROM app_investigations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToInvestigation(row) : null;
  }

  updateAppInvestigation(id: string, input: UpdateLocalAppInvestigationInput): LocalAppInvestigation | null {
    const current = this.getAppInvestigation(id);
    if (!current) return null;
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE app_investigations
      SET dashboard_id = ?, source_tile_id = ?, source_block_id = ?, title = ?, question = ?,
          intent = ?, context = ?, status = ?, summary = ?, recommendation = ?, metrics = ?,
          driver_cards = ?, result_previews = ?, evidence = ?, report_sections = ?, generated_sql = ?, review_status = ?,
          error = ?, pinned_ai_pin_id = ?, updated_at = ?, last_run_at = ?
      WHERE id = ?
    `).run(
      input.dashboardId === undefined ? (current.dashboardId ?? null) : (cleanOptionalString(input.dashboardId) ?? null),
      input.sourceTileId === undefined ? (current.sourceTileId ?? null) : (cleanOptionalString(input.sourceTileId) ?? null),
      input.sourceBlockId === undefined ? (current.sourceBlockId ?? null) : (cleanOptionalString(input.sourceBlockId) ?? null),
      cleanOptionalString(input.title) ?? current.title,
      cleanOptionalString(input.question) ?? current.question,
      input.intent ?? current.intent,
      input.context === undefined ? json(current.context) : json(input.context),
      input.status ?? current.status,
      input.summary === undefined ? (current.summary ?? null) : (cleanOptionalString(input.summary) ?? null),
      input.recommendation === undefined ? (current.recommendation ?? null) : (cleanOptionalString(input.recommendation) ?? null),
      input.metrics === undefined ? json(current.metrics) : json(input.metrics),
      input.driverCards === undefined ? json(current.driverCards ?? []) : json(input.driverCards ?? []),
      input.resultPreviews === undefined ? json(current.resultPreviews ?? []) : json(input.resultPreviews ?? []),
      input.evidence === undefined ? json(current.evidence) : json(input.evidence),
      input.reportSections === undefined ? json(current.reportSections ?? []) : json(normalizeReportSections(input.reportSections)),
      input.generatedSql === undefined ? (current.generatedSql ?? null) : (cleanOptionalString(input.generatedSql) ?? null),
      input.reviewStatus ?? current.reviewStatus,
      input.error === undefined ? (current.error ?? null) : (cleanOptionalString(input.error) ?? null),
      input.pinnedAiPinId === undefined ? (current.pinnedAiPinId ?? null) : (cleanOptionalString(input.pinnedAiPinId) ?? null),
      now,
      input.lastRunAt === undefined ? (current.lastRunAt ?? null) : (cleanOptionalString(input.lastRunAt) ?? null),
      id,
    );
    return this.getAppInvestigation(id);
  }

  markAppInvestigationPinned(id: string, pinId: string): LocalAppInvestigation | null {
    return this.updateAppInvestigation(id, { pinnedAiPinId: pinId });
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
        id, app_id, dashboard_id, notebook_path, title, context, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      conversation.id,
      conversation.appId,
      conversation.dashboardId ?? null,
      conversation.notebookPath ?? null,
      conversation.title,
      json(input.context),
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
      SET title = ?, dashboard_id = ?, notebook_path = ?, context = ?, updated_at = ?
      WHERE id = ?
    `).run(
      cleanOptionalString(input.title) ?? current.title,
      input.dashboardId === undefined ? (current.dashboardId ?? null) : (cleanOptionalString(input.dashboardId) ?? null),
      input.notebookPath === undefined ? (current.notebookPath ?? null) : (cleanOptionalString(input.notebookPath) ?? null),
      input.context === undefined ? json(current.context) : json(input.context ?? undefined),
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
        question TEXT,
        sql TEXT,
        source_tier TEXT,
        certification TEXT NOT NULL,
        review_status TEXT NOT NULL,
        refresh_cadence TEXT NOT NULL DEFAULT 'none',
        chart_config TEXT,
        result TEXT,
        citations TEXT,
        analysis_plan TEXT,
        evidence TEXT,
        follow_ups TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_refreshed_at TEXT,
        last_refresh_error TEXT,
        promoted_block_path TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_ai_pins_app_dashboard ON ai_pins(app_id, dashboard_id);
      CREATE INDEX IF NOT EXISTS idx_ai_pins_review ON ai_pins(review_status);

      CREATE TABLE IF NOT EXISTS app_investigations (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        dashboard_id TEXT,
        source_tile_id TEXT,
        source_block_id TEXT,
        title TEXT NOT NULL,
        question TEXT NOT NULL,
        intent TEXT NOT NULL,
        context TEXT,
        status TEXT NOT NULL,
        summary TEXT,
        recommendation TEXT,
        metrics TEXT,
        driver_cards TEXT,
        result_previews TEXT,
        evidence TEXT,
        report_sections TEXT,
        generated_sql TEXT,
        review_status TEXT NOT NULL,
        error TEXT,
        pinned_ai_pin_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_run_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_app_investigations_app_dashboard ON app_investigations(app_id, dashboard_id);
      CREATE INDEX IF NOT EXISTS idx_app_investigations_review ON app_investigations(review_status);

      CREATE TABLE IF NOT EXISTS app_conversations (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        dashboard_id TEXT,
        notebook_path TEXT,
        title TEXT NOT NULL,
        context TEXT,
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
    this.ensureColumn('ai_pins', 'question', 'TEXT');
    this.ensureColumn('ai_pins', 'analysis_plan', 'TEXT');
    this.ensureColumn('ai_pins', 'evidence', 'TEXT');
    this.ensureColumn('ai_pins', 'follow_ups', 'TEXT');
    this.ensureColumn('app_investigations', 'source_tile_id', 'TEXT');
    this.ensureColumn('app_investigations', 'source_block_id', 'TEXT');
    this.ensureColumn('app_investigations', 'metrics', 'TEXT');
    this.ensureColumn('app_investigations', 'driver_cards', 'TEXT');
    this.ensureColumn('app_investigations', 'result_previews', 'TEXT');
    this.ensureColumn('app_investigations', 'generated_sql', 'TEXT');
    this.ensureColumn('app_investigations', 'pinned_ai_pin_id', 'TEXT');
    this.ensureColumn('app_investigations', 'report_sections', 'TEXT');
    this.ensureColumn('app_conversations', 'context', 'TEXT');
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
    if (rows.some((row) => row.name === column)) return;
    this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
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
      context: normalizeConversationContext(parseJson(row.context)),
    };
  }
}

function normalizeConversationContext(value: unknown): LocalAppConversationContext | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as LocalAppConversationContext;
}

function rowToAiPin(row: Record<string, unknown>): LocalAiPin {
  return {
    id: String(row.id),
    appId: String(row.app_id),
    dashboardId: String(row.dashboard_id),
    tileId: optionalString(row.tile_id),
    title: String(row.title),
    answer: String(row.answer),
    question: optionalString(row.question),
    sql: optionalString(row.sql),
    sourceTier: optionalString(row.source_tier),
    certification: row.certification === 'certified' ? 'certified' : 'ai_generated',
    reviewStatus: parseReviewStatus(row.review_status),
    refreshCadence: row.refresh_cadence === 'daily' ? 'daily' : 'none',
    chartConfig: parseJson(row.chart_config) as Record<string, unknown> | undefined,
    result: parseJson(row.result),
    citations: (parseJson(row.citations) as unknown[] | undefined) ?? [],
    analysisPlan: parseJson(row.analysis_plan),
    evidence: parseJson(row.evidence),
    followUps: (parseJson(row.follow_ups) as string[] | undefined) ?? [],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastRefreshedAt: optionalString(row.last_refreshed_at),
    lastRefreshError: optionalString(row.last_refresh_error),
    promotedBlockPath: optionalString(row.promoted_block_path),
  };
}

function rowToInvestigation(row: Record<string, unknown>): LocalAppInvestigation {
  return {
    id: String(row.id),
    appId: String(row.app_id),
    dashboardId: optionalString(row.dashboard_id),
    sourceTileId: optionalString(row.source_tile_id),
    sourceBlockId: optionalString(row.source_block_id),
    title: String(row.title),
    question: String(row.question),
    intent: parseInvestigationIntent(row.intent),
    context: parseJson(row.context),
    status: parseInvestigationStatus(row.status),
    summary: optionalString(row.summary),
    recommendation: optionalString(row.recommendation),
    metrics: parseJson(row.metrics),
    driverCards: (parseJson(row.driver_cards) as unknown[] | undefined) ?? [],
    resultPreviews: (parseJson(row.result_previews) as unknown[] | undefined) ?? [],
    evidence: parseJson(row.evidence),
    reportSections: normalizeReportSections(parseJson(row.report_sections)),
    generatedSql: optionalString(row.generated_sql),
    reviewStatus: parseReviewStatus(row.review_status),
    error: optionalString(row.error),
    pinnedAiPinId: optionalString(row.pinned_ai_pin_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastRunAt: optionalString(row.last_run_at),
  };
}

function normalizeReportSections(value: unknown): LocalAppInvestigationReportSection[] {
  if (!Array.isArray(value)) return [];
  const sections: LocalAppInvestigationReportSection[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const title = cleanOptionalString(record.title);
    const body = cleanOptionalString(record.body);
    if (!title || !body) continue;
    const id = cleanOptionalString(record.id) ?? slugForReportSection(title, sections.length);
    sections.push({
      id,
      kind: parseReportSectionKind(record.kind),
      title,
      body,
      tone: parseReportSectionTone(record.tone),
      bullets: Array.isArray(record.bullets)
        ? record.bullets.map(cleanOptionalString).filter((item): item is string => Boolean(item))
        : undefined,
      evidenceRefs: Array.isArray(record.evidenceRefs)
        ? record.evidenceRefs.map(cleanOptionalString).filter((item): item is string => Boolean(item))
        : undefined,
    });
  }
  return sections;
}

function parseReportSectionKind(value: unknown): LocalAppInvestigationReportSectionKind {
  if (
    value === 'executive_answer'
    || value === 'business_interpretation'
    || value === 'key_numbers'
    || value === 'recommended_next_step'
    || value === 'review_boundary'
    || value === 'validation'
    || value === 'reusable_logic'
  ) return value;
  return 'custom';
}

function parseReportSectionTone(value: unknown): LocalAppInvestigationReportSection['tone'] | undefined {
  if (value === 'answer' || value === 'insight' || value === 'warning' || value === 'review' || value === 'neutral') return value;
  return undefined;
}

function parseReviewStatus(value: unknown): LocalAiPinReviewStatus {
  if (value === 'draft_created' || value === 'certified' || value === 'rejected') return value;
  return 'needs_review';
}

function parseInvestigationIntent(value: unknown): LocalAppInvestigationIntent {
  if (
    value === 'diagnose_change'
    || value === 'driver_breakdown'
    || value === 'segment_compare'
    || value === 'entity_drilldown'
    || value === 'anomaly_investigation'
    || value === 'trust_gap_review'
  ) return value;
  return 'driver_breakdown';
}

function parseInvestigationStatus(value: unknown): LocalAppInvestigationStatus {
  if (value === 'running' || value === 'ready' || value === 'error') return value;
  return 'draft';
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function cleanOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function slugForReportSection(title: string, index: number): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug ? `${slug}-${index + 1}` : `section-${index + 1}`;
}

function titleFromMessages(messages: CreateLocalAppConversationInput['messages']): string | undefined {
  const firstUserMessage = messages?.find((message) => message.role === 'user' && message.content.trim());
  if (!firstUserMessage) return undefined;
  return firstUserMessage.content.trim().replace(/\s+/g, ' ').slice(0, 80);
}

function titleFromQuestion(question: string): string {
  return question.trim().replace(/\s+/g, ' ').slice(0, 90) || 'Research investigation';
}

function appInvestigationReuseFingerprint(input: FindReusableLocalAppInvestigationInput): string {
  return [
    normalizeFingerprintString(input.appId),
    normalizeFingerprintString(input.dashboardId),
    normalizeFingerprintString(input.sourceTileId),
    normalizeFingerprintString(input.sourceBlockId),
    normalizeFingerprintString(input.question),
    normalizeFingerprintString(input.intent ?? 'driver_breakdown'),
    stableFingerprintValue(input.context),
  ].join('|');
}

function dedupeAppInvestigations(items: LocalAppInvestigation[]): LocalAppInvestigation[] {
  const seen = new Set<string>();
  const out: LocalAppInvestigation[] = [];
  for (const item of items) {
    const fingerprint = appInvestigationReuseFingerprint(item);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push(item);
  }
  return out;
}

function normalizeFingerprintString(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

function stableFingerprintValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  return JSON.stringify(stableFingerprintObject(value));
}

function stableFingerprintObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableFingerprintObject);
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (/^(nonce|timestamp|createdAt|updatedAt|lastRunAt)$/i.test(key)) continue;
    out[key] = stableFingerprintObject(record[key]);
  }
  return out;
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
