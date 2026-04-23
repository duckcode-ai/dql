export type BlockStatus =
  | 'draft'
  | 'review'
  | 'certified'
  | 'deprecated'
  | 'pending_recertification';

export interface BlockEntry {
  name: string;
  domain: string;
  status: BlockStatus | string;
  owner: string | null;
  tags: string[];
  path: string;
  lastModified: string;
  description: string;
  llmContext?: string | null;
}

export const STATUS_COLORS: Record<string, string> = {
  draft: '#8b949e',
  review: '#d29922',
  certified: '#3fb950',
  deprecated: '#f85149',
  pending_recertification: '#db6d28',
};
