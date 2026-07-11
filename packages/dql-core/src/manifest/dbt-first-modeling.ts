/**
 * dbt-first domain modeling (manifest v3).
 *
 * The loader deliberately reads dbt artifacts as the physical source of truth
 * and emits only stable references and DQL-owned analytical policy. Do not add
 * copied dbt descriptions, column catalogs, tests, or MetricFlow formulas here.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import * as yaml from 'js-yaml';
import type {
  ManifestConformanceDeclaration,
  ManifestDbtFirstModeling,
  ManifestDbtNodeProvenance,
  ManifestDbtProvenance,
  ManifestDiagnostic,
  ManifestDomainPackage,
  ManifestDomainRelationshipLineage,
  ManifestFanoutPolicy,
  ManifestMetricFlowProvenance,
  ManifestModelContract,
  ManifestModelEntity,
  ManifestModelRelationship,
  ManifestModelRule,
  ManifestRelationshipCardinality,
} from './types.js';

type UnknownRecord = Record<string, unknown>;

interface DbtNodeFacts {
  uniqueId: string;
  resourceType: 'model' | 'source';
  name: string;
  packageName?: string;
  relation?: string;
  sourcePath?: string;
  grain?: string;
  keys: string[];
  columns: Set<string>;
  identityFingerprint: string;
}

interface DomainSource {
  id: string;
  root: string;
  filePath: string;
  parent?: string;
  exports: string[];
  owner?: string;
}

interface RawEntity {
  id?: unknown;
  dbt_model?: unknown;
  dbtModel?: unknown;
  domain?: unknown;
  grain?: unknown;
  keys?: unknown;
}

interface RawRelationship {
  id?: unknown;
  from?: unknown;
  to?: unknown;
  keys?: unknown;
  cardinality?: unknown;
  fanout?: unknown;
  status?: unknown;
  crossDomain?: unknown;
  owner?: unknown;
  certifiedAgainst?: unknown;
}

/** Result of compiling the v3 overlay. The raw dbt facts never leave this module. */
export interface DbtFirstModelingLoadResult {
  provenance: ManifestDbtProvenance;
  modeling: ManifestDbtFirstModeling;
  diagnostics: ManifestDiagnostic[];
}

/** Returns the sibling dbt artifact only when it exists. */
export function siblingDbtArtifact(manifestPath: string, name: string): string | undefined {
  const candidate = join(dirname(manifestPath), name);
  return existsSync(candidate) ? candidate : undefined;
}

/**
 * Build v3 provenance and sparse packages from a dbt manifest. This function
 * is intentionally deterministic: it uses source content and paths only, not
 * wall-clock time.
 */
export function loadDbtFirstModeling(
  projectRoot: string,
  manifestPath: string,
): DbtFirstModelingLoadResult {
  const diagnostics: ManifestDiagnostic[] = [];
  const rawManifest = readJson(manifestPath, 'dbt manifest', diagnostics);
  const catalogPath = siblingDbtArtifact(manifestPath, 'catalog.json');
  const semanticManifestPath = siblingDbtArtifact(manifestPath, 'semantic_manifest.json');
  const rawCatalog = catalogPath ? readJson(catalogPath, 'dbt catalog', diagnostics) : undefined;
  const rawSemantic = semanticManifestPath
    ? readJson(semanticManifestPath, 'dbt semantic manifest', diagnostics)
    : undefined;

  const nodeFacts = new Map<string, DbtNodeFacts>();
  const nodeProvenance: Record<string, ManifestDbtNodeProvenance> = {};
  const rawNodes = asRecord(rawManifest?.nodes);
  const rawSources = asRecord(rawManifest?.sources);

  for (const [uniqueId, node] of [...Object.entries(rawNodes), ...Object.entries(rawSources)]) {
    const raw = asRecord(node);
    const resourceType = raw.resource_type === 'model' ? 'model' : raw.resource_type === 'source' ? 'source' : undefined;
    if (!resourceType) continue;

    const name = stringValue(raw.alias) ?? stringValue(raw.identifier) ?? stringValue(raw.name);
    if (!name) continue;
    const sourcePath = stringValue(raw.original_file_path) ?? stringValue(raw.path);
    const relation = relationName(raw, name);
    const dqlMeta = asRecord(asRecord(raw.meta).dql);
    const keys = stringArray(dqlMeta.keys ?? dqlMeta.key ?? dqlMeta.primary_key);
    const grain = stringValue(dqlMeta.grain);
    const columns = new Set(Object.keys(asRecord(raw.columns)).map((column) => column.toLowerCase()));
    const catalogEntry = catalogNode(rawCatalog, uniqueId);
    const identityFingerprint = fingerprint({
      uniqueId,
      relation,
      grain,
      keys: [...keys].sort(),
      columns: [...columns].sort(),
      dqlMeta,
    });

    nodeFacts.set(uniqueId, {
      uniqueId,
      resourceType,
      name,
      packageName: stringValue(raw.package_name),
      relation,
      sourcePath,
      grain,
      keys,
      columns,
      identityFingerprint,
    });
    nodeProvenance[uniqueId] = {
      uniqueId,
      resourceType,
      name,
      packageName: stringValue(raw.package_name),
      relation,
      sourcePath,
      identityFingerprint,
      available: {
        description: Boolean(stringValue(raw.description)),
        columns: columns.size > 0,
        tests: hasDbtTests(raw),
        catalogTypes: hasCatalogTypes(catalogEntry),
        dqlMeta: Object.keys(dqlMeta).length > 0,
      },
    };
  }

  const metricFlow = collectMetricFlowProvenance(rawManifest, rawSemantic);
  const provenance: ManifestDbtProvenance = {
    manifestPath,
    catalogPath,
    semanticManifestPath,
    manifestFingerprint: fileFingerprint(manifestPath),
    catalogFingerprint: catalogPath ? fileFingerprint(catalogPath) : undefined,
    semanticManifestFingerprint: semanticManifestPath ? fileFingerprint(semanticManifestPath) : undefined,
    projectName: stringValue(asRecord(rawManifest?.metadata).project_name),
    nodes: sortRecord(nodeProvenance),
    metricFlow: sortRecord(metricFlow),
  };

  const domainSources = loadDomainSources(projectRoot, diagnostics);
  const modelFiles = collectModelingFiles(domainSources);
  const entities: Record<string, ManifestModelEntity> = {};
  const rawRelationships: Array<{ value: RawRelationship; sourcePath: string; domain: string }> = [];
  const contracts: Record<string, ManifestModelContract> = {};
  const conformance: Record<string, ManifestConformanceDeclaration> = {};
  const rules: Record<string, ManifestModelRule> = {};

  for (const filePath of modelFiles) {
    const source = readYaml(filePath, diagnostics);
    if (!source) continue;
    const packageSource = packageForFile(domainSources, filePath);
    const domain = stringValue(source.domain) ?? packageSource?.id;
    const relPath = relative(projectRoot, filePath).replace(/\\/g, '/');
    if (!domain) {
      diagnostics.push(modelingError(relPath, 'modeling source is not inside a Domain Package and does not declare `domain`'));
      continue;
    }

    for (const rawEntity of arrayOfRecords(source.entities) as RawEntity[]) {
      const id = stringValue(rawEntity.id);
      const dbtUniqueId = stringValue(rawEntity.dbt_model) ?? stringValue(rawEntity.dbtModel);
      if (!id || !dbtUniqueId) {
        diagnostics.push(modelingError(relPath, 'each entity requires `id` and `dbt_model`'));
        continue;
      }
      if (entities[id]) {
        diagnostics.push(modelingError(relPath, `duplicate entity "${id}" also declared in ${entities[id].sourcePath}`));
        continue;
      }
      const dbt = nodeFacts.get(dbtUniqueId);
      if (!dbt || dbt.resourceType !== 'model') {
        diagnostics.push(modelingError(relPath, `entity "${id}" references unknown dbt model "${dbtUniqueId}"`));
        continue;
      }
      const explicitGrain = stringValue(rawEntity.grain);
      const explicitKeys = stringArray(rawEntity.keys);
      const grain = explicitGrain ?? dbt.grain;
      const keys = explicitKeys.length > 0 ? explicitKeys : dbt.keys;
      entities[id] = {
        id,
        domain: stringValue(rawEntity.domain) ?? domain,
        dbtUniqueId,
        grain,
        keys,
        sourcePath: relPath,
        identityFingerprint: fingerprint({
          dbt: dbt.identityFingerprint,
          grain,
          keys: [...keys].sort(),
        }),
      };
    }

    for (const rawRelationship of arrayOfRecords(source.relationships) as RawRelationship[]) {
      rawRelationships.push({ value: rawRelationship, sourcePath: relPath, domain });
    }

    for (const rawContract of arrayOfRecords(source.contracts)) {
      const id = stringValue(rawContract.id);
      if (!id) {
        diagnostics.push(modelingError(relPath, 'each contract requires `id`'));
        continue;
      }
      if (contracts[id]) {
        diagnostics.push(modelingError(relPath, `duplicate contract "${id}" also declared in ${contracts[id].sourcePath}`));
        continue;
      }
      contracts[id] = {
        id,
        domain: stringValue(rawContract.domain) ?? domain,
        entities: stringArray(rawContract.entities),
        blocks: stringArray(rawContract.blocks),
        status: lifecycle(rawContract.status),
        owner: stringValue(rawContract.owner),
        sourcePath: relPath,
        requiredEvaluation: rawContract.required_evaluation !== false && rawContract.requiredEvaluation !== false,
      };
    }

    for (const rawDeclaration of arrayOfRecords(source.conformance)) {
      const id = stringValue(rawDeclaration.id);
      const rule = stringValue(rawDeclaration.rule);
      if (!id || !rule) {
        diagnostics.push(modelingError(relPath, 'each conformance declaration requires `id` and `rule`'));
        continue;
      }
      conformance[id] = { id, entities: stringArray(rawDeclaration.entities), rule, sourcePath: relPath };
    }

    for (const rawRule of arrayOfRecords(source.rules)) {
      const id = stringValue(rawRule.id);
      const expression = stringValue(rawRule.expression);
      if (!id || !expression) {
        diagnostics.push(modelingError(relPath, 'each rule requires `id` and `expression`'));
        continue;
      }
      rules[id] = {
        id,
        domain: stringValue(rawRule.domain) ?? domain,
        kind: ruleKind(rawRule.kind),
        expression,
        sourcePath: relPath,
      };
    }
  }

  const relationships = buildRelationships(rawRelationships, entities, nodeFacts, domainSources, diagnostics);
  validateContracts(contracts, entities, diagnostics);
  validateConformance(conformance, entities, diagnostics);
  const packages = Object.fromEntries([...domainSources.values()]
    .map((source): [string, ManifestDomainPackage] => [source.id, {
      id: source.id,
      filePath: relative(projectRoot, source.filePath).replace(/\\/g, '/'),
      parent: source.parent,
      exports: source.exports,
      owner: source.owner,
    }])
    .sort(([a], [b]) => a.localeCompare(b)));
  const domainLineage = Object.values(relationships)
    .filter((relationship) => entities[relationship.from] && entities[relationship.to])
    .map((relationship): ManifestDomainRelationshipLineage => ({
      relationship: relationship.id,
      fromDomain: entities[relationship.from].domain,
      toDomain: entities[relationship.to].domain,
      automaticJoinAllowed: relationship.automaticJoinAllowed,
      staleCertification: relationship.staleCertification,
    }))
    .sort((a, b) => a.relationship.localeCompare(b.relationship));

  return {
    provenance,
    modeling: {
      mode: 'dbt-first',
      packages,
      entities: sortRecord(entities),
      relationships: sortRecord(relationships),
      contracts: sortRecord(contracts),
      conformance: sortRecord(conformance),
      rules: sortRecord(rules),
      domainLineage,
    },
    diagnostics,
  };
}

function buildRelationships(
  rawRelationships: Array<{ value: RawRelationship; sourcePath: string; domain: string }>,
  entities: Record<string, ManifestModelEntity>,
  nodeFacts: Map<string, DbtNodeFacts>,
  packages: Map<string, DomainSource>,
  diagnostics: ManifestDiagnostic[],
): Record<string, ManifestModelRelationship> {
  const relationships: Record<string, ManifestModelRelationship> = {};
  for (const { value, sourcePath } of rawRelationships) {
    const id = stringValue(value.id);
    const from = stringValue(value.from);
    const to = stringValue(value.to);
    if (!id || !from || !to) {
      diagnostics.push(modelingError(sourcePath, 'each relationship requires `id`, `from`, and `to`'));
      continue;
    }
    if (relationships[id]) {
      diagnostics.push(modelingError(sourcePath, `duplicate relationship "${id}" also declared in ${relationships[id].sourcePath}`));
      continue;
    }
    const fromEntity = entities[from];
    const toEntity = entities[to];
    if (!fromEntity || !toEntity) {
      diagnostics.push(modelingError(sourcePath, `relationship "${id}" references unknown entity "${!fromEntity ? from : toEntity ? to : `${from}" and "${to}`}`));
      continue;
    }
    const keys = relationshipKeys(value.keys);
    if (keys.length === 0) {
      diagnostics.push(modelingError(sourcePath, `relationship "${id}" requires one or more key pairs`));
      continue;
    }
    const fromFacts = nodeFacts.get(fromEntity.dbtUniqueId);
    const toFacts = nodeFacts.get(toEntity.dbtUniqueId);
    for (const pair of keys) {
      if (fromFacts && !fromFacts.columns.has(pair.from.toLowerCase())) {
        diagnostics.push(modelingError(sourcePath, `relationship "${id}" key "${pair.from}" is not a column of ${fromEntity.dbtUniqueId}`));
      }
      if (toFacts && !toFacts.columns.has(pair.to.toLowerCase())) {
        diagnostics.push(modelingError(sourcePath, `relationship "${id}" key "${pair.to}" is not a column of ${toEntity.dbtUniqueId}`));
      }
    }
    const cardinality = relationshipCardinality(value.cardinality);
    const fanout = fanoutPolicy(value.fanout);
    const status = lifecycle(value.status);
    const crossDomain = value.crossDomain === true || fromEntity.domain !== toEntity.domain;
    const certificationFingerprint = certificationProof(value.certifiedAgainst, keys, cardinality, fanout);
    const currentProof = fingerprint({
      from: { grain: fromEntity.grain, keys: [...fromEntity.keys].sort(), identity: fromEntity.identityFingerprint },
      to: { grain: toEntity.grain, keys: [...toEntity.keys].sort(), identity: toEntity.identityFingerprint },
      relationshipKeys: keys,
      cardinality,
      fanout,
    });
    const currentCertificationProof = fingerprint({
      from: { grain: fromEntity.grain, keys: [...fromEntity.keys].sort() },
      to: { grain: toEntity.grain, keys: [...toEntity.keys].sort() },
      relationshipKeys: keys,
      cardinality,
      fanout,
    });
    const staleCertification = status === 'certified' && (
      !certificationFingerprint || certificationFingerprint !== currentCertificationProof
    );
    if (status === 'certified' && !certificationFingerprint) {
      diagnostics.push(modelingError(sourcePath, `certified relationship "${id}" requires ` + '`certifiedAgainst` so DQL can detect dbt identity drift'));
    } else if (staleCertification) {
      diagnostics.push({
        kind: 'modeling',
        filePath: sourcePath,
        severity: 'warning',
        message: `certification for relationship "${id}" is stale because its dbt identity/grain proof changed`,
      });
    }
    const exported = !crossDomain || packages.get(fromEntity.domain)?.exports.includes(from) === true;
    if (crossDomain && !exported) {
      diagnostics.push(modelingError(sourcePath, `cross-domain relationship "${id}" requires ${fromEntity.domain} to export entity "${from}"`));
    }
    const automaticJoinAllowed = status === 'certified'
      && !staleCertification
      && exported
      && (cardinality === 'many_to_one' || cardinality === 'one_to_many' || cardinality === 'one_to_one')
      && fanout === 'safe';
    relationships[id] = {
      id,
      from,
      to,
      keys,
      cardinality,
      fanout,
      status,
      crossDomain,
      owner: stringValue(value.owner),
      sourcePath,
      fingerprint: currentProof,
      certificationFingerprint,
      staleCertification,
      automaticJoinAllowed,
    };
  }
  return relationships;
}

function certificationProof(
  value: unknown,
  relationshipKeys: Array<{ from: string; to: string }>,
  cardinality: ManifestRelationshipCardinality,
  fanout: ManifestFanoutPolicy,
): string | undefined {
  if (!asRecord(value) || Object.keys(asRecord(value)).length === 0) return undefined;
  const from = asRecord(asRecord(value).from);
  const to = asRecord(asRecord(value).to);
  const fromGrain = stringValue(from.grain);
  const toGrain = stringValue(to.grain);
  const fromKeys = stringArray(from.keys);
  const toKeys = stringArray(to.keys);
  if (!fromGrain || !toGrain || fromKeys.length === 0 || toKeys.length === 0) return undefined;
  return fingerprint({
    from: { grain: fromGrain, keys: fromKeys.sort() },
    to: { grain: toGrain, keys: toKeys.sort() },
    relationshipKeys,
    cardinality,
    fanout,
  });
}

function validateContracts(
  contracts: Record<string, ManifestModelContract>,
  entities: Record<string, ManifestModelEntity>,
  diagnostics: ManifestDiagnostic[],
): void {
  for (const contract of Object.values(contracts)) {
    for (const entity of contract.entities) {
      if (!entities[entity]) diagnostics.push(modelingError(contract.sourcePath, `contract "${contract.id}" references unknown entity "${entity}"`));
    }
  }
}

function validateConformance(
  declarations: Record<string, ManifestConformanceDeclaration>,
  entities: Record<string, ManifestModelEntity>,
  diagnostics: ManifestDiagnostic[],
): void {
  for (const declaration of Object.values(declarations)) {
    if (declaration.entities.length < 2) {
      diagnostics.push(modelingError(declaration.sourcePath, `conformance "${declaration.id}" must name at least two entities`));
    }
    for (const entity of declaration.entities) {
      if (!entities[entity]) diagnostics.push(modelingError(declaration.sourcePath, `conformance "${declaration.id}" references unknown entity "${entity}"`));
    }
  }
}

function loadDomainSources(projectRoot: string, diagnostics: ManifestDiagnostic[]): Map<string, DomainSource> {
  const sources = new Map<string, DomainSource>();
  const root = join(projectRoot, 'domains');
  for (const filePath of scanYaml(root).filter((path) => basename(path) === 'domain.dql.yaml' || basename(path) === 'domain.dql.yml')) {
    const source = readYaml(filePath, diagnostics);
    if (!source) continue;
    const id = stringValue(source.id) ?? stringValue(source.domain) ?? basename(dirname(filePath));
    if (sources.has(id)) {
      diagnostics.push(modelingError(relative(projectRoot, filePath), `duplicate Domain Package "${id}"`));
      continue;
    }
    sources.set(id, {
      id,
      root: dirname(filePath),
      filePath,
      parent: stringValue(source.parent),
      exports: stringArray(source.exports),
      owner: stringValue(source.owner),
    });
  }
  return sources;
}

function collectModelingFiles(packages: Map<string, DomainSource>): string[] {
  return [...new Set([...packages.values()].flatMap((pkg) => scanYaml(join(pkg.root, 'modeling'))))].sort();
}

function packageForFile(packages: Map<string, DomainSource>, filePath: string): DomainSource | undefined {
  return [...packages.values()]
    .filter((pkg) => filePath.startsWith(`${pkg.root}${sep}`))
    .sort((a, b) => b.root.length - a.root.length)[0];
}

function collectMetricFlowProvenance(rawManifest: UnknownRecord | undefined, rawSemantic: UnknownRecord | undefined): Record<string, ManifestMetricFlowProvenance> {
  const metrics: Record<string, ManifestMetricFlowProvenance> = {};
  for (const [uniqueId, raw] of Object.entries(asRecord(rawManifest?.metrics))) {
    const metric = asRecord(raw);
    const name = stringValue(metric.name);
    if (!name) continue;
    metrics[uniqueId] = {
      uniqueId,
      name,
      sourcePath: stringValue(metric.original_file_path) ?? stringValue(metric.path),
      semanticModel: stringValue(asRecord(metric.type_params).semantic_model),
      fingerprint: fingerprint({ uniqueId, name, semanticModel: asRecord(metric.type_params).semantic_model }),
    };
  }
  for (const [uniqueId, raw] of Object.entries(asRecord(rawSemantic?.metrics))) {
    const metric = asRecord(raw);
    const name = stringValue(metric.name) ?? uniqueId;
    if (metrics[uniqueId]) continue;
    metrics[uniqueId] = {
      uniqueId,
      name,
      sourcePath: stringValue(metric.path),
      semanticModel: stringValue(metric.semantic_model),
      fingerprint: fingerprint({ uniqueId, name, semanticModel: metric.semantic_model }),
    };
  }
  return metrics;
}

function readJson(path: string, label: string, diagnostics: ManifestDiagnostic[]): UnknownRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return asRecord(parsed);
  } catch (error) {
    diagnostics.push({ kind: 'dbt', filePath: path, severity: 'error', message: `could not read ${label}: ${error instanceof Error ? error.message : String(error)}` });
    return undefined;
  }
}

function readYaml(filePath: string, diagnostics: ManifestDiagnostic[]): UnknownRecord | undefined {
  try {
    return asRecord(yaml.load(readFileSync(filePath, 'utf8')));
  } catch (error) {
    diagnostics.push(modelingError(filePath, `could not parse YAML: ${error instanceof Error ? error.message : String(error)}`));
    return undefined;
  }
}

function scanYaml(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...scanYaml(fullPath));
    else if (entry.isFile() && (extname(entry.name) === '.yaml' || extname(entry.name) === '.yml')) files.push(fullPath);
  }
  return files.sort();
}

function catalogNode(rawCatalog: UnknownRecord | undefined, uniqueId: string): UnknownRecord {
  return asRecord(asRecord(rawCatalog?.nodes)[uniqueId] ?? asRecord(rawCatalog?.sources)[uniqueId]);
}

function hasCatalogTypes(entry: UnknownRecord): boolean {
  return Object.values(asRecord(entry.columns)).some((column) => Boolean(stringValue(asRecord(column).type)));
}

function hasDbtTests(node: UnknownRecord): boolean {
  return Object.values(asRecord(node.columns)).some((column) => {
    const rawColumn = asRecord(column);
    const tests = rawColumn.tests ?? rawColumn.data_tests;
    return Array.isArray(tests) ? tests.length > 0 : Object.keys(asRecord(tests)).length > 0;
  }) || Object.keys(asRecord(node.tests)).length > 0;
}

function relationName(node: UnknownRecord, name: string): string | undefined {
  const database = stringValue(node.database);
  const schema = stringValue(node.schema);
  return [database, schema, name].filter(Boolean).join('.') || undefined;
}

function relationshipKeys(value: unknown): Array<{ from: string; to: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const pair = asRecord(item);
    const from = stringValue(pair.from);
    const to = stringValue(pair.to);
    return from && to ? [{ from, to }] : [];
  });
}

function relationshipCardinality(value: unknown): ManifestRelationshipCardinality {
  return value === 'one_to_one' || value === 'one_to_many' || value === 'many_to_one' || value === 'many_to_many'
    ? value
    : 'unknown';
}

function fanoutPolicy(value: unknown): ManifestFanoutPolicy {
  return value === 'safe' || value === 'attribution_required' || value === 'unsafe' ? value : 'unknown';
}

function lifecycle(value: unknown): 'draft' | 'review' | 'certified' | 'deprecated' {
  return value === 'review' || value === 'certified' || value === 'deprecated' ? value : 'draft';
}

function ruleKind(value: unknown): 'fanout' | 'export' | 'contract' | 'custom' {
  return value === 'fanout' || value === 'export' || value === 'contract' ? value : 'custom';
}

function arrayOfRecords(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.map(asRecord).filter((record) => Object.keys(record).length > 0) : [];
}

function stringArray(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {};
}

function sortRecord<T>(value: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) as Record<string, T>;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function fileFingerprint(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return value;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stable(record[key])]));
}

function modelingError(filePath: string, message: string): ManifestDiagnostic {
  return { kind: 'modeling', filePath, severity: 'error', message };
}
