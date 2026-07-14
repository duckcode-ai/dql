/**
 * Canonical Domain Package discovery.
 *
 * `domain.dql` is the source of truth. The short-lived `domain.dql.yaml`
 * descriptor is accepted only as a compatibility input so v3 projects created
 * before the unified registry can migrate without disappearing from Modeling.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import * as yaml from 'js-yaml';
import { NodeKind, type DomainDeclNode } from '../ast/nodes.js';
import { Parser } from '../parser/index.js';
import { domainFolderSlug } from './domain-writer.js';
import type { ManifestDiagnostic, ManifestDomain, ManifestDomainPackage } from './types.js';

type UnknownRecord = Record<string, unknown>;

export interface DomainPackageRecord extends ManifestDomainPackage {
  name: string;
  root: string;
  declarationPath: string;
  legacyYamlPath?: string;
  domain: ManifestDomain;
  ancestry: string[];
  depth: number;
}

export interface DomainPackageRegistryResult {
  packages: Map<string, DomainPackageRecord>;
  diagnostics: ManifestDiagnostic[];
  get(id: string): DomainPackageRecord | undefined;
  values(): DomainPackageRecord[];
  packageForPath(filePath: string): DomainPackageRecord | undefined;
  descendants(id: string): DomainPackageRecord[];
}

interface LegacyDescriptor {
  id?: string;
  parent?: string;
  owner?: string;
  exports: string[];
  filePath: string;
  root: string;
}

export function loadDomainPackageRegistry(projectRoot: string): DomainPackageRegistryResult {
  const root = resolve(projectRoot);
  const domainsRoot = join(root, 'domains');
  const diagnostics: ManifestDiagnostic[] = [];
  const legacyByRoot = loadLegacyDescriptors(root, domainsRoot, diagnostics);
  const records = new Map<string, DomainPackageRecord>();
  const rootsWithDql = new Set<string>();

  for (const filePath of scanFiles(domainsRoot, '.dql')) {
    const source = safeRead(filePath);
    if (source === undefined || !/(^|\n)\s*domain\s+"/.test(source)) continue;
    let declarations: DomainDeclNode[] = [];
    try {
      const ast = new Parser(source, relative(root, filePath)).parse();
      declarations = ast.statements.filter((node): node is DomainDeclNode => node.kind === NodeKind.DomainDecl);
    } catch (error) {
      diagnostics.push(problem(root, filePath, 'error', `Failed to parse Domain Package: ${message(error)}`));
      continue;
    }
    for (const declaration of declarations) {
      const packageRoot = dirname(filePath);
      rootsWithDql.add(packageRoot);
      const legacy = legacyByRoot.get(packageRoot);
      const id = stableDomainId(declaration, legacy);
      if (!validDomainId(id)) {
        diagnostics.push(problem(root, filePath, 'error', `Domain Package id "${id}" must be a dot-qualified identifier.`));
        continue;
      }
      if (records.has(id)) {
        diagnostics.push(problem(root, filePath, 'error', `Duplicate Domain Package "${id}" also declared in ${records.get(id)?.declarationPath}.`));
        continue;
      }
      const domain = manifestDomain(declaration, id, relative(root, filePath).replace(/\\/g, '/'));
      records.set(id, {
        id,
        name: declaration.name,
        root: packageRoot,
        declarationPath: domain.filePath,
        filePath: domain.filePath,
        legacyYamlPath: legacy ? relative(root, legacy.filePath).replace(/\\/g, '/') : undefined,
        parent: declaration.parent ?? legacy?.parent,
        exports: declaration.exports ?? legacy?.exports ?? [],
        owner: declaration.owner ?? legacy?.owner,
        domain,
        ancestry: [],
        depth: 0,
      });
      if (legacy) {
        const mismatch = (legacy.id && legacy.id !== id)
          || (legacy.parent && declaration.parent && legacy.parent !== declaration.parent)
          || (legacy.owner && declaration.owner && legacy.owner !== declaration.owner);
        diagnostics.push(problem(
          root,
          legacy.filePath,
          mismatch ? 'error' : 'warning',
          mismatch
            ? `Legacy domain.dql.yaml conflicts with canonical ${domain.filePath}; consolidate it before compiling.`
            : `Legacy domain.dql.yaml is deprecated; ${domain.filePath} is authoritative.`,
        ));
      }
    }
  }

  // Compatibility for early v3 packages that have not yet gained domain.dql.
  for (const legacy of legacyByRoot.values()) {
    if (rootsWithDql.has(legacy.root)) continue;
    const id = legacy.id ?? legacyIdFromPath(domainsRoot, legacy.root, legacy.parent);
    if (records.has(id)) {
      diagnostics.push(problem(root, legacy.filePath, 'error', `Duplicate legacy Domain Package "${id}".`));
      continue;
    }
    const name = id.split('.').at(-1) ?? id;
    const filePath = relative(root, legacy.filePath).replace(/\\/g, '/');
    const domain: ManifestDomain = {
      id,
      name,
      filePath,
      parent: legacy.parent,
      owner: legacy.owner,
    };
    records.set(id, {
      id,
      name,
      root: legacy.root,
      declarationPath: filePath,
      legacyYamlPath: filePath,
      filePath,
      parent: legacy.parent,
      exports: legacy.exports,
      owner: legacy.owner,
      domain,
      ancestry: [],
      depth: 0,
    });
    diagnostics.push(problem(root, legacy.filePath, 'warning', 'Legacy domain.dql.yaml is compatibility-only; migrate this package to domain.dql.'));
  }

  validateHierarchy(root, records, diagnostics);
  validatePackageNesting(root, records, diagnostics);

  const values = (): DomainPackageRecord[] => [...records.values()].sort((a, b) => a.id.localeCompare(b.id));
  return {
    packages: records,
    diagnostics,
    get: (id) => records.get(id),
    values,
    packageForPath: (filePath) => {
      const absolute = resolve(root, filePath);
      return values()
        .filter((pkg) => absolute === pkg.root || absolute.startsWith(`${pkg.root}${sep}`))
        .sort((a, b) => b.root.length - a.root.length)[0];
    },
    descendants: (id) => values().filter((pkg) => pkg.ancestry.includes(id)),
  };
}

function loadLegacyDescriptors(
  projectRoot: string,
  domainsRoot: string,
  diagnostics: ManifestDiagnostic[],
): Map<string, LegacyDescriptor> {
  const output = new Map<string, LegacyDescriptor>();
  for (const filePath of scanFiles(domainsRoot, '.yaml').concat(scanFiles(domainsRoot, '.yml'))) {
    if (basename(filePath) !== 'domain.dql.yaml' && basename(filePath) !== 'domain.dql.yml') continue;
    try {
      const raw = asRecord(yaml.load(readFileSync(filePath, 'utf8')));
      output.set(dirname(filePath), {
        id: stringValue(raw.id ?? raw.domain),
        parent: stringValue(raw.parent),
        owner: stringValue(raw.owner),
        exports: stringArray(raw.exports),
        filePath,
        root: dirname(filePath),
      });
    } catch (error) {
      diagnostics.push(problem(projectRoot, filePath, 'error', `Failed to parse legacy domain descriptor: ${message(error)}`));
    }
  }
  return output;
}

function validateHierarchy(
  projectRoot: string,
  records: Map<string, DomainPackageRecord>,
  diagnostics: ManifestDiagnostic[],
): void {
  for (const record of records.values()) {
    const ancestry: string[] = [];
    const seen = new Set<string>([record.id]);
    let parent = record.parent;
    while (parent) {
      if (seen.has(parent)) {
        diagnostics.push(problem(projectRoot, join(projectRoot, record.declarationPath), 'error', `Domain hierarchy contains a cycle involving "${record.id}".`));
        break;
      }
      seen.add(parent);
      const parentRecord = records.get(parent);
      if (!parentRecord) {
        diagnostics.push(problem(projectRoot, join(projectRoot, record.declarationPath), 'error', `Domain Package "${record.id}" references missing parent "${parent}".`));
        break;
      }
      ancestry.unshift(parent);
      parent = parentRecord.parent;
    }
    record.ancestry = ancestry;
    record.depth = ancestry.length;
  }
}

function validatePackageNesting(
  projectRoot: string,
  records: Map<string, DomainPackageRecord>,
  diagnostics: ManifestDiagnostic[],
): void {
  for (const record of records.values()) {
    if (!record.parent) continue;
    const parent = records.get(record.parent);
    if (!parent) continue;
    if (!record.root.startsWith(`${parent.root}${sep}`)) {
      diagnostics.push(problem(projectRoot, join(projectRoot, record.declarationPath), 'error', `Domain Package "${record.id}" must be nested beneath parent "${record.parent}".`));
    }
  }
}

function stableDomainId(declaration: DomainDeclNode, legacy?: LegacyDescriptor): string {
  if (declaration.id?.trim()) return declaration.id.trim();
  if (legacy?.id) return legacy.id;
  const local = domainFolderSlug(declaration.name).replace(/-/g, '_');
  return declaration.parent ? `${declaration.parent}.${local}` : local;
}

function legacyIdFromPath(domainsRoot: string, packageRoot: string, parent?: string): string {
  const local = relative(domainsRoot, packageRoot).split(sep).filter(Boolean).map((part) => domainFolderSlug(part).replace(/-/g, '_')).join('.');
  if (parent && !local.startsWith(`${parent}.`)) return `${parent}.${local.split('.').at(-1)}`;
  return local || 'domain';
}

function manifestDomain(declaration: DomainDeclNode, id: string, filePath: string): ManifestDomain {
  return {
    id,
    name: declaration.name,
    filePath,
    parent: declaration.parent,
    owner: declaration.owner,
    businessOwner: declaration.businessOwner,
    boundedContext: declaration.boundedContext,
    sourceSystems: declaration.sourceSystems,
    primaryTerms: declaration.primaryTerms,
    reviewCadence: declaration.reviewCadence,
    tags: declaration.tags,
    businessOutcome: declaration.businessOutcome,
    description: declaration.description,
    inScope: declaration.inScope,
    outOfScope: declaration.outOfScope,
    dbtGroups: declaration.dbtGroups,
    dbtPaths: declaration.dbtPaths,
    dbtTags: declaration.dbtTags,
    semanticDomains: declaration.semanticDomains,
    semanticTags: declaration.semanticTags,
    exports: declaration.exports,
  };
}

function scanFiles(dir: string, extension: string): string[] {
  if (!existsSync(dir)) return [];
  const output: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) output.push(...scanFiles(path, extension));
    else if (entry.isFile() && extname(entry.name) === extension && statSync(path).size <= 1024 * 1024) output.push(path);
  }
  return output.sort();
}

function safeRead(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function problem(
  projectRoot: string,
  filePath: string,
  severity: 'error' | 'warning',
  messageText: string,
): ManifestDiagnostic {
  return {
    kind: 'modeling',
    filePath: relative(projectRoot, filePath).replace(/\\/g, '/'),
    severity,
    message: messageText,
  };
}

function validDomainId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)*$/.test(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {};
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
