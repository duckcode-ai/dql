import Database from 'better-sqlite3';
import type {
  BlockRecord,
  BlockVersion,
  BlockSearchQuery,
  BlockSearchResult,
  RegistryStorage,
  TestResultSummary,
} from './types.js';

export class SQLiteStorage implements RegistryStorage {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS block_registry (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL UNIQUE,
        domain          TEXT NOT NULL,
        type            TEXT NOT NULL,
        version         TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'draft',
        git_repo        TEXT NOT NULL DEFAULT '',
        git_path        TEXT NOT NULL DEFAULT '',
        git_commit_sha  TEXT NOT NULL DEFAULT '',
        description     TEXT,
        owner           TEXT NOT NULL,
        tags            TEXT DEFAULT '[]',
        dependencies    TEXT DEFAULT '[]',
        cost_estimate   REAL,
        certified_at    TEXT,
        certified_by    TEXT,
        test_results    TEXT,
        used_in_count   INTEGER DEFAULT 0,
        last_executed   TEXT,
        avg_runtime_ms  INTEGER,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_block_domain ON block_registry(domain);
      CREATE INDEX IF NOT EXISTS idx_block_status ON block_registry(status);
      CREATE INDEX IF NOT EXISTS idx_block_owner ON block_registry(owner);

      CREATE TABLE IF NOT EXISTS block_versions (
        id              TEXT PRIMARY KEY,
        block_id        TEXT NOT NULL REFERENCES block_registry(id) ON DELETE CASCADE,
        version         TEXT NOT NULL,
        git_commit_sha  TEXT NOT NULL DEFAULT '',
        dql_source      TEXT NOT NULL,
        certified_at    TEXT,
        is_active       INTEGER DEFAULT 0,
        created_at      TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_version_block ON block_versions(block_id);
      CREATE INDEX IF NOT EXISTS idx_version_active ON block_versions(block_id, is_active);

      CREATE TABLE IF NOT EXISTS app_registry (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        domain          TEXT NOT NULL,
        description     TEXT,
        owners          TEXT NOT NULL DEFAULT '[]',
        tags            TEXT NOT NULL DEFAULT '[]',
        file_path       TEXT NOT NULL,
        members         TEXT NOT NULL DEFAULT '[]',
        roles           TEXT NOT NULL DEFAULT '[]',
        policies        TEXT NOT NULL DEFAULT '[]',
        rls_bindings    TEXT NOT NULL DEFAULT '[]',
        schedules       TEXT NOT NULL DEFAULT '[]',
        homepage        TEXT,
        git_commit_sha  TEXT NOT NULL DEFAULT '',
        updated_at      TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_app_domain ON app_registry(domain);

      CREATE TABLE IF NOT EXISTS dashboard_registry (
        id              TEXT PRIMARY KEY,
        app_id          TEXT NOT NULL REFERENCES app_registry(id) ON DELETE CASCADE,
        title           TEXT NOT NULL,
        description     TEXT,
        domain          TEXT,
        tags            TEXT NOT NULL DEFAULT '[]',
        file_path       TEXT NOT NULL,
        block_ids       TEXT NOT NULL DEFAULT '[]',
        block_path_refs TEXT NOT NULL DEFAULT '[]',
        unresolved_refs TEXT NOT NULL DEFAULT '[]',
        params          TEXT NOT NULL DEFAULT '[]',
        filters         TEXT NOT NULL DEFAULT '[]',
        layout          TEXT NOT NULL DEFAULT '{}',
        git_commit_sha  TEXT NOT NULL DEFAULT '',
        updated_at      TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_dashboard_app ON dashboard_registry(app_id);
      CREATE INDEX IF NOT EXISTS idx_dashboard_domain ON dashboard_registry(domain);
    `);
  }

  /**
   * Replace the persisted apps/dashboards rows with the contents of a
   * compiled manifest. Idempotent: clears the registries and re-inserts.
   * Apps and dashboards are file-format-first — the registries exist for
   * fast queries from the UI/API surface, not as a source of truth.
   */
  upsertAppsAndDashboards(input: {
    apps: Array<{
      id: string;
      name: string;
      domain: string;
      description?: string;
      owners: string[];
      tags: string[];
      filePath: string;
      members: unknown;
      roles: unknown;
      policies: unknown;
      rlsBindings: unknown;
      schedules: unknown;
      homepage?: unknown;
      gitCommitSha?: string;
    }>;
    dashboards: Array<{
      id: string;
      appId: string;
      title: string;
      description?: string;
      domain?: string;
      tags: string[];
      filePath: string;
      blockIds: string[];
      blockPathRefs: string[];
      unresolvedRefs: string[];
      params: string[];
      filters: string[];
      layout: unknown;
      gitCommitSha?: string;
    }>;
  }): void {
    const now = new Date().toISOString();
    const txn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM dashboard_registry').run();
      this.db.prepare('DELETE FROM app_registry').run();
      const insertApp = this.db.prepare(`
        INSERT INTO app_registry (
          id, name, domain, description, owners, tags, file_path,
          members, roles, policies, rls_bindings, schedules, homepage,
          git_commit_sha, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const a of input.apps) {
        insertApp.run(
          a.id, a.name, a.domain, a.description ?? null,
          JSON.stringify(a.owners), JSON.stringify(a.tags),
          a.filePath,
          JSON.stringify(a.members), JSON.stringify(a.roles),
          JSON.stringify(a.policies), JSON.stringify(a.rlsBindings),
          JSON.stringify(a.schedules),
          a.homepage ? JSON.stringify(a.homepage) : null,
          a.gitCommitSha ?? '', now,
        );
      }
      const insertDashboard = this.db.prepare(`
        INSERT INTO dashboard_registry (
          id, app_id, title, description, domain, tags, file_path,
          block_ids, block_path_refs, unresolved_refs,
          params, filters, layout, git_commit_sha, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const d of input.dashboards) {
        insertDashboard.run(
          d.id, d.appId, d.title, d.description ?? null,
          d.domain ?? null, JSON.stringify(d.tags),
          d.filePath,
          JSON.stringify(d.blockIds), JSON.stringify(d.blockPathRefs),
          JSON.stringify(d.unresolvedRefs),
          JSON.stringify(d.params), JSON.stringify(d.filters),
          JSON.stringify(d.layout),
          d.gitCommitSha ?? '', now,
        );
      }
    });
    txn();
  }

  /** Read all apps from the registry, with their resolved dashboards joined. */
  listAppsWithDashboards(): Array<{
    app: Record<string, unknown>;
    dashboards: Array<Record<string, unknown>>;
  }> {
    const apps = this.db.prepare('SELECT * FROM app_registry ORDER BY name').all() as any[];
    const dashboards = this.db.prepare('SELECT * FROM dashboard_registry').all() as any[];
    const byApp = new Map<string, any[]>();
    for (const d of dashboards) {
      if (!byApp.has(d.app_id)) byApp.set(d.app_id, []);
      byApp.get(d.app_id)!.push(rowToDashboard(d));
    }
    return apps.map((a) => ({
      app: rowToApp(a),
      dashboards: byApp.get(a.id) ?? [],
    }));
  }

  async getBlock(id: string): Promise<BlockRecord | null> {
    const row = this.db.prepare('SELECT * FROM block_registry WHERE id = ?').get(id) as any;
    return row ? this.rowToBlock(row) : null;
  }

  async getBlockByName(name: string): Promise<BlockRecord | null> {
    const row = this.db.prepare('SELECT * FROM block_registry WHERE name = ?').get(name) as any;
    return row ? this.rowToBlock(row) : null;
  }

  async searchBlocks(query: BlockSearchQuery): Promise<BlockSearchResult> {
    const conditions: string[] = [];
    const params: any[] = [];

    if (query.domain) {
      conditions.push('domain = ?');
      params.push(query.domain);
    }
    if (query.type) {
      conditions.push('type = ?');
      params.push(query.type);
    }
    if (query.status) {
      conditions.push('status = ?');
      params.push(query.status);
    }
    if (query.owner) {
      conditions.push('owner = ?');
      params.push(query.owner);
    }
    if (query.tags && query.tags.length > 0) {
      const tagConditions = query.tags.map(() => 'tags LIKE ?');
      conditions.push(`(${tagConditions.join(' OR ')})`);
      for (const tag of query.tags) params.push(`%"${tag}"%`);
    }
    if (query.query) {
      conditions.push('(name LIKE ? OR description LIKE ? OR domain LIKE ?)');
      const q = `%${query.query}%`;
      params.push(q, q, q);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const countRow = this.db.prepare(`SELECT COUNT(*) as total FROM block_registry ${where}`).get(...params) as any;
    const total = countRow.total;
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const rows = this.db
      .prepare(`SELECT * FROM block_registry ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as any[];

    return {
      blocks: rows.map((row) => this.rowToBlock(row)),
      total,
      limit,
      offset,
    };
  }

  async insertBlock(block: BlockRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO block_registry (
        id, name, domain, type, version, status,
        git_repo, git_path, git_commit_sha,
        description, owner, tags, dependencies, cost_estimate,
        certified_at, certified_by, test_results,
        used_in_count, last_executed, avg_runtime_ms,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      block.id, block.name, block.domain, block.type, block.version, block.status,
      block.gitRepo, block.gitPath, block.gitCommitSha,
      block.description ?? null, block.owner,
      JSON.stringify(block.tags), JSON.stringify(block.dependencies),
      block.costEstimate ?? null,
      block.certifiedAt?.toISOString() ?? null,
      block.certifiedBy ?? null,
      block.testResults ? JSON.stringify(block.testResults) : null,
      block.usedInCount, block.lastExecuted?.toISOString() ?? null,
      block.avgRuntimeMs ?? null,
      block.createdAt.toISOString(), block.updatedAt.toISOString(),
    );
  }

  async updateBlock(id: string, updates: Partial<BlockRecord>): Promise<void> {
    const sets: string[] = [];
    const params: any[] = [];
    const fieldMap: Record<string, string> = {
      name: 'name',
      domain: 'domain',
      type: 'type',
      version: 'version',
      status: 'status',
      gitRepo: 'git_repo',
      gitPath: 'git_path',
      gitCommitSha: 'git_commit_sha',
      description: 'description',
      owner: 'owner',
      costEstimate: 'cost_estimate',
      certifiedBy: 'certified_by',
      usedInCount: 'used_in_count',
      avgRuntimeMs: 'avg_runtime_ms',
    };

    for (const [key, column] of Object.entries(fieldMap)) {
      if ((updates as any)[key] !== undefined) {
        sets.push(`${column} = ?`);
        params.push((updates as any)[key]);
      }
    }

    if (updates.tags !== undefined) {
      sets.push('tags = ?');
      params.push(JSON.stringify(updates.tags));
    }
    if (updates.dependencies !== undefined) {
      sets.push('dependencies = ?');
      params.push(JSON.stringify(updates.dependencies));
    }
    if (updates.certifiedAt !== undefined) {
      sets.push('certified_at = ?');
      params.push(updates.certifiedAt?.toISOString() ?? null);
    }
    if (updates.lastExecuted !== undefined) {
      sets.push('last_executed = ?');
      params.push(updates.lastExecuted?.toISOString() ?? null);
    }
    if (updates.testResults !== undefined) {
      sets.push('test_results = ?');
      params.push(updates.testResults ? JSON.stringify(updates.testResults) : null);
    }
    if (updates.updatedAt !== undefined) {
      sets.push('updated_at = ?');
      params.push(updates.updatedAt.toISOString());
    }

    if (sets.length === 0) return;
    params.push(id);
    this.db.prepare(`UPDATE block_registry SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  async deleteBlock(id: string): Promise<void> {
    this.db.prepare('DELETE FROM block_registry WHERE id = ?').run(id);
  }

  async getVersions(blockId: string): Promise<BlockVersion[]> {
    const rows = this.db
      .prepare('SELECT * FROM block_versions WHERE block_id = ? ORDER BY created_at DESC')
      .all(blockId) as any[];
    return rows.map((row) => this.rowToVersion(row));
  }

  async getActiveVersion(blockId: string): Promise<BlockVersion | null> {
    const row = this.db.prepare('SELECT * FROM block_versions WHERE block_id = ? AND is_active = 1').get(blockId) as any;
    return row ? this.rowToVersion(row) : null;
  }

  async getVersion(id: string): Promise<BlockVersion | null> {
    const row = this.db.prepare('SELECT * FROM block_versions WHERE id = ?').get(id) as any;
    return row ? this.rowToVersion(row) : null;
  }

  async insertVersion(version: BlockVersion): Promise<void> {
    this.db.prepare(`
      INSERT INTO block_versions (id, block_id, version, git_commit_sha, dql_source, certified_at, is_active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      version.id,
      version.blockId,
      version.version,
      version.gitCommitSha,
      version.dqlSource,
      version.certifiedAt?.toISOString() ?? null,
      version.isActive ? 1 : 0,
      version.createdAt.toISOString(),
    );
  }

  async setActiveVersion(blockId: string, versionId: string): Promise<void> {
    const transaction = this.db.transaction(() => {
      this.db.prepare('UPDATE block_versions SET is_active = 0 WHERE block_id = ?').run(blockId);
      this.db.prepare('UPDATE block_versions SET is_active = 1 WHERE id = ?').run(versionId);
    });
    transaction();
  }

  close(): void {
    this.db.close();
  }

  private rowToBlock(row: any): BlockRecord {
    return {
      id: row.id,
      name: row.name,
      domain: row.domain,
      type: row.type,
      version: row.version,
      status: row.status,
      gitRepo: row.git_repo,
      gitPath: row.git_path,
      gitCommitSha: row.git_commit_sha,
      description: row.description ?? undefined,
      owner: row.owner,
      tags: safeParseJSON(row.tags, []),
      dependencies: safeParseJSON(row.dependencies, []),
      costEstimate: row.cost_estimate ?? undefined,
      certifiedAt: row.certified_at ? new Date(row.certified_at) : undefined,
      certifiedBy: row.certified_by ?? undefined,
      testResults: row.test_results ? (safeParseJSON(row.test_results, null) as TestResultSummary | null) ?? undefined : undefined,
      usedInCount: row.used_in_count ?? 0,
      lastExecuted: row.last_executed ? new Date(row.last_executed) : undefined,
      avgRuntimeMs: row.avg_runtime_ms ?? undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private rowToVersion(row: any): BlockVersion {
    return {
      id: row.id,
      blockId: row.block_id,
      version: row.version,
      gitCommitSha: row.git_commit_sha,
      dqlSource: row.dql_source,
      certifiedAt: row.certified_at ? new Date(row.certified_at) : undefined,
      isActive: !!row.is_active,
      createdAt: new Date(row.created_at),
    };
  }
}

function safeParseJSON<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function rowToApp(row: any): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    description: row.description ?? undefined,
    owners: safeParseJSON(row.owners, [] as string[]),
    tags: safeParseJSON(row.tags, [] as string[]),
    filePath: row.file_path,
    members: safeParseJSON(row.members, [] as unknown[]),
    roles: safeParseJSON(row.roles, [] as unknown[]),
    policies: safeParseJSON(row.policies, [] as unknown[]),
    rlsBindings: safeParseJSON(row.rls_bindings, [] as unknown[]),
    schedules: safeParseJSON(row.schedules, [] as unknown[]),
    homepage: row.homepage ? safeParseJSON(row.homepage, null) : undefined,
    gitCommitSha: row.git_commit_sha ?? '',
    updatedAt: row.updated_at,
  };
}

function rowToDashboard(row: any): Record<string, unknown> {
  return {
    id: row.id,
    appId: row.app_id,
    title: row.title,
    description: row.description ?? undefined,
    domain: row.domain ?? undefined,
    tags: safeParseJSON(row.tags, [] as string[]),
    filePath: row.file_path,
    blockIds: safeParseJSON(row.block_ids, [] as string[]),
    blockPathRefs: safeParseJSON(row.block_path_refs, [] as string[]),
    unresolvedRefs: safeParseJSON(row.unresolved_refs, [] as string[]),
    params: safeParseJSON(row.params, [] as string[]),
    filters: safeParseJSON(row.filters, [] as string[]),
    layout: safeParseJSON(row.layout, {} as Record<string, unknown>),
    gitCommitSha: row.git_commit_sha ?? '',
    updatedAt: row.updated_at,
  };
}
