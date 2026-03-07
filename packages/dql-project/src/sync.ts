import type { BlockRecord, BlockStatus, RegistryStorage } from './types.js';
import { VersionManager } from './version-manager.js';

export interface SyncResult {
  created: string[];
  updated: string[];
  unchanged: string[];
  errors: Array<{ file: string; error: string }>;
}

export interface ParsedBlock {
  name: string;
  domain: string;
  type: string;
  description?: string;
  owner: string;
  tags: string[];
  dependencies: string[];
  dqlSource: string;
  filePath: string;
}

export interface SyncOptions {
  gitRepo: string;
  gitCommitSha: string;
  actor: string;
  defaultStatus?: BlockStatus;
}

export class RegistrySync {
  private storage: RegistryStorage;
  private versionManager: VersionManager;

  constructor(storage: RegistryStorage) {
    this.storage = storage;
    this.versionManager = new VersionManager(storage);
  }

  async sync(blocks: ParsedBlock[], options: SyncOptions): Promise<SyncResult> {
    const result: SyncResult = {
      created: [],
      updated: [],
      unchanged: [],
      errors: [],
    };

    for (const parsed of blocks) {
      try {
        const existing = await this.storage.getBlockByName(parsed.name);

        if (!existing) {
          const block = this.toBlockRecord(parsed, options, '1.0.0');
          await this.storage.insertBlock(block);
          await this.versionManager.createVersion(block, parsed.dqlSource, '1.0.0', options.gitCommitSha, options.actor);
          result.created.push(parsed.name);
          continue;
        }

        const activeVersion = await this.versionManager.getActiveVersion(existing.id);
        if (activeVersion && activeVersion.dqlSource === parsed.dqlSource) {
          result.unchanged.push(parsed.name);
          continue;
        }

        const newVersion = bumpPatch(existing.version);
        await this.storage.updateBlock(existing.id, {
          domain: parsed.domain,
          type: parsed.type,
          description: parsed.description,
          tags: parsed.tags,
          dependencies: parsed.dependencies,
          gitPath: parsed.filePath,
          gitCommitSha: options.gitCommitSha,
          updatedAt: new Date(),
        });

        await this.versionManager.createVersion(
          { ...existing, name: parsed.name },
          parsed.dqlSource,
          newVersion,
          options.gitCommitSha,
          options.actor,
        );
        result.updated.push(parsed.name);
      } catch (err) {
        result.errors.push({
          file: parsed.filePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  }

  private toBlockRecord(parsed: ParsedBlock, options: SyncOptions, version: string): BlockRecord {
    const now = new Date();
    return {
      id: generateId(),
      name: parsed.name,
      domain: parsed.domain,
      type: parsed.type,
      version,
      status: options.defaultStatus ?? 'draft',
      gitRepo: options.gitRepo,
      gitPath: parsed.filePath,
      gitCommitSha: options.gitCommitSha,
      description: parsed.description,
      owner: parsed.owner,
      tags: parsed.tags,
      dependencies: parsed.dependencies,
      usedInCount: 0,
      createdAt: now,
      updatedAt: now,
    };
  }
}

function bumpPatch(version: string): string {
  const parts = version.split('.').map(Number);
  if (parts.length !== 3 || parts.some((part) => Number.isNaN(part))) return '1.0.1';
  parts[2] += 1;
  return parts.join('.');
}

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
