import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, type Dirent } from 'node:fs';
import { join, basename } from 'node:path';
import { load as loadYaml, dump as dumpYaml } from 'js-yaml';
import type { CLIFlags } from '../args.js';
import { findProjectRoot } from '../local-runtime.js';

interface AppManifest {
  name: string;
  domain: string;
  owner?: string;
  description?: string;
  cadence?: string;
  consumers?: string[];
  entryPoints?: string[];
}

const APP_DIR_SUFFIX = '.dql-app';
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
      return runAppList(flags);
    case 'show':
      return runAppShow(rest, flags);
    default:
      throw new Error('Usage: dql app <new|ls|show> [args]');
  }
}

async function runAppNew(rest: string[], flags: CLIFlags): Promise<void> {
  const name = rest[0];
  if (!name) throw new Error('Usage: dql app new <name> --domain <domain> [--owner <owner>]');
  const domain = flags.domain?.trim();
  if (!domain) throw new Error('--domain is required for "dql app new"');

  const projectRoot = findProjectRoot(process.cwd());
  const slug = toSlug(name);
  const appDir = join(projectRoot, APPS_ROOT, `${slug}${APP_DIR_SUFFIX}`);

  if (existsSync(appDir)) {
    throw new Error(`App already exists at ${relFromRoot(projectRoot, appDir)}`);
  }

  const owner = flags.owner?.trim() || process.env.USER || 'team';
  const manifest: AppManifest = {
    name: slug,
    domain,
    owner,
    description: `${titleFromSlug(slug)} — an app for ${domain}`,
    cadence: 'ad-hoc',
    consumers: [],
    entryPoints: [`notebooks/overview.dqlnb`],
  };

  mkdirSync(join(appDir, 'notebooks'), { recursive: true });
  mkdirSync(join(appDir, 'dashboards'), { recursive: true });
  writeFileSync(join(appDir, 'app.yml'), dumpYaml(manifest), 'utf-8');
  writeFileSync(
    join(appDir, 'notebooks', 'overview.dqlnb'),
    JSON.stringify(
      {
        dqlnbVersion: 1,
        title: `${titleFromSlug(slug)} Overview`,
        cells: [
          {
            id: 'intro',
            type: 'markdown',
            content: `# ${titleFromSlug(slug)}\n\n${manifest.description}\n\nOwner: ${owner}`,
          },
        ],
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );

  const rel = relFromRoot(projectRoot, appDir);
  if (flags.format === 'json') {
    console.log(JSON.stringify({ created: true, name: slug, path: rel, manifest }, null, 2));
    return;
  }
  console.log(`\n  ✓ Created app: ${slug}`);
  console.log(`    Path: ${rel}`);
  console.log(`    Domain: ${domain}   Owner: ${owner}`);
  console.log('');
  console.log('  Next steps:');
  console.log(`    1. Edit ${rel}/app.yml to describe consumers and cadence`);
  console.log(`    2. dql notebook  (then open ${rel}/notebooks/overview.dqlnb)`);
  console.log('');
}

async function runAppList(flags: CLIFlags): Promise<void> {
  const projectRoot = findProjectRoot(process.cwd());
  const apps = discoverApps(projectRoot);

  if (flags.format === 'json') {
    console.log(JSON.stringify({ apps }, null, 2));
    return;
  }
  if (apps.length === 0) {
    console.log('No apps found. Create one with: dql app new <name> --domain <domain>');
    return;
  }
  for (const app of apps) {
    console.log(`${app.manifest.name.padEnd(28)} domain=${app.manifest.domain.padEnd(12)} owner=${app.manifest.owner ?? '-'}`);
  }
}

async function runAppShow(rest: string[], flags: CLIFlags): Promise<void> {
  const name = rest[0];
  if (!name) throw new Error('Usage: dql app show <name>');
  const projectRoot = findProjectRoot(process.cwd());
  const app = loadAppByName(projectRoot, name);
  if (!app) throw new Error(`No app named "${name}" under ${APPS_ROOT}/`);

  if (flags.format === 'json') {
    console.log(JSON.stringify(app, null, 2));
    return;
  }
  console.log(`App: ${app.manifest.name}`);
  console.log(`  domain:      ${app.manifest.domain}`);
  console.log(`  owner:       ${app.manifest.owner ?? '-'}`);
  console.log(`  description: ${app.manifest.description ?? '-'}`);
  console.log(`  cadence:     ${app.manifest.cadence ?? '-'}`);
  console.log(`  consumers:   ${(app.manifest.consumers ?? []).join(', ') || '-'}`);
  console.log(`  entryPoints: ${(app.manifest.entryPoints ?? []).join(', ') || '-'}`);
  console.log(`  notebooks:   ${app.notebooks.length}`);
  console.log(`  dashboards:  ${app.dashboards.length}`);
}

interface DiscoveredApp {
  path: string;
  manifest: AppManifest;
  notebooks: string[];
  dashboards: string[];
}

function discoverApps(projectRoot: string): DiscoveredApp[] {
  const appsRoot = join(projectRoot, APPS_ROOT);
  let entries: Dirent[];
  try {
    entries = readdirSync(appsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: DiscoveredApp[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(APP_DIR_SUFFIX)) continue;
    const app = readApp(projectRoot, join(appsRoot, entry.name));
    if (app) results.push(app);
  }
  return results.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

function loadAppByName(projectRoot: string, name: string): DiscoveredApp | null {
  const slug = toSlug(name);
  return readApp(projectRoot, join(projectRoot, APPS_ROOT, `${slug}${APP_DIR_SUFFIX}`));
}

function readApp(projectRoot: string, appDir: string): DiscoveredApp | null {
  let raw: string;
  try {
    raw = readFileSync(join(appDir, 'app.yml'), 'utf-8');
  } catch {
    return null;
  }
  try {
    const manifest = loadYaml(raw) as AppManifest;
    if (!manifest || !manifest.name || !manifest.domain) return null;
    return {
      path: relFromRoot(projectRoot, appDir),
      manifest,
      notebooks: listTree(join(appDir, 'notebooks'), '.dqlnb'),
      dashboards: listTree(join(appDir, 'dashboards'), '.dql'),
    };
  } catch {
    return null;
  }
}

function listTree(dir: string, ext: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTree(full, ext).map((n) => `${entry.name}/${n}`));
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      out.push(entry.name);
    }
  }
  return out;
}

function relFromRoot(projectRoot: string, path: string): string {
  const prefix = projectRoot.endsWith('/') ? projectRoot : `${projectRoot}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : basename(path);
}

function toSlug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'app'
  );
}

function titleFromSlug(slug: string): string {
  return slug
    .split('_')
    .filter(Boolean)
    .map((w) => `${w[0]?.toUpperCase() || ''}${w.slice(1)}`)
    .join(' ');
}

