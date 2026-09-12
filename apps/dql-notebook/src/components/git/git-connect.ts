/**
 * Pure helpers for connecting a project to Git from the UI (initialize a
 * repository, add a remote). The server is the authority on validation; these
 * only give immediate feedback before a request is sent.
 */

export const REMOTE_URL_EXAMPLES = 'https://github.com/org/repo.git, git@github.com:org/repo.git, or a local folder path';

/** Returns a plain-language problem with a pasted remote URL, or null when it looks usable. */
export function remoteUrlInputProblem(raw: string): string | null {
  const url = raw.trim();
  if (!url) return 'Enter the remote URL from your Git host.';
  if (/\s/.test(url)) return 'The remote URL cannot contain spaces.';
  if (url.startsWith('-') || /^[a-z][a-z0-9+.-]*::/i.test(url)) return 'That is not a remote URL.';
  if (/^http:\/\//i.test(url)) return 'Use the HTTPS or SSH address of the repository.';
  if (/^https:\/\/[^/@\s]*:[^/@\s]*@/i.test(url)) {
    return 'Remove the password or token from the URL. Use an SSH key or a Git credential helper instead.';
  }
  if (/^(?:https|ssh):\/\/[^/\s]+\/.+/i.test(url)) return null;
  if (/^file:\/\/.+/i.test(url)) return null;
  if (/^[A-Za-z0-9._~-]+@[A-Za-z0-9.-]+:(?!\/\/)\S+$/.test(url)) return null;
  if (url.startsWith('/') || url.startsWith('./') || url.startsWith('../') || /^[A-Za-z]:[\\/]/.test(url)) return null;
  return `Use an address like ${REMOTE_URL_EXAMPLES}.`;
}

/** True when a push/share failed only because no remote is configured yet. */
export function isNoRemoteFailure(result: { ok: boolean; code?: string } | null | undefined): boolean {
  return Boolean(result && !result.ok && result.code === 'no_remote');
}
