/**
 * HTTP handlers for `/api/apps`, `/api/apps/:id`, `/api/apps/:id/dashboards/:did`,
 * `/api/persona`. Designed to be invoked from `local-runtime.ts`'s request
 * dispatcher — returns `true` if the request was handled, `false` otherwise.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  loadAppDocument,
  findAppDocuments,
  loadDashboardDocument,
  findDashboardsForApp,
  parseAppDocument,
  parseDashboardDocument,
  type AppDocument,
  type DashboardDocument,
} from '@duckcodeailabs/dql-core';
import {
  defaultPersonaRegistry,
  personaFromMember,
  type ActivePersona,
} from '@duckcodeailabs/dql-project';

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  path: string;
  projectRoot: string;
}

export async function handleAppsApi(ctx: Ctx): Promise<boolean> {
  const { req, res, path, projectRoot } = ctx;

  // ── Apps ────────────────────────────────────────────────────────────────

  if (req.method === 'GET' && path === '/api/apps') {
    const apps = collectAppsList(projectRoot);
    sendJson(res, 200, { apps });
    return true;
  }

  // /api/apps/:id  — single App with dashboards summary
  let m = path.match(/^\/api\/apps\/([^/]+)$/);
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

function collectAppsList(projectRoot: string): Array<{
  id: string;
  name: string;
  domain: string;
  description?: string;
  owners: string[];
  tags: string[];
  members: number;
  roles: number;
  policies: number;
  schedules: number;
  dashboards: Array<{ id: string; title: string }>;
  homepage?: AppDocument['homepage'];
}> {
  const out: Array<{
    id: string;
    name: string;
    domain: string;
    description?: string;
    owners: string[];
    tags: string[];
    members: number;
    roles: number;
    policies: number;
    schedules: number;
    dashboards: Array<{ id: string; title: string }>;
    homepage?: AppDocument['homepage'];
  }> = [];
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
      description: document.description,
      owners: document.owners,
      tags: document.tags ?? [],
      members: document.members.length,
      roles: document.roles.length,
      policies: document.policies.length,
      schedules: (document.schedules ?? []).length,
      dashboards,
      homepage: document.homepage,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function loadAppById(
  projectRoot: string,
  id: string,
): {
  app: AppDocument;
  dashboards: Array<{ id: string; title: string; description?: string; itemCount: number }>;
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
    return { app: document, dashboards };
  }
  return null;
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

async function writeDashboard(
  projectRoot: string,
  appId: string,
  dashboardId: string,
  payload: unknown,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
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
