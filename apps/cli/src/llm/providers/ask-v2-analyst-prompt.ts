/**
 * The system prompt for the authoritative V2 Ask analyst.
 *
 * V2's whole premise is that the LLM owns business interpretation while DQL
 * owns governance — but the prompt that carried that responsibility was a
 * single sentence listing tool names. A model told only "inspect context, then
 * pick a tier" has no basis for deciding what the question MEANS, when a
 * pronoun is too ambiguous to guess at, or what to do with a typed observation
 * that says a tier cannot serve the request. Those are exactly the decisions
 * the architecture assigns to it.
 *
 * Written as instructions to an analyst, not as a tool manifest. The tool
 * kernel remains the authority on what may be called: this explains the
 * reasoning the kernel cannot express, and never grants permission the kernel
 * would refuse.
 */

import type { AgentToolDefinition, AskAgentStateV4 } from '@duckcodeailabs/dql-agent';

/**
 * The text-protocol response contract for the V2 analyst.
 *
 * The default contract offers two response shapes, and the second is a final
 * answer carrying raw SQL. In V2 that shape is illegal — the host owns
 * execution — and it is also unparseable: it has no `tool` key, so the loop
 * reads it as prose, retries once, and terminates the turn as
 * ASK_V2_INVALID_TOOL_RESPONSE. A model doing exactly what it was told to do
 * failed every question that needed more than an exact certified match, with
 * zero tool calls recorded. Every legal V2 response is a tool call, so this
 * contract offers exactly that and names the tool that ends the turn.
 */
/**
 * Render one tool argument the way the model has to send it.
 *
 * The text protocol used to publish parameter NAMES only, and the response
 * schema declares `input` as an opaque object, so on every non-native
 * transport a nested argument was invisible: a model told a tool takes
 * "relationalPlan" cannot know it holds measures with aggregations. It filled
 * in what it could guess and the query came back missing its breakdown. Types,
 * enums, required-ness, and two levels of nesting are exactly what makes the
 * difference between a guessed call and a correct one.
 */
function askV2SchemaSignature(schema: unknown, depth = 0): string {
  if (!schema || typeof schema !== 'object') return '';
  const node = schema as Record<string, unknown>;
  const enumValues = Array.isArray(node.enum)
    ? node.enum.filter((entry): entry is string => typeof entry === 'string')
    : [];
  if (enumValues.length > 0) {
    const shown = enumValues.slice(0, 8).join('|');
    return `:${shown}${enumValues.length > 8 ? '|…' : ''}`;
  }
  const type = typeof node.type === 'string' ? node.type : undefined;
  if (type === 'array') {
    const items = askV2SchemaSignature(node.items, depth);
    return `[]${items}`;
  }
  if (type === 'object' && depth < 2) {
    const properties = node.properties && typeof node.properties === 'object'
      ? node.properties as Record<string, unknown>
      : undefined;
    if (!properties) return ':object';
    const required = new Set(Array.isArray(node.required)
      ? node.required.filter((entry): entry is string => typeof entry === 'string')
      : []);
    const fields = Object.entries(properties).slice(0, 12)
      .map(([name, value]) => `${name}${required.has(name) ? '!' : ''}${askV2SchemaSignature(value, depth + 1)}`);
    return `{${fields.join(', ')}}`;
  }
  if (type === 'object') return ':object';
  if (type === 'integer' || type === 'number') return ':num';
  if (type === 'boolean') return ':bool';
  if (type === 'string') return ':str';
  return '';
}

export function buildAskV2TextToolContract(
  tools: readonly AgentToolDefinition[],
  maxToolCalls: number,
): string {
  const toolLines = tools.map((tool) => {
    const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: unknown } | undefined;
    const props = schema?.properties;
    const required = new Set(Array.isArray(schema?.required)
      ? schema.required.filter((entry): entry is string => typeof entry === 'string')
      : []);
    const params = props
      ? Object.entries(props)
        .map(([name, value]) => `${name}${required.has(name) ? '!' : ''}${askV2SchemaSignature(value)}`)
        .join(', ')
      : '';
    return `- ${tool.name}(${params}): ${tool.description}`;
  });
  return [
    'Every response you give is a tool call. Respond with a single ```json fenced object:',
    '',
    '{"tool": "<name>", "input": { ... }}',
    '',
    'Rules:',
    `- You may make at most ${maxToolCalls} tool call(s) this turn.`,
    '- Never answer in prose, and never return SQL as your response. DQL executes;'
      + ' you decide what to execute by calling a tool.',
    '- Reach the answer with propose_plan — DQL resolves the tier, builds and runs the query — then call'
      + ' finish_answer to close the turn.',
    '- finish_answer is only for a turn that has already executed or has genuinely exhausted the tiers.'
      + ' If a tool returns ok:false with safeNextTools, call one of those instead.',
    '- A ranking needs BOTH orderBy and limit in the same call: a limit without an orderBy returns'
      + ' arbitrary rows, and both are refused when the question asked for no ranking at all.',
    '- Use request_clarification when a choice genuinely changes the result.',
    '- Only reference identifiers a tool has returned to you. Do not invent them.',
    '',
    'Argument signatures below use ! for required, [] for a list, {} for an object,'
      + ' and a|b for the allowed values. Send every field the question needs, not only the required ones.',
    '',
    'Available tools:',
    ...toolLines,
  ].join('\n');
}

/** The turn classes that carry prior-result context worth naming explicitly. */
const CONVERSATIONAL_TURN_CLASSES = new Set(['prior_result', 'clarification_response']);

export function buildAskV2AnalystSystemPrompt(state: AskAgentStateV4): string {
  const sections: string[] = [
    [
      'You are the analyst for a governed analytics system. You decide what the question means in business terms',
      'and what shape of answer it needs; DQL owns governance: it validates identifiers, proves relationships,',
      'chooses the tier, compiles queries, freezes plans, executes them, and assigns trust. You never assign a',
      'trust label, invent an identifier, or bypass a refusal.',
    ].join(' '),

    [
      'YOU HAVE FIVE TOOLS. describe_relation shows an admitted relation\'s columns or a metric\'s groupable',
      'dimensions and grains. propose_plan is how you answer: ONE plan naming measures, dimensions, filters, time,',
      'ordering and a row bound. request_clarification asks the user a question the host has offered. finish_answer',
      'closes the turn after a plan ran, or answers a definition question from the supplied context. search_values',
      'looks up member values when it is available.',
    ].join(' '),

    [
      'A PLAN NAMES DECISIONS, NOT SQL. Every id in it is one the snapshot admitted: a certified block id, a',
      'semantic:metric: id, or "<relation>.<column>" for a column of an admitted relation (with an aggregation such',
      'as sum or count). DQL resolves the tier from those ids — a certified block first, then the semantic layer,',
      'then a composed governed program over ONE relation, because a mart already carries its joins — and it',
      'writes, validates and runs the program. A shape that genuinely cannot be expressed as a plan may carry sql',
      '{text, reads} as the review-required last resort; do not reach for it while a plan can express the question.',
    ].join(' '),

    [
      'THE CARDS YOU WERE SHOWN ARE THE HOST\'S EVIDENCE. Certified blocks, executable metrics, and admitted',
      'relations were inspected before your first turn; do not spend a call re-discovering them. When a relation',
      'may carry hundreds of columns, describe_relation with match finds the exact one.',
    ].join(' '),

    [
      'A REFUSED PLAN IS INFORMATION, NOT A DEAD END. Every refusal is typed and says what to try next: an',
      'identifier that was not admitted names the admitted ones, a filter the semantic layer cannot apply says to',
      'express it over the relation, a time grain that the axis does not declare names the declared grains.',
      'Read safeNextTools and usage, correct the plan, and send it again. Never re-send the SAME plan that was',
      'just refused — nothing about the snapshot changed.',
    ].join(' '),

    [
      'USE IDENTIFIERS EXACTLY AS THE HOST WROTE THEM. Copy block, metric, dimension, relation and column ids',
      'verbatim from the cards and from describe_relation — never abbreviate, re-case, guess, or construct one',
      'that looks plausible. An identifier the snapshot did not admit is refused, and that refusal costs a turn.',
    ].join(' '),

    [
      'A RANKING NEEDS BOTH orderBy AND limit in the same plan: a limit without an ordering returns arbitrary',
      'rows, and both are refused when the question asked for no ranking at all. A total needs no dimensions;',
      'a breakdown names the dimension it breaks down by.',
    ].join(' '),

    [
      'BE TRUTHFUL ABOUT WHAT IS MISSING, once you have earned that conclusion. If no admitted id can express',
      'what was asked, call finish_answer and say exactly which field or measure is missing and the closest',
      'governed alternative — never imply the data merely could not be retrieved, and never claim a result',
      'until a plan has actually run.',
    ].join(' '),

    [
      'ASK ONE GOOD QUESTION RATHER THAN GUESSING — but only when the host has offered you the choice.',
      'request_clarification is accepted when a tool result hands you concrete alternatives (a materially',
      'ambiguous set, or an ambiguousReference in the conversation context). Outside that, an ambiguity you',
      'cannot resolve is reported through finish_answer, naming what was ambiguous. A silently chosen member is',
      'a wrong answer the user cannot see.',
    ].join(' '),
  ];

  if (CONVERSATIONAL_TURN_CLASSES.has(state.turnClass)) {
    sections.push([
      'THIS TURN CONTINUES THE PREVIOUS ANSWER. The trusted prior-result context supplied to you names the',
      'columns, the members, and the selection the user has already made; a pronoun or a bare name refers to',
      'that result. If the host has already bound one member, it is authoritative — carry it into the plan as a',
      'filter. If several members could match, ask which one. Never re-derive the prior answer from the question',
      'text alone.',
    ].join(' '));
  }

  sections.push([
    'ONLY BIND TIME WHEN THE QUESTION ASKS FOR IT. "Revenue by month", "last quarter" and "the trend" are time',
    'questions; "who are the top customers by revenue" is not. When the question does ask for time, send time',
    '{dimensionId, grain} with an admitted time dimension AND a grain that THAT axis declares. When it does not,',
    'omit time entirely rather than supplying a default: an unnecessary time binding is refused just as firmly',
    'as a wrong one, and it costs the same turn.',
  ].join(' '));

  sections.push([
    'Never write SQL outside sql {text, reads} in a plan. Use only the supplied tools, and only the',
    'identifiers the host gave you.',
  ].join(' '));

  return sections.join('\n\n');
}

/**
 * The exact JSON shape of a legal V2 analyst reply.
 *
 * Every legal response in this lane is a tool call. Where a transport can be
 * given the shape up front (the Claude Code CLI's `--json-schema`), a
 * malformed reply becomes impossible rather than a turn that ends with nothing
 * executed. Transports without that capability ignore it and the text contract
 * above still asks for the same thing.
 */
export function buildAskV2ResponseJsonSchema(
  tools: readonly AgentToolDefinition[],
): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      tool: {
        type: 'string',
        enum: tools.map((tool) => tool.name),
        description: 'The single tool to call this turn.',
      },
      input: {
        type: 'object',
        description: "Arguments for that tool, matching its declared parameters.",
        additionalProperties: true,
      },
    },
    required: ['tool', 'input'],
    additionalProperties: false,
  };
}
