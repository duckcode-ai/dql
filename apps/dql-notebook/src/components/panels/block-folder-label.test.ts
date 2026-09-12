import { describe, expect, it } from 'vitest';
import { blockFolderLabel } from './block-library-tree';

describe('block library folder labels', () => {
  it('shows the reserved drafts folder as "Drafts" and every other folder as named', () => {
    expect(blockFolderLabel('_drafts')).toBe('Drafts');
    expect(blockFolderLabel('commerce')).toBe('commerce');
    expect(blockFolderLabel('order_item')).toBe('order_item');
  });
});
