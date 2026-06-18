import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { ConnectionConfig } from './connector.js';

export class MissingConnectorDependencyError extends Error {
  constructor(
    readonly packageName: string,
    readonly driver: string,
    readonly installHint: string,
  ) {
    super(`DQL connector package missing for ${driver}: install ${packageName}. ${installHint}`);
    this.name = 'MissingConnectorDependencyError';
  }
}

export async function importConnectorDependency(
  packageName: string,
  config: ConnectionConfig,
): Promise<unknown> {
  const searchPaths = config.moduleSearchPaths ?? [];
  for (const basePath of searchPaths) {
    try {
      const req = createRequire(join(basePath, 'package.json'));
      return req(packageName);
    } catch {
      // Try the next configured project-local connector location.
    }
  }

  try {
    const dependencyName = packageName;
    return await import(dependencyName);
  } catch {
    const driver = config.driver === 'file' ? 'duckdb' : config.driver;
    const installRoot = searchPaths[0] ?? '.dql/connectors';
    throw new MissingConnectorDependencyError(
      packageName,
      driver,
      `Use the Connections page install button, or run "npm install --prefix ${installRoot} ${packageName}".`,
    );
  }
}
