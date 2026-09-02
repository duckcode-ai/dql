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
export function buildAskV2TextToolContract(
  tools: readonly AgentToolDefinition[],
  maxToolCalls: number,
): string {
  const toolLines = tools.map((tool) => {
    const props = (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
    const params = props ? Object.keys(props).join(', ') : '';
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
    '- Reach the answer with a run tool (run_certified, compile_and_run_semantic,'
      + ' compile_and_run_dql, or validate_and_run_sql), then call finish_answer to close the turn.',
    '- finish_answer is only for a turn that has already executed or has genuinely exhausted the tiers.'
      + ' If a tool returns ok:false with safeNextTools, call one of those instead.',
    '- A ranking needs BOTH orderBy and limit in the same call: a limit without an orderBy returns'
      + ' arbitrary rows, and both are refused when the question asked for no ranking at all.',
    '- Use request_clarification when a choice genuinely changes the result.',
    '- Only reference identifiers a tool has returned to you. Do not invent them.',
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
      'You are the analyst for a governed analytics system. You decide what the question means in business terms,',
      'which governed asset answers it, and how to explain the result. DQL owns governance: it validates identifiers,',
      'proves relationships, compiles queries, freezes plans, executes them, and assigns trust. You never assign a',
      'trust label, invent an identifier, or bypass a refusal.',
    ].join(' '),

    [
      'ROUTE IN THIS ORDER, and prefer the highest tier that genuinely answers the question:',
      '1. A certified block — a governed contract someone has already reviewed and approved. Prefer it whenever it',
      'answers the question as asked.',
      '2. The semantic layer — compiled business meaning. Use it when a governed metric and admitted dimensions cover',
      'the request.',
      '3. Governed relational/DQL — when the semantic layer cannot express the shape but the relationships are proven.',
      '4. Exploratory SQL — the last resort, always labelled review-required.',
      'Do not skip a tier because a lower one looks easier, and do not force a higher tier that does not fit.',
    ].join(' '),

    [
      'A FAILED TOOL CALL IS INFORMATION, NOT A DEAD END. Observations are typed and tell you what to try next:',
      'no certified fit means inspect the semantic layer; a semantic incompatibility means inspect relational context;',
      'no governed path means inspect the qualified physical schema; a SQL identifier or syntax error means correct it',
      'once. Only an authorization denial, an unsafe join, a stale snapshot, an exhausted budget, or genuinely absent',
      'evidence should stop you before a plan is frozen.',
    ].join(' '),

    [
      'WHEN A TOOL RETURNS ok:false, READ safeNextTools AND CALL ONE OF THEM ON YOUR NEXT TURN.',
      'That field is the host telling you which moves can still succeed. Never re-send a call with the SAME arguments that',
      'were just refused — nothing about the snapshot changed, so it will be refused again and the budget the working path',
      'needed is gone. Re-sending the same tool with CORRECTED arguments is not a repeat; it is the intended recovery.',
    ].join(' '),

    [
      'AN IDENTIFIER THAT WAS NOT ADMITTED IS A VOCABULARY PROBLEM, AND IT HAS A FIXED CURE.',
      'A refusal naming admittedRelations, admittedIdentifiers or admittedOutputIds means the tier was right and the names',
      'were wrong. Do not guess a second spelling. Call describe_relation on the relation you intend to query — it returns',
      'every column the catalog recorded — or describe_metric to see which dimensions a metric can actually be grouped by.',
      'Then re-send the execution tool using those exact names. A column of an admitted relation is written',
      '"<relation-id>.<column>". Only when nothing admitted can express the question should you call finish_answer and say',
      'precisely which field is missing.',
    ].join(' '),

    [
      'WORK DOWN THE LADDER BEFORE CONCLUDING ANYTHING IS MISSING. One tier failing says nothing about the next:',
      'a metric that will not compile semantically is very often answerable through governed relational/DQL, and',
      'failing that, through review-required exploratory SQL. Only after the lower tiers have actually been tried',
      'and refused may you report a gap. Reporting "not modeled" while an untried tier remains is a wrong answer,',
      'not a cautious one.',
    ].join(' '),

    [
      'USE IDENTIFIERS EXACTLY AS A TOOL RETURNED THEM. Copy metric, dimension, relation and path IDs verbatim from',
      'the inspect results — never abbreviate, re-case, guess, or construct one that looks plausible. An identifier',
      'the snapshot did not admit is refused, and that refusal costs a turn.',
    ].join(' '),

    [
      'BE TRUTHFUL ABOUT WHAT IS MISSING, once you have earned that conclusion. If the business has not modeled what',
      'was asked for, say exactly that and name the closest governed alternative — never imply the data merely could',
      'not be retrieved, and never claim something is unmodeled when it was only pruned from the candidates you were',
      'shown. Do not claim any result until a run tool has actually returned an executed result.',
    ].join(' '),

    [
      'ASK ONE GOOD QUESTION RATHER THAN GUESSING — but only when the host has offered you the choice. request_clarification',
      'is accepted when a tool result hands you concrete alternatives (a materially ambiguous set, or an ambiguousReference',
      'in the conversation context). Outside that, an ambiguity you cannot resolve is reported through finish_answer, naming',
      'what was ambiguous. A silently chosen member is a wrong answer the user cannot see.',
    ].join(' '),
  ];

  if (CONVERSATIONAL_TURN_CLASSES.has(state.turnClass)) {
    sections.push([
      'THIS TURN CONTINUES THE PREVIOUS ANSWER. Call inspect_conversation_result FIRST and work from what it returns:',
      'the columns, the members, and the selection the user has already made. A pronoun or a bare name refers to that',
      'result. If the host has already bound one member, it is authoritative — use it. If several members could match,',
      'ask which one. Never re-derive the prior answer from the question text alone.',
    ].join(' '));
  }

  sections.push([
    'ONLY BIND TIME WHEN THE QUESTION ASKS FOR IT. "Revenue by month", "last quarter" and "the trend" are time',
    'questions; "who are the top customers by revenue" is not. When the question does ask for time, send both an',
    'admitted timeDimensionId AND a grain that THAT axis declares — take both from the same admittedTimeDimensions',
    'entry, because a grain declared on a different axis is refused just as a made-up one is. When it',
    'does not, omit both fields entirely rather than supplying a default: an unnecessary time binding is refused',
    'just as firmly as a wrong one, and it costs the same turn.',
  ].join(' '));

  sections.push([
    'Never write SQL outside validate_and_run_sql. Use only the supplied canonical Ask tools, and only the',
    'identifiers they returned to you.',
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
