import type {
  BlockVersion,
  BlockRecord,
  RegistryStorage,
  RegistryEvent,
} from './types.js';

export class VersionManager {
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

  async createVersion(
    block: BlockRecord,
    dqlSource: string,
    newVersion: string,
    gitCommitSha: string,
    actor: string,
  ): Promise<BlockVersion> {
    const version: BlockVersion = {
      id: generateId(),
      blockId: block.id,
      version: newVersion,
      gitCommitSha,
      dqlSource,
      isActive: true,
      createdAt: new Date(),
    };

    await this.storage.insertVersion(version);
    await this.storage.setActiveVersion(block.id, version.id);
    await this.storage.updateBlock(block.id, {
      version: newVersion,
      gitCommitSha,
      updatedAt: new Date(),
    });

    this.emit({
      type: 'version.created',
      blockId: block.id,
      blockName: block.name,
      version: newVersion,
      actor,
      timestamp: new Date(),
    });

    return version;
  }

  async listVersions(blockId: string): Promise<BlockVersion[]> {
    const versions = await this.storage.getVersions(blockId);
    return versions.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }

  async getActiveVersion(blockId: string): Promise<BlockVersion | null> {
    return this.storage.getActiveVersion(blockId);
  }

  async rollback(blockId: string, targetVersionId: string, actor: string): Promise<BlockVersion> {
    const block = await this.storage.getBlock(blockId);
    if (!block) throw new Error(`Block not found: ${blockId}`);

    const targetVersion = await this.storage.getVersion(targetVersionId);
    if (!targetVersion) throw new Error(`Version not found: ${targetVersionId}`);
    if (targetVersion.blockId !== blockId) {
      throw new Error(`Version ${targetVersionId} does not belong to block ${blockId}`);
    }

    await this.storage.setActiveVersion(blockId, targetVersionId);
    await this.storage.updateBlock(blockId, {
      version: targetVersion.version,
      gitCommitSha: targetVersion.gitCommitSha,
      updatedAt: new Date(),
    });

    this.emit({
      type: 'block.rollback',
      blockId,
      blockName: block.name,
      version: targetVersion.version,
      actor,
      timestamp: new Date(),
      metadata: {
        fromVersion: block.version,
        toVersion: targetVersion.version,
      },
    });

    return targetVersion;
  }

  async rollbackToVersion(blockId: string, semver: string, actor: string): Promise<BlockVersion> {
    const versions = await this.storage.getVersions(blockId);
    const target = versions.find((version) => version.version === semver);
    if (!target) throw new Error(`Version "${semver}" not found for block ${blockId}`);
    return this.rollback(blockId, target.id, actor);
  }
}

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
