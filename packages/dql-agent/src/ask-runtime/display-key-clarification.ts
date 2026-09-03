/**
 * The deterministic display-key clarification.
 *
 * "Show the top names by revenue" names a ranking and a measure but not WHICH
 * name: a revenue metric that can be ranked by customer name and by product
 * name gives two different tables, and choosing one silently is a wrong
 * answer the user cannot see. The host holds everything needed to ask
 * instead — the metric's authored capability contract says exactly which
 * dimensions may rank it — so this decides before any provider dispatch,
 * from the admitted cards alone, and offers only options the contract
 * declares. No option is ever invented from a name.
 *
 * It fires narrowly: the question must carry a bare `name`/`names` token, no
 * entity noun that already settles it ("top customer names" is not
 * ambiguous), and a ranking. Two or more distinct rank-entity labels are
 * required; one label, or two ids that render the same words, is not a
 * choice worth a round trip.
 */
import { resolveMetricCapabilityDimension } from '../analytical-frame.js';
import { evidenceCandidateRoles } from '../analytical-orchestration.js';
import type { AgentEvidenceCandidate } from '../meaning-resolution.js';
import { buildAnalysisQuestionPlan } from '../metadata/analysis-planner.js';

export interface DisplayKeyClarificationOptionV1 {
  /** The authored capability dimension id — the stable choice, never the label. */
  id: string;
  label: string;
  description: string;
  /** The question to resubmit when this option is chosen. */
  question: string;
  kind: 'semantic_dimension';
}

export interface DisplayKeyClarificationV1 {
  version: 1;
  reasonCode: 'ASK_V2_DISPLAY_KEY_AMBIGUOUS';
  metricId: string;
  message: string;
  options: DisplayKeyClarificationOptionV1[];
}

const BARE_NAME_TOKEN = /(?:^| )names?(?: |$)/;
const SETTLING_ENTITY_NOUN = /(?:^| )(?:account|customer|client|product|owner|contact|vendor|supplier|employee|store|region|category)s?(?: |$)/;

function normalizeQuestion(question: string): string {
  return question.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function humanizeLabel(value: string): string {
  const tail = value.includes('.') ? value.slice(value.lastIndexOf('.') + 1) : value;
  return tail
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function candidateIdentities(candidate: AgentEvidenceCandidate): string[] {
  const record = candidate as AgentEvidenceCandidate & { qualifiedId?: string; aliases?: string[] };
  return [...new Set([
    candidate.id,
    ...(typeof record.qualifiedId === 'string' ? [record.qualifiedId] : []),
    ...(Array.isArray(record.aliases) ? record.aliases.filter((alias: unknown): alias is string => typeof alias === 'string') : []),
  ].filter((value) => value.trim().length > 0))];
}

export function deterministicDisplayKeyClarification(input: {
  question: string;
  candidates: readonly AgentEvidenceCandidate[];
}): DisplayKeyClarificationV1 | undefined {
  const normalized = normalizeQuestion(input.question);
  if (!normalized || !BARE_NAME_TOKEN.test(normalized) || SETTLING_ENTITY_NOUN.test(normalized)) return undefined;
  const plan = buildAnalysisQuestionPlan(input.question);
  if (!plan.requirements.ranking) return undefined;

  const metric = input.candidates.find((candidate) => candidate.kind === 'semantic_metric'
    && Boolean(candidate.analyticalCapability)
    && candidate.eligible !== false
    && candidate.compatibility !== 'incompatible');
  if (!metric) return undefined;

  const seen = new Map<string, DisplayKeyClarificationOptionV1>();
  for (const candidate of input.candidates) {
    if (candidate.kind !== 'semantic_member') continue;
    if (candidate.eligible === false || candidate.compatibility === 'incompatible') continue;
    if (!evidenceCandidateRoles(candidate).includes('entity_label')) continue;
    for (const identity of candidateIdentities(candidate)) {
      const dimension = resolveMetricCapabilityDimension(metric, identity);
      if (!dimension) continue;
      // A generic top-N display choice is meaningful only when the metric
      // itself declares this dimension as a rank entity.
      if (!dimension.supportedRoles.includes('rank_entity')) break;
      if (seen.has(dimension.dimensionId)) break;
      const label = humanizeLabel(dimension.label ?? candidate.name);
      seen.set(dimension.dimensionId, {
        id: dimension.dimensionId,
        label,
        description: `Use ${label} as the ranking display key.`,
        question: `${input.question.trim()} — clarification: ${label}`,
        kind: 'semantic_dimension',
      });
      break;
    }
  }
  const options = [...seen.values()]
    .sort((left, right) => left.label.localeCompare(right.label))
    .slice(0, 3);
  const distinctLabels = new Set(options.map((option) => option.label.toLowerCase()));
  if (options.length < 2 || distinctLabels.size < 2) return undefined;
  return {
    version: 1,
    reasonCode: 'ASK_V2_DISPLAY_KEY_AMBIGUOUS',
    metricId: metric.id,
    message: 'Which business name should I use for this ranking?',
    options,
  };
}
