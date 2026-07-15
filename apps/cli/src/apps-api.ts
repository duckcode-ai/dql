/**
 * HTTP handlers for `/api/apps`, `/api/apps/:id`, `/api/apps/:id/dashboards/:did`,
 * `/api/persona`. Designed to be invoked from `local-runtime.ts`'s request
 * dispatcher — returns `true` if the request was handled, `false` otherwise.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, type Dirent, type Stats } from 'node:fs';
import { join, dirname, relative, basename } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentAnswer, AgentResultPayload, AppPlan, NarrateInput, NarrateItem, NarrateResult, ResearchPlan as AppResearchPlan } from '@duckcodeailabs/dql-agent';
import {
  loadAppDocument,
  findAppDocuments,
  loadDashboardDocument,
  findDashboardsForApp,
  parseAppDocument,
  parseDashboardDocument,
  normalizeDqlArtifactReference,
  suggestAppId,
  type AppDocument,
  type BlockParameterDefinition,
  type DashboardDisplayMetadata,
  type DashboardDocument,
  type DashboardFilter,
  type DashboardGridItem,
} from '@duckcodeailabs/dql-core';
import {
  defaultPersonaRegistry,
  defaultLocalAppsDbPath,
  LocalAppStorage,
  personaFromMember,
  type ActivePersona,
  type LocalAiPin,
  type LocalAppConversationContext,
  type LocalAppInvestigation,
  type LocalAppInvestigationIntent,
  type LocalAppInvestigationReportSection,
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
  /** Grounded ReAct research planner (P4) — supplied by the runtime, which holds the
   *  metric/block catalog. Lets the App ask lane decide + offer real follow-ups. */
  planResearch?: (input: { question: string; isFollowUp?: boolean }) => Promise<AppResearchPlan>;
  /** Governed answer generator — supplied by the runtime. Lets the two-phase app
   *  build fill coverage gaps with bounded, review-required generated SQL. */
  generateGovernedAnswer?: (question: string) => Promise<AgentAnswer>;
  /** Story narrator — supplied by the runtime (LLM-backed with a deterministic
   *  fallback). Commit uses it to write the app's narrated story sections. */
  narrate?: (input: NarrateInput) => Promise<NarrateResult>;
}

/** Runtime hooks the two-phase app build can use during propose (all optional —
 *  without them, gaps stay listed as uncovered research questions). */
export interface AppBuildHooks {
  generateGovernedAnswer?: (question: string) => Promise<AgentAnswer>;
}

/** Runtime hooks for the commit step (all optional — commit falls back to the
 *  deterministic narrator so story sections exist even offline). */
export interface AppBuildCommitHooks {
  narrate?: (input: NarrateInput) => Promise<NarrateResult>;
}

export async function handleAppsApi(ctx: Ctx): Promise<boolean> {
  const { req, res, path, projectRoot } = ctx;

  if (req.method === 'POST' && path === '/api/visualizations/recommend') {
    try {
      const body = await readJson<VisualizationRecommendationRequest>(req);
      const result = recommendVisualization(projectRoot, body);
      if (!result.ok) {
        sendJson(res, 400, result);
        return true;
      }
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: (err as Error).message });
    }
    return true;
  }

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

  if (req.method === 'POST' && path === '/api/apps/ai-builds') {
    try {
      const body = await readJson<AppGenerateRequest>(req);
      const result = await createAppAiBuildSession(projectRoot, body);
      if (result.status === 'error') {
        sendJson(res, 400, { ok: false, session: result, error: result.error });
        return true;
      }
      sendJson(res, 201, { ok: true, session: result });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: (err as Error).message });
    }
    return true;
  }

  // Two-phase AI build: propose (plan + confirmable content list, no files) …
  if (req.method === 'POST' && path === '/api/apps/ai-builds/propose') {
    try {
      const body = await readJson<AppGenerateRequest>(req);
      const result = await proposeAppAiBuild(projectRoot, body, {
        generateGovernedAnswer: ctx.generateGovernedAnswer,
      });
      if (result.status === 'error') {
        sendJson(res, 400, { ok: false, session: result, error: result.error });
        return true;
      }
      sendJson(res, 201, { ok: true, session: result });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: (err as Error).message });
    }
    return true;
  }

  // … then commit (user confirmed the selection → write the app files).
  const commitMatch = path.match(/^\/api\/apps\/ai-builds\/([^/]+)\/commit$/);
  if (commitMatch && req.method === 'POST') {
    try {
      const body = await readJson<CommitAppAiBuildInput>(req);
      const result = await commitAppAiBuild(projectRoot, decodeURIComponent(commitMatch[1]), body, {
        narrate: ctx.narrate,
      });
      if (!result.ok) {
        sendJson(res, result.status ?? 400, { ok: false, error: result.error });
        return true;
      }
      sendJson(res, 201, { ok: true, session: result.session, app: result.app, dashboardId: result.dashboardId });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: (err as Error).message });
    }
    return true;
  }

  let m = path.match(/^\/api\/apps\/ai-builds\/([^/]+)$/);
  if (m && req.method === 'GET') {
    const session = getAppAiBuildSession(projectRoot, decodeURIComponent(m[1]));
    if (!session) {
      sendJson(res, 404, { ok: false, error: `AI build session "${decodeURIComponent(m[1])}" not found` });
      return true;
    }
    sendJson(res, 200, { ok: true, session });
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

  m = path.match(/^\/api\/apps\/([^/]+)\/ask$/);
  if (m && req.method === 'POST') {
    const appId = decodeURIComponent(m[1]);
    try {
      const body = await readJson<AppAskRequest>(req);
      const result = await askAppQuestion(ctx, appId, body);
      if (!result.ok) {
        sendJson(res, 400, result);
        return true;
      }
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: (err as Error).message });
    }
    return true;
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/promote$/);
  if (m && req.method === 'POST') {
    const appId = decodeURIComponent(m[1]);
    try {
      const body = await readJson<AppPromoteRequest>(req);
      const result = promoteAppForStakeholders(projectRoot, appId, body);
      if (!result.ok) {
        sendJson(res, 400, result);
        return true;
      }
      await refreshGeneratedMetadata(projectRoot);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: (err as Error).message });
    }
    return true;
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/editor\/catalog$/);
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
        sendJson(res, 200, { investigations: dedupeAppInvestigationsForDisplay(storage.listAppInvestigations(appId, dashboardId)) });
        return true;
      }
      if (req.method === 'POST') {
        const body = await readJson<AppInvestigationCreateRequest>(req);
        const question = cleanString(body.question);
        if (!question) {
          sendJson(res, 400, { error: 'question is required' });
          return true;
        }
        let investigation = createOrReuseAppInvestigation(storage, {
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
          investigation = storage.updateAppInvestigation(investigation.id, {
            status: 'running',
            reviewStatus: 'needs_review',
            error: '',
          }) ?? investigation;
          scheduleAppInvestigationRun(ctx, appId, investigation.id, body);
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
        answer: investigationNarrativeAnswer(investigation),
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

  m = path.match(/^\/api\/apps\/([^/]+)\/dashboards\/([^/]+)\/tiles\/recommend$/);
  if (m && req.method === 'POST') {
    const appId = decodeURIComponent(m[1]);
    const dashboardId = decodeURIComponent(m[2]);
    try {
      const body = await readJson<DashboardTileRecommendationRequest>(req);
      const result = recommendDashboardTile(projectRoot, appId, dashboardId, body);
      if (!result.ok) {
        sendJson(res, 400, result);
        return true;
      }
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: (err as Error).message });
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
  ownerDomain?: string;
  usesDomains: string[];
  purpose?: string;
  requiredExports: string[];
  classification?: string;
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
      ownerDomain: document.ownerDomain,
      usesDomains: document.usesDomains,
      purpose: document.purpose,
      requiredExports: document.requiredExports,
      classification: document.classification,
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

interface VisualizationRecommendationRequest {
  blockRef?: string;
  resultSchema?: unknown;
  rowSample?: Array<Record<string, unknown>>;
  rows?: Array<Record<string, unknown>>;
  appAudience?: string;
  audience?: string;
  prompt?: string;
  filters?: unknown;
  allowedVisualizations?: string[];
  component?: DashboardDisplayMetadata['component'];
  defaultVisualization?: string;
}

interface AppCreateRequest {
  name?: string;
  domain?: string;
  ownerDomain?: string;
  usesDomains?: string[];
  requiredExports?: string[];
  classification?: string;
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
  audience?: string;
  notebookPath?: string;
  existingAppId?: string;
  /** Gap-fill budget: how many uncovered questions may get generated SQL (default 3, hard cap 5). */
  maxGeneratedTiles?: number;
}

interface AppAiBuildSession {
  id: string;
  /** 'proposed' = plan + proposal saved, NO app files written yet (awaiting confirm). */
  status: 'proposed' | 'ready' | 'error';
  createdAt: string;
  updatedAt: string;
  prompt: string;
  appId?: string;
  dashboardId?: string | null;
  generatedPaths: string[];
  plan?: unknown;
  validation?: unknown;
  /** The reviewable content list shown to the user before commit. */
  proposal?: AppBuildProposal;
  /** Tile ids the user confirmed at commit time (audit trail). */
  committedTileIds?: string[];
  warnings: string[];
  reviewTasks: string[];
  inputs: {
    domain?: string;
    owner?: string;
    audience?: string;
    notebookPath?: string;
    existingAppId?: string;
    selectedBlockIds: string[];
  };
  error?: string;
}

/** One confirmable entry in the pre-create proposal list. */
export interface AppBuildProposalTile {
  id: string;
  source: 'certified_block' | 'ai_generated';
  title: string;
  description?: string;
  /** Certified tiles reference an existing block. */
  blockId?: string;
  /** AI-generated candidates carry the question + generated SQL (Phase 2). */
  question?: string;
  sql?: string;
  answer?: string;
  viz: string;
  certification: 'certified' | 'ai_generated';
  /** Bounded preview rows from executing the generated SQL (Phase 2). */
  preview?: { columns: string[]; rows: Array<Record<string, unknown>>; rowCount?: number };
  /** Generation failed — listed for transparency, not selectable. */
  error?: string;
  selectedByDefault: boolean;
  followUps?: string[];
}

/** Questions the plan could not cover; Phase 2 upgrades these into generated tiles. */
export interface AppBuildProposalGap {
  id: string;
  question: string;
  reason: string;
}

export interface AppBuildProposal {
  tiles: AppBuildProposalTile[];
  gaps: AppBuildProposalGap[];
  followUps: string[];
  coverage: { certifiedTiles: number; generatedTiles: number; gaps: number };
}

interface AppAskRequest {
  question?: string;
  dashboardId?: string;
  tileId?: string;
  blockId?: string;
  variables?: Record<string, unknown>;
  context?: unknown;
  runInvestigation?: boolean;
}

interface AppAskDecision {
  mode: 'answer' | 'analysis' | 'app_change' | 'metadata';
  reason: string;
  nextAction: string;
  requiresContext: boolean;
  usesCertifiedResult: boolean;
  confidence: number;
}

interface AppPromoteRequest {
  lifecycle?: AppDocument['lifecycle'];
}

interface DashboardTileRecommendationRequest extends VisualizationRecommendationRequest {
  tileId?: string;
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
    followupKind: record.followupKind === 'generic' || record.followupKind === 'drilldown' || record.followupKind === 'contextual'
      ? record.followupKind
      : undefined,
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
  repairMode?: 'rebuild_from_certified';
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
  mode?: 'sql_and_memo' | 'memo_only';
  generatedSql?: string;
  metrics?: Record<string, unknown>;
  drivers?: Array<Record<string, unknown>>;
  resultPreviews?: unknown[];
  summaryHint?: string;
  recommendationHint?: string;
  sqlError?: string;
  sqlErrorKind?: SqlPreviewErrorKind;
  hasReportEvidence?: boolean;
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
  const terms = appRecommendationTerms([input.purpose, input.audience, ...(input.tags ?? [])]);
  const certifiedOnly = input.certifiedOnly !== false;
  const hasCriteria = Boolean(domain || tags.length > 0 || terms.length > 0);

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
      const textHits = terms.filter((term) => term && haystack.includes(term));
      if (textHits.length > 0) {
        score += textHits.length * 6;
        criteriaScore += textHits.length * 6;
        reasons.push('context match');
      }
      if (!hasCriteria && block.status === 'certified') {
        criteriaScore += 1;
        reasons.push('generic prompt fallback');
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

function appRecommendationTerms(values: Array<unknown>): string[] {
  const stop = new Set([
    'a', 'an', 'and', 'app', 'apps', 'analytics', 'available', 'block', 'blocks', 'build', 'certified',
    'dashboard', 'dashboards', 'data', 'dql', 'from', 'for', 'governed', 'my', 'of', 'on', 'stakeholder',
    'stakeholders', 'table', 'tables', 'the', 'to', 'using', 'view', 'warehouse', 'with',
  ]);
  const terms = values
    .flatMap((value) => cleanString(value).toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? [])
    .filter((term) => !stop.has(term))
    .slice(0, 40);
  return unique(terms);
}

export function recommendVisualization(
  projectRoot: string,
  input: VisualizationRecommendationRequest,
): { ok: true; display: DashboardDisplayMetadata; evidence: Array<{ source: string; reason: string }>; warnings: string[] } | { ok: false; error: string } {
  const blockRef = cleanString(input.blockRef);
  const prompt = cleanString(input.prompt).toLowerCase();
  const audience = cleanString(input.appAudience) || cleanString(input.audience);
  const rows = Array.isArray(input.rowSample) ? input.rowSample : Array.isArray(input.rows) ? input.rows : [];
  const columns = extractRecommendationColumns(input.resultSchema, rows);
  const block = blockRef
    ? collectBlockCandidates(projectRoot).find((candidate) =>
        candidate.id === blockRef ||
        candidate.name === blockRef ||
        candidate.path === blockRef ||
        candidate.path.endsWith(`/${blockRef}`),
      )
    : undefined;
  const evidence: Array<{ source: string; reason: string }> = [];
  const warnings: string[] = [];
  if (block) {
    evidence.push({ source: block.path, reason: `Block hint: ${block.chartType ?? 'table'}; status: ${block.status}; domain: ${block.domain}` });
  } else if (blockRef) {
    warnings.push(`Block reference was not found locally: ${blockRef}`);
  }
  if (columns.length > 0) {
    evidence.push({ source: 'result_schema', reason: `${columns.length} result column(s) were inspected.` });
  } else {
    warnings.push('No result schema or row sample was provided, so recommendation used block metadata and prompt only.');
  }
  if (audience) {
    evidence.push({ source: 'audience', reason: `Audience: ${audience}` });
  }

  const requestedViz = cleanString(input.defaultVisualization);
  if (requestedViz && !isSupportedVizType(requestedViz)) {
    return { ok: false, error: `Unsupported visualization: ${requestedViz}` };
  }
  const requestedVisualization = requestedViz ? normalizeVizType(requestedViz) : undefined;
  // An explicit component is an authored product contract, so reject an invalid
  // pairing rather than silently changing it. A model/default visualization is a
  // preference: validate it against the returned rows before displaying it.
  if (input.component && requestedVisualization && !componentVizCompatible(input.component, requestedVisualization)) {
    return {
      ok: false,
      error: `${input.component} cannot use ${requestedVisualization}. Choose one of ${allowedVisualizationsForComponent(input.component, requestedVisualization).join(', ')}.`,
    };
  }
  const dataRecommendation = recommendVizType({ columns, rows, prompt, blockChartType: block?.chartType });
  const defaultVisualization = requestedVisualization && visualizationFitsResult(requestedVisualization, columns, rows)
    ? requestedVisualization
    : dataRecommendation;
  if (requestedVisualization && requestedVisualization !== defaultVisualization) {
    warnings.push(`Preferred visualization ${requestedVisualization} did not fit the returned result shape; using ${defaultVisualization} instead.`);
  }
  const component = input.component ?? componentForViz(defaultVisualization, prompt);
  if (!componentVizCompatible(component, defaultVisualization)) {
    return {
      ok: false,
      error: `${component} cannot use ${defaultVisualization}. Choose one of ${allowedVisualizationsForComponent(component, defaultVisualization).join(', ')}.`,
    };
  }
  const unsupportedAllowed = (input.allowedVisualizations ?? []).filter((value) => !isSupportedVizType(value));
  if (unsupportedAllowed.length > 0) {
    return { ok: false, error: `Unsupported allowed visualization(s): ${unsupportedAllowed.join(', ')}` };
  }
  const supportedAllowed = (input.allowedVisualizations ?? [])
    .map((value) => normalizeVizType(value))
    .filter((value, index, arr) => arr.indexOf(value) === index);
  if (supportedAllowed.length > 0 && !supportedAllowed.includes(defaultVisualization)) {
    return {
      ok: false,
      error: `Requested visualization ${defaultVisualization} is outside allowed visualizations: ${supportedAllowed.join(', ')}.`,
    };
  }
  const allowedVisualizations = supportedAllowed.length > 0
    ? supportedAllowed
    : allowedVisualizationsForComponent(component, defaultVisualization);
  const fieldHints = fieldHintsForColumns(columns, rows, prompt);
  const display: DashboardDisplayMetadata = {
    mode: block ? 'block_hint' : 'ai_generated',
    component,
    defaultVisualization,
    allowedVisualizations,
    ...(Object.keys(fieldHints).length > 0 ? { fieldHints } : {}),
    layoutIntent: layoutIntentForComponent(component),
    rationale: recommendationRationale(component, defaultVisualization, block, columns, prompt),
    trustState: block?.status === 'certified' ? 'certified' : 'review_required',
    reviewStatus: block?.status === 'certified' ? 'certified' : 'review_required',
  };
  return { ok: true, display, evidence, warnings };
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
      audience: cleanString(input.audience) || undefined,
      owner: cleanString(input.owner) || undefined,
      preferredBlockIds: selectedBlockIds,
      plannerMode: input.plannerMode === 'ai_assisted' ? 'ai_assisted' : 'deterministic',
    });
    const validation = validateAppPlan(plan, kg);
    const certifiedTiles = typeof (validation as { certifiedTiles?: unknown }).certifiedTiles === 'number'
      ? (validation as { certifiedTiles: number }).certifiedTiles
      : 0;
    if (certifiedTiles === 0) {
      return {
        ok: false,
        error: appBuildBlockedMessage(validation, plan as unknown as Record<string, unknown>),
      };
    }
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

export async function createAppAiBuildSession(
  projectRoot: string,
  input: AppGenerateRequest,
): Promise<AppAiBuildSession> {
  const now = new Date().toISOString();
  const id = `app_build_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const selectedBlockIds = unique((input.selectedBlockIds ?? []).map(cleanString).filter(Boolean));
  const base: AppAiBuildSession = {
    id,
    status: 'ready',
    createdAt: now,
    updatedAt: now,
    prompt: cleanString(input.prompt),
    generatedPaths: [],
    warnings: [],
    reviewTasks: [],
    inputs: {
      domain: cleanString(input.domain) || undefined,
      owner: cleanString(input.owner) || undefined,
      audience: cleanString(input.audience) || undefined,
      notebookPath: cleanString(input.notebookPath) || undefined,
      existingAppId: cleanString(input.existingAppId) || undefined,
      selectedBlockIds,
    },
  };
  if (!base.prompt) {
    const session = { ...base, status: 'error' as const, error: 'prompt is required' };
    writeAppAiBuildSession(projectRoot, session);
    return session;
  }

  const result = await generateAppPackage(projectRoot, {
    ...input,
    selectedBlockIds,
  });
  if (!result.ok) {
    const session = {
      ...base,
      status: 'error' as const,
      error: result.error,
      warnings: [result.error],
    };
    writeAppAiBuildSession(projectRoot, session);
    return session;
  }

  const plan = result.plan as Record<string, unknown>;
  const session: AppAiBuildSession = {
    ...base,
    appId: typeof plan.appId === 'string' ? plan.appId : result.app?.id,
    dashboardId: result.dashboardId,
    generatedPaths: result.generated.paths,
    plan: result.plan,
    validation: result.validation,
    warnings: appBuildWarnings(result.validation, plan),
    reviewTasks: reviewTasksFromPlan(plan),
  };
  writeAppAiBuildSession(projectRoot, session);
  return session;
}

export function getAppAiBuildSession(projectRoot: string, id: string): AppAiBuildSession | null {
  const clean = cleanString(id);
  if (!clean || !/^[a-z0-9_:-]+$/i.test(clean)) return null;
  const path = join(appAiBuildSessionDir(projectRoot), `${clean}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as AppAiBuildSession;
  } catch {
    return null;
  }
}

/** Derive the confirmable proposal list from a plan: certified tiles are selectable
 *  (default on); uncovered questions are listed as gaps (Phase 2 fills them with
 *  bounded AI-generated candidates). Narrative/placeholder tiles are structural and
 *  not part of the confirm list. */
function buildAppProposal(plan: AppPlan): AppBuildProposal {
  const tiles: AppBuildProposalTile[] = [];
  for (const page of plan.pages) {
    for (const tile of page.tiles) {
      if (tile.kind !== 'certified_block') continue;
      tiles.push({
        id: tile.id,
        source: 'certified_block',
        title: tile.title,
        description: tile.description,
        blockId: tile.blockId,
        viz: tile.viz,
        certification: 'certified',
        selectedByDefault: true,
      });
    }
  }
  const gaps: AppBuildProposalGap[] = [];
  const seenGap = new Set<string>();
  for (const report of plan.scopedReports) {
    const question = cleanString(report.question) || report.title;
    if (!question || seenGap.has(question.toLowerCase())) continue;
    seenGap.add(question.toLowerCase());
    gaps.push({ id: report.id, question, reason: report.description || 'No certified block covers this question.' });
  }
  for (const evidence of plan.missingEvidence) {
    const question = cleanString(evidence);
    if (!question || seenGap.has(question.toLowerCase())) continue;
    seenGap.add(question.toLowerCase());
    gaps.push({ id: `gap_${gaps.length + 1}`, question, reason: 'No certified block covers this question.' });
  }
  return {
    tiles,
    gaps,
    followUps: gaps.map((gap) => gap.question).slice(0, 4),
    coverage: {
      certifiedTiles: tiles.filter((tile) => tile.certification === 'certified').length,
      generatedTiles: tiles.filter((tile) => tile.certification === 'ai_generated').length,
      gaps: gaps.length,
    },
  };
}

/** Bounded preview rows stored in the session file (the UI shows fewer). */
const PROPOSAL_PREVIEW_ROW_CAP = 50;
const GENERATED_TILE_DEFAULT = 3;
const GENERATED_TILE_HARD_CAP = 5;

const GENERATED_VIZ_TYPES = new Set([
  'single_value', 'grouped_bar', 'stacked_bar', 'line', 'bar', 'area', 'pie', 'donut',
  'scatter', 'heatmap', 'histogram', 'waterfall', 'gauge', 'table', 'pivot', 'map', 'funnel', 'kpi',
]);

function normalizeGeneratedViz(viz: unknown): string {
  const clean = typeof viz === 'string' ? viz.trim().toLowerCase() : '';
  return GENERATED_VIZ_TYPES.has(clean) ? clean : 'table';
}

function titleForGapQuestion(question: string): string {
  const clean = question.trim().replace(/[?.!]+$/, '');
  const title = clean.charAt(0).toUpperCase() + clean.slice(1);
  return title.length > 72 ? `${title.slice(0, 69)}…` : title;
}

/** Normalize an executed agent result into the proposal's bounded preview shape.
 *  Columns may arrive as strings or {name} objects; rows as objects or arrays. */
function previewFromAgentResult(result: AgentResultPayload | undefined): AppBuildProposalTile['preview'] {
  if (!result || !Array.isArray(result.columns) || !Array.isArray(result.rows)) return undefined;
  const columns = result.columns.map((column) => {
    if (typeof column === 'string') return column;
    const record = column as Record<string, unknown> | null;
    return typeof record?.name === 'string' ? record.name : String(column);
  });
  if (columns.length === 0) return undefined;
  const rows = result.rows.slice(0, PROPOSAL_PREVIEW_ROW_CAP).map((row) => {
    if (Array.isArray(row)) {
      const entry: Record<string, unknown> = {};
      columns.forEach((column, index) => { entry[column] = row[index]; });
      return entry;
    }
    return (row ?? {}) as Record<string, unknown>;
  });
  return { columns, rows, rowCount: typeof result.rowCount === 'number' ? result.rowCount : rows.length };
}

/**
 * Fill coverage gaps with bounded, review-required generated answers. Sequential
 * on purpose (provider rate limits); every failure is listed for transparency, not
 * thrown; and nothing here can certify — pass-through of a certified block match is
 * the only way a candidate keeps a 'certified' label.
 */
async function fillProposalGaps(
  proposal: AppBuildProposal,
  hooks: AppBuildHooks | undefined,
  maxGeneratedTiles: number | undefined,
): Promise<void> {
  if (!hooks?.generateGovernedAnswer || proposal.gaps.length === 0) return;
  if (maxGeneratedTiles === 0) return;
  const cap = Math.min(Math.max(1, maxGeneratedTiles ?? GENERATED_TILE_DEFAULT), GENERATED_TILE_HARD_CAP);
  const toFill = proposal.gaps.slice(0, cap);
  const remaining = proposal.gaps.slice(cap);
  let providerUnavailable = false;
  for (const gap of toFill) {
    if (providerUnavailable) {
      remaining.push(gap);
      continue;
    }
    try {
      const answer = await hooks.generateGovernedAnswer(gap.question);
      const sql = cleanString(answer.sql ?? answer.proposedSql ?? answer.result?.sql ?? '');
      if (!sql) {
        remaining.push(gap);
        continue;
      }
      // Gap-fill tiles are AI-generated by definition (they answer questions the
      // certified blocks did NOT cover). They are ALWAYS ai_generated / review-
      // required — never auto-certified, even if the governed loop happened to
      // touch a certified block. The AI never certifies its own output.
      proposal.tiles.push({
        id: `gen_${gap.id}`,
        source: 'ai_generated',
        title: titleForGapQuestion(gap.question),
        question: gap.question,
        sql,
        answer: cleanString(answer.answer ?? answer.text ?? '') || undefined,
        viz: normalizeGeneratedViz(answer.suggestedViz),
        certification: 'ai_generated',
        preview: previewFromAgentResult(answer.result),
        selectedByDefault: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Offline degradation: without a configured provider, keep everything as
      // plain research gaps instead of listing one error tile per question.
      if (/no ai provider/i.test(message)) {
        providerUnavailable = true;
        remaining.push(gap);
        continue;
      }
      proposal.tiles.push({
        id: `gen_${gap.id}`,
        source: 'ai_generated',
        title: titleForGapQuestion(gap.question),
        question: gap.question,
        viz: 'table',
        certification: 'ai_generated',
        error: message,
        selectedByDefault: false,
      });
    }
  }
  proposal.gaps = remaining;
  proposal.followUps = remaining.map((gap) => gap.question).slice(0, 4);
  proposal.coverage = {
    certifiedTiles: proposal.tiles.filter((tile) => tile.certification === 'certified' && !tile.error).length,
    generatedTiles: proposal.tiles.filter((tile) => tile.certification === 'ai_generated' && !tile.error).length,
    gaps: remaining.length,
  };
}

/**
 * Phase 1 of the two-phase app build: plan + validate + build the confirmable
 * proposal, persist the session with status 'proposed'. Writes NO app files —
 * `commitAppAiBuild` does that after the user confirms the selection.
 */
export async function proposeAppAiBuild(
  projectRoot: string,
  input: AppGenerateRequest,
  hooks?: AppBuildHooks,
): Promise<AppAiBuildSession> {
  const now = new Date().toISOString();
  const id = `app_build_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const selectedBlockIds = unique((input.selectedBlockIds ?? []).map(cleanString).filter(Boolean));
  const base: AppAiBuildSession = {
    id,
    status: 'proposed',
    createdAt: now,
    updatedAt: now,
    prompt: cleanString(input.prompt),
    generatedPaths: [],
    warnings: [],
    reviewTasks: [],
    inputs: {
      domain: cleanString(input.domain) || undefined,
      owner: cleanString(input.owner) || undefined,
      audience: cleanString(input.audience) || undefined,
      notebookPath: cleanString(input.notebookPath) || undefined,
      existingAppId: cleanString(input.existingAppId) || undefined,
      selectedBlockIds,
    },
  };
  if (!base.prompt) {
    const session = { ...base, status: 'error' as const, error: 'prompt is required' };
    writeAppAiBuildSession(projectRoot, session);
    return session;
  }

  const {
    KGStore,
    defaultKgPath,
    planAppFromPrompt,
    reindexProject,
    validateAppPlan,
  } = await import('@duckcodeailabs/dql-agent');
  const kgPath = defaultKgPath(projectRoot);
  await reindexProject(projectRoot, { kgPath });
  const kg = new KGStore(kgPath);
  try {
    const plan = planAppFromPrompt({
      prompt: base.prompt,
      kg,
      domain: base.inputs.domain,
      audience: base.inputs.audience,
      owner: base.inputs.owner,
      preferredBlockIds: selectedBlockIds,
      plannerMode: input.plannerMode === 'ai_assisted' ? 'ai_assisted' : 'deterministic',
    });
    const validation = validateAppPlan(plan, kg);
    const proposal = buildAppProposal(plan);
    // Fill uncovered questions with bounded, review-required generated SQL when the
    // runtime supplied a governed answer hook; offline the gaps stay listed as-is.
    await fillProposalGaps(proposal, hooks, input.maxGeneratedTiles);
    const session: AppAiBuildSession = {
      ...base,
      appId: plan.appId,
      dashboardId: plan.pages[0]?.id ?? null,
      plan,
      validation,
      proposal,
      warnings: appBuildWarnings(validation, plan as unknown as Record<string, unknown>),
      reviewTasks: reviewTasksFromPlan(plan as unknown as Record<string, unknown>),
    };
    writeAppAiBuildSession(projectRoot, session);
    return session;
  } catch (err) {
    const session = {
      ...base,
      status: 'error' as const,
      error: err instanceof Error ? err.message : String(err),
    };
    writeAppAiBuildSession(projectRoot, session);
    return session;
  } finally {
    kg.close();
  }
}

/**
 * Persist selected AI-generated candidates as aiPins (certification preserved,
 * never upgraded; review-required) and append them as dashboard tiles below the
 * certified layout. The dashboard doc was just written by generateAppFromPlan, so
 * this rewrites it with the extra items — the renderer already badges aiPin tiles.
 */
function attachGeneratedTiles(
  projectRoot: string,
  plan: AppPlan,
  generatedPaths: string[],
  candidates: AppBuildProposalTile[],
): void {
  const dashboardId = plan.pages[0]?.id ?? 'overview';
  const dashboardPath = generatedPaths.find((path) => path.endsWith(`${dashboardId}.dqld`))
    ?? generatedPaths.find((path) => path.endsWith('.dqld'));
  if (!dashboardPath) return;
  const absolutePath = join(projectRoot, dashboardPath);
  if (!existsSync(absolutePath)) return;
  const doc = JSON.parse(readFileSync(absolutePath, 'utf-8')) as DashboardDocument;
  // Story layout: generated tiles live in the review appendix. Classic grids
  // (no sections) just append at the bottom, untagged.
  const storyMode = Array.isArray(doc.sections) && doc.sections.length > 0;
  if (storyMode && !doc.sections!.some((section) => section.kind === 'appendix')) {
    doc.sections!.push({
      id: 'appendix',
      title: 'AI-generated analysis — needs review',
      kind: 'appendix',
      order: doc.sections!.length,
    });
  }
  const storage = new LocalAppStorage(defaultLocalAppsDbPath(projectRoot));
  try {
    let y = doc.layout.items.reduce((max, item) => Math.max(max, item.y + item.h), 0);
    let x = 0;
    for (const tile of candidates) {
      const certified = tile.certification === 'certified';
      const pin = storage.createAiPin({
        appId: plan.appId,
        dashboardId: doc.id,
        title: tile.title,
        answer: tile.answer ?? tile.question ?? tile.title,
        question: tile.question,
        sql: tile.sql,
        certification: certified ? 'certified' : 'ai_generated',
        reviewStatus: certified ? 'certified' : 'needs_review',
        refreshCadence: 'none',
        result: tile.preview,
        followUps: tile.followUps ?? [],
      });
      const item: DashboardGridItem = {
        i: `aipin_${pin.id}`,
        x,
        y,
        w: 6,
        h: 4,
        aiPin: { id: pin.id },
        viz: { type: normalizeGeneratedViz(tile.viz) as DashboardGridItem['viz']['type'] },
        title: tile.title,
        trustState: certified ? 'certified' : 'review_required',
        reviewStatus: certified ? 'certified' : 'review_required',
        ...(storyMode ? { sectionId: 'appendix' } : {}),
      };
      doc.layout.items.push(item);
      if (x === 0) {
        x = 6;
      } else {
        x = 0;
        y += 4;
      }
    }
    writeFileSync(absolutePath, JSON.stringify(doc, null, 2) + '\n', 'utf-8');
  } finally {
    storage.close();
  }
}

export interface CommitAppAiBuildInput {
  /** Proposal tile ids to include; omitted = everything selectable. */
  selectedTileIds?: string[];
  force?: boolean;
}

/**
 * Phase 2 of the two-phase app build: the user confirmed the proposal — filter the
 * plan to the selected tiles, re-validate (fail closed on drift), write the app
 * files, and mark the session ready.
 */
export async function commitAppAiBuild(
  projectRoot: string,
  sessionId: string,
  input: CommitAppAiBuildInput = {},
  hooks?: AppBuildCommitHooks,
): Promise<
  | { ok: true; session: AppAiBuildSession; app: ReturnType<typeof collectAppsList>[number] | null; dashboardId: string | null }
  | { ok: false; error: string; status?: number }
> {
  const session = getAppAiBuildSession(projectRoot, sessionId);
  if (!session) return { ok: false, error: `AI build session "${sessionId}" not found`, status: 404 };
  if (session.status === 'ready') return { ok: false, error: 'This app build was already created.', status: 409 };
  if (session.status !== 'proposed' || !session.plan || !session.proposal) {
    return { ok: false, error: session.error ?? 'Session has no proposal to commit.', status: 400 };
  }

  const plan = session.plan as AppPlan;
  const proposal = session.proposal;
  const selectable = new Set(proposal.tiles.filter((tile) => !tile.error).map((tile) => tile.id));
  const selected = new Set(
    (input.selectedTileIds ?? Array.from(selectable)).filter((tileId) => selectable.has(tileId)),
  );
  if (selected.size === 0) {
    return { ok: false, error: 'Select at least one tile to create the app.', status: 400 };
  }

  // Filter the plan's certified tiles down to the confirmed selection; structural
  // tiles (narrative, draft placeholders) stay — they document the story + gaps.
  const committedPlan: AppPlan = {
    ...plan,
    pages: plan.pages.map((page) => ({
      ...page,
      tiles: page.tiles.filter((tile) => tile.kind !== 'certified_block' || selected.has(tile.id)),
    })),
  };

  const {
    KGStore,
    defaultKgPath,
    ensureMetadataCatalogFresh,
    generateAppFromPlan,
    narrateResult,
    validateAppPlan,
  } = await import('@duckcodeailabs/dql-agent');
  const kg = new KGStore(defaultKgPath(projectRoot));
  try {
    // Re-validate against the live catalog: blocks may have changed since propose.
    const validation = validateAppPlan(committedPlan, kg);
    if (validation.certifiedTiles === 0) {
      return { ok: false, error: appBuildBlockedMessage(validation, committedPlan as unknown as Record<string, unknown>), status: 409 };
    }
    // Narrate the story from the confirmed content (generated candidates carry
    // executed previews, so real numbers reach the prose). The LLM-backed hook is
    // optional — the deterministic narrator guarantees a story offline.
    const narrateInput: NarrateInput = {
      question: committedPlan.prompt,
      items: [
        ...proposal.tiles
          .filter((tile) => tile.source === 'certified_block' && selected.has(tile.id))
          .map((tile): NarrateItem => ({ id: tile.id, title: tile.title })),
        ...proposal.tiles
          .filter((tile) => tile.source === 'ai_generated' && !tile.error && selected.has(tile.id))
          .map((tile): NarrateItem => ({
            id: tile.id,
            title: tile.title,
            result: tile.preview ? { columns: tile.preview.columns, rows: tile.preview.rows } : undefined,
          })),
      ],
      reviewRequired: proposal.tiles.some((tile) => tile.source === 'ai_generated' && !tile.error && selected.has(tile.id)),
    };
    let narration: NarrateResult | undefined;
    try {
      narration = hooks?.narrate ? await hooks.narrate(narrateInput) : await narrateResult(narrateInput);
    } catch {
      try {
        narration = await narrateResult(narrateInput);
      } catch {
        narration = undefined; // Narration is enhancement, never a commit blocker.
      }
    }
    // Honesty caveat: when the story is built partly from AI-generated (review-
    // required) figures, say so in the executive summary — the headline must not
    // present uncertified numbers as trusted.
    if (narration && narrateInput.reviewRequired) {
      narration = {
        ...narration,
        summary: `${narration.summary}\n\n_Some figures draw on AI-generated analysis that is pending review — see the review appendix._`,
      };
    }
    // Copilot follow-ups the created app carries: still-uncovered gaps first, then
    // the questions behind any candidates the user chose to leave out.
    const copilotQuestions = unique([
      ...proposal.gaps.map((gap) => gap.question),
      ...proposal.tiles
        .filter((tile) => tile.source === 'ai_generated' && !selected.has(tile.id) && tile.question)
        .map((tile) => tile.question as string),
    ]).slice(0, 4);
    let generated: ReturnType<typeof generateAppFromPlan>;
    try {
      generated = generateAppFromPlan(projectRoot, committedPlan, kg, { overwrite: Boolean(input.force), narration, copilotQuestions });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message, status: message.includes('already exists') ? 409 : 400 };
    }
    // Selected AI-generated candidates become aiPin tiles: stored in local app
    // storage with their review-required status, then appended to the dashboard.
    // The certified app is already valid on disk — attaching the extra pins must
    // NOT be able to fail the commit and orphan the app, so it is best-effort.
    const generatedCandidates = proposal.tiles.filter(
      (tile) => tile.source === 'ai_generated' && !tile.error && selected.has(tile.id) && tile.sql,
    );
    const attachWarnings: string[] = [];
    if (generatedCandidates.length > 0) {
      try {
        attachGeneratedTiles(projectRoot, committedPlan, generated.paths, generatedCandidates);
      } catch (err) {
        attachWarnings.push(`Some AI-generated tiles could not be attached: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await ensureMetadataCatalogFresh(projectRoot, { force: true });
    const app = collectAppsList(projectRoot).find((entry) => entry.id === committedPlan.appId) ?? null;
    const next: AppAiBuildSession = {
      ...session,
      status: 'ready',
      updatedAt: new Date().toISOString(),
      appId: committedPlan.appId,
      dashboardId: committedPlan.pages[0]?.id ?? app?.dashboards[0]?.id ?? null,
      plan: committedPlan,
      validation,
      generatedPaths: generated.paths,
      committedTileIds: Array.from(selected),
      warnings: [...session.warnings, ...attachWarnings],
    };
    writeAppAiBuildSession(projectRoot, next);
    return { ok: true, session: next, app, dashboardId: next.dashboardId ?? null };
  } finally {
    kg.close();
  }
}

interface AppAskSuccess {
  ok: true;
  route: 'certified_answer' | 'generated_answer' | 'investigation' | 'app_change_proposal' | 'metadata_answer';
  answer: string;
  trustState: 'certified' | 'review_required' | 'draft_ready';
  reviewStatus: 'certified' | 'review_required' | 'draft_ready';
  citations: Array<{ kind: string; name: string; path?: string }>;
  followUps: string[];
  decision: AppAskDecision;
  investigation?: LocalAppInvestigation;
  proposal?: unknown;
  /** Grounded ReAct research plan (P4): the decision, steps, and follow-up options. */
  researchPlan?: AppResearchPlan;
}

type AppAskResult = AppAskSuccess | { ok: false; error: string };

/**
 * Ask the App a question. Routes to the right lane (certified answer / investigation /
 * app change / metadata) and — when the runtime supplies a research planner — enriches
 * the result with a grounded ReAct plan + smart follow-up options (the P4 loop), so the
 * panel can DECIDE and offer real next steps instead of generic strings.
 */
async function askAppQuestion(ctx: Ctx, appId: string, input: AppAskRequest): Promise<AppAskResult> {
  const routed = await routeAppAskQuestion(ctx, appId, input);
  if (!routed.ok) return routed;
  // Blend in the app's own suggested questions (uncovered analysis gaps captured
  // at AI-build time) so follow-ups point at what the app can't answer yet.
  const appCopilotQuestions = loadAppById(ctx.projectRoot, appId)?.app.copilot?.suggestedQuestions ?? [];
  const result: AppAskSuccess = appCopilotQuestions.length > 0
    ? { ...routed, followUps: unique([...routed.followUps, ...appCopilotQuestions]).slice(0, 5) }
    : routed;
  if (!ctx.planResearch) return result;
  try {
    const research = await ctx.planResearch({
      question: cleanString(input.question),
      isFollowUp: result.route === 'investigation' || result.route === 'app_change_proposal',
    });
    // A clarify decision means "ask before researching" — surface the real options.
    const followUps = research.decision === 'clarify' && research.followUp
      ? [research.followUp.question, ...research.followUp.options].slice(0, 5)
      : result.followUps;
    return { ...result, researchPlan: research, followUps };
  } catch {
    return result; // best-effort: research enrichment never blocks the answer
  }
}

async function routeAppAskQuestion(
  ctx: Ctx,
  appId: string,
  input: AppAskRequest,
): Promise<AppAskResult> {
  const loaded = loadAppById(ctx.projectRoot, appId);
  if (!loaded) return { ok: false, error: `App "${appId}" not found` };
  const question = cleanString(input.question);
  if (!question) return { ok: false, error: 'question is required' };

  const dashboardId = cleanString(input.dashboardId)
    || (loaded.app.homepage?.type === 'dashboard' ? loaded.app.homepage.id : undefined)
    || loaded.dashboards[0]?.id;
  const dashboard = dashboardId ? loadDashboardForApp(ctx.projectRoot, appId, dashboardId)?.dashboard : null;
  const tile = dashboard?.layout.items.find((item) =>
    item.i === input.tileId ||
    (input.blockId && item.block && 'blockId' in item.block && item.block.blockId === input.blockId),
  );
  const blockId = cleanString(input.blockId) || (tile?.block && 'blockId' in tile.block ? tile.block.blockId : undefined);
  const citations = [
    { kind: 'app', name: loaded.app.name, path: loaded.appPath },
    ...(dashboard ? [{ kind: 'dashboard', name: dashboard.metadata.title, path: `${loaded.appPath}/dashboards/${dashboard.id}.dqld` }] : []),
    ...(blockId ? [{ kind: 'block', name: blockId }] : []),
  ];

  if (isAppChangeQuestion(question)) {
    const decision = buildAppAskDecision('app_change_proposal', {
      question,
      blockId,
      selected: selectedBlockContext(input.context),
      appName: loaded.app.name,
    });
    return {
      ok: true,
      route: 'app_change_proposal',
      answer: `I can update the app presentation, but this should remain a reviewed app change. Suggested action: ${appChangeSuggestion(question)}.`,
      trustState: 'review_required',
      reviewStatus: 'review_required',
      citations,
      followUps: ['Review this app change', 'Open Build mode', 'Create analysis before changing logic'],
      decision,
      proposal: {
        type: 'app_change',
        dashboardId,
        tileId: input.tileId,
        blockId,
        question,
        reviewRequired: true,
      },
    };
  }

  if (shouldRouteAppQuestionToInvestigation(question)) {
    const decision = buildAppAskDecision('investigation', {
      question,
      blockId,
      selected: selectedBlockContext(input.context),
      appName: loaded.app.name,
    });
    const investigationProposal = {
      type: 'research_investigation',
      dashboardId,
      tileId: cleanString(input.tileId) || undefined,
      blockId,
      question,
      intent: normalizeInvestigationIntent(undefined, question, input.context),
      title: titleFromInvestigation(question, selectedBlockContext(input.context)),
      requiredContext: true,
      reviewRequired: true,
      suggestedContext: {
        appId,
        appName: loaded.app.name,
        dashboardId,
        tileId: input.tileId,
        blockId,
        variables: input.variables,
        selectedTile: tile ? appAskTileContext(tile) : undefined,
        userContext: input.context,
      },
    };

    if (input.runInvestigation === false) {
      return {
        ok: true,
        route: 'investigation',
        answer: 'This needs a scoped analysis memo. Add the comparison, filters, timeframe, and decision context before DQL writes SQL or runs a preview.',
        trustState: 'draft_ready',
        reviewStatus: 'draft_ready',
        citations,
        followUps: ['Add analysis context', 'Check proof', 'Create block draft'],
        decision,
        proposal: investigationProposal,
      };
    }

    const storage = new LocalAppStorage(defaultLocalAppsDbPath(ctx.projectRoot));
    try {
      let investigation = createOrReuseAppInvestigation(storage, {
        appId,
        dashboardId,
        sourceTileId: cleanString(input.tileId) || undefined,
        sourceBlockId: blockId,
        title: titleFromInvestigation(question, selectedBlockContext(input.context)),
        question,
        intent: normalizeInvestigationIntent(undefined, question, input.context),
        context: {
          appId,
          appName: loaded.app.name,
          dashboardId,
          tileId: input.tileId,
          blockId,
          variables: input.variables,
          selectedTile: tile ? appAskTileContext(tile) : undefined,
          userContext: input.context,
          routeDecision: decision,
        },
      });
      investigation = await runAppInvestigation(ctx, storage, investigation, { context: investigation.context });
      return {
        ok: true,
        route: 'investigation',
        answer: 'I opened a review-required analysis memo for this follow-up. Review the numbers, caveats, SQL appendix, and source proof before adding it to the app or drafting reusable logic.',
        trustState: 'draft_ready',
        reviewStatus: 'draft_ready',
        citations,
        followUps: ['Review the memo', 'Add reviewed result to this app', 'Create a draft DQL block'],
        decision,
        investigation,
      };
    } finally {
      storage.close();
    }
  }

  // The focused tile narrates ONLY questions that are actually about it ("explain this",
  // "what does this chart show"). Everything else routes through the shared governed loop.
  const focusTileAnswer = (): AppAskSuccess => {
    const selected = selectedBlockContext(input.context);
    const answer = buildCertifiedAppAnswer({
      app: loaded.app,
      dashboard: dashboard ?? null,
      blockId: blockId!,
      question,
      selected,
      variables: input.variables,
    });
    return {
      ok: true,
      route: 'certified_answer',
      answer,
      trustState: tile?.trustState === 'certified' || tile?.display?.trustState === 'certified' ? 'certified' : 'review_required',
      reviewStatus: tile?.reviewStatus === 'certified' || tile?.display?.reviewStatus === 'certified' ? 'certified' : 'review_required',
      citations,
      followUps: ['Explain the visible result', 'Investigate drivers', 'Create block draft from this result'],
      decision: buildAppAskDecision('certified_answer', { question, blockId, selected, appName: loaded.app.name }),
    };
  };

  if (blockId && questionIsAboutFocusedTile(question)) {
    return focusTileAnswer();
  }

  // Route the QUESTION through the same governed answer loop the Notebook and Ask
  // surfaces use: question-first retrieval finds the best-matching certified block
  // across the app, generates review-required SQL, or digs deeper — instead of
  // narrating whichever tile happens to be focused.
  const governed = await tryGovernedAppAnswer(ctx, question, { blockId, appName: loaded.app.name, citations });
  if (governed) return governed;

  // Offline / no AI provider: keep the focused tile as a graceful fallback.
  if (blockId) return focusTileAnswer();

  return {
    ok: true,
    route: 'metadata_answer',
    answer: `${loaded.app.name} is a ${loaded.app.domain} app for ${loaded.app.audience ?? 'stakeholders'}. It has ${loaded.dashboards.length} dashboard page${loaded.dashboards.length === 1 ? '' : 's'}, ${loaded.aiPins.length} pinned insight${loaded.aiPins.length === 1 ? '' : 's'}, and ${loaded.investigations.length} analysis item${loaded.investigations.length === 1 ? '' : 's'}. Ask about a tile for a certified answer, or ask a why/change/drilldown question to create analysis.`,
    trustState: 'draft_ready',
    reviewStatus: 'draft_ready',
    citations,
    followUps: ['Ask about a specific tile', 'Find trust gaps', 'Start driver analysis'],
    decision: buildAppAskDecision('metadata_answer', {
      question,
      appName: loaded.app.name,
    }),
  };
}

function buildAppAskDecision(
  route: 'certified_answer' | 'generated_answer' | 'investigation' | 'app_change_proposal' | 'metadata_answer',
  input: {
    question: string;
    blockId?: string;
    selected?: Record<string, unknown> | null;
    appName?: string;
  },
): AppAskDecision {
  const selected = input.selected ?? null;
  const sourceName = selectedString(selected, 'title')
    || cleanString(input.blockId)
    || cleanString(input.appName)
    || 'this app';
  if (route === 'certified_answer') {
    return {
      mode: 'answer',
      reason: `The question can be answered from the selected certified result: ${sourceName}.`,
      nextAction: 'Use the answer directly, or request deeper analysis when you need a new comparison, grain, or reusable logic.',
      requiresContext: false,
      usesCertifiedResult: true,
      confidence: hasSelectedRows(selected) ? 0.9 : 0.74,
    };
  }
  if (route === 'generated_answer') {
    return {
      mode: 'answer',
      reason: 'Answered by routing the question through the governed answer loop (best-matching certified block, or review-required generated SQL).',
      nextAction: 'Review the result; promote to a certified block when it should be reused.',
      requiresContext: false,
      usesCertifiedResult: false,
      confidence: 0.7,
    };
  }
  if (route === 'investigation') {
    const intent = normalizeInvestigationIntent(undefined, input.question, selected);
    return {
      mode: 'analysis',
      reason: appAskInvestigationReason(intent),
      nextAction: 'Add the exact comparison, filters, and proof focus before DQL writes SQL or opens the main-canvas analysis.',
      requiresContext: true,
      usesCertifiedResult: Boolean(input.blockId || input.selected),
      confidence: 0.82,
    };
  }
  if (route === 'app_change_proposal') {
    return {
      mode: 'app_change',
      reason: 'The question asks to change presentation or layout, not business logic.',
      nextAction: 'Review the proposed app change in Build mode and keep certified block logic unchanged.',
      requiresContext: false,
      usesCertifiedResult: Boolean(input.blockId || input.selected),
      confidence: 0.78,
    };
  }
  return {
    mode: 'metadata',
    reason: 'No specific certified tile was selected, so DQL answered from app metadata.',
    nextAction: 'Select a tile for a trusted answer, or ask for deeper analysis with a clear comparison and filter scope.',
    requiresContext: false,
    usesCertifiedResult: false,
    confidence: 0.62,
  };
}

/**
 * True only when the question is genuinely ABOUT the focused tile ("explain this",
 * "what does this chart show") — deictic/explanatory and not asking for other data.
 * Any other question (rankings, other entities, drilldowns, "why") must route through
 * the shared governed loop instead of narrating the focused tile.
 */
function questionIsAboutFocusedTile(question: string): boolean {
  const lower = question.toLowerCase();
  if (!/\b(this|that|it|these|those|the (?:chart|graph|result|tile|number|value|visual|figure)|visible|current (?:tile|block|metric|result)|selected (?:tile|block|metric)|explain)\b/.test(lower)) {
    return false;
  }
  if (/\b(top|bottom|best|worst|highest|lowest|least|fewest|most|rank|ranking|customers?|products?|orders?|revenue|sales|spend|by\s+[a-z]|compare|versus|vs\.?|break\s*down|drill|why|driver|segment|cohort|trend|forecast|list|who|where|which)\b/.test(lower)) {
    return false;
  }
  return true;
}

/** Map a governed AgentAnswer into the App Copilot's response shape. */
function mapGovernedToAppAsk(
  governed: AgentAnswer,
  input: { question: string; blockId?: string; appName: string; citations: Array<{ kind: string; name: string; path?: string }> },
): AppAskSuccess {
  const isCertified = governed.certification === 'certified' || governed.kind === 'certified';
  const noAnswer = governed.kind === 'no_answer';
  const answer = cleanString(governed.answer) || cleanString(governed.text) || 'No governed answer was available for this question.';
  const route: AppAskSuccess['route'] = noAnswer ? 'metadata_answer' : isCertified ? 'certified_answer' : 'generated_answer';
  const trustState: AppAskSuccess['trustState'] = noAnswer ? 'draft_ready' : isCertified ? 'certified' : 'review_required';
  const govCitations = Array.isArray(governed.citations)
    ? governed.citations.map((c) => ({ kind: String((c as { kind?: unknown }).kind ?? 'source'), name: String((c as { name?: unknown }).name ?? '') })).filter((c) => c.name)
    : [];
  const seen = new Set<string>();
  const citations = [...input.citations, ...govCitations].filter((c) => {
    const key = `${c.kind}:${c.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
  return {
    ok: true,
    route,
    answer,
    trustState,
    reviewStatus: trustState,
    citations,
    followUps: noAnswer
      ? ['Name the metric and grain', 'Pick a certified tile', 'Start driver analysis']
      : ['Investigate drivers', 'Break this down further', 'Create a draft DQL block'],
    decision: buildAppAskDecision(route, { question: input.question, blockId: input.blockId, appName: input.appName }),
  };
}

/** Route the question through the shared governed answer loop; null if unavailable. */
async function tryGovernedAppAnswer(
  ctx: Ctx,
  question: string,
  input: { blockId?: string; appName: string; citations: Array<{ kind: string; name: string; path?: string }> },
): Promise<AppAskSuccess | null> {
  if (!ctx.generateGovernedAnswer) return null;
  try {
    const governed = await ctx.generateGovernedAnswer(question);
    return governed ? mapGovernedToAppAsk(governed, { question, ...input }) : null;
  } catch {
    return null; // no provider / transient — caller falls back to tile or metadata
  }
}

function appAskInvestigationReason(intent: LocalAppInvestigationIntent): string {
  if (intent === 'diagnose_change') return 'The question asks why something changed, which needs a comparison window or baseline beyond the visible certified result.';
  if (intent === 'segment_compare') return 'The question asks for a comparison across segments, cohorts, or groups, which needs scoped analysis before promotion.';
  if (intent === 'entity_drilldown') return 'The question asks for entity-level drilldown, which needs reviewed grain, joins, and identifiers.';
  if (intent === 'anomaly_investigation') return 'The question asks about an exception or outlier, which needs baseline proof before stakeholder use.';
  if (intent === 'trust_gap_review') return 'The question asks about proof, caveats, lineage, or trust gaps, which should be reviewed as an evidence brief.';
  return 'The question asks for drivers or decomposition, which needs scoped analysis before creating or changing reusable logic.';
}

function appAnalysisRouteDecisionFromContext(
  context: unknown,
  intent: LocalAppInvestigationIntent,
  selected: Record<string, unknown> | null,
  question: string,
): AppAskDecision {
  const root = asRecord(context);
  const rawDecision = asRecord(root?.routeDecision) ?? asRecord(asRecord(root?.originatingAnswer)?.decision);
  if (rawDecision) {
    return normalizeAppAskDecision(rawDecision, intent, selected, question);
  }
  return buildAppAskDecision('investigation', {
    question,
    blockId: selectedString(selected, 'blockId'),
    selected,
    appName: cleanString(root?.appName),
  });
}

function normalizeAppAskDecision(
  value: Record<string, unknown>,
  intent: LocalAppInvestigationIntent,
  selected: Record<string, unknown> | null,
  question: string,
): AppAskDecision {
  const mode = value.mode === 'answer' || value.mode === 'analysis' || value.mode === 'app_change' || value.mode === 'metadata'
    ? value.mode
    : 'analysis';
  const reason = cleanString(value.reason) || appAskInvestigationReason(intent);
  const nextAction = cleanString(value.nextAction)
    || 'Review the generated analysis, validate proof, then pin or promote only after approval.';
  const confidence = typeof value.confidence === 'number' && Number.isFinite(value.confidence)
    ? Math.max(0, Math.min(1, value.confidence))
    : hasSelectedRows(selected) ? 0.82 : 0.68;
  return {
    mode,
    reason,
    nextAction,
    requiresContext: typeof value.requiresContext === 'boolean' ? value.requiresContext : mode === 'analysis',
    usesCertifiedResult: typeof value.usesCertifiedResult === 'boolean'
      ? value.usesCertifiedResult
      : Boolean(selectedString(selected, 'blockId') || selectedString(selected, 'certificationStatus')),
    confidence,
  };
}

function buildCertifiedAppAnswer(input: {
  app: AppDocument;
  dashboard: DashboardDocument | null;
  blockId: string;
  question: string;
  selected: Record<string, unknown> | null;
  variables?: Record<string, unknown>;
}): string {
  const rows = selectedRows(input.selected);
  const columns = selectedColumns(input.selected, rows);
  const metrics = buildMetricSnapshot(input.selected);
  const currentValue = typeofNumber(metrics.currentValue);
  const baselineValue = typeofNumber(metrics.baselineValue);
  const deltaValue = typeofNumber(metrics.delta);
  const metricName = cleanString(metrics.metric) || preferredMeasureColumn(columns, rows) || 'selected metric';
  const firstRow = rows[0];
  const labelColumn = preferredLabelColumn(columns, rows);
  const label = labelColumn && firstRow ? cleanString(firstRow[labelColumn]) : '';
  const filterSummary = formatAppAskVariables(input.variables);
  const resultTitle = cleanString(input.selected?.title)
    || cleanString(input.dashboard?.metadata.title)
    || input.app.name;
  const currentLine = currentValue !== null
    ? `${label ? `${label} is the leading visible row and ` : 'The current visible result '}shows ${formatMetricValue(currentValue)} for ${formatBusinessColumn(metricName)}${baselineValue !== null ? ` versus ${formatMetricValue(baselineValue)} for the next comparison` : ''}${deltaValue !== null ? `, a gap of ${formatMetricValue(deltaValue)}` : ''}.`
    : rows.length > 0
      ? `The certified result is loaded with ${rows.length} sampled row${rows.length === 1 ? '' : 's'} across ${columns.length} field${columns.length === 1 ? '' : 's'}.`
      : 'The certified block is selected, but this request did not include result rows for a numeric summary.';
  const rowDetails = firstRow && columns.length
    ? columns
      .slice(0, 5)
      .map((column) => `${formatBusinessColumn(column)}: ${formatAskValue(firstRow[column])}`)
      .join('; ')
    : '';
  const nextStep = /\bwhy|driver|change|changed|compare|segment|drill|root cause|because\b/i.test(input.question)
    ? 'This question asks for explanation beyond the current certified result. Use the copilot analysis flow with the exact comparison, timeframe, and segment so DQL can create review-required analysis.'
    : 'Use deeper analysis only when you need a new grain, driver breakdown, segment comparison, or reusable block that this certified tile does not already cover.';

  return [
    `## Answer`,
    `For **${resultTitle}**${filterSummary ? ` with ${filterSummary}` : ''}, ${currentLine}`,
    rowDetails ? `Visible row detail: ${rowDetails}.` : '',
    `## Trusted source`,
    `This answer is grounded in certified DQL block **${input.blockId}**. The app can present this result directly; new SQL or new business logic still needs review before promotion.`,
    `## Next step`,
    nextStep,
  ].filter(Boolean).join('\n\n');
}

function preferredLabelColumn(columns: string[], rows: Array<Record<string, unknown>>): string | undefined {
  return columns.find((column) => /\b(name|player|customer|account|team|segment|category|label)\b/i.test(column) && rows.some((row) => cleanString(row[column])))
    ?? columns.find((column) => rows.some((row) => typeof row[column] === 'string' && cleanString(row[column])));
}

function preferredMeasureColumn(columns: string[], rows: Array<Record<string, unknown>>): string | undefined {
  return columns.find((column) => /\b(total|points?|revenue|score|amount|count|games?|orders?|value|delta|change)\b/i.test(column) && rows.some((row) => typeofNumber(row[column]) !== null))
    ?? columns.find((column) => rows.some((row) => typeofNumber(row[column]) !== null));
}

function formatAppAskVariables(variables?: Record<string, unknown>): string {
  if (!variables) return '';
  return Object.entries(variables)
    .filter(([key, value]) => key !== 'smartView' && value !== undefined && value !== null && String(value).trim() !== '')
    .slice(0, 6)
    .map(([key, value]) => `${formatBusinessColumn(key)} ${formatAskVariableValue(key, value)}`)
    .join(', ');
}

function formatBusinessColumn(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function formatAskValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(formatAskValue).join(', ');
  if (typeof value === 'number') return Number.isInteger(value) ? value.toLocaleString() : Number(value.toFixed(2)).toLocaleString();
  if (value === null || value === undefined) return 'not set';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function formatAskVariableValue(key: string, value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => formatAskVariableValue(key, item)).join(', ');
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() && Number.isFinite(Number(value))
      ? Number(value)
      : null;
  if (numeric !== null && /(season|year)/i.test(key) && Number.isInteger(numeric) && numeric >= 1900 && numeric <= 2200) {
    return String(numeric);
  }
  return formatAskValue(value);
}

export function recommendDashboardTile(
  projectRoot: string,
  appId: string,
  dashboardId: string,
  input: DashboardTileRecommendationRequest,
): { ok: true; display: DashboardDisplayMetadata; filterBindings: DashboardGridItem['filterBindings']; parameterBindings: DashboardGridItem['parameterBindings']; sourceEvidence: DashboardGridItem['sourceEvidence']; trustState: NonNullable<DashboardGridItem['trustState']>; reviewStatus: NonNullable<DashboardGridItem['reviewStatus']>; evidence: Array<{ source: string; reason: string }>; warnings: string[] } | { ok: false; error: string } {
  const loaded = loadDashboardForApp(projectRoot, appId, dashboardId);
  if (!loaded) return { ok: false, error: `Dashboard "${dashboardId}" not found in app "${appId}"` };
  const recommendation = recommendVisualization(projectRoot, input);
  if (!recommendation.ok) return recommendation;
  const block = input.blockRef
    ? collectBlockCandidates(projectRoot).find((candidate) =>
        candidate.id === input.blockRef ||
        candidate.name === input.blockRef ||
        candidate.path === input.blockRef ||
        candidate.path.endsWith(`/${input.blockRef}`),
      )
    : undefined;
  const filterBindings = block ? filterBindingsForBlockSource(projectRoot, block) : [];
  const parameterBindings = filterBindings
    .filter((entry) => entry.mode === 'parameter' && entry.paramNames?.length)
    .flatMap((entry) => (entry.paramNames ?? []).map((param) => ({ param, source: 'dashboard_filter' as const, filter: entry.filter, field: entry.binding })));
  const sourceEvidence = [
    ...recommendation.evidence.map((entry) => ({
      source: entry.source,
      reason: entry.reason,
      kind: entry.source === 'result_schema' ? 'result_schema' : 'metadata',
      trustState: recommendation.display.trustState,
    })),
    ...(block ? [{
      source: `block:${block.name}`,
      reason: block.status === 'certified' ? 'Certified block can back this app tile.' : 'Block is not certified; keep review-required.',
      kind: 'block',
      path: block.path,
      trustState: block.status === 'certified' ? 'certified' as const : 'review_required' as const,
    }] : []),
  ];
  return {
    ok: true,
    display: recommendation.display,
    filterBindings,
    parameterBindings,
    sourceEvidence,
    trustState: recommendation.display.trustState,
    reviewStatus: recommendation.display.reviewStatus,
    evidence: recommendation.evidence,
    warnings: recommendation.warnings,
  };
}

export function promoteAppForStakeholders(
  projectRoot: string,
  appId: string,
  input: AppPromoteRequest = {},
): { ok: true; app: AppDocument; paths: string[]; removedLocalTiles: number } | { ok: false; error: string } {
  const loaded = loadAppById(projectRoot, appId);
  if (!loaded) return { ok: false, error: `App "${appId}" not found` };
  const lifecycle = input.lifecycle === 'certified' || input.lifecycle === 'deprecated' ? input.lifecycle : 'review';
  const app: AppDocument = {
    ...loaded.app,
    visibility: 'shared',
    lifecycle,
  };
  const appPath = join(loaded.appDir, 'dql.app.json');
  const parsedApp = parseAppDocument(JSON.stringify(app), appPath);
  if (!parsedApp.document) return { ok: false, error: parsedApp.errors.map((err) => err.message).join('; ') };
  writeFileSync(appPath, JSON.stringify(parsedApp.document, null, 2) + '\n', 'utf-8');

  let removedLocalTiles = 0;
  const paths = [relative(projectRoot, appPath)];
  for (const dashboardPath of findDashboardsForApp(loaded.appDir)) {
    const loadedDashboard = loadDashboardDocument(dashboardPath).document;
    if (!loadedDashboard) continue;
    const items = loadedDashboard.layout.items
      .filter((item) => {
        if (item.aiPin) {
          removedLocalTiles += 1;
          return false;
        }
        return true;
      })
      .map((item) => promoteSharedDashboardItem(item));
    const dashboard: DashboardDocument = {
      ...loadedDashboard,
      metadata: {
        ...loadedDashboard.metadata,
        visibility: 'shared',
        lifecycle,
      },
      layout: {
        ...loadedDashboard.layout,
        items,
      },
    };
    const parsed = parseDashboardDocument(JSON.stringify(dashboard), dashboardPath);
    if (!parsed.document) return { ok: false, error: parsed.errors.map((err) => err.message).join('; ') };
    writeFileSync(dashboardPath, JSON.stringify(parsed.document, null, 2) + '\n', 'utf-8');
    paths.push(relative(projectRoot, dashboardPath));
  }
  return { ok: true, app: parsedApp.document, paths, removedLocalTiles };
}

function appAiBuildSessionDir(projectRoot: string): string {
  return join(projectRoot, '.dql', 'local', 'app-ai-builds');
}

function writeAppAiBuildSession(projectRoot: string, session: AppAiBuildSession): void {
  const dir = appAiBuildSessionDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${session.id}.json`), JSON.stringify(session, null, 2) + '\n', 'utf-8');
}

function appBuildWarnings(validation: unknown, plan: Record<string, unknown>): string[] {
  const issues = Array.isArray((validation as { issues?: unknown[] } | undefined)?.issues)
    ? (validation as { issues: Array<{ level?: string; message?: string }> }).issues
    : [];
  const warnings = issues
    .filter((issue) => issue.level === 'warning')
    .map((issue) => cleanString(issue.message))
    .filter(Boolean);
  const missing = Array.isArray(plan.missingEvidence) ? plan.missingEvidence.map(cleanString).filter(Boolean) : [];
  return unique([...warnings, ...missing]);
}

function appBuildBlockedMessage(validation: unknown, plan: Record<string, unknown>): string {
  const warnings = appBuildWarnings(validation, plan).slice(0, 4);
  const reviewTasks = reviewTasksFromPlan(plan).slice(0, 4);
  return [
    'No certified DQL blocks matched strongly enough to create a stakeholder app.',
    'DQL did not write an empty dashboard. Create or certify reusable blocks first, or select certified blocks explicitly.',
    warnings.length ? `Missing proof: ${warnings.join(' | ')}` : '',
    reviewTasks.length ? `Next review tasks: ${reviewTasks.join(' | ')}` : '',
  ].filter(Boolean).join(' ');
}

function reviewTasksFromPlan(plan: Record<string, unknown>): string[] {
  const tasks = Array.isArray(plan.reviewTasks) ? plan.reviewTasks.map(cleanString).filter(Boolean) : [];
  const scopedReports = Array.isArray(plan.scopedReports) ? plan.scopedReports : [];
  const planning = plan.planning && typeof plan.planning === 'object' ? plan.planning as { scopedReports?: unknown[] } : {};
  const planningReports = Array.isArray(planning.scopedReports) ? planning.scopedReports : [];
  const reportTasks = [...scopedReports, ...planningReports].flatMap((report) => {
    if (!report || typeof report !== 'object') return [];
    const record = report as { title?: unknown; question?: unknown; evidenceNeeded?: unknown[] };
    const title = cleanString(record.title) || 'Scoped analysis';
    const question = cleanString(record.question);
    const evidence = Array.isArray(record.evidenceNeeded)
      ? record.evidenceNeeded.map(cleanString).filter(Boolean).join(', ')
      : '';
    return [
      `Scoped analysis "${title}": ${question || 'Review the analysis question before running it.'}`,
      evidence ? `Scoped analysis "${title}" evidence needed: ${evidence}` : '',
    ].filter(Boolean);
  });
  const pages = Array.isArray(plan.pages) ? plan.pages : [];
  const tileTasks = pages.flatMap((page) => {
    if (!page || typeof page !== 'object') return [];
    const tiles = Array.isArray((page as { tiles?: unknown[] }).tiles) ? (page as { tiles: unknown[] }).tiles : [];
    return tiles.flatMap((tile) => {
      if (!tile || typeof tile !== 'object') return [];
      const record = tile as { title?: unknown; reviewTasks?: unknown[] };
      const title = cleanString(record.title) || 'Tile';
      return Array.isArray(record.reviewTasks)
        ? record.reviewTasks.map((task) => `${title}: ${cleanString(task)}`).filter((task) => !task.endsWith(': '))
        : [];
    });
  });
  return unique([...tasks, ...reportTasks, ...tileTasks]).slice(0, 20);
}

function shouldRouteAppQuestionToInvestigation(question: string): boolean {
  return /\b(why|changed|change|drop|decline|increase|decrease|driver|drill|break\s*down|segment|cohort|compare|versus| vs |anomal|outlier|spike|dip|root cause)\b/i.test(question);
}

function isAppChangeQuestion(question: string): boolean {
  return /\b(add|remove|change|update|replace|resize|move|create|build|show|switch)\b.*\b(tile|chart|page|dashboard|app|layout|visual|view)\b/i.test(question);
}

function appChangeSuggestion(question: string): string {
  if (/\b(chart|visual|bar|line|table|pivot|kpi)\b/i.test(question)) return 'recommend a governed tile display change and save it in Build mode';
  if (/\b(page|dashboard)\b/i.test(question)) return 'create or update a dashboard page as a reviewed app artifact';
  if (/\b(filter|parameter|param)\b/i.test(question)) return 'bind the filter to compatible certified block parameters only';
  return 'prepare a reviewed app layout change';
}

function appAskTileContext(tile: DashboardGridItem): Record<string, unknown> {
  return {
    tileId: tile.i,
    title: tile.title,
    blockId: tile.block && 'blockId' in tile.block ? tile.block.blockId : undefined,
    viz: tile.viz.type,
    trustState: tile.trustState ?? tile.display?.trustState,
    reviewStatus: tile.reviewStatus ?? tile.display?.reviewStatus,
    filterBindings: tile.filterBindings,
    parameterBindings: tile.parameterBindings,
    sourceEvidence: tile.sourceEvidence,
  };
}

function filterBindingsForBlockSource(projectRoot: string, block: BlockCandidate): NonNullable<DashboardGridItem['filterBindings']> {
  const absPath = join(projectRoot, block.path);
  if (!existsSync(absPath)) return [];
  const source = readFileSync(absPath, 'utf-8');
  const filterSection = sectionBody(source, 'filterBindings');
  const parameterSection = sectionBody(source, 'parameterPolicy');
  const bindings = Array.from(filterSection.matchAll(/^\s*([A-Za-z_][\w-]*)\s*=\s*"([^"]+)"/gm))
    .map((match) => ({ filter: match[1], binding: match[2], mode: 'predicate' as const }));
  const parameterNames = Array.from(parameterSection.matchAll(/^\s*([A-Za-z_][\w-]*)\s*=\s*"dynamic"/gm))
    .map((match) => match[1]);
  const parameterBindings = parameterNames.map((param) => ({
    filter: param,
    binding: param,
    mode: 'parameter' as const,
    paramNames: [param],
  }));
  return uniqueFilterBindings([...bindings, ...parameterBindings]);
}

function sectionBody(source: string, sectionName: string): string {
  const match = new RegExp(`${sectionName}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`, 'm').exec(source);
  return match?.[1] ?? '';
}

function buildInvestigationSqlTemplateValues(
  projectRoot: string,
  context: unknown,
  selected: Record<string, unknown> | null,
  sourceBlockId?: string,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const block = resolveSelectedBlock(projectRoot, selected, sourceBlockId);
  if (block) {
    const absPath = join(projectRoot, block.path);
    if (existsSync(absPath)) {
      Object.assign(values, parseDqlParams(readFileSync(absPath, 'utf-8')));
    }
  }

  const root = asRecord(context);
  const selectedRecord = asRecord(selected);
  mergeTemplateRecord(values, root?.activeFilters);
  mergeTemplateRecord(values, root?.filters);
  mergeTemplateRecord(values, root?.variables);
  mergeTemplateRecord(values, root?.parameters);
  mergeTemplateRecord(values, root?.parameterValues);
  mergeTemplateRecord(values, selectedRecord?.activeFilters);
  mergeTemplateRecord(values, selectedRecord?.variables);
  mergeTemplateRecord(values, selectedRecord?.parameters);
  return values;
}

function mergeTemplateRecord(target: Record<string, unknown>, value: unknown): void {
  const record = asRecord(value);
  if (!record) return;
  for (const [key, entry] of Object.entries(record)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (entry === undefined || entry === null || entry === '') continue;
    target[key] = entry;
  }
}

function parseDqlParams(source: string): Record<string, unknown> {
  const body = sectionBody(source, 'params');
  const values: Record<string, unknown> = {};
  for (const match of body.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/gm)) {
    const name = match[1];
    const value = parseDqlLiteral(match[2]);
    if (value !== undefined) values[name] = value;
  }
  return values;
}

function parseDqlLiteral(raw: string): unknown {
  const trimmed = raw
    .replace(/\s+#.*$/g, '')
    .replace(/\s+\/\/.*$/g, '')
    .replace(/,\s*$/g, '')
    .trim();
  if (!trimmed) return undefined;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (/^(true|false)$/i.test(trimmed)) return /^true$/i.test(trimmed);
  const quoted = /^"((?:[^"\\]|\\.)*)"$/s.exec(trimmed) ?? /^'((?:[^'\\]|\\.)*)'$/s.exec(trimmed);
  if (quoted) return quoted[1].replace(/\\(["'\\])/g, '$1');
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const items = splitDqlArrayValues(trimmed.slice(1, -1))
      .map(parseDqlLiteral)
      .filter((item) => item !== undefined);
    return items;
  }
  return trimmed;
}

function splitDqlArrayValues(value: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      current += char;
      if (char === quote && value[index - 1] !== '\\') quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ',') {
      if (current.trim()) out.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function renderSqlTemplateParams(
  sql: string,
  values: Record<string, unknown>,
): { sql: string; unresolved: string[] } {
  const rendered = sql.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, name)) return match;
    const literal = sqlTemplateLiteral(values[name]);
    return literal ?? match;
  });
  return { sql: rendered, unresolved: unresolvedSqlTemplateParams(rendered) };
}

function sqlTemplateLiteral(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (Array.isArray(value)) {
    const rendered = value.map(sqlTemplateLiteral).filter((item): item is string => Boolean(item));
    return rendered.length > 0 ? rendered.join(', ') : undefined;
  }
  const stringValue = String(value).trim();
  if (!stringValue) return undefined;
  if (/^-?\d+(?:\.\d+)?$/.test(stringValue)) return stringValue;
  if (/^(true|false)$/i.test(stringValue)) return /^true$/i.test(stringValue) ? 'TRUE' : 'FALSE';
  return sqlStringLiteral(stringValue);
}

function unresolvedSqlTemplateParams(sql: string): string[] {
  const names = Array.from(sql.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g), (match) => match[1]);
  if (/\{\{[\s\S]*?\}\}/.test(sql)) names.push('jinja_template');
  return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
}

function uniqueFilterBindings(bindings: NonNullable<DashboardGridItem['filterBindings']>): NonNullable<DashboardGridItem['filterBindings']> {
  const seen = new Set<string>();
  const out: NonNullable<DashboardGridItem['filterBindings']> = [];
  for (const binding of bindings) {
    const key = `${binding.filter}:${binding.binding ?? ''}:${binding.mode ?? ''}:${(binding.paramNames ?? []).join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(binding);
  }
  return out;
}

function promoteSharedDashboardItem(item: DashboardGridItem): DashboardGridItem {
  const trustState = item.trustState ?? item.display?.trustState ?? (item.block ? 'certified' : 'review_required');
  const reviewStatus = item.reviewStatus ?? item.display?.reviewStatus ?? (trustState === 'certified' ? 'certified' : 'review_required');
  const display = item.display
    ? {
        ...item.display,
        trustState,
        reviewStatus,
      }
    : undefined;
  return {
    ...item,
    ...(display ? { display } : {}),
    trustState,
    reviewStatus,
  };
}

export function createAppPackage(
  projectRoot: string,
  input: AppCreateRequest,
): { ok: true; app: ReturnType<typeof collectAppsList>[number]; paths: string[]; dashboardId: string } | { ok: false; error: string } {
  const name = cleanString(input.name);
  const domain = cleanString(input.ownerDomain) || cleanString(input.domain);
  if (!name) return { ok: false, error: 'name is required' };
  if (!domain) return { ok: false, error: 'domain is required' };

  const id = suggestAppId(name);
  const appDir = resolveAppPackageDir(projectRoot, id);
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
    ownerDomain: domain,
    usesDomains: normalizeTags(input.usesDomains ?? [domain]),
    purpose: cleanString(input.purpose) || undefined,
    requiredExports: normalizeTags(input.requiredExports ?? []),
    classification: cleanString(input.classification) || undefined,
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
    display: displayForBlockHint(block, chartType),
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
  if (normalized === 'text') return 'text';
  if (normalized === 'heading') return 'heading';
  return 'table';
}

function isSupportedVizType(chartType?: string): boolean {
  const normalized = (chartType ?? '').toLowerCase().replace(/-/g, '_');
  return [
    'single', 'single_value', 'kpi', 'line', 'bar', 'grouped_bar', 'stacked_bar',
    'area', 'pie', 'donut', 'scatter', 'heatmap', 'histogram', 'waterfall',
    'gauge', 'pivot', 'map', 'funnel', 'table', 'text', 'heading',
  ].includes(normalized);
}

function displayForBlockHint(
  block: BlockCandidate,
  chartType: DashboardGridItem['viz']['type'],
): DashboardDisplayMetadata {
  const component = componentForViz(chartType, `${block.name} ${block.description} ${block.tags.join(' ')}`.toLowerCase());
  return {
    mode: 'block_hint',
    component,
    defaultVisualization: chartType,
    allowedVisualizations: allowedVisualizationsForComponent(component, chartType),
    layoutIntent: layoutIntentForComponent(component),
    rationale: `Block-level visualization is treated as a display hint for ${block.name}; apps and notebooks may override it.`,
    trustState: block.status === 'certified' ? 'certified' : 'draft_ready',
    reviewStatus: block.status === 'certified' ? 'certified' : 'draft_ready',
  };
}

function displayForAiPin(
  title: string,
  chartType: DashboardGridItem['viz']['type'],
  input: AiPinCreateRequest,
): DashboardDisplayMetadata {
  const text = `${title} ${cleanString(input.question)} ${cleanString(input.answer)}`.toLowerCase();
  const component = componentForViz(chartType, text);
  const certified = input.certification === 'certified' || input.reviewStatus === 'certified';
  return {
    mode: 'ai_generated',
    component,
    defaultVisualization: chartType,
    allowedVisualizations: allowedVisualizationsForComponent(component, chartType),
    layoutIntent: layoutIntentForComponent(component),
    rationale: 'AI-generated analysis pin saved as governed presentation metadata; promote the SQL to a draft block before treating it as reusable logic.',
    trustState: certified ? 'certified' : 'review_required',
    reviewStatus: certified ? 'certified' : 'review_required',
  };
}

function extractRecommendationColumns(
  schema: unknown,
  rows: Array<Record<string, unknown>>,
): Array<{ name: string; type?: string }> {
  const rawColumns = Array.isArray(schema)
    ? schema
    : schema && typeof schema === 'object' && Array.isArray((schema as { columns?: unknown }).columns)
      ? (schema as { columns: unknown[] }).columns
      : [];
  const columns = rawColumns.flatMap((column): Array<{ name: string; type?: string }> => {
    if (typeof column === 'string') return [{ name: column }];
    if (column && typeof column === 'object') {
      const record = column as Record<string, unknown>;
      const name = cleanString(record.name) || cleanString(record.field) || cleanString(record.id);
      if (!name) return [];
      const type = cleanString(record.type) || cleanString(record.dataType);
      return [{ name, ...(type ? { type } : {}) }];
    }
    return [];
  });
  if (columns.length > 0) return columns;
  const first = rows.find((row) => row && typeof row === 'object');
  return first ? Object.keys(first).map((name) => ({ name, type: typeof first[name] })) : [];
}

function recommendVizType(input: {
  columns: Array<{ name: string; type?: string }>;
  rows: Array<Record<string, unknown>>;
  prompt: string;
  blockChartType?: string;
}): DashboardGridItem['viz']['type'] {
  const names = input.columns.map((column) => column.name.toLowerCase());
  const hasTime = names.some((name) => /\b(date|time|week|month|quarter|year|season|period)\b/.test(name));
  const measures = input.columns.filter((column) => isMeasureColumn(column, input.rows));
  const dimensions = input.columns.filter((column) => !isMeasureColumn(column, input.rows));
  if (/\bpivot|matrix|cross.?tab\b/.test(input.prompt)) return 'pivot';
  if (/\btrend|over time|weekly|monthly|daily|quarterly\b/.test(input.prompt) || (hasTime && measures.length > 0)) return 'line';
  if (/\btop|bottom|rank|ranking|leader|leaderboard|players?|scorers?\b/.test(input.prompt)) return 'bar';
  if (measures.length === 1 && dimensions.length === 0) return 'single_value';
  if (dimensions.length > 0 && measures.length > 0) return 'bar';
  return normalizeVizType(input.blockChartType);
}

/** Whether an AI/default preference can actually be represented by the result. */
function visualizationFitsResult(
  viz: DashboardGridItem['viz']['type'],
  columns: Array<{ name: string; type?: string }>,
  rows: Array<Record<string, unknown>>,
): boolean {
  const measures = columns.filter((column) => isMeasureColumn(column, rows));
  const dimensions = columns.filter((column) => !isMeasureColumn(column, rows));
  const hasTime = columns.some((column) => /\b(date|time|week|month|quarter|year|season|period)\b/i.test(column.name));
  if (viz === 'table' || viz === 'pivot' || viz === 'text' || viz === 'heading') return true;
  if (rows.length === 0) return false;
  if (viz === 'single_value' || viz === 'kpi' || viz === 'gauge') return rows.length === 1 && measures.length >= 1;
  if (viz === 'line' || viz === 'area') return hasTime && measures.length >= 1;
  if (viz === 'scatter') return measures.length >= 2;
  if (viz === 'grouped_bar' || viz === 'stacked_bar') return dimensions.length >= 1 && measures.length >= 2;
  if (viz === 'pie' || viz === 'donut') return dimensions.length >= 1 && measures.length >= 1 && rows.length >= 2 && rows.length <= 8;
  if (viz === 'heatmap') return columns.length >= 3 && measures.length >= 1;
  if (viz === 'histogram') return measures.length >= 1;
  // Treat a model/default bar as a soft preference on a time series. The data
  // has an ordered axis, for which the deterministic recommendation is line.
  if (viz === 'bar') return dimensions.length >= 1 && measures.length >= 1 && !hasTime;
  return dimensions.length >= 1 && measures.length >= 1;
}

function isMeasureColumn(column: { name: string; type?: string }, rows: Array<Record<string, unknown>>): boolean {
  const type = (column.type ?? '').toLowerCase();
  if (/\b(number|numeric|decimal|double|float|integer|int|bigint|real)\b/.test(type)) return true;
  const name = column.name.toLowerCase();
  if (/\b(count|sum|avg|average|total|revenue|arr|amount|rate|score|points?|goals?|rank|value)\b/.test(name)) return true;
  const sample = rows.map((row) => row[column.name]).find((value) => value !== null && value !== undefined);
  return typeof sample === 'number';
}

function fieldHintsForColumns(
  columns: Array<{ name: string; type?: string }>,
  rows: Array<Record<string, unknown>>,
  prompt: string,
): Record<string, string> {
  const hints: Record<string, string> = {};
  const measure = columns.find((column) => isMeasureColumn(column, rows));
  const time = columns.find((column) => /\b(date|time|week|month|quarter|year|season|period)\b/i.test(column.name));
  const rank = columns.find((column) => /\b(rank|position)\b/i.test(column.name));
  const label = columns.find((column) =>
    !isMeasureColumn(column, rows) && /\b(name|player|customer|account|team|segment|region|category|label)\b/i.test(column.name),
  ) ?? columns.find((column) => !isMeasureColumn(column, rows));
  if (label) hints.label = label.name;
  if (measure) hints.value = measure.name;
  if (time) hints.time = time.name;
  if (rank || /\brank|top|bottom\b/i.test(prompt)) hints.rank = rank?.name ?? 'rank';
  if (time && measure) {
    hints.x = time.name;
    hints.y = measure.name;
  } else if (label && measure) {
    hints.x = label.name;
    hints.y = measure.name;
  }
  return hints;
}

function componentForViz(
  viz: DashboardGridItem['viz']['type'],
  text: string,
): DashboardDisplayMetadata['component'] {
  if (viz === 'single_value' || viz === 'kpi' || viz === 'gauge') return 'KpiMetric';
  if (viz === 'line' || viz === 'area') return 'TrendPanel';
  if (viz === 'pivot') return 'PivotTable';
  if (viz === 'text' || viz === 'heading') return /\btrust|evidence|caveat|quality\b/.test(text) ? 'TrustCallout' : 'NarrativePanel';
  if (/\btop|bottom|rank|ranking|leader|leaderboard|scorer|player\b/.test(text)) return 'RankingPanel';
  if (viz === 'bar' || viz === 'grouped_bar' || viz === 'stacked_bar' || viz === 'pie' || viz === 'donut') return 'RankingPanel';
  return 'EvidenceTable';
}

function allowedVisualizationsForComponent(
  component: DashboardDisplayMetadata['component'],
  primary: DashboardGridItem['viz']['type'],
): DashboardGridItem['viz']['type'][] {
  const base = new Set<DashboardGridItem['viz']['type']>([primary]);
  for (const viz of compatibleVisualizationsForComponent(component)) base.add(viz);
  return Array.from(base);
}

function compatibleVisualizationsForComponent(
  component: DashboardDisplayMetadata['component'],
): DashboardGridItem['viz']['type'][] {
  if (component === 'KpiMetric') {
    return ['single_value', 'kpi', 'gauge', 'table'];
  }
  if (component === 'TrendPanel') return ['line', 'area', 'bar', 'table'];
  if (component === 'RankingPanel') return ['bar', 'grouped_bar', 'stacked_bar', 'pie', 'donut', 'table'];
  if (component === 'PivotTable') return ['pivot', 'table', 'bar'];
  if (component === 'EvidenceTable') return ['table', 'bar', 'scatter', 'heatmap', 'histogram', 'waterfall', 'map', 'funnel'];
  return ['text', 'heading'];
}

function componentVizCompatible(
  component: DashboardDisplayMetadata['component'],
  viz: DashboardGridItem['viz']['type'],
): boolean {
  return compatibleVisualizationsForComponent(component).includes(viz);
}

function layoutIntentForComponent(component: DashboardDisplayMetadata['component']): DashboardDisplayMetadata['layoutIntent'] {
  if (component === 'KpiMetric' || component === 'TrustCallout' || component === 'ResearchActions') return 'compact';
  if (component === 'TrendPanel' || component === 'RankingPanel') return 'wide';
  if (component === 'PivotTable' || component === 'EvidenceTable') return 'standard';
  if (component === 'BusinessBrief') return 'wide';
  return 'standard';
}

function recommendationRationale(
  component: DashboardDisplayMetadata['component'],
  viz: DashboardGridItem['viz']['type'],
  block: BlockCandidate | undefined,
  columns: Array<{ name: string; type?: string }>,
  prompt: string,
): string {
  if (block) {
    return `Recommended ${component} with ${viz} from the block display hint and result shape. The certified block remains the business logic source.`;
  }
  if (columns.length > 0) {
    return `Recommended ${component} with ${viz} from ${columns.length} output column(s) and the app prompt. This is consumer-level metadata pending review.`;
  }
  return prompt
    ? `Recommended ${component} with ${viz} from the app prompt. Review against previewed fields before sharing.`
    : `Recommended ${component} with ${viz} as a safe table-first presentation fallback.`;
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
  const intent = normalizeInvestigationIntent('intent' in input ? input.intent : investigation.intent, question, context);
  const title = cleanString('title' in input ? input.title : undefined)
    || cleanString(investigation.title)
    || titleFromInvestigation(question, selectedBlockContext(context));
  const rebuildFromCertified = 'repairMode' in input && input.repairMode === 'rebuild_from_certified';
  let generatedSql = cleanString(input.generatedSql) || (rebuildFromCertified ? undefined : investigation.generatedSql);
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
    const routeDecision = appAnalysisRouteDecisionFromContext(context, intent, selected, question);
    const sqlTemplateValues = buildInvestigationSqlTemplateValues(ctx.projectRoot, context, selected, sourceBlockId);
    if (generatedSql) {
      generatedSql = renderSqlTemplateParams(generatedSql, sqlTemplateValues).sql;
    }
    const deterministicGeneration = generatedSql || baselineGap
      ? undefined
      : buildDeterministicInvestigationSql(ctx.projectRoot, {
          question,
          intent,
          selected,
          sourceBlockId,
          context,
        });
    generatedSql = generatedSql || deterministicGeneration?.sql;
    let agentGeneration: AppInvestigationGenerationResult | undefined;
    if (!generatedSql && !baselineGap) {
      agentGeneration = await generateInvestigationSql(ctx, {
          appId: investigation.appId,
          dashboardId: investigation.dashboardId ?? selectedString(context, 'dashboardId'),
          sourceTileId,
          sourceBlockId,
          title: investigation.title,
          question,
          intent,
          context,
          mode: 'sql_and_memo',
        });
    }
    generatedSql = generatedSql || cleanString(agentGeneration?.sql);
    const generationError = cleanString(agentGeneration?.executionError);
    const sqlEvidence = agentGeneration?.result
      ? { preview: buildGeneratedSqlPreview(agentGeneration.result, generatedSql), error: generationError || undefined }
      : await runGeneratedSqlPreview(ctx, generatedSql);
    const sqlError = sqlEvidence.error ?? generationError;
    const sqlErrorKind = classifySqlPreviewError(sqlError);
    if (sqlEvidence.preview) {
      previews.unshift(sqlEvidence.preview);
      metricSnapshot = buildPreviewMetricSnapshot(sqlEvidence.preview, selectedString(selected, 'title'));
      driverCards = buildPreviewDriverCards(sqlEvidence.preview, intent);
    }
    const hasReportEvidence = previews.length > 0 || driverCards.length > 0 || Object.keys(metricSnapshot).length > 0;
    const reportSqlError = shouldSurfaceSqlPreviewIssue({
      sqlError,
      sqlErrorKind,
      generatedSql,
      hasReportEvidence,
    }) ? sqlError : undefined;
    const fallbackSummary = baselineGap
      ? buildMissingBaselineSummary(question, selected)
      : buildInvestigationSummary(intent, question, selected, metricSnapshot, driverCards);
    const recommendation = baselineGap
      ? buildMissingBaselineRecommendation(selected)
      : buildInvestigationRecommendation(intent, selected, reportSqlError, sqlErrorKind);
    const memoGeneration = !baselineGap && shouldRequestProviderMemo({
      ctx,
      generatedSql,
      agentGeneration,
      hasReportEvidence,
    })
      ? await generateInvestigationSql(ctx, {
          appId: investigation.appId,
          dashboardId: investigation.dashboardId ?? selectedString(context, 'dashboardId'),
          sourceTileId,
          sourceBlockId,
          title: investigation.title,
          question,
          intent,
          context,
          mode: 'memo_only',
          generatedSql,
          metrics: metricSnapshot,
          drivers: driverCards,
          resultPreviews: previews.slice(0, 4),
          summaryHint: fallbackSummary,
          recommendationHint: recommendation,
          sqlError: reportSqlError,
          sqlErrorKind,
          hasReportEvidence,
        })
      : undefined;
    const narrativeGeneration = cleanString(memoGeneration?.answer) ? memoGeneration : agentGeneration;
    const evidence = {
      trustStatus: buildInvestigationTrust(investigation, selected, sqlError),
      planner: {
        intent,
        steps: investigationSteps(intent),
        reviewRequired: true,
        generatedSql: generatedSql || undefined,
        sqlExecuted: Boolean(sqlEvidence.preview),
        sqlError,
        sqlErrorKind,
        generationSource: baselineGap ? 'missing_baseline' : deterministicGeneration ? 'selected_block_metadata' : agentGeneration?.providerUsed ? 'ai_provider' : generatedSql ? 'provided_sql' : 'context_only',
        repairMode: rebuildFromCertified ? 'rebuild_from_certified' : undefined,
        baselineGap,
        sourceBlockPath: deterministicGeneration?.sourceBlockPath,
        sourceBlockName: deterministicGeneration?.sourceBlockName,
        providerUsed: agentGeneration?.providerUsed,
        memoProviderUsed: memoGeneration?.providerUsed,
        memoSource: cleanString(narrativeGeneration?.answer) ? 'ai_provider' : 'deterministic_template',
        routeDecision,
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
      routeDecision,
      assumptions: [
        ...investigationAssumptions(intent, selected, generatedSql, sqlError),
        ...(baselineGap ? ['The selected tile sample does not include at least two comparable time values, so DQL did not invent a change query from an unrelated table.'] : []),
      ],
      context,
      agentEvidence: narrativeGeneration?.evidence ?? agentGeneration?.evidence,
      analysisPlan: narrativeGeneration?.analysisPlan ?? agentGeneration?.analysisPlan,
      citations: narrativeGeneration?.citations ?? agentGeneration?.citations,
    };
    const summary = cleanString(narrativeGeneration?.answer) || fallbackSummary;
    const reportSections = buildInvestigationReportSections({
      intent,
      question,
      context,
      selected,
      metrics: metricSnapshot,
      drivers: driverCards,
      summary,
      recommendation,
      agentAnswer: narrativeGeneration?.answer,
      hasReportEvidence,
      sqlError: reportSqlError,
      sqlErrorKind,
      baselineGap,
    });
    return storage.updateAppInvestigation(investigation.id, {
      title,
      question,
      intent,
      context,
      status: sqlEvidence.fatal && !hasReportEvidence ? 'error' : 'ready',
      summary,
      recommendation,
      metrics: metricSnapshot,
      driverCards,
      resultPreviews: previews,
      evidence,
      reportSections,
      generatedSql,
      reviewStatus: 'needs_review',
      error: reportSqlError ?? '',
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

function scheduleAppInvestigationRun(
  ctx: Ctx,
  appId: string,
  investigationId: string,
  input: AppInvestigationRunRequest | AppInvestigationCreateRequest,
): void {
  const runContext: Ctx = { ...ctx };
  setTimeout(() => {
    void (async () => {
      const storage = new LocalAppStorage(defaultLocalAppsDbPath(runContext.projectRoot));
      try {
        const current = storage.getAppInvestigation(investigationId);
        if (!current || current.appId !== appId) return;
        await runAppInvestigation(runContext, storage, current, input);
      } finally {
        storage.close();
      }
    })();
  }, 0);
}

function createOrReuseAppInvestigation(
  storage: LocalAppStorage,
  input: AppInvestigationCreateRequest & {
    appId: string;
    question: string;
    sourceTileId?: string;
    sourceBlockId?: string;
    intent?: LocalAppInvestigationIntent;
  },
): LocalAppInvestigation {
  if (!cleanString(input.generatedSql)) {
    const reusable = findReusableAppInvestigation(storage, {
      appId: input.appId,
      dashboardId: input.dashboardId,
      sourceTileId: input.sourceTileId,
      sourceBlockId: input.sourceBlockId,
      question: input.question,
      intent: input.intent,
      context: input.context,
    });
    if (reusable) {
      return storage.updateAppInvestigation(reusable.id, {
        title: input.title ?? reusable.title,
        question: input.question,
        intent: input.intent ?? reusable.intent,
        context: input.context,
        dashboardId: input.dashboardId,
        sourceTileId: input.sourceTileId,
        sourceBlockId: input.sourceBlockId,
      }) ?? reusable;
    }
  }
  return storage.createAppInvestigation(input);
}

function findReusableAppInvestigation(
  storage: LocalAppStorage,
  input: {
    appId: string;
    dashboardId?: string;
    sourceTileId?: string;
    sourceBlockId?: string;
    question: string;
    intent?: LocalAppInvestigationIntent;
    context?: unknown;
  },
): LocalAppInvestigation | null {
  const storageWithMethod = storage as LocalAppStorage & {
    findReusableAppInvestigation?: (value: typeof input) => LocalAppInvestigation | null;
  };
  if (typeof storageWithMethod.findReusableAppInvestigation === 'function') {
    return storageWithMethod.findReusableAppInvestigation(input);
  }
  const target = appInvestigationReuseFingerprint(input);
  return storage.listAppInvestigations(input.appId, input.dashboardId).find((item) => {
    if (item.reviewStatus === 'rejected') return false;
    return appInvestigationReuseFingerprint(item) === target;
  }) ?? null;
}

function appInvestigationReuseFingerprint(input: {
  appId: string;
  dashboardId?: string;
  sourceTileId?: string;
  sourceBlockId?: string;
  question: string;
  intent?: LocalAppInvestigationIntent;
  context?: unknown;
}): string {
  return [
    normalizeFingerprintString(input.appId),
    normalizeFingerprintString(input.dashboardId),
    normalizeFingerprintString(input.sourceTileId),
    normalizeFingerprintString(input.sourceBlockId),
    normalizeFingerprintString(input.question),
    normalizeFingerprintString(input.intent ?? 'driver_breakdown'),
    stableInvestigationFingerprintValue(input.context),
  ].join('|');
}

function normalizeFingerprintString(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

function stableInvestigationFingerprintValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  return JSON.stringify(stableInvestigationFingerprintObject(value));
}

function stableInvestigationFingerprintObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableInvestigationFingerprintObject);
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (/^(nonce|timestamp|createdAt|updatedAt|lastRunAt)$/i.test(key)) continue;
    out[key] = stableInvestigationFingerprintObject(record[key]);
  }
  return out;
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
  const topRow = rows.find((row) => typeofNumber(row[metricColumn]) !== null);
  const comparisonRow = rows.slice(1).find((row) => typeofNumber(row[metricColumn]) !== null);
  const dimensionColumn = columns.find((column) => column !== metricColumn && rows.some((row) => typeof row[column] === 'string'));
  const currentValue = typeofNumber(topRow?.[metricColumn]);
  const baselineValue = typeofNumber(comparisonRow?.[metricColumn]);
  const delta = currentValue !== null && baselineValue !== null ? currentValue - baselineValue : undefined;
  const topLabel = dimensionColumn && topRow ? cleanString(topRow[dimensionColumn]) : '';
  const comparisonLabel = dimensionColumn && comparisonRow ? cleanString(comparisonRow[dimensionColumn]) : '';
  return {
    metric: metricColumn,
    currentValue,
    baselineValue,
    delta,
    currentLabel: 'Top value',
    baselineLabel: 'Next comparison',
    deltaLabel: 'Top gap',
    currentDetail: topLabel ? `${topLabel} / ${metricColumn}` : 'highest ranked evidence row',
    baselineDetail: comparisonLabel ? `${comparisonLabel} / ${metricColumn}` : 'next comparable evidence row',
    deltaDetail: comparisonLabel ? `difference between ${topLabel || 'top row'} and ${comparisonLabel}` : 'difference to next comparison',
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
    context?: unknown;
  },
): { sql: string; sourceBlockPath: string; sourceBlockName: string } | undefined {
  if (input.intent === 'trust_gap_review') return undefined;
  const block = resolveSelectedBlock(projectRoot, input.selected, input.sourceBlockId);
  if (!block) return undefined;
  const source = readFileSync(join(projectRoot, block.path), 'utf-8');
  const rawBlockSql = extractDqlQuery(source);
  if (!rawBlockSql) return undefined;
  const rendered = renderSqlTemplateParams(
    rawBlockSql,
    buildInvestigationSqlTemplateValues(projectRoot, input.context, input.selected, input.sourceBlockId),
  );
  const blockSql = rendered.sql;
  if (rendered.unresolved.length > 0 || /\{\{/.test(blockSql) || !isReadOnlySql(blockSql)) return undefined;
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
    const timeoutMs = appResearchAiTimeoutMs();
    const result = await boundedPromise(ctx.generateInvestigationSql(input), timeoutMs);
    if (result.timedOut) {
      return {
        executionError: `AI SQL generation timed out after ${Math.round(timeoutMs / 1000)}s. DQL continued with deterministic app evidence and kept the analysis review-required.`,
      };
    }
    return result.value;
  } catch (err) {
    return {
      executionError: err instanceof Error ? err.message : String(err),
    };
  }
}

function shouldRequestProviderMemo(input: {
  ctx: Ctx;
  generatedSql?: string;
  agentGeneration?: AppInvestigationGenerationResult;
  hasReportEvidence: boolean;
}): boolean {
  if (!input.ctx.generateInvestigationSql) return false;
  if (cleanString(input.agentGeneration?.answer)) return false;
  return input.hasReportEvidence || Boolean(cleanString(input.generatedSql));
}

async function runGeneratedSqlPreview(
  ctx: Ctx,
  generatedSql?: string,
): Promise<{ preview?: Record<string, unknown>; error?: string; fatal?: boolean }> {
  const sql = cleanString(generatedSql);
  if (!sql) return {};
  const unresolved = unresolvedSqlTemplateParams(sql);
  if (unresolved.length > 0) {
    return {
      error: `Generated SQL was not run because unresolved DQL parameters remain: ${unresolved.join(', ')}.`,
      fatal: false,
    };
  }
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
    const timeoutMs = appResearchPreviewTimeoutMs();
    const result = await boundedPromise(
      ctx.executeSql(boundedPreviewSql(sql)),
      timeoutMs,
    );
    if (result.timedOut) {
      return {
        error: `Generated SQL preview timed out after ${Math.round(timeoutMs / 1000)}s. The analysis was created from selected app evidence; review or simplify the SQL before promotion.`,
        fatal: false,
      };
    }
    return {
      preview: {
        id: 'generated-sql-preview',
        title: 'Generated SQL preview',
        kind: 'table',
        reviewRequired: true,
        result: result.value,
      },
    };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
      fatal: true,
    };
  }
}

async function boundedPromise<T>(promise: Promise<T>, timeoutMs: number): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function appResearchPreviewTimeoutMs(): number {
  const raw = Number(process.env.DQL_APP_RESEARCH_PREVIEW_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 500) return Math.min(raw, 120000);
  return 12000;
}

function appResearchAiTimeoutMs(): number {
  const raw = Number(process.env.DQL_APP_RESEARCH_AI_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 500) return Math.min(raw, 120000);
  return 12000;
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

type SqlPreviewErrorKind = 'runtime_unavailable' | 'ai_generation_timeout' | 'timeout' | 'sql_repair' | 'safety' | 'unknown';

function classifySqlPreviewError(error?: string): SqlPreviewErrorKind | undefined {
  const value = cleanString(error);
  if (!value) return undefined;
  if (/\bAI SQL generation timed out\b/i.test(value)) return 'ai_generation_timeout';
  if (/\b(warehouse|suspended|resume|authenticat|permission|privilege|network|connection|connect|host cannot execute|cannot execute|not configured)\b/i.test(value)) {
    return 'runtime_unavailable';
  }
  if (/\b(timed out|timeout)\b/i.test(value)) return 'timeout';
  if (/\b(not a read-only|not read-only|insert|update|delete|drop|alter|create|merge|truncate|grant|revoke)\b/i.test(value)) {
    return 'safety';
  }
  if (/\b(unresolved|parameter|invalid identifier|syntax|compilation|parse|unknown column|does not exist|ambiguous|not found)\b/i.test(value)) {
    return 'sql_repair';
  }
  return 'unknown';
}

function shouldSurfaceSqlPreviewIssue(input: {
  sqlError?: string;
  sqlErrorKind?: SqlPreviewErrorKind;
  generatedSql?: string;
  hasReportEvidence: boolean;
}): boolean {
  const error = cleanString(input.sqlError);
  if (!error) return false;
  if (
    input.hasReportEvidence &&
    !cleanString(input.generatedSql) &&
    (input.sqlErrorKind === 'unknown' || /\bAI provider did not return a governed answer\b/i.test(error))
  ) {
    return false;
  }
  return true;
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
    label: 'AI-generated analysis',
    uncertified: true,
    reviewStatus: 'needs_review',
    certifiedContext: selectedString(selected, 'certificationStatus') === 'certified' ? 'selected tile is certified' : 'selected tile certification needs review',
    sourceBlockId: investigation.sourceBlockId ?? selectedString(selected, 'blockId'),
    sourceTileId: investigation.sourceTileId ?? selectedString(selected, 'tileId'),
    caveats: [
      'Analysis output is not certified until a reviewer promotes or certifies the generated block.',
      ...(sqlError ? [`SQL preview caveat: ${sqlError}`] : []),
    ],
  };
}

function investigationSteps(intent: LocalAppInvestigationIntent): string[] {
  const common = ['trust check', 'proof capture'];
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
  const cleanQuestion = cleanInvestigationQuestion(question);
  const metricName = cleanString(metrics.metric) || 'selected metric';
  const currentValue = typeofNumber(metrics.currentValue);
  const baselineValue = typeofNumber(metrics.baselineValue);
  const deltaValue = typeofNumber(metrics.delta);
  const currentDetail = cleanString(metrics.currentDetail);
  const baselineDetail = cleanString(metrics.baselineDetail);
  const currentLabel = currentDetail ? currentDetail.replace(/\s*\/\s*[^/]+$/, '') : cleanString(metrics.currentLabel) || 'Current result';
  const baselineLabel = baselineDetail ? baselineDetail.replace(/\s*\/\s*[^/]+$/, '') : cleanString(metrics.baselineLabel) || 'comparison';
  const valueSentence = currentValue !== null
    ? `${currentLabel} leads on ${metricName} with ${formatMetricValue(currentValue)}${baselineValue !== null ? ` versus ${formatMetricValue(baselineValue)} for ${baselineLabel}` : ''}${deltaValue !== null ? `, a gap of ${formatMetricValue(deltaValue)}` : ''}.`
    : '';
  if (intent === 'trust_gap_review') {
    return `This tile can be used as certified context only where its source block and lineage are certified. ${valueSentence || 'The deeper answer is AI-generated analysis and needs review before leaders rely on it.'}`;
  }
  const driverTitle = cleanString(drivers[0]?.title);
  const driver = driverTitle && driverTitle !== currentLabel
    ? ` ${driverTitle} is the strongest visible driver in the bounded preview.`
    : '';
  const reviewBoundary = ' This remains review-required until SQL, grain, filters, and lineage are confirmed.';
  if (valueSentence) {
    return `${valueSentence}${driver}${reviewBoundary}`.trim();
  }
  const fallbackSubject = cleanQuestion || target;
  return `This analysis investigates ${fallbackSubject}. The preview is bounded to the selected app context and needs analyst review before it becomes governed business logic.`;
}

function cleanInvestigationQuestion(value: string): string {
  return cleanString(value)
    .replace(/^\/(ask|research|report|analy[sz]e|analysis|proof|evidence|validate|verify|add\s+block|create\s+block|draft\s+block|block)\b/i, '')
    .replace(/^(Analysis goal|Analysis question|Research question|Evidence question|Validation question|Reusable block goal|Business question|Question):\s*/i, '')
    .replace(/\bCurrent app filters:\s*[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*[.?!]+$/, '')
    .trim();
}

function buildMissingBaselineSummary(
  question: string,
  selected: Record<string, unknown> | null,
): string {
  const target = selectedString(selected, 'title') ?? 'the selected tile';
  return `DQL opened review-required analysis for ${target}: ${question}. The selected tile shows the current certified result, but its sample does not include a comparable prior period or historical snapshot, so DQL cannot calculate what changed without guessing.`;
}

function buildMissingBaselineRecommendation(selected: Record<string, unknown> | null): string {
  const target = selectedString(selected, 'title') ?? 'this tile';
  return `Use ${target} as current-state evidence. To explain change, add or select a block with a time grain, snapshot date, or prior-period baseline, then rerun the analysis.`;
}

function buildInvestigationRecommendation(
  intent: LocalAppInvestigationIntent,
  selected: Record<string, unknown> | null,
  sqlError?: string,
  sqlErrorKind?: SqlPreviewErrorKind,
): string {
  if (sqlErrorKind === 'runtime_unavailable') return 'Resume or choose an active warehouse, then refresh the analysis. Keep the generated SQL review-required until a preview runs successfully.';
  if (sqlErrorKind === 'ai_generation_timeout') return 'Use the certified app result as the current answer, then retry AI SQL generation or draft the scoped SQL manually before promotion.';
  if (sqlErrorKind === 'timeout') return 'Simplify the generated SQL or narrow the app filters, then refresh the bounded preview before promotion.';
  if (sqlErrorKind === 'safety') return 'Rewrite the SQL as a read-only SELECT/WITH query before any preview or promotion.';
  if (sqlError) return 'Review the generated SQL or add a certified drilldown block before promoting this result.';
  if (intent === 'trust_gap_review') return 'Use the certified tile for stakeholder reporting, and promote only the reviewed gaps into a draft block.';
  if (!selected) return 'Select a dashboard tile or provide SQL so DQL can rank drivers with stronger evidence.';
  return 'Review the driver evidence, then pin the useful answer or promote the SQL path into a draft DQL block.';
}

function buildInvestigationReportSections(input: {
  intent: LocalAppInvestigationIntent;
  question: string;
  context: unknown;
  selected: Record<string, unknown> | null;
  metrics: Record<string, unknown>;
  drivers: Array<Record<string, unknown>>;
  summary: string;
  recommendation: string;
  agentAnswer?: string;
  hasReportEvidence?: boolean;
  sqlError?: string;
  sqlErrorKind?: SqlPreviewErrorKind;
  baselineGap?: boolean;
}): LocalAppInvestigationReportSection[] {
  const actionMode = cleanString(asRecord(input.context)?.actionMode);
  const sourceName = selectedString(input.selected, 'title') ?? selectedString(input.selected, 'blockId') ?? 'selected app result';
  const topNumber = reportMetricBullet(input.metrics, 'current');
  const comparison = reportMetricBullet(input.metrics, 'baseline');
  const delta = reportMetricBullet(input.metrics, 'delta');
  const keyBullets = [topNumber, comparison, delta].filter((item): item is string => Boolean(item));
  const driver = cleanString(input.drivers[0]?.title);
  const driverValue = cleanString(input.drivers[0]?.contribution ?? input.drivers[0]?.value ?? input.drivers[0]?.metric);
  const nextDriver = cleanString(input.drivers[1]?.title);
  const interpretation = reportInterpretationForIntent({
    intent: input.intent,
    actionMode,
    sourceName,
    driver,
    driverValue,
    nextDriver,
    baselineGap: input.baselineGap,
  });
  const interpretationMeta = reportInterpretationMeta(input.intent, actionMode);
  const providerSections = extractProviderReportSections(input.agentAnswer);
  if (providerSections.length >= 2) {
    const sections = [...providerSections];
    if (keyBullets.length > 0 && !hasReportSection(sections, /\b(number|metric|kpi|value)\b/i)) {
      sections.push({
        id: 'key-numbers',
        kind: 'key_numbers',
        title: keyNumbersTitleForIntent(input.intent),
        body: keyNumbersBodyForIntent(input.intent),
        tone: 'insight',
        bullets: keyBullets,
        evidenceRefs: reportEvidenceRefs(input.selected),
      });
    }
    if (input.baselineGap && !hasReportSection(sections, /\b(missing|baseline|comparison)\b/i)) {
      sections.push({
        id: 'missing-comparison',
        kind: 'custom',
        title: 'Missing comparison',
        body: 'The selected dashboard sample does not contain a second comparable period or baseline. DQL preserved the current certified result and stopped short of inventing a change explanation from unrelated data.',
        tone: 'warning',
        evidenceRefs: reportEvidenceRefs(input.selected),
      });
    }
    const previewIssue = input.hasReportEvidence && input.sqlErrorKind === 'runtime_unavailable'
      ? undefined
      : reportPreviewIssue(input.sqlError, input.sqlErrorKind);
    if (previewIssue && !hasReportSection(sections, /\b(sql|preview|repair|warehouse|runtime)\b/i)) {
      sections.push({
        id: previewIssue.id,
        kind: 'custom',
        title: previewIssue.title,
        body: previewIssue.body,
        tone: previewIssue.tone,
      });
    }
    if (!hasReportSection(sections, /\b(next|recommend|action)\b/i)) {
      sections.push({
        id: 'recommended-next-step',
        kind: 'recommended_next_step',
        title: 'Recommended next step',
        body: input.recommendation,
        tone: input.sqlError ? 'warning' : 'neutral',
      });
    }
    if (!hasReportSection(sections, /\b(review boundary|review-required|governed boundary|trust boundary)\b/i)) {
      sections.push({
        id: 'review-boundary',
        kind: 'review_boundary',
        title: 'Review boundary',
        body: 'This analysis is AI-generated and review-required. Use it to guide decisions, then validate SQL, grain, filters, joins, and source proof before pinning it to the app or turning it into a reusable DQL block.',
        tone: 'review',
      });
    }
    return sections.filter((section) => cleanString(section.body));
  }
  const sections: LocalAppInvestigationReportSection[] = [
    {
      id: 'executive-answer',
      kind: 'executive_answer',
      title: 'Executive answer',
      body: input.summary,
      tone: 'answer',
      evidenceRefs: reportEvidenceRefs(input.selected),
    },
    {
      id: interpretationMeta.id,
      kind: interpretationMeta.kind,
      title: interpretationMeta.title,
      body: interpretation,
      tone: interpretationMeta.tone,
      evidenceRefs: reportEvidenceRefs(input.selected),
    },
  ];

  if (keyBullets.length > 0) {
    sections.push({
      id: 'key-numbers',
      kind: 'key_numbers',
      title: keyNumbersTitleForIntent(input.intent),
      body: keyNumbersBodyForIntent(input.intent),
      tone: 'insight',
      bullets: keyBullets,
      evidenceRefs: reportEvidenceRefs(input.selected),
    });
  }

  if (input.baselineGap) {
    sections.push({
      id: 'missing-comparison',
      kind: 'custom',
      title: 'Missing comparison',
      body: 'The selected dashboard sample does not contain a second comparable period or baseline. DQL preserved the current certified result and stopped short of inventing a change explanation from unrelated data.',
      tone: 'warning',
      evidenceRefs: reportEvidenceRefs(input.selected),
    });
  }

  const previewIssue = input.hasReportEvidence && input.sqlErrorKind === 'runtime_unavailable'
    ? undefined
    : reportPreviewIssue(input.sqlError, input.sqlErrorKind);
  if (previewIssue) {
    sections.push({
      id: previewIssue.id,
      kind: 'custom',
      title: previewIssue.title,
      body: previewIssue.body,
      tone: previewIssue.tone,
    });
  }

  sections.push(
    {
      id: 'recommended-next-step',
      kind: 'recommended_next_step',
      title: 'Recommended next step',
      body: input.recommendation,
      tone: input.sqlError ? 'warning' : 'neutral',
    },
    {
      id: 'review-boundary',
      kind: 'review_boundary',
      title: 'Review boundary',
      body: 'This analysis is AI-generated and review-required. Use it to guide decisions, then validate SQL, grain, filters, joins, and source proof before pinning it to the app or turning it into a reusable DQL block.',
      tone: 'review',
    },
  );

  return sections.filter((section) => cleanString(section.body));
}

function extractProviderReportSections(answer?: string): LocalAppInvestigationReportSection[] {
  const raw = cleanString(answer);
  if (!raw) return [];
  const text = raw
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*(SQL|Query)\s*:.*$/gim, '')
    .trim();
  const matches = Array.from(text.matchAll(/^#{2,4}\s+(.+)$/gm));
  if (matches.length < 2) return [];
  const sections: LocalAppInvestigationReportSection[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const title = cleanProviderReportTitle(match[1]);
    const next = matches[index + 1];
    const bodyText = text.slice((match.index ?? 0) + match[0].length, next?.index ?? text.length).trim();
    if (!title || !bodyText || isTraceOnlyProviderSection(title)) continue;
    const id = slugify(title) || `section-${index + 1}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const parsed = parseProviderSectionBody(bodyText);
    if (!parsed.body) continue;
    sections.push({
      id,
      kind: providerReportKind(title),
      title,
      body: parsed.body,
      bullets: parsed.bullets,
      tone: providerReportTone(title),
    });
  }
  return sections.slice(0, 8);
}

function cleanProviderReportTitle(value: string): string {
  return cleanString(value)
    .replace(/\*\*/g, '')
    .replace(/[:：]\s*$/, '')
    .replace(/^\d+[.)]\s*/, '')
    .trim()
    .slice(0, 90);
}

function isTraceOnlyProviderSection(title: string): boolean {
  return /\b(sql|query|raw trace|appendix|implementation detail)\b/i.test(title);
}

function parseProviderSectionBody(value: string): { body: string; bullets?: string[] } {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^#{1,6}\s+/.test(line));
  const bullets: string[] = [];
  const prose: string[] = [];
  for (const line of lines) {
    const bullet = /^[-*]\s+(.+)$/.exec(line)?.[1]?.trim();
    if (bullet) {
      bullets.push(bullet);
      continue;
    }
    prose.push(line);
  }
  const body = prose.join('\n\n') || bullets.slice(0, 3).join(' ');
  return {
    body: cleanString(body),
    bullets: bullets.length ? bullets.slice(0, 8) : undefined,
  };
}

function providerReportKind(title: string): LocalAppInvestigationReportSection['kind'] {
  if (/\b(executive|answer|summary|decision)\b/i.test(title)) return 'executive_answer';
  if (/\b(number|metric|kpi|value)\b/i.test(title)) return 'key_numbers';
  if (/\b(driver|why|interpret|segment|movement|trend|entity|anomaly)\b/i.test(title)) return 'business_interpretation';
  if (/\b(proof|validate|evidence|trust)\b/i.test(title)) return 'validation';
  if (/\b(block|logic|reuse|contract)\b/i.test(title)) return 'reusable_logic';
  if (/\b(next|recommend|action)\b/i.test(title)) return 'recommended_next_step';
  if (/\b(caveat|review|boundary|risk|assumption)\b/i.test(title)) return 'review_boundary';
  return 'custom';
}

function providerReportTone(title: string): LocalAppInvestigationReportSection['tone'] {
  if (/\b(executive|answer|summary|decision)\b/i.test(title)) return 'answer';
  if (/\b(driver|why|interpret|segment|movement|trend|number|metric|kpi|value)\b/i.test(title)) return 'insight';
  if (/\b(caveat|warning|risk|missing|error|unavailable|anomaly)\b/i.test(title)) return 'warning';
  if (/\b(proof|validate|evidence|trust|review|boundary|block|logic|reuse)\b/i.test(title)) return 'review';
  return 'neutral';
}

function hasReportSection(
  sections: LocalAppInvestigationReportSection[],
  pattern: RegExp,
): boolean {
  return sections.some((section) => pattern.test(section.title) || pattern.test(section.kind));
}

function reportPreviewIssue(
  sqlError?: string,
  sqlErrorKind?: SqlPreviewErrorKind,
): Pick<LocalAppInvestigationReportSection, 'id' | 'title' | 'body' | 'tone'> | undefined {
  if (!sqlError) return undefined;
  if (sqlErrorKind === 'runtime_unavailable') {
    return {
      id: 'preview-unavailable',
      title: 'Preview unavailable',
      body: 'The generated SQL was not proven because the warehouse or execution runtime is unavailable. Resume or choose an active warehouse, then refresh the analysis. Do not edit business logic just to fix an infrastructure issue.',
      tone: 'warning',
    };
  }
  if (sqlErrorKind === 'ai_generation_timeout') {
    return {
      id: 'ai-generation-timeout',
      title: 'AI SQL generation timed out',
      body: 'DQL did not receive generated SQL inside the bounded AI window. The memo uses certified app evidence only; retry AI generation, provide reviewed SQL, or draft reusable logic manually before promoting this analysis.',
      tone: 'warning',
    };
  }
  if (sqlErrorKind === 'timeout') {
    return {
      id: 'preview-timeout',
      title: 'Preview timed out',
      body: 'The generated SQL did not finish inside the bounded preview window. Narrow the filters, simplify the SQL, or rerun when the warehouse is responsive before promoting this analysis.',
      tone: 'warning',
    };
  }
  if (sqlErrorKind === 'safety') {
    return {
      id: 'sql-safety-check',
      title: 'SQL safety check',
      body: 'DQL blocked the preview because the SQL was not a read-only SELECT/WITH statement. Rewrite it as safe analytical SQL before running, pinning, or promoting.',
      tone: 'warning',
    };
  }
  return {
    id: 'sql-repair-path',
    title: 'SQL repair path',
    body: 'The generated SQL preview needs review before this analysis can be promoted. Open the trace appendix, edit the SQL against the selected block context, rerun the preview, then pin or draft reusable logic only after the row sample matches the business question.',
    tone: 'warning',
  };
}

function reportInterpretationMeta(
  intent: LocalAppInvestigationIntent,
  actionMode?: string,
): Pick<LocalAppInvestigationReportSection, 'id' | 'kind' | 'title' | 'tone'> {
  if (actionMode === 'block') {
    return { id: 'reusable-logic', kind: 'reusable_logic', title: 'Reusable logic decision', tone: 'review' };
  }
  if (actionMode === 'evidence' || intent === 'trust_gap_review') {
    return { id: 'validation-result', kind: 'validation', title: 'Validation result', tone: 'review' };
  }
  if (intent === 'diagnose_change') {
    return { id: 'change-explanation', kind: 'business_interpretation', title: 'Change explanation', tone: 'insight' };
  }
  if (intent === 'segment_compare') {
    return { id: 'segment-readout', kind: 'business_interpretation', title: 'Segment readout', tone: 'insight' };
  }
  if (intent === 'entity_drilldown') {
    return { id: 'entity-drilldown', kind: 'business_interpretation', title: 'Entity drilldown', tone: 'insight' };
  }
  if (intent === 'anomaly_investigation') {
    return { id: 'anomaly-readout', kind: 'business_interpretation', title: 'Anomaly readout', tone: 'warning' };
  }
  return { id: 'driver-readout', kind: 'business_interpretation', title: 'Driver readout', tone: 'insight' };
}

function reportInterpretationForIntent(input: {
  intent: LocalAppInvestigationIntent;
  actionMode?: string;
  sourceName: string;
  driver?: string;
  driverValue?: string;
  nextDriver?: string;
  baselineGap?: boolean;
}): string {
  if (input.baselineGap) {
    return 'This is a current-state answer, not a completed change explanation. The analysis has enough proof to show the selected result, but it does not have a comparable prior period or baseline needed to explain movement responsibly.';
  }
  if (input.actionMode === 'block') {
    return 'This is a reusable-logic candidate. Preserve the business question, parameters, allowed filters, output grain, source proof, and review path before certification.';
  }
  if (input.actionMode === 'evidence' || input.intent === 'trust_gap_review') {
    return `This validation is bounded to ${input.sourceName}. Treat the claim as trusted only after source block, lineage, filters, and preview rows are reviewed.`;
  }
  if (input.driver) {
    const driverSentence = `${input.driver} is the strongest visible driver${input.driverValue ? ` (${input.driverValue})` : ''}.`;
    const comparisonSentence = input.nextDriver ? ` The next visible comparison is ${input.nextDriver}.` : '';
    const reviewSentence = ' Treat the interpretation as directional until a reviewer confirms SQL, grain, filters, joins, and lineage.';
    if (input.intent === 'segment_compare') return `${driverSentence}${comparisonSentence} Use this as a segment readout only after confirming the grouping field and filter bindings.${reviewSentence}`;
    if (input.intent === 'entity_drilldown') return `${driverSentence}${comparisonSentence} Use this as an entity drilldown only after confirming the entity identifier and output grain.${reviewSentence}`;
    if (input.intent === 'anomaly_investigation') return `${driverSentence}${comparisonSentence} Review the baseline, outlier rows, and time grain before treating this as an anomaly narrative.${reviewSentence}`;
    if (input.intent === 'diagnose_change') return `${driverSentence}${comparisonSentence} Confirm a comparable baseline or prior period before treating this as a causal change explanation.${reviewSentence}`;
    return `${driverSentence}${comparisonSentence}${reviewSentence}`;
  }
  if (input.intent === 'diagnose_change') {
    return 'The analysis does not yet have a comparable baseline or ranked drivers. Add a time grain, prior-period block, or segment field before treating the change explanation as complete.';
  }
  if (input.intent === 'segment_compare') {
    return 'The analysis does not yet have a clear segment grouping. Add a segment field or certified breakdown block before using this as a stakeholder segment comparison.';
  }
  if (input.intent === 'entity_drilldown') {
    return 'The analysis does not yet have a stable entity identifier. Add the entity key and output grain before using this as a stakeholder drilldown.';
  }
  return 'The analysis does not yet have ranked drivers. Add a clearer metric, time grain, or segment field before treating it as complete.';
}

function keyNumbersTitleForIntent(intent: LocalAppInvestigationIntent): string {
  if (intent === 'diagnose_change') return 'Movement numbers';
  if (intent === 'segment_compare') return 'Segment numbers';
  if (intent === 'entity_drilldown') return 'Entity numbers';
  if (intent === 'anomaly_investigation') return 'Anomaly numbers';
  if (intent === 'trust_gap_review') return 'Validation numbers';
  return 'Key numbers';
}

function keyNumbersBodyForIntent(intent: LocalAppInvestigationIntent): string {
  if (intent === 'diagnose_change') return 'The bounded preview includes the values DQL can prove for this movement question. Use them for stakeholder framing, but validate the baseline and time grain before promotion.';
  if (intent === 'segment_compare') return 'The bounded preview includes the segment values DQL can compare from the selected context. Confirm the grouping field and filters before promotion.';
  if (intent === 'entity_drilldown') return 'The bounded preview includes entity-level values from the selected context. Confirm the entity key and grain before promotion.';
  if (intent === 'anomaly_investigation') return 'The bounded preview includes values that may explain the exception. Confirm the baseline, threshold, and time grain before promotion.';
  if (intent === 'trust_gap_review') return 'The bounded preview includes values available for validation. Confirm source proof, lineage, and owner review before promotion.';
  return 'The bounded preview includes the following decision-relevant values. These are useful for stakeholder framing but still require source validation before promotion.';
}

function investigationNarrativeAnswer(investigation: LocalAppInvestigation): string {
  const sections = Array.isArray(investigation.reportSections)
    ? investigation.reportSections
      .filter((section) => cleanString(section?.title) && cleanString(section?.body))
      .slice(0, 8)
    : [];
  if (!sections.length) {
    return cleanString(investigation.summary)
      || cleanString(investigation.recommendation)
      || cleanString(investigation.title)
      || 'Review-required app analysis.';
  }

  const stakeholderSections = sections
    .filter((section) => {
      if (section.kind === 'review_boundary') return false;
      return !/\b(sql|query|appendix|technical|repair|preview error)\b/i.test(section.title);
    })
    .slice(0, 5);

  return (stakeholderSections.length ? stakeholderSections : sections.slice(0, 3)).map((section) => {
    const bullets = Array.isArray(section.bullets) && section.bullets.length
      ? `\n${section.bullets.filter(Boolean).slice(0, 8).map((bullet) => `- ${bullet}`).join('\n')}`
      : '';
    return `## ${section.title.trim()}\n${section.body.trim()}${bullets}`;
  }).join('\n\n');
}

function reportMetricBullet(metrics: Record<string, unknown>, role: 'current' | 'baseline' | 'delta'): string | undefined {
  const prefix = role === 'current' ? 'current' : role === 'baseline' ? 'baseline' : 'delta';
  const label = cleanString(metrics[`${prefix}Label`])
    || (role === 'current' ? 'Top value' : role === 'baseline' ? 'Next comparison' : 'Gap');
  const value = typeofNumber(metrics[role === 'current' ? 'currentValue' : role === 'baseline' ? 'baselineValue' : 'delta']);
  if (value === null) return undefined;
  const detail = cleanString(metrics[`${prefix}Detail`]);
  return `${label}: ${formatMetricValue(value)}${detail ? ` (${detail})` : ''}`;
}

function reportEvidenceRefs(selected: Record<string, unknown> | null): string[] {
  return [
    selectedString(selected, 'blockId') ? `block:${selectedString(selected, 'blockId')}` : '',
    selectedString(selected, 'tileId') ? `tile:${selectedString(selected, 'tileId')}` : '',
    selectedString(selected, 'blockPath') ?? '',
  ].filter(Boolean);
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

function formatMetricValue(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 100) return Math.round(value).toLocaleString();
  return Number(value.toFixed(2)).toLocaleString();
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

function resolveAppPackageDir(projectRoot: string, id: string): string {
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
): { ok: true; pin: unknown; dashboard?: DashboardDocument; tile?: DashboardGridItem; deduped?: boolean } | { ok: false; error: string } {
  const dashboardId = cleanString(input.dashboardId);
  if (!dashboardId) return { ok: false, error: 'dashboardId is required' };
  const loaded = loadDashboardForApp(projectRoot, appId, dashboardId);
  if (!loaded) return { ok: false, error: `Dashboard "${dashboardId}" not found in app "${appId}"` };
  const title = cleanString(input.title) || 'AI result';
  const tileId = cleanString(input.tileId) || nextTileId(loaded.dashboard, slugify(title) || 'ai-pin');
  const storage = new LocalAppStorage(defaultLocalAppsDbPath(projectRoot));
  try {
    const existing = findExistingAiPinTile(storage, loaded.dashboard, appId, dashboardId, title, input);
    if (existing) {
      return { ok: true, pin: existing.pin, dashboard: loaded.dashboard, tile: existing.tile, deduped: true };
    }
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
    const vizType = normalizeVizTypeFromChart(input.chartConfig);
    const dqlArtifact = normalizeDqlArtifactReference(
      input.analysisPlan && typeof input.analysisPlan === 'object' && !Array.isArray(input.analysisPlan)
        ? (input.analysisPlan as Record<string, unknown>).dqlArtifact
        : undefined,
    );
    const runtimeParameters = (dqlArtifact?.parameters ?? []).filter((parameter) => parameter.policy === 'dynamic' || parameter.policy === 'optional');
    const tile: DashboardGridItem = {
      i: tileId,
      ...nextTilePosition(loaded.dashboard),
      aiPin: { id: pin.id },
      viz: { type: vizType },
      display: displayForAiPin(title, vizType, input),
      title,
      ...(runtimeParameters.length > 0 ? {
        parameterBindings: runtimeParameters.map((parameter) => ({
          param: parameter.name,
          source: 'dashboard_filter' as const,
          filter: parameter.name,
          field: parameter.binding?.kind === 'semantic_filter' ? parameter.binding.field : parameter.name,
          parameterType: parameter.type,
          required: parameter.required,
          ...(parameter.default === undefined ? {} : { default: parameter.default }),
          policy: parameter.policy,
        })),
        trustState: dqlArtifact?.trustState === 'certified' ? 'certified' as const : 'review_required' as const,
        reviewStatus: dqlArtifact?.trustState === 'certified' ? 'certified' as const : 'review_required' as const,
      } : {}),
    };
    const artifactFilters = runtimeParameters.map(dashboardFilterForArtifactParameter);
    const existingFilterIds = new Set((loaded.dashboard.filters ?? []).map((filter) => filter.id));
    const dashboard: DashboardDocument = {
      ...loaded.dashboard,
      ...(artifactFilters.length > 0 ? {
        filters: [
          ...(loaded.dashboard.filters ?? []),
          ...artifactFilters.filter((filter) => !existingFilterIds.has(filter.id)),
        ],
      } : {}),
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

function dashboardFilterForArtifactParameter(
  parameter: BlockParameterDefinition,
): DashboardFilter {
  const type: DashboardFilter['type'] = parameter.type === 'number'
    ? 'number'
    : parameter.type === 'boolean'
      ? 'boolean'
      : parameter.type === 'date'
        ? 'date'
        : parameter.type.endsWith('[]')
          ? 'select'
          : 'string';
  const options = Array.isArray(parameter.default) ? parameter.default.map(String) : undefined;
  return {
    id: parameter.name,
    type,
    ...(parameter.default === undefined ? {} : { default: parameter.default }),
    ...(options?.length ? { options } : {}),
    ...(parameter.binding?.kind === 'semantic_filter' ? { bindsTo: parameter.binding.field } : {}),
  };
}

function findExistingAiPinTile(
  storage: LocalAppStorage,
  dashboard: DashboardDocument,
  appId: string,
  dashboardId: string,
  title: string,
  input: AiPinCreateRequest,
): { pin: LocalAiPin; tile: DashboardGridItem } | null {
  const requested = aiPinDedupeFingerprint(title, input.question, input.analysisPlan, input.result);
  if (!requested) return null;
  const pins = storage.listAiPins(appId, dashboardId);
  for (const pin of pins) {
    const existing = aiPinDedupeFingerprint(pin.title, pin.question, pin.analysisPlan, pin.result);
    if (!existing || existing !== requested) continue;
    const tile = dashboard.layout.items.find((item) => item.aiPin?.id === pin.id || (pin.tileId && item.i === pin.tileId));
    if (tile) return { pin, tile };
  }
  return null;
}

function aiPinDedupeFingerprint(
  title: string | undefined,
  question: unknown,
  analysisPlan: unknown,
  result: unknown,
): string {
  const plan = asRecord(analysisPlan);
  const sourceBlock = cleanString(plan?.sourceBlockId);
  const sourceTile = cleanString(plan?.sourceTileId);
  const questionKey = normalizeAiPinDedupeText(question) || normalizeAiPinDedupeText(title);
  if (!questionKey && !sourceBlock && !sourceTile) return '';
  return [
    questionKey,
    sourceBlock,
    sourceTile,
    aiPinResultFingerprint(result),
  ].filter(Boolean).join('|');
}

function normalizeAiPinDedupeText(value: unknown): string {
  return cleanString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function aiPinResultFingerprint(result: unknown): string {
  const record = asRecord(result);
  if (!record) return '';
  const columns = Array.isArray(record.columns) ? record.columns.map((column) => String(column).toLowerCase()).join(',') : '';
  const rows = Array.isArray(record.rows) ? record.rows.slice(0, 8).map((row) => stableFingerprintValue(row)).join(';') : '';
  return columns || rows ? `${columns}:${rows}` : '';
}

function stableFingerprintValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return `[${value.map(stableFingerprintValue).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${key}:${stableFingerprintValue(record[key])}`).join(',')}}`;
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
    dqlnbVersion: 2,
    version: 1,
    title,
    metadata: {
      description: `Supporting notebook for ${app.name}`,
      status: 'draft',
      categories: [app.domain, app.subdomain, ...(app.groups ?? [])].filter(Boolean),
      ownerDomain: app.ownerDomain,
      usesDomains: app.usesDomains,
      purpose: app.purpose,
      requiredExports: app.requiredExports,
      classification: app.classification,
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
      return dedupeLocalAiPins(storage.listAiPins(appId));
    } finally {
      storage.close();
    }
  } catch {
    // AI pins are optional local overlays. Do not hide file-backed Apps when
    // the native SQLite module is unavailable for the current Node runtime.
    return [];
  }
}

function dedupeLocalAiPins(pins: LocalAiPin[]): LocalAiPin[] {
  const seen = new Set<string>();
  const out: LocalAiPin[] = [];
  for (const pin of pins) {
    const fingerprint = aiPinDedupeFingerprint(pin.title, pin.question, pin.analysisPlan, pin.result) || pin.id;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push(pin);
  }
  return out;
}

function listAppInvestigations(projectRoot: string, appId: string): unknown[] {
  const dbPath = defaultLocalAppsDbPath(projectRoot);
  if (!existsSync(dbPath)) return [];
  try {
    const storage = new LocalAppStorage(dbPath);
    try {
      return dedupeAppInvestigationsForDisplay(storage.listAppInvestigations(appId));
    } finally {
      storage.close();
    }
  } catch {
    return [];
  }
}

function dedupeAppInvestigationsForDisplay(investigations: LocalAppInvestigation[]): LocalAppInvestigation[] {
  const seen = new Set<string>();
  const out: LocalAppInvestigation[] = [];
  for (const investigation of investigations) {
    const fingerprint = appInvestigationReuseFingerprint(investigation);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push(investigation);
  }
  return out;
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
  buildMetricSnapshot,
  buildPreviewDriverCards,
  buildPreviewMetricSnapshot,
  buildDeterministicInvestigationSql,
  buildInvestigationSummary,
  buildInvestigationReportSections,
  classifySqlPreviewError,
  investigationNarrativeAnswer,
  createAiPinTile,
  runGeneratedSqlPreview,
  renderSqlTemplateParams,
  unresolvedSqlTemplateParams,
  selectedBlockContext,
  runAppInvestigation,
  askAppQuestion,
  collectAppsList,
  loadAppById,
};

// reference unused parseAppDocument/readFileSync to keep import stable for forward use
void parseAppDocument;
void readFileSync;
