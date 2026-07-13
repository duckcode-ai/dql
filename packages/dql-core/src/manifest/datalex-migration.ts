/**
 * One-way DataLex → DQL v3 migration planner.
 *
 * The planner is intentionally conservative. It imports only DataLex business
 * semantics that can be bound to dbt, writes every migrated governance object
 * as a draft, and reports every dropped/missing item. dbt-owned descriptions,
 * fields and types become *suggested* YAML patches rather than a second DQL
 * catalog.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import * as yaml from 'js-yaml';
import type { DataLexManifest, DataLexEntity, DataLexRelationship } from '../contracts/types.js';
import { renderDomainDeclaration } from './domain-writer.js';

export interface DataLexMigrationInput {
  projectRoot: string;
  datalexManifestPath: string;
  dbtManifestPath: string;
}

export interface DataLexMigrationFile {
  path: string;
  content: string;
  kind: 'domain_declaration' | 'domain_overlay' | 'dbt_yaml_patch' | 'report';
}

export interface DataLexMigrationLoss {
  path: string;
  reason: string;
}

export interface DataLexMigrationAmbiguity {
  path: string;
  reference: string;
  candidates: string[];
  reason: string;
}

export interface DataLexMigrationReport {
  matchedEntities: Array<{ datalex: string; dbtUniqueId: string; dqlEntity: string }>;
  droppedDbtMirrors: Array<{ path: string; fields: string[] }>;
  draftedObjects: Array<{ kind: 'relationship' | 'contract' | 'conformance'; id: string }>;
  losses: DataLexMigrationLoss[];
  ambiguities: DataLexMigrationAmbiguity[];
  suggestedDbtPatches: string[];
  autoCertified: 0;
}

export interface DataLexMigrationPlan {
  version: 1;
  sourceFingerprint: string;
  datalexManifestPath: string;
  dbtManifestPath: string;
  files: DataLexMigrationFile[];
  report: DataLexMigrationReport;
}

interface DbtMigrationNode {
  uniqueId: string;
  name: string;
  relation: string;
  description?: string;
  sourcePath?: string;
  columns: Map<string, { description?: string }>;
}

interface BoundEntity {
  domain: string;
  name: string;
  dqlId: string;
  dbt: DbtMigrationNode;
  raw: DataLexEntity;
}

/** Create a deterministic, reviewable migration plan without writing files. */
export function planDataLexMigration(input: DataLexMigrationInput): DataLexMigrationPlan {
  const datalex = readDataLexManifest(input.datalexManifestPath);
  const dbt = readDbtNodes(input.dbtManifestPath);
  const report: DataLexMigrationReport = {
    matchedEntities: [],
    droppedDbtMirrors: [],
    draftedObjects: [],
    losses: [],
    ambiguities: [],
    suggestedDbtPatches: [],
    autoCertified: 0,
  };
  const bound = new Map<string, BoundEntity>();
  const overlays = new Map<string, {
    entities: Array<Record<string, unknown>>;
    relationships: Array<Record<string, unknown>>;
    contracts: Array<Record<string, unknown>>;
    conformance: Array<Record<string, unknown>>;
    rules: Array<Record<string, unknown>>;
  }>();
  const patchModels = new Map<string, Array<Record<string, unknown>>>();

  for (const domain of datalex.domains ?? []) {
    const domainId = slug(domain.name);
    const overlay = overlayFor(overlays, domainId);
    for (const entity of domain.entities ?? []) {
      const path = `domains.${domainId}.entities.${entity.name}`;
      const match = matchDbtEntity(entity, dbt);
      if (match.ambiguity) {
        report.ambiguities.push({ path, ...match.ambiguity });
        continue;
      }
      const matched = match.node;
      if (!matched) {
        report.losses.push({ path, reason: 'No unambiguous dbt unique ID, relation, or model name matched the DataLex binding.' });
        continue;
      }
      const dqlId = entityId(domainId, entity.name);
      const candidateKeys = stringArray(entity.candidate_keys);
      overlay.entities.push(compact({
        id: dqlId,
        dbt_model: matched.uniqueId,
        grain: entity.grain,
        keys: candidateKeys.length > 0 ? candidateKeys : undefined,
      }));
      bound.set(entityLookup(domain.name, entity.name), { domain: domainId, name: entity.name, dqlId, dbt: matched, raw: entity });
      report.matchedEntities.push({ datalex: `${domain.name}.${entity.name}`, dbtUniqueId: matched.uniqueId, dqlEntity: dqlId });

      const mirrors = mirroredDbtFields(entity, matched);
      if (mirrors.length > 0) report.droppedDbtMirrors.push({ path, fields: mirrors });
      const patch = dbtPatchForEntity(entity, matched);
      if (patch) {
        const patches = patchModels.get(domainId) ?? [];
        patches.push(patch);
        patchModels.set(domainId, patches);
      }

      for (const contract of entity.contracts ?? []) {
        const id = typeof contract.id === 'string' ? contract.id : undefined;
        if (!id) {
          report.losses.push({ path: `${path}.contracts`, reason: 'A contract without an id cannot be migrated.' });
          continue;
        }
        overlay.contracts.push(compact({
          id,
          domain: domainId,
          entities: [dqlId],
          status: 'draft',
          owner: contract.owner,
          required_evaluation: true,
        }));
        report.draftedObjects.push({ kind: 'contract', id });
      }
    }
  }

  for (const relationship of datalex.relationships ?? []) {
    migrateRelationship(relationship, bound, overlays, report);
  }
  for (const declaration of datalex.conformance ?? []) {
    const entities = (declaration.physical ?? [])
      .map((physical) => bound.get(entityLookup(declaration.domain ?? '', physical.entity))?.dqlId)
      .filter((id): id is string => Boolean(id));
    if (entities.length < 2) {
      report.losses.push({ path: `conformance.${declaration.concept}`, reason: 'Conformance did not resolve to two or more dbt-bound entities.' });
      continue;
    }
    const domainId = bound.get(entityLookup(declaration.domain ?? '', declaration.physical?.[0]?.entity ?? ''))?.domain ?? 'shared';
    const id = `${slug(domainId)}_${slug(declaration.concept)}_conformance`;
    overlayFor(overlays, domainId).conformance.push({
      id,
      entities: [...new Set(entities)].sort(),
      rule: `DataLex conformance migration for ${declaration.concept}; review canonical key ${stringArray(declaration.canonical_key).join(', ') || 'not supplied'}.`,
    });
    report.draftedObjects.push({ kind: 'conformance', id });
  }

  const files: DataLexMigrationFile[] = [];
  for (const domain of [...(datalex.domains ?? [])].sort((a, b) => a.name.localeCompare(b.name))) {
    const domainId = slug(domain.name);
    files.push({
      path: `domains/${domainId}/domain.dql`,
      content: renderDomainDeclaration({
        id: domainId,
        name: domain.name,
        description: domain.description,
        owner: domain.owners?.[0],
        tags: ['migrated-from-datalex'],
      }),
      kind: 'domain_declaration',
    });
  }
  for (const [domainId, overlay] of [...overlays.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const content = yaml.dump(compact(overlay), { noRefs: true, lineWidth: 120, sortKeys: false });
    if (content.trim()) {
      files.push({
        path: `domains/${domainId}/modeling/datalex-migration.dql.yaml`,
        content,
        kind: 'domain_overlay',
      });
    }
  }
  for (const [domainId, models] of [...patchModels.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const path = `migrations/datalex/${domainId}.dbt-schema.patch.yaml`;
    files.push({
      path,
      content: yaml.dump({ version: 2, models }, { noRefs: true, lineWidth: 120, sortKeys: false }),
      kind: 'dbt_yaml_patch',
    });
    report.suggestedDbtPatches.push(path);
  }

  report.matchedEntities.sort((a, b) => a.datalex.localeCompare(b.datalex));
  report.droppedDbtMirrors.sort((a, b) => a.path.localeCompare(b.path));
  report.draftedObjects.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  report.losses.sort((a, b) => `${a.path}:${a.reason}`.localeCompare(`${b.path}:${b.reason}`));
  report.ambiguities.sort((a, b) => `${a.path}:${a.reference}`.localeCompare(`${b.path}:${b.reference}`));
  files.push({
    path: 'migrations/datalex/report.json',
    content: `${JSON.stringify(report, null, 2)}\n`,
    kind: 'report',
  });

  return {
    version: 1,
    sourceFingerprint: dataLexSourceFingerprint(input.datalexManifestPath, input.dbtManifestPath),
    datalexManifestPath: input.datalexManifestPath,
    dbtManifestPath: input.dbtManifestPath,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    report,
  };
}

/**
 * Write a reviewed plan idempotently. Existing identical files are left alone;
 * no dbt project file is ever mutated because suggestions live under
 * `migrations/datalex/` for explicit review and application.
 */
export function applyDataLexMigration(projectRoot: string, plan: DataLexMigrationPlan): { written: string[]; unchanged: string[] } {
  if (plan.report.ambiguities.length > 0) {
    throw new Error('DataLex migration is blocked by ambiguous dbt bindings; no files were written.');
  }
  const currentFingerprint = dataLexSourceFingerprint(plan.datalexManifestPath, plan.dbtManifestPath);
  if (currentFingerprint !== plan.sourceFingerprint) {
    throw new Error('SOURCE_CHANGED: DataLex or dbt artifacts changed after preview; create a new migration plan.');
  }
  const written: string[] = [];
  const unchanged: string[] = [];
  const changed = plan.files.filter((file) => {
    const absolute = join(projectRoot, file.path);
    if (existsSync(absolute) && readFileSync(absolute, 'utf8') === file.content) {
      unchanged.push(file.path);
      return false;
    }
    return true;
  });
  if (changed.length === 0) return { written, unchanged };

  const stageRoot = join(projectRoot, '.dql', 'migration-staging', `datalex-${randomUUID()}`);
  const installed: string[] = [];
  const backedUp: string[] = [];
  try {
    for (const file of changed) {
      const staged = join(stageRoot, 'after', file.path);
      mkdirSync(dirname(staged), { recursive: true });
      writeFileSync(staged, file.content, 'utf8');
    }
    for (const file of changed) {
      const absolute = join(projectRoot, file.path);
      if (existsSync(absolute)) {
        const backup = join(stageRoot, 'before', file.path);
        mkdirSync(dirname(backup), { recursive: true });
        renameSync(absolute, backup);
        backedUp.push(file.path);
      }
      mkdirSync(dirname(absolute), { recursive: true });
      renameSync(join(stageRoot, 'after', file.path), absolute);
      installed.push(file.path);
      written.push(file.path);
    }
    rmSync(stageRoot, { recursive: true, force: true });
    return { written, unchanged };
  } catch (error) {
    for (const path of [...installed].reverse()) rmSync(join(projectRoot, path), { recursive: true, force: true });
    for (const path of [...backedUp].reverse()) {
      const backup = join(stageRoot, 'before', path);
      if (existsSync(backup)) {
        mkdirSync(dirname(join(projectRoot, path)), { recursive: true });
        renameSync(backup, join(projectRoot, path));
      }
    }
    rmSync(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

function migrateRelationship(
  relationship: DataLexRelationship,
  bound: Map<string, BoundEntity>,
  overlays: Map<string, ReturnType<typeof emptyOverlay>>,
  report: DataLexMigrationReport,
): void {
  const from = bound.get(entityLookup(relationship.from.domain ?? '', relationship.from.entity));
  const to = bound.get(entityLookup(relationship.to.domain ?? '', relationship.to.entity));
  const path = `relationships.${relationship.name}`;
  if (!from || !to) {
    report.losses.push({ path, reason: 'Relationship endpoint did not resolve to a dbt-bound migrated entity.' });
    return;
  }
  if (!relationship.from.column || !relationship.to.column) {
    report.losses.push({ path, reason: 'Relationship lacks physical key columns and cannot be made into DQL join proof.' });
    return;
  }
  const id = slug(relationship.name);
  overlayFor(overlays, from.domain).relationships.push({
    id,
    from: from.dqlId,
    to: to.dqlId,
    keys: [{ from: relationship.from.column, to: relationship.to.column }],
    cardinality: relationship.cardinality ?? 'unknown',
    fanout: relationship.cardinality === 'many_to_many' ? 'attribution_required' : 'unknown',
    crossDomain: from.domain !== to.domain || undefined,
    status: 'draft',
  });
  report.draftedObjects.push({ kind: 'relationship', id });
}

function overlayFor(
  overlays: Map<string, ReturnType<typeof emptyOverlay>>,
  domainId: string,
): ReturnType<typeof emptyOverlay> {
  const existing = overlays.get(domainId);
  if (existing) return existing;
  const created = emptyOverlay();
  overlays.set(domainId, created);
  return created;
}

function emptyOverlay() {
  return {
    entities: [] as Array<Record<string, unknown>>,
    relationships: [] as Array<Record<string, unknown>>,
    contracts: [] as Array<Record<string, unknown>>,
    conformance: [] as Array<Record<string, unknown>>,
    rules: [] as Array<Record<string, unknown>>,
  };
}

function readDataLexManifest(path: string): DataLexManifest {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as DataLexManifest;
  if (!parsed || !Array.isArray(parsed.domains)) throw new Error(`DataLex manifest at ${path} does not contain a domains array.`);
  return parsed;
}

function readDbtNodes(path: string): DbtMigrationNode[] {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { nodes?: Record<string, Record<string, unknown>>; sources?: Record<string, Record<string, unknown>> };
  const nodes: DbtMigrationNode[] = [];
  for (const [uniqueId, node] of Object.entries({ ...(raw.nodes ?? {}), ...(raw.sources ?? {}) })) {
    if (node.resource_type !== 'model' && node.resource_type !== 'source') continue;
    const name = string(node.alias) ?? string(node.identifier) ?? string(node.name);
    if (!name) continue;
    const relation = [string(node.database), string(node.schema), name].filter(Boolean).join('.');
    const columns = new Map<string, { description?: string }>();
    for (const [columnName, rawColumn] of Object.entries(record(node.columns))) {
      columns.set(columnName.toLowerCase(), { description: string(record(rawColumn).description) });
    }
    nodes.push({
      uniqueId,
      name,
      relation,
      description: string(node.description),
      sourcePath: string(node.original_file_path) ?? string(node.path),
      columns,
    });
  }
  return nodes.sort((a, b) => a.uniqueId.localeCompare(b.uniqueId));
}

function matchDbtEntity(entity: DataLexEntity, nodes: DbtMigrationNode[]): {
  node?: DbtMigrationNode;
  ambiguity?: Omit<DataLexMigrationAmbiguity, 'path'>;
} {
  const ref = entity.binding?.ref;
  const candidate = normalizeRef(ref || entity.name);
  const exactId = nodes.filter((node) => normalizeRef(node.uniqueId) === candidate);
  if (exactId.length === 1) return { node: exactId[0] };
  const evidence = nodes.filter((node) => [node.name, node.relation].map(normalizeRef).includes(candidate));
  if (evidence.length === 1) return { node: evidence[0] };
  const matches = exactId.length > 1 ? exactId : evidence;
  if (matches.length > 1) {
    return {
      ambiguity: {
        reference: ref || entity.name,
        candidates: matches.map((node) => node.uniqueId).sort(),
        reason: 'Reference matches multiple dbt nodes; use an exact dbt unique_id.',
      },
    };
  }
  return {};
}

function dataLexSourceFingerprint(datalexManifestPath: string, dbtManifestPath: string): string {
  const hash = createHash('sha256');
  for (const path of [datalexManifestPath, dbtManifestPath]) {
    hash.update(path);
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function mirroredDbtFields(entity: DataLexEntity, dbt: DbtMigrationNode): string[] {
  const mirrors: string[] = [];
  if (entity.description) mirrors.push('description');
  for (const field of entity.fields ?? []) {
    if (field.description || field.type || field.nullable !== undefined || field.unique !== undefined || field.primary_key !== undefined) {
      if (dbt.columns.has(field.name.toLowerCase())) mirrors.push(`fields.${field.name}`);
    }
  }
  return mirrors;
}

function dbtPatchForEntity(entity: DataLexEntity, dbt: DbtMigrationNode): Record<string, unknown> | undefined {
  const columns = (entity.fields ?? [])
    .filter((field) => field.description && dbt.columns.has(field.name.toLowerCase()) && dbt.columns.get(field.name.toLowerCase())?.description !== field.description)
    .map((field) => ({ name: field.name, description: field.description }));
  const descriptionChanged = entity.description && entity.description !== dbt.description;
  if (!descriptionChanged && columns.length === 0) return undefined;
  return compact({ name: dbt.name, description: descriptionChanged ? entity.description : undefined, columns: columns.length > 0 ? columns : undefined });
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, candidate]) => candidate !== undefined && candidate !== null && candidate !== ''));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((candidate): candidate is string => typeof candidate === 'string') : [];
}

function entityLookup(domain: string, entity: string): string {
  return `${domain.toLowerCase()}.${entity.toLowerCase()}`;
}

function entityId(domain: string, entity: string): string {
  return `${slug(domain)}_${slug(entity)}`;
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unnamed';
}

function normalizeRef(value: string): string {
  return value.replace(/^ref\(['"]|['"]\)$/g, '').replace(/["`]/g, '').toLowerCase();
}
