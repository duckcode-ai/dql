import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  buildManifest,
  discoverDbtDomains,
  loadDomainPackageRegistry,
  renderDomainDeclaration,
  resolveDbtManifestPath,
  type DomainDiscoveryReport,
  type DomainProposal,
} from '@duckcodeailabs/dql-core';
import type { CLIFlags } from '../args.js';

/** `dql model` — inspect/validate v3 and preview evidence-bounded discovery (AGT-002/API-001). */
export async function runModel(file: string | null, rest: string[], flags: CLIFlags): Promise<void> {
  const subcommand = file ?? 'list';
  if (subcommand === 'discover' || subcommand === 'apply-discovery') {
    runDomainDiscovery(subcommand, rest, flags);
    return;
  }
  const args = rest.filter((value) => !value.startsWith('-'));
  const relationshipId = subcommand === 'explain' ? args[0] : undefined;
  const projectArg = subcommand === 'explain' ? args[1] : args[0];
  const projectRoot = resolve(projectArg ?? '.');
  if (!existsSync(resolve(projectRoot, 'dql.config.json'))) {
    console.error(`No DQL project found at ${projectRoot} (missing dql.config.json).`);
    process.exitCode = 1;
    return;
  }
  const manifest = buildManifest({ projectRoot, dbtManifestPath: resolveDbtManifestPath(projectRoot) ?? undefined });
  if (manifest.manifestVersion !== 3 || !manifest.modeling || !manifest.dbtProvenance) {
    console.error('dbt-first modeling is not enabled. Set manifestVersion: 3 and modeling.mode: "dbt-first" in dql.config.json.');
    process.exitCode = 1;
    return;
  }

  if (subcommand === 'validate') {
    const diagnostics = (manifest.diagnostics ?? []).filter((diagnostic) => diagnostic.kind === 'modeling' || diagnostic.kind === 'config');
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
    const result = {
      valid: errors.length === 0,
      entities: Object.keys(manifest.modeling.entities).length,
      relationships: Object.keys(manifest.modeling.relationships).length,
      diagnostics,
    };
    if (flags.format === 'json') console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`DQL dbt-first modeling: ${result.valid ? 'valid' : 'invalid'}`);
      console.log(`  ${result.entities} entities, ${result.relationships} relationships`);
      for (const diagnostic of diagnostics) console.log(`  ${diagnostic.severity === 'error' ? '✗' : '!' } ${diagnostic.message}`);
    }
    if (!result.valid) process.exitCode = 1;
    return;
  }

  if (subcommand === 'explain') {
    if (!relationshipId) {
      console.error('Usage: dql model explain <relationship-id> [path]');
      process.exitCode = 1;
      return;
    }
    const relationship = manifest.modeling.relationships[relationshipId];
    if (!relationship) {
      console.error(`No relationship named "${relationshipId}".`);
      process.exitCode = 1;
      return;
    }
    const output = {
      relationship,
      from: manifest.modeling.entities[relationship.from],
      to: manifest.modeling.entities[relationship.to],
      automaticJoinRule: relationship.automaticJoinAllowed
        ? 'certified + fresh + exported + fanout-safe'
        : 'blocked until the relationship meets certified, fresh, exported, fanout-safe policy',
    };
    console.log(flags.format === 'json' ? JSON.stringify(output, null, 2) : [
      `${relationship.id}: ${relationship.from} → ${relationship.to}`,
      `  ${relationship.cardinality}; fanout=${relationship.fanout}; status=${relationship.status}`,
      `  ${relationship.automaticJoinAllowed ? 'automatic join allowed' : relationship.staleCertification ? 'blocked: stale certification' : 'not automatic join proof'}`,
      `  source: ${relationship.sourcePath}`,
    ].join('\n'));
    return;
  }

  if (subcommand !== 'list') {
    console.error('Usage: dql model list|validate|discover [path] | dql model explain <relationship-id> [path] | dql model apply-discovery [path] --domain <id> --apply');
    process.exitCode = 1;
    return;
  }
  const output = {
    entities: Object.values(manifest.modeling.entities),
    relationships: Object.values(manifest.modeling.relationships),
    packages: Object.values(manifest.modeling.packages),
  };
  if (flags.format === 'json') console.log(JSON.stringify(output, null, 2));
  else {
    console.log('Entities');
    for (const entity of output.entities) console.log(`  ${entity.id} → ${entity.dbtUniqueId} (${entity.domain})`);
    console.log('Relationships');
    for (const relationship of output.relationships) console.log(`  ${relationship.id}: ${relationship.from} → ${relationship.to} [${relationship.automaticJoinAllowed ? 'safe' : relationship.fanout}]`);
  }
}

function runDomainDiscovery(
  subcommand: 'discover' | 'apply-discovery',
  rest: string[],
  flags: CLIFlags,
): void {
  const explicitManifestIndex = rest.indexOf('--dbt-manifest');
  const explicitManifest = explicitManifestIndex >= 0 ? rest[explicitManifestIndex + 1] : undefined;
  const consumed = new Set<number>();
  if (explicitManifestIndex >= 0) {
    consumed.add(explicitManifestIndex);
    consumed.add(explicitManifestIndex + 1);
  }
  const pathArg = rest.find((value, index) => !value.startsWith('-') && !consumed.has(index));
  const projectRoot = resolve(pathArg ?? '.');
  if (!existsSync(resolve(projectRoot, 'dql.config.json'))) {
    discoveryError(flags, 'DBT_PROJECT_NOT_FOUND', `No DQL project found at ${projectRoot} (missing dql.config.json).`);
    return;
  }
  const dbtManifestPath = resolveDbtManifestPath(
    projectRoot,
    explicitManifest ? resolve(projectRoot, explicitManifest) : undefined,
  );
  if (!dbtManifestPath || !existsSync(dbtManifestPath)) {
    discoveryError(flags, 'DBT_MANIFEST_MISSING', 'No dbt manifest found. Run dbt parse or pass --dbt-manifest <path>.');
    return;
  }

  let report: DomainDiscoveryReport;
  try {
    report = discoverDbtDomains({ projectRoot, dbtManifestPath });
  } catch (error) {
    discoveryError(
      flags,
      'DBT_ARTIFACT_INVALID',
      `Could not discover domains from the dbt artifact: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  if (subcommand === 'discover') {
    printDiscoveryReport(report, flags, false);
    return;
  }

  const selected = flags.domain
    ? report.proposals.filter((proposal) => proposal.id === flags.domain)
    : report.proposals;
  if (flags.domain && selected.length === 0) {
    discoveryError(flags, 'DOMAIN_MEMBERSHIP_AMBIGUOUS', `No unambiguous discovered domain named "${flags.domain}".`);
    return;
  }
  if (!flags.apply || flags.dryRun) {
    printDiscoveryReport({ ...report, proposals: selected }, flags, true);
    return;
  }

  const registry = loadDomainPackageRegistry(projectRoot);
  const existing = new Set(registry.values().map((pkg) => pkg.id));
  const selectedIds = new Set(selected.map((proposal) => proposal.id));
  const results = selected.map((proposal) => applyDomainProposal(projectRoot, proposal, report, existing, selectedIds));
  const output = { sourceFingerprint: report.sourceFingerprint, applied: results };
  if (flags.format === 'json') {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log('DQL domain discovery apply');
    for (const result of results) console.log(`  ${result.status === 'created' ? '+' : result.status === 'existing' ? '=' : '!'} ${result.id}: ${result.message}`);
    console.log('Relationship and skill candidates remain review-only drafts and were not written or certified.');
  }
  if (results.some((result) => result.status === 'blocked')) process.exitCode = 1;
}

function applyDomainProposal(
  projectRoot: string,
  proposal: DomainProposal,
  report: DomainDiscoveryReport,
  existing: Set<string>,
  selected: Set<string>,
): { id: string; status: 'created' | 'existing' | 'blocked'; path?: string; message: string } {
  if (existing.has(proposal.id)) {
    return { id: proposal.id, status: 'existing', message: 'existing Domain Package retained unchanged' };
  }
  if (proposal.proposedParent && !existing.has(proposal.proposedParent) && !selected.has(proposal.proposedParent)) {
    return {
      id: proposal.id,
      status: 'blocked',
      message: `proposed parent "${proposal.proposedParent}" must exist or be selected before apply`,
    };
  }
  const safeSegments = proposal.id.split('.').filter((segment) => /^[a-z0-9_]+$/.test(segment));
  if (safeSegments.length !== proposal.id.split('.').length || safeSegments.length === 0) {
    return { id: proposal.id, status: 'blocked', message: 'domain id is not a safe normalized path' };
  }
  const sourcePath = ['domains', ...safeSegments, 'domain.dql'].join('/');
  const absolutePath = resolve(projectRoot, sourcePath);
  const memberships = report.memberships.filter((membership) => membership.proposedDomain === proposal.id);
  const dbtPaths = [...new Set(memberships.map((membership) => membership.sourcePath).filter((value): value is string => Boolean(value)))].sort();
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, renderDomainDeclaration({
    id: proposal.id,
    name: proposal.name,
    parent: proposal.proposedParent,
    owner: proposal.owner,
    dbtPaths,
    description: 'Draft domain boundary proposed from cited dbt evidence; review before governance use.',
  }), 'utf8');
  existing.add(proposal.id);
  return { id: proposal.id, status: 'created', path: sourcePath, message: `wrote ${sourcePath} as a review-required proposal` };
}

function printDiscoveryReport(report: DomainDiscoveryReport, flags: CLIFlags, applyPreview: boolean): void {
  if (flags.format === 'json') {
    console.log(JSON.stringify(applyPreview ? { mode: 'preview', ...report } : report, null, 2));
    return;
  }
  console.log(`DQL dbt domain discovery${applyPreview ? ' apply preview' : ''} (deterministic, draft only)`);
  console.log(`  source ${report.sourceFingerprint.slice(0, 12)} · ${report.memberships.length} models · ${report.unassignedModels.length} unassigned`);
  console.log('Domain proposals');
  if (report.proposals.length === 0) console.log('  none');
  for (const proposal of report.proposals) {
    const owner = proposal.owner ? ` · owner=${proposal.owner}` : '';
    const parent = proposal.proposedParent ? ` · parent=${proposal.proposedParent}` : '';
    console.log(`  ${proposal.id}: ${proposal.matchedDbtUniqueIds.length} models · ${proposal.confidence}${owner}${parent}${proposal.requiresReview ? ' · review required' : ''}`);
  }
  if (report.unassignedModels.length > 0) {
    console.log('Unassigned models');
    for (const model of report.unassignedModels) {
      const candidates = model.candidateDomains.length > 0 ? ` (${model.candidateDomains.join(', ')})` : '';
      console.log(`  ${model.dbtUniqueId}: ${model.reason}${candidates}`);
    }
  }
  console.log(`Review-only drafts: ${report.relationshipDraftCandidates.length} relationships, ${report.skillDraftCandidates.length} skills; none are certified.`);
  if (applyPreview) console.log('No files written. Re-run with --apply after reviewing the selected proposals.');
}

function discoveryError(flags: CLIFlags, code: string, message: string): void {
  if (flags.format === 'json') console.log(JSON.stringify({ code, message, recoverable: true }, null, 2));
  else console.error(`${code}: ${message}`);
  process.exitCode = 1;
}
