import { describe, expect, it } from 'vitest';
import { appLibraryLaunchExpanded } from './app-library-launch';

describe('App library launcher disclosure (UI-022, E2E-020)', () => {
  it('does not flash the launcher before both library sources finish loading', () => {
    expect(appLibraryLaunchExpanded({
      preference: 'auto',
      loading: true,
      appCount: 0,
      localDraftCount: 0,
    })).toBe(false);
  });

  it('expands by default only when the loaded library is empty', () => {
    expect(appLibraryLaunchExpanded({
      preference: 'auto',
      loading: false,
      appCount: 0,
      localDraftCount: 0,
    })).toBe(true);
    expect(appLibraryLaunchExpanded({
      preference: 'auto',
      loading: false,
      appCount: 1,
      localDraftCount: 0,
    })).toBe(false);
    expect(appLibraryLaunchExpanded({
      preference: 'auto',
      loading: false,
      appCount: 0,
      localDraftCount: 1,
    })).toBe(false);
  });

  it('preserves an explicit expand or collapse choice', () => {
    expect(appLibraryLaunchExpanded({
      preference: 'expanded',
      loading: false,
      appCount: 2,
      localDraftCount: 1,
    })).toBe(true);
    expect(appLibraryLaunchExpanded({
      preference: 'collapsed',
      loading: false,
      appCount: 0,
      localDraftCount: 0,
    })).toBe(false);
  });
});
