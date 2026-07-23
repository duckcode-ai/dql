import {
  ClaudeProvider,
  KGStore,
  MemoryStore,
  defaultKgPath,
  defaultMemoryPath,
  GeminiProvider,
  loadAgentSemanticLayer,
  OllamaProvider,
  OpenAIProvider,
  answer,
  buildAnalysisQuestionPlan,
  buildLocalContextPack,
  contextRetrievalBudgetForQuestion,
  ensureAgentProjectReady,
  type AgentAnswer,
  type AgentDqlArtifactReference,
  type CertifiedFitConfirmation,
  type CertifiedFitConfirmationRequest,
  type AgentFollowUpContext,
  type AgentMemberBinding,
  type AgentPriorResultReference,
  type AgentProvider,
  type AgentResultPayload,
  type ConversationSnapshot,
  type LocalContextPack,
  type Skill,
} from '@duckcodeailabs/dql-agent';
import { buildManifest, normalizeDqlArtifactReference, resolveDbtManifestPath } from '@duckcodeailabs/dql-core';
import { existsSync } from 'node:fs';
import type { AgentRunRequest, AgentRunner, AgentTurn, BlockProposal, ProviderId } from '../types.js';
import { buildAnswerLoopTools, createGroundingContextExpander } from '../answer-loop-tools.js';
import { rethrowIfCancelled } from '../cancellation.js';
import { getSemanticRuntimeStatus } from '../../semantic-runtime.js';
import { blockProposalDqlMetadata } from '../proposal-metadata.js';
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

function createCertifiedFitConfirmation(provider: AgentProvider, signal?: AbortSignal): CertifiedFitConfirmation {
  return async ({ question, questionPlan, block, fit }) => {
    const response = await provider.generate([
      {
        role: 'system',
        content: [
          'You are a strict governed analytics routing judge.',
          'Decide whether the certified block can directly answer the user question.',
          'Allow only when the block covers the requested metric, grain, dimensions, filters, required columns, ranking, and top-N.',
          'If the block is merely useful context, close but wrong grain, missing requested columns, or ambiguous, reject it.',
          'Return JSON only: {"allow":boolean,"confidence":"high|medium|low","reason":"short reason"}.',
        ].join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify({
          question,
          requestedShape: questionPlan.requestedShape,
          candidateBlock: summarizeBlockForFitConfirmation(block),
          deterministicFit: {
            kind: fit.kind,
            confidence: fit.confidence,
            reasons: fit.reasons,
            missingOutputs: fit.missingOutputs,
            missingDimensions: fit.missingDimensions,
            unsupportedFilters: fit.unsupportedFilters,
            grainMismatch: fit.grainMismatch,
            topNAction: fit.topNAction,
            inferredContract: fit.inferredContract,
          },
        }, null, 2),
      },
    ], { maxTokens: 220, temperature: 0, signal });
    return parseCertifiedFitConfirmation(response);
  };
}

/**
 * Decide whether the answer path needs a live warehouse-schema read up front.
 * Catalog-backed relations are already present in the context pack and the
 * generated lane has bounded schema tools for genuine gaps, so eager warehouse
 * scans are reserved for unresolved filters or an empty retrieved SQL context.
 */
function shouldLoadSchemaContext(
  contextPack: LocalContextPack | undefined,
  hasSemanticLayer: boolean,
): boolean {
  if (!contextPack) return true;
  const route = contextPack.routeDecision.route;
  if (route === 'certified' || route === 'clarify' || route === 'conflict') return false;
  if (contextPack.questionPlan.requestedShape.filters.length > 0) return true;

  const hasSemanticCandidates = hasSemanticLayer && contextPack.objects.some((object) =>
    object.objectType === 'metric'
    || object.objectType === 'dimension'
    || object.objectType === 'measure'
    || object.objectType === 'semantic_model');
  if (hasSemanticCandidates) return false;

  return contextPack.allowedSqlContext.relations.length === 0
    && contextPack.allowedSqlContext.sourceBlockSql.length === 0;
}

function shouldSearchProjectFiles(contextPack: LocalContextPack | undefined): boolean {
  if (!contextPack) return true;
  if (contextPack.routeDecision.route === 'certified') return false;
  const meaningfulObjects = contextPack.objects.filter((object) =>
    object.objectType === 'block'
    || object.objectType === 'metric'
    || object.objectType === 'semantic_metric'
    || object.objectType === 'semantic_model'
    || object.objectType === 'dbt_model');
  return meaningfulObjects.length < 2
    || (contextPack.allowedSqlContext.relations.length === 0
      && contextPack.allowedSqlContext.sourceBlockSql.length === 0);
}

function renderProjectSourceSearch(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const matches = (value as { matches?: unknown }).matches;
  if (!Array.isArray(matches) || matches.length === 0) return undefined;
  const lines = matches.slice(0, 24).flatMap((match) => {
    if (!match || typeof match !== 'object' || Array.isArray(match)) return [];
    const record = match as { path?: unknown; line?: unknown; text?: unknown };
    if (typeof record.path !== 'string' || typeof record.text !== 'string') return [];
    return [`${record.path}${typeof record.line === 'number' ? `:${record.line}` : ''} — ${record.text}`];
  });
  return lines.length > 0
    ? `Live project source matches (bounded fallback; validate through DQL metadata before use):\n${lines.join('\n')}`
    : undefined;
}

function summarizeBlockForFitConfirmation(block: CertifiedFitConfirmationRequest['block']): Record<string, unknown> {
  const payload = block.payload ?? {};
  return {
    objectKey: block.objectKey,
    objectType: block.objectType,
    name: block.name,
    status: block.status,
    description: block.description ?? stringValue(payload.description),
    grain: stringValue(payload.grain),
    dimensions: stringArray(payload.dimensions),
    entities: stringArray(payload.entities),
    declaredOutputs: stringArray(payload.declaredOutputs),
    outputContract: payload.outputContract,
    allowedFilters: stringArray(payload.allowedFilters),
    sql: truncateForFitPrompt(stringValue(payload.sql), 1200),
    llmContext: truncateForFitPrompt(stringValue(payload.llmContext), 800),
  };
}

function parseCertifiedFitConfirmation(text: string): { allow: boolean; confidence?: 'high' | 'medium' | 'low'; reason?: string } {
  const jsonText = extractJsonObject(text);
  if (!jsonText) {
    return { allow: false, confidence: 'low', reason: 'fit confirmation did not return JSON' };
  }
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const confidence = parsed.confidence === 'high' || parsed.confidence === 'medium' || parsed.confidence === 'low'
      ? parsed.confidence
      : undefined;
    return {
      allow: parsed.allow === true,
      ...(confidence ? { confidence } : {}),
      reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
    };
  } catch {
    return { allow: false, confidence: 'low', reason: 'fit confirmation returned malformed JSON' };
  }
}

function extractJsonObject(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  if (fenced?.[1]) return fenced[1];
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function truncateForFitPrompt(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

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
        ...blockProposalDqlMetadata(raw),
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
        const requestStartedAt = Date.now();
        emit({ kind: 'thinking', text: `Using ${spec.label} through the governed DQL agent.` });
        const kgPath = defaultKgPath(req.projectRoot);
        if (!existsSync(kgPath)) {
          emit({ kind: 'thinking', text: 'Building the local agent knowledge graph from terms, business views, blocks, apps, dashboards, dbt, and semantic metadata.' });
        }
        const projectStateStartedAt = Date.now();
        const projectState = await ensureAgentProjectReady(req.projectRoot, { kgPath, manifest: req.projectSnapshot?.manifest });
        const projectStateDurationMs = Date.now() - projectStateStartedAt;
        emit({ kind: 'thinking', text: projectState.cacheHit ? 'Reused the warm project index.' : 'Refreshed the project index after source changes.' });

        const rawQuestion = resolveEffectiveQuestion(req);
        if (!rawQuestion) {
          emit({ kind: 'error', message: 'No user question found.' });
          return;
        }

        const memory = new MemoryStore(defaultMemoryPath(req.projectRoot));
        const kg = new KGStore(kgPath);
        try {
          const conversationSnapshot = conversationSnapshotFromContext(req.conversationContext);
          const rawFollowUp = followUpFromConversationContext(req, rawQuestion) ?? inferFollowUpContext(req, rawQuestion);
          const followUp = applyTopicShiftGuard(rawFollowUp, conversationSnapshot);
          // CTX-003: retrieval and planning operate on the user's current words.
          // Prior SQL, DQL source, owners, and result metadata stay in the typed
          // follow-up envelope rendered separately for the provider; concatenating
          // them into the question polluted filters/dimensions and changed intent.
          const question = rewriteFollowUpQuestion(rawQuestion, followUp);
          // Retrieve durable learnings only — notebook/project/user/artifact scope.
          // `thread` (per-conversation) memory is intentionally excluded: it is
          // raw-chat residue, not a governed learning, and bloats the prompt.
          const memoryContext = memory.search({
            query: question,
            scopes: ['notebook', 'project', 'user', 'artifact'],
            scopeId: req.upstream?.cellId,
            limit: 6,
          });
          const semanticLayer = loadAgentSemanticLayer(req.projectRoot);
          const semanticRuntimeActive = semanticLayer
            ? await getSemanticRuntimeStatus(req.projectRoot).then((status) => status.active).catch(() => 'native' as const)
            : 'native' as const;
          const questionPlan = buildAnalysisQuestionPlan(question, followUp);
          const contextBudget = contextRetrievalBudgetForQuestion({
            questionPlan,
            requestedDepth: req.analysisDepth,
            reasoningEffort: req.reasoningEffort,
          });
          const selectedContext = selectedContextForMetadata(req, question);
          emit({ kind: 'thinking', text: 'Searching certified blocks, semantic metrics, relevant domains, and skills.' });
          const contextStartedAt = Date.now();
          const contextPack = req.preparedContextPack ?? await buildLocalContextPack(req.projectRoot, {
            question,
            surface: 'notebook',
            followUp,
            selectedContext,
            strictness: contextBudget.strictness,
            limit: contextBudget.limit,
            confirmCertifiedFit: createCertifiedFitConfirmation(provider, signal),
            // Conversation-aware reuse: same-topic follow-ups seed (or, for
            // filter-only refinements, re-stamp) the prior turn's context pack.
            priorContextPackId: priorContextPackIdFromSnapshot(conversationSnapshot),
            conversationTopicRelation: conversationSnapshot?.topicRelation,
            domainContext: req.domainContext,
            preparedMetadataFingerprint: projectState.metadataFingerprint,
          })
            .catch(() => undefined);
          // CTX-002/SKILL-003: the immutable context pack is the single skill
          // selection for this turn. Never re-read mutable skill files after
          // the project snapshot has been acquired.
          const skills: Skill[] = (contextPack?.skills ?? []).map((skill) => ({
            id: skill.id,
            localId: skill.id,
            qualifiedId: skill.qualifiedId,
            scope: 'project',
            domain: skill.domain,
            domains: skill.domains,
            modelAreaRefs: skill.modelAreaRefs,
            kind: skill.kind,
            status: skill.status,
            owner: skill.owner,
            triggers: skill.triggers,
            exclusions: skill.exclusions,
            description: skill.description,
            preferredMetrics: skill.preferredMetrics,
            preferredBlocks: skill.preferredBlocks,
            preferredDimensions: skill.preferredDimensions,
            requiredFilters: skill.requiredFilters,
            clarifyWhen: skill.clarifyWhen,
            examples: [],
            sourceRefs: skill.sourceRefs,
            vocabulary: skill.vocabulary,
            body: skill.guidance,
            sourcePath: skill.sourcePath ?? '',
          }));
          const contextDurationMs = Date.now() - contextStartedAt;
          const answerLoopTools = buildAnswerLoopTools(req.projectRoot);
          const sourceSearchTool = answerLoopTools.find((tool) => tool.name === 'search_project_files');
          const sourceSearchStartedAt = Date.now();
          const earlySourceSearch = sourceSearchTool && shouldSearchProjectFiles(contextPack)
            ? await (async () => {
                emit({ kind: 'thinking', text: 'Checking live project definitions for a missed metric, dimension, or join.' });
                return sourceSearchTool.run({ query: question, limit: 24 }).catch(() => undefined);
              })()
            : undefined;
          const sourceSearchDurationMs = Date.now() - sourceSearchStartedAt;
          const extraContext = [
            renderExtraContext(req, followUp),
            renderProjectSourceSearch(earlySourceSearch),
          ].filter((value): value is string => Boolean(value)).join('\n\n') || undefined;
          // Catalog relations already carry the bounded column context needed by
          // certified and semantic lanes. Touch the live warehouse only when the
          // retrieved context proves it is necessary (unresolved filters or no
          // usable relation). This also passes the prepared pack so the runtime
          // never builds a second metadata context pack for the same question.
          const schemaStartedAt = Date.now();
          if (req.getSchemaContext && shouldLoadSchemaContext(contextPack, Boolean(semanticLayer))) {
            emit({ kind: 'thinking', text: 'Inspecting the runtime schema needed to ground this answer.' });
          }
          const schemaContext = req.getSchemaContext && shouldLoadSchemaContext(contextPack, Boolean(semanticLayer))
            ? await req.getSchemaContext(question, contextPack).catch(() => [])
            : [];
          const schemaDurationMs = Date.now() - schemaStartedAt;
          const selectedBlockHints = shouldUseSelectedBlockHint(req, question, followUp)
            ? extractSelectedBlockHints(req)
            : [];
          const blockHints = Array.from(new Set([
            ...(followUp?.kind === 'generic' && followUp.sourceBlockName ? [followUp.sourceBlockName] : []),
            ...selectedBlockHints,
          ]));
          const answerStartedAt = Date.now();
          emit({ kind: 'thinking', text: 'Resolving the best governed answer path and validating the result.' });
          const manifest = req.projectSnapshot?.manifest ?? buildManifest({
            projectRoot: req.projectRoot,
            dbtManifestPath: resolveDbtManifestPath(req.projectRoot) ?? undefined,
          });
          const guardSnapshot = (): void => {
            if (req.projectSnapshot) req.assertProjectSnapshot?.(req.projectSnapshot.snapshotId);
          };
          const result = await answer({
            question,
            ...(req.resolvedAnalyticalPlan
              ? { resolvedAnalyticalPlan: req.resolvedAnalyticalPlan }
              : {}),
            ...(req.analyticalReferenceInstant
              ? { analyticalReferenceInstant: req.analyticalReferenceInstant }
              : {}),
            ...(req.resolveAnalyticalFreshness
              ? { resolveAnalyticalFreshness: req.resolveAnalyticalFreshness }
              : {}),
            extraContext,
            provider,
            kg,
            manifest,
            domain: req.domainContext?.activeDomain ?? undefined,
            domainContext: req.domainContext,
            skills,
            blockHints,
            followUp,
            conversationSnapshot,
            memoryContext,
            schemaContext,
            semanticLayer,
            // Runtime-aware executability for metric SELECTION: with a full
            // semantic runtime active (dbt Cloud / MetricFlow CLI) every
            // governed metric is executable; native-only hosts demote
            // runtime-only metrics so they cannot outrank an executable
            // sibling on a lexical tie.
            ...(semanticLayer
              ? {
                  canExecuteSemanticMetric: (metricName: string) =>
                    semanticRuntimeActive !== 'native' || semanticLayer.canComposeMetric(metricName),
                }
              : {}),
            contextPack,
            signal,
            reasoningEffort: req.reasoningEffort,
            analysisDepth: contextBudget.analysisDepth,
            ...(req.semanticDriver ? { semanticDriver: req.semanticDriver } : {}),
            ...(req.semanticTableMapping ? { semanticTableMapping: req.semanticTableMapping } : {}),
            ...(req.semanticQueryCompiler ? { semanticQueryCompiler: req.semanticQueryCompiler } : {}),
            ...(req.preferredEvidenceIds?.length ? { preferredEvidenceIds: req.preferredEvidenceIds } : {}),
            ...(req.preferredExecutionId ? { preferredExecutionId: req.preferredExecutionId } : {}),
            executeCertifiedBlock: req.executeCertifiedBlock
              ? async (...args) => { guardSnapshot(); return req.executeCertifiedBlock!(...args); }
              : undefined,
            executeGeneratedSql: req.executeGeneratedSql
              ? async (...args) => { guardSnapshot(); return req.executeGeneratedSql!(...args); }
              : undefined,
            executeDqlArtifact: req.executeDqlArtifact
              ? async (...args) => { guardSnapshot(); return req.executeDqlArtifact!(...args); }
              : undefined,
            expandGroundingContext: createGroundingContextExpander(req.projectRoot),
            answerLoopTools,
            // NOTE: no captureGeneratedDraft here — a plain answer/research question must NOT
            // auto-write a draft into the blocks space. A draft is created only when the user
            // explicitly acts (the "Create DQL draft" action → the dql_block_draft route).
          });
          const answerDurationMs = Date.now() - answerStartedAt;
          // CTX-002: an answer built from one snapshot must never be published
          // after the runtime has advanced to another snapshot.
          guardSnapshot();
          result.evidence = result.evidence ?? {
            route: [], lineage: [], businessContext: [], selectedAssets: [], sourceTables: [], semanticObjects: [], citations: result.citations,
          };
          result.evidence.route.unshift({
            tool: 'prepare_project_state',
            status: 'checked',
            label: projectState.cacheHit ? 'Reused warm project index' : 'Refreshed project index',
            detail: `catalog=${projectState.metadataFingerprint.slice(0, 12)}; schema=${schemaContext.length > 0 ? 'loaded' : 'deferred'}`,
          });
          result.evidence.timings = [
            { phase: 'project_state', durationMs: projectStateDurationMs, detail: projectState.cacheHit ? 'warm index reused' : 'project index refreshed' },
            { phase: 'context_retrieval', durationMs: contextDurationMs, detail: contextPack ? `objects=${contextPack.objects.length}` : 'catalog unavailable' },
            { phase: 'source_search', durationMs: sourceSearchDurationMs, detail: earlySourceSearch ? 'bounded live fallback ran' : 'not needed' },
            { phase: 'runtime_schema', durationMs: schemaDurationMs, detail: schemaContext.length > 0 ? `tables=${schemaContext.length}` : 'deferred' },
            { phase: 'answer_resolution', durationMs: answerDurationMs, detail: result.route?.tier ?? result.kind },
            { phase: 'total', durationMs: Date.now() - requestStartedAt },
          ];
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
        // A deadline/cancellation is NOT a provider failure. Rethrow it intact so
        // the engine renders its graceful bounded-deadline message instead of a
        // raw "<provider> failed: The operation was aborted due to timeout".
        rethrowIfCancelled(err, signal);
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

export function rewriteFollowUpQuestion(question: string, followUp?: AgentFollowUpContext): string {
  void followUp;
  return question.replace(/\s+/g, ' ').trim();
}

function formatPriorResultRefForQuestion(ref: AgentPriorResultReference): string {
  const parts = [
    `Prior result ref: result:${ref.id}`,
    ref.columns.length ? `schema=[${ref.columns.slice(0, 24).join(', ')}]` : '',
    typeof ref.rowCount === 'number' ? `row_count=${ref.rowCount}` : '',
    ref.sourceSql ? `source_sql=${compactInline(ref.sourceSql, 500)}` : '',
  ].filter(Boolean);
  return parts.join('; ');
}

function formatPriorDqlArtifactForQuestion(artifact: AgentDqlArtifactReference): string {
  const parts = [
    `Prior DQL artifact: kind=${artifact.kind}`,
    artifact.name ? `name=${artifact.name}` : '',
    artifact.sourcePath ? `path=${artifact.sourcePath}` : '',
    artifact.metrics?.length ? `metrics=[${artifact.metrics.slice(0, 12).join(', ')}]` : '',
    artifact.dimensions?.length ? `dimensions=[${artifact.dimensions.slice(0, 12).join(', ')}]` : '',
    artifact.filters?.length ? `filters=[${artifact.filters.slice(0, 8).map(formatDqlArtifactFilterInline).join('; ')}]` : '',
    artifact.timeDimension ? `time=${artifact.timeDimension.name}/${artifact.timeDimension.granularity}` : '',
    artifact.orderBy?.length ? `order_by=[${artifact.orderBy.slice(0, 8).map((order) => `${order.name} ${order.direction}`).join(', ')}]` : '',
    typeof artifact.limit === 'number' ? `limit=${artifact.limit}` : '',
    artifact.source ? `source=${compactInline(artifact.source, 900)}` : '',
  ].filter(Boolean);
  return parts.join('; ');
}

function formatDqlArtifactFilterInline(filter: { dimension: string; operator: string; values: string[] }): string {
  return `${filter.dimension} ${filter.operator} ${filter.values.slice(0, 8).join(', ')}`;
}

function formatFollowUpFilters(followUp: AgentFollowUpContext): string {
  if (!followUp.filters?.length) return '';
  if (followUp.dimensions?.length === 1) {
    return `${followUp.dimensions[0]} in [${followUp.filters.join(', ')}]`;
  }
  return followUp.filters.join(', ');
}

function compactInline(value: string, max: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 3).trimEnd()}...` : compact;
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
  // Thread-scoped runs render the structured conversation snapshot in its own
  // prompt section (answer-loop) — skip this text recap to avoid double-carrying.
  const hasServerSnapshot = Boolean((context as Record<string, unknown> | undefined)?.serverSnapshot);
  if (context && !hasServerSnapshot) {
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
      context.dqlArtifact ? `prior DQL artifact:\n${formatPriorDqlArtifactForQuestion(context.dqlArtifact)}` : '',
      context.requestedFilters?.length ? `remembered filters: ${clampList(context.requestedFilters)}` : '',
      context.requestedDimensions?.length ? `remembered dimensions: ${clampList(context.requestedDimensions)}` : '',
      context.outputColumns?.length ? `prior output columns: ${clampList(context.outputColumns)}` : '',
      context.resultDimensionValues ? `prior result values: ${formatResultDimensionValues(context.resultDimensionValues)}` : '',
      context.turns?.length ? `recent analytical turns:\n${formatConversationTurnsForPrompt(context.turns)}` : '',
    ].filter(Boolean);
    if (contextLines.length > 0) {
      parts.push(`Conversation memory:\n${contextLines.join('\n')}`);
    }
  }
  if (followUp?.sourceBlockName) {
    const suffix = followUp.kind === 'drilldown'
      ? 'Use it as source context, but prefer a distinct certified drilldown block or a review-required draft.'
      : followUp.kind === 'contextual'
        ? 'This is advisory prior-turn context — use it only if the question refers to it; on a new topic, ignore it.'
        : 'Reuse it for this generic follow-up.';
    const lead = followUp.kind === 'contextual'
      ? `Prior turn used certified block "${followUp.sourceBlockName}".`
      : `Follow-up context: the user is referring to certified block "${followUp.sourceBlockName}".`;
    parts.push(`${lead} ${suffix}`);
  }
  if (followUp?.filters?.length) {
    parts.push(`Requested follow-up filters: ${followUp.filters.join(', ')}`);
  }
  if (followUp?.dimensions?.length) {
    parts.push(`Requested follow-up dimensions: ${followUp.dimensions.join(', ')}`);
  }
  if (followUp?.priorResultRef) {
    parts.push(`Prior result reference:\n${formatPriorResultRefForQuestion(followUp.priorResultRef)}`);
  }
  if (followUp?.priorDqlArtifact) {
    parts.push(`Prior DQL artifact reference:\n${formatPriorDqlArtifactForQuestion(followUp.priorDqlArtifact)}`);
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
  // Messages-only fallback (no structured conversationContext). Regexes classify the
  // kind; a non-matching question still carries the prior turn as advisory 'contextual'.
  const kind = isGenericFollowUp(question) ? 'generic' : isDrilldownFollowUp(question) ? 'drilldown' : 'contextual';
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

function priorContextPackIdFromSnapshot(snapshot: ConversationSnapshot | undefined): string | undefined {
  const fromState = (snapshot?.workingState as { lastContextPackId?: unknown } | undefined)?.lastContextPackId;
  if (typeof fromState === 'string' && fromState.trim()) return fromState;
  const fromTurns = snapshot?.recentTurns?.length
    ? snapshot.recentTurns[snapshot.recentTurns.length - 1]?.contextPackId
    : undefined;
  return typeof fromTurns === 'string' && fromTurns.trim() ? fromTurns : undefined;
}

/** Parse the server-attached conversation snapshot (thread-scoped runs only). */
function conversationSnapshotFromContext(
  context: AgentRunRequest['conversationContext'],
): ConversationSnapshot | undefined {
  const raw = (context as Record<string, unknown> | undefined)?.serverSnapshot;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const snapshot = raw as ConversationSnapshot;
  return typeof snapshot.threadId === 'string' && Array.isArray(snapshot.recentTurns)
    ? snapshot
    : undefined;
}

/**
 * Deterministic stale-context protection: when the persisted working state says
 * the new question is a topic SHIFT, prior-turn filters must not be forced into
 * the follow-up (a "by X" phrasing can regex-classify as drilldown even on a
 * genuinely new topic). Question-derived filters are kept; carried ones drop.
 */
function applyTopicShiftGuard(
  followUp: AgentFollowUpContext | undefined,
  snapshot: ConversationSnapshot | undefined,
): AgentFollowUpContext | undefined {
  if (!followUp || snapshot?.topicRelation !== 'shift') return followUp;
  if (followUp.kind !== 'drilldown') return followUp;
  return {
    ...followUp,
    kind: 'contextual',
    filters: undefined,
    dimensions: undefined,
    priorResultValues: undefined,
    priorMeasures: undefined,
    priorLimit: undefined,
  };
}

export function resolveAgentFollowUpContext(
  rawContext: Record<string, unknown> | undefined,
  question: string,
): AgentFollowUpContext | undefined {
  const context = rawContext as AgentRunRequest['conversationContext'];
  if (!context) return undefined;
  const turns = conversationTurnsFromContext(context);
  const activeTurn = activeConversationTurn(context, turns, question);
  const activeResult = activeTurn?.result && typeof activeTurn.result === 'object' && !Array.isArray(activeTurn.result)
    ? activeTurn.result as Record<string, unknown>
    : undefined;
  const sourceBlockName = cleanOptionalString(activeTurn?.sourceCertifiedBlock) ?? cleanOptionalString(context.sourceCertifiedBlock);
  const priorResultValues = cleanStringRecordArray(activeResult?.dimensionValues) ?? cleanStringRecordArray(context.resultDimensionValues);
  const priorResultColumns = mergeStrings(
    arrayValue(activeResult?.columns),
    context.resultColumns,
    context.outputColumns,
  );
  const priorResultRef = priorResultRefFromTurn(activeTurn, activeResult, priorResultColumns);
  const priorDqlArtifact = cleanDqlArtifactReference(activeTurn?.dqlArtifact) ?? cleanDqlArtifactReference(context.dqlArtifact);
  const resolvedReferences = resolveConversationReferences(question, turns, priorResultValues);
  const focusedPriorResultValues = resolvedReferences.valuesByDimension ?? priorResultValues;
  const hasFocusedReference = Boolean(resolvedReferences.valuesByDimension);
  const relativeComparison = isEntityRelativeComparisonQuestion(question);
  const hasUsefulContext = Boolean(sourceBlockName || priorResultColumns?.length || focusedPriorResultValues || priorDqlArtifact);
  if (!hasUsefulContext) return undefined;
  const inferredKind = resolvedReferences.memberBindings?.length
    ? 'drilldown'
    : isGenericFollowUp(question)
    ? 'generic'
    : isDrilldownFollowUp(question)
      ? 'drilldown'
      : null;
  // Always-on carry: the regexes only CLASSIFY the follow-up kind — they no longer
  // gate whether conversation context exists at all. A question that matches neither
  // pattern still carries the prior turn as advisory 'contextual' state; the model
  // (not a regex) decides whether it's relevant to the new question.
  const kind = inferredKind
    ?? (context.followupKind === 'generic' || context.followupKind === 'drilldown' ? context.followupKind : null)
    ?? 'contextual';
  return {
    kind,
    sourceTurnId: cleanOptionalString(activeTurn?.id) ?? cleanOptionalString(context.sourceAnswerId),
    // A relative comparison needs the named member from history, not the prior
    // block's result contract. Carrying a beverage-ranking block into "less tax
    // than Melissa" biases retrieval toward the same technical artifact and is
    // exactly how the old loop produced a global tax KPI or all customer rows.
    sourceBlockName: relativeComparison ? undefined : sourceBlockName,
    sourceQuestion: relativeComparison
      ? undefined
      : cleanOptionalString(activeTurn?.question) ?? cleanOptionalString(context.sourceQuestion),
    sourceAnswer: relativeComparison
      ? undefined
      : cleanOptionalString(activeTurn?.answerSummary) ?? cleanOptionalString(context.sourceAnswerSummary),
    filters: kind === 'drilldown'
      ? mergeStrings(
          hasFocusedReference ? undefined : activeTurnStringArray(activeTurn, 'requestedFilters'),
          hasFocusedReference ? undefined : context.requestedFilters,
          extractDrilldownFilters(question),
          resolvedReferences.filters,
        )
      : undefined,
    dimensions: kind === 'drilldown'
      ? mergeStrings(
          hasFocusedReference ? undefined : activeTurnStringArray(activeTurn, 'requestedDimensions'),
          hasFocusedReference ? undefined : context.requestedDimensions,
          extractDrilldownDimensions(question),
          resolvedReferences.dimensions,
        )
      : undefined,
    priorResultColumns: relativeComparison ? undefined : priorResultColumns,
    priorResultValues: focusedPriorResultValues,
    priorResultRef: relativeComparison ? undefined : priorResultRef,
    priorDqlArtifact: relativeComparison ? undefined : priorDqlArtifact,
    priorLimit: relativeComparison
      ? undefined
      : activeTurnNumber(activeTurn, 'topN') ?? (typeof context.priorLimit === 'number' ? context.priorLimit : undefined),
    priorMeasures: relativeComparison
      ? undefined
      : mergeStrings(
          activeTurnStringArray(activeTurn, 'requestedMeasures'),
          arrayValue(activeResult?.measureColumns),
          context.priorMeasures,
          inferredMeasuresFromAnswerContract(context.answerContract),
          inferredMeasureColumns(priorResultColumns),
        ),
    memberBindings: resolvedReferences.memberBindings?.map((binding) => ({
      ...binding,
      sourceTurnId: cleanOptionalString(activeTurn?.id) ?? cleanOptionalString(context.sourceAnswerId),
    })),
    resolvedReferences: resolvedReferences.labels,
    unresolvedReferences: resolvedReferences.unresolved,
    // The prior turn's actual rows, so a follow-up can compute across the shown
    // results ("of these, the average") without a fresh query. A relative
    // comparison deliberately drops the prior contract, so skip it there too.
    priorResult: relativeComparison ? undefined : priorResultDataFromTurn(activeResult, priorResultColumns),
  };
}

/** Build the bounded prior-result rows (aligned to columns) for cross-result
 *  follow-up computation, from a turn's persisted result sample. */
function priorResultDataFromTurn(
  activeResult: Record<string, unknown> | undefined,
  columns: string[] | undefined,
): AgentFollowUpContext['priorResult'] {
  if (!activeResult || !columns || columns.length === 0) return undefined;
  const sample = activeResult.rowsSample;
  if (!Array.isArray(sample) || sample.length === 0) return undefined;
  const rows = sample
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => columns.map((_, index) => row[index]));
  if (rows.length === 0) return undefined;
  const measureColumns = (arrayValue(activeResult.measureColumns) ?? [])
    .filter((value): value is string => typeof value === 'string');
  const rowCountRaw = activeResult.rowCount;
  return {
    columns,
    rows,
    ...(measureColumns.length > 0 ? { measureColumns } : {}),
    ...(typeof rowCountRaw === 'number' ? { rowCount: rowCountRaw } : {}),
  };
}

function followUpFromConversationContext(req: AgentRunRequest, question: string): AgentFollowUpContext | undefined {
  return resolveAgentFollowUpContext(req.conversationContext as Record<string, unknown> | undefined, question);
}

function conversationTurnsFromContext(context: AgentRunRequest['conversationContext']): Array<Record<string, unknown>> {
  const explicit = Array.isArray(context?.turns)
    ? context.turns.map(cleanRecord).filter((turn): turn is Record<string, unknown> => Boolean(turn))
    : [];
  const snapshot = conversationSnapshotFromContext(context);
  const snapshotTurns = [
    ...(snapshot?.recalledTurns ?? []).map((turn) => snapshotTurnToConversationRecord(turn, 'recalled')),
    ...(snapshot?.recentTurns ?? []).map((turn) => snapshotTurnToConversationRecord(turn, 'recent')),
  ].filter((turn): turn is Record<string, unknown> => Boolean(turn));
  const merged = mergeConversationTurnRecords([...snapshotTurns, ...explicit]);
  if (merged.length > 0) return merged.slice(-12);
  const legacy = cleanRecord({
    id: context?.sourceAnswerId,
    question: context?.sourceQuestion,
    answerSummary: context?.sourceAnswerSummary,
    sourceCertifiedBlock: context?.sourceCertifiedBlock,
    requestedFilters: context?.requestedFilters,
    requestedDimensions: context?.requestedDimensions,
    requestedMeasures: context?.priorMeasures,
    topN: context?.priorLimit,
    result: {
      columns: context?.resultColumns ?? context?.outputColumns,
      rowsSample: context?.resultRowsSample,
      dimensionValues: context?.resultDimensionValues,
      measureColumns: context?.priorMeasures,
    },
    route: context?.route,
    trustLabel: context?.trustLabel,
    reviewStatus: context?.reviewStatus,
    certification: context?.certification,
    contextPackId: context?.contextPackId,
    sourceSql: (context as Record<string, unknown> | undefined)?.sourceSql,
    dqlArtifact: context?.dqlArtifact,
    cascade: context?.cascade,
  });
  return legacy ? [legacy] : [];
}

function snapshotTurnToConversationRecord(
  turn: ConversationSnapshot['recentTurns'][number],
  snapshotSource: 'recent' | 'recalled',
): Record<string, unknown> | undefined {
  return compactConversationRecord({
    id: turn.id,
    question: turn.question,
    answerSummary: turn.answerSummary,
    sourceCertifiedBlock: turn.sourceCertifiedBlock,
    route: turn.route,
    contextPackId: turn.contextPackId,
    sourceSql: turn.sourceSql,
    dqlArtifact: turn.dqlArtifact,
    cascade: turn.cascade,
    snapshotSource,
    result: compactConversationRecord({
      columns: turn.resultColumns,
      dimensionValues: turn.resultDimensionValues,
      rowCount: turn.resultRowCount,
    }),
  });
}

function mergeConversationTurnRecords(turns: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  const anonymous: Array<Record<string, unknown>> = [];
  for (const turn of turns) {
    const id = cleanOptionalString(turn.id);
    if (!id) {
      anonymous.push(turn);
      continue;
    }
    const current = byId.get(id);
    byId.set(id, current ? { ...current, ...turn } : turn);
  }
  return [...anonymous, ...byId.values()];
}

function activeConversationTurn(
  context: AgentRunRequest['conversationContext'],
  turns: Array<Record<string, unknown>>,
  question: string,
): Record<string, unknown> | undefined {
  if (turns.length === 0) return undefined;
  const activeId = cleanOptionalString(context?.activeTurnId);
  const activeMatch = activeId
    ? turns.find((turn) => cleanOptionalString(turn.id) === activeId)
    : undefined;
  const recalled = turns.filter((turn) => cleanOptionalString(turn.snapshotSource) === 'recalled' && turnHasUsefulResult(turn));
  if (recalled.length > 0) {
    const bestRecalled = recalled
      .map((turn) => ({ turn, score: scoreTurnForQuestion(turn, question) }))
      .sort((a, b) => b.score - a.score)[0];
    const activeScore = activeMatch ? scoreTurnForQuestion(activeMatch, question) : 0;
    if (bestRecalled && shouldPreferRecalledPriorResult(question, bestRecalled.score, activeScore)) {
      return bestRecalled.turn;
    }
  }
  if (activeId) {
    if (activeMatch) return activeMatch;
  }
  return [...turns].reverse().find((turn) => {
    return turnHasUsefulResult(turn);
  }) ?? turns[turns.length - 1];
}

function turnHasUsefulResult(turn: Record<string, unknown>): boolean {
  const result = cleanRecord(turn.result);
  const columns = arrayValue(result?.columns);
  const rows = arrayValue(result?.rowsSample);
  const values = cleanStringRecordArray(result?.dimensionValues);
  return Boolean(columns?.length || rows?.length || values);
}

function scoreTurnForQuestion(turn: Record<string, unknown>, question: string): number {
  const queryTokens = tokenSet(question);
  if (queryTokens.size === 0) return 0;
  const result = cleanRecord(turn.result);
  const values = cleanStringRecordArray(result?.dimensionValues);
  const text = [
    cleanOptionalString(turn.question),
    cleanOptionalString(turn.answerSummary),
    ...(arrayValue(result?.columns) ?? []).map((value) => cleanOptionalString(value)).filter((value): value is string => Boolean(value)),
    ...Object.entries(values ?? {}).flatMap(([key, list]) => [key, ...list.slice(0, 8)]),
  ].filter(Boolean).join(' ');
  let score = 0;
  const turnTokens = tokenSet(text);
  for (const token of queryTokens) {
    if (turnTokens.has(token)) score += 1;
  }
  return score;
}

function shouldPreferRecalledPriorResult(question: string, recalledScore: number, activeScore: number): boolean {
  if (recalledScore >= Math.max(activeScore + 2, 2)) return true;
  if (!wantsPriorResultReference(question)) return false;
  return recalledScore > 0 && recalledScore > activeScore;
}

function wantsPriorResultReference(question: string): boolean {
  return /\b(?:previous|prior|earlier|above)\s+(?:results?|outputs?|rows?|turns?)\b/i.test(question)
    || /\b(?:with|from|using|include)\s+(?:the\s+)?(?:previous|prior|earlier|above)\b/i.test(question);
}

function tokenSet(value: string): Set<string> {
  const tokens = value
    .toLowerCase()
    .match(/[a-z0-9_]+/g) ?? [];
  return new Set(tokens
    .map((token) => token.replace(/s$/, ''))
    .filter((token) => token.length > 2 && !GENERIC_FOLLOW_UP_WORDS.has(token)));
}

function priorResultRefFromTurn(
  activeTurn: Record<string, unknown> | undefined,
  activeResult: Record<string, unknown> | undefined,
  priorResultColumns: string[] | undefined,
): AgentPriorResultReference | undefined {
  const columns = priorResultColumns?.slice(0, 32) ?? [];
  if (columns.length === 0) return undefined;
  const id = cleanOptionalString(activeTurn?.id) ?? 'previous';
  const rowCount = typeof activeResult?.rowCount === 'number' && Number.isFinite(activeResult.rowCount)
    ? activeResult.rowCount
    : Array.isArray(activeResult?.rowsSample)
      ? activeResult.rowsSample.length
      : undefined;
  const sourceSql = cleanOptionalString(activeTurn?.sourceSql);
  return {
    id,
    question: cleanOptionalString(activeTurn?.question),
    columns,
    rowCount,
    sourceSql: sourceSql ? sourceSql.slice(0, 1200) : undefined,
  };
}

function resolveConversationReferences(
  question: string,
  turns: Array<Record<string, unknown>>,
  activeValues: Record<string, string[]> | undefined,
): {
  filters?: string[];
  dimensions?: string[];
  labels?: string[];
  unresolved?: string[];
  valuesByDimension?: Record<string, string[]>;
  memberBindings?: AgentMemberBinding[];
} {
  const namedValues = resolveNamedConversationValues(question, turns, activeValues);
  const dimensions = [
    ...(resolveDeicticDimensions(question, activeValues) ?? []),
    ...Object.keys(namedValues ?? {}).map(normalizePriorValueDimension),
  ];
  let filters = resolveDeicticFilters(question, activeValues) ?? [];
  const labels: string[] = [];
  if (!namedValues && dimensions.length > 0 && filters.length === 0) {
    for (const turn of [...turns].reverse()) {
      const values = cleanStringRecordArray(cleanRecord(turn.result)?.dimensionValues);
      if (!values) continue;
      filters = dimensions.flatMap((dimension) => valuesForPriorDimension(values, dimension));
      if (filters.length > 0) break;
    }
  }
  for (const dimension of dimensions) {
    const values = (namedValues
      ? valuesForPriorDimension(namedValues, dimension)
      : activeValues
        ? valuesForPriorDimension(activeValues, dimension)
        : []).slice(0, 5);
    labels.push(values.length ? `${dimension}: ${values.join(', ')}` : `${dimension}: unresolved`);
  }
  if (namedValues) filters.push(...Object.values(namedValues).flat());
  const questionText = normalizeConversationValueText(question);
  const memberBindings: AgentMemberBinding[] = namedValues
    ? Object.entries(namedValues).map(([dimension, values]) => ({
        dimension: normalizePriorValueDimension(dimension),
        values,
        source: 'prior_result',
        confidence: values.every((value) => (` ${questionText} `).includes(` ${normalizeConversationValueText(value)} `))
          ? 'exact'
          : 'unique_partial',
      }))
    : dimensions.length === 1 && filters.length > 0
      ? [{
          dimension: dimensions[0]!,
          values: Array.from(new Set(filters)).slice(0, 24),
          source: 'prior_result',
          confidence: 'deictic',
        }]
      : [];
  const unresolved = referencesNeedValues(question) && filters.length === 0
    ? ['Could not resolve the referenced prior result values from conversation state.']
    : undefined;
  return {
    filters: filters.length > 0 ? Array.from(new Set(filters)).slice(0, 24) : undefined,
    dimensions: dimensions.length > 0 ? Array.from(new Set(dimensions)) : undefined,
    labels: labels.length > 0 ? Array.from(new Set(labels)) : undefined,
    unresolved,
    valuesByDimension: namedValues,
    memberBindings: memberBindings.length > 0 ? memberBindings : undefined,
  };
}

/**
 * Resolve explicit mentions against bounded values from recent result sets. Full
 * phrases win; otherwise a unique member token may resolve a shortened name
 * ("Melissa" → "Melissa Lopez"). Ambiguous partials are deliberately left for
 * clarification instead of guessing between two real warehouse members.
 */
function resolveNamedConversationValues(
  question: string,
  turns: Array<Record<string, unknown>>,
  activeValues: Record<string, string[]> | undefined,
): Record<string, string[]> | undefined {
  const questionText = normalizeConversationValueText(question);
  const questionTokens = new Set(questionText.split(' ').filter((token) =>
    token.length >= 3 && !GENERIC_FOLLOW_UP_WORDS.has(token)
  ));
  if (!questionText || questionTokens.size === 0) return undefined;

  const candidates = new Map<string, { dimension: string; value: string; exact: boolean }>();
  const addValues = (values: Record<string, string[]> | undefined) => {
    for (const [dimension, members] of Object.entries(values ?? {})) {
      for (const value of members) {
        const normalized = normalizeConversationValueText(value);
        if (!normalized) continue;
        const exact = (` ${questionText} `).includes(` ${normalized} `);
        const memberTokens = normalized.split(' ').filter((token) =>
          token.length >= 3 && !GENERIC_FOLLOW_UP_WORDS.has(token)
        );
        const partial = memberTokens.some((token) => questionTokens.has(token));
        if (!exact && !partial) continue;
        candidates.set(`${dimension}\u0000${normalized}`, { dimension, value, exact });
      }
    }
  };
  addValues(activeValues);
  for (const turn of [...turns].reverse()) {
    addValues(cleanStringRecordArray(cleanRecord(turn.result)?.dimensionValues));
  }

  const all = [...candidates.values()];
  const exact = all.filter((candidate) => candidate.exact);
  const selected = exact.length > 0 ? exact : all;
  const distinctValues = new Set(selected.map((candidate) => normalizeConversationValueText(candidate.value)));
  if (distinctValues.size !== 1) return undefined;

  const out: Record<string, string[]> = {};
  for (const candidate of selected) {
    out[candidate.dimension] = Array.from(new Set([...(out[candidate.dimension] ?? []), candidate.value])).slice(0, 4);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeConversationValueText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9@._'-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function isEntityRelativeComparisonQuestion(question: string): boolean {
  return /\b(?:less|lower|fewer|more|higher|greater)\b[^?.!]{0,80}\bthan\b\s+[a-z0-9@._'-]+/i.test(question)
    || /\b(?:below|under|above|over)\b\s+that\s+of\s+[a-z0-9@._'-]+/i.test(question)
    || /\b(?:below|under|above|over)\b\s+[A-Z][A-Za-z0-9@._'-]+/.test(question);
}

function cleanRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function compactConversationRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(record).filter(([, value]) => value !== undefined && value !== null);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function cleanDqlArtifactReference(value: unknown): AgentDqlArtifactReference | undefined {
  const artifact = normalizeDqlArtifactReference(value);
  if (!artifact) return undefined;
  return {
    ...artifact,
    source: artifact.source.slice(0, 3000),
    metrics: uniqueStringList(artifact.metrics),
    dimensions: uniqueStringList(artifact.dimensions),
    filters: artifact.filters
      ?.filter((filter) => filter.values.length > 0)
      .slice(0, 12)
      .map((filter) => ({ ...filter, values: uniqueStringList(filter.values)?.slice(0, 12) ?? [] })),
    orderBy: artifact.orderBy?.slice(0, 12),
  };
}

function uniqueStringList(value: string[] | undefined): string[] | undefined {
  if (!value?.length) return undefined;
  const unique = Array.from(new Set(value)).slice(0, 24);
  return unique.length > 0 ? unique : undefined;
}

function activeTurnStringArray(turn: Record<string, unknown> | undefined, key: string): unknown[] | undefined {
  return arrayValue(turn?.[key]);
}

function activeTurnNumber(turn: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = turn?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function referencesNeedValues(question: string): boolean {
  return /\b(?:it|its|they|their|them|this|that|these|those|same|above|previous|prior)\b/i.test(question);
}

function extractCertifiedBlockName(content: string): string | undefined {
  const fromAnswer = content.match(/Answered by certified block \*\*([^*]+)\*\*/i)?.[1];
  const fromRoute = content.match(/Answered from certified block\s+([A-Za-z0-9_.-]+)/i)?.[1];
  const fromCitation = content.match(/^- block:\s*([A-Za-z0-9_.-]+)/im)?.[1];
  // The name pattern admits dots, so a sentence period lands in the match
  // ("... block food_vs_drink_revenue.") — strip trailing punctuation.
  return (fromAnswer ?? fromRoute ?? fromCitation)?.trim().replace(/[.,;:]+$/, '') || undefined;
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

function inferredMeasuresFromAnswerContract(value: unknown): string[] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const requestedShape = record.requestedShape && typeof record.requestedShape === 'object' && !Array.isArray(record.requestedShape)
    ? record.requestedShape as Record<string, unknown>
    : undefined;
  return mergeStrings(arrayValue(record.measures), arrayValue(requestedShape?.measures));
}

function inferredMeasureColumns(columns: string[] | undefined): string[] | undefined {
  if (!columns?.length) return undefined;
  const measures = columns.filter((column) =>
    /\b(revenue|sales|amount|total|count|average|avg|sum|spend|cost|margin|profit|value|points?|score|quantity|rate|volume)\b/i.test(
      column.replace(/_/g, ' '),
    )
  );
  return measures.length > 0 ? measures : undefined;
}

function arrayValue(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function cleanStringRecordArray(value: unknown): Record<string, string[]> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const values = Array.isArray(raw)
      ? raw.map(cleanOptionalString).filter((item): item is string => Boolean(item)).slice(0, 24)
      : [];
    if (key.trim() && values.length > 0) out[key.trim()] = values;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function resolveDeicticFilters(question: string, priorValues: Record<string, string[]> | undefined): string[] | undefined {
  if (!priorValues) return undefined;
  const hasExplicitPluralReference = /\b(?:these|those|same)\s+(?:customers?|products?|cat(?:egor|agor|ogor)(?:y|ies)|segments?|regions?)\b/i.test(question);
  if (!hasExplicitPluralReference) {
    const singular = resolveSingularDeicticDimension(question, priorValues);
    if (singular) {
      const values = valuesForPriorDimension(priorValues, singular).slice(0, 1);
      return values.length > 0 ? values : undefined;
    }
  }
  const dims = resolveDeicticDimensions(question, priorValues) ?? [];
  const values = dims.flatMap((dim) => valuesForPriorDimension(priorValues, dim));
  return values.length > 0 ? Array.from(new Set(values)).slice(0, 24) : undefined;
}

function resolveDeicticDimensions(question: string, priorValues: Record<string, string[]> | undefined): string[] | undefined {
  if (!priorValues) return undefined;
  const lower = question.toLowerCase();
  const dims: string[] = [];
  const candidates: Array<[RegExp, string]> = [
    [/\b(?:these|those|the)\s+cat(?:egor|agor|ogor)(?:y|ies)\b/, 'category'],
    [/\b(?:this|that|these|those|the)\s+products?\b/, 'product'],
    [/\b(?:this|that|these|those|the)\s+customers?\b/, 'customer'],
    [/\b(?:above|previous|prior)\s+(?:orders?|results?|rows?)\b/, 'customer'],
    [/\b(?:this|that|these|those|the)\s+segments?\b/, 'segment'],
    [/\b(?:this|that|these|those|the)\s+regions?\b/, 'region'],
  ];
  for (const [pattern, dim] of candidates) {
    if (!pattern.test(lower)) continue;
    if (dim === 'product' && /\bthe\s+product\s+cat(?:egor|agor|ogor)(?:y|ies)\b/.test(lower)) continue;
    if (valuesForPriorDimension(priorValues, dim).length) dims.push(dim);
  }
  // Subject/object pronouns usually refer to people/accounts when paired with
  // purchasing verbs. Resolve that entity before broad object retrieval so a
  // prior customer row does not become a fresh catalog search for "they".
  if (
    dims.length === 0
    && /\b(?:they|their|them)\b[^.?!]{0,48}\b(?:buy|bought|purchase|purchased|order|ordered|spend|spent|use|used)\b/.test(lower)
    && valuesForPriorDimension(priorValues, 'customer').length > 0
  ) dims.push('customer');
  if (dims.length === 0 && /\b(?:it|its|they|their|them|this|these|those|that|same|above|previous|prior)\b/.test(lower)) {
    const single = singlePriorValueDimension(priorValues);
    if (single) dims.push(single);
  }
  return dims.length > 0 ? Array.from(new Set(dims)) : undefined;
}

function resolveSingularDeicticDimension(question: string, priorValues: Record<string, string[]>): string | undefined {
  const lower = question.toLowerCase();
  const candidates: Array<[RegExp, string]> = [
    [/\b(?:this|that|the)\s+product\b/, 'product'],
    [/\b(?:this|that|the)\s+customer\b/, 'customer'],
    [/\b(?:this|that|the)\s+category\b/, 'category'],
    [/\b(?:this|that|the)\s+segment\b/, 'segment'],
    [/\b(?:this|that|the)\s+region\b/, 'region'],
  ];
  for (const [pattern, dim] of candidates) {
    if (pattern.test(lower) && valuesForPriorDimension(priorValues, dim).length) return dim;
  }
  return undefined;
}

function valuesForPriorDimension(values: Record<string, string[]>, dim: string): string[] {
  const aliases = [dim, `${dim}_name`];
  if (dim === 'product') aliases.push('sku');
  if (dim === 'category') aliases.push('product_type', 'category_name');
  return Array.from(new Set(aliases.flatMap((alias) => values[alias] ?? []))).filter(Boolean);
}

function formatResultDimensionValues(value: Record<string, string[]>): string {
  return Object.entries(value)
    .slice(0, 8)
    .map(([key, values]) => `${key}=[${values.slice(0, 8).join(', ')}]`)
    .join('; ');
}

function formatConversationTurnsForPrompt(turns: unknown[]): string {
  return turns
    .map(cleanRecord)
    .filter((turn): turn is Record<string, unknown> => Boolean(turn))
    .slice(-4)
    .map((turn, index) => {
      const result = cleanRecord(turn.result);
      const columns = arrayValue(result?.columns)?.map(cleanOptionalString).filter(Boolean).slice(0, 6) ?? [];
      const values = cleanStringRecordArray(result?.dimensionValues);
      const valueText = values ? formatResultDimensionValues(values) : '';
      const cascade = cleanRecord(turn.cascade);
      const cascadeText = [
        cleanOptionalString(cascade?.terminalLane),
        cleanOptionalString(cascade?.routeTier),
      ].filter(Boolean).join('/');
      return [
        `${index + 1}. ${cleanOptionalString(turn.question) ?? 'prior turn'}`,
        cascadeText ? `cascade=${cascadeText}` : '',
        cleanOptionalString(turn.answerSummary) ? `summary=${cleanOptionalString(turn.answerSummary)}` : '',
        columns.length ? `columns=${columns.join(', ')}` : '',
        valueText ? `values=${valueText}` : '',
      ].filter(Boolean).join(' | ');
    })
    .join('\n');
}

function singlePriorValueDimension(priorValues: Record<string, string[]>): string | undefined {
  const dims = Array.from(new Set(Object.keys(priorValues).map(normalizePriorValueDimension).filter(Boolean)));
  return dims.length === 1 ? dims[0] : undefined;
}

function normalizePriorValueDimension(value: string): string {
  const lower = value.toLowerCase();
  if (lower.includes('category')) return 'category';
  if (lower.includes('product')) return 'product';
  if (lower.includes('customer')) return 'customer';
  if (lower.includes('account')) return 'account';
  if (lower.includes('user')) return 'user';
  if (lower.includes('region')) return 'region';
  if (lower.includes('segment')) return 'segment';
  if (lower.includes('channel')) return 'channel';
  return lower.replace(/[_\s-]+name$/, '').replace(/[^a-z0-9_ -]+/g, '').trim();
}

export const __test__ = {
  applyTopicShiftGuard,
  buildAnswerLoopTools,
  createCertifiedFitConfirmation,
  followUpFromConversationContext,
  inferFollowUpContext,
  formatCascadeOutcome,
  parseCertifiedFitConfirmation,
  rewriteFollowUpQuestion,
  shouldLoadSchemaContext,
  shouldSearchProjectFiles,
  renderProjectSourceSearch,
};

const GENERIC_FOLLOW_UP_WORDS = new Set([
  'a', 'about', 'again', 'all', 'also', 'and', 'are', 'as', 'be', 'block', 'can', 'could', 'data', 'did', 'do', 'does',
  'execute', 'for', 'from', 'get', 'give', 'import', 'it', 'its', 'let', 'lets', 'me', 'metrics',
  'more', 'now', 'of', 'output', 'please', 'result', 'results', 'run', 'show', 'solution', 'summary',
  'that', 'the', 'them', 'this', 'to', 'use', 'was', 'were', 'what', 'when', 'where', 'which', 'who',
  'why', 'with', 'you',
]);

function isGenericFollowUp(question: string): boolean {
  const lower = question.toLowerCase();
  if (/\b(?:combine|merge|join|final|summari[sz]e)\b/.test(lower) && /\b(?:previous|prior|above|these|those|results?|outputs?|turns?)\b/.test(lower)) {
    return true;
  }
  if (!/\b(block|data|execute|import|it|result|results|run|solution|that|this)\b/.test(lower)) return false;
  const tokens = lower.match(/[a-z0-9_]+/g) ?? [];
  const meaningful = tokens.filter((token) => token.length > 1 && !GENERIC_FOLLOW_UP_WORDS.has(token));
  return meaningful.length === 0;
}

function isDrilldownFollowUp(question: string): boolean {
  const lower = question.toLowerCase();
  const deicticDrilldown = /\b(?:this|that|these|those|same|above|previous|prior)\s+(?:amount|value|orders?|results?|rows?|customers?|products?|cat(?:egor|agor|ogor)(?:y|ies)|segments?|regions?)\b/.test(lower)
    || /\b(?:they|their|them)\b/.test(lower);
  return /\b(drill|break\s*down|slice|segment|filter|compare|split|why|changed?|change|driver|root cause|increase|decrease|drop|spike|variance|by|for|only|where|last week|this week|last month|this month|enterprise|regions?|customers?|channels?|products?|category|categories|catagor(?:y|ies)|catogor(?:y|ies))\b/.test(lower)
    && (deicticDrilldown || !/\b(what is|what are|define|definition|meaning of)\b/.test(lower));
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
  for (const dim of ['segment', 'region', 'customer', 'channel', 'product', 'category', 'week', 'month']) {
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
  const cascade = formatCascadeOutcome(result.cascade);
  const cascadeLine = cascade ? `\nCascade: ${cascade}` : '';
  const resultPreview = formatResultPreview(result.result);
  const dql = result.dqlArtifact?.source?.trim()
    ? `\n\nDQL Artifact (${result.dqlArtifact.kind}):\n\`\`\`dql\n${result.dqlArtifact.source.trim()}\n\`\`\``
    : '';
  const sql = result.proposedSql ? `\n\nCompiled SQL preview:\n\`\`\`sql\n${result.proposedSql}\n\`\`\`` : '';
  return `[${badge}]${cascadeLine}\n\n${result.text}${resultPreview}${citations}${dql}${sql}`;
}

function formatCascadeOutcome(cascade: AgentAnswer['cascade']): string | undefined {
  if (!cascade?.terminalLane && !cascade?.routeTier) return undefined;
  const lane = formatCascadeLane(cascade.terminalLane);
  const tier = formatCascadeTier(cascade.routeTier);
  return [lane, tier].filter(Boolean).join(' · ') || undefined;
}

function formatCascadeLane(value?: string): string | undefined {
  switch (value) {
    case 'certified':
      return 'Lane 1 certified';
    case 'semantic':
      return 'Lane 2 semantic';
    case 'generated':
      return 'Lane 3 generated';
    case 'refusal':
      return 'Lane 4 refusal';
    default:
      return value ? formatLabel(value) : undefined;
  }
}

function formatCascadeTier(value?: string): string | undefined {
  switch (value) {
    case 'certified_block':
      return 'Certified block';
    case 'semantic_metric':
      return 'Semantic metric';
    case 'generated_sql':
      return 'Generated SQL';
    case 'business_context':
      return 'Business context';
    case 'no_answer':
      return 'No answer';
    default:
      return value ? formatLabel(value) : undefined;
  }
}

function formatLabel(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
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
  const dqlArtifact = result.dqlArtifact;
  const semanticArtifact = dqlArtifact?.kind === 'semantic_block' ? dqlArtifact : undefined;
  const proposal: BlockProposal = {
    name: slugify(question).slice(0, 56) || 'ai_generated_analysis',
    domain: inferProposalDomain(result) ?? '',
    owner: `${process.env.USER ?? 'analyst'}@local`,
    description: result.text.slice(0, 240),
    sql: result.proposedSql!,
    blockType: semanticArtifact ? 'semantic' : 'custom',
    ...(dqlArtifact
      ? {
          dqlSource: dqlArtifact.source,
        }
      : {}),
    ...(semanticArtifact
      ? {
          metrics: semanticArtifact.metrics,
          dimensions: semanticArtifact.dimensions,
          ...(semanticArtifact.filters ? { filters: semanticArtifact.filters } : {}),
          ...(semanticArtifact.timeDimension ? { timeDimension: semanticArtifact.timeDimension } : {}),
        }
      : {}),
    tags: [
      'ai-generated',
      'needs-review',
      semanticArtifact ? 'semantic' : result.sourceTier ?? 'dbt_manifest',
      ...(isDrilldown ? ['drilldown'] : []),
    ],
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
