import type { Domain } from '../../store/types';

export function blockGitPath(domains: Domain[], domainId: string, folderPath: string, slug: string): string {
  const folder = folderPath.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const suffix = `${folder ? `${folder}/` : ''}${slug}.dql`;
  if (!domainId) return `blocks/${suffix}`;
  const domain = domains.find((item) => item.id === domainId);
  const packageRoot = domain?.sourcePath?.replace(/\/domain\.dql$/, '');
  return packageRoot
    ? `${packageRoot}/blocks/${suffix}`
    : `blocks/${domainId}/${suffix}`;
}

/**
 * The file name the server gives a new notebook. The server turns every run of
 * characters other than letters and digits into one underscore, so a hint
 * built from the dialog's hyphenated slug named a file that never appeared.
 */
export function notebookFileStem(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'notebook';
}
