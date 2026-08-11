export type AppLibraryLaunchPreference = 'auto' | 'expanded' | 'collapsed';

export function appLibraryLaunchExpanded(input: {
  preference: AppLibraryLaunchPreference;
  loading: boolean;
  appCount: number;
  localDraftCount: number;
}): boolean {
  if (input.preference === 'expanded') return true;
  if (input.preference === 'collapsed') return false;
  if (input.loading) return false;
  return input.appCount === 0 && input.localDraftCount === 0;
}
