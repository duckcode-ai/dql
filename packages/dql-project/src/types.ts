/**
 * Project and block registry types for the open DQL ecosystem.
 */

export type BlockStatus = 'draft' | 'review' | 'certified' | 'deprecated' | 'pending_recertification';

export interface BlockRecord {
  id: string;
  name: string;
  domain: string;
  type: string;
  version: string;
  status: BlockStatus;
  gitRepo: string;
  gitPath: string;
  gitCommitSha: string;
  description?: string;
  owner: string;
  tags: string[];
  dependencies: string[];
  costEstimate?: number;
  certifiedAt?: Date;
  certifiedBy?: string;
  testResults?: TestResultSummary;
  usedInCount: number;
  lastExecuted?: Date;
  avgRuntimeMs?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface BlockVersion {
  id: string;
  blockId: string;
  version: string;
  gitCommitSha: string;
  dqlSource: string;
  certifiedAt?: Date;
  isActive: boolean;
  createdAt: Date;
}

export interface TestResultSummary {
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  assertions: TestAssertionResult[];
  runAt: Date;
}

export interface TestAssertionResult {
  name: string;
  passed: boolean;
  actual?: unknown;
  expected?: unknown;
  error?: string;
}

export interface BlockSearchQuery {
  domain?: string;
  type?: string;
  status?: BlockStatus;
  owner?: string;
  tags?: string[];
  query?: string;
  limit?: number;
  offset?: number;
}

export interface BlockSearchResult {
  blocks: BlockRecord[];
  total: number;
  limit: number;
  offset: number;
}

export type RegistryEventType =
  | 'block.registered'
  | 'block.updated'
  | 'block.certified'
  | 'block.deprecated'
  | 'block.rollback'
  | 'version.created';

export interface RegistryEvent {
  type: RegistryEventType;
  blockId: string;
  blockName: string;
  version?: string;
  actor: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface RegistryStorage {
  getBlock(id: string): Promise<BlockRecord | null>;
  getBlockByName(name: string): Promise<BlockRecord | null>;
  searchBlocks(query: BlockSearchQuery): Promise<BlockSearchResult>;
  insertBlock(block: BlockRecord): Promise<void>;
  updateBlock(id: string, updates: Partial<BlockRecord>): Promise<void>;
  deleteBlock(id: string): Promise<void>;
  getVersions(blockId: string): Promise<BlockVersion[]>;
  getActiveVersion(blockId: string): Promise<BlockVersion | null>;
  getVersion(id: string): Promise<BlockVersion | null>;
  insertVersion(version: BlockVersion): Promise<void>;
  setActiveVersion(blockId: string, versionId: string): Promise<void>;
}
