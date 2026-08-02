import type { Domain } from '../../store/types';

export interface AuthoredDomainOption {
  value: string;
  label: string;
  disabled?: boolean;
}

function clean(value: string | undefined): string {
  return value?.trim() ?? '';
}

/**
 * UI-001 / UI-006: business-domain controls use only first-class declarations
 * returned by `/api/domains`. Semantic catalog folders are a separate concept.
 */
export function authoredDomainOptions(domains: readonly Domain[]): AuthoredDomainOption[] {
  const byId = new Map<string, Domain>();
  for (const domain of domains) {
    const id = clean(domain.id);
    if (id && !byId.has(id)) byId.set(id, { ...domain, id });
  }

  const labelFor = (domain: Domain): string => {
    const labels: string[] = [clean(domain.name) || domain.id];
    const visited = new Set([domain.id]);
    let parentId = clean(domain.parent);
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      labels.unshift(clean(parent.name) || parent.id);
      parentId = clean(parent.parent);
    }
    return labels.join(' / ');
  };

  return [...byId.values()]
    .map((domain) => ({ value: domain.id, label: labelFor(domain) }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

/**
 * Preserve a legacy assignment visibly without presenting it as a valid domain.
 * The disabled row lets the user move the artifact to an authored domain or to
 * the global scope without silently rewriting existing Git-owned metadata.
 */
export function authoredDomainOptionsWithCurrent(
  currentDomain: string | null | undefined,
  domains: readonly Domain[],
): AuthoredDomainOption[] {
  const options = authoredDomainOptions(domains);
  const current = clean(currentDomain ?? undefined);
  if (!current || options.some((option) => option.value === current)) return options;
  return [
    { value: current, label: `${current} (missing Domain page)`, disabled: true },
    ...options,
  ];
}

export function authoredDomainIds(domains: readonly Domain[]): Set<string> {
  return new Set(authoredDomainOptions(domains).map((option) => option.value));
}

/** Resolve an id or human label without inventing a new domain. */
export function resolveAuthoredDomainId(value: string | null | undefined, domains: readonly Domain[]): string {
  const needle = clean(value ?? undefined).toLowerCase();
  if (!needle) return '';
  const match = domains.find((domain) => (
    clean(domain.id).toLowerCase() === needle || clean(domain.name).toLowerCase() === needle
  ));
  return clean(match?.id);
}
