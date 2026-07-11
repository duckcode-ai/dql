import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildManifest, resolveDbtManifestPath } from '@duckcodeailabs/dql-core';
import type { CLIFlags } from '../args.js';

/** `dql model` — inspect and validate the manifest-v3 sparse analytical overlay. */
export async function runModel(file: string | null, rest: string[], flags: CLIFlags): Promise<void> {
  const subcommand = file ?? 'list';
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
    console.error('Usage: dql model list|validate [path] | dql model explain <relationship-id> [path]');
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
