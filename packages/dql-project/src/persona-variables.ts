/**
 * Persona → executeQuery variables bridge.
 *
 * The compiler lowers `@rls("col", "{user.var}")` decorators into positional
 * SQL params whose `name` matches `user.<var>`. The runtime executor accepts
 * a `variables` map (third argument) that supplies values for those names.
 *
 * `personaVariables(persona)` returns the right shape for that map. The
 * caller is responsible for merging with any block-level template params
 * before passing into `executor.executeQuery(sql, params, variables, conn)`.
 *
 * When no persona is active, returns an empty object — same as today's
 * behaviour, which is how single-user OSS continues to "just work" with no
 * runtime narrowing.
 */

import type { ActivePersona } from './persona.js';

/**
 * Build the template-variable map for the runtime executor from an active
 * persona. Includes both:
 *  - `user.<var>` keys (for compile-time RLS templates the lowering pass produced),
 *  - mirror `<var>` keys without the `user.` prefix, so callers that resolve
 *    bare identifiers also see the value.
 */
export function personaVariables(
  persona: ActivePersona | null,
): Record<string, unknown> {
  if (!persona) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(persona.rlsContext)) {
    out[k] = v;
    // Convenience: also expose the bare variable name without the `user.` prefix.
    if (k.startsWith('user.')) out[k.slice('user.'.length)] = v;
  }
  // Always expose the user id so blocks can reference `${user.id}` patterns.
  out['user.id'] = persona.userId;
  out['user.userId'] = persona.userId;
  out['user.roles'] = persona.roles;
  return out;
}

/**
 * Merge two variable maps. The persona side takes precedence so that
 * stakeholders cannot override their own RLS by passing a manual override.
 */
export function mergePersonaVariables(
  base: Record<string, unknown>,
  persona: ActivePersona | null,
): Record<string, unknown> {
  return { ...base, ...personaVariables(persona) };
}
