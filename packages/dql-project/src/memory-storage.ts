import type {
  BlockRecord,
  BlockVersion,
  BlockSearchQuery,
  BlockSearchResult,
  RegistryStorage,
} from './types.js';

export class MemoryStorage implements RegistryStorage {
  private blocks = new Map<string, BlockRecord>();
  private versions = new Map<string, BlockVersion>();

  async getBlock(id: string): Promise<BlockRecord | null> {
    return this.blocks.get(id) ?? null;
  }

  async getBlockByName(name: string): Promise<BlockRecord | null> {
    for (const block of this.blocks.values()) {
      if (block.name === name) return block;
    }
    return null;
  }

  async searchBlocks(query: BlockSearchQuery): Promise<BlockSearchResult> {
    let results = [...this.blocks.values()];

    if (query.domain) results = results.filter((b) => b.domain === query.domain);
    if (query.type) results = results.filter((b) => b.type === query.type);
    if (query.status) results = results.filter((b) => b.status === query.status);
    if (query.owner) results = results.filter((b) => b.owner === query.owner);
    if (query.tags && query.tags.length > 0) {
      results = results.filter((b) => query.tags!.some((tag) => b.tags.includes(tag)));
    }
    if (query.query) {
      const q = query.query.toLowerCase();
      results = results.filter(
        (b) =>
          b.name.toLowerCase().includes(q) ||
          (b.description?.toLowerCase().includes(q) ?? false) ||
          b.domain.toLowerCase().includes(q),
      );
    }

    const total = results.length;
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;
    return { blocks: results.slice(offset, offset + limit), total, limit, offset };
  }

  async insertBlock(block: BlockRecord): Promise<void> {
    this.blocks.set(block.id, { ...block });
  }

  async updateBlock(id: string, updates: Partial<BlockRecord>): Promise<void> {
    const block = this.blocks.get(id);
    if (!block) throw new Error(`Block not found: ${id}`);
    this.blocks.set(id, { ...block, ...updates });
  }

  async deleteBlock(id: string): Promise<void> {
    this.blocks.delete(id);
    for (const [versionId, version] of this.versions) {
      if (version.blockId === id) this.versions.delete(versionId);
    }
  }

  async getVersions(blockId: string): Promise<BlockVersion[]> {
    return [...this.versions.values()].filter((version) => version.blockId === blockId);
  }

  async getActiveVersion(blockId: string): Promise<BlockVersion | null> {
    for (const version of this.versions.values()) {
      if (version.blockId === blockId && version.isActive) return version;
    }
    return null;
  }

  async getVersion(id: string): Promise<BlockVersion | null> {
    return this.versions.get(id) ?? null;
  }

  async insertVersion(version: BlockVersion): Promise<void> {
    this.versions.set(version.id, { ...version });
  }

  async setActiveVersion(blockId: string, versionId: string): Promise<void> {
    for (const [existingId, version] of this.versions) {
      if (version.blockId === blockId) {
        this.versions.set(existingId, { ...version, isActive: existingId === versionId });
      }
    }
  }
}
