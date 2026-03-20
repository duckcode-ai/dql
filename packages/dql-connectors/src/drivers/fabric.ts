import { MSSQLConnector } from './mssql.js';
import type { ConnectionConfig } from '../connector.js';

export class FabricConnector extends MSSQLConnector {
  readonly driverName = 'fabric';

  async connect(config: ConnectionConfig): Promise<void> {
    await super.connect({
      ...config,
      driver: 'fabric',
      port: config.port ?? 1433,
    });
  }
}
