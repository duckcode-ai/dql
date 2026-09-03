import type { AgentMessage, AgentProvider, ProviderToolLoopOptions } from '../providers/types.js';

/**
 * Analysts that behave the way real ones did when the runtime failed.
 *
 * The Ask runtime is judged by what the USER gets, and the user gets the
 * same thing whether the model was brilliant, lazy, wrong, or absent: an
 * executed governed answer, a clarification, or an honest gap — never a
 * sentence about the machinery. These personas drive the real lane through
 * the text-protocol transport (the subscription-CLI / Ollama path) so a
 * battery can assert that contract for every way an analyst can fail.
 *
 * None of them ever writes SQL or a DQL block: the host composes programs.
 */
export type ScriptedAnalystPersona =
  /** Reads the cards, chooses a plan, finishes. What a good model does. */
  | 'cooperative'
  /** Only ever finishes. Never touches a tool. */
  | 'lazy'
  /** Sends invented identifiers first, then the admitted ones it was shown. */
  | 'wrong_ids_then_corrects'
  /** Describes relations until the budget dies. */
  | 'browser'
  /** Faults on its second dispatch, the way an expired login does. */
  | 'crashes_second_dispatch'
  /** Returns prose that is not a tool call, every time. */
  | 'garbage';

export const SCRIPTED_ANALYST_PERSONAS: readonly ScriptedAnalystPersona[] = [
  'cooperative',
  'lazy',
  'wrong_ids_then_corrects',
  'browser',
  'crashes_second_dispatch',
  'garbage',
];

export interface ScriptedAnalystProvider extends AgentProvider {
  /** Every prompt the lane sent, in order. */
  readonly calls: AgentMessage[][];
  readonly persona: ScriptedAnalystPersona;
}

const toolCall = (tool: string, input: Record<string, unknown>): string =>
  `\`\`\`json\n${JSON.stringify({ tool, input })}\n\`\`\``;

/** "<relation>.<column>" identifiers the host admitted, read off its cards. */
function admittedColumnIds(prompt: string): string[] {
  const ids = new Set<string>();
  // Column cards render identifiers as relation.column; the `mart_x.col`
  // reading is what compile_and_run_dql expects.
  for (const match of prompt.matchAll(/\b([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)\b/g)) {
    const [, relation, column] = match;
    if (!relation || !column) continue;
    if (['e', 'g', 'i', 'vs', 'etc', 'io'].includes(relation)) continue;
    ids.add(`${relation}.${column}`);
  }
  return [...ids];
}

function certifiedIds(prompt: string): string[] {
  return [...new Set([
    ...[...prompt.matchAll(/\b([a-z0-9_.-]+::block::[a-z0-9_.-]+)\b/gi)].map((match) => match[1]!),
    ...[...prompt.matchAll(/\b(block:[a-z0-9_.-]+)\b/gi)].map((match) => match[1]!),
  ])];
}

function metricIds(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(/\b(semantic:metric:[a-z0-9_.-]+)\b/gi)].map((match) => match[1]!))];
}

function looksNumeric(id: string): boolean {
  return /(revenue|amount|spend|arr|total|count|quantity|price|cost|value|sum|net|gross|mrr|units)/i.test(id.split('.')[1] ?? '');
}

/**
 * A cooperative analyst's one plan: the first certified block it was shown,
 * else the first metric, else a single-relation relational plan over the
 * first numeric-looking admitted column grouped by the first text-looking one.
 */
function cooperativeMove(prompt: string, priorCalls: number): string {
  if (priorCalls >= 1) return toolCall('finish_answer', { answer: 'Here is the result.', evidenceIds: [] });
  const certified = certifiedIds(prompt);
  if (certified.length) return toolCall('run_certified', { candidateId: certified[0] });
  const metrics = metricIds(prompt);
  if (metrics.length) return toolCall('compile_and_run_semantic', { metricIds: [metrics[0]] });
  const columns = admittedColumnIds(prompt);
  const measure = columns.find(looksNumeric);
  const dimension = columns.find((id) => id !== measure && !looksNumeric(id));
  if (measure) {
    return toolCall('compile_and_run_dql', {
      relationalPlan: {
        measures: [{ id: measure, aggregation: 'sum' }],
        ...(dimension ? { dimensions: [{ id: dimension }], limit: 10 } : {}),
      },
    });
  }
  return toolCall('finish_answer', { answer: 'Nothing admitted fits this question.', evidenceIds: [] });
}

export function createScriptedAnalystProvider(persona: ScriptedAnalystPersona): ScriptedAnalystProvider {
  const calls: AgentMessage[][] = [];
  const provider: ScriptedAnalystProvider = {
    name: 'ollama',
    persona,
    calls,
    available: async () => true,
    async generate(messages: AgentMessage[], options?: ProviderToolLoopOptions): Promise<string> {
      calls.push(messages);
      options?.onProviderDispatch?.({ provider: 'ollama', operation: 'generate', attemptIndex: 1, envelope: { messages } });
      const prompt = messages.map((message) => message.content).join('\n');
      const index = calls.length - 1;
      switch (persona) {
        case 'cooperative':
          return cooperativeMove(prompt, index);
        case 'lazy':
          return toolCall('finish_answer', { answer: 'I would rather not run anything.', evidenceIds: [] });
        case 'wrong_ids_then_corrects':
          if (index === 0) {
            return toolCall('compile_and_run_dql', {
              relationalPlan: { measures: [{ id: 'invented_mart.invented_total', aggregation: 'sum' }] },
            });
          }
          return cooperativeMove(prompt, index - 1);
        case 'browser': {
          const relation = admittedColumnIds(prompt)[index % 3]?.split('.')[0] ?? 'orders';
          return toolCall('describe_relation', { candidateId: relation });
        }
        case 'crashes_second_dispatch':
          if (index === 0) return cooperativeMove(prompt, 0);
          throw new Error('Claude Code exited before producing an answer');
        case 'garbage':
          return 'Sure! Based on my understanding you probably want: SELECT * FROM everything LIMIT 10;';
        default:
          return '';
      }
    },
  };
  return provider;
}
