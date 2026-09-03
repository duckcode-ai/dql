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
 * ambiguous), and a ranking. The options are the NAME-LIKE rank-entity
 * dimensions the metric's contract declares (customer name, product name,
 * location name — not a boolean flag the contract also lets you rank by);
 * two or more distinct labels are required, or there is no choice worth a
 * round trip. Retrieval need not have surfaced the dimension cards: the
 * contract is authored, host-held evidence.
 */
import { normalizeMetricCapabilityContract } from '@duckcodeailabs/dql-core';
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
const SETTLING_ENTITY_NOUN = /(?:^| )(?:account|customer|client|product|owner|contact|vendor|supplier|employee|store|location|region|category)s?(?: |$)/;
const NAME_LIKE_DIMENSION = /(?:^|[ _.:-])(?:name|label|title)s?(?:$|[ _.:-])/;

function normalizeQuestion(question: string): string {
  return question.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The human-readable tail of a dimension id: `…:customers.customer_name` → `Customer Name`. */
function humanizeLabel(value: string): string {
  const afterColon = value.includes(':') ? value.slice(value.lastIndexOf(':') + 1) : value;
  const tail = afterColon.includes('.') ? afterColon.slice(afterColon.lastIndexOf('.') + 1) : afterColon;
  return tail
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function deterministicDisplayKeyClarification(input: {
  question: string;
  candidates: readonly AgentEvidenceCandidate[];
}): DisplayKeyClarificationV1 | undefined {
  const normalized = normalizeQuestion(input.question);
  if (!normalized || !BARE_NAME_TOKEN.test(normalized) || SETTLING_ENTITY_NOUN.test(normalized)) return undefined;
  const plan = buildAnalysisQuestionPlan(input.question);
  if (!plan.requirements.ranking) return undefined;

  // The first executable metric with an authored capability contract is the
  // measure the ranking is over; its contract is the only authority on which
  // dimensions may rank it.
  const metric = input.candidates.find((candidate) => candidate.kind === 'semantic_metric'
    && Boolean(candidate.analyticalCapability)
    && candidate.eligible !== false
    && candidate.compatibility !== 'incompatible');
  if (!metric) return undefined;
  const capability = normalizeMetricCapabilityContract(metric.analyticalCapability);
  if (!capability) return undefined;

  const seen = new Map<string, DisplayKeyClarificationOptionV1>();
  for (const dimension of capability.dimensions) {
    if (!dimension.supportedRoles.includes('rank_entity')) continue;
    // "Names" means a name-like display key, not every dimension a metric can
    // rank by: a boolean flag or a price is not what the question asked for.
    const identity = `${dimension.dimensionId} ${dimension.label ?? ''}`.toLowerCase();
    if (!NAME_LIKE_DIMENSION.test(identity)) continue;
    if (seen.has(dimension.dimensionId)) continue;
    const label = humanizeLabel(dimension.label ?? dimension.dimensionId);
    seen.set(dimension.dimensionId, {
      id: dimension.dimensionId,
      label,
      description: `Use ${label} as the ranking display key.`,
      question: `${input.question.trim()} — clarification: ${label}`,
      kind: 'semantic_dimension',
    });
  }
  const options = [...seen.values()]
    .sort((left, right) => left.label.localeCompare(right.label))
    .slice(0, 4);
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
