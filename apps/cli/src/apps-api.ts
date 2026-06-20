/**
 * HTTP handlers for `/api/apps`, `/api/apps/:id`, `/api/apps/:id/dashboards/:did`,
 * `/api/persona`. Designed to be invoked from `local-runtime.ts`'s request
 * dispatcher — returns `true` if the request was handled, `false` otherwise.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, type Dirent, type Stats } from 'node:fs';
import { join, dirname, relative, basename } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  loadAppDocument,
  findAppDocuments,
  loadDashboardDocument,
  findDashboardsForApp,
  parseAppDocument,
  parseDashboardDocument,
  suggestAppId,
  type AppDocument,
  type DashboardDocument,
  type DashboardGridItem,
} from '@duckcodeailabs/dql-core';
import {
  defaultPersonaRegistry,
  defaultLocalAppsDbPath,
  LocalAppStorage,
  personaFromMember,
  type ActivePersona,
  type LocalAppConversationContext,
  type LocalAppInvestigation,
  type LocalAppInvestigationIntent,
} from '@duckcodeailabs/dql-project';

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  path: string;
  projectRoot: string;
  executeSql?: (sql: string) => Promise<unknown>;
  generateInvestigationSql?: (input: AppInvestigationGenerationRequest) => Promise<AppInvestigationGenerationResult>;
  runNotebook?: (appId: string, notebookPath: string) => Promise<void>;
}

export async function handleAppsApi(ctx: Ctx): Promise<boolean> {
  const { req, res, path, projectRoot } = ctx;

  // ── Apps ────────────────────────────────────────────────────────────────

  if (req.method === 'GET' && path === '/api/apps') {
    const apps = collectAppsList(projectRoot);
    sendJson(res, 200, { apps });
    return true;
  }

  if (req.method === 'POST' && path === '/api/apps/recommend-blocks') {
    try {
      const body = await readJson<AppRecommendationRequest>(req);
      sendJson(res, 200, { blocks: recommendBlocks(projectRoot, body) });
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return true;
  }

  if (req.method === 'POST' && path === '/api/apps/generate') {
    try {
      const body = await readJson<AppGenerateRequest>(req);
      const result = await generateAppPackage(projectRoot, body);
      if (!result.ok) {
        sendJson(res, 400, { error: result.error });
        return true;
      }
      sendJson(res, 201, result);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return true;
  }

  if (req.method === 'POST' && path === '/api/apps') {
    try {
      const body = await readJson<AppCreateRequest>(req);
      const result = createAppPackage(projectRoot, body);
      if (!result.ok) {
        sendJson(res, 400, { error: result.error });
        return true;
      }
      await refreshGeneratedMetadata(projectRoot);
      sendJson(res, 201, result);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return true;
  }

  let m = path.match(/^\/api\/apps\/([^/]+)\/editor\/catalog$/);
  if (m && req.method === 'GET') {
    const appId = decodeURIComponent(m[1]);
    const app = loadAppById(projectRoot, appId)?.app;
    if (!app) {
      sendJson(res, 404, { error: `App "${appId}" not found` });
      return true;
    }
    const domain = ctx.url.searchParams.get('domain') ?? app.domain;
    const certifiedOnly = ctx.url.searchParams.get('certifiedOnly') !== 'false';
    const blocks = collectBlockCandidates(projectRoot)
      .filter((block) => !certifiedOnly || block.status === 'certified')
      .filter((block) => !domain || block.domain === domain || appAllowsExecute(app, block.domain))
      .sort((a, b) => {
        const aDomain = a.domain === app.domain ? 0 : 1;
        const bDomain = b.domain === app.domain ? 0 : 1;
        return aDomain - bDomain || a.name.localeCompare(b.name);
      });
    sendJson(res, 200, {
      appId,
      defaultDomain: app.domain,
      domains: unique(blocks.map((block) => block.domain)),
      blocks,
    });
    return true;
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/dashboards$/);
  if (m && req.method === 'POST') {
    const appId = decodeURIComponent(m[1]);
    try {
      const body = await readJson<{ id?: string; title?: string; description?: string }>(req);
      const result = createDashboardForApp(projectRoot, appId, body);
      if (!result.ok) {
        sendJson(res, 400, { error: result.error });
        return true;
      }
      sendJson(res, 201, result);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return true;
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/notebook-candidates$/);
  if (m && req.method === 'GET') {
    const appId = decodeURIComponent(m[1]);
    const loaded = loadAppById(projectRoot, appId);
    if (!loaded) {
      sendJson(res, 404, { error: `App "${appId}" not found` });
      return true;
    }
    sendJson(res, 200, { notebooks: listNotebookCandidates(projectRoot, loaded.app, loaded.appDir) });
    return true;
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/notebooks\/create$/);
  if (m && req.method === 'POST') {
    const appId = decodeURIComponent(m[1]);
    try {
      const body = await readJson<{ name?: string; title?: string; role?: string; visibility?: string; template?: string }>(req);
      const result = createNotebookForApp(projectRoot, appId, body);
      if (!result.ok) {
        sendJson(res, 400, { error: result.error });
        return true;
      }
      sendJson(res, 201, result);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return true;
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/notebooks\/preview$/);
  if (m && req.method === 'GET') {
    const appId = decodeURIComponent(m[1]);
    const notebookPath = ctx.url.searchParams.get('path') ?? '';
    const result = previewNotebookForApp(projectRoot, appId, notebookPath);
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    sendJson(res, 200, result.preview);
    return true;
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/notebooks\/run$/);
  if (m && req.method === 'POST') {
    const appId = decodeURIComponent(m[1]);
    try {
      const body = await readJson<{ path?: string }>(req);
      const notebookPath = cleanString(body.path);
      if (!notebookPath) {
        sendJson(res, 400, { error: 'path is required' });
        return true;
      }
      if (!ctx.runNotebook) {
        sendJson(res, 400, { error: 'Notebook run is unavailable in this host.' });
        return true;
      }
      await ctx.runNotebook(appId, notebookPath);
      const preview = previewNotebookForApp(projectRoot, appId, notebookPath);
      if (!preview.ok) {
        sendJson(res, preview.status, { error: preview.error });
        return true;
      }
      sendJson(res, 200, { ok: true, preview: preview.preview });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/notebooks$/);
  if (m && req.method === 'POST') {
    const appId = decodeURIComponent(m[1]);
    try {
      const body = await readJson<{ path?: string; title?: string; role?: string; visibility?: string }>(req);
      const result = attachNotebookToApp(projectRoot, appId, body);
      if (!result.ok) {
        sendJson(res, 400, { error: result.error });
        return true;
      }
      sendJson(res, 200, loadAppById(projectRoot, appId) ?? result);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return true;
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/conversations$/);
  if (m) {
    const appId = decodeURIComponent(m[1]);
    if (!loadAppById(projectRoot, appId)) {
      sendJson(res, 404, { error: `App "${appId}" not found` });
      return true;
    }
    const storage = new LocalAppStorage(defaultLocalAppsDbPath(projectRoot));
    try {
      if (req.method === 'GET') {
        sendJson(res, 200, { conversations: storage.listAppConversations(appId) });
        return true;
      }
      if (req.method === 'POST') {
        const body = await readJson<{
          title?: string;
          dashboardId?: string;
          notebookPath?: string;
          context?: unknown;
          messages?: AppConversationMessageRequest[];
        }>(req);
        const conversation = storage.createAppConversation({
          appId,
          title: body.title,
          dashboardId: body.dashboardId,
          notebookPath: body.notebookPath,
          context: normalizeConversationContext(body.context),
          messages: normalizeConversationMessages(body.messages),
        });
        sendJson(res, 201, { ok: true, conversation });
        return true;
      }
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
      return true;
    } finally {
      storage.close();
    }
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/conversations\/([^/]+)$/);
  if (m) {
    const appId = decodeURIComponent(m[1]);
    const conversationId = decodeURIComponent(m[2]);
    const storage = new LocalAppStorage(defaultLocalAppsDbPath(projectRoot));
    try {
      const conversation = storage.getAppConversation(conversationId);
      if (!conversation || conversation.appId !== appId) {
        sendJson(res, 404, { error: `Conversation "${conversationId}" not found` });
        return true;
      }
      if (req.method === 'GET') {
        sendJson(res, 200, { conversation });
        return true;
      }
      if (req.method === 'PATCH') {
        const body = await readJson<{
          title?: string;
          dashboardId?: string;
          notebookPath?: string;
          context?: unknown;
          messages?: AppConversationMessageRequest[];
        }>(req);
        const updated = storage.updateAppConversation(conversationId, {
          title: body.title,
          dashboardId: body.dashboardId,
          notebookPath: body.notebookPath,
          context: body.context === undefined ? undefined : normalizeConversationContext(body.context) ?? null,
          messages: body.messages ? normalizeConversationMessages(body.messages) : undefined,
        });
        sendJson(res, 200, { ok: true, conversation: updated });
        return true;
      }
      if (req.method === 'DELETE') {
        sendJson(res, 200, { ok: storage.deleteAppConversation(conversationId) });
        return true;
      }
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
      return true;
    } finally {
      storage.close();
    }
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/investigations$/);
  if (m) {
    const appId = decodeURIComponent(m[1]);
    if (!loadAppById(projectRoot, appId)) {
      sendJson(res, 404, { error: `App "${appId}" not found` });
      return true;
    }
    const storage = new LocalAppStorage(defaultLocalAppsDbPath(projectRoot));
    try {
      if (req.method === 'GET') {
        const dashboardId = ctx.url.searchParams.get('dashboardId') ?? undefined;
        sendJson(res, 200, { investigations: storage.listAppInvestigations(appId, dashboardId) });
        return true;
      }
      if (req.method === 'POST') {
        const body = await readJson<AppInvestigationCreateRequest>(req);
        const question = cleanString(body.question);
        if (!question) {
          sendJson(res, 400, { error: 'question is required' });
          return true;
        }
        let investigation = storage.createAppInvestigation({
          appId,
          dashboardId: body.dashboardId,
          sourceTileId: body.sourceTileId ?? selectedContextString(body.context, 'tileId'),
          sourceBlockId: body.sourceBlockId ?? selectedContextString(body.context, 'blockId'),
          title: body.title,
          question,
          intent: normalizeInvestigationIntent(body.intent, question, body.context),
          context: body.context,
          generatedSql: body.generatedSql,
        });
        if (body.run !== false) {
          investigation = await runAppInvestigation(ctx, storage, investigation, body);
        }
        sendJson(res, 201, { ok: true, investigation });
        return true;
      }
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      return true;
    } finally {
      storage.close();
    }
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/investigations\/([^/]+)$/);
  if (m) {
    const appId = decodeURIComponent(m[1]);
    const investigationId = decodeURIComponent(m[2]);
    const storage = new LocalAppStorage(defaultLocalAppsDbPath(projectRoot));
    try {
      const investigation = storage.getAppInvestigation(investigationId);
      if (!investigation || investigation.appId !== appId) {
        sendJson(res, 404, { error: `Investigation "${investigationId}" not found` });
        return true;
      }
      if (req.method === 'GET') {
        sendJson(res, 200, { investigation });
        return true;
      }
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      return true;
    } finally {
      storage.close();
    }
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/investigations\/([^/]+)\/run$/);
  if (m && req.method === 'POST') {
    const appId = decodeURIComponent(m[1]);
    const investigationId = decodeURIComponent(m[2]);
    const storage = new LocalAppStorage(defaultLocalAppsDbPath(projectRoot));
    try {
      const investigation = storage.getAppInvestigation(investigationId);
      if (!investigation || investigation.appId !== appId) {
        sendJson(res, 404, { error: `Investigation "${investigationId}" not found` });
        return true;
      }
      const body = await readJson<AppInvestigationRunRequest>(req);
      const updated = await runAppInvestigation(ctx, storage, investigation, body);
      sendJson(res, 200, { ok: true, investigation: updated });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    } finally {
      storage.close();
    }
    return true;
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/investigations\/([^/]+)\/pin$/);
  if (m && req.method === 'POST') {
    const appId = decodeURIComponent(m[1]);
    const investigationId = decodeURIComponent(m[2]);
    const storage = new LocalAppStorage(defaultLocalAppsDbPath(projectRoot));
    try {
      const investigation = storage.getAppInvestigation(investigationId);
      if (!investigation || investigation.appId !== appId) {
        sendJson(res, 404, { error: `Investigation "${investigationId}" not found` });
        return true;
      }
      const body = await readJson<AppInvestigationPinRequest>(req);
      const appInfo = loadAppById(projectRoot, appId);
      const dashboardId = cleanString(body.dashboardId) || investigation.dashboardId || appInfo?.dashboards[0]?.id;
      if (!dashboardId) {
        sendJson(res, 400, { error: 'No dashboard is available for this investigation.' });
        return true;
      }
      const created = createAiPinTile(projectRoot, appId, {
        dashboardId,
        title: cleanString(body.title) || investigation.title,
        answer: investigation.summary ?? investigation.recommendation ?? investigation.title,
        question: investigation.question,
        sql: investigation.generatedSql,
        sourceTier: 'metadata_research',
        certification: 'ai_generated',
        reviewStatus: 'needs_review',
        refreshCadence: body.refreshCadence === 'daily' ? 'daily' : 'none',
        chartConfig: { chart: 'table' },
        result: investigationPreviewResult(investigation),
        citations: investigationCitations(investigation),
        analysisPlan: {
          intent: investigation.intent,
          reviewRequired: true,
          uncertified: true,
          sourceTileId: investigation.sourceTileId,
          sourceBlockId: investigation.sourceBlockId,
        },
        evidence: investigation.evidence,
        followUps: nextResearchFollowUps(investigation),
      });
      if (!created.ok) {
        sendJson(res, 400, { error: created.error });
        return true;
      }
      const pinId = typeof created.pin === 'object' && created.pin && 'id' in created.pin ? String((created.pin as { id: unknown }).id) : '';
      const updated = pinId ? storage.markAppInvestigationPinned(investigationId, pinId) : investigation;
      sendJson(res, 200, { ...created, investigation: updated });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    } finally {
      storage.close();
    }
    return true;
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/ai-pins$/);
  if (m) {
    const appId = decodeURIComponent(m[1]);
    if (req.method === 'GET') {
      const dashboardId = ctx.url.searchParams.get('dashboardId') ?? undefined;
      const storage = new LocalAppStorage(defaultLocalAppsDbPath(projectRoot));
      try {
        sendJson(res, 200, { pins: storage.listAiPins(appId, dashboardId) });
      } finally {
        storage.close();
      }
      return true;
    }
    if (req.method === 'POST') {
      try {
        const body = await readJson<AiPinCreateRequest>(req);
        const created = createAiPinTile(projectRoot, appId, body);
        if (!created.ok) {
          sendJson(res, 400, { error: created.error });
          return true;
        }
        sendJson(res, 201, created);
      } catch (err) {
        sendJson(res, 500, { error: (err as Error).message });
      }
      return true;
    }
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/ai-pins\/([^/]+)\/refresh$/);
  if (m && req.method === 'POST') {
    const pinId = decodeURIComponent(m[2]);
    const storage = new LocalAppStorage(defaultLocalAppsDbPath(projectRoot));
    try {
      const pin = storage.getAiPin(pinId);
      if (!pin) {
        sendJson(res, 404, { error: `AI pin "${pinId}" not found` });
        return true;
      }
      if (!pin.sql) {
        const updated = storage.updateAiPinResult(pinId, pin.result, 'Pin has no SQL to refresh.');
        sendJson(res, 400, { error: 'Pin has no SQL to refresh.', pin: updated });
        return true;
      }
      if (!ctx.executeSql) {
        const updated = storage.updateAiPinResult(pinId, pin.result, 'This host cannot execute AI pin SQL.');
        sendJson(res, 400, { error: 'This host cannot execute AI pin SQL.', pin: updated });
        return true;
      }
      const result = await ctx.executeSql(pin.sql);
      const updated = storage.updateAiPinResult(pinId, result);
      sendJson(res, 200, { ok: true, pin: updated });
    } catch (err) {
      const pin = storage.updateAiPinResult(pinId, undefined, err instanceof Error ? err.message : String(err));
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err), pin });
    } finally {
      storage.close();
    }
    return true;
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/ai-pins\/([^/]+)\/promote$/);
  if (m && req.method === 'POST') {
    const appId = decodeURIComponent(m[1]);
    const pinId = decodeURIComponent(m[2]);
    try {
      const result = promoteAiPinToDraftBlock(projectRoot, appId, pinId);
      if (!result.ok) {
        sendJson(res, 400, { error: result.error });
        return true;
      }
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return true;
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/dashboards\/([^/]+)\/layout$/);
  if (m && req.method === 'PATCH') {
    const appId = decodeURIComponent(m[1]);
    const dashboardId = decodeURIComponent(m[2]);
    try {
      const body = await readJson<{ layout?: DashboardDocument['layout']; items?: DashboardGridItem[] }>(req);
      const result = patchDashboardLayout(projectRoot, appId, dashboardId, body);
      if (!result.ok) {
        sendJson(res, 400, { error: result.error });
        return true;
      }
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return true;
  }

  // /api/apps/:id  — single App with dashboards summary
  m = path.match(/^\/api\/apps\/([^/]+)$/);
  if (m && req.method === 'GET') {
    const id = m[1];
    const result = loadAppById(projectRoot, id);
    if (!result) {
      sendJson(res, 404, { error: `App "${id}" not found` });
      return true;
    }
    sendJson(res, 200, result);
    return true;
  }

  // /api/apps/:id/dashboards
  m = path.match(/^\/api\/apps\/([^/]+)\/dashboards$/);
  if (m && req.method === 'GET') {
    const id = m[1];
    const dashboards = listDashboardsFor(projectRoot, id);
    if (dashboards === null) {
      sendJson(res, 404, { error: `App "${id}" not found` });
      return true;
    }
    sendJson(res, 200, { dashboards });
    return true;
  }

  // /api/apps/:id/dashboards/:did
  m = path.match(/^\/api\/apps\/([^/]+)\/dashboards\/([^/]+)$/);
  if (m) {
    const id = m[1];
    const did = m[2];
    if (req.method === 'GET') {
      const result = loadDashboardForApp(projectRoot, id, did);
      if (!result) {
        sendJson(res, 404, { error: `Dashboard "${did}" not found in app "${id}"` });
        return true;
      }
      sendJson(res, 200, result);
      return true;
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      try {
        const body = await readJson(req);
        const written = await writeDashboard(projectRoot, id, did, body);
        if (!written.ok) {
          sendJson(res, 400, { error: written.error });
          return true;
        }
        sendJson(res, 200, { ok: true, path: written.path });
      } catch (err) {
        sendJson(res, 500, { error: (err as Error).message });
      }
      return true;
    }
  }

  // ── Persona ────────────────────────────────────────────────────────────

  if (path === '/api/persona') {
    if (req.method === 'GET') {
      sendJson(res, 200, { persona: defaultPersonaRegistry.active });
      return true;
    }
    if (req.method === 'DELETE') {
      defaultPersonaRegistry.clear();
      sendJson(res, 200, { persona: null });
      return true;
    }
    if (req.method === 'POST') {
      try {
        const body = await readJson(req);
        const userId = typeof body.userId === 'string' ? body.userId : null;
        const appId = typeof body.appId === 'string' ? body.appId : null;
        if (!userId) {
          sendJson(res, 400, { error: 'userId is required' });
          return true;
        }
        const persona = activatePersona(projectRoot, userId, appId);
        if (!persona) {
          sendJson(res, 404, { error: 'No App member matches this userId' });
          return true;
        }
        sendJson(res, 200, { persona });
      } catch (err) {
        sendJson(res, 500, { error: (err as Error).message });
      }
      return true;
    }
  }

  return false;
}

// ---- Helpers ----

type AppListEntry = {
  id: string;
  name: string;
  filePath: string;
  domain: string;
  subdomain?: string;
  groups: string[];
  description?: string;
  audience?: string;
  lifecycle: NonNullable<AppDocument['lifecycle']>;
  certification: 'certified' | 'uncertified';
  status?: 'ready' | 'empty' | 'review';
  storage: 'shared' | 'mine' | 'template';
  visibility: NonNullable<AppDocument['visibility']>;
  owners: string[];
  tags: string[];
  members: number;
  roles: number;
  policies: number;
  schedules: number;
  dashboards: Array<{ id: string; title: string }>;
  notebooks: Array<{ path: string; title?: string; role: 'source' | 'analysis' | 'supporting'; visibility: NonNullable<AppDocument['visibility']> }>;
  drafts: Array<{ path: string; name: string; reviewStatus?: string }>;
  aiPins: number;
  investigations: number;
  homepage?: AppDocument['homepage'];
};

function collectAppsList(projectRoot: string): AppListEntry[] {
  const out: AppListEntry[] = [];
  for (const p of findAppDocuments(projectRoot)) {
    const { document } = loadAppDocument(p);
    if (!document) continue;
    const appDir = p.slice(0, -'/dql.app.json'.length);
    const dashboards: Array<{ id: string; title: string }> = [];
    for (const d of findDashboardsForApp(appDir)) {
      const { document: dd } = loadDashboardDocument(d);
      if (dd) dashboards.push({ id: dd.id, title: dd.metadata.title });
    }
    out.push({
      id: document.id,
      name: document.name,
      filePath: relative(projectRoot, appDir),
      domain: document.domain,
      subdomain: document.subdomain,
      groups: document.groups ?? [],
      description: document.description,
      audience: document.audience ?? audienceFromTags(document.tags ?? []),
      lifecycle: document.lifecycle ?? 'draft',
      certification: document.lifecycle === 'certified' ? 'certified' : 'uncertified',
      status: document.lifecycle === 'review' ? 'review' : dashboards.length > 0 ? 'ready' : 'empty',
      storage: document.visibility === 'private' ? 'mine' : document.visibility === 'template' ? 'template' : 'shared',
      visibility: document.visibility ?? 'shared',
      owners: document.owners,
      tags: document.tags ?? [],
      members: document.members.length,
      roles: document.roles.length,
      policies: document.policies.length,
      schedules: (document.schedules ?? []).length,
      dashboards,
      notebooks: listAppNotebookRefs(projectRoot, document, appDir),
      drafts: listAppDrafts(projectRoot, appDir),
      aiPins: countAiPins(projectRoot, document.id),
      investigations: countAppInvestigations(projectRoot, document.id),
      homepage: document.homepage,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

interface AppRecommendationRequest {
  domain?: string;
  tags?: string[];
  purpose?: string;
  audience?: string;
  certifiedOnly?: boolean;
}

interface AppCreateRequest {
  name?: string;
  domain?: string;
  dashboardTitle?: string;
  subdomain?: string;
  groups?: string[];
  purpose?: string;
  audience?: string;
  visibility?: 'shared' | 'private' | 'template';
  lifecycle?: AppDocument['lifecycle'];
  tags?: string[];
  owners?: string[];
  selectedBlockIds?: string[];
}

interface AppGenerateRequest {
  prompt?: string;
  domain?: string;
  owner?: string;
  force?: boolean;
  selectedBlockIds?: string[];
  plannerMode?: 'deterministic' | 'ai_assisted';
}

interface AiPinCreateRequest {
  dashboardId?: string;
  tileId?: string;
  title?: string;
  answer?: string;
  question?: string;
  sql?: string;
  sourceTier?: string;
  certification?: 'certified' | 'ai_generated';
  reviewStatus?: 'needs_review' | 'draft_created' | 'certified' | 'rejected';
  refreshCadence?: 'none' | 'daily';
  chartConfig?: Record<string, unknown>;
  result?: unknown;
  citations?: unknown[];
  analysisPlan?: unknown;
  evidence?: unknown;
  followUps?: string[];
}

interface AppConversationMessageRequest {
  id?: string;
  role?: 'user' | 'assistant';
  content?: string;
  events?: unknown[];
  createdAt?: string;
}

function normalizeConversationContext(value: unknown): LocalAppConversationContext | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    activeSurface: cleanString(record.activeSurface) || undefined,
    sourceCertifiedBlock: cleanString(record.sourceCertifiedBlock) || undefined,
    sourceQuestion: cleanString(record.sourceQuestion) || undefined,
    sourceAnswerSummary: cleanString(record.sourceAnswerSummary) || undefined,
    followupKind: record.followupKind === 'generic' || record.followupKind === 'drilldown' ? record.followupKind : undefined,
    requestedFilters: stringArray(record.requestedFilters),
    requestedDimensions: stringArray(record.requestedDimensions),
    outputColumns: stringArray(record.outputColumns),
    trustLabel: cleanString(record.trustLabel) || undefined,
    reviewStatus: cleanString(record.reviewStatus) || undefined,
    certification: cleanString(record.certification) || undefined,
    route: cleanString(record.route) || undefined,
    contextPackId: cleanString(record.contextPackId) || undefined,
    draftBlockPath: cleanString(record.draftBlockPath) || undefined,
    selectedEvidence: Array.isArray(record.selectedEvidence) ? record.selectedEvidence.slice(0, 16) : undefined,
    updatedAt: cleanString(record.updatedAt) || undefined,
  };
}

interface AppInvestigationCreateRequest {
  dashboardId?: string;
  sourceTileId?: string;
  sourceBlockId?: string;
  title?: string;
  question?: string;
  intent?: LocalAppInvestigationIntent;
  context?: unknown;
  generatedSql?: string;
  run?: boolean;
}

interface AppInvestigationRunRequest {
  question?: string;
  intent?: LocalAppInvestigationIntent;
  context?: unknown;
  generatedSql?: string;
}

interface AppInvestigationPinRequest {
  dashboardId?: string;
  title?: string;
  refreshCadence?: 'none' | 'daily';
}

interface AppInvestigationGenerationRequest {
  appId: string;
  dashboardId?: string;
  sourceTileId?: string;
  sourceBlockId?: string;
  title?: string;
  question: string;
  intent: LocalAppInvestigationIntent;
  context?: unknown;
}

interface AppInvestigationGenerationResult {
  sql?: string;
  answer?: string;
  result?: unknown;
  analysisPlan?: unknown;
  evidence?: unknown;
  citations?: unknown[];
  suggestedViz?: string;
  executionError?: string;
  providerUsed?: string;
}

interface BlockCandidate {
  id: string;
  name: string;
  domain: string;
  status: string;
  owner: string | null;
  tags: string[];
  path: string;
  lastModified: string;
  description: string;
  llmContext: string | null;
  chartType?: string;
  score: number;
  reasons: string[];
}

export function recommendBlocks(projectRoot: string, input: AppRecommendationRequest): BlockCandidate[] {
  const domain = cleanString(input.domain).toLowerCase();
  const tags = normalizeTags(input.tags ?? []);
  const text = [input.purpose, input.audience, ...(input.tags ?? [])].map((v) => cleanString(v).toLowerCase()).filter(Boolean);
  const certifiedOnly = input.certifiedOnly !== false;
  const hasCriteria = Boolean(domain || tags.length > 0 || text.length > 0);

  return collectBlockCandidates(projectRoot)
    .map((block) => {
      let score = 0;
      let criteriaScore = 0;
      const reasons: string[] = [];
      if (domain && block.domain.toLowerCase() === domain) {
        score += 100;
        criteriaScore += 100;
        reasons.push('domain match');
      }
      if (certifiedOnly && block.status !== 'certified') return null;
      if (block.status === 'certified') {
        score += 30;
        reasons.push('certified');
      }
      const overlap = block.tags.filter((tag) => tags.includes(tag.toLowerCase()));
      if (overlap.length > 0) {
        score += overlap.length * 12;
        criteriaScore += overlap.length * 12;
        reasons.push(`tag match: ${overlap.join(', ')}`);
      }
      const haystack = [block.name, block.description, block.owner ?? '', block.llmContext ?? '', ...block.tags]
        .join(' ')
        .toLowerCase();
      const textHits = text.filter((term) => term && haystack.includes(term));
      if (textHits.length > 0) {
        score += textHits.length * 6;
        criteriaScore += textHits.length * 6;
        reasons.push('context match');
      }
      if (score === 0 && !domain && tags.length === 0 && !certifiedOnly) score = 1;
      if (hasCriteria && criteriaScore === 0) return null;
      if (score === 0) return null;
      return { ...block, score, reasons };
    })
    .filter((block): block is BlockCandidate => Boolean(block))
    .sort((a, b) => b.score - a.score || new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime())
    .slice(0, 50);
}

export async function generateAppPackage(
  projectRoot: string,
  input: AppGenerateRequest,
): Promise<
  | {
      ok: true;
      plan: unknown;
      validation: unknown;
      generated: { paths: string[] };
      app: ReturnType<typeof collectAppsList>[number] | null;
      dashboardId: string | null;
    }
  | { ok: false; error: string }
> {
  const prompt = cleanString(input.prompt);
  if (!prompt) return { ok: false, error: 'prompt is required' };
  const selectedBlockIds = unique((input.selectedBlockIds ?? []).map(cleanString).filter(Boolean));

  const {
    KGStore,
    defaultKgPath,
    generateAppFromPlan,
    ensureMetadataCatalogFresh,
    planAppFromPrompt,
    reindexProject,
    validateAppPlan,
  } = await import('@duckcodeailabs/dql-agent');

  const kgPath = defaultKgPath(projectRoot);
  await reindexProject(projectRoot, { kgPath });
  const kg = new KGStore(kgPath);
  try {
    const plan = planAppFromPrompt({
      prompt,
      kg,
      domain: cleanString(input.domain) || undefined,
      owner: cleanString(input.owner) || undefined,
      preferredBlockIds: selectedBlockIds,
      plannerMode: input.plannerMode === 'ai_assisted' ? 'ai_assisted' : 'deterministic',
    });
    const validation = validateAppPlan(plan, kg);
    const generated = generateAppFromPlan(projectRoot, plan, kg, {
      overwrite: Boolean(input.force),
    });
    await ensureMetadataCatalogFresh(projectRoot, { force: true });
    const app = collectAppsList(projectRoot).find((entry) => entry.id === plan.appId) ?? null;
    return {
      ok: true,
      plan,
      validation,
      generated: { paths: generated.paths },
      app,
      dashboardId: plan.pages[0]?.id ?? app?.dashboards[0]?.id ?? null,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    kg.close();
  }
}

export function createAppPackage(
  projectRoot: string,
  input: AppCreateRequest,
): { ok: true; app: ReturnType<typeof collectAppsList>[number]; paths: string[]; dashboardId: string } | { ok: false; error: string } {
  const name = cleanString(input.name);
  const domain = cleanString(input.domain);
  if (!name) return { ok: false, error: 'name is required' };
  if (!domain) return { ok: false, error: 'domain is required' };

  const id = suggestAppId(name);
  const appDir = resolveAppPackageDir(projectRoot, domain, id);
  if (existsSync(appDir)) return { ok: false, error: `App already exists: ${id}` };
  const dashboardTitle = cleanString(input.dashboardTitle) || 'Overview';
  const dashboardId = slugify(dashboardTitle) || 'overview';

  const owner = cleanString(input.owners?.[0]) || `${process.env.USER ?? 'owner'}@local`;
  const audience = cleanString(input.audience);
  const subdomain = cleanString(input.subdomain);
  const groups = normalizeTags(input.groups ?? []);
  const visibility = input.visibility === 'private' || input.visibility === 'template' ? input.visibility : 'shared';
  const lifecycle = input.lifecycle === 'certified' || input.lifecycle === 'review' || input.lifecycle === 'deprecated'
    ? input.lifecycle
    : 'draft';
  const tags = normalizeTags([...(input.tags ?? []), audience ? `audience:${slugify(audience)}` : '']);
  const selectedIds = Array.from(new Set((input.selectedBlockIds ?? []).map(cleanString).filter(Boolean)));
  const blocks = collectBlockCandidates(projectRoot);
  const selectedBlocks = selectedIds
    .map((blockId) => blocks.find((block) => block.id === blockId || block.name === blockId))
    .filter((block): block is BlockCandidate => Boolean(block));

  const app: AppDocument = {
    version: 1,
    id,
    name,
    description: cleanString(input.purpose) || `${name} consumption surface for ${domain}`,
    visibility,
    domain,
    subdomain: subdomain || undefined,
    groups,
    audience: audience || undefined,
    lifecycle,
    owners: [owner],
    tags,
    members: [
      { userId: owner, displayName: owner, roles: ['owner', 'analyst'] },
    ],
    roles: [
      { id: 'owner', displayName: 'Owner', description: 'Full access to dashboards and App configuration.' },
      { id: 'analyst', displayName: 'Analyst', description: 'Can execute dashboards and review generated drafts.' },
      { id: 'viewer', displayName: 'Viewer', description: 'Read-only access to certified dashboard consumption.' },
    ],
    policies: [
      {
        id: 'viewers-read',
        domain,
        minClassification: 'internal',
        allowedRoles: ['viewer', 'analyst', 'owner'],
        accessLevel: 'read',
        enabled: true,
      },
      {
        id: 'analyst-execute',
        domain,
        minClassification: 'internal',
        allowedRoles: ['analyst', 'owner'],
        accessLevel: 'execute',
        enabled: true,
      },
      {
        id: 'owner-admin',
        domain,
        minClassification: 'restricted',
        allowedRoles: ['owner'],
        accessLevel: 'admin',
        enabled: true,
      },
    ],
    rlsBindings: [],
    schedules: [],
    homepage: { type: 'dashboard', id: dashboardId },
  };

  const dashboard: DashboardDocument = {
    version: 1,
    id: dashboardId,
    metadata: {
      title: dashboardTitle,
      description: cleanString(input.purpose) || `Starter dashboard for ${name}`,
      domain,
      subdomain: subdomain || undefined,
      groups,
      audience: audience || undefined,
      visibility,
      lifecycle,
      tags,
    },
    layout: {
      kind: 'grid',
      cols: 12,
      rowHeight: 80,
      items: buildDashboardItems(selectedBlocks),
    },
  };

  const paths = [
    join(appDir, 'dql.app.json'),
    join(appDir, 'README.md'),
    join(appDir, 'dashboards', `${dashboardId}.dqld`),
    join(appDir, 'notebooks'),
    join(appDir, 'drafts'),
  ];
  mkdirSync(join(appDir, 'dashboards'), { recursive: true });
  mkdirSync(join(appDir, 'notebooks'), { recursive: true });
  mkdirSync(join(appDir, 'drafts'), { recursive: true });
  writeFileSync(join(appDir, 'dql.app.json'), JSON.stringify(app, null, 2) + '\n', 'utf-8');
  writeFileSync(join(appDir, 'dashboards', `${dashboardId}.dqld`), JSON.stringify(dashboard, null, 2) + '\n', 'utf-8');
  writeFileSync(join(appDir, 'README.md'), appReadme(app, audience, selectedBlocks, dashboardId), 'utf-8');

  const created = collectAppsList(projectRoot).find((entry) => entry.id === id);
  if (!created) return { ok: false, error: `App was written but could not be reloaded: ${id}` };
  return {
    ok: true,
    app: created,
    paths: paths.map((path) => path.startsWith(projectRoot) ? path.slice(projectRoot.length + 1) : path),
    dashboardId,
  };
}

function buildDashboardItems(blocks: BlockCandidate[]): DashboardDocument['layout']['items'] {
  let x = 0;
  let y = 0;
  let rowH = 0;
  return [...blocks]
    .sort((a, b) => vizRank(a.chartType) - vizRank(b.chartType))
    .map((block, index) => {
      const chartType = normalizeVizType(block.chartType);
      const size = tileSize(chartType);
      if (x + size.w > 12) {
        x = 0;
        y += rowH || size.h;
        rowH = 0;
      }
      const item = dashboardItemForBlock(block, chartType, x, y, size, index);
      x += size.w;
      rowH = Math.max(rowH, size.h);
      return item;
    });
}

function dashboardItemForBlock(
  block: BlockCandidate,
  chartType: ReturnType<typeof normalizeVizType>,
  x: number,
  y: number,
  size: { w: number; h: number },
  index: number,
): DashboardDocument['layout']['items'][number] {
  return {
    i: slugify(block.name) || `tile-${index + 1}`,
    x,
    y,
    w: size.w,
    h: size.h,
    block: { blockId: block.name },
    viz: { type: chartType },
    title: block.name,
  };
}

function vizRank(chartType?: string): number {
  const normalized = normalizeVizType(chartType);
  if (normalized === 'single_value' || normalized === 'kpi') return 0;
  if (normalized === 'line' || normalized === 'area') return 1;
  if (normalized === 'bar' || normalized === 'pie' || normalized === 'funnel' || normalized === 'map') return 2;
  return 3;
}

function tileSize(chartType: string): { w: number; h: number } {
  if (chartType === 'single_value' || chartType === 'kpi') return { w: 3, h: 2 };
  if (chartType === 'table' || chartType === 'pivot') return { w: 6, h: 4 };
  return { w: 6, h: 3 };
}

function normalizeVizType(chartType?: string): DashboardGridItem['viz']['type'] {
  const normalized = (chartType ?? 'table').toLowerCase().replace(/-/g, '_');
  if (normalized === 'single' || normalized === 'single_value') return 'single_value';
  if (normalized === 'kpi') return 'kpi';
  if (normalized === 'line') return 'line';
  if (normalized === 'bar') return 'bar';
  if (normalized === 'grouped_bar') return 'grouped_bar';
  if (normalized === 'stacked_bar') return 'stacked_bar';
  if (normalized === 'area') return 'area';
  if (normalized === 'pie') return 'pie';
  if (normalized === 'donut') return 'donut';
  if (normalized === 'scatter') return 'scatter';
  if (normalized === 'heatmap') return 'heatmap';
  if (normalized === 'histogram') return 'histogram';
  if (normalized === 'waterfall') return 'waterfall';
  if (normalized === 'gauge') return 'gauge';
  if (normalized === 'pivot') return 'pivot';
  if (normalized === 'map') return 'map';
  if (normalized === 'funnel') return 'funnel';
  return 'table';
}

function appReadme(app: AppDocument, audience: string, blocks: BlockCandidate[], dashboardId = 'overview'): string {
  return [
    `# ${app.name}`,
    '',
    app.description ?? '',
    '',
    `- Domain: ${app.domain}`,
    ...(app.subdomain ? [`- Subdomain: ${app.subdomain}`] : []),
    ...(app.groups?.length ? [`- Groups: ${app.groups.join(', ')}`] : []),
    `- Audience: ${audience || 'not specified'}`,
    `- Visibility: ${app.visibility}`,
    `- Lifecycle: ${app.lifecycle}`,
    `- Owners: ${app.owners.join(', ')}`,
    `- Starter dashboard: dashboards/${dashboardId}.dqld`,
    `- Supporting notebooks: notebooks/`,
    `- Draft blocks: drafts/`,
    '',
    '## Selected Certified Blocks',
    '',
    ...(blocks.length > 0
      ? blocks.map((block) => `- ${block.name} (${block.domain}, ${block.status}) - ${block.path}`)
      : ['No blocks selected yet. Add certified blocks from the Apps Command Center.']),
    '',
    '## Governance',
    '',
    'This OSS App uses local persona switching with owner, analyst, and viewer roles. Real authentication and SSO are intentionally outside OSS scope.',
    '',
  ].join('\n');
}

function collectBlockCandidates(projectRoot: string): BlockCandidate[] {
  const blocks: BlockCandidate[] = [];
  const seen = new Set<string>();
  const scanDir = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSyncSafe(dir)) {
      const filePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(filePath);
      } else if (entry.isFile() && entry.name.endsWith('.dql') && !seen.has(filePath)) {
        try {
          seen.add(filePath);
          const source = readFileSync(filePath, 'utf-8');
          const stat = statSyncSafe(filePath);
          const name = matchString(source, /block\s+"([^"]+)"/) ?? entry.name.replace(/\.dql$/, '');
          const tags = matchArray(source, /tags\s*=\s*\[([^\]]*)\]/);
          blocks.push({
            id: name,
            name,
            domain: matchString(source, /domain\s*=\s*"([^"]+)"/) ?? 'uncategorized',
            status: matchString(source, /status\s*=\s*"([^"]+)"/) ?? 'draft',
            owner: matchString(source, /owner\s*=\s*"([^"]+)"/),
            tags,
            path: relative(projectRoot, filePath).replaceAll('\\', '/'),
            lastModified: stat?.mtime.toISOString() ?? new Date(0).toISOString(),
            description: matchString(source, /description\s*=\s*"((?:[^"\\]|\\.)*)"/) ?? '',
            llmContext: matchString(source, /llmContext\s*=\s*"((?:[^"\\]|\\.)*)"/),
            chartType: matchString(source, /chart\s*=\s*"([^"]+)"/) ?? matchString(source, /chart\.(\w+)\s*\(/) ?? undefined,
            score: 0,
            reasons: [],
          });
        } catch {
          // skip unreadable block
        }
      }
    }
  };
  scanDir(join(projectRoot, 'blocks'));
  scanDir(join(projectRoot, 'domains'));
  return blocks;
}

function readdirSyncSafe(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function statSyncSafe(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function matchString(source: string, regex: RegExp): string | null {
  const match = regex.exec(source);
  return match?.[1]?.replace(/\\"/g, '"').trim() || null;
}

function matchArray(source: string, regex: RegExp): string[] {
  const match = regex.exec(source);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((item) => item.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function normalizeConversationMessages(messages: AppConversationMessageRequest[] | undefined): Array<{
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  events?: unknown[];
  createdAt?: string;
}> {
  return (messages ?? [])
    .map((message) => ({
      id: cleanString(message.id) || undefined,
      role: message.role === 'assistant' ? 'assistant' as const : 'user' as const,
      content: cleanString(message.content),
      events: Array.isArray(message.events) ? message.events : [],
      createdAt: cleanString(message.createdAt) || undefined,
    }))
    .filter((message) => message.content.length > 0);
}

async function runAppInvestigation(
  ctx: Ctx,
  storage: LocalAppStorage,
  investigation: LocalAppInvestigation,
  input: AppInvestigationRunRequest | AppInvestigationCreateRequest = {},
): Promise<LocalAppInvestigation> {
  const question = cleanString(input.question) || investigation.question;
  const context = input.context === undefined ? investigation.context : input.context;
  const intent = normalizeInvestigationIntent(input.intent, question, context);
  let generatedSql = cleanString(input.generatedSql) || investigation.generatedSql;
  const lastRunAt = new Date().toISOString();
  storage.updateAppInvestigation(investigation.id, {
    question,
    intent,
    context,
    generatedSql,
    status: 'running',
    reviewStatus: 'needs_review',
    error: '',
  });

  try {
    const selected = selectedBlockContext(context);
    const appInfo = ctx.path.includes('/api/apps/') ? loadAppById(ctx.projectRoot, investigation.appId) : null;
    const previews = buildContextPreviews(selected);
    let metricSnapshot = buildMetricSnapshot(selected);
    let driverCards = buildDriverCards(selected, intent);
    const baselineGap = intent === 'diagnose_change' && hasSelectedRows(selected) && !hasComparableTimeBaseline(selected);
    const sourceTileId = investigation.sourceTileId ?? selectedContextString(context, 'tileId');
    const sourceBlockId = investigation.sourceBlockId ?? selectedContextString(context, 'blockId');
    const deterministicGeneration = generatedSql || baselineGap
      ? undefined
      : buildDeterministicInvestigationSql(ctx.projectRoot, {
          question,
          intent,
          selected,
          sourceBlockId,
        });
    generatedSql = generatedSql || deterministicGeneration?.sql;
    const agentGeneration = generatedSql || baselineGap
      ? undefined
      : await generateInvestigationSql(ctx, {
          appId: investigation.appId,
          dashboardId: investigation.dashboardId ?? selectedString(context, 'dashboardId'),
          sourceTileId,
          sourceBlockId,
          title: investigation.title,
          question,
          intent,
          context,
        });
    generatedSql = generatedSql || cleanString(agentGeneration?.sql);
    const generationError = cleanString(agentGeneration?.executionError);
    const sqlEvidence = agentGeneration?.result
      ? { preview: buildGeneratedSqlPreview(agentGeneration.result, generatedSql), error: generationError || undefined }
      : await runGeneratedSqlPreview(ctx, generatedSql);
    const sqlError = sqlEvidence.error ?? generationError;
    if (sqlEvidence.preview) {
      previews.unshift(sqlEvidence.preview);
      metricSnapshot = buildPreviewMetricSnapshot(sqlEvidence.preview, selectedString(selected, 'title'));
      driverCards = buildPreviewDriverCards(sqlEvidence.preview, intent);
    }
    const evidence = {
      trustStatus: buildInvestigationTrust(investigation, selected, sqlError),
      planner: {
        intent,
        steps: investigationSteps(intent),
        reviewRequired: true,
        generatedSql: generatedSql || undefined,
        sqlExecuted: Boolean(sqlEvidence.preview),
        sqlError,
        generationSource: baselineGap ? 'missing_baseline' : deterministicGeneration ? 'selected_block_metadata' : agentGeneration?.providerUsed ? 'ai_provider' : generatedSql ? 'provided_sql' : 'context_only',
        baselineGap,
        sourceBlockPath: deterministicGeneration?.sourceBlockPath,
        sourceBlockName: deterministicGeneration?.sourceBlockName,
        providerUsed: agentGeneration?.providerUsed,
      },
      certifiedContext: {
        appId: investigation.appId,
        appName: appInfo?.app.name,
        dashboardId: investigation.dashboardId,
        dashboardTitle: selectedString(context, 'dashboardTitle'),
        sourceTileId,
        sourceBlockId,
        sourceBlockPath: deterministicGeneration?.sourceBlockPath ?? selectedString(selected, 'blockPath'),
        certificationStatus: selectedString(selected, 'certificationStatus'),
      },
      assumptions: [
        ...investigationAssumptions(intent, selected, generatedSql, sqlError),
        ...(baselineGap ? ['The selected tile sample does not include at least two comparable time values, so DQL did not invent a change query from an unrelated table.'] : []),
      ],
      context,
      agentEvidence: agentGeneration?.evidence,
      analysisPlan: agentGeneration?.analysisPlan,
      citations: agentGeneration?.citations,
    };
    const summary = cleanString(agentGeneration?.answer) || (baselineGap
      ? buildMissingBaselineSummary(question, selected)
      : buildInvestigationSummary(intent, question, selected, metricSnapshot, driverCards));
    const recommendation = baselineGap
      ? buildMissingBaselineRecommendation(selected)
      : buildInvestigationRecommendation(intent, selected, sqlError);
    return storage.updateAppInvestigation(investigation.id, {
      title: cleanString(input.question) ? titleFromInvestigation(question, selected) : investigation.title,
      question,
      intent,
      context,
      status: sqlEvidence.fatal ? 'error' : 'ready',
      summary,
      recommendation,
      metrics: metricSnapshot,
      driverCards,
      resultPreviews: previews,
      evidence,
      generatedSql,
      reviewStatus: 'needs_review',
      error: sqlError ?? '',
      lastRunAt,
    }) ?? investigation;
  } catch (err) {
    return storage.updateAppInvestigation(investigation.id, {
      status: 'error',
      reviewStatus: 'needs_review',
      error: err instanceof Error ? err.message : String(err),
      lastRunAt,
    }) ?? investigation;
  }
}

function normalizeInvestigationIntent(
  value: unknown,
  question: string,
  context: unknown,
): LocalAppInvestigationIntent {
  if (
    value === 'diagnose_change'
    || value === 'driver_breakdown'
    || value === 'segment_compare'
    || value === 'entity_drilldown'
    || value === 'anomaly_investigation'
    || value === 'trust_gap_review'
  ) return value;
  const text = `${question} ${JSON.stringify(safeIntentContext(context)).slice(0, 500)}`.toLowerCase();
  if (/\b(trust|rely|certif|lineage|owner|caveat|gap)\b/.test(text)) return 'trust_gap_review';
  if (/\b(anomal|exception|outlier|spike|dip)\b/.test(text)) return 'anomaly_investigation';
  if (/\b(compare|versus| vs |segment|cohort)\b/.test(text)) return 'segment_compare';
  if (/\b(why|changed|change|drop|decline|increase|decrease|february|month|week|quarter)\b/.test(text)) return 'diagnose_change';
  if (/\b(driver|drove|break down|breakdown|contribute|top mover|movers)\b/.test(text)) return 'driver_breakdown';
  if (/\b(customer|account|user|client|merchant|product|sku|alice|johnson)\b/.test(text)) return 'entity_drilldown';
  return 'driver_breakdown';
}

function safeIntentContext(context: unknown): Record<string, unknown> {
  const root = asRecord(context);
  return {
    selectedBlock: root ? root.selectedBlock ?? root.focusBlock : undefined,
    dashboardTitle: root ? root.dashboardTitle : undefined,
    availableBlocks: root ? root.availableBlocks : undefined,
  };
}

function selectedBlockContext(context: unknown): Record<string, unknown> | null {
  const root = asRecord(context);
  const selected = asRecord(root?.selectedBlock) ?? asRecord(root?.focusBlock);
  if (selected) return selected;
  if (!root) return null;
  const hasSelectedTileContext = ['blockId', 'blockPath', 'tileId', 'certificationStatus', 'resultSample', 'rowCount']
    .some((key) => root[key] !== undefined && root[key] !== null);
  return hasSelectedTileContext ? root : null;
}

function selectedContextString(context: unknown, key: string): string | undefined {
  return selectedString(selectedBlockContext(context), key);
}

function selectedString(context: unknown, key: string): string | undefined {
  const record = asRecord(context);
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function buildContextPreviews(selected: Record<string, unknown> | null): unknown[] {
  const rows = selectedRows(selected);
  if (rows.length === 0) return [];
  const columns = selectedColumns(selected, rows);
  return [{
    id: 'selected-tile-sample',
    title: 'Selected tile evidence',
    kind: 'table',
    reviewRequired: true,
    result: {
      columns,
      rows,
      rowCount: typeof selected?.rowCount === 'number' ? selected.rowCount : rows.length,
    },
  }];
}

function buildMetricSnapshot(selected: Record<string, unknown> | null): Record<string, unknown> {
  const rows = selectedRows(selected);
  const columns = selectedColumns(selected, rows);
  const numericColumns = columns.filter((column) => rows.some((row) => typeofNumber(row[column]) !== null));
  const metricColumn = numericColumns[0];
  if (!metricColumn || rows.length === 0) {
    return {
      currentValue: undefined,
      baselineValue: undefined,
      delta: undefined,
      context: 'Metric values were not available in the selected tile sample.',
    };
  }
  const baselineValue = typeofNumber(rows[0]?.[metricColumn]);
  const currentValue = typeofNumber(rows[rows.length - 1]?.[metricColumn]) ?? baselineValue;
  const delta = currentValue !== null && baselineValue !== null ? currentValue - baselineValue : undefined;
  return {
    metric: metricColumn,
    currentValue,
    baselineValue,
    delta,
    rowsReviewed: rows.length,
    context: selectedString(selected, 'title') ?? 'Selected dashboard tile',
  };
}

function hasSelectedRows(selected: Record<string, unknown> | null): boolean {
  return selectedRows(selected).length > 0;
}

function hasComparableTimeBaseline(selected: Record<string, unknown> | null): boolean {
  const rows = selectedRows(selected);
  if (rows.length < 2) return false;
  const columns = selectedColumns(selected, rows);
  const profile = profileResultColumns(columns, rows);
  const timeDimension = chooseTimeDimension(profile);
  if (!timeDimension) return false;
  const values = new Set(
    rows
      .map((row) => row[timeDimension.name])
      .filter((value) => value !== null && value !== undefined && String(value).trim())
      .map((value) => String(value)),
  );
  return values.size >= 2;
}

function buildDriverCards(
  selected: Record<string, unknown> | null,
  intent: LocalAppInvestigationIntent,
): Array<Record<string, unknown>> {
  const rows = selectedRows(selected);
  const columns = selectedColumns(selected, rows);
  if (rows.length === 0) {
    return [{
      title: 'Runtime context needed',
      contribution: 'Needs SQL preview',
      explanation: 'The selected tile did not include sample rows, so DQL captured the question and review path for a deeper SQL run.',
      intent,
    }];
  }
  const numericColumn = columns.find((column) => rows.some((row) => typeofNumber(row[column]) !== null));
  const dimensionColumn = columns.find((column) => column !== numericColumn && rows.some((row) => typeof row[column] === 'string'));
  if (!numericColumn) {
    return rows.slice(0, 5).map((row, index) => ({
      title: String(row[dimensionColumn ?? columns[0]] ?? `Row ${index + 1}`),
      contribution: 'Context row',
      explanation: 'This row is part of the tile evidence for the investigation.',
    }));
  }
  return rows
    .map((row, index) => {
      const value = typeofNumber(row[numericColumn]) ?? 0;
      const label = String(row[dimensionColumn ?? columns[0]] ?? `Row ${index + 1}`);
      return {
        title: label,
        value,
        contribution: formatContribution(value),
        explanation: `${label} is one of the highest-signal rows in the selected tile sample for ${numericColumn}.`,
        evidenceLabel: numericColumn,
      };
    })
    .sort((a, b) => Math.abs(Number(b.value ?? 0)) - Math.abs(Number(a.value ?? 0)))
    .slice(0, 5);
}

function buildPreviewMetricSnapshot(preview: Record<string, unknown>, fallbackTitle?: string): Record<string, unknown> {
  const rows = previewResultRows(preview);
  const columns = previewResultColumns(preview, rows);
  const numericColumns = columns.filter((column) => rows.some((row) => typeofNumber(row[column]) !== null));
  if (rows.length === 0 || numericColumns.length === 0) {
    return {
      currentValue: undefined,
      baselineValue: undefined,
      delta: undefined,
      context: 'Generated SQL preview did not return numeric metric rows.',
    };
  }
  const currentColumn = pickColumn(numericColumns, [/^current_/i, /current.*(revenue|value|amount|total|orders?)/i])
    ?? pickColumn(numericColumns, [/^total_/i, /(revenue|value|amount|total|orders?|points?|goals?|assists?|rebounds?|score|games_played)$/i])
    ?? pickColumn(numericColumns, [/(count|row_count)$/i])
    ?? numericColumns[0];
  const baselineColumn = pickColumn(numericColumns, [/^baseline_/i, /baseline.*(revenue|value|amount|total|orders?)/i]);
  const deltaColumn = pickColumn(numericColumns, [/(delta|change|variance|diff|contribution)/i]);
  const currentValue = sumNumericRows(rows, currentColumn);
  const baselineValue = baselineColumn ? sumNumericRows(rows, baselineColumn) : typeofNumber(rows[0]?.[currentColumn]);
  const delta = deltaColumn
    ? sumNumericRows(rows, deltaColumn)
    : currentValue !== null && baselineValue !== null
      ? currentValue - baselineValue
      : undefined;
  return {
    metric: deltaColumn ?? currentColumn,
    currentValue,
    baselineValue,
    delta,
    rowsReviewed: rows.length,
    context: fallbackTitle ?? selectedString(preview, 'title') ?? 'Generated SQL preview',
  };
}

function buildPreviewDriverCards(
  preview: Record<string, unknown>,
  intent: LocalAppInvestigationIntent,
): Array<Record<string, unknown>> {
  const rows = previewResultRows(preview);
  const columns = previewResultColumns(preview, rows);
  if (rows.length === 0) {
    return buildDriverCards(null, intent);
  }
  const numericColumns = columns.filter((column) => rows.some((row) => typeofNumber(row[column]) !== null));
  const contributionColumn = pickColumn(numericColumns, [/(delta|change|variance|diff|contribution)/i])
    ?? pickColumn(numericColumns, [/^current_/i, /^total_/i, /(revenue|value|amount|total|orders?|points?|goals?|assists?|rebounds?|score|games_played)$/i])
    ?? pickColumn(numericColumns, [/(count|row_count)$/i])
    ?? numericColumns[0];
  const dimensionColumn = columns.find((column) => column !== contributionColumn && rows.some((row) => typeof row[column] === 'string'));
  if (!contributionColumn) {
    return rows.slice(0, 5).map((row, index) => ({
      title: String(row[dimensionColumn ?? columns[0]] ?? `Row ${index + 1}`),
      contribution: 'Preview row',
      explanation: 'This row came from the generated SQL preview and needs analyst review.',
      intent,
    }));
  }
  return rows
    .map((row, index) => {
      const value = typeofNumber(row[contributionColumn]) ?? 0;
      const label = String(row[dimensionColumn ?? columns[0]] ?? `Row ${index + 1}`);
      return {
        title: label,
        value,
        contribution: formatContribution(value),
        explanation: `${label} is ranked by ${contributionColumn} from the generated SQL preview.`,
        evidenceLabel: contributionColumn,
        reviewRequired: true,
        intent,
      };
    })
    .sort((a, b) => Math.abs(Number(b.value ?? 0)) - Math.abs(Number(a.value ?? 0)))
    .slice(0, 5);
}

function previewResultRows(preview: Record<string, unknown>): Array<Record<string, unknown>> {
  const result = asRecord(preview.result);
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  return rows.map(asRecord).filter((row): row is Record<string, unknown> => Boolean(row)).slice(0, 100);
}

function previewResultColumns(preview: Record<string, unknown>, rows: Array<Record<string, unknown>>): string[] {
  const result = asRecord(preview.result);
  const columns = Array.isArray(result?.columns) ? result.columns.map(String).filter(Boolean) : [];
  return columns.length > 0 ? columns.slice(0, 20) : Object.keys(rows[0] ?? {}).slice(0, 20);
}

function pickColumn(columns: string[], patterns: RegExp[]): string | undefined {
  return columns.find((column) => patterns.some((pattern) => pattern.test(column)));
}

function sumNumericRows(rows: Array<Record<string, unknown>>, column: string): number | null {
  let total = 0;
  let found = false;
  for (const row of rows) {
    const value = typeofNumber(row[column]);
    if (value === null) continue;
    total += value;
    found = true;
  }
  return found ? total : null;
}

function buildDeterministicInvestigationSql(
  projectRoot: string,
  input: {
    question: string;
    intent: LocalAppInvestigationIntent;
    selected: Record<string, unknown> | null;
    sourceBlockId?: string;
  },
): { sql: string; sourceBlockPath: string; sourceBlockName: string } | undefined {
  if (input.intent === 'trust_gap_review') return undefined;
  const block = resolveSelectedBlock(projectRoot, input.selected, input.sourceBlockId);
  if (!block) return undefined;
  const source = readFileSync(join(projectRoot, block.path), 'utf-8');
  const blockSql = extractDqlQuery(source);
  if (!blockSql || /\{\{/.test(blockSql) || !isReadOnlySql(blockSql)) return undefined;
  const rows = selectedRows(input.selected);
  const columns = selectedColumns(input.selected, rows);
  const sourceSql = stripTopLevelOrderAndLimit(blockSql);
  const profile = profileResultColumns(columns, rows);
  const measure = chooseMeasureColumn(profile);
  if (!measure) return undefined;
  const dimension = chooseDimensionColumn(input.question, profile, input.intent);
  const sourceCte = `WITH dql_source AS (\n${sourceSql}\n)`;

  if (input.intent === 'entity_drilldown') {
    const entity = inferEntityFilter(input.question, profile, rows);
    const orderBy = `ORDER BY ${quoteSqlIdentifier(measure.name)} DESC`;
    const where = entity ? `\nWHERE ${quoteSqlIdentifier(entity.column)} IS NOT NULL AND LOWER(CAST(${quoteSqlIdentifier(entity.column)} AS VARCHAR)) LIKE ${sqlStringLiteral(`%${entity.value.toLowerCase()}%`)}` : '';
    return {
      sql: `${sourceCte}\nSELECT *\nFROM dql_source${where}\n${orderBy}\nLIMIT 100`,
      sourceBlockPath: block.path,
      sourceBlockName: block.name,
    };
  }

  if (input.intent === 'anomaly_investigation' || input.intent === 'diagnose_change') {
    const timeDimension = chooseTimeDimension(profile) ?? dimension;
    const rankExpr = `${measureAgg(measure)}(${quoteSqlIdentifier(measure.name)})`;
    if (timeDimension) {
      return {
        sql: [
          sourceCte,
          ', dql_trend AS (',
          `  SELECT ${quoteSqlIdentifier(timeDimension.name)} AS ${quoteSqlIdentifier(timeDimension.name)}, ${rankExpr} AS ${quoteSqlIdentifier(measure.name)}`,
          '  FROM dql_source',
          `  GROUP BY ${quoteSqlIdentifier(timeDimension.name)}`,
          '), dql_deltas AS (',
          `  SELECT ${quoteSqlIdentifier(timeDimension.name)}, ${quoteSqlIdentifier(measure.name)}, LAG(${quoteSqlIdentifier(measure.name)}) OVER (ORDER BY ${quoteSqlIdentifier(timeDimension.name)}) AS baseline_${safeAlias(measure.name)}`,
          '  FROM dql_trend',
          ')',
          `SELECT *, ${quoteSqlIdentifier(measure.name)} - baseline_${safeAlias(measure.name)} AS delta_${safeAlias(measure.name)}`,
          'FROM dql_deltas',
          `ORDER BY ABS(COALESCE(delta_${safeAlias(measure.name)}, 0)) DESC`,
          'LIMIT 20',
        ].join('\n'),
        sourceBlockPath: block.path,
        sourceBlockName: block.name,
      };
    }
  }

  if (!dimension) return undefined;
  const aggregate = `${measureAgg(measure)}(${quoteSqlIdentifier(measure.name)})`;
  const label = quoteSqlIdentifier(dimension.name);
  return {
    sql: [
      sourceCte,
      `SELECT ${label} AS ${label}, ${aggregate} AS ${quoteSqlIdentifier(measure.name)}, COUNT(*) AS ${quoteSqlIdentifier('row_count')}`,
      'FROM dql_source',
      `GROUP BY ${label}`,
      `ORDER BY ABS(COALESCE(${quoteSqlIdentifier(measure.name)}, 0)) DESC`,
      'LIMIT 20',
    ].join('\n'),
    sourceBlockPath: block.path,
    sourceBlockName: block.name,
  };
}

function resolveSelectedBlock(
  projectRoot: string,
  selected: Record<string, unknown> | null,
  sourceBlockId?: string,
): BlockCandidate | undefined {
  const selectedPath = selectedString(selected, 'blockPath');
  const candidates = collectBlockCandidates(projectRoot);
  if (selectedPath) {
    const normalizedPath = selectedPath.replace(/^\/+/, '');
    const found = candidates.find((block) => block.path === normalizedPath);
    if (found) return found;
    if (normalizedPath.startsWith('blocks/') && existsSync(join(projectRoot, normalizedPath))) {
      const source = readFileSync(join(projectRoot, normalizedPath), 'utf-8');
      const name = matchString(source, /block\s+"([^"]+)"/) ?? titleFromPath(normalizedPath);
      return {
        id: name,
        name,
        domain: matchString(source, /domain\s*=\s*"([^"]+)"/) ?? 'uncategorized',
        status: matchString(source, /status\s*=\s*"([^"]+)"/) ?? 'draft',
        owner: matchString(source, /owner\s*=\s*"([^"]+)"/),
        tags: matchArray(source, /tags\s*=\s*\[([^\]]*)\]/),
        path: normalizedPath,
        lastModified: statSyncSafe(join(projectRoot, normalizedPath))?.mtime.toISOString() ?? new Date(0).toISOString(),
        description: matchString(source, /description\s*=\s*"((?:[^"\\]|\\.)*)"/) ?? '',
        llmContext: matchString(source, /llmContext\s*=\s*"((?:[^"\\]|\\.)*)"/),
        chartType: matchString(source, /chart\s*=\s*"([^"]+)"/) ?? undefined,
        score: 0,
        reasons: [],
      };
    }
  }
  const id = cleanString(sourceBlockId) || selectedString(selected, 'blockId');
  if (!id) return undefined;
  return candidates.find((block) => block.id === id || block.name === id || block.path === id);
}

type ResultColumnProfile = {
  name: string;
  lower: string;
  numeric: boolean;
  text: boolean;
  dimension: boolean;
  measure: boolean;
  time: boolean;
};

function profileResultColumns(columns: string[], rows: Array<Record<string, unknown>>): ResultColumnProfile[] {
  return columns.map((name) => {
    const lower = name.toLowerCase();
    const numeric = rows.length === 0 ? !isLikelyTextColumn(lower) : rows.some((row) => typeofNumber(row[name]) !== null);
    const text = rows.some((row) => typeof row[name] === 'string' && String(row[name]).trim().length > 0);
    const time = /\b(season|year|month|week|quarter|date|day)\b/i.test(lower);
    const identifier = /\b(id|key|uuid|number)\b/i.test(lower) && !time;
    const measureName = /\b(total|sum|amount|revenue|sales|points?|goals?|assists?|rebounds?|count|avg|average|rate|pct|percent|score|value|delta|change|variance)\b/i.test(lower);
    const dimensionName = /\b(name|type|segment|region|market|category|status|player|customer|account|team|season|year|month|week|quarter|date)\b/i.test(lower);
    const measure = numeric && measureName && !identifier && !time;
    const dimension = !measure && (text || time || dimensionName || !numeric);
    return { name, lower, numeric, text, dimension, measure, time };
  });
}

function chooseMeasureColumn(columns: ResultColumnProfile[]): ResultColumnProfile | undefined {
  const candidates = columns.filter((column) => column.measure);
  return candidates.find((column) => /\b(delta|change|variance|contribution)\b/i.test(column.lower))
    ?? candidates.find((column) => /\b(total_points|total_revenue|total_amount|total|revenue|amount|sales|points|goals)\b/i.test(column.lower))
    ?? candidates.find((column) => /\b(count|value|score|avg|average|rate|pct|percent)\b/i.test(column.lower))
    ?? columns.find((column) => column.numeric && !column.dimension);
}

function chooseDimensionColumn(
  question: string,
  columns: ResultColumnProfile[],
  intent: LocalAppInvestigationIntent,
): ResultColumnProfile | undefined {
  const dimensions = columns.filter((column) => column.dimension);
  const questionTokens = new Set(question.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const mentioned = dimensions.find((column) => column.lower.split(/[^a-z0-9]+/).some((token) => questionTokens.has(token)));
  if (mentioned) return mentioned;
  const timeDimension = chooseTimeDimension(columns);
  if ((intent === 'diagnose_change' || intent === 'segment_compare' || intent === 'anomaly_investigation') && timeDimension) return timeDimension;
  return dimensions.find((column) => column.text && !column.time)
    ?? timeDimension
    ?? dimensions[0];
}

function chooseTimeDimension(columns: ResultColumnProfile[]): ResultColumnProfile | undefined {
  return columns.find((column) => column.time);
}

function inferEntityFilter(
  question: string,
  columns: ResultColumnProfile[],
  rows: Array<Record<string, unknown>>,
): { column: string; value: string } | undefined {
  const textDimensions = columns.filter((column) => column.dimension && (column.text || /\b(name|player|customer|account|team)\b/i.test(column.lower)));
  const lowerQuestion = question.toLowerCase();
  for (const column of textDimensions) {
    for (const row of rows) {
      const value = cleanString(row[column.name]);
      if (value && lowerQuestion.includes(value.toLowerCase())) return { column: column.name, value };
    }
  }
  const named = question.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/);
  const value = named?.[1]?.trim();
  const column = textDimensions[0];
  return value && column ? { column: column.name, value } : undefined;
}

function measureAgg(column: ResultColumnProfile): 'AVG' | 'SUM' {
  return /\b(avg|average|rate|pct|percent|per_)\b/i.test(column.lower) ? 'AVG' : 'SUM';
}

function extractDqlQuery(source: string): string | null {
  const tripleQuoteMatch = source.match(/query\s*=\s*"""([\s\S]*?)"""/i);
  if (tripleQuoteMatch) return tripleQuoteMatch[1].trim() || null;
  const singleQuoteMatch = source.match(/query\s*=\s*"((?:[^"\\]|\\.)*)"/i);
  if (singleQuoteMatch) return singleQuoteMatch[1].replace(/\\"/g, '"').trim() || null;
  return null;
}

function stripTopLevelOrderAndLimit(sql: string): string {
  let next = sql.trim().replace(/;+\s*$/g, '');
  const limitIndex = findLastTopLevelKeyword(next, 'limit');
  if (limitIndex >= 0 && /^\s+limit\s+\d+\s*$/i.test(next.slice(limitIndex))) {
    next = next.slice(0, limitIndex).trim();
  }
  const orderIndex = findLastTopLevelKeyword(next, 'order by');
  if (orderIndex >= 0) next = next.slice(0, orderIndex).trim();
  return next;
}

function findLastTopLevelKeyword(sql: string, keyword: string): number {
  const lower = sql.toLowerCase();
  const target = keyword.toLowerCase();
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let last = -1;
  for (let i = 0; i < lower.length; i += 1) {
    const char = lower[i];
    if (quote) {
      if (char === quote && lower[i - 1] !== '\\') quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && lower.startsWith(target, i) && isKeywordBoundary(lower, i - 1) && isKeywordBoundary(lower, i + target.length)) {
      last = i;
    }
  }
  return last;
}

function isKeywordBoundary(value: string, index: number): boolean {
  if (index < 0 || index >= value.length) return true;
  return /[^a-z0-9_]/i.test(value[index]);
}

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function safeAlias(identifier: string): string {
  return identifier.replace(/[^a-z0-9_]+/gi, '_').replace(/^_+|_+$/g, '') || 'value';
}

function isLikelyTextColumn(value: string): boolean {
  return /\b(name|type|segment|region|market|category|status|player|customer|account|team)\b/i.test(value);
}

async function generateInvestigationSql(
  ctx: Ctx,
  input: AppInvestigationGenerationRequest,
): Promise<AppInvestigationGenerationResult | undefined> {
  if (!ctx.generateInvestigationSql) return undefined;
  try {
    return await ctx.generateInvestigationSql(input);
  } catch (err) {
    return {
      executionError: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runGeneratedSqlPreview(
  ctx: Ctx,
  generatedSql?: string,
): Promise<{ preview?: Record<string, unknown>; error?: string; fatal?: boolean }> {
  const sql = cleanString(generatedSql);
  if (!sql) return {};
  if (!isReadOnlySql(sql)) {
    return {
      error: 'Generated SQL was not run because it was not a read-only SELECT or WITH query.',
      fatal: true,
    };
  }
  if (!ctx.executeSql) {
    return {
      error: 'This host cannot execute investigation SQL.',
      fatal: false,
    };
  }
  try {
    const result = await ctx.executeSql(boundedPreviewSql(sql));
    return {
      preview: {
        id: 'generated-sql-preview',
        title: 'Generated SQL preview',
        kind: 'table',
        reviewRequired: true,
        result,
      },
    };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
      fatal: true,
    };
  }
}

function buildGeneratedSqlPreview(result: unknown, generatedSql?: string): Record<string, unknown> {
  const record = asRecord(result);
  const rawRows = Array.isArray(record?.rows) ? record.rows : [];
  const rows = rawRows.map(asRecord).filter((row): row is Record<string, unknown> => Boolean(row)).slice(0, 100);
  const rawColumns = Array.isArray(record?.columns) ? record.columns : [];
  const columns = rawColumns.length
    ? rawColumns.map((column) => {
        const columnRecord = asRecord(column);
        return typeof column === 'string'
          ? column
          : typeof columnRecord?.name === 'string'
            ? columnRecord.name
            : String(column);
      })
    : Object.keys(rows[0] ?? {});
  return {
    id: 'generated-sql-preview',
    title: 'Generated SQL preview',
    kind: 'table',
    reviewRequired: true,
    sql: generatedSql,
    result: {
      columns,
      rows,
      rowCount: typeof record?.rowCount === 'number' ? record.rowCount : rows.length,
      executionTime: typeof record?.executionTime === 'number' ? record.executionTime : undefined,
    },
  };
}

function isReadOnlySql(sql: string): boolean {
  const trimmed = stripLeadingSqlComments(sql).replace(/;+\s*$/g, '');
  if (!/^(select|with)\b/i.test(trimmed)) return false;
  if (/;\s*\S/.test(trimmed)) return false;
  return !/\b(insert|update|delete|merge|drop|alter|create|truncate|copy|grant|revoke|call|execute|attach|detach)\b/i.test(trimmed);
}

function stripLeadingSqlComments(sql: string): string {
  let next = sql.trim();
  while (next.startsWith('--') || next.startsWith('/*')) {
    if (next.startsWith('--')) {
      const lineEnd = next.indexOf('\n');
      next = lineEnd >= 0 ? next.slice(lineEnd + 1).trimStart() : '';
      continue;
    }
    const blockEnd = next.indexOf('*/');
    next = blockEnd >= 0 ? next.slice(blockEnd + 2).trimStart() : '';
  }
  return next;
}

function boundedPreviewSql(sql: string): string {
  return `SELECT * FROM (${sql.trim().replace(/;+\s*$/g, '')}) AS dql_research_preview LIMIT 100`;
}

function buildInvestigationTrust(
  investigation: LocalAppInvestigation,
  selected: Record<string, unknown> | null,
  sqlError?: string,
): Record<string, unknown> {
  return {
    label: 'AI-generated research',
    uncertified: true,
    reviewStatus: 'needs_review',
    certifiedContext: selectedString(selected, 'certificationStatus') === 'certified' ? 'selected tile is certified' : 'selected tile certification needs review',
    sourceBlockId: investigation.sourceBlockId ?? selectedString(selected, 'blockId'),
    sourceTileId: investigation.sourceTileId ?? selectedString(selected, 'tileId'),
    caveats: [
      'Investigation output is not certified until a reviewer promotes or certifies the generated block.',
      ...(sqlError ? [`SQL preview caveat: ${sqlError}`] : []),
    ],
  };
}

function investigationSteps(intent: LocalAppInvestigationIntent): string[] {
  const common = ['trust check', 'evidence capture'];
  if (intent === 'trust_gap_review') return ['certification review', 'lineage review', 'owner and caveat check', ...common];
  if (intent === 'entity_drilldown') return ['entity value match', 'metric trend', 'exception rows', ...common];
  if (intent === 'segment_compare') return ['segment grouping', 'baseline comparison', 'top movers', ...common];
  if (intent === 'anomaly_investigation') return ['baseline comparison', 'trend check', 'exception rows', 'top movers', ...common];
  if (intent === 'diagnose_change') return ['baseline comparison', 'trend check', 'top movers', 'segment contribution', ...common];
  return ['top movers', 'segment contribution', 'exception rows', ...common];
}

function investigationAssumptions(
  intent: LocalAppInvestigationIntent,
  selected: Record<string, unknown> | null,
  generatedSql?: string,
  sqlError?: string,
): string[] {
  return [
    `Intent classified as ${intent}.`,
    selected ? 'The selected dashboard tile is the starting context.' : 'No selected tile context was provided.',
    generatedSql ? 'A generated SQL preview was requested and bounded to 100 rows.' : 'No generated SQL was supplied, so the first pass used dashboard result samples and metadata.',
    sqlError ? `SQL preview needs review: ${sqlError}` : 'The result remains uncertified until reviewed.',
  ];
}

function buildInvestigationSummary(
  intent: LocalAppInvestigationIntent,
  question: string,
  selected: Record<string, unknown> | null,
  metrics: Record<string, unknown>,
  drivers: Array<Record<string, unknown>>,
): string {
  const target = selectedString(selected, 'title') ?? 'this dashboard question';
  const delta = typeof metrics.delta === 'number' ? ` Delta from the sampled baseline is ${formatContribution(metrics.delta)}.` : '';
  if (intent === 'trust_gap_review') {
    return `This tile can be used as certified context only where its source block and lineage are certified. The deeper answer is AI-generated research and needs review before leaders rely on it.${delta}`;
  }
  const driver = drivers[0]?.title ? ` Top visible driver in the current evidence is ${drivers[0].title}.` : '';
  return `DQL opened a review-required investigation for ${target}: ${question}.${delta}${driver}`;
}

function buildMissingBaselineSummary(
  question: string,
  selected: Record<string, unknown> | null,
): string {
  const target = selectedString(selected, 'title') ?? 'the selected tile';
  return `DQL opened a review-required investigation for ${target}: ${question}. The selected tile shows the current certified result, but its sample does not include a comparable prior period or historical snapshot, so DQL cannot calculate what changed without guessing.`;
}

function buildMissingBaselineRecommendation(selected: Record<string, unknown> | null): string {
  const target = selectedString(selected, 'title') ?? 'this tile';
  return `Use ${target} as current-state evidence. To explain change, add or select a block with a time grain, snapshot date, or prior-period baseline, then rerun the investigation.`;
}

function buildInvestigationRecommendation(
  intent: LocalAppInvestigationIntent,
  selected: Record<string, unknown> | null,
  sqlError?: string,
): string {
  if (sqlError) return 'Review the generated SQL or add a certified drilldown block before promoting this result.';
  if (intent === 'trust_gap_review') return 'Use the certified tile for reporting, and promote only the reviewed gaps into a draft block.';
  if (!selected) return 'Select a dashboard tile or provide SQL so DQL can rank drivers with stronger evidence.';
  return 'Review the driver evidence, then pin the useful answer or promote the SQL path into a draft DQL block.';
}

function investigationPreviewResult(investigation: LocalAppInvestigation): unknown {
  const previews = Array.isArray(investigation.resultPreviews) ? investigation.resultPreviews : [];
  const first = previews.find((preview) => asRecord(preview)?.result);
  return asRecord(first)?.result;
}

function investigationCitations(investigation: LocalAppInvestigation): unknown[] {
  return [{
    kind: 'app_investigation',
    name: investigation.title,
    reviewStatus: investigation.reviewStatus,
    uncertified: true,
    sourceBlockId: investigation.sourceBlockId,
    sourceTileId: investigation.sourceTileId,
  }];
}

function nextResearchFollowUps(investigation: LocalAppInvestigation): string[] {
  const target = investigation.sourceBlockId ?? investigation.sourceTileId ?? 'this result';
  return [
    `Break ${target} down by the strongest segment`,
    `Show exception rows for ${target}`,
    `What would need review before certifying this answer?`,
  ];
}

function titleFromInvestigation(question: string, selected: Record<string, unknown> | null): string {
  const selectedTitle = selectedString(selected, 'title');
  const base = selectedTitle ? `${selectedTitle}: ${question}` : question;
  return base.replace(/\s+/g, ' ').slice(0, 90);
}

function selectedRows(selected: Record<string, unknown> | null): Array<Record<string, unknown>> {
  const rows = Array.isArray(selected?.sampleRows)
    ? selected?.sampleRows
    : Array.isArray(selected?.resultSample)
      ? selected?.resultSample
      : selected?.rows;
  if (!Array.isArray(rows)) return [];
  return rows.map(asRecord).filter((row): row is Record<string, unknown> => Boolean(row)).slice(0, 100);
}

function selectedColumns(selected: Record<string, unknown> | null, rows: Array<Record<string, unknown>>): string[] {
  const columns = selected?.columns;
  if (Array.isArray(columns) && columns.length > 0) {
    return columns.map(String).filter(Boolean).slice(0, 20);
  }
  return Object.keys(rows[0] ?? {}).slice(0, 20);
}

function typeofNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function formatContribution(value: number): string {
  const rounded = Math.abs(value) >= 100 ? Math.round(value).toLocaleString() : Number(value.toFixed(2)).toLocaleString();
  return value >= 0 ? `+${rounded}` : `-${rounded.replace(/^-/, '')}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => cleanString(item))
    .filter(Boolean)
    .slice(0, 24);
  return items.length > 0 ? items : undefined;
}

function normalizeTags(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => cleanString(value)).filter(Boolean)));
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function resolveAppPackageDir(projectRoot: string, domain: string, id: string): string {
  const domainSlug = slugify(domain);
  const domainDir = domainSlug ? join(projectRoot, 'domains', domainSlug) : '';
  if (domainDir && existsSync(domainDir)) {
    return join(domainDir, 'apps', id);
  }
  return join(projectRoot, 'apps', id);
}

function titleFromPath(path: string): string {
  return basename(path)
    .replace(/\.(dqlnb|dql)$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase()) || path;
}

function audienceFromTags(tags: string[]): string | undefined {
  const tag = tags.find((value) => value.startsWith('audience:'));
  if (!tag) return undefined;
  return tag.slice('audience:'.length).replace(/-/g, ' ');
}

function appAllowsExecute(app: AppDocument, domain: string): boolean {
  return (app.policies ?? []).some((policy) => {
    if (policy.enabled === false) return false;
    if (policy.domain !== '*' && policy.domain !== domain) return false;
    return policy.accessLevel === 'execute' || policy.accessLevel === 'admin';
  });
}

export function createDashboardForApp(
  projectRoot: string,
  appId: string,
  input: { id?: string; title?: string; description?: string },
): { ok: true; dashboard: DashboardDocument; path: string } | { ok: false; error: string } {
  const loaded = loadAppById(projectRoot, appId);
  if (!loaded) return { ok: false, error: `App "${appId}" not found` };
  const title = cleanString(input.title) || 'New page';
  const id = slugify(cleanString(input.id) || title) || `page-${Date.now()}`;
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) return { ok: false, error: 'dashboard id must be folder-safe' };
  const appDir = loaded.appDir;
  const dashboardPath = join(appDir, 'dashboards', `${id}.dqld`);
  if (existsSync(dashboardPath)) return { ok: false, error: `Dashboard already exists: ${id}` };
  const dashboard: DashboardDocument = {
    version: 1,
    id,
    metadata: {
      title,
      description: cleanString(input.description) || `${title} dashboard page`,
      domain: loaded.app.domain,
      subdomain: loaded.app.subdomain,
      groups: loaded.app.groups ?? [],
      audience: loaded.app.audience,
      visibility: loaded.app.visibility ?? 'shared',
      lifecycle: loaded.app.lifecycle ?? 'draft',
      tags: loaded.app.tags ?? [],
    },
    layout: {
      kind: 'grid',
      cols: 12,
      rowHeight: 80,
      items: [],
    },
  };
  mkdirSync(dirname(dashboardPath), { recursive: true });
  writeFileSync(dashboardPath, JSON.stringify(dashboard, null, 2) + '\n', 'utf-8');
  return { ok: true, dashboard, path: relative(projectRoot, dashboardPath) };
}

function patchDashboardLayout(
  projectRoot: string,
  appId: string,
  dashboardId: string,
  input: { layout?: DashboardDocument['layout']; items?: DashboardGridItem[] },
): { ok: true; dashboard: DashboardDocument; path: string } | { ok: false; error: string } {
  const loaded = loadDashboardForApp(projectRoot, appId, dashboardId);
  if (!loaded) return { ok: false, error: `Dashboard "${dashboardId}" not found in app "${appId}"` };
  const next: DashboardDocument = {
    ...loaded.dashboard,
    layout: input.layout
      ? input.layout
      : {
          ...loaded.dashboard.layout,
          items: input.items ?? loaded.dashboard.layout.items,
        },
  };
  const written = writeDashboard(projectRoot, appId, dashboardId, next);
  if (!written.ok) return written;
  return { ok: true, dashboard: next, path: relative(projectRoot, written.path) };
}

function createAiPinTile(
  projectRoot: string,
  appId: string,
  input: AiPinCreateRequest,
): { ok: true; pin: unknown; dashboard?: DashboardDocument; tile?: DashboardGridItem } | { ok: false; error: string } {
  const dashboardId = cleanString(input.dashboardId);
  if (!dashboardId) return { ok: false, error: 'dashboardId is required' };
  const loaded = loadDashboardForApp(projectRoot, appId, dashboardId);
  if (!loaded) return { ok: false, error: `Dashboard "${dashboardId}" not found in app "${appId}"` };
  const title = cleanString(input.title) || 'AI result';
  const tileId = cleanString(input.tileId) || nextTileId(loaded.dashboard, slugify(title) || 'ai-pin');
  const storage = new LocalAppStorage(defaultLocalAppsDbPath(projectRoot));
  try {
    const pin = storage.createAiPin({
      appId,
      dashboardId,
      tileId,
      title,
      answer: cleanString(input.answer) || title,
      question: cleanString(input.question) || undefined,
      sql: cleanString(input.sql) || undefined,
      sourceTier: cleanString(input.sourceTier) || undefined,
      certification: input.certification === 'certified' ? 'certified' : 'ai_generated',
      reviewStatus: input.reviewStatus,
      refreshCadence: input.refreshCadence === 'daily' ? 'daily' : 'none',
      chartConfig: input.chartConfig,
      result: input.result,
      citations: Array.isArray(input.citations) ? input.citations : [],
      analysisPlan: input.analysisPlan,
      evidence: input.evidence,
      followUps: Array.isArray(input.followUps) ? input.followUps.filter((item): item is string => typeof item === 'string') : [],
    });
    const tile: DashboardGridItem = {
      i: tileId,
      ...nextTilePosition(loaded.dashboard),
      aiPin: { id: pin.id },
      viz: { type: normalizeVizTypeFromChart(input.chartConfig) },
      title,
    };
    const dashboard: DashboardDocument = {
      ...loaded.dashboard,
      layout: {
        ...loaded.dashboard.layout,
        items: [...loaded.dashboard.layout.items, tile],
      },
    };
    const written = writeDashboard(projectRoot, appId, dashboardId, dashboard);
    if (!written.ok) {
      return { ok: false, error: written.error };
    }
    return { ok: true, pin, dashboard, tile };
  } finally {
    storage.close();
  }
}

function promoteAiPinToDraftBlock(
  projectRoot: string,
  appId: string,
  pinId: string,
): { ok: true; pin: unknown; blockPath: string } | { ok: false; error: string } {
  const loaded = loadAppById(projectRoot, appId);
  if (!loaded) return { ok: false, error: `App "${appId}" not found` };
  const storage = new LocalAppStorage(defaultLocalAppsDbPath(projectRoot));
  try {
    const pin = storage.getAiPin(pinId);
    if (!pin) return { ok: false, error: `AI pin "${pinId}" not found` };
    if (!pin.sql) return { ok: false, error: 'AI pin has no SQL to promote' };
    const blockName = slugify(pin.title) || pin.id;
    const analysisPlan = pin.analysisPlan && typeof pin.analysisPlan === 'object'
      ? pin.analysisPlan as { candidateTables?: Array<{ relation?: string }>; dimensions?: string[]; measures?: string[] }
      : null;
    const sourceContext = [
      pin.question ? `Question: ${pin.question}` : '',
      analysisPlan?.candidateTables?.length
        ? `Candidate tables: ${analysisPlan.candidateTables.map((table) => table.relation).filter(Boolean).join(', ')}`
        : '',
      analysisPlan?.dimensions?.length ? `Dimensions: ${analysisPlan.dimensions.join(', ')}` : '',
      analysisPlan?.measures?.length ? `Measures: ${analysisPlan.measures.join(', ')}` : '',
    ].filter(Boolean).join(' | ');
    const draftDir = join(loaded.appDir, 'drafts');
    const blockPath = join(draftDir, `${blockName}.dql`);
    mkdirSync(draftDir, { recursive: true });
    const source = [
      `block "${blockName}" {`,
      `  domain = "${escapeDqlString(loaded.app.domain)}"`,
      '  type = "custom"',
      '  status = "review"',
      `  owner = "${escapeDqlString(loaded.app.owners[0] ?? `${process.env.USER ?? 'analyst'}@local`)}"`,
      `  description = "${escapeDqlString(pin.answer.slice(0, 240))}"`,
      sourceContext ? `  llmContext = "${escapeDqlString(sourceContext.slice(0, 800))}"` : '',
      pin.question ? `  examples = [{ question = "${escapeDqlString(pin.question)}" }]` : '',
      '  caveats = ["AI-generated draft. Validate joins, filters, grain, and business interpretation before certification."]',
      '  tags = ["ai-generated", "needs-review"]',
      '',
      '  query = """',
      pin.sql,
      '  """',
      '',
      '  visualization {',
      `    chart = "${escapeDqlString(String((pin.chartConfig as { chart?: unknown } | undefined)?.chart ?? 'table'))}"`,
      '  }',
      '}',
      '',
    ].join('\n');
    writeFileSync(blockPath, source, 'utf-8');
    const updated = storage.markAiPinPromoted(pinId, relative(projectRoot, blockPath));
    return { ok: true, pin: updated, blockPath: relative(projectRoot, blockPath) };
  } finally {
    storage.close();
  }
}

function nextTilePosition(dashboard: DashboardDocument): { x: number; y: number; w: number; h: number } {
  const maxY = dashboard.layout.items.reduce((value, item) => Math.max(value, item.y + item.h), 0);
  return { x: 0, y: maxY, w: 6, h: 3 };
}

function nextTileId(dashboard: DashboardDocument, base: string): string {
  const used = new Set(dashboard.layout.items.map((item) => item.i));
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function normalizeVizTypeFromChart(chartConfig: Record<string, unknown> | undefined): DashboardGridItem['viz']['type'] {
  const chart = String(chartConfig?.chart ?? '').toLowerCase().replace(/-/g, '_');
  if (chart === 'single_value' || chart === 'kpi' || chart === 'line' || chart === 'bar' || chart === 'area'
    || chart === 'grouped_bar' || chart === 'stacked_bar' || chart === 'pie' || chart === 'donut'
    || chart === 'scatter' || chart === 'heatmap' || chart === 'histogram' || chart === 'waterfall'
    || chart === 'gauge' || chart === 'pivot' || chart === 'map' || chart === 'funnel') {
    return chart;
  }
  return 'table';
}

function escapeDqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
}

function loadAppById(
  projectRoot: string,
  id: string,
): {
  app: AppDocument;
  appDir: string;
  appPath: string;
  dashboards: Array<{ id: string; title: string; description?: string; itemCount: number }>;
  notebooks: AppListEntry['notebooks'];
  drafts: AppListEntry['drafts'];
  aiPins: unknown[];
  investigations: unknown[];
} | null {
  for (const p of findAppDocuments(projectRoot)) {
    const { document } = loadAppDocument(p);
    if (!document || document.id !== id) continue;
    const appDir = p.slice(0, -'/dql.app.json'.length);
    const dashboards: Array<{ id: string; title: string; description?: string; itemCount: number }> = [];
    for (const d of findDashboardsForApp(appDir)) {
      const { document: dd } = loadDashboardDocument(d);
      if (dd) {
        dashboards.push({
          id: dd.id,
          title: dd.metadata.title,
          description: dd.metadata.description,
          itemCount: dd.layout.items.length,
        });
      }
    }
    return {
      app: document,
      appDir,
      appPath: relative(projectRoot, appDir),
      dashboards,
      notebooks: listAppNotebookRefs(projectRoot, document, appDir),
      drafts: listAppDrafts(projectRoot, appDir),
      aiPins: listAiPins(projectRoot, document.id),
      investigations: listAppInvestigations(projectRoot, document.id),
    };
  }
  return null;
}

export function listNotebookCandidates(projectRoot: string, app: AppDocument, appDir: string): Array<{
  path: string;
  title: string;
  attached: boolean;
  role?: 'source' | 'analysis' | 'supporting';
  visibility?: NonNullable<AppDocument['visibility']>;
  lastModified?: string;
}> {
  const attached = new Map(listAppNotebookRefs(projectRoot, app, appDir).map((notebook) => [notebook.path, notebook]));
  const files = new Map<string, string>();
  for (const root of ['notebooks', 'workbooks', 'apps']) {
    for (const file of scanFiles(join(projectRoot, root), '.dqlnb')) {
      const rel = relative(projectRoot, file).replaceAll('\\', '/');
      files.set(rel, file);
    }
  }
  for (const notebook of attached.values()) {
    const abs = join(projectRoot, notebook.path);
    if (existsSync(abs)) files.set(notebook.path, abs);
  }
  return Array.from(files.entries())
    .map(([path, abs]) => {
      const ref = attached.get(path);
      const stat = statSyncSafe(abs);
      return {
        path,
        title: ref?.title ?? notebookTitleFromFile(abs) ?? titleFromPath(path),
        attached: Boolean(ref),
        role: ref?.role,
        visibility: ref?.visibility,
        lastModified: stat?.mtime.toISOString(),
      };
    })
    .sort((a, b) => Number(b.attached) - Number(a.attached) || a.title.localeCompare(b.title));
}

export function createNotebookForApp(
  projectRoot: string,
  appId: string,
  input: { name?: string; title?: string; role?: string; visibility?: string; template?: string },
): { ok: true; path: string; app: ReturnType<typeof loadAppById>; preview: unknown } | { ok: false; error: string } {
  const loaded = loadAppById(projectRoot, appId);
  if (!loaded) return { ok: false, error: `App "${appId}" not found` };
  const title = cleanString(input.title) || cleanString(input.name) || 'App analysis';
  const slug = slugify(cleanString(input.name) || title) || `notebook-${Date.now()}`;
  const appDir = loaded.appDir;
  const relPath = relative(projectRoot, join(appDir, 'notebooks', `${slug}.dqlnb`)).replaceAll('\\', '/');
  const absPath = join(projectRoot, relPath);
  if (existsSync(absPath)) return { ok: false, error: `Notebook already exists: ${relPath}` };
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, buildAppNotebookTemplate(title, loaded.app, input.template), 'utf-8');
  const attached = attachNotebookToApp(projectRoot, appId, {
    path: relPath,
    title,
    role: normalizeNotebookRole(input.role),
    visibility: input.visibility,
  });
  if (!attached.ok) return { ok: false, error: attached.error };
  const preview = previewNotebookForApp(projectRoot, appId, relPath);
  return {
    ok: true,
    path: relPath,
    app: loadAppById(projectRoot, appId),
    preview: preview.ok ? preview.preview : null,
  };
}

export function previewNotebookForApp(
  projectRoot: string,
  appId: string,
  notebookPath: string,
): { ok: true; preview: unknown } | { ok: false; status: number; error: string } {
  if (!loadAppById(projectRoot, appId)) return { ok: false, status: 404, error: `App "${appId}" not found` };
  const rel = cleanString(notebookPath).replaceAll('\\', '/');
  if (!rel || rel.startsWith('/') || rel.includes('..') || !rel.endsWith('.dqlnb')) {
    return { ok: false, status: 400, error: 'notebook path must be a project-relative .dqlnb path' };
  }
  const abs = join(projectRoot, rel);
  if (!existsSync(abs)) return { ok: false, status: 404, error: `Notebook not found: ${rel}` };
  try {
    const raw = readFileSync(abs, 'utf-8');
    const parsed = JSON.parse(raw) as {
      title?: string;
      metadata?: { title?: string; description?: string; status?: string; categories?: string[] };
      cells?: Array<Record<string, unknown>>;
    };
    const snapshot = readNotebookRunSnapshot(abs);
    const snapshotByCell = new Map<string, Record<string, unknown>>();
    for (const entry of snapshot?.cells ?? []) {
      if (entry && typeof entry === 'object' && typeof (entry as { cellId?: unknown }).cellId === 'string') {
        snapshotByCell.set(String((entry as { cellId: unknown }).cellId), entry as Record<string, unknown>);
      }
    }
    const cells = (parsed.cells ?? []).map((cell, index) => {
      const id = typeof cell.id === 'string' ? cell.id : `cell-${index + 1}`;
      const snap = snapshotByCell.get(id);
      return {
        id,
        type: typeof cell.type === 'string' ? cell.type : 'sql',
        name: typeof cell.name === 'string' ? cell.name : typeof cell.title === 'string' ? cell.title : undefined,
        content: typeof cell.content === 'string' ? cell.content : typeof cell.source === 'string' ? cell.source : '',
        upstream: typeof cell.upstream === 'string' ? cell.upstream : undefined,
        chartConfig: cell.chartConfig ?? cell.config,
        tableConfig: cell.tableConfig,
        singleValueConfig: cell.singleValueConfig,
        pivotConfig: cell.pivotConfig,
        status: snap?.status ?? 'idle',
        result: snap?.result,
        error: snap?.error,
        executionCount: snap?.executionCount,
        executedAt: snap?.executedAt,
      };
    });
    return {
      ok: true,
      preview: {
        path: rel,
        title: parsed.title ?? parsed.metadata?.title ?? titleFromPath(rel),
        metadata: parsed.metadata ?? {},
        cells,
        snapshotFound: Boolean(snapshot),
        capturedAt: typeof snapshot?.capturedAt === 'string' ? snapshot.capturedAt : undefined,
      },
    };
  } catch (err) {
    return { ok: false, status: 400, error: err instanceof Error ? err.message : String(err) };
  }
}

function attachNotebookToApp(
  projectRoot: string,
  appId: string,
  input: { path?: string; title?: string; role?: string; visibility?: string },
): { ok: true; path: string } | { ok: false; error: string } {
  const notebookPath = cleanString(input.path).replaceAll('\\', '/');
  if (!notebookPath) return { ok: false, error: 'path is required' };
  if (notebookPath.startsWith('/') || notebookPath.includes('..')) {
    return { ok: false, error: 'notebook path must be project-relative' };
  }
  if (!existsSync(join(projectRoot, notebookPath))) {
    return { ok: false, error: `Notebook not found: ${notebookPath}` };
  }
  for (const appJsonPath of findAppDocuments(projectRoot)) {
    const { document } = loadAppDocument(appJsonPath);
    if (!document || document.id !== appId) continue;
    const role = input.role === 'source' || input.role === 'analysis' ? input.role : 'supporting';
    const visibility = input.visibility === 'private' || input.visibility === 'template' ? input.visibility : 'shared';
    const next: AppDocument = {
      ...document,
      notebooks: [
        ...(document.notebooks ?? []).filter((notebook) => notebook.path !== notebookPath),
        {
          path: notebookPath,
          title: cleanString(input.title) || titleFromPath(notebookPath),
          role,
          visibility,
        },
      ],
    };
    const { document: validated, errors } = parseAppDocument(JSON.stringify(next), appJsonPath);
    if (!validated) return { ok: false, error: errors.map((e) => e.message).join('; ') };
    writeFileSync(appJsonPath, JSON.stringify(validated, null, 2) + '\n', 'utf-8');
    return { ok: true, path: relative(projectRoot, appJsonPath) };
  }
  return { ok: false, error: `App "${appId}" not found` };
}

function listAppNotebookRefs(
  projectRoot: string,
  app: AppDocument,
  appDir: string,
): AppListEntry['notebooks'] {
  const byPath = new Map<string, AppListEntry['notebooks'][number]>();
  for (const notebook of app.notebooks ?? []) {
    byPath.set(notebook.path, {
      path: notebook.path,
      title: notebook.title,
      role: notebook.role,
      visibility: notebook.visibility ?? 'shared',
    });
  }
  const notebooksDir = join(appDir, 'notebooks');
  for (const file of scanFiles(notebooksDir, '.dqlnb')) {
    const rel = relative(projectRoot, file).replaceAll('\\', '/');
    if (byPath.has(rel)) continue;
    byPath.set(rel, {
      path: rel,
      title: titleFromPath(rel),
      role: 'supporting',
      visibility: app.visibility ?? 'shared',
    });
  }
  return Array.from(byPath.values()).sort((a, b) => (a.title ?? a.path).localeCompare(b.title ?? b.path));
}

function buildAppNotebookTemplate(title: string, app: AppDocument, template?: string): string {
  const normalizedTemplate = cleanString(template) || 'blank';
  const cellId = (base: string) => `${slugify(base) || 'cell'}_${Math.random().toString(36).slice(2, 8)}`;
  const intro = [
    `# ${title}`,
    '',
    `App: ${app.name}`,
    `Domain: ${[app.domain, app.subdomain, ...(app.groups ?? [])].filter(Boolean).join(' / ')}`,
    '',
    'Use this notebook for analysis that supports the App dashboard pages.',
  ].join('\n');
  const cells = [
    {
      id: cellId('intro'),
      type: 'markdown',
      content: intro,
    },
    {
      id: cellId('starter-sql'),
      type: 'sql',
      name: 'starter_query',
      content: '-- Write supporting SQL for this App here\nSELECT 1 AS value;',
    },
  ];
  if (normalizedTemplate === 'summary') {
    cells.push({
      id: cellId('summary'),
      type: 'markdown',
      content: '## Notes\n\nAdd observations, assumptions, and follow-up questions here.',
    });
  }
  return JSON.stringify({
    dqlnbVersion: 1,
    version: 1,
    title,
    metadata: {
      description: `Supporting notebook for ${app.name}`,
      status: 'draft',
      categories: [app.domain, app.subdomain, ...(app.groups ?? [])].filter(Boolean),
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
    },
    cells,
  }, null, 2) + '\n';
}

function notebookTitleFromFile(absPath: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(absPath, 'utf-8')) as { title?: unknown; metadata?: { title?: unknown } };
    if (typeof parsed.title === 'string' && parsed.title.trim()) return parsed.title.trim();
    if (typeof parsed.metadata?.title === 'string' && parsed.metadata.title.trim()) return parsed.metadata.title.trim();
  } catch {
    // fall back to path-derived title
  }
  return null;
}

function readNotebookRunSnapshot(absNotebookPath: string): { cells?: unknown[]; capturedAt?: unknown } | null {
  const snapshotPath = absNotebookPath.replace(/\.dqlnb$/i, '.run.json');
  if (!existsSync(snapshotPath)) return null;
  try {
    return JSON.parse(readFileSync(snapshotPath, 'utf-8')) as { cells?: unknown[] };
  } catch {
    return null;
  }
}

function normalizeNotebookRole(value: unknown): 'source' | 'analysis' | 'supporting' {
  return value === 'source' || value === 'analysis' ? value : 'supporting';
}

function listAppDrafts(projectRoot: string, appDir: string): AppListEntry['drafts'] {
  return scanFiles(join(appDir, 'drafts'), '.dql').map((file) => {
    const source = readFileSync(file, 'utf-8');
    const path = relative(projectRoot, file).replaceAll('\\', '/');
    return {
      path,
      name: matchString(source, /block\s+"([^"]+)"/) ?? titleFromPath(path),
      reviewStatus: matchString(source, /status\s*=\s*"([^"]+)"/) ?? 'review',
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function scanFiles(root: string, extension: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSyncSafe(root)) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...scanFiles(full, extension));
    else if (entry.isFile() && entry.name.endsWith(extension)) out.push(full);
  }
  return out.sort();
}

function countAiPins(projectRoot: string, appId: string): number {
  return listAiPins(projectRoot, appId).length;
}

function countAppInvestigations(projectRoot: string, appId: string): number {
  return listAppInvestigations(projectRoot, appId).length;
}

function listAiPins(projectRoot: string, appId: string): unknown[] {
  const dbPath = defaultLocalAppsDbPath(projectRoot);
  if (!existsSync(dbPath)) return [];
  try {
    const storage = new LocalAppStorage(dbPath);
    try {
      return storage.listAiPins(appId);
    } finally {
      storage.close();
    }
  } catch {
    // AI pins are optional local overlays. Do not hide file-backed Apps when
    // the native SQLite module is unavailable for the current Node runtime.
    return [];
  }
}

function listAppInvestigations(projectRoot: string, appId: string): unknown[] {
  const dbPath = defaultLocalAppsDbPath(projectRoot);
  if (!existsSync(dbPath)) return [];
  try {
    const storage = new LocalAppStorage(dbPath);
    try {
      return storage.listAppInvestigations(appId);
    } finally {
      storage.close();
    }
  } catch {
    return [];
  }
}

function listDashboardsFor(projectRoot: string, id: string) {
  const result = loadAppById(projectRoot, id);
  return result?.dashboards ?? null;
}

function loadDashboardForApp(
  projectRoot: string,
  appId: string,
  dashboardId: string,
): { app: AppDocument; dashboard: DashboardDocument } | null {
  for (const p of findAppDocuments(projectRoot)) {
    const { document } = loadAppDocument(p);
    if (!document || document.id !== appId) continue;
    const appDir = p.slice(0, -'/dql.app.json'.length);
    for (const d of findDashboardsForApp(appDir)) {
      const { document: dd } = loadDashboardDocument(d);
      if (dd && dd.id === dashboardId) {
        return { app: document, dashboard: dd };
      }
    }
  }
  return null;
}

function writeDashboard(
  projectRoot: string,
  appId: string,
  dashboardId: string,
  payload: unknown,
): { ok: true; path: string } | { ok: false; error: string } {
  // Validate against the dashboard schema before touching disk.
  const { document, errors } = parseDashboardDocument(JSON.stringify(payload), '<incoming>');
  if (!document) {
    return { ok: false, error: errors.map((e) => e.message).join('; ') };
  }
  if (document.id !== dashboardId) {
    return { ok: false, error: `dashboard.id (${document.id}) does not match URL :did (${dashboardId})` };
  }

  // Confirm the App exists.
  const loaded = loadAppById(projectRoot, appId);
  if (!loaded) return { ok: false, error: `App "${appId}" not found` };
  const appDir = loaded.appDir;
  const dashboardPath = join(appDir, 'dashboards', `${dashboardId}.dqld`);
  mkdirSync(dirname(dashboardPath), { recursive: true });
  writeFileSync(dashboardPath, JSON.stringify(document, null, 2) + '\n', 'utf-8');
  return { ok: true, path: dashboardPath };
}

function activatePersona(
  projectRoot: string,
  userId: string,
  appId: string | null,
): ActivePersona | null {
  // If an App id is provided, scope the persona to it.
  if (appId) {
    for (const p of findAppDocuments(projectRoot)) {
      const { document } = loadAppDocument(p);
      if (!document || document.id !== appId) continue;
      return defaultPersonaRegistry.setFromApp(document, userId);
    }
    return null;
  }
  // Otherwise pick the first App that contains the user.
  for (const p of findAppDocuments(projectRoot)) {
    const { document } = loadAppDocument(p);
    if (!document) continue;
    const member = document.members.find((m) => m.userId === userId);
    if (member) {
      const persona = personaFromMember(document, member);
      defaultPersonaRegistry.set(persona);
      return persona;
    }
  }
  return null;
}

// ---- IO utilities ----

async function refreshGeneratedMetadata(projectRoot: string): Promise<void> {
  try {
    const { ensureMetadataCatalogFresh } = await import('@duckcodeailabs/dql-agent');
    await ensureMetadataCatalogFresh(projectRoot, { force: true });
  } catch {
    // App files remain the source of truth; the local catalog refreshes again
    // on the next agent/MCP call if this best-effort update fails.
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve({} as T);
      try {
        resolve(JSON.parse(raw) as T);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export const __test__ = {
  buildPreviewDriverCards,
  buildPreviewMetricSnapshot,
  buildDeterministicInvestigationSql,
  selectedBlockContext,
};

// reference unused parseAppDocument/readFileSync to keep import stable for forward use
void parseAppDocument;
void readFileSync;
