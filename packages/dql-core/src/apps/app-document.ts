/**
 * App documents — `apps/<id>/dql.app.json`.
 *
 * An App is the consumption surface for stakeholders/CXO/teams. It bundles
 * dashboards, notebooks, members, roles, access policies, RLS bindings,
 * schedules, and a homepage into a single git-versioned artifact.
 *
 * Identity stays single-user in OSS; roles and policies are programmable and
 * enforced via the existing dql-governance PolicyEngine + the @rls compiler
 * decorator. Real SSO is layered separately in closed product.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename, relative } from 'node:path';

export type AppRole = {
  id: string;
  displayName?: string;
  description?: string;
};

export type AppMember = {
  /** Stable user identifier. In OSS this is a free-form string (e.g. email). */
  userId: string;
  /** Optional display name shown in the persona switcher. */
  displayName?: string;
  /** Roles assigned to this member within the App. */
  roles: string[];
  /** Free-form attributes used to resolve RLS template variables (e.g. `region`). */
  attributes?: Record<string, string | number | boolean>;
};

export type AppPolicy = {
  id: string;
  description?: string;
  /** Domain this policy applies to, or '*' for all. */
  domain: string;
  /** Minimum data classification this policy permits. */
  minClassification: 'public' | 'internal' | 'confidential' | 'restricted';
  /** Roles granted access. */
  allowedRoles: string[];
  /** Specific user IDs granted access (overrides roles). */
  allowedUsers?: string[];
  /** Access level granted by this policy. */
  accessLevel: 'read' | 'write' | 'execute' | 'admin';
  enabled?: boolean;
};

export type AppRlsBinding = {
  /** Role this binding applies to. */
  role: string;
  /** RLS template variable name (matches `{user.<variable>}` in @rls templates). */
  variable: string;
  /** Member attribute key whose value populates the variable for that role. */
  from: string;
};

export type AppScheduleDelivery =
  | { kind: 'slack'; channel: string }
  | { kind: 'email'; to: string[] }
  | { kind: 'webhook'; url: string };

export type AppSchedule = {
  id: string;
  cron: string;
  /** Dashboard id (within this App) to render and deliver. */
  dashboard: string;
  deliver: AppScheduleDelivery[];
  /** Optional human-readable description. */
  description?: string;
  enabled?: boolean;
};

export type AppHomepage =
  | { type: 'dashboard'; id: string }
  | { type: 'notebook'; path: string };

export interface AppDocument {
  /** Schema version for forward compatibility. */
  version: 1;
  id: string;
  name: string;
  description?: string;
  domain: string;
  owners: string[];
  tags?: string[];
  members: AppMember[];
  roles: AppRole[];
  policies: AppPolicy[];
  rlsBindings?: AppRlsBinding[];
  schedules?: AppSchedule[];
  /** What stakeholders see when they open the App. */
  homepage?: AppHomepage;
}

export interface AppDocumentParseError {
  path: string;
  message: string;
}

export interface AppDocumentLoadResult {
  document: AppDocument | null;
  errors: AppDocumentParseError[];
}

/** Parse a `dql.app.json` from raw text. */
export function parseAppDocument(text: string, path = 'dql.app.json'): AppDocumentLoadResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      document: null,
      errors: [{ path, message: `invalid JSON: ${(err as Error).message}` }],
    };
  }

  return validateAppDocument(raw, path);
}

/**
 * Load and validate an App document by file path.
 * Returns errors instead of throwing so callers can surface them as diagnostics.
 */
export function loadAppDocument(filePath: string): AppDocumentLoadResult {
  if (!existsSync(filePath)) {
    return {
      document: null,
      errors: [{ path: filePath, message: 'file not found' }],
    };
  }
  const text = readFileSync(filePath, 'utf-8');
  return parseAppDocument(text, filePath);
}

/**
 * Discover all `dql.app.json` files under `<projectRoot>/apps/`.
 * Returns absolute paths, sorted for deterministic manifest output.
 */
export function findAppDocuments(projectRoot: string): string[] {
  const appsDir = join(projectRoot, 'apps');
  if (!existsSync(appsDir)) return [];

  const out: string[] = [];
  for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const manifestPath = join(appsDir, entry.name, 'dql.app.json');
    if (existsSync(manifestPath) && statSync(manifestPath).isFile()) {
      out.push(manifestPath);
    }
  }
  return out.sort();
}

/** Normalize a member's attributes for RLS resolution. Always returns a plain object. */
export function memberAttributes(member: AppMember): Record<string, string | number | boolean> {
  return member.attributes ?? {};
}

/**
 * Resolve `{user.<var>}` RLS templates for a given member by walking
 * `rlsBindings` matching any of the member's roles.
 *
 * The first matching binding wins for each variable — bindings are
 * declared in role-priority order in `dql.app.json`.
 */
export function resolveRlsContext(
  app: AppDocument,
  member: AppMember,
): Record<string, string | number | boolean> {
  const ctx: Record<string, string | number | boolean> = {};
  const attrs = memberAttributes(member);
  for (const binding of app.rlsBindings ?? []) {
    if (!member.roles.includes(binding.role)) continue;
    if (ctx[binding.variable] !== undefined) continue;
    const value = attrs[binding.from];
    if (value !== undefined) ctx[binding.variable] = value;
  }
  return ctx;
}

/** Relative path of the App folder from the project root. */
export function appFolderRelPath(projectRoot: string, appJsonPath: string): string {
  // appJsonPath = <projectRoot>/apps/<id>/dql.app.json
  const dir = appJsonPath.endsWith('dql.app.json')
    ? appJsonPath.slice(0, -'/dql.app.json'.length)
    : appJsonPath;
  return relative(projectRoot, dir);
}

// ---- Validation ----

function validateAppDocument(raw: unknown, path: string): AppDocumentLoadResult {
  const errors: AppDocumentParseError[] = [];
  const err = (msg: string) => errors.push({ path, message: msg });

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    err('expected a JSON object at the top level');
    return { document: null, errors };
  }

  const obj = raw as Record<string, unknown>;

  // version: optional, default to 1
  const version = obj.version ?? 1;
  if (version !== 1) err(`unsupported version ${String(version)} (expected 1)`);

  const id = stringField(obj, 'id', err);
  const name = stringField(obj, 'name', err);
  const domain = stringField(obj, 'domain', err);

  if (!id || !name || !domain) {
    return { document: null, errors };
  }

  // Validate id shape — folder-safe
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
    err(`id "${id}" must match /^[a-z0-9][a-z0-9_-]*$/i (folder-safe)`);
  }

  const owners = stringArray(obj, 'owners', err);
  if (owners.length === 0) err('at least one owner is required');

  const description = optionalString(obj, 'description', err);
  const tags = obj.tags === undefined ? [] : stringArray(obj, 'tags', err);

  const members = readMembers(obj.members, err);
  const roles = readRoles(obj.roles, err);
  const policies = readPolicies(obj.policies, err);
  const rlsBindings = readRlsBindings(obj.rlsBindings, err);
  const schedules = readSchedules(obj.schedules, err);
  const homepage = readHomepage(obj.homepage, err);

  // Cross-checks: every member role must be defined; every policy role must be defined
  const declaredRoles = new Set(roles.map((r) => r.id));
  for (const m of members) {
    for (const r of m.roles) {
      if (!declaredRoles.has(r)) err(`member ${m.userId} references undeclared role "${r}"`);
    }
  }
  for (const p of policies) {
    for (const r of p.allowedRoles) {
      if (!declaredRoles.has(r)) err(`policy ${p.id} references undeclared role "${r}"`);
    }
  }
  for (const b of rlsBindings) {
    if (!declaredRoles.has(b.role)) err(`rlsBinding references undeclared role "${b.role}"`);
  }

  if (errors.length > 0) {
    return { document: null, errors };
  }

  const doc: AppDocument = {
    version: 1,
    id,
    name,
    description,
    domain,
    owners,
    tags,
    members,
    roles,
    policies,
    rlsBindings: rlsBindings.length > 0 ? rlsBindings : undefined,
    schedules: schedules.length > 0 ? schedules : undefined,
    homepage,
  };
  return { document: doc, errors: [] };
}

function stringField(
  obj: Record<string, unknown>,
  key: string,
  err: (m: string) => void,
): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    err(`field "${key}" must be a non-empty string`);
    return '';
  }
  return v;
}

function optionalString(
  obj: Record<string, unknown>,
  key: string,
  err: (m: string) => void,
): string | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') {
    err(`field "${key}" must be a string when present`);
    return undefined;
  }
  return v;
}

function stringArray(
  obj: Record<string, unknown>,
  key: string,
  err: (m: string) => void,
): string[] {
  const v = obj[key];
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    err(`field "${key}" must be an array of strings`);
    return [];
  }
  return v as string[];
}

function readMembers(raw: unknown, err: (m: string) => void): AppMember[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    err('members must be an array');
    return [];
  }
  const out: AppMember[] = [];
  for (let i = 0; i < raw.length; i++) {
    const m = raw[i];
    if (typeof m !== 'object' || m === null) {
      err(`members[${i}] must be an object`);
      continue;
    }
    const mo = m as Record<string, unknown>;
    const userId = mo.userId;
    const roles = mo.roles;
    if (typeof userId !== 'string' || userId.length === 0) {
      err(`members[${i}].userId must be a non-empty string`);
      continue;
    }
    if (!Array.isArray(roles) || !roles.every((x) => typeof x === 'string')) {
      err(`members[${i}].roles must be an array of strings`);
      continue;
    }
    const attrs = mo.attributes;
    let attributes: Record<string, string | number | boolean> | undefined;
    if (attrs !== undefined) {
      if (typeof attrs !== 'object' || attrs === null || Array.isArray(attrs)) {
        err(`members[${i}].attributes must be an object`);
      } else {
        attributes = {};
        for (const [k, v] of Object.entries(attrs)) {
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            attributes[k] = v;
          } else {
            err(`members[${i}].attributes.${k} must be string|number|boolean`);
          }
        }
      }
    }
    out.push({
      userId,
      displayName: typeof mo.displayName === 'string' ? mo.displayName : undefined,
      roles: roles as string[],
      attributes,
    });
  }
  return out;
}

function readRoles(raw: unknown, err: (m: string) => void): AppRole[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    err('roles must be an array');
    return [];
  }
  const out: AppRole[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    if (typeof r !== 'object' || r === null) {
      err(`roles[${i}] must be an object`);
      continue;
    }
    const ro = r as Record<string, unknown>;
    if (typeof ro.id !== 'string' || ro.id.length === 0) {
      err(`roles[${i}].id must be a non-empty string`);
      continue;
    }
    out.push({
      id: ro.id,
      displayName: typeof ro.displayName === 'string' ? ro.displayName : undefined,
      description: typeof ro.description === 'string' ? ro.description : undefined,
    });
  }
  return out;
}

function readPolicies(raw: unknown, err: (m: string) => void): AppPolicy[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    err('policies must be an array');
    return [];
  }
  const allowedClassifications = ['public', 'internal', 'confidential', 'restricted'] as const;
  const allowedLevels = ['read', 'write', 'execute', 'admin'] as const;

  const out: AppPolicy[] = [];
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i];
    if (typeof p !== 'object' || p === null) {
      err(`policies[${i}] must be an object`);
      continue;
    }
    const po = p as Record<string, unknown>;
    const id = po.id;
    const domain = po.domain;
    const minClassification = po.minClassification;
    const allowedRoles = po.allowedRoles;
    const accessLevel = po.accessLevel;

    if (typeof id !== 'string' || id.length === 0) {
      err(`policies[${i}].id must be a non-empty string`);
      continue;
    }
    if (typeof domain !== 'string' || domain.length === 0) {
      err(`policies[${id}].domain must be a non-empty string`);
      continue;
    }
    if (typeof minClassification !== 'string'
      || !allowedClassifications.includes(minClassification as typeof allowedClassifications[number])) {
      err(`policies[${id}].minClassification must be one of ${allowedClassifications.join('|')}`);
      continue;
    }
    if (!Array.isArray(allowedRoles) || !allowedRoles.every((x) => typeof x === 'string')) {
      err(`policies[${id}].allowedRoles must be an array of strings`);
      continue;
    }
    if (typeof accessLevel !== 'string'
      || !allowedLevels.includes(accessLevel as typeof allowedLevels[number])) {
      err(`policies[${id}].accessLevel must be one of ${allowedLevels.join('|')}`);
      continue;
    }
    const allowedUsers = po.allowedUsers;
    let allowedUsersTyped: string[] | undefined;
    if (allowedUsers !== undefined) {
      if (!Array.isArray(allowedUsers) || !allowedUsers.every((x) => typeof x === 'string')) {
        err(`policies[${id}].allowedUsers must be an array of strings when present`);
      } else {
        allowedUsersTyped = allowedUsers as string[];
      }
    }
    out.push({
      id,
      description: typeof po.description === 'string' ? po.description : undefined,
      domain,
      minClassification: minClassification as AppPolicy['minClassification'],
      allowedRoles: allowedRoles as string[],
      allowedUsers: allowedUsersTyped,
      accessLevel: accessLevel as AppPolicy['accessLevel'],
      enabled: po.enabled === undefined ? true : Boolean(po.enabled),
    });
  }
  return out;
}

function readRlsBindings(raw: unknown, err: (m: string) => void): AppRlsBinding[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    err('rlsBindings must be an array');
    return [];
  }
  const out: AppRlsBinding[] = [];
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i];
    if (typeof b !== 'object' || b === null) {
      err(`rlsBindings[${i}] must be an object`);
      continue;
    }
    const bo = b as Record<string, unknown>;
    if (typeof bo.role !== 'string' || typeof bo.variable !== 'string' || typeof bo.from !== 'string') {
      err(`rlsBindings[${i}] must have string role, variable, from`);
      continue;
    }
    out.push({ role: bo.role, variable: bo.variable, from: bo.from });
  }
  return out;
}

function readSchedules(raw: unknown, err: (m: string) => void): AppSchedule[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    err('schedules must be an array');
    return [];
  }
  const out: AppSchedule[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    if (typeof s !== 'object' || s === null) {
      err(`schedules[${i}] must be an object`);
      continue;
    }
    const so = s as Record<string, unknown>;
    if (typeof so.id !== 'string' || typeof so.cron !== 'string' || typeof so.dashboard !== 'string') {
      err(`schedules[${i}] must have string id, cron, dashboard`);
      continue;
    }
    const deliver = readDelivery(so.deliver, `schedules[${so.id}]`, err);
    out.push({
      id: so.id,
      cron: so.cron,
      dashboard: so.dashboard,
      deliver,
      description: typeof so.description === 'string' ? so.description : undefined,
      enabled: so.enabled === undefined ? true : Boolean(so.enabled),
    });
  }
  return out;
}

function readDelivery(raw: unknown, ctx: string, err: (m: string) => void): AppScheduleDelivery[] {
  if (!Array.isArray(raw)) {
    err(`${ctx}.deliver must be an array`);
    return [];
  }
  const out: AppScheduleDelivery[] = [];
  for (let i = 0; i < raw.length; i++) {
    const d = raw[i];
    if (typeof d !== 'object' || d === null) {
      err(`${ctx}.deliver[${i}] must be an object`);
      continue;
    }
    const dobj = d as Record<string, unknown>;
    const kind = dobj.kind;
    if (kind === 'slack' && typeof dobj.channel === 'string') {
      out.push({ kind: 'slack', channel: dobj.channel });
    } else if (kind === 'email' && Array.isArray(dobj.to) && dobj.to.every((x) => typeof x === 'string')) {
      out.push({ kind: 'email', to: dobj.to as string[] });
    } else if (kind === 'webhook' && typeof dobj.url === 'string') {
      out.push({ kind: 'webhook', url: dobj.url });
    } else {
      err(`${ctx}.deliver[${i}] has unknown shape (kind=${String(kind)})`);
    }
  }
  return out;
}

function readHomepage(raw: unknown, err: (m: string) => void): AppHomepage | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null) {
    err('homepage must be an object');
    return undefined;
  }
  const ho = raw as Record<string, unknown>;
  if (ho.type === 'dashboard' && typeof ho.id === 'string') {
    return { type: 'dashboard', id: ho.id };
  }
  if (ho.type === 'notebook' && typeof ho.path === 'string') {
    return { type: 'notebook', path: ho.path };
  }
  err(`homepage must be { type: "dashboard", id } or { type: "notebook", path }`);
  return undefined;
}

/** Synthesize a folder-safe id when scaffolding a new App. Public for CLI use. */
export function suggestAppId(name: string): string {
  return basename(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
}
