import type {
  BlockRecord,
  BlockSearchQuery,
  BlockSearchResult,
  BlockStatus,
  RegistryStorage,
  RegistryEvent,
} from './types.js';

export class RegistryClient {
  private storage: RegistryStorage;
  private listeners: Array<(event: RegistryEvent) => void> = [];

  constructor(storage: RegistryStorage) {
    this.storage = storage;
  }

  onEvent(listener: (event: RegistryEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((current) => current !== listener);
    };
  }

  private emit(event: RegistryEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  async register(block: BlockRecord): Promise<void> {
    const existing = await this.storage.getBlockByName(block.name);
    if (existing) {
      throw new Error(`Block "${block.name}" already exists (id: ${existing.id}). Use update() instead.`);
    }
    await this.storage.insertBlock(block);
    this.emit({
      type: 'block.registered',
      blockId: block.id,
      blockName: block.name,
      version: block.version,
      actor: block.owner,
      timestamp: new Date(),
    });
  }

  async get(id: string): Promise<BlockRecord | null> {
    return this.storage.getBlock(id);
  }

  async getByName(name: string): Promise<BlockRecord | null> {
    return this.storage.getBlockByName(name);
  }

  async search(query: BlockSearchQuery): Promise<BlockSearchResult> {
    return this.storage.searchBlocks({
      ...query,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    });
  }

  async update(id: string, updates: Partial<BlockRecord>, actor: string): Promise<void> {
    const block = await this.storage.getBlock(id);
    if (!block) throw new Error(`Block not found: ${id}`);
    await this.storage.updateBlock(id, { ...updates, updatedAt: new Date() });
    this.emit({
      type: 'block.updated',
      blockId: id,
      blockName: block.name,
      actor,
      timestamp: new Date(),
      metadata: { fields: Object.keys(updates) },
    });
  }

  async certify(id: string, certifiedBy: string): Promise<void> {
    const block = await this.storage.getBlock(id);
    if (!block) throw new Error(`Block not found: ${id}`);
    const now = new Date();
    await this.storage.updateBlock(id, {
      status: 'certified' as BlockStatus,
      certifiedAt: now,
      certifiedBy,
      updatedAt: now,
    });
    this.emit({
      type: 'block.certified',
      blockId: id,
      blockName: block.name,
      version: block.version,
      actor: certifiedBy,
      timestamp: now,
    });
  }

  async deprecate(id: string, actor: string): Promise<void> {
    const block = await this.storage.getBlock(id);
    if (!block) throw new Error(`Block not found: ${id}`);
    await this.storage.updateBlock(id, {
      status: 'deprecated' as BlockStatus,
      updatedAt: new Date(),
    });
    this.emit({
      type: 'block.deprecated',
      blockId: id,
      blockName: block.name,
      version: block.version,
      actor,
      timestamp: new Date(),
    });
  }

  async delete(id: string): Promise<void> {
    await this.storage.deleteBlock(id);
  }

  async listByDomain(domain: string, limit = 50): Promise<BlockRecord[]> {
    return (await this.search({ domain, limit })).blocks;
  }

  async listCertified(limit = 50): Promise<BlockRecord[]> {
    return (await this.search({ status: 'certified', limit })).blocks;
  }

  async listByOwner(owner: string, limit = 50): Promise<BlockRecord[]> {
    return (await this.search({ owner, limit })).blocks;
  }
}
