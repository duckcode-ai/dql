import type { Domain } from '../../store/types';
import { authoredDomainOptionsWithCurrent, type AuthoredDomainOption } from '../domains/authored-domain-options';

/** Keep legacy metadata visible, but only human-authored domains selectable. */
export function blockDomainOptions(
  currentDomain: string | null | undefined,
  domains: readonly Domain[],
): AuthoredDomainOption[] {
  return authoredDomainOptionsWithCurrent(currentDomain, domains);
}
