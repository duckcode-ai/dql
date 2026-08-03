import type { Skill } from '../../store/types';

export function skillMatchesModelingScope(skill: Skill, domainFilter: string | null, modelAreaFilter: string | null): boolean {
  if (domainFilter && skill.domain !== domainFilter && !skill.domains?.includes(domainFilter)) return false;
  const areaKey = modelAreaFilter?.split('::').at(-1)?.toLowerCase();
  if (!areaKey) return true;
  const refs = (skill.modelAreaRefs ?? []).map((value) => value.split('::').at(-1)?.toLowerCase());
  return refs.length === 0 || refs.includes(areaKey);
}

function normalizedSourcePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** Keep the embedded Domain workspace limited to Git-owned Domain skills. */
export function skillMatchesSourcePaths(skill: Skill, sourcePaths: readonly string[] | undefined): boolean {
  if (!sourcePaths) return true;
  const actual = normalizedSourcePath(skill.sourcePath);
  return sourcePaths.some((path) => {
    const expected = normalizedSourcePath(path);
    return actual === expected || actual.endsWith(`/${expected}`);
  });
}
