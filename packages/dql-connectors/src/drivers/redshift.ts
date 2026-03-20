import { PostgreSQLConnector } from './postgresql.js';
import type { ConnectionConfig } from '../connector.js';

export class RedshiftConnector extends PostgreSQLConnector {
  readonly driverName = 'redshift';

  async connect(config: ConnectionConfig): Promise<void> {
    await super.connect({
      ...config,
      driver: 'redshift',
      port: config.port ?? 5439,
    });
  }
}
