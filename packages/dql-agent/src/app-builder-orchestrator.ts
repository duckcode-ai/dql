import type {
  AppBuildClarification,
  AppBuildFrame,
  AppBuildRequirement,
  AppBuildSourcePolicy,
} from '@duckcodeailabs/dql-core';
import type { AppSourceCatalogRecord } from './app-source-catalog.js';

export type AppBuilderComponentRole = AppBuildRequirement['role'];
export type AppBuilderComponentView = 'kpi' | 'line' | 'bar' | 'table';

export interface AppBuilderPlannedComponent {
  id: string;
  title: string;
  sourceId: string;
  requirementIds: string[];
  role: AppBuilderComponentRole;
  view: AppBuilderComponentView;
  rationale: string;
}

export interface AppBuilderBuildBrief {
  version: 1;
  planningMode: 'ai' | 'deterministic_fallback';
  frame: AppBuildFrame;
  requirements: AppBuildRequirement[];
  components: AppBuilderPlannedComponent[];
  selectedSourceIds: string[];
  candidateSourceIds: string[];
  warnings: string[];
}

export interface AppBuilderPlannerCompletionInput {
  system: string;
  user: string;
}

export type AppBuilderPlannerCompletion = (
  input: AppBuilderPlannerCompletionInput,
) => Promise<string | undefined>;

export interface PlanAppBuildBriefInput {
  prompt: string;
  candidates: AppSourceCatalogRecord[];
  sourcePolicy: AppBuildSourcePolicy;
  domain?: string;
  audience?: string;
  complete?: AppBuilderPlannerCompletion;
}

/**
 * App-specific orchestration boundary. It shares a host provider adapter but
 * owns a structured, stateful build brief rather than invoking Ask AI's answer
 * state machine. At most one provider call is made and it can reference only
 * the supplied candidate IDs.
 *
 * Acceptance: PRD-007, AGT-026.
 */
export async function planAppBuildBrief(input: PlanAppBuildBriefInput): Promise<AppBuilderBuildBrief> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error('App build prompt is required.');
  const candidates = input.candidates.slice(0, 12);
  if (!input.complete || candidates.length === 0) return deterministicBrief(input, candidates);

  let raw: string | undefined;
  try {
    raw = await input.complete({
      system: appBuilderSystemPrompt(),
      user: appBuilderUserPrompt(input, candidates),
    });
  } catch {
    return deterministicBrief(input, candidates, ['The configured App planning provider was unavailable; deterministic matching was used.']);
  }
  const parsed = parsePlannerJson(raw);
  if (!parsed) {
    return deterministicBrief(input, candidates, ['The App planning provider returned an invalid build brief; deterministic matching was used.']);
  }
  const allowedIds = new Set(candidates.map((candidate) => candidate.sourceId));
  const requirements = normalizeRequirements(parsed.requirements);
  const requirementIds = new Set(requirements.map((requirement) => requirement.id));
  const components = normalizeComponents(parsed.components, allowedIds, requirementIds);
  if (requirements.length === 0 || components.length === 0) {
    return deterministicBrief(input, candidates, ['The App planning provider did not return grounded requirements and components; deterministic matching was used.']);
  }
  const frame = normalizeFrame(parsed.frame, prompt, input.audience);
  return {
    version: 1,
    planningMode: 'ai',
    frame,
    requirements,
    components,
    selectedSourceIds: Array.from(new Set(components.map((component) => component.sourceId))),
    candidateSourceIds: candidates.map((candidate) => candidate.sourceId),
    warnings: [],
  };
}

function deterministicBrief(
  input: PlanAppBuildBriefInput,
  candidates: AppSourceCatalogRecord[],
  warnings: string[] = [],
): AppBuilderBuildBrief {
  const requirementQuestions = deterministicRequirementQuestions(input.prompt);
  const requirements = requirementQuestions.map((question, index): AppBuildRequirement => ({
    id: `requirement-${index + 1}`,
    question,
    role: inferRequirementRole(question, index),
    required: true,
    measures: [],
    dimensions: [],
    filters: [],
  }));
  const requirementIdsBySource = new Map<string, string[]>();
  const selected: AppSourceCatalogRecord[] = [];
  const addSelection = (candidate: AppSourceCatalogRecord, requirementId: string) => {
    if (!selected.some((item) => item.sourceId === candidate.sourceId)) selected.push(candidate);
    const ids = requirementIdsBySource.get(candidate.sourceId) ?? [];
    if (!ids.includes(requirementId)) ids.push(requirementId);
    requirementIdsBySource.set(candidate.sourceId, ids);
  };
  if (requirements.length === 1) {
    for (const candidate of candidates.slice(0, Math.min(3, candidates.length))) {
      addSelection(candidate, requirements[0].id);
    }
  } else {
    const used = new Set<string>();
    for (const requirement of requirements) {
      const ranked = candidates
        .map((candidate) => ({ candidate, score: deterministicCandidateScore(requirement.question, candidate) }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score || left.candidate.sourceId.localeCompare(right.candidate.sourceId));
      const match = ranked.find((entry) => !used.has(entry.candidate.sourceId)) ?? ranked[0];
      if (!match) continue;
      used.add(match.candidate.sourceId);
      addSelection(match.candidate, requirement.id);
    }
  }
  const components = selected.map((candidate, index): AppBuilderPlannedComponent => {
    const requirementIds = requirementIdsBySource.get(candidate.sourceId) ?? [];
    const primaryRequirement = requirements.find((requirement) => requirementIds.includes(requirement.id));
    return {
      id: `component-${index + 1}`,
      title: candidate.title,
      sourceId: candidate.sourceId,
      requirementIds,
      role: primaryRequirement?.role ?? inferRole(candidate, index),
      view: inferView(candidate, index),
      rationale: candidate.reasons[0] ?? `Matched ${candidate.title} from the App source catalog.`,
    };
  });
  return {
    version: 1,
    planningMode: 'deterministic_fallback',
    frame: {
      goal: input.prompt.trim(),
      decision: input.prompt.trim(),
      audience: input.audience?.trim() || 'App users',
      metrics: Array.from(new Set(selected.flatMap((candidate) => candidate.capabilities.measures))),
      dimensions: Array.from(new Set(selected.flatMap((candidate) => candidate.capabilities.dimensions))),
      filters: Array.from(new Set(selected.flatMap((candidate) => candidate.capabilities.filters))),
      desiredOutput: 'Interactive analytical App',
    },
    requirements,
    components,
    selectedSourceIds: selected.map((candidate) => candidate.sourceId),
    candidateSourceIds: candidates.map((candidate) => candidate.sourceId),
    warnings,
  };
}

const DETERMINISTIC_REQUIREMENT_STOP_WORDS = new Set([
  'a', 'an', 'analytics', 'and', 'app', 'application', 'available', 'block',
  'build', 'certified', 'create', 'dashboard', 'data', 'dql', 'draft', 'for',
  'from', 'governed', 'in', 'last', 'me', 'of', 'on', 'please', 'report',
  'source', 'table', 'the', 'to', 'using', 'view', 'warehouse', 'with',
]);

function deterministicRequirementQuestions(prompt: string): string[] {
  const trimmed = prompt.trim().replace(/[.!?]+$/, '');
  const focusMatch = trimmed.match(/\b(?:showing|including|that shows?|that tracks?|that monitors?)\b\s+(.+)$/i);
  const focus = (focusMatch?.[1] ?? trimmed.replace(/^(?:please\s+)?(?:build|create|make|design)\s+(?:me\s+)?/i, '')).trim();
  const parts = focus.split(/\s*(?:,|;|\band\b)\s*/i)
    .map((part) => part.replace(/^(?:and\s+)?/i, '').trim())
    .filter((part) => part.length > 2);
  if (parts.length < 2 || parts.length > 6 || parts.some((part) => deterministicWords(part).size === 0)) return [trimmed];
  return Array.from(new Set(parts.map((part) => part[0].toUpperCase() + part.slice(1))));
}

function deterministicWords(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/)
    .map((token) => token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token)
    .filter((token) => token.length > 1 && !DETERMINISTIC_REQUIREMENT_STOP_WORDS.has(token)));
}

function deterministicCandidateScore(question: string, candidate: AppSourceCatalogRecord): number {
  const required = deterministicWords(question);
  const title = deterministicWords(candidate.title);
  const evidence = deterministicWords([
    candidate.title,
    candidate.description ?? '',
    candidate.qualifiedIdentity,
    ...candidate.tags,
    ...candidate.capabilities.measures,
    ...candidate.capabilities.dimensions,
    ...candidate.capabilities.filters,
  ].join(' '));
  let score = 0;
  for (const word of required) {
    if (title.has(word)) score += 4;
    else if (evidence.has(word)) score += 2;
  }
  return score;
}

function inferRequirementRole(question: string, index: number): AppBuilderComponentRole {
  const normalized = question.toLowerCase();
  if (/trend|growth|change|week|month|quarter|year|over time/.test(normalized)) return 'trend';
  if (/region|segment|category|channel|breakdown|rank|top/.test(normalized)) return 'breakdown';
  if (/detail|customer|order|record|list/.test(normalized)) return 'detail';
  return index === 0 ? 'kpi' : 'evidence';
}

function appBuilderSystemPrompt(): string {
  return [
    'You are the DQL App Builder planner. Produce one stateful analytical App build brief, not a prose answer.',
    'Use only sourceId values present in the supplied candidate cards. Never invent a source, field, capability, or trust state.',
    'Draft and review sources may be recommended, but their trust must not be upgraded.',
    'Return JSON only with keys frame, requirements, and components.',
    'frame: {goal, decision?, audience?, metrics[], dimensions[], grain?, timeRange?, comparison?, filters[], desiredOutput?, clarificationQuestions?}.',
    'requirements: [{id, question, role, required, measures[], dimensions[], filters[], grain?}]. role is kpi, trend, breakdown, detail, narrative, or evidence.',
    'components: [{id, title, sourceId, requirementIds[], role, view, rationale}]. view is kpi, line, bar, or table.',
    'Prefer the fewest components that cover the request. Ask a clarification only when a material choice cannot be made from supplied evidence.',
  ].join('\n');
}

function appBuilderUserPrompt(input: PlanAppBuildBriefInput, candidates: AppSourceCatalogRecord[]): string {
  return JSON.stringify({
    request: input.prompt,
    sourcePolicy: input.sourcePolicy,
    domain: input.domain,
    audience: input.audience,
    candidateCards: candidates.map((candidate) => ({
      sourceId: candidate.sourceId,
      qualifiedIdentity: candidate.qualifiedIdentity,
      title: candidate.title,
      description: candidate.description,
      domain: candidate.domain,
      lifecycle: candidate.lifecycle,
      trust: candidate.trust,
      eligibleForLocalPreview: candidate.eligibility.localPreview,
      capabilities: candidate.capabilities,
      evidence: candidate.reasons,
    })),
  });
}

function parsePlannerJson(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw?.trim()) return undefined;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeFrame(value: unknown, prompt: string, audience?: string): AppBuildFrame {
  const record = objectValue(value);
  return {
    goal: stringValue(record?.goal) ?? prompt,
    ...(stringValue(record?.decision) ? { decision: stringValue(record?.decision) } : {}),
    audience: stringValue(record?.audience) ?? audience ?? 'App users',
    metrics: stringArray(record?.metrics),
    dimensions: stringArray(record?.dimensions),
    ...(stringValue(record?.grain) ? { grain: stringValue(record?.grain) } : {}),
    ...(stringValue(record?.timeRange) ? { timeRange: stringValue(record?.timeRange) } : {}),
    ...(stringValue(record?.comparison) ? { comparison: stringValue(record?.comparison) } : {}),
    filters: stringArray(record?.filters),
    ...(stringValue(record?.desiredOutput) ? { desiredOutput: stringValue(record?.desiredOutput) } : {}),
    ...normalizeClarifications(record?.clarificationQuestions),
  };
}

function normalizeRequirements(value: unknown): AppBuildRequirement[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.slice(0, 12).flatMap((raw, index) => {
    const record = objectValue(raw);
    if (!record) return [];
    const id = stringValue(record.id) ?? `requirement-${index + 1}`;
    const question = stringValue(record.question);
    const role = appRole(record.role);
    if (!question || !role || seen.has(id)) return [];
    seen.add(id);
    return [{
      id,
      question,
      role,
      required: record.required !== false,
      measures: stringArray(record.measures),
      dimensions: stringArray(record.dimensions),
      filters: stringArray(record.filters),
      ...(stringValue(record.grain) ? { grain: stringValue(record.grain) } : {}),
    }];
  });
}

function normalizeComponents(
  value: unknown,
  allowedSourceIds: Set<string>,
  requirementIds: Set<string>,
): AppBuilderPlannedComponent[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.slice(0, 16).flatMap((raw, index) => {
    const record = objectValue(raw);
    if (!record) return [];
    const sourceId = stringValue(record.sourceId);
    const role = appRole(record.role);
    const view = appView(record.view);
    const id = stringValue(record.id) ?? `component-${index + 1}`;
    if (!sourceId || !allowedSourceIds.has(sourceId) || !role || !view || seen.has(id)) return [];
    seen.add(id);
    return [{
      id,
      title: stringValue(record.title) ?? id,
      sourceId,
      requirementIds: stringArray(record.requirementIds).filter((requirementId) => requirementIds.has(requirementId)),
      role,
      view,
      rationale: stringValue(record.rationale) ?? 'Selected from the bounded App source candidate set.',
    }];
  });
}

function normalizeClarifications(value: unknown): Pick<AppBuildFrame, 'clarificationQuestions'> | Record<string, never> {
  if (!Array.isArray(value)) return {};
  const questions = value.slice(0, 3).flatMap((raw, index): AppBuildClarification[] => {
    const record = objectValue(raw);
    const question = stringValue(record?.question);
    if (!record || !question || !Array.isArray(record.choices)) return [];
    const choices = record.choices.slice(0, 5).flatMap((choiceRaw, choiceIndex) => {
      const choice = objectValue(choiceRaw);
      const label = stringValue(choice?.label);
      if (!choice || !label) return [];
      return [{
        id: stringValue(choice.id) ?? `choice-${choiceIndex + 1}`,
        label,
        ...(stringValue(choice.description) ? { description: stringValue(choice.description) } : {}),
      }];
    });
    if (choices.length < 2) return [];
    return [{
      id: stringValue(record.id) ?? `clarification-${index + 1}`,
      question,
      choices,
      required: record.required !== false,
      ...(stringValue(record.answerId) ? { answerId: stringValue(record.answerId) } : {}),
    }];
  });
  return questions.length ? { clarificationQuestions: questions } : {};
}

function inferRole(candidate: AppSourceCatalogRecord, index: number): AppBuilderComponentRole {
  const text = `${candidate.title} ${candidate.capabilities.chartType ?? ''}`.toLowerCase();
  if (index === 0 && candidate.capabilities.measures.length) return 'kpi';
  if (/trend|time|date|week|month|line/.test(text)) return 'trend';
  if (/region|segment|category|channel|bar|rank/.test(text)) return 'breakdown';
  return 'detail';
}

function inferView(candidate: AppSourceCatalogRecord, index: number): AppBuilderComponentView {
  const allowed = candidate.capabilities.allowedVisualizations ?? [];
  const preferred = candidate.capabilities.chartType ?? allowed[0] ?? '';
  if (/line|area/.test(preferred)) return 'line';
  if (/bar|column|rank/.test(preferred)) return 'bar';
  if (index === 0 && candidate.capabilities.measures.length) return 'kpi';
  return 'table';
}

function appRole(value: unknown): AppBuilderComponentRole | undefined {
  return value === 'kpi' || value === 'trend' || value === 'breakdown' || value === 'detail'
    || value === 'narrative' || value === 'evidence' ? value : undefined;
}

function appView(value: unknown): AppBuilderComponentView | undefined {
  return value === 'kpi' || value === 'line' || value === 'bar' || value === 'table' ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim())))
    : [];
}
