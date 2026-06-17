import React, { useMemo, useRef, useState } from 'react';
import { Bot, CheckCircle2, Send, Sparkles, X } from 'lucide-react';
import { runAgent } from '../../llm/client';
import type { AgentTurn, BlockProposal } from '../../llm/types';
import { themes, type Theme, type ThemeMode } from '../../themes/notebook-theme';
import { StructuredAnswerText, extractGovernedAnswer, type AgentAnswerEnvelope } from './AgentAnswerCard';

type AiSqlMode = 'notebook' | 'block';

export interface AiSqlDraftMeta {
  question: string;
  title?: string;
  description?: string;
  domain?: string;
  owner?: string;
  tags?: string[];
  answer?: AgentAnswerEnvelope | null;
  blockSource?: string;
}

interface AiSqlDraftDialogProps {
  mode: AiSqlMode;
  themeMode: ThemeMode;
  contextLabel?: string;
  upstreamSql?: string;
  initialPrompt?: string;
  onClose: () => void;
  onInsertSql: (sql: string, meta: AiSqlDraftMeta) => void;
  onCreateBlock?: (sql: string, meta: AiSqlDraftMeta) => void;
}

export function AiSqlDraftDialog({
  mode,
  themeMode,
  contextLabel,
  upstreamSql,
  initialPrompt,
  onClose,
  onInsertSql,
  onCreateBlock,
}: AiSqlDraftDialogProps) {
  const t = themes[themeMode];
  const [question, setQuestion] = useState(initialPrompt ?? '');
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<AgentTurn[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<BlockProposal | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const answer = useMemo(() => extractGovernedAnswer(events), [events]);
  const sql = extractSqlDraft(answer, proposal, text);
  const blockMeta = buildBlockDraftMeta(question, answer, proposal, sql, text);
  const title = blockMeta.title;
  const isBlockMode = mode === 'block';
  const previewText = isBlockMode ? blockMeta.blockSource : sql;
  const canCreateBlock = Boolean(onCreateBlock && sql && !running);

  const generate = async () => {
    const trimmed = question.trim();
    if (!trimmed || running) return;
    setRunning(true);
    setEvents([]);
    setText('');
    setError(null);
    setProposal(null);
    const controller = new AbortController();
    abortRef.current = controller;
    const collected: AgentTurn[] = [];
    let output = '';
    try {
      await runAgent(
        {
          messages: [{ role: 'user', content: buildSqlDraftPrompt(trimmed, mode) }],
          upstream: upstreamSql?.trim() ? { cellId: `ai-sql:${mode}`, sql: upstreamSql } : undefined,
          signal: controller.signal,
        },
        (turn) => {
          collected.push(turn);
          setEvents([...collected]);
          if (turn.kind === 'text') {
            output += turn.text;
            setText(output);
          }
          if (turn.kind === 'proposal') setProposal(turn.proposal);
          if (turn.kind === 'error') setError(turn.message);
        },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const insert = () => {
    if (!sql) return;
    onInsertSql(sql, blockMeta);
  };

  const createBlock = () => {
    if (!sql || !onCreateBlock) return;
    onCreateBlock(sql, blockMeta);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={mode === 'block' ? 'Ask AI for block SQL' : 'Ask AI for notebook SQL'}
      style={overlayStyle}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div style={dialogStyle(t)}>
        <div style={headerStyle(t)}>
          <div style={iconWrapStyle(t)}><Bot size={17} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: t.textPrimary }}>
              {isBlockMode ? 'Build DQL block with AI' : 'Build SQL with AI'}
            </div>
            <div style={{ fontSize: 12, color: t.textSecondary, marginTop: 2 }}>
              Metadata, dbt, certified blocks, and schema first. Generated work stays review-required.
            </div>
          </div>
          <button type="button" onClick={onClose} title="Close" style={iconButtonStyle(t)}><X size={15} /></button>
        </div>

        <div style={bodyStyle}>
          <label style={labelStyle(t)}>
            Question
            <textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder={isBlockMode ? 'Example: build a top 10 players by points per game block' : 'Example: show monthly revenue by customer type'}
              rows={4}
              style={textareaStyle(t)}
              autoFocus
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void generate();
                }
              }}
            />
          </label>

          <div style={suggestionRowStyle}>
            {starterPrompts(mode).map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={() => setQuestion(prompt)}
                style={suggestionStyle(t)}
              >
                <Sparkles size={12} /> {prompt}
              </button>
            ))}
          </div>

          <div style={contextStyle(t)}>
            <span>{contextLabel ?? (mode === 'block' ? 'Block Studio' : 'Notebook')}</span>
            <b>{upstreamSql?.trim() ? 'Current SQL context included' : 'Project metadata and runtime schema'}</b>
          </div>

          {events.length > 0 || text || error ? (
            <div style={resultShellStyle(t)}>
              <div style={resultHeadStyle(t)}>
                <span>{running ? (isBlockMode ? 'Drafting block' : 'Drafting SQL') : previewText ? (isBlockMode ? 'Block draft ready' : 'SQL draft ready') : 'AI response'}</span>
                {answer?.certification && <b>{formatLabel(answer.certification)}</b>}
              </div>
              {error && <div style={errorStyle}>{error}</div>}
              {answer?.text || answer?.answer ? (
                <div style={summaryStyle(t)}><StructuredAnswerText text={answer.answer ?? answer.text ?? ''} t={t} compact /></div>
              ) : text ? (
                <div style={summaryStyle(t)}><StructuredAnswerText text={stripSqlBlock(text)} t={t} compact /></div>
              ) : null}
              {previewText ? (
                <pre style={sqlPreviewStyle(t)}>{previewText}</pre>
              ) : (
                <div style={emptySqlStyle(t)}>
                  {running ? (isBlockMode ? 'Waiting for the agent to produce a block...' : 'Waiting for the agent to produce SQL...') : 'No SQL was returned. Add more schema context or ask for a specific metric/table grain.'}
                </div>
              )}
              {events.some((event) => event.kind === 'thinking') && (
                <div style={eventListStyle(t)}>
                  {events
                    .filter((event): event is Extract<AgentTurn, { kind: 'thinking' }> => event.kind === 'thinking')
                    .slice(-3)
                    .map((event, index) => <span key={`${event.text}-${index}`}>{event.text}</span>)}
                </div>
              )}
            </div>
          ) : null}
        </div>

        <div style={footerStyle(t)}>
          <span style={{ fontSize: 11, color: t.textMuted }}>
            {isBlockMode ? 'Use this as a draft block. Run, test, save, then certify.' : 'Use this as a draft. Run, review joins/grain, then save as a block when ready.'}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={onClose} style={secondaryButtonStyle(t)}>Cancel</button>
            {running ? (
              <button type="button" onClick={() => abortRef.current?.abort()} style={secondaryButtonStyle(t)}>
                Stop
              </button>
            ) : (
              <button type="button" onClick={() => void generate()} disabled={!question.trim()} style={primaryButtonStyle(t, Boolean(question.trim()))}>
                <Send size={13} /> {isBlockMode ? 'Generate block' : 'Generate SQL'}
              </button>
            )}
            {!isBlockMode && onCreateBlock && (
              <button type="button" onClick={createBlock} disabled={!canCreateBlock} style={secondaryActionButtonStyle(t, canCreateBlock)}>
                <CheckCircle2 size={13} /> Create block
              </button>
            )}
            <button type="button" onClick={insert} disabled={!sql || running} style={insertButtonStyle(t, Boolean(sql) && !running)}>
              <CheckCircle2 size={13} /> {isBlockMode ? 'Use draft block' : 'Insert SQL cell'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function buildSqlDraftPrompt(question: string, mode: AiSqlMode): string {
  if (mode === 'block') {
    return [
      'Create a complete review-required DQL block for Block Studio.',
      'Use certified DQL blocks, business views, terms, dbt manifest metadata, semantic objects, and runtime schema before guessing.',
      'If a certified block exactly matches, cite or adapt it, but return a new review-required draft only when the user is asking to build new analysis.',
      'The block must include: block name, domain, type = "custom", status = "draft", description, owner, tags, query, visualization, and at least one simple tests block.',
      'The query must be one read-only SELECT/WITH statement with a bounded result size.',
      'Do not generate INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, COPY, MERGE, TRUNCATE, or CALL statements.',
      'Return a short business summary, then exactly one fenced dql block. Put the SQL inside query = """ ... """.',
      '',
      `User request: ${question}`,
    ].join('\n');
  }
  const surface = 'notebook SQL cell';
  return [
    `Create review-required SQL for a ${surface}.`,
    'Use certified DQL blocks, business views, terms, dbt manifest metadata, semantic objects, and runtime schema before guessing.',
    'If a certified block exactly matches, you may reuse its SQL or cite it, but still return runnable SQL for this authoring surface.',
    'If the requested grain needs new analysis, generate a single read-only SELECT/WITH query with bounded result size.',
    'Do not generate INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, COPY, MERGE, TRUNCATE, or CALL statements.',
    'Return a short business summary, then one fenced sql block, and mark the result as AI-generated/review-required.',
    '',
    `User question: ${question}`,
  ].join('\n');
}

function buildBlockDraftMeta(
  question: string,
  answer: AgentAnswerEnvelope | null,
  proposal: BlockProposal | null,
  sql: string,
  text: string,
): AiSqlDraftMeta {
  const title = proposal?.name ?? answer?.block?.name ?? answer?.result?.blockName ?? titleFromQuestion(question);
  const description = proposal?.description
    ?? answer?.answer
    ?? answer?.text
    ?? `AI-generated draft for: ${question.trim() || title}`;
  const domain = proposal?.domain ?? answer?.block?.domain ?? inferDomain(question);
  const owner = proposal?.owner ?? answer?.evidence?.outcome?.owner ?? 'analytics';
  const tags = uniqueList([...(proposal?.tags ?? []), 'ai-generated', 'review-required']);
  const blockSource = extractBlockDraft(text) || buildDqlBlockSource({
    name: title,
    domain,
    owner,
    description,
    tags,
    sql,
  });
  return {
    question: question.trim(),
    title,
    description: firstSentence(description),
    domain,
    owner,
    tags,
    answer,
    blockSource,
  };
}

function extractSqlDraft(answer: AgentAnswerEnvelope | null, proposal: BlockProposal | null, text: string): string {
  const sql = firstNonEmpty([
    answer?.proposedSql,
    answer?.sql,
    answer?.result?.sql,
    answer?.analysisPlan?.sql,
    proposal?.sql,
    extractQueryFromBlock(extractBlockDraft(text)),
    extractFencedSql(text),
  ]);
  return cleanSql(sql);
}

function extractBlockDraft(text: string): string {
  const fenced = text.match(/```(?:dql|ddl|dqld)\s*([\s\S]*?)```/i);
  if (fenced?.[1] && /^\s*block\s+"/i.test(fenced[1].trim())) return fenced[1].trim();
  const generic = text.match(/```\s*([\s\S]*?)```/);
  if (generic?.[1] && /^\s*block\s+"/i.test(generic[1].trim())) return generic[1].trim();
  const start = text.search(/^\s*block\s+"/im);
  if (start < 0) return '';
  const body = text.slice(start).trim();
  const end = body.lastIndexOf('}');
  return end >= 0 ? body.slice(0, end + 1).trim() : body;
}

function extractFencedSql(text: string): string {
  const sqlMatch = text.match(/```sql\s*([\s\S]*?)```/i);
  if (sqlMatch?.[1]) return sqlMatch[1];
  const genericMatch = text.match(/```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/);
  const body = genericMatch?.[1]?.trim() ?? '';
  if (!body || /^\s*block\s+"/i.test(body)) return '';
  if (/^\s*(select|with)\b/i.test(body)) return body;
  return '';
}

function cleanSql(sql?: string): string {
  return String(sql ?? '').trim().replace(/;\s*$/, '');
}

function firstNonEmpty(values: Array<string | undefined | null>): string {
  return values.find((value) => Boolean(value?.trim())) ?? '';
}

function extractQueryFromBlock(blockSource: string): string {
  return blockSource.match(/query\s*=\s*"""([\s\S]*?)"""/i)?.[1]?.trim() ?? '';
}

function stripSqlBlock(text: string): string {
  return text.replace(/```(?:sql|dql|ddl|dqld)?[\s\S]*?```/gi, '').trim();
}

function starterPrompts(mode: AiSqlMode): string[] {
  return mode === 'block'
    ? ['Top customers by revenue', 'Monthly trend by segment', 'Data quality availability check']
    : ['Build a trend query', 'Break this down by segment', 'Show top movers'];
}

function titleFromQuestion(question: string): string {
  const words = question
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => !/^(show|build|create|make|give|me|the|a|an|by|for|with)$/i.test(word))
    .slice(0, 8);
  const title = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
  return title || 'AI SQL Draft';
}

function formatLabel(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function buildDqlBlockSource(options: {
  name: string;
  domain: string;
  owner: string;
  description: string;
  tags: string[];
  sql: string;
}): string {
  const sql = cleanSql(options.sql) || 'SELECT 1 AS value';
  const tags = uniqueList(options.tags.length > 0 ? options.tags : ['ai-generated', 'review-required']);
  return [
    `block "${escapeDql(options.name)}" {`,
    `  domain = "${escapeDql(options.domain || 'analytics')}"`,
    '  type = "custom"',
    '  status = "draft"',
    `  description = "${escapeDql(firstSentence(options.description) || options.name)}"`,
    `  owner = "${escapeDql(options.owner || 'analytics')}"`,
    `  tags = [${tags.map((tag) => `"${escapeDql(tag)}"`).join(', ')}]`,
    '',
    '  query = """',
    indentSql(sql, '    '),
    '  """',
    '',
    '  visualization {',
    '    chart = "table"',
    '  }',
    '',
    '  tests {',
    '    assert row_count > 0',
    '  }',
    '}',
  ].join('\n');
}

function inferDomain(question: string): string {
  const lower = question.toLowerCase();
  if (/\b(player|goal|assist|defense|nba|game|team|scoring)\b/.test(lower)) return 'nba';
  if (/\b(customer|account|segment)\b/.test(lower)) return 'customer';
  if (/\b(revenue|sales|arr|booking)\b/.test(lower)) return 'revenue';
  return 'analytics';
}

function firstSentence(value: string): string {
  return value.replace(/\s+/g, ' ').split(/(?<=[.!?])\s/)[0]?.slice(0, 220).trim() || '';
}

function uniqueList(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function escapeDql(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function indentSql(sql: string, indent: string): string {
  return sql.split('\n').map((line) => `${indent}${line}`).join('\n');
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1400,
  background: 'rgba(0,0,0,0.34)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
};

const bodyStyle: React.CSSProperties = {
  padding: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  minHeight: 0,
  overflow: 'auto',
};

const suggestionRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
};

function dialogStyle(t: Theme): React.CSSProperties {
  return {
    width: 'min(780px, calc(100vw - 48px))',
    maxHeight: 'min(760px, calc(100vh - 48px))',
    background: t.modalBg,
    color: t.textPrimary,
    border: `1px solid ${t.cellBorder}`,
    borderRadius: 12,
    boxShadow: '0 22px 70px rgba(0,0,0,0.35)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    fontFamily: t.font,
  };
}

function headerStyle(t: Theme): React.CSSProperties {
  return {
    display: 'flex',
    gap: 10,
    alignItems: 'center',
    padding: '14px 16px',
    borderBottom: `1px solid ${t.headerBorder}`,
  };
}

function iconWrapStyle(t: Theme): React.CSSProperties {
  return {
    width: 34,
    height: 34,
    borderRadius: 9,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: t.accent,
    background: `${t.accent}16`,
    border: `1px solid ${t.accent}36`,
    flex: '0 0 auto',
  };
}

function iconButtonStyle(t: Theme): React.CSSProperties {
  return {
    width: 30,
    height: 30,
    border: `1px solid ${t.headerBorder}`,
    borderRadius: 7,
    background: t.appBg,
    color: t.textSecondary,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  };
}

function labelStyle(t: Theme): React.CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: 7,
    color: t.textSecondary,
    fontSize: 12,
    fontWeight: 700,
  };
}

function textareaStyle(t: Theme): React.CSSProperties {
  return {
    resize: 'vertical',
    minHeight: 88,
    border: `1px solid ${t.cellBorder}`,
    borderRadius: 8,
    background: t.editorBg,
    color: t.textPrimary,
    fontFamily: t.font,
    fontSize: 13,
    lineHeight: 1.45,
    padding: 10,
    outline: 'none',
  };
}

function suggestionStyle(t: Theme): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    border: `1px solid ${t.headerBorder}`,
    borderRadius: 999,
    background: t.appBg,
    color: t.textSecondary,
    cursor: 'pointer',
    padding: '5px 9px',
    fontSize: 11,
    fontFamily: t.font,
  };
}

function contextStyle(t: Theme): React.CSSProperties {
  return {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 10,
    padding: '8px 10px',
    borderRadius: 8,
    background: `${t.accent}0d`,
    border: `1px solid ${t.headerBorder}`,
    color: t.textMuted,
    fontSize: 11,
  };
}

function resultShellStyle(t: Theme): React.CSSProperties {
  return {
    border: `1px solid ${t.cellBorder}`,
    borderRadius: 10,
    background: t.cellBg,
    overflow: 'hidden',
  };
}

function resultHeadStyle(t: Theme): React.CSSProperties {
  return {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 10,
    padding: '8px 10px',
    borderBottom: `1px solid ${t.headerBorder}`,
    color: t.textSecondary,
    fontSize: 11,
    fontWeight: 800,
    textTransform: 'uppercase',
  };
}

function summaryStyle(t: Theme): React.CSSProperties {
  return {
    padding: '10px 12px',
    color: t.textSecondary,
    fontSize: 12,
    lineHeight: 1.5,
  };
}

function sqlPreviewStyle(t: Theme): React.CSSProperties {
  return {
    margin: 0,
    maxHeight: 280,
    overflow: 'auto',
    padding: 12,
    background: t.editorBg,
    borderTop: `1px solid ${t.headerBorder}`,
    color: t.textPrimary,
    fontFamily: t.fontMono,
    fontSize: 12,
    lineHeight: 1.5,
    whiteSpace: 'pre',
  };
}

function emptySqlStyle(t: Theme): React.CSSProperties {
  return {
    padding: 12,
    color: t.textMuted,
    fontSize: 12,
    borderTop: `1px solid ${t.headerBorder}`,
  };
}

function eventListStyle(t: Theme): React.CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '9px 12px',
    borderTop: `1px solid ${t.headerBorder}`,
    color: t.textMuted,
    fontSize: 11,
  };
}

function footerStyle(t: Theme): React.CSSProperties {
  return {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    alignItems: 'center',
    padding: '12px 16px',
    borderTop: `1px solid ${t.headerBorder}`,
    background: t.appBg,
    flexWrap: 'wrap',
  };
}

function secondaryButtonStyle(t: Theme): React.CSSProperties {
  return {
    border: `1px solid ${t.headerBorder}`,
    borderRadius: 7,
    background: t.cellBg,
    color: t.textSecondary,
    cursor: 'pointer',
    padding: '7px 11px',
    fontSize: 12,
    fontFamily: t.font,
  };
}

function primaryButtonStyle(t: Theme, enabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    border: `1px solid ${enabled ? t.accent : t.headerBorder}`,
    borderRadius: 7,
    background: enabled ? `${t.accent}20` : t.cellBg,
    color: enabled ? t.accent : t.textMuted,
    cursor: enabled ? 'pointer' : 'not-allowed',
    padding: '7px 11px',
    fontSize: 12,
    fontFamily: t.font,
  };
}

function secondaryActionButtonStyle(t: Theme, enabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    border: `1px solid ${enabled ? t.accent : t.headerBorder}`,
    borderRadius: 7,
    background: enabled ? t.cellBg : `${t.cellBg}88`,
    color: enabled ? t.accent : t.textMuted,
    cursor: enabled ? 'pointer' : 'not-allowed',
    padding: '7px 11px',
    fontSize: 12,
    fontFamily: t.font,
  };
}

function insertButtonStyle(t: Theme, enabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    border: `1px solid ${enabled ? '#3fb950' : t.headerBorder}`,
    borderRadius: 7,
    background: enabled ? '#3fb95018' : t.cellBg,
    color: enabled ? '#238636' : t.textMuted,
    cursor: enabled ? 'pointer' : 'not-allowed',
    padding: '7px 11px',
    fontSize: 12,
    fontFamily: t.font,
  };
}

const errorStyle: React.CSSProperties = {
  margin: 10,
  padding: '7px 9px',
  borderRadius: 6,
  background: '#ff7b7218',
  color: '#ff7b72',
  fontSize: 12,
};
