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
} from '@duckcodeailabs/dql-project';

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  path: string;
  projectRoot: string;
  executeSql?: (sql: string) => Promise<unknown>;
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
    sendJson(res, 200, { notebooks: listNotebookCandidates(projectRoot, loaded.app, join(projectRoot, 'apps', appId)) });
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
          messages?: AppConversationMessageRequest[];
        }>(req);
        const conversation = storage.createAppConversation({
          appId,
          title: body.title,
          dashboardId: body.dashboardId,
          notebookPath: body.notebookPath,
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
          messages?: AppConversationMessageRequest[];
        }>(req);
        const updated = storage.updateAppConversation(conversationId, {
          title: body.title,
          dashboardId: body.dashboardId,
          notebookPath: body.notebookPath,
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
  template?: string;
  force?: boolean;
  selectedBlockIds?: string[];
}

const APP_PLAN_TEMPLATE_IDS = new Set([
  'executive_kpi_review',
  'revenue_health',
  'customer_360',
  'data_quality_monitor',
  'experiment_readout',
]);

interface AiPinCreateRequest {
  dashboardId?: string;
  tileId?: string;
  title?: string;
  answer?: string;
  sql?: string;
  sourceTier?: string;
  certification?: 'certified' | 'ai_generated';
  reviewStatus?: 'needs_review' | 'draft_created' | 'certified' | 'rejected';
  refreshCadence?: 'none' | 'daily';
  chartConfig?: Record<string, unknown>;
  result?: unknown;
  citations?: unknown[];
}

interface AppConversationMessageRequest {
  id?: string;
  role?: 'user' | 'assistant';
  content?: string;
  events?: unknown[];
  createdAt?: string;
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
    planAppFromPrompt,
    reindexProject,
    validateAppPlan,
  } = await import('@duckcodeailabs/dql-agent');

  const kgPath = defaultKgPath(projectRoot);
  await reindexProject(projectRoot, { kgPath });
  const kg = new KGStore(kgPath);
  try {
    const requestedTemplate = cleanString(input.template);
    const plan = planAppFromPrompt({
      prompt,
      kg,
      domain: cleanString(input.domain) || undefined,
      owner: cleanString(input.owner) || undefined,
      template: APP_PLAN_TEMPLATE_IDS.has(requestedTemplate) ? requestedTemplate as never : undefined,
      preferredBlockIds: selectedBlockIds,
    });
    const validation = validateAppPlan(plan, kg);
    const generated = generateAppFromPlan(projectRoot, plan, kg, {
      overwrite: Boolean(input.force),
    });
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
  const appDir = join(projectRoot, 'apps', id);
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
  const blocksDir = join(projectRoot, 'blocks');
  const blocks: BlockCandidate[] = [];
  if (!existsSync(blocksDir)) return blocks;
  const scanDir = (dir: string) => {
    for (const entry of readdirSyncSafe(dir)) {
      const filePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(filePath);
      } else if (entry.isFile() && entry.name.endsWith('.dql')) {
        try {
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
            path: filePath.slice(projectRoot.length + 1),
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
  scanDir(blocksDir);
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

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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

function createDashboardForApp(
  projectRoot: string,
  appId: string,
  input: { id?: string; title?: string; description?: string },
): { ok: true; dashboard: DashboardDocument; path: string } | { ok: false; error: string } {
  const loaded = loadAppById(projectRoot, appId);
  if (!loaded) return { ok: false, error: `App "${appId}" not found` };
  const title = cleanString(input.title) || 'New page';
  const id = slugify(cleanString(input.id) || title) || `page-${Date.now()}`;
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) return { ok: false, error: 'dashboard id must be folder-safe' };
  const appDir = join(projectRoot, 'apps', appId);
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
      sql: cleanString(input.sql) || undefined,
      sourceTier: cleanString(input.sourceTier) || undefined,
      certification: input.certification === 'certified' ? 'certified' : 'ai_generated',
      reviewStatus: input.reviewStatus,
      refreshCadence: input.refreshCadence === 'daily' ? 'daily' : 'none',
      chartConfig: input.chartConfig,
      result: input.result,
      citations: Array.isArray(input.citations) ? input.citations : [],
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
    const draftDir = join(projectRoot, 'apps', appId, 'drafts');
    const blockPath = join(draftDir, `${blockName}.dql`);
    mkdirSync(draftDir, { recursive: true });
    const source = [
      `block "${blockName}" {`,
      `  domain = "${escapeDqlString(loaded.app.domain)}"`,
      '  type = "custom"',
      '  status = "review"',
      `  owner = "${escapeDqlString(loaded.app.owners[0] ?? `${process.env.USER ?? 'analyst'}@local`)}"`,
      `  description = "${escapeDqlString(pin.answer.slice(0, 240))}"`,
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
  dashboards: Array<{ id: string; title: string; description?: string; itemCount: number }>;
  notebooks: AppListEntry['notebooks'];
  drafts: AppListEntry['drafts'];
  aiPins: unknown[];
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
      dashboards,
      notebooks: listAppNotebookRefs(projectRoot, document, appDir),
      drafts: listAppDrafts(projectRoot, appDir),
      aiPins: listAiPins(projectRoot, document.id),
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
  const appDir = join(projectRoot, 'apps', appId);
  const relPath = `apps/${appId}/notebooks/${slug}.dqlnb`;
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
  const appDir = join(projectRoot, 'apps', appId);
  if (!existsSync(join(appDir, 'dql.app.json'))) {
    return { ok: false, error: `App "${appId}" not found at ${appDir}` };
  }
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

// reference unused parseAppDocument/readFileSync to keep import stable for forward use
void parseAppDocument;
void readFileSync;
