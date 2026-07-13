/**
 * dbt-first domain modeling (manifest v3).
 *
 * The loader deliberately reads dbt artifacts as the physical source of truth
 * and emits only stable references and DQL-owned analytical policy. Do not add
 * copied dbt descriptions, column catalogs, tests, or MetricFlow formulas here.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';
import * as yaml from 'js-yaml';
import type {
  ManifestConformanceDeclaration,
  ManifestDbtFirstModeling,
  ManifestDbtNodeProvenance,
  ManifestDbtProvenance,
  ManifestDiagnostic,
  ManifestDomainPackage,
  ManifestDomainRelationshipLineage,
  ManifestDomainExport,
  ManifestDomainImport,
  ManifestFanoutPolicy,
  ManifestMetricFlowProvenance,
  ManifestModelContract,
  ManifestModelEntity,
  ManifestModelRelationship,
  ManifestModelRule,
  ManifestRelationshipCardinality,
  ManifestRelationshipValidationEvidence,
} from './types.js';
import { loadDomainPackageRegistry } from './domain-package-registry.js';

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
  analytical_role?: unknown;
  analyticalRole?: unknown;
  concept_refs?: unknown;
  conceptRefs?: unknown;
  status?: unknown;
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
  validation?: unknown;
  owner_domain?: unknown;
  ownerDomain?: unknown;
  verb?: unknown;
  description?: unknown;
  rationale?: unknown;
  roles?: unknown;
  optionality?: unknown;
  join_types?: unknown;
  joinTypes?: unknown;
  aggregation?: unknown;
  temporal?: unknown;
  attribution_block?: unknown;
  attributionBlock?: unknown;
  imports?: unknown;
  evidence_expires_at?: unknown;
  evidenceExpiresAt?: unknown;
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
  const domainExports: Record<string, ManifestDomainExport> = {};
  const domainImports: Record<string, ManifestDomainImport> = {};

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
      const dbt = nodeFacts.get(dbtUniqueId);
      if (!dbt || dbt.resourceType !== 'model') {
        diagnostics.push(modelingError(relPath, `entity "${id}" references unknown dbt model "${dbtUniqueId}"`));
        continue;
      }
      const explicitGrain = stringValue(rawEntity.grain);
      const explicitKeys = stringArray(rawEntity.keys);
      const grain = explicitGrain ?? dbt.grain;
      const keys = explicitKeys.length > 0 ? explicitKeys : dbt.keys;
      const entityDomain = stringValue(rawEntity.domain) ?? domain;
      const qualifiedId = qualifiedObjectId(entityDomain, 'entity', id);
      const entity: ManifestModelEntity = {
        id: qualifiedId,
        localId: id,
        qualifiedId,
        domain: entityDomain,
        dbtUniqueId,
        grain,
        keys,
        analyticalRole: analyticalRole(rawEntity.analytical_role ?? rawEntity.analyticalRole),
        conceptRefs: stringArray(rawEntity.concept_refs ?? rawEntity.conceptRefs),
        status: lifecycle(rawEntity.status),
        sourcePath: relPath,
        identityFingerprint: fingerprint({
          dbt: dbt.identityFingerprint,
          grain,
          keys: [...keys].sort(),
        }),
      };
      if (!insertScopedRecord(entities, entity)) {
        diagnostics.push(modelingError(relPath, `duplicate entity "${entity.qualifiedId}" in the same Domain Package`));
      }
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
      const contractDomain = stringValue(rawContract.domain) ?? domain;
      const qualifiedId = qualifiedObjectId(contractDomain, 'contract', id);
      const contract: ManifestModelContract = {
        id: qualifiedId,
        localId: id,
        qualifiedId,
        domain: contractDomain,
        entities: stringArray(rawContract.entities),
        blocks: stringArray(rawContract.blocks),
        status: lifecycle(rawContract.status),
        owner: stringValue(rawContract.owner),
        sourcePath: relPath,
        requiredEvaluation: rawContract.required_evaluation !== false && rawContract.requiredEvaluation !== false,
        version: positiveInteger(rawContract.version, 1),
        grain: stringValue(rawContract.grain),
        metricRefs: stringArray(rawContract.metrics ?? rawContract.metric_refs ?? rawContract.metricRefs),
        dimensions: stringArray(rawContract.dimensions),
        allowedFilters: stringArray(rawContract.allowed_filters ?? rawContract.allowedFilters),
        requiredFilters: stringArray(rawContract.required_filters ?? rawContract.requiredFilters),
        purpose: stringValue(rawContract.purpose),
        evaluationRefs: stringArray(rawContract.evaluations ?? rawContract.evaluation_refs ?? rawContract.evaluationRefs),
      };
      if (!insertScopedRecord(contracts, contract)) diagnostics.push(modelingError(relPath, `duplicate contract "${contract.qualifiedId}" in the same Domain Package`));
    }

    for (const rawDeclaration of arrayOfRecords(source.conformance)) {
      const id = stringValue(rawDeclaration.id);
      const rule = stringValue(rawDeclaration.rule);
      if (!id || !rule) {
        diagnostics.push(modelingError(relPath, 'each conformance declaration requires `id` and `rule`'));
        continue;
      }
      const qualifiedId = qualifiedObjectId(domain, 'conformance', id);
      const declaration: ManifestConformanceDeclaration = {
        id: qualifiedId,
        localId: id,
        qualifiedId,
        domain,
        entities: stringArray(rawDeclaration.entities),
        rule,
        sourcePath: relPath,
      };
      if (!insertScopedRecord(conformance, declaration)) diagnostics.push(modelingError(relPath, `duplicate conformance declaration "${declaration.qualifiedId}" in the same Domain Package`));
    }

    for (const rawRule of arrayOfRecords(source.rules)) {
      const id = stringValue(rawRule.id);
      const expression = stringValue(rawRule.expression);
      if (!id || !expression) {
        diagnostics.push(modelingError(relPath, 'each rule requires `id` and `expression`'));
        continue;
      }
      const ruleDomain = stringValue(rawRule.domain) ?? domain;
      const qualifiedId = qualifiedObjectId(ruleDomain, 'rule', id);
      const ruleValue: ManifestModelRule = {
        id: qualifiedId,
        localId: id,
        qualifiedId,
        domain: ruleDomain,
        kind: ruleKind(rawRule.kind),
        expression,
        sourcePath: relPath,
      };
      if (!insertScopedRecord(rules, ruleValue)) diagnostics.push(modelingError(relPath, `duplicate rule "${ruleValue.qualifiedId}" in the same Domain Package`));
    }

    for (const rawExport of arrayOfRecords(source.exports)) {
      const localId = stringValue(rawExport.id);
      if (!localId) {
        diagnostics.push(modelingError(relPath, 'each domain export requires `id`'));
        continue;
      }
      const version = positiveInteger(rawExport.version, 1);
      const id = localId.includes('.') ? localId : `${domain}.${localId}`;
      const ref = `${id}@${version}`;
      if (domainExports[ref]) {
        diagnostics.push(modelingError(relPath, `duplicate domain export "${ref}"`));
        continue;
      }
      const exportDomain = stringValue(rawExport.domain) ?? domain;
      const qualifiedId = qualifiedObjectId(exportDomain, 'export', localId);
      const value: ManifestDomainExport = {
        id: qualifiedId,
        localId,
        qualifiedId,
        domain: exportDomain,
        version,
        entity: stringValue(rawExport.entity),
        metrics: stringArray(rawExport.metrics ?? rawExport.allowed_metrics ?? rawExport.allowedMetrics),
        blocks: stringArray(rawExport.blocks),
        allowedKeys: stringArray(rawExport.allowed_keys ?? rawExport.allowedKeys),
        allowedDimensions: stringArray(rawExport.allowed_dimensions ?? rawExport.allowedDimensions),
        allowedFilters: stringArray(rawExport.allowed_filters ?? rawExport.allowedFilters),
        purposes: stringArray(rawExport.purposes),
        consumerDomains: stringArray(rawExport.consumer_domains ?? rawExport.consumerDomains),
        classification: stringValue(rawExport.classification),
        contract: stringValue(rawExport.contract),
        status: lifecycle(rawExport.status),
        owner: stringValue(rawExport.owner),
        sourcePath: relPath,
        fingerprint: '',
      };
      value.fingerprint = fingerprint(value);
      domainExports[ref] = value;
    }

    for (const rawImport of arrayOfRecords(source.imports)) {
      const exportRef = stringValue(rawImport.export ?? rawImport.export_ref ?? rawImport.exportRef);
      if (!exportRef) {
        diagnostics.push(modelingError(relPath, 'each domain import requires `export`'));
        continue;
      }
      const localId = stringValue(rawImport.id) ?? exportRef.replace(/[^A-Za-z0-9_-]+/g, '_');
      const importDomain = stringValue(rawImport.domain ?? rawImport.consumer_domain ?? rawImport.consumerDomain) ?? domain;
      const qualifiedId = qualifiedObjectId(importDomain, 'import', localId);
      if (domainImports[qualifiedId]) {
        diagnostics.push(modelingError(relPath, `duplicate domain import "${localId}"`));
        continue;
      }
      domainImports[qualifiedId] = {
        id: qualifiedId,
        localId,
        qualifiedId,
        domain: importDomain,
        exportRef,
        purpose: stringValue(rawImport.purpose) ?? '',
        status: lifecycle(rawImport.status),
        owner: stringValue(rawImport.owner),
        sourcePath: relPath,
      };
    }
  }

  validateInterfaces(domainExports, domainImports, entities, diagnostics);
  validateContracts(contracts, entities, diagnostics);
  const relationships = buildRelationships(rawRelationships, entities, nodeFacts, domainSources, domainExports, domainImports, contracts, diagnostics);
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
      relationship: relationship.qualifiedId,
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
      interfaces: {
        exports: sortRecord(domainExports),
        imports: sortRecord(domainImports),
      },
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
  domainExports: Record<string, ManifestDomainExport>,
  domainImports: Record<string, ManifestDomainImport>,
  contracts: Record<string, ManifestModelContract>,
  diagnostics: ManifestDiagnostic[],
): Record<string, ManifestModelRelationship> {
  const relationships: Record<string, ManifestModelRelationship> = {};
  for (const { value, sourcePath, domain } of rawRelationships) {
    const id = stringValue(value.id);
    const from = stringValue(value.from);
    const to = stringValue(value.to);
    if (!id || !from || !to) {
      diagnostics.push(modelingError(sourcePath, 'each relationship requires `id`, `from`, and `to`'));
      continue;
    }
    const fromKey = resolveScopedKey(entities, from, domain);
    const toKey = resolveScopedKey(entities, to, domain);
    const fromEntity = fromKey ? entities[fromKey] : undefined;
    const toEntity = toKey ? entities[toKey] : undefined;
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
    let keyColumnsValid = true;
    for (const pair of keys) {
      if (fromFacts && !fromFacts.columns.has(pair.from.toLowerCase())) {
        keyColumnsValid = false;
        diagnostics.push(modelingError(sourcePath, `relationship "${id}" key "${pair.from}" is not a column of ${fromEntity.dbtUniqueId}`));
      }
      if (toFacts && !toFacts.columns.has(pair.to.toLowerCase())) {
        keyColumnsValid = false;
        diagnostics.push(modelingError(sourcePath, `relationship "${id}" key "${pair.to}" is not a column of ${toEntity.dbtUniqueId}`));
      }
    }
    const cardinality = relationshipCardinality(value.cardinality);
    const fanout = fanoutPolicy(value.fanout);
    const status = lifecycle(value.status);
    const crossDomain = value.crossDomain === true || fromEntity.domain !== toEntity.domain;
    const ownerDomain = stringValue(value.owner_domain ?? value.ownerDomain) ?? domain;
    const importRefs = stringArray(value.imports);
    const structuredInterfaces = Object.keys(domainExports).length > 0 || Object.keys(domainImports).length > 0;
    const interfacesGranted = !crossDomain || (structuredInterfaces
      ? crossDomainInterfacesGranted(ownerDomain, [fromEntity, toEntity], importRefs, domainExports, domainImports, sourcePath, id, diagnostics)
      : packages.get(fromEntity.domain)?.exports.includes(from) === true);
    const contractsGranted = !crossDomain || (structuredInterfaces
      && crossDomainContractsGranted(ownerDomain, importRefs, domainExports, domainImports, contracts, sourcePath, id, diagnostics));
    const certificationFingerprint = certificationProof(value.certifiedAgainst, keys, cardinality, fanout);
    const validation = validationEvidence(value.validation);
    const validationProof = relationshipValidationProofFingerprint({
      fromRelation: fromFacts?.relation,
      toRelation: toFacts?.relation,
      keys,
      cardinality,
      fanout,
      queryFingerprint: validation?.queryFingerprint ?? '',
    });
    const validationMatches = Boolean(validation?.proofFingerprint && validation.proofFingerprint === validationProof);
    const evidenceExpiresAt = stringValue(value.evidence_expires_at ?? value.evidenceExpiresAt);
    const evidenceExpired = Boolean(evidenceExpiresAt && Number.isFinite(Date.parse(evidenceExpiresAt)) && Date.parse(evidenceExpiresAt) <= Date.now());
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
    if (crossDomain && !interfacesGranted && !structuredInterfaces) {
      diagnostics.push(modelingError(sourcePath, `cross-domain relationship "${id}" requires ${fromEntity.domain} to export entity "${from}"`));
    }
    const automaticJoinAllowed = status === 'certified'
      && !staleCertification
      && keyColumnsValid
      && !evidenceExpired
      && interfacesGranted
      && contractsGranted
      && validation?.status === 'passed'
      && validationMatches
      && (cardinality === 'many_to_one' || cardinality === 'one_to_many' || cardinality === 'one_to_one')
      && fanout === 'safe';
    if (status === 'certified' && validation?.status !== 'passed') {
      diagnostics.push({
        kind: 'modeling',
        filePath: sourcePath,
        severity: 'warning',
        message: `certified relationship "${id}" has no passed warehouse validation evidence and cannot prove an automatic join`,
      });
    }
    if (status === 'certified' && evidenceExpired) {
      diagnostics.push({ kind: 'modeling', filePath: sourcePath, severity: 'warning', message: `relationship "${id}" validation evidence expired at ${evidenceExpiresAt}` });
    }
    if (status === 'certified' && !validationMatches) {
      diagnostics.push({ kind: 'modeling', filePath: sourcePath, severity: 'warning', message: `relationship "${id}" validation proof no longer matches its relations, keys, cardinality, or fanout policy` });
    }
    const qualifiedId = qualifiedObjectId(ownerDomain, 'relationship', id);
    const relationship: ManifestModelRelationship = {
      id: qualifiedId,
      localId: id,
      qualifiedId,
      from: fromKey!,
      to: toKey!,
      keys,
      cardinality,
      fanout,
      status,
      crossDomain,
      ownerDomain,
      owner: stringValue(value.owner),
      verb: stringValue(value.verb),
      description: stringValue(value.description),
      rationale: stringValue(value.rationale),
      roles: relationshipRoles(value.roles),
      optionality: relationshipOptionality(value.optionality),
      joinTypes: relationshipJoinTypes(value.join_types ?? value.joinTypes),
      aggregation: relationshipAggregation(value.aggregation),
      temporal: relationshipTemporal(value.temporal),
      attributionBlock: stringValue(value.attribution_block ?? value.attributionBlock),
      importRefs,
      evidenceExpiresAt,
      sourcePath,
      fingerprint: currentProof,
      certificationFingerprint,
      validation,
      staleCertification,
      automaticJoinAllowed,
    };
    if (!insertScopedRecord(relationships, relationship)) {
      diagnostics.push(modelingError(sourcePath, `duplicate relationship "${relationship.qualifiedId}" in the same Domain Package`));
    }
  }
  return relationships;
}

function validationEvidence(value: unknown): ManifestRelationshipValidationEvidence | undefined {
  const raw = asRecord(value);
  const status = raw.status === 'passed' || raw.status === 'failed' || raw.status === 'error' ? raw.status : undefined;
  const checkedAt = stringValue(raw.checked_at ?? raw.checkedAt);
  const queryFingerprint = stringValue(raw.query_fingerprint ?? raw.queryFingerprint);
  const proofFingerprint = stringValue(raw.proof_fingerprint ?? raw.proofFingerprint);
  if (!status || !checkedAt || !queryFingerprint) return undefined;
  const numberValue = (input: unknown): number => typeof input === 'number' && Number.isFinite(input) ? input : Number(input) || 0;
  return {
    status,
    checkedAt,
    queryFingerprint,
    proofFingerprint,
    fromRows: numberValue(raw.from_rows ?? raw.fromRows),
    toRows: numberValue(raw.to_rows ?? raw.toRows),
    joinedRows: numberValue(raw.joined_rows ?? raw.joinedRows),
    fromNullKeys: numberValue(raw.from_null_keys ?? raw.fromNullKeys),
    toNullKeys: numberValue(raw.to_null_keys ?? raw.toNullKeys),
    unmatchedFrom: numberValue(raw.unmatched_from ?? raw.unmatchedFrom),
    maxFromPerKey: numberValue(raw.max_from_per_key ?? raw.maxFromPerKey),
    maxToPerKey: numberValue(raw.max_to_per_key ?? raw.maxToPerKey),
    message: stringValue(raw.message),
  };
}

function qualifiedObjectId(domain: string, kind: string, localId: string): string {
  const prefix = `${domain}::${kind}::`;
  return localId.startsWith(prefix) ? localId : `${prefix}${localId}`;
}

export function relationshipValidationProofFingerprint(input: {
  fromRelation?: string;
  toRelation?: string;
  keys: Array<{ from: string; to: string }>;
  cardinality: ManifestRelationshipCardinality;
  fanout: ManifestFanoutPolicy;
  queryFingerprint: string;
}): string {
  return fingerprint({
    fromRelation: input.fromRelation,
    toRelation: input.toRelation,
    keys: input.keys,
    cardinality: input.cardinality,
    fanout: input.fanout,
    queryFingerprint: input.queryFingerprint,
  });
}

type ScopedManifestObject = {
  localId: string;
  qualifiedId: string;
  domain?: string;
  ownerDomain?: string;
};

/**
 * Manifest v3 always uses canonical qualified keys. Source-local ids are kept
 * only for display and package-local authoring references.
 */
function insertScopedRecord<T extends ScopedManifestObject>(record: Record<string, T>, value: T): boolean {
  if (record[value.qualifiedId]) return false;
  record[value.qualifiedId] = value;
  return true;
}

function resolveScopedKey<T extends ScopedManifestObject>(record: Record<string, T>, reference: string, ownerDomain?: string): string | undefined {
  if (record[reference]) return reference;
  if (ownerDomain) {
    const kind = Object.values(record)[0]?.qualifiedId.split('::')[1];
    const localQualified = kind ? qualifiedObjectId(ownerDomain, kind, reference) : undefined;
    if (localQualified && record[localQualified]) return localQualified;
  }
  const matches = Object.entries(record).filter(([, item]) => item.localId === reference
    || item.qualifiedId === reference
    || `${item.domain ?? item.ownerDomain}:${item.localId}` === reference);
  return matches.length === 1 ? matches[0]![0] : undefined;
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

function validateInterfaces(
  exports: Record<string, ManifestDomainExport>,
  imports: Record<string, ManifestDomainImport>,
  entities: Record<string, ManifestModelEntity>,
  diagnostics: ManifestDiagnostic[],
): void {
  for (const value of Object.values(exports)) {
    if (value.entity) {
      const key = resolveScopedKey(entities, value.entity, value.domain);
      if (key) value.entity = key;
      else diagnostics.push(modelingError(value.sourcePath, `domain export "${value.id}@${value.version}" references unknown or ambiguous entity "${value.entity}"`));
    }
    if (value.status === 'certified' && !value.owner) {
      diagnostics.push(modelingError(value.sourcePath, `certified domain export "${value.id}@${value.version}" requires an owner`));
    }
  }
  for (const value of Object.values(imports)) {
    const exported = exports[value.exportRef];
    if (!exported) {
      diagnostics.push(modelingError(value.sourcePath, `domain import "${value.id}" references unknown export "${value.exportRef}"`));
      continue;
    }
    if (exported.consumerDomains.length > 0 && !exported.consumerDomains.includes(value.domain)) {
      diagnostics.push(modelingError(value.sourcePath, `domain import "${value.id}" is not an allowed consumer of "${value.exportRef}"`));
    }
    if (exported.purposes.length > 0 && !exported.purposes.includes(value.purpose)) {
      diagnostics.push(modelingError(value.sourcePath, `domain import "${value.id}" purpose "${value.purpose}" is not allowed by "${value.exportRef}"`));
    }
  }
}

function crossDomainInterfacesGranted(
  ownerDomain: string,
  endpoints: ManifestModelEntity[],
  importRefs: string[],
  exports: Record<string, ManifestDomainExport>,
  imports: Record<string, ManifestDomainImport>,
  sourcePath: string,
  relationshipId: string,
  diagnostics: ManifestDiagnostic[],
): boolean {
  let granted = true;
  for (const endpoint of endpoints.filter((entity) => entity.domain !== ownerDomain)) {
    const matching = importRefs
      .map((ref) => Object.values(imports).find((value) => value.exportRef === ref && value.domain === ownerDomain))
      .filter((value): value is ManifestDomainImport => Boolean(value))
      .find((value) => {
        const exported = exports[value.exportRef];
        return exported?.domain === endpoint.domain && (!exported.entity || [endpoint.id, endpoint.localId, endpoint.qualifiedId].includes(exported.entity));
      });
    const exported = matching ? exports[matching.exportRef] : undefined;
    if (!matching || matching.status !== 'certified' || !exported || exported.status !== 'certified') {
      diagnostics.push(modelingError(sourcePath, `cross-domain relationship "${relationshipId}" requires a certified ${ownerDomain} import of a certified ${endpoint.domain} export for entity "${endpoint.id}"`));
      granted = false;
    }
  }
  return granted;
}

function crossDomainContractsGranted(
  ownerDomain: string,
  importRefs: string[],
  exports: Record<string, ManifestDomainExport>,
  imports: Record<string, ManifestDomainImport>,
  contracts: Record<string, ManifestModelContract>,
  sourcePath: string,
  relationshipId: string,
  diagnostics: ManifestDiagnostic[],
): boolean {
  let granted = true;
  for (const exportRef of importRefs) {
    const imported = Object.values(imports).find((value) =>
      value.domain === ownerDomain && value.exportRef === exportRef && value.status === 'certified');
    const exported = exports[exportRef];
    const contract = exported?.contract
      ? Object.values(contracts).find((value) => value.qualifiedId === exported.contract
        || value.id === exported.contract
        || (value.domain === exported.domain && value.localId === exported.contract))
      : undefined;
    const compatible = Boolean(
      imported?.purpose
      && exported?.status === 'certified'
      && contract?.status === 'certified'
      && (!contract.purpose || contract.purpose === imported.purpose)
      && (!exported.entity || contract.entities.includes(exported.entity)),
    );
    if (!compatible) {
      diagnostics.push(modelingError(sourcePath, `cross-domain relationship "${relationshipId}" requires export "${exportRef}" to have a compatible certified contract and explicit import purpose`));
      granted = false;
    }
  }
  return granted && importRefs.length > 0;
}

function relationshipRoles(value: unknown): { from?: string; to?: string } | undefined {
  const raw = asRecord(value);
  const from = stringValue(raw.from);
  const to = stringValue(raw.to);
  return from || to ? { from, to } : undefined;
}

function relationshipOptionality(value: unknown): { from: 'required' | 'optional' | 'unknown'; to: 'required' | 'optional' | 'unknown' } | undefined {
  const raw = asRecord(value);
  if (Object.keys(raw).length === 0) return undefined;
  const normalize = (input: unknown): 'required' | 'optional' | 'unknown' => input === 'required' || input === 'optional' ? input : 'unknown';
  return { from: normalize(raw.from), to: normalize(raw.to) };
}

function relationshipJoinTypes(value: unknown): Array<'left' | 'inner'> | undefined {
  const values = stringArray(value).filter((item): item is 'left' | 'inner' => item === 'left' || item === 'inner');
  return values.length > 0 ? [...new Set(values)] : undefined;
}

function relationshipAggregation(value: unknown): { measuresFrom: string[]; dimensionsFrom: string[]; requiresPreAggregation?: boolean } | undefined {
  const raw = asRecord(value);
  if (Object.keys(raw).length === 0) return undefined;
  return {
    measuresFrom: stringArray(raw.measures_from ?? raw.measuresFrom),
    dimensionsFrom: stringArray(raw.dimensions_from ?? raw.dimensionsFrom),
    requiresPreAggregation: raw.requires_pre_aggregation === true || raw.requiresPreAggregation === true || undefined,
  };
}

function relationshipTemporal(value: unknown): { factTime: string; validFrom: string; validTo?: string; openEnded?: boolean } | undefined {
  const raw = asRecord(value);
  const factTime = stringValue(raw.fact_time ?? raw.factTime);
  const validFrom = stringValue(raw.valid_from ?? raw.validFrom);
  if (!factTime || !validFrom) return undefined;
  return {
    factTime,
    validFrom,
    validTo: stringValue(raw.valid_to ?? raw.validTo),
    openEnded: raw.open_ended === true || raw.openEnded === true || undefined,
  };
}

function validateContracts(
  contracts: Record<string, ManifestModelContract>,
  entities: Record<string, ManifestModelEntity>,
  diagnostics: ManifestDiagnostic[],
): void {
  for (const contract of Object.values(contracts)) {
    contract.entities = contract.entities.flatMap((entity) => {
      const key = resolveScopedKey(entities, entity, contract.domain);
      if (key) return [key];
      diagnostics.push(modelingError(contract.sourcePath, `contract "${contract.id}" references unknown or ambiguous entity "${entity}"`));
      return [];
    });
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
    declaration.entities = declaration.entities.flatMap((entity) => {
      const key = resolveScopedKey(entities, entity, declaration.domain);
      if (key) return [key];
      diagnostics.push(modelingError(declaration.sourcePath, `conformance "${declaration.id}" references unknown or ambiguous entity "${entity}"`));
      return [];
    });
  }
}

function loadDomainSources(projectRoot: string, diagnostics: ManifestDiagnostic[]): Map<string, DomainSource> {
  const registry = loadDomainPackageRegistry(projectRoot);
  diagnostics.push(...registry.diagnostics);
  return new Map(registry.values().map((pkg) => [pkg.id, {
    id: pkg.id,
    root: pkg.root,
    filePath: join(projectRoot, pkg.declarationPath),
    parent: pkg.parent,
    exports: pkg.exports,
    owner: pkg.owner,
  }]));
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

function analyticalRole(value: unknown): 'event' | 'dimension' | 'snapshot' | 'bridge' | 'unknown' {
  return value === 'event' || value === 'dimension' || value === 'snapshot' || value === 'bridge' ? value : 'unknown';
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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
