/**
 * `dql app` — manage Apps (consumption-layer artifacts).
 *
 * Apps live at `apps/<id>/dql.app.json` and bundle dashboards/notebooks plus
 * declarative members, roles, policies, RLS bindings, and schedules. They're
 * compiled into the `apps[]` and `dashboards[]` records of `dql-manifest.json`
 * and read by both the desktop UI and the CLI.
 *
 * Subcommands:
 *   dql app new <id> --domain <domain> [--owner <user>]
 *   dql app ls
 *   dql app show <id>
 *   dql app build [--app <id>]
 *   dql app reindex [--app <id>]   (no-op until the agent KG package lands; aliased)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { resolveDbtManifestPath } from '@duckcodeailabs/dql-core';
import {
  buildManifest,
  loadAppDocument,
  findAppDocuments,
  loadDashboardDocument,
  findDashboardsForApp,
  suggestAppId,
  type AppDocument,
  type DashboardDocument,
  type ManifestApp,
} from '@duckcodeailabs/dql-core';
import type { CLIFlags } from '../args.js';
import { findProjectRoot } from '../local-runtime.js';

const APPS_ROOT = 'apps';

export async function runApp(
  sub: string | null,
  rest: string[],
  flags: CLIFlags,
): Promise<void> {
  switch (sub) {
    case 'new':
      return runAppNew(rest, flags);
    case 'ls':
    case 'list':
      return runAppList(flags);
    case 'show':
      return runAppShow(rest, flags);
    case 'build':
      return runAppBuild(flags);
    case 'reindex':
      return runAppReindex(flags);
    default:
      throw new Error(
        'Usage: dql app <new|ls|show|build|reindex> [args]\n' +
          '  dql app new <id> --domain <domain> [--owner <user>]\n' +
          '  dql app ls\n' +
          '  dql app show <id>\n' +
          '  dql app build\n' +
          '  dql app reindex',
      );
  }
}

// ---- new ----

async function runAppNew(rest: string[], flags: CLIFlags): Promise<void> {
  const rawId = rest[0];
  if (!rawId) {
    throw new Error('Usage: dql app new <id> --domain <domain> [--owner <user>]');
  }
  const domain = (flags as { domain?: string }).domain?.trim();
  if (!domain) throw new Error('--domain is required for "dql app new"');

  const id = suggestAppId(rawId);
  const projectRoot = findProjectRoot(process.cwd());
  const appDir = join(projectRoot, APPS_ROOT, id);

  if (existsSync(appDir)) {
    throw new Error(`App already exists at ${relFromRoot(projectRoot, appDir)}`);
  }

  const owner = (flags as { owner?: string }).owner?.trim() || `${process.env.USER ?? 'owner'}@local`;
  const displayName = humanise(id);

  const appJson: AppDocument = {
    version: 1,
    id,
    name: displayName,
    description: `${displayName} — consumption surface for ${domain}`,
    domain,
    owners: [owner],
    tags: [],
    members: [
      { userId: owner, displayName: owner, roles: ['owner'] },
    ],
    roles: [
      { id: 'owner', displayName: 'Owner', description: 'Full access to all dashboards and configuration.' },
      { id: 'analyst', displayName: 'Analyst', description: 'Can view and run dashboards, propose new blocks.' },
      { id: 'viewer', displayName: 'Viewer', description: 'Read-only access to certified dashboards.' },
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
        minClassification: 'confidential',
        allowedRoles: ['analyst', 'owner'],
        accessLevel: 'execute',
        enabled: true,
      },
    ],
    rlsBindings: [],
    schedules: [],
    homepage: { type: 'dashboard', id: 'overview' },
  };

  const overview: DashboardDocument = {
    version: 1,
    id: 'overview',
    metadata: {
      title: `${displayName} — Overview`,
      description: 'Default dashboard scaffolded by `dql app new`. Replace with your own blocks.',
      domain,
    },
    layout: {
      kind: 'grid',
      cols: 12,
      rowHeight: 80,
      items: [],
    },
  };

  mkdirSync(join(appDir, 'dashboards'), { recursive: true });
  mkdirSync(join(appDir, 'notebooks'), { recursive: true });
  writeFileSync(
    join(appDir, 'dql.app.json'),
    JSON.stringify(appJson, null, 2) + '\n',
    'utf-8',
  );
  writeFileSync(
    join(appDir, 'dashboards', 'overview.dqld'),
    JSON.stringify(overview, null, 2) + '\n',
    'utf-8',
  );

  const rel = relFromRoot(projectRoot, appDir);

  if ((flags as { format?: string }).format === 'json') {
    console.log(JSON.stringify({ created: true, id, path: rel }, null, 2));
    return;
  }
  console.log(`\n  ✓ Created app: ${id}`);
  console.log(`    Path: ${rel}`);
  console.log(`    Domain: ${domain}   Owner: ${owner}`);
  console.log('');
  console.log('  Next steps:');
  console.log(`    1. Add blocks to your project under blocks/`);
  console.log(`    2. Edit ${rel}/dashboards/overview.dqld to reference them`);
  console.log(`    3. dql app build      # writes apps[] and dashboards[] into dql-manifest.json`);
  console.log(`    4. dql notebook       # open the App in the desktop UI`);
  console.log('');
}

// ---- ls ----

async function runAppList(flags: CLIFlags): Promise<void> {
  const projectRoot = findProjectRoot(process.cwd());
  const apps = collectApps(projectRoot);

  if ((flags as { format?: string }).format === 'json') {
    console.log(JSON.stringify({ apps }, null, 2));
    return;
  }
  if (apps.length === 0) {
    console.log('No apps found. Create one with: dql app new <id> --domain <domain>');
    return;
  }
  for (const a of apps) {
    const member = `${a.members.length} member${a.members.length === 1 ? '' : 's'}`;
    const dash = `${a.dashboards.length} dashboard${a.dashboards.length === 1 ? '' : 's'}`;
    console.log(`${a.id.padEnd(28)} domain=${a.domain.padEnd(12)} ${member.padEnd(12)} ${dash}`);
  }
}

// ---- show ----

async function runAppShow(rest: string[], flags: CLIFlags): Promise<void> {
  const id = rest[0];
  if (!id) throw new Error('Usage: dql app show <id>');
  const projectRoot = findProjectRoot(process.cwd());
  const apps = collectApps(projectRoot);
  const app = apps.find((a) => a.id === id);
  if (!app) throw new Error(`No app named "${id}" under ${APPS_ROOT}/`);

  if ((flags as { format?: string }).format === 'json') {
    console.log(JSON.stringify(app, null, 2));
    return;
  }
  console.log(`App: ${app.name} (${app.id})`);
  console.log(`  domain:      ${app.domain}`);
  console.log(`  owners:      ${app.owners.join(', ')}`);
  console.log(`  description: ${app.description ?? '-'}`);
  console.log(`  members:     ${app.members.length}`);
  for (const m of app.members) {
    console.log(`    - ${m.userId} [${m.roles.join(', ')}]`);
  }
  console.log(`  policies:    ${app.policies.length}`);
  console.log(`  schedules:   ${app.schedules.length}`);
  console.log(`  dashboards:  ${app.dashboards.length}`);
  for (const d of app.dashboards) {
    console.log(`    - ${d.id} (${d.title})`);
  }
}

// ---- build ----

async function runAppBuild(flags: CLIFlags): Promise<void> {
  const projectRoot = findProjectRoot(process.cwd());
  // Build the manifest with dbt import resolved the same way `dql compile`
  // does, so `dql app build` produces an identical on-disk artifact.
  const dbtManifestPath = resolveDbtManifestPath(projectRoot) ?? undefined;
  const manifest = buildManifest({ projectRoot, dbtManifestPath });

  // Persist the manifest to dql-manifest.json — without this the App + the
  // dashboards never land in the on-disk artifact, so downstream consumers
  // (KG reindex, lineage CLI, the desktop UI) keep reading the previous build.
  const manifestPath = join(projectRoot, 'dql-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

  const json = (flags as { format?: string }).format === 'json';
  const apps = manifest.apps ?? {};
  const dashboards = manifest.dashboards ?? {};
  const diagnostics = (manifest.diagnostics ?? []).filter(
    (d) => d.filePath?.startsWith('apps/') ?? false,
  );

  if (json) {
    console.log(JSON.stringify({
      apps: Object.values(apps).map((a) => ({ id: a.id, name: a.name, dashboards: a.dashboards })),
      dashboards: Object.values(dashboards).map((d) => ({
        id: d.id,
        appId: d.appId,
        blockIds: d.blockIds,
        unresolvedRefs: d.unresolvedRefs,
      })),
      manifestPath: relative(projectRoot, manifestPath),
      diagnostics,
    }, null, 2));
    return;
  }

  console.log(`\n  ✓ Built ${Object.keys(apps).length} app(s), ${Object.keys(dashboards).length} dashboard(s).`);
  for (const a of Object.values(apps)) {
    console.log(`    - ${a.id}: ${a.dashboards.length} dashboard(s)`);
  }
  console.log(`\n  Manifest written to: ${relative(projectRoot, manifestPath)}`);
  if (diagnostics.length > 0) {
    console.log('\n  Diagnostics:');
    for (const d of diagnostics) {
      console.log(`    [${d.severity}] ${d.filePath ?? ''}: ${d.message}`);
    }
  }
  console.log('');
}

// ---- reindex (alias hook for the agent KG package) ----

async function runAppReindex(flags: CLIFlags): Promise<void> {
  const { reindexProject } = await import('@duckcodeailabs/dql-agent');
  const projectRoot = findProjectRoot(process.cwd());
  const stats = await reindexProject(projectRoot);
  if ((flags as { format?: string }).format === 'json') {
    console.log(JSON.stringify({ ok: true, ...stats }, null, 2));
    return;
  }
  console.log(`  ✓ Knowledge graph reindexed — ${stats.nodes} nodes, ${stats.edges} edges, ${stats.skills} skill(s).`);
}

// ---- helpers ----

interface ResolvedApp extends Omit<ManifestApp, 'dashboards'> {
  dashboards: Array<{ id: string; title: string }>;
}

function collectApps(projectRoot: string): ResolvedApp[] {
  const out: ResolvedApp[] = [];
  for (const appJsonPath of findAppDocuments(projectRoot)) {
    const { document } = loadAppDocument(appJsonPath);
    if (!document) continue;
    const appDir = appJsonPath.slice(0, -'/dql.app.json'.length);
    const dashboardSummaries: Array<{ id: string; title: string }> = [];
    for (const dqldPath of findDashboardsForApp(appDir)) {
      const { document: d } = loadDashboardDocument(dqldPath);
      if (d) dashboardSummaries.push({ id: d.id, title: d.metadata.title });
    }
    out.push({
      id: document.id,
      name: document.name,
      description: document.description,
      domain: document.domain,
      owners: document.owners,
      tags: document.tags ?? [],
      filePath: relative(projectRoot, appDir),
      members: document.members.map((m) => ({
        userId: m.userId,
        displayName: m.displayName,
        roles: m.roles,
        attributes: m.attributes,
      })),
      roles: document.roles,
      policies: document.policies.map((p) => ({
        id: p.id,
        description: p.description,
        domain: p.domain,
        minClassification: p.minClassification,
        allowedRoles: p.allowedRoles,
        allowedUsers: p.allowedUsers,
        accessLevel: p.accessLevel,
        enabled: p.enabled === undefined ? true : Boolean(p.enabled),
      })),
      rlsBindings: document.rlsBindings ?? [],
      schedules: (document.schedules ?? []).map((s) => ({
        id: s.id,
        cron: s.cron,
        dashboard: s.dashboard,
        deliver: s.deliver,
        description: s.description,
        enabled: s.enabled === undefined ? true : Boolean(s.enabled),
      })),
      dashboards: dashboardSummaries,
      homepage: document.homepage,
    } as ResolvedApp);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function relFromRoot(projectRoot: string, p: string): string {
  const prefix = projectRoot.endsWith('/') ? projectRoot : `${projectRoot}/`;
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

function humanise(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => `${w[0]?.toUpperCase() ?? ''}${w.slice(1)}`)
    .join(' ') || id;
}

// Export internal helpers for tests.
export const __test__ = {
  collectApps,
  humanise,
};
// reference unused readdirSync/readFileSync to keep imports stable for future use
void readdirSync;
void readFileSync;
