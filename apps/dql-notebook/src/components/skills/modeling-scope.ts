import type { Skill } from '../../store/types';

export function skillMatchesModelingScope(skill: Skill, domainFilter: string | null, modelAreaFilter: string | null): boolean {
  if (domainFilter && skill.domain !== domainFilter && !skill.domains?.includes(domainFilter)) return false;
  const areaKey = modelAreaFilter?.split('::').at(-1)?.toLowerCase();
  if (!areaKey) return true;
  const refs = (skill.modelAreaRefs ?? []).map((value) => value.split('::').at(-1)?.toLowerCase());
  return refs.length === 0 || refs.includes(areaKey);
}
