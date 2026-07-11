import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import * as yaml from 'js-yaml';
import { domainFolderSlug, renderDomainDeclaration, type DomainInput } from './domain-writer.js';
import { loadDomainPackageRegistry } from './domain-package-registry.js';
import type {
  ManifestFanoutPolicy,
  ManifestRelationshipCardinality,
  ManifestRelationshipValidationEvidence,
} from './types.js';

type UnknownRecord = Record<string, unknown>;

export interface DomainPackageAuthoringInput extends DomainInput {
  id: string;
  exports?: string[];
}

export interface EntityBindingAuthoringInput {
  id: string;
  domain: string;
  dbtModel: string;
  grain?: string;
  keys?: string[];
}

export interface RelationshipAuthoringInput {
  id: string;
  domain: string;
  from: string;
  to: string;
  keys: Array<{ from: string; to: string }>;
  cardinality: ManifestRelationshipCardinality;
  fanout: ManifestFanoutPolicy;
  status?: 'draft' | 'review' | 'certified' | 'deprecated';
  crossDomain?: boolean;
  owner?: string;
  certifiedAgainst?: {
    from: { grain: string; keys: string[] };
    to: { grain: string; keys: string[] };
  };
  validation?: ManifestRelationshipValidationEvidence;
  ownerDomain?: string;
  verb?: string;
  description?: string;
  rationale?: string;
  roles?: { from?: string; to?: string };
  optionality?: { from: 'required' | 'optional' | 'unknown'; to: 'required' | 'optional' | 'unknown' };
  joinTypes?: Array<'left' | 'inner'>;
  aggregation?: { measuresFrom: string[]; dimensionsFrom: string[]; requiresPreAggregation?: boolean };
  temporal?: { factTime: string; validFrom: string; validTo?: string; openEnded?: boolean };
  attributionBlock?: string;
  importRefs?: string[];
  evidenceExpiresAt?: string;
}

export interface ContractAuthoringInput {
  id: string;
  domain: string;
  entities: string[];
  blocks?: string[];
  status?: 'draft' | 'review' | 'certified' | 'deprecated';
  owner?: string;
  requiredEvaluation?: boolean;
  version?: number;
  grain?: string;
  metricRefs?: string[];
  dimensions?: string[];
  allowedFilters?: string[];
  requiredFilters?: string[];
  purpose?: string;
  evaluationRefs?: string[];
}

export interface DomainExportAuthoringInput {
  id: string;
  domain: string;
  version?: number;
  entity?: string;
  metrics?: string[];
  blocks?: string[];
  allowedKeys?: string[];
  allowedDimensions?: string[];
  allowedFilters?: string[];
  purposes?: string[];
  consumerDomains?: string[];
  classification?: string;
  contract?: string;
  status?: 'draft' | 'review' | 'certified' | 'deprecated';
  owner?: string;
}

export interface DomainImportAuthoringInput {
  id?: string;
  domain: string;
  exportRef: string;
  purpose: string;
  status?: 'draft' | 'review' | 'certified' | 'deprecated';
  owner?: string;
}

export type ModelingAuthoringChange =
  | { operation: 'upsert_domain'; value: DomainPackageAuthoringInput }
  | { operation: 'upsert_entity'; value: EntityBindingAuthoringInput }
  | { operation: 'upsert_relationship'; value: RelationshipAuthoringInput }
  | { operation: 'upsert_contract'; value: ContractAuthoringInput }
  | { operation: 'upsert_export'; value: DomainExportAuthoringInput }
  | { operation: 'upsert_import'; value: DomainImportAuthoringInput };

export interface ModelingSourcePatch {
  path: string;
  before: string;
  after: string;
  changed: boolean;
}

export interface ModelingChangePreview {
  operation: ModelingAuthoringChange['operation'];
  patches: ModelingSourcePatch[];
  fingerprint: string;
}

export interface DbtNodeAuthoringDetail {
  uniqueId: string;
  name: string;
  resourceType: 'model' | 'source';
  relation?: string;
  sourcePath?: string;
  description?: string;
  columns: Array<{
    name: string;
    type?: string;
    description?: string;
    tests: string[];
  }>;
  tests: string[];
  dqlMeta?: { grain?: string; keys: string[] };
}

export function previewModelingChange(projectRoot: string, change: ModelingAuthoringChange): ModelingChangePreview {
  const root = resolve(projectRoot);
  const patches = change.operation === 'upsert_domain'
    ? previewDomain(root, change.value)
    : change.operation === 'upsert_entity'
      ? [previewEntity(root, change.value)]
      : change.operation === 'upsert_relationship'
        ? [previewRelationship(root, change.value)]
        : change.operation === 'upsert_contract'
          ? [previewContract(root, change.value)]
          : change.operation === 'upsert_export'
            ? [previewExport(root, change.value)]
            : [previewImport(root, change.value)];
  return {
    operation: change.operation,
    patches,
    fingerprint: hash(patches.map((patch) => ({ path: patch.path, before: patch.before, after: patch.after }))),
  };
}

export function applyModelingChange(
  projectRoot: string,
  change: ModelingAuthoringChange,
  expectedFingerprint?: string,
): ModelingChangePreview {
  const preview = previewModelingChange(projectRoot, change);
  if (expectedFingerprint && preview.fingerprint !== expectedFingerprint) {
    throw new Error('Modeling source changed after the preview. Refresh the preview before applying.');
  }
  for (const patch of preview.patches) {
    if (!patch.changed) continue;
    const absolute = safeProjectPath(projectRoot, patch.path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, patch.after, 'utf8');
  }
  return preview;
}

export function loadDbtNodeAuthoringDetail(manifestPath: string, uniqueId: string): DbtNodeAuthoringDetail | undefined {
  const manifest = readJson(manifestPath);
  const raw = asRecord(asRecord(manifest.nodes)[uniqueId] ?? asRecord(manifest.sources)[uniqueId]);
  if (Object.keys(raw).length === 0) return undefined;
  const resourceType = raw.resource_type === 'source' ? 'source' : raw.resource_type === 'model' ? 'model' : undefined;
  if (!resourceType) return undefined;
  const catalogPath = join(dirname(manifestPath), 'catalog.json');
  const catalog = existsSync(catalogPath) ? readJson(catalogPath) : {};
  const catalogEntry = asRecord(asRecord(catalog[resourceType === 'source' ? 'sources' : 'nodes'])[uniqueId]);
  const catalogColumns = asRecord(catalogEntry.columns);
  const manifestColumns = asRecord(raw.columns);
  const childMap = asRecord(manifest.child_map);
  const childIds = Array.isArray(childMap[uniqueId]) ? childMap[uniqueId] as unknown[] : [];
  const testNodes = asRecord(manifest.nodes);
  const modelTests = childIds
    .map((id) => asRecord(testNodes[String(id)]))
    .filter((node) => node.resource_type === 'test')
    .map((node) => String(node.name ?? node.unique_id ?? 'test'))
    .sort();
  const names = new Set([...Object.keys(manifestColumns), ...Object.keys(catalogColumns)]);
  const columns = [...names].sort().map((name) => {
    const manifestColumn = asRecord(manifestColumns[name]);
    const catalogColumn = asRecord(catalogColumns[name]);
    return {
      name,
      type: stringValue(catalogColumn.type),
      description: stringValue(manifestColumn.description),
      tests: stringArray(manifestColumn.tests),
    };
  });
  const dqlMeta = asRecord(asRecord(raw.meta).dql);
  return {
    uniqueId,
    name: stringValue(raw.alias) ?? stringValue(raw.identifier) ?? stringValue(raw.name) ?? uniqueId,
    resourceType,
    relation: relationName(raw),
    sourcePath: stringValue(raw.original_file_path) ?? stringValue(raw.path),
    description: stringValue(raw.description),
    columns,
    tests: modelTests,
    dqlMeta: Object.keys(dqlMeta).length > 0
      ? { grain: stringValue(dqlMeta.grain), keys: stringArray(dqlMeta.keys ?? dqlMeta.key ?? dqlMeta.primary_key) }
      : undefined,
  };
}

function previewDomain(projectRoot: string, value: DomainPackageAuthoringInput): ModelingSourcePatch[] {
  const id = requiredId(value.id, 'domain');
  const root = packageRootForWrite(projectRoot, id, value.parent);
  const declarationPath = relative(projectRoot, join(root, 'domain.dql')).replace(/\\/g, '/');
  return [
    sourcePatch(projectRoot, declarationPath, renderDomainDeclaration({
      ...value,
      id,
      name: value.name || id.split('.').at(-1) || id,
      exports: cleanStrings(value.exports),
    })),
  ];
}

function previewEntity(projectRoot: string, value: EntityBindingAuthoringInput): ModelingSourcePatch {
  const id = requiredId(value.id, 'entity');
  const domain = requiredId(value.domain, 'domain');
  const dbtModel = requiredId(value.dbtModel, 'dbt model');
  const path = modelingFile(projectRoot, domain, 'entities.dql.yaml');
  const entity: UnknownRecord = {
    id,
    dbt_model: dbtModel,
    ...(value.grain ? { grain: value.grain } : {}),
    ...(cleanStrings(value.keys).length > 0 ? { keys: cleanStrings(value.keys) } : {}),
  };
  return upsertListPatch(projectRoot, path, 'entities', 'id', entity);
}

function previewRelationship(projectRoot: string, value: RelationshipAuthoringInput): ModelingSourcePatch {
  const id = requiredId(value.id, 'relationship');
  const domain = requiredId(value.domain, 'domain');
  if (!value.from || !value.to || !Array.isArray(value.keys) || value.keys.length === 0) {
    throw new Error('Relationship requires from, to, and at least one key pair.');
  }
  const relationship: UnknownRecord = {
    id,
    from: value.from,
    to: value.to,
    keys: value.keys.map((key) => ({ from: key.from, to: key.to })),
    cardinality: value.cardinality,
    fanout: value.fanout,
    status: value.status ?? 'draft',
    ...(value.crossDomain ? { crossDomain: true } : {}),
    ...(value.owner ? { owner: value.owner } : {}),
    ...(value.ownerDomain ? { owner_domain: value.ownerDomain } : {}),
    ...(value.verb ? { verb: value.verb } : {}),
    ...(value.description ? { description: value.description } : {}),
    ...(value.rationale ? { rationale: value.rationale } : {}),
    ...(value.roles ? { roles: value.roles } : {}),
    ...(value.optionality ? { optionality: value.optionality } : {}),
    ...(value.joinTypes?.length ? { join_types: value.joinTypes } : {}),
    ...(value.aggregation ? { aggregation: {
      measures_from: cleanStrings(value.aggregation.measuresFrom),
      dimensions_from: cleanStrings(value.aggregation.dimensionsFrom),
      ...(value.aggregation.requiresPreAggregation ? { requires_pre_aggregation: true } : {}),
    } } : {}),
    ...(value.temporal ? { temporal: {
      fact_time: value.temporal.factTime,
      valid_from: value.temporal.validFrom,
      ...(value.temporal.validTo ? { valid_to: value.temporal.validTo } : {}),
      ...(value.temporal.openEnded ? { open_ended: true } : {}),
    } } : {}),
    ...(value.attributionBlock ? { attribution_block: value.attributionBlock } : {}),
    ...(value.importRefs?.length ? { imports: cleanStrings(value.importRefs) } : {}),
    ...(value.evidenceExpiresAt ? { evidence_expires_at: value.evidenceExpiresAt } : {}),
    ...(value.certifiedAgainst ? { certifiedAgainst: value.certifiedAgainst } : {}),
    ...(value.validation ? { validation: validationSource(value.validation) } : {}),
  };
  return upsertListPatch(projectRoot, modelingFile(projectRoot, domain, 'relationships.dql.yaml'), 'relationships', 'id', relationship);
}

function previewContract(projectRoot: string, value: ContractAuthoringInput): ModelingSourcePatch {
  const id = requiredId(value.id, 'contract');
  const domain = requiredId(value.domain, 'domain');
  const contract: UnknownRecord = {
    id,
    entities: cleanStrings(value.entities),
    blocks: cleanStrings(value.blocks),
    status: value.status ?? 'draft',
    ...(value.owner ? { owner: value.owner } : {}),
    requiredEvaluation: value.requiredEvaluation !== false,
    version: value.version ?? 1,
    ...(value.grain ? { grain: value.grain } : {}),
    ...(value.metricRefs?.length ? { metrics: cleanStrings(value.metricRefs) } : {}),
    ...(value.dimensions?.length ? { dimensions: cleanStrings(value.dimensions) } : {}),
    ...(value.allowedFilters?.length ? { allowed_filters: cleanStrings(value.allowedFilters) } : {}),
    ...(value.requiredFilters?.length ? { required_filters: cleanStrings(value.requiredFilters) } : {}),
    ...(value.purpose ? { purpose: value.purpose } : {}),
    ...(value.evaluationRefs?.length ? { evaluations: cleanStrings(value.evaluationRefs) } : {}),
  };
  return upsertListPatch(projectRoot, modelingFile(projectRoot, domain, 'contracts.dql.yaml'), 'contracts', 'id', contract);
}

function previewExport(projectRoot: string, value: DomainExportAuthoringInput): ModelingSourcePatch {
  const id = requiredId(value.id, 'domain export');
  const domain = requiredId(value.domain, 'domain');
  const exported: UnknownRecord = {
    id,
    version: value.version ?? 1,
    ...(value.entity ? { entity: value.entity } : {}),
    metrics: cleanStrings(value.metrics),
    blocks: cleanStrings(value.blocks),
    allowed_keys: cleanStrings(value.allowedKeys),
    allowed_dimensions: cleanStrings(value.allowedDimensions),
    allowed_filters: cleanStrings(value.allowedFilters),
    purposes: cleanStrings(value.purposes),
    consumer_domains: cleanStrings(value.consumerDomains),
    ...(value.classification ? { classification: value.classification } : {}),
    ...(value.contract ? { contract: value.contract } : {}),
    status: value.status ?? 'draft',
    ...(value.owner ? { owner: value.owner } : {}),
  };
  return upsertListPatch(projectRoot, modelingFile(projectRoot, domain, 'interfaces.dql.yaml'), 'exports', 'id', exported);
}

function previewImport(projectRoot: string, value: DomainImportAuthoringInput): ModelingSourcePatch {
  const domain = requiredId(value.domain, 'domain');
  const exportRef = requiredId(value.exportRef.replace('@', '.v'), 'domain export reference').replace(/\.v(\d+)$/, '@$1');
  const id = value.id?.trim() || `${domain}:${exportRef}`;
  const imported: UnknownRecord = {
    id,
    export: exportRef,
    purpose: value.purpose,
    status: value.status ?? 'draft',
    ...(value.owner ? { owner: value.owner } : {}),
  };
  return upsertListPatch(projectRoot, modelingFile(projectRoot, domain, 'interfaces.dql.yaml'), 'imports', 'id', imported);
}

function validationSource(value: ManifestRelationshipValidationEvidence): UnknownRecord {
  return {
    status: value.status,
    checked_at: value.checkedAt,
    query_fingerprint: value.queryFingerprint,
    from_rows: value.fromRows,
    to_rows: value.toRows,
    joined_rows: value.joinedRows,
    from_null_keys: value.fromNullKeys,
    to_null_keys: value.toNullKeys,
    unmatched_from: value.unmatchedFrom,
    max_from_per_key: value.maxFromPerKey,
    max_to_per_key: value.maxToPerKey,
    ...(value.message ? { message: value.message } : {}),
  };
}

function upsertListPatch(
  projectRoot: string,
  path: string,
  listKey: string,
  identityKey: string,
  value: UnknownRecord,
): ModelingSourcePatch {
  const absolute = safeProjectPath(projectRoot, path);
  const before = existsSync(absolute) ? readFileSync(absolute, 'utf8') : '';
  const document = before.trim() ? asRecord(yaml.load(before)) : {};
  const list = Array.isArray(document[listKey]) ? [...document[listKey] as unknown[]] : [];
  const index = list.findIndex((entry) => asRecord(entry)[identityKey] === value[identityKey]);
  if (index >= 0) list[index] = value;
  else list.push(value);
  list.sort((left, right) => String(asRecord(left)[identityKey] ?? '').localeCompare(String(asRecord(right)[identityKey] ?? '')));
  document[listKey] = list;
  return { path, before, after: dumpYaml(document), changed: before !== dumpYaml(document) };
}

function sourcePatch(projectRoot: string, path: string, after: string): ModelingSourcePatch {
  const absolute = safeProjectPath(projectRoot, path);
  const before = existsSync(absolute) ? readFileSync(absolute, 'utf8') : '';
  return { path, before, after, changed: before !== after };
}

function modelingFile(projectRoot: string, domain: string, name: string): string {
  const root = findPackageRoot(projectRoot, domain);
  if (!root) throw new Error(`Domain Package "${domain}" does not exist. Create the domain first.`);
  return relative(projectRoot, join(root, 'modeling', name)).replace(/\\/g, '/');
}

function packageRootForWrite(projectRoot: string, id: string, parent?: string): string {
  const existing = findPackageRoot(projectRoot, id);
  if (existing) return existing;
  if (parent) {
    const parentRoot = findPackageRoot(projectRoot, parent);
    if (!parentRoot) throw new Error(`Parent Domain Package "${parent}" does not exist.`);
    return join(parentRoot, domainFolderSlug(id.split('.').pop() ?? id));
  }
  return join(projectRoot, 'domains', domainFolderSlug(id));
}

function findPackageRoot(projectRoot: string, id: string): string | undefined {
  return loadDomainPackageRegistry(projectRoot).get(id)?.root;
}

function safeProjectPath(projectRoot: string, relativePath: string): string {
  const root = resolve(projectRoot);
  const path = resolve(root, relativePath);
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error('Modeling path escapes the project root.');
  if (!relativePath.replace(/\\/g, '/').startsWith('domains/')) throw new Error('Modeling writes are restricted to domains/.');
  return path;
}

function dumpYaml(value: unknown): string {
  return yaml.dump(value, { noRefs: true, lineWidth: -1, sortKeys: false, noCompatMode: true }).trimEnd() + '\n';
}

function readJson(path: string): UnknownRecord {
  return asRecord(JSON.parse(readFileSync(path, 'utf8')));
}

function relationName(raw: UnknownRecord): string | undefined {
  const database = stringValue(raw.database);
  const schema = stringValue(raw.schema);
  const identifier = stringValue(raw.alias) ?? stringValue(raw.identifier) ?? stringValue(raw.name);
  return [database, schema, identifier].filter(Boolean).join('.') || undefined;
}

function requiredId(value: string | undefined, label: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(normalized)) throw new Error(`${label} requires a safe non-empty id.`);
  return normalized;
}

function cleanStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))].sort();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {};
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
