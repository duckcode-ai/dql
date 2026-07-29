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
