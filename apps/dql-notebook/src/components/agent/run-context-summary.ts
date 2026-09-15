/**
 * What shaped an answer, from its receipt: the domain it was scoped to, the
 * skills that guided it, the required filters that were enforced, and the
 * domain Ask suggests when the question was not scoped.
 */

type Rec = Record<string, unknown>;

const rec = (value: unknown): Rec | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : undefined);
const texts = (value: unknown): string[] => (Array.isArray(value) ? value : [])
  .map((item) => (typeof item === 'string' ? item : typeof rec(item)?.text === 'string' ? String(rec(item)!.text) : undefined))
  .filter((item): item is string => Boolean(item && item.trim()));

export interface RunContextSummary {
  domain?: string;
  skills: string[];
  requiredFilters: string[];
  suggestedDomain?: string;
}

/** A skill ref (`commerce::skill::beverage-analysis`) as its name. */
export function skillName(ref: string): string {
  return ref.split('::').pop() ?? ref;
}

export function runContextSummary(receipt: Rec | undefined): RunContextSummary {
  const context = rec(receipt?.context);
  const domain = rec(context?.envelope)?.activeDomain;
  const suggested = context?.suggestedDomain;
  return {
    ...(typeof domain === 'string' && domain ? { domain } : {}),
    skills: [...new Set(texts(rec(context?.rendered)?.skills).map(skillName))],
    requiredFilters: [...new Set(texts(rec(context?.enforced)?.requiredFilters))],
    ...(typeof suggested === 'string' && suggested && !(typeof domain === 'string' && domain) ? { suggestedDomain: suggested } : {}),
  };
}

/** One short line for the answer card, or undefined when nothing shaped the answer. */
export function runContextLine(summary: RunContextSummary): string | undefined {
  const parts = [
    summary.domain ? `Scoped to ${summary.domain}` : '',
    summary.skills.length ? `Skill${summary.skills.length === 1 ? '' : 's'}: ${summary.skills.join(', ')}` : '',
    summary.requiredFilters.length ? `Required filter${summary.requiredFilters.length === 1 ? '' : 's'} applied: ${summary.requiredFilters.join('; ')}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}
