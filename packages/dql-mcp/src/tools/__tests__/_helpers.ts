import type { DQLContext } from '../../context.js';

export function makeManifestBlock(overrides: Record<string, unknown> = {}) {
  return {
    name: 'My Block',
    status: 'certified',
    type: 'custom',
    domain: 'finance',
    filePath: 'blocks/my-block.dql',
    description: 'Stub block used by tests.',
    owner: 'tests@example.com',
    tags: [],
    ...overrides,
  } as Record<string, unknown>;
}

/**
 * Default registry stub: `isLoaded()` returns false so query-via-block's
 * datalex_contract check is skipped, matching the "DataLex not yet adopted"
 * path. Specific tests pass a real registry via `extra.datalexRegistry`.
 */
const skipRegistry = {
  isLoaded: () => false,
  resolve: () => ({ ok: false, reason: 'not_found', message: '', requestedRef: '' }),
  list: () => [],
  reload: () => undefined,
  loadDiagnostics: () => [],
};

export function makeCtx(blocks: Record<string, unknown> = {}, extra: Partial<DQLContext> = {}): DQLContext {
  return {
    projectRoot: '/test/project',
    manifest: { blocks },
    datalexRegistry: skipRegistry,
    ...extra,
  } as unknown as DQLContext;
}
