/**
 * Domain backlinks carried by global consumption products.
 *
 * Apps and notebooks remain under the project-level `apps/` and `notebooks/`
 * roots. This metadata declares stewardship and governed dependencies without
 * moving or duplicating the product inside a Domain Package.
 */
export interface ProductDomainContext {
  ownerDomain?: string;
  usesDomains: string[];
  purpose?: string;
  requiredExports: string[];
  classification?: string;
}

/** Stable, lossless normalization used by product readers and writers. */
export function normalizeProductDomainContext(input: {
  ownerDomain?: unknown;
  usesDomains?: unknown;
  purpose?: unknown;
  requiredExports?: unknown;
  classification?: unknown;
}, legacyOwnerDomain?: string): ProductDomainContext {
  const ownerDomain = cleanOptionalString(input.ownerDomain) ?? cleanOptionalString(legacyOwnerDomain);
  return {
    ...(ownerDomain ? { ownerDomain } : {}),
    usesDomains: cleanStringArray(input.usesDomains, ownerDomain ? [ownerDomain] : []),
    ...(cleanOptionalString(input.purpose) ? { purpose: cleanOptionalString(input.purpose) } : {}),
    requiredExports: cleanStringArray(input.requiredExports, []),
    ...(cleanOptionalString(input.classification) ? { classification: cleanOptionalString(input.classification) } : {}),
  };
}

function cleanOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function cleanStringArray(value: unknown, fallback: string[]): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) return [...fallback];
  return Array.from(new Set(value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean)));
}
