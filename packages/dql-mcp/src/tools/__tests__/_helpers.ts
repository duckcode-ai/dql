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

export function makeCtx(blocks: Record<string, unknown> = {}, extra: Partial<DQLContext> = {}): DQLContext {
  return {
    projectRoot: '/test/project',
    manifest: { blocks },
    ...extra,
  } as unknown as DQLContext;
}
