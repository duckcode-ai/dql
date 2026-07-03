import {
  ClaudeProvider,
  KGStore,
  MemoryStore,
  defaultKgPath,
  defaultMemoryPath,
  GeminiProvider,
  OllamaProvider,
  OpenAIProvider,
  answer,
  buildLocalContextPack,
  loadSkills,
  reindexProject,
  type AgentAnswer,
  type AgentFollowUpContext,
  type AgentProvider,
  type AgentResultPayload,
} from '@duckcodeailabs/dql-agent';
import { existsSync } from 'node:fs';
import type { AgentRunRequest, AgentRunner, AgentTurn, BlockProposal, ProviderId } from '../types.js';
import { getEffectiveProviderConfig } from '../../settings/provider-settings.js';
import { ClaudeCodeCliProvider, CodexCliProvider } from '../../providers/subscription-cli.js';
import { ClaudeOAuthProvider, claudeOAuthConnected } from '../../providers/oauth/claude-oauth.js';
import { CodexOAuthProvider, codexOAuthConnected } from '../../providers/oauth/codex-oauth.js';

/**
 * Providers the governed answer-loop runner can drive. Beyond the API-key/local
 * providers this includes the subscription CLI providers (`claude-code`, `codex`) —
 * used as plain completion backends here, distinct from the MCP `claudeCodeRunner`.
 */
type SimpleProviderId =
  | Extract<ProviderId, 'anthropic' | 'openai' | 'gemini' | 'ollama' | 'custom-openai'>
  | 'claude-code'
  | 'codex';

interface ProviderSpec {
  label: string;
  setup: string;
  create(projectRoot: string): AgentProvider;
}

const SPECS: Record<SimpleProviderId, ProviderSpec> = {
  anthropic: {
    label: 'Anthropic Claude',
    setup: 'Configure Anthropic in Settings or set ANTHROPIC_API_KEY. Optional: ANTHROPIC_MODEL.',
    create: (projectRoot) => {
      const config = getEffectiveProviderConfig(projectRoot, 'anthropic');
      return new ClaudeProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model });
    },
  },
  openai: {
    label: 'OpenAI',
    setup: 'Configure OpenAI in Settings or set OPENAI_API_KEY. Optional: OPENAI_MODEL and OPENAI_BASE_URL.',
    create: (projectRoot) => {
      const config = getEffectiveProviderConfig(projectRoot, 'openai');
      return new OpenAIProvider({ apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl });
    },
  },
  gemini: {
    label: 'Gemini',
    setup: 'Configure Gemini in Settings or set GEMINI_API_KEY. Optional: GEMINI_MODEL.',
    create: (projectRoot) => {
      const config = getEffectiveProviderConfig(projectRoot, 'gemini');
      return new GeminiProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model });
    },
  },
  ollama: {
    label: 'Ollama',
    setup: 'Start Ollama and configure OLLAMA_BASE_URL / OLLAMA_MODEL in Settings or env.',
    create: (projectRoot) => {
      const config = getEffectiveProviderConfig(projectRoot, 'ollama');
      return new OllamaProvider({ model: config.model, baseUrl: config.baseUrl });
    },
  },
  'custom-openai': {
    label: 'Custom OpenAI-compatible',
    setup: 'Configure a custom OpenAI-compatible endpoint in Settings with base URL, model, and optional API key.',
    create: (projectRoot) => {
      const config = getEffectiveProviderConfig(projectRoot, 'custom-openai');
      return new OpenAIProvider({ apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl, allowNoApiKey: true });
    },
  },
  'claude-code': {
    label: 'Claude subscription',
    setup: 'Open Settings → Claude subscription and click "Sign in with Claude" (or install the `claude` CLI and run `claude /login`).',
    // OAuth-first: use the browser-login token when connected; fall back to the CLI-passthrough otherwise.
    create: (projectRoot) => {
      const model = getEffectiveProviderConfig(projectRoot, 'claude-code').model;
      return claudeOAuthConnected(projectRoot)
        ? new ClaudeOAuthProvider({ projectRoot, model })
        : new ClaudeCodeCliProvider({ model });
    },
  },
  codex: {
    label: 'ChatGPT subscription',
    setup: 'Open Settings → ChatGPT subscription and click "Sign in with ChatGPT" (or install the `codex` CLI and run `codex login`).',
    create: (projectRoot) => {
      const model = getEffectiveProviderConfig(projectRoot, 'codex').model;
      return codexOAuthConnected(projectRoot)
        ? new CodexOAuthProvider({ projectRoot, model })
        : new CodexCliProvider({ model });
    },
  },
};

function emitProposalFromText(text: string, emit: (turn: AgentTurn) => void): void {
  const match = text.match(/DQL_BLOCK_PROPOSAL\s*[:=]?\s*(\{[\s\S]*\})\s*$/);
  if (!match) return;
  try {
    const raw = JSON.parse(match[1]) as Partial<BlockProposal>;
    if (!raw.name || !raw.sql) return;
    emit({
      kind: 'proposal',
      proposal: {
        name: String(raw.name),
        path: typeof raw.path === 'string' && raw.path.trim() ? raw.path : undefined,
        domain: String(raw.domain ?? ''),
        owner: String(raw.owner ?? ''),
        description: String(raw.description ?? ''),
        sql: String(raw.sql),
        tags: Array.isArray(raw.tags) ? raw.tags.map(String) : undefined,
        chartType: typeof raw.chartType === 'string' ? raw.chartType : undefined,
      },
      governance: { certified: false, errors: [], warnings: ['Generated by a non-tool provider; review before saving.'] },
    });
  } catch {
    // Ignore malformed proposal text. The visible assistant response still streams as text.
  }
}

export function createDqlAgentProviderRunner(id: SimpleProviderId): AgentRunner {
  return {
    async run(req, emit, signal) {
      const spec = SPECS[id];
      const provider = spec.create(req.projectRoot);
      const available = await provider.available().catch(() => false);
      if (!available) {
        emit({ kind: 'error', message: `${spec.label} is not configured or reachable. ${spec.setup}` });
        return;
      }

      try {
        emit({ kind: 'thinking', text: `Using ${spec.label} through the governed DQL agent.` });
        const kgPath = defaultKgPath(req.projectRoot);
        if (!existsSync(kgPath)) {
          emit({ kind: 'thinking', text: 'Building the local agent knowledge graph from terms, business views, blocks, apps, dashboards, dbt, and semantic metadata.' });
        }
        await reindexProject(req.projectRoot, { kgPath });

        const question = resolveEffectiveQuestion(req);
        if (!question) {
          emit({ kind: 'error', message: 'No user question found.' });
          return;
        }

        const memory = new MemoryStore(defaultMemoryPath(req.projectRoot));
        const kg = new KGStore(kgPath);
        try {
          // Retrieve durable learnings only — notebook/project/user/artifact scope.
          // `thread` (per-conversation) memory is intentionally excluded: it is
          // raw-chat residue, not a governed learning, and bloats the prompt.
          const memoryContext = memory.search({
            query: question,
            scopes: ['notebook', 'project', 'user', 'artifact'],
            scopeId: req.upstream?.cellId,
            limit: 6,
          });
          const schemaContext = req.getSchemaContext
            ? await req.getSchemaContext(question).catch(() => [])
            : [];
          const skills = loadSkills(req.projectRoot).skills;
          const followUp = followUpFromConversationContext(req, question) ?? inferFollowUpContext(req, question);
          const selectedContext = selectedContextForMetadata(req, question);
          const contextPack = await buildLocalContextPack(req.projectRoot, {
            question,
            surface: 'notebook',
            followUp,
            selectedContext,
            runtimeSchemaSnapshot: schemaContext.length > 0
              ? {
                  source: 'agent provider schema context',
                  tables: schemaContext.map((table) => ({
                    relation: table.relation,
                    schema: table.schema,
                    name: table.name,
                    description: table.description,
                    source: table.source,
                    columns: table.columns,
                  })),
                }
              : undefined,
          })
            .catch(() => undefined);
          const selectedBlockHints = shouldUseSelectedBlockHint(req, question, followUp)
            ? extractSelectedBlockHints(req)
            : [];
          const blockHints = Array.from(new Set([
            ...(followUp?.kind === 'generic' && followUp.sourceBlockName ? [followUp.sourceBlockName] : []),
            ...selectedBlockHints,
          ]));
          const result = await answer({
            question,
            extraContext: renderExtraContext(req, followUp),
            provider,
            kg,
            skills,
            blockHints,
            followUp,
            memoryContext,
            schemaContext,
            contextPack,
            signal,
            reasoningEffort: req.reasoningEffort,
            executeCertifiedBlock: req.executeCertifiedBlock,
            executeGeneratedSql: req.executeGeneratedSql,
            // NOTE: no captureGeneratedDraft here — a plain answer/research question must NOT
            // auto-write a draft into the blocks space. A draft is created only when the user
            // explicitly acts (the "Create DQL draft" action → the dql_block_draft route).
          });
          emit({ kind: 'tool_result', id: 'governed_answer', output: result });
          emit({ kind: 'text', text: formatAgentAnswer(result) });
          if (result.proposedSql) {
            emitDraftProposal(result, question, emit);
          } else {
            emitProposalFromText(result.text, emit);
          }
          // NOTE: we deliberately do NOT persist a per-turn chat summary into
          // memory. Raw chat is not a correctness signal; auto-capturing it
          // pollutes the store and bloats every later prompt. Durable learning
          // comes only from governed deltas (certify/correct). Conversation
          // continuity is carried per-request via conversationContext instead.
        } finally {
          kg.close();
          memory.close();
        }
        emit({ kind: 'done', stopReason: 'stop' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const setupHint = shouldShowProviderSetupHint(message) ? ` ${spec.setup}` : '';
        emit({ kind: 'error', message: `${spec.label} failed: ${message}.${setupHint}` });
      }
    },
  };
}

function shouldShowProviderSetupHint(message: string): boolean {
  return /api key|not configured|not reachable|connection refused|ECONNREFUSED|fetch failed|network error|model .*not found/i
    .test(message);
}

function lastUserMessage(req: AgentRunRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const msg = req.messages[i];
    if (msg.role === 'user' && msg.content.trim()) return msg.content.trim();
  }
  return '';
}

/** Did the assistant's previous turn ask the user a clarifying question? */
const CLARIFY_MARKER_RE =
  /one more detail|needs clarification|which (?:business object|metric|table|certified block)|what (?:grain|filter|time period)|baseline period|should define the answer|before (?:i can|it can) (?:safely )?(?:answer|generate)/i;

/**
 * When the prior assistant turn was a clarifying question and this turn is the user's
 * answer, the answer alone is too vague to route — re-classifying it just re-clarifies.
 * Fold the ORIGINAL question together with the clarification answer so the loop has
 * enough to proceed. Returns the current message unchanged when this isn't a clarify
 * follow-up.
 */
export function resolveEffectiveQuestion(req: AgentRunRequest): string {
  const msgs = req.messages;
  const current = lastUserMessage(req);
  if (!current) return current;
  // The current user turn is the last message; find the assistant turn before it.
  let assistantIdx = -1;
  for (let i = msgs.length - 2; i >= 0; i--) {
    if (msgs[i].role === 'assistant') { assistantIdx = i; break; }
  }
  if (assistantIdx < 0) return current;
  if (!CLARIFY_MARKER_RE.test(msgs[assistantIdx].content)) return current;
  // Find the original user question that prompted the clarification.
  let original = '';
  for (let i = assistantIdx - 1; i >= 0; i--) {
    if (msgs[i].role === 'user' && msgs[i].content.trim()) { original = msgs[i].content.trim(); break; }
  }
  if (!original || original === current) return current;
  return `${original} — clarification: ${current}`;
}

function renderExtraContext(req: AgentRunRequest, followUp?: AgentFollowUpContext): string | undefined {
  const parts: string[] = [];
  const upstream = req.upstream?.sql?.trim();
  if (upstream) {
    const label = upstream.startsWith('{') || upstream.startsWith('[')
      ? 'Current app/drill context'
      : 'Current upstream SQL';
    parts.push(`${label}:\n${upstream}`);
  }
  const context = req.conversationContext;
  if (context) {
    // Bound the carried-forward "conversation memory" defensively: only the most
    // recent turn's signals, with hard caps on the summary length and list sizes
    // so prompts don't grow across a long multi-turn chat.
    const clampText = (value: string, max = 240): string =>
      value.length > max ? `${value.slice(0, max).trimEnd()}…` : value;
    const clampList = (values: string[], max = 8): string => values.slice(0, max).join(', ');
    const contextLines = [
      context.sourceCertifiedBlock ? `source certified block: ${context.sourceCertifiedBlock}` : '',
      context.sourceQuestion ? `source question: ${clampText(context.sourceQuestion, 200)}` : '',
      context.sourceAnswerSummary ? `source answer summary: ${clampText(context.sourceAnswerSummary)}` : '',
      context.contextPackId ? `context pack: ${context.contextPackId}` : '',
      context.trustLabel ? `trust label: ${context.trustLabel}` : '',
      context.reviewStatus ? `review status: ${context.reviewStatus}` : '',
      context.draftBlockPath ? `draft block: ${context.draftBlockPath}` : '',
      context.requestedFilters?.length ? `remembered filters: ${clampList(context.requestedFilters)}` : '',
      context.requestedDimensions?.length ? `remembered dimensions: ${clampList(context.requestedDimensions)}` : '',
      context.outputColumns?.length ? `prior output columns: ${clampList(context.outputColumns)}` : '',
    ].filter(Boolean);
    if (contextLines.length > 0) {
      parts.push(`Conversation memory:\n${contextLines.join('\n')}`);
    }
  }
  if (followUp?.sourceBlockName) {
    const suffix = followUp.kind === 'drilldown'
      ? 'Use it as source context, but prefer a distinct certified drilldown block or a review-required draft.'
      : 'Reuse it for this generic follow-up.';
    parts.push(`Follow-up context: the user is referring to certified block "${followUp.sourceBlockName}". ${suffix}`);
  }
  if (followUp?.filters?.length) {
    parts.push(`Requested follow-up filters: ${followUp.filters.join(', ')}`);
  }
  if (followUp?.dimensions?.length) {
    parts.push(`Requested follow-up dimensions: ${followUp.dimensions.join(', ')}`);
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

function selectedContextForMetadata(req: AgentRunRequest, question: string): unknown {
  const upstream = req.upstream?.sql?.trim();
  if (!upstream || (!upstream.startsWith('{') && !upstream.startsWith('['))) return req.upstream;
  try {
    const parsed = JSON.parse(upstream) as Record<string, unknown>;
    if (!('selectedBlock' in parsed) && !('focusBlock' in parsed)) return req.upstream;
    if (shouldUseFocusedTileForQuestion(question)) return req.upstream;
    const { selectedBlock: _selectedBlock, ...rest } = parsed;
    return {
      ...rest,
      focusBlock: rest.focusBlock ?? _selectedBlock,
      contextPolicy: {
        ...(rest.contextPolicy && typeof rest.contextPolicy === 'object' && !Array.isArray(rest.contextPolicy)
          ? rest.contextPolicy as Record<string, unknown>
          : {}),
        retrieval: 'question_first',
        focusBlockUse: 'soft_context_only',
      },
    };
  } catch {
    return req.upstream;
  }
}

function shouldUseSelectedBlockHint(
  req: AgentRunRequest,
  question: string,
  followUp?: AgentFollowUpContext,
): boolean {
  if (followUp?.kind === 'generic' && followUp.sourceBlockName) return false;
  if (followUp?.kind === 'drilldown' || isDrilldownFollowUp(question)) return false;
  return shouldUseFocusedTileForQuestion(question) && extractSelectedBlockHints(req).length > 0;
}

function shouldUseFocusedTileForQuestion(question: string): boolean {
  const lower = question.toLowerCase();
  if (!/\b(this|that|it|selected\s+(?:tile|block|metric)|current\s+(?:tile|block|metric))\b/.test(lower)) return false;
  if (/\b(top|bottom|best|worst|highest|lowest|least|fewest|less|most|rank|ranking|orders?|customers?|revenue|spend|by\s+[a-z]|compare|break\s*down|drill|why|driver|list|show|give me)\b/.test(lower)) {
    return false;
  }
  return true;
}

function extractSelectedBlockHints(req: AgentRunRequest): string[] {
  const upstream = req.upstream?.sql?.trim();
  if (!upstream || (!upstream.startsWith('{') && !upstream.startsWith('['))) return [];
  try {
    const parsed = JSON.parse(upstream) as {
      selectedBlock?: { blockId?: unknown };
      focusBlock?: { blockId?: unknown };
      availableBlocks?: Array<{ blockId?: unknown }>;
    };
    const selected = typeof parsed.selectedBlock?.blockId === 'string'
      ? parsed.selectedBlock.blockId.trim()
      : typeof parsed.focusBlock?.blockId === 'string'
        ? parsed.focusBlock.blockId.trim()
      : '';
    return selected ? [selected] : [];
  } catch {
    return [];
  }
}

function inferFollowUpContext(req: AgentRunRequest, question: string): AgentFollowUpContext | undefined {
  const kind = isGenericFollowUp(question) ? 'generic' : isDrilldownFollowUp(question) ? 'drilldown' : null;
  if (!kind) return undefined;
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const msg = req.messages[i];
    if (msg.role !== 'assistant') continue;
    const sourceBlockName = extractCertifiedBlockName(msg.content);
    if (!sourceBlockName) continue;
    return {
      kind,
      sourceBlockName,
      sourceAnswer: msg.content.slice(0, 1200),
      filters: kind === 'drilldown' ? extractDrilldownFilters(question) : undefined,
      dimensions: kind === 'drilldown' ? extractDrilldownDimensions(question) : undefined,
    };
  }
  return undefined;
}

function followUpFromConversationContext(req: AgentRunRequest, question: string): AgentFollowUpContext | undefined {
  const context = req.conversationContext;
  if (!context) return undefined;
  const sourceBlockName = cleanOptionalString(context.sourceCertifiedBlock);
  if (!sourceBlockName) return undefined;
  const inferredKind = isGenericFollowUp(question)
    ? 'generic'
    : isDrilldownFollowUp(question)
      ? 'drilldown'
      : null;
  const kind = inferredKind ?? (context.followupKind === 'generic' || context.followupKind === 'drilldown' ? context.followupKind : null);
  if (!kind) return undefined;
  return {
    kind,
    sourceBlockName,
    sourceQuestion: cleanOptionalString(context.sourceQuestion),
    sourceAnswer: cleanOptionalString(context.sourceAnswerSummary),
    filters: kind === 'drilldown'
      ? mergeStrings(context.requestedFilters, extractDrilldownFilters(question))
      : undefined,
    dimensions: kind === 'drilldown'
      ? mergeStrings(context.requestedDimensions, extractDrilldownDimensions(question))
      : undefined,
  };
}

function extractCertifiedBlockName(content: string): string | undefined {
  const fromAnswer = content.match(/Answered by certified block \*\*([^*]+)\*\*/i)?.[1];
  const fromCitation = content.match(/^- block:\s*([A-Za-z0-9_.-]+)/im)?.[1];
  return (fromAnswer ?? fromCitation)?.trim();
}

function cleanOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function mergeStrings(...groups: Array<unknown[] | undefined>): string[] | undefined {
  const values = groups
    .flatMap((group) => group ?? [])
    .map((value) => cleanOptionalString(value))
    .filter((value): value is string => Boolean(value));
  const unique = Array.from(new Set(values)).slice(0, 24);
  return unique.length > 0 ? unique : undefined;
}

const GENERIC_FOLLOW_UP_WORDS = new Set([
  'a', 'about', 'again', 'all', 'also', 'and', 'as', 'be', 'block', 'can', 'could', 'data', 'do',
  'execute', 'for', 'from', 'get', 'give', 'import', 'it', 'its', 'let', 'lets', 'me', 'metrics',
  'more', 'now', 'of', 'output', 'please', 'result', 'results', 'run', 'show', 'solution', 'summary',
  'that', 'the', 'them', 'this', 'to', 'use', 'with', 'you',
]);

function isGenericFollowUp(question: string): boolean {
  const lower = question.toLowerCase();
  if (!/\b(block|data|execute|import|it|result|results|run|solution|that|this)\b/.test(lower)) return false;
  const tokens = lower.match(/[a-z0-9_]+/g) ?? [];
  const meaningful = tokens.filter((token) => token.length > 1 && !GENERIC_FOLLOW_UP_WORDS.has(token));
  return meaningful.length === 0;
}

function isDrilldownFollowUp(question: string): boolean {
  const lower = question.toLowerCase();
  return /\b(drill|break\s*down|slice|segment|filter|compare|split|why|changed?|change|driver|root cause|increase|decrease|drop|spike|variance|by|for|only|where|last week|this week|last month|this month|enterprise|region|customer|channel|product)\b/.test(lower)
    && !/\b(what is|what are|define|definition|meaning of)\b/.test(lower);
}

function extractDrilldownFilters(question: string): string[] {
  const filters: string[] = [];
  const quoted = [...question.matchAll(/["']([^"']+)["']/g)].map((match) => match[1].trim()).filter(Boolean);
  filters.push(...quoted);
  for (const pattern of [
    /\benterprise\b/i,
    /\bsmall business\b/i,
    /\bmid[- ]market\b/i,
    /\blast week\b/i,
    /\bthis week\b/i,
    /\blast month\b/i,
    /\bthis month\b/i,
    /\blast quarter\b/i,
    /\bthis quarter\b/i,
  ]) {
    const match = question.match(pattern);
    if (match) filters.push(match[0]);
  }
  return Array.from(new Set(filters));
}

function extractDrilldownDimensions(question: string): string[] {
  const dims: string[] = [];
  for (const match of question.matchAll(/\bby\s+([a-z][a-z0-9_ -]{1,40})/gi)) {
    const value = match[1].replace(/\b(last|this|where|for|only|and|with)\b.*$/i, '').trim();
    if (value) dims.push(value);
  }
  for (const dim of ['segment', 'region', 'customer', 'channel', 'product', 'week', 'month']) {
    if (new RegExp(`\\b${dim}\\b`, 'i').test(question)) dims.push(dim);
  }
  return Array.from(new Set(dims));
}

function formatAgentAnswer(result: AgentAnswer): string {
  const badge = result.certification === 'certified'
    ? 'Certified'
    : result.sourceTier === 'semantic_layer'
      ? 'AI generated from semantic layer - analyst review required'
      : result.kind === 'no_answer'
        ? 'No answer'
        : 'AI generated from dbt manifest - analyst review required';
  const citations = result.citations.length > 0
    ? '\n\nCitations:\n' + result.citations.map((c) => `- ${c.kind}: ${c.name}${c.provenance ? ` (${c.provenance})` : ''}`).join('\n')
    : '';
  const resultPreview = formatResultPreview(result.result);
  const sql = result.proposedSql ? `\n\nProposed SQL:\n\`\`\`sql\n${result.proposedSql}\n\`\`\`` : '';
  return `[${badge}]\n\n${result.text}${resultPreview}${citations}${sql}`;
}

function formatResultPreview(result?: AgentResultPayload): string {
  if (!result) return '';
  const columns = normalizeColumns(result.columns).slice(0, 8);
  const rows = Array.isArray(result.rows) ? result.rows.slice(0, 8) : [];
  const shown = rows.length;
  const timing = typeof result.executionTime === 'number' && result.executionTime > 0
    ? ` in ${Math.round(result.executionTime)} ms`
    : '';
  if (columns.length === 0 || rows.length === 0) {
    return `\n\nResults: ${result.rowCount} row${result.rowCount === 1 ? '' : 's'}${timing}.`;
  }
  const tableRows = rows.map((row) => {
    const record = row && typeof row === 'object' ? row as Record<string, unknown> : {};
    return `| ${columns.map((col) => formatCell(record[col])).join(' | ')} |`;
  });
  const omittedRows = result.rowCount > shown ? ` Showing first ${shown} rows.` : '';
  return [
    `\n\nResults: ${result.rowCount} row${result.rowCount === 1 ? '' : 's'}${timing}.${omittedRows}`,
    `| ${columns.map(escapeMarkdownTable).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...tableRows,
  ].join('\n');
}

function normalizeColumns(columns: unknown[]): string[] {
  return columns.map((column) => {
    if (typeof column === 'string') return column;
    if (column && typeof column === 'object' && typeof (column as { name?: unknown }).name === 'string') {
      return (column as { name: string }).name;
    }
    return String(column);
  });
}

function formatCell(value: unknown): string {
  if (value === null || typeof value === 'undefined') return '';
  const raw = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return escapeMarkdownTable(raw.length > 80 ? `${raw.slice(0, 77)}...` : raw);
}

function escapeMarkdownTable(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function emitDraftProposal(result: AgentAnswer, question: string, emit: (turn: AgentTurn) => void): void {
  const isDrilldown = result.evidence?.route.some((step) => step.tool === 'propose_drilldown' && step.status === 'checked') ?? false;
  const proposal: BlockProposal = {
    name: slugify(question).slice(0, 56) || 'ai_generated_analysis',
    domain: inferProposalDomain(result) ?? '',
    owner: `${process.env.USER ?? 'analyst'}@local`,
    description: result.text.slice(0, 240),
    sql: result.proposedSql!,
    tags: ['ai-generated', 'needs-review', result.sourceTier ?? 'dbt_manifest', ...(isDrilldown ? ['drilldown'] : [])],
    chartType: result.suggestedViz,
  };
  emit({
    kind: 'proposal',
    proposal,
    governance: {
      certified: false,
      errors: [],
      warnings: [
        isDrilldown
          ? 'AI generated drilldown. Validate filters, joins, and grain before certifying.'
          : 'AI generated. Analyst review and certification are required before reuse as governed content.',
      ],
    },
  });
}

function inferProposalDomain(result: AgentAnswer): string | undefined {
  const evidence = result.evidence;
  const candidates = [
    ...(evidence?.selectedAssets ?? []),
    ...(evidence?.semanticObjects ?? []),
    ...(evidence?.sourceTables ?? []),
  ];
  return candidates.find((asset) => typeof asset.domain === 'string' && asset.domain.trim())?.domain?.trim();
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');
}
