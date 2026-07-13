/** Keep the current value visible while presenting a stable, compact domain menu. */
export function blockDomainOptions(currentDomain: string | null | undefined, domains: readonly string[]): string[] {
  const current = currentDomain?.trim() ?? '';
  const normalized = domains.map((domain) => domain.trim()).filter(Boolean);
  const unique = [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
  return current ? [current, ...unique.filter((domain) => domain !== current)] : unique;
}
