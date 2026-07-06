import type { BlockProposal } from './types.js';

type ProposalDqlMetadata = Pick<BlockProposal, 'blockType' | 'dqlSource' | 'metrics' | 'dimensions' | 'filters' | 'timeDimension'>;

export function blockProposalDqlMetadata(input: Partial<BlockProposal>): Partial<ProposalDqlMetadata> {
  const blockType = input.blockType === 'semantic' || input.blockType === 'custom' ? input.blockType : undefined;
  const timeDimension = input.timeDimension
    && typeof input.timeDimension === 'object'
    && typeof input.timeDimension.name === 'string'
    && typeof input.timeDimension.granularity === 'string'
      ? { name: input.timeDimension.name, granularity: input.timeDimension.granularity }
      : undefined;
  return {
    ...(blockType ? { blockType } : {}),
    ...(typeof input.dqlSource === 'string' && input.dqlSource.trim() ? { dqlSource: input.dqlSource } : {}),
    ...(Array.isArray(input.metrics) ? { metrics: input.metrics.map(String).filter(Boolean) } : {}),
    ...(Array.isArray(input.dimensions) ? { dimensions: input.dimensions.map(String).filter(Boolean) } : {}),
    ...(Array.isArray(input.filters) ? { filters: input.filters.filter(isProposalFilter) } : {}),
    ...(timeDimension ? { timeDimension } : {}),
  };
}

function isProposalFilter(value: unknown): value is { dimension: string; operator: string; values: string[] } {
  if (!value || typeof value !== 'object') return false;
  const record = value as { dimension?: unknown; operator?: unknown; values?: unknown };
  return typeof record.dimension === 'string'
    && typeof record.operator === 'string'
    && Array.isArray(record.values)
    && record.values.every((item) => typeof item === 'string');
}
