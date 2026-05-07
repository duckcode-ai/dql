// `dql cloud` — bridge between local DQL projects and Datalex-Cloud.
//
// Subcommands:
//   dql cloud login <url>           Open browser to mint a dlx_ token; save to credentials file
//   dql cloud whoami                Show stored credentials
//   dql cloud push block <file>     POST /v1/projects/:projectId/blocks
//   dql cloud push manifest <path>  POST /v1/manifests?project_id=...
//   dql cloud push notebook <file>  POST /v1/projects/:projectId/notebooks
//   dql cloud logout                Wipe credentials file
//
// Credentials live at ~/.config/dql/credentials.json. Project id is read
// from .dql/cloud.json in the current project (see `dql cloud link`).

import { homedir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';

interface Credentials {
  url: string;
  token: string;
  user_email?: string;
  saved_at: string;
}

interface ProjectLink {
  url: string;
  tenant_id: string;
  tenant_slug: string;
  project_id: string;
  project_name: string;
  linked_at: string;
}

const CREDS_DIR = join(homedir(), '.config', 'dql');
const CREDS_FILE = join(CREDS_DIR, 'credentials.json');
const PROJECT_LINK_FILE = '.dql/cloud.json';

function readCreds(): Credentials | null {
  if (!existsSync(CREDS_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CREDS_FILE, 'utf-8')) as Credentials;
  } catch {
    return null;
  }
}

function writeCreds(creds: Credentials): void {
  mkdirSync(CREDS_DIR, { recursive: true });
  writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2));
  // Tighten permissions so the token isn't world-readable on shared machines.
  try {
    chmodSync(CREDS_FILE, 0o600);
  } catch {
    // ignore on platforms that don't support chmod
  }
}

function readProjectLink(cwd: string): ProjectLink | null {
  const path = join(cwd, PROJECT_LINK_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ProjectLink;
  } catch {
    return null;
  }
}

function writeProjectLink(cwd: string, link: ProjectLink): void {
  const path = join(cwd, PROJECT_LINK_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(link, null, 2));
}

function trim(s: string): string {
  return s.replace(/\/$/, '');
}

async function fetchJson<T>(
  url: string,
  init: RequestInit & { token?: string } = {},
): Promise<T> {
  const { token, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(rest.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const detail = body && typeof body === 'object' && 'error' in (body as Record<string, unknown>) ? (body as Record<string, unknown>).error : `http_${res.status}`;
    throw new Error(`${url} → ${res.status} ${String(detail)}`);
  }
  return body as T;
}

export async function runCloud(
  rest: string[],
  _flags: unknown,
): Promise<void> {
  const sub = rest[0];
  if (!sub) {
    console.error(
      'Usage: dql cloud <login|whoami|logout|link|push> [args]',
    );
    process.exit(1);
  }

  switch (sub) {
    case 'login':
      return loginCmd(rest[1]);
    case 'whoami':
      return whoamiCmd();
    case 'logout':
      return logoutCmd();
    case 'link':
      return linkCmd(rest[1], rest.slice(2));
    case 'push':
      return pushCmd(rest[1], rest.slice(2));
    default:
      console.error(`Unknown cloud subcommand: ${sub}`);
      process.exit(1);
  }
}

async function loginCmd(url: string | undefined): Promise<void> {
  if (!url) {
    console.error('Usage: dql cloud login <url>');
    console.error('Example: dql cloud login https://app.duckcodeai.com');
    process.exit(1);
  }
  const cleanUrl = trim(url);
  console.log(`Open this URL in your browser to mint a dlx_ token:`);
  console.log(`  ${cleanUrl}/t/-/api-tokens?from=dql-cli`);
  console.log('');
  console.log('After minting the token, paste it below.');

  const token = await readline('Token: ');
  if (!token.startsWith('dlx_')) {
    console.error('Error: token must start with dlx_');
    process.exit(1);
  }

  // Verify the token by hitting /v1/me.
  const me = await fetchJson<{
    user: { email: string };
    memberships: Array<{ tenantId: string; role: string }>;
  }>(`${cleanUrl}/v1/me`, { token });
  console.log(`Signed in as ${me.user.email}`);
  console.log(
    `  ${me.memberships.length} workspace${me.memberships.length === 1 ? '' : 's'}`,
  );
  writeCreds({
    url: cleanUrl,
    token,
    user_email: me.user.email,
    saved_at: new Date().toISOString(),
  });
  console.log(`Saved to ${CREDS_FILE}`);
}

async function whoamiCmd(): Promise<void> {
  const creds = readCreds();
  if (!creds) {
    console.log('Not logged in. Run `dql cloud login <url>`.');
    return;
  }
  console.log(`Logged in as ${creds.user_email ?? '?'}`);
  console.log(`  url:        ${creds.url}`);
  console.log(`  saved at:   ${creds.saved_at}`);
  console.log(`  creds file: ${CREDS_FILE}`);
  // Hit /v1/me to confirm the token still works.
  try {
    const me = await fetchJson<{
      user: { email: string };
      memberships: Array<{ tenantId: string; role: string }>;
    }>(`${creds.url}/v1/me`, { token: creds.token });
    console.log(
      `  memberships: ${me.memberships.map((m) => `${m.tenantId}(${m.role})`).join(', ')}`,
    );
  } catch (err) {
    console.error(`  warning: token may be revoked — ${(err as Error).message}`);
  }
}

async function logoutCmd(): Promise<void> {
  if (!existsSync(CREDS_FILE)) {
    console.log('Not logged in.');
    return;
  }
  writeFileSync(CREDS_FILE, '{}');
  console.log('Logged out.');
}

async function linkCmd(
  tenantSlug: string | undefined,
  rest: string[],
): Promise<void> {
  if (!tenantSlug || rest.length === 0) {
    console.error('Usage: dql cloud link <tenant-slug> <project-name>');
    process.exit(1);
  }
  const projectName = rest.join(' ');
  const creds = readCreds();
  if (!creds) {
    console.error('Not logged in. Run `dql cloud login <url>` first.');
    process.exit(1);
  }

  // Look up tenant by slug.
  const { tenants } = await fetchJson<{
    tenants: Array<{ id: string; slug: string; display_name: string }>;
  }>(`${creds.url}/v1/tenants`, { token: creds.token });
  const tenant = tenants.find((t) => t.slug === tenantSlug);
  if (!tenant) {
    console.error(`Tenant '${tenantSlug}' not found, or you don't have access.`);
    process.exit(1);
  }

  // Find project by name within tenant.
  const { projects } = await fetchJson<{
    projects: Array<{ id: string; name: string }>;
  }>(
    `${creds.url}/v1/projects?tenant_id=${encodeURIComponent(tenant.id)}`,
    { token: creds.token },
  );
  const project = projects.find((p) => p.name === projectName);
  if (!project) {
    console.error(
      `Project '${projectName}' not found in tenant '${tenantSlug}'. Available: ${projects.map((p) => p.name).join(', ')}`,
    );
    process.exit(1);
  }

  writeProjectLink(process.cwd(), {
    url: creds.url,
    tenant_id: tenant.id,
    tenant_slug: tenant.slug,
    project_id: project.id,
    project_name: project.name,
    linked_at: new Date().toISOString(),
  });
  console.log(
    `Linked ${process.cwd()} → ${tenant.slug}/${project.name} (${project.id})`,
  );
  console.log(`Saved ${PROJECT_LINK_FILE}`);
}

async function pushCmd(kind: string | undefined, rest: string[]): Promise<void> {
  if (!kind || !['block', 'manifest', 'notebook'].includes(kind)) {
    console.error(
      'Usage: dql cloud push <block|manifest|notebook> <file-or-path>',
    );
    process.exit(1);
  }
  const path = rest[0];
  if (!path) {
    console.error(`Missing file argument for push ${kind}`);
    process.exit(1);
  }
  const creds = readCreds();
  if (!creds) {
    console.error('Not logged in. Run `dql cloud login <url>` first.');
    process.exit(1);
  }
  const link = readProjectLink(process.cwd());
  if (!link) {
    console.error(
      'Project not linked. Run `dql cloud link <tenant-slug> <project-name>` first.',
    );
    process.exit(1);
  }

  const abs = resolve(path);
  if (!existsSync(abs)) {
    console.error(`File not found: ${abs}`);
    process.exit(1);
  }

  if (kind === 'block') {
    const text = readFileSync(abs, 'utf-8');
    const result = await fetchJson<{
      block: { id: string; name: string; status: string };
    }>(
      `${link.url}/v1/projects/${link.project_id}/blocks`,
      {
        token: creds.token,
        method: 'POST',
        body: JSON.stringify({ body_text: text }),
      },
    );
    console.log(
      `Pushed ${basename(abs)} → ${result.block.name} (status: ${result.block.status})`,
    );
    console.log(
      `View: ${link.url}/t/${link.tenant_slug}/p/${link.project_id}/blocks/${encodeURIComponent(result.block.name)}`,
    );
    return;
  }

  if (kind === 'manifest') {
    const text = readFileSync(abs, 'utf-8');
    const json = JSON.parse(text);
    const result = await fetchJson<{
      manifest: { id: string; node_count: number; source_count: number };
      message: string;
    }>(
      `${link.url}/v1/manifests?project_id=${link.project_id}`,
      {
        token: creds.token,
        method: 'POST',
        body: JSON.stringify(json),
      },
    );
    console.log(`Pushed manifest. ${result.message}`);
    console.log(
      `View: ${link.url}/t/${link.tenant_slug}/p/${link.project_id}/manifest`,
    );
    return;
  }

  if (kind === 'notebook') {
    const text = readFileSync(abs, 'utf-8');
    const body = JSON.parse(text);
    const name = body.metadata?.title ?? basename(abs).replace(/\.dqlnb$/, '');
    const result = await fetchJson<{
      notebook: { id: string; name: string };
    }>(
      `${link.url}/v1/projects/${link.project_id}/notebooks`,
      {
        token: creds.token,
        method: 'POST',
        body: JSON.stringify({ name, body }),
      },
    );
    console.log(
      `Pushed notebook → ${result.notebook.name} (${result.notebook.id})`,
    );
    console.log(
      `View: ${link.url}/t/${link.tenant_slug}/p/${link.project_id}/notebooks/${result.notebook.id}`,
    );
    return;
  }
}

function readline(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    let buf = '';
    process.stdin.setEncoding('utf-8');
    const onData = (chunk: string): void => {
      const idx = chunk.indexOf('\n');
      if (idx >= 0) {
        buf += chunk.slice(0, idx);
        process.stdin.removeListener('data', onData);
        process.stdin.pause();
        resolve(buf.trim());
      } else {
        buf += chunk;
      }
    };
    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}
