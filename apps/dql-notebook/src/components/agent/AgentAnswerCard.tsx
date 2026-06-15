import React, { useState } from 'react';
import type { AgentTurn } from '../../llm/types';
import type { CellChartConfig, QueryResult } from '../../store/types';
import { themes, type Theme, type ThemeMode } from '../../themes/notebook-theme';
import { api } from '../../api/client';
import { ChartOutput, resolveChartType } from '../output/ChartOutput';
import { TableOutput } from '../output/TableOutput';

type AnswerTab = 'answer' | 'visual' | 'data' | 'lineage' | 'context' | 'sql' | 'review';
type AddToAppMode = 'auto' | 'chart' | 'data' | 'both';

interface EvidenceRouteStep {
  tool?: string;
  status?: string;
  label?: string;
  detail?: string;
}

interface EvidenceAsset {
  nodeId?: string;
  kind?: string;
  name?: string;
  description?: string;
  sourceTier?: string;
  certification?: string;
  provenance?: string;
  sourcePath?: string;
  owner?: string;
  domain?: string;
  status?: string;
  role?: string;
}

interface EvidenceContextItem {
  label?: string;
  value?: string;
  source?: string;
}

interface AgentEvidence {
  route?: EvidenceRouteStep[];
  lineage?: EvidenceAsset[];
  businessContext?: EvidenceContextItem[];
  analysisPlan?: AgentAnalysisPlan;
  outcome?: {
    name?: string;
    owner?: string;
    decisionUse?: string;
    reviewCadence?: string;
    caveats?: string[];
  };
  selectedAssets?: EvidenceAsset[];
  sourceTables?: EvidenceAsset[];
  semanticObjects?: EvidenceAsset[];
  validation?: {
    status?: string;
    message?: string;
  };
  execution?: {
    status?: string;
    message?: string;
    rowCount?: number;
    executionTime?: number;
  };
  citations?: Array<{ kind?: string; name?: string; provenance?: string }>;
}

interface AgentAnalysisPlan {
  question?: string;
  intent?: string;
  routeReason?: string;
  grain?: string;
  measures?: string[];
  dimensions?: string[];
  candidateTables?: Array<{ relation?: string; columns?: string[]; reason?: string }>;
  trustedContext?: Array<{ kind?: string; name?: string; certification?: string; sourceTier?: string }>;
  assumptions?: string[];
  sql?: string;
  suggestedViz?: string;
  followUps?: string[];
  repairAttempts?: number;
}

export interface AgentAnswerEnvelope {
  kind: 'certified' | 'uncertified' | 'no_answer';
  sourceTier?: string;
  certification?: string;
  reviewStatus?: string;
  confidence?: number;
  text?: string;
  answer?: string;
  sql?: string;
  proposedSql?: string;
  suggestedViz?: string;
  block?: { name?: string; sourcePath?: string; status?: string; domain?: string };
  result?: {
    columns?: unknown[];
    rows?: unknown[];
    rowCount?: number;
    executionTime?: number;
    chartConfig?: unknown;
    sql?: string;
    blockName?: string;
    blockPath?: string;
  };
  citations?: Array<{ kind?: string; name?: string; provenance?: string }>;
  evidence?: AgentEvidence;
  analysisPlan?: AgentAnalysisPlan;
}

export function extractGovernedAnswer(events: AgentTurn[]): AgentAnswerEnvelope | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind !== 'tool_result' || event.id !== 'governed_answer') continue;
    const output = event.output;
    if (output && typeof output === 'object' && 'kind' in output) return output as AgentAnswerEnvelope;
  }
  return null;
}

function normalizeAgentResult(answer: AgentAnswerEnvelope): QueryResult | null {
  const result = answer.result;
  if (!result || !Array.isArray(result.rows)) return null;
  const rawColumns = Array.isArray(result.columns) ? result.columns : [];
  const columns = rawColumns.map((column) => {
    if (typeof column === 'string') return column;
    if (column && typeof column === 'object' && typeof (column as { name?: unknown }).name === 'string') {
      return String((column as { name: unknown }).name);
    }
    return String(column);
  });
  const rows = result.rows
    .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object' && !Array.isArray(row)))
    .map((row) => row);
  return {
    columns,
    rows,
    rowCount: typeof result.rowCount === 'number' ? result.rowCount : rows.length,
    executionTime: result.executionTime,
  };
}

function normalizeChartConfig(config: unknown, answer: AgentAnswerEnvelope): CellChartConfig | undefined {
  const raw = (config && typeof config === 'object' ? config : {}) as Record<string, unknown>;
  const chart = typeof raw.chart === 'string'
    ? raw.chart
    : typeof answer.suggestedViz === 'string'
      ? answer.suggestedViz
      : undefined;
  return {
    ...(chart ? { chart } : {}),
    ...(typeof raw.x === 'string' ? { x: raw.x } : {}),
    ...(typeof raw.y === 'string' ? { y: raw.y } : {}),
    ...(typeof raw.color === 'string' ? { color: raw.color } : {}),
    ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
  };
}

export function AgentAnswerCard({
  answer,
  themeMode,
  showSql = true,
  compact = false,
  addToAppTarget,
}: {
  answer: AgentAnswerEnvelope;
  themeMode: ThemeMode;
  showSql?: boolean;
  compact?: boolean;
  addToAppTarget?: { appId: string; dashboardId: string };
}) {
  const t = themes[themeMode];
  const result = normalizeAgentResult(answer);
  const chartConfig = normalizeChartConfig(answer.result?.chartConfig, answer);
  const hasChart = Boolean(result && resolveChartType(result, chartConfig) !== 'table');
  const sql = showSql ? answer.sql ?? answer.result?.sql ?? answer.proposedSql : undefined;
  const blockPath = answer.result?.blockPath ?? answer.block?.sourcePath;
  const hasSqlPanel = Boolean(sql || (showSql && blockPath));
  const hasEvidence = Boolean(answer.evidence);
  const [tab, setTab] = useState<AnswerTab>('answer');
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const badge = answer.certification === 'certified'
    ? 'Certified'
    : answer.kind === 'no_answer'
      ? 'No answer'
      : 'AI generated / needs review';
  const badgeColor = answer.certification === 'certified' ? '#3fb950' : answer.kind === 'no_answer' ? '#ff7b72' : '#f0883e';
  const summary = (answer.answer ?? answer.text ?? '').replace(/\n\n_Question:_[\s\S]*$/m, '').trim();
  const analysisPlan = answer.analysisPlan ?? answer.evidence?.analysisPlan;
  const blockName = answer.result?.blockName ?? answer.block?.name ?? answer.citations?.find((c) => c.kind === 'block')?.name;
  const [adding, setAdding] = useState(false);
  const [addMessage, setAddMessage] = useState<string | null>(null);
  const canAddToApp = Boolean(addToAppTarget && (result || sql || summary || blockName));
  const addToApp = async (mode: AddToAppMode = 'auto') => {
    if (!addToAppTarget) return;
    const selectedModes: Array<'chart' | 'data'> = mode === 'both'
      ? ['chart', 'data']
      : mode === 'data'
        ? ['data']
        : mode === 'chart'
          ? ['chart']
          : result
            ? [hasChart ? 'chart' : 'data']
            : [];
    setAdding(true);
    setAddMenuOpen(false);
    setAddMessage(null);
    try {
      if (answer.certification === 'certified' && blockName) {
        const doc = await api.getDashboard(addToAppTarget.appId, addToAppTarget.dashboardId);
        if (!doc) throw new Error('Dashboard could not be loaded.');
        const nextItems = [...doc.dashboard.layout.items];
        const modesToAdd = selectedModes.length > 0 ? selectedModes : ['chart'];
        for (const tileMode of modesToAdd) {
          const tileBase = modesToAdd.length > 1 ? `${blockName}_${tileMode}` : blockName;
          const dashboardForPosition = {
            ...doc.dashboard,
            layout: { ...doc.dashboard.layout, items: nextItems },
          };
          const tileId = nextTileId(dashboardForPosition, tileBase);
          nextItems.push({
            i: tileId,
            ...nextTilePosition(dashboardForPosition),
            block: { blockId: blockName },
            viz: { type: tileMode === 'data' ? 'table' : normalizeVizTypeForDashboard(chartConfig?.chart) },
            title: modesToAdd.length > 1 ? `${blockName} ${tileMode === 'data' ? 'data' : 'chart'}` : blockName,
          });
        }
        const next = {
          ...doc.dashboard.layout,
          items: nextItems,
        };
        const saved = await api.patchDashboardLayout(addToAppTarget.appId, addToAppTarget.dashboardId, next);
        if (!saved.ok) throw new Error(saved.error);
        setAddMessage(modesToAdd.length > 1 ? 'Added certified chart and data tiles.' : 'Added certified block tile.');
      } else {
        const keepDaily = Boolean(sql && window.confirm('Keep this AI result refreshed daily?'));
        const baseTitle = blockName ?? (summary.slice(0, 60) || 'AI result');
        const modesToAdd = selectedModes.length > 0 ? selectedModes : ['data'];
        for (const tileMode of modesToAdd) {
          const tileChartConfig = tileMode === 'data'
            ? ({ ...(chartConfig ?? {}), chart: 'table', title: `${baseTitle} data` } as Record<string, unknown>)
            : (chartConfig as Record<string, unknown> | undefined);
          const created = await api.createAiPin(addToAppTarget.appId, {
            dashboardId: addToAppTarget.dashboardId,
            title: modesToAdd.length > 1 ? `${baseTitle} ${tileMode === 'data' ? 'data' : 'chart'}` : baseTitle,
            answer: summary || answer.answer || answer.text || 'AI generated answer',
            question: analysisPlan?.question,
            sql,
            sourceTier: answer.sourceTier,
            certification: answer.certification === 'certified' ? 'certified' : 'ai_generated',
            refreshCadence: keepDaily ? 'daily' : 'none',
            chartConfig: tileChartConfig,
            result: result ?? undefined,
            citations: answer.citations,
            analysisPlan,
            evidence: answer.evidence,
            followUps: analysisPlan?.followUps,
          });
          if (!created.ok) throw new Error(created.error);
        }
        setAddMessage(modesToAdd.length > 1 ? 'Pinned chart and data tiles for review.' : 'Pinned AI result for review.');
      }
      window.dispatchEvent(new CustomEvent('dql-app-dashboard-updated', { detail: addToAppTarget }));
    } catch (err) {
      setAddMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  };
  const tabItems: Array<{ id: AnswerTab; label: string; visible: boolean }> = [
    { id: 'answer', label: compact ? 'Summary' : 'Answer', visible: true },
    { id: 'visual', label: compact ? 'Chart' : 'Visualization', visible: hasChart },
    { id: 'data', label: 'Data', visible: Boolean(result) },
    { id: 'sql', label: 'SQL / Block', visible: showSql && hasSqlPanel },
    { id: 'lineage', label: compact ? 'Trace' : 'Lineage', visible: hasEvidence },
    { id: 'context', label: compact ? 'Context' : 'Business Context', visible: hasEvidence },
    { id: 'review', label: compact ? 'Trust' : 'Review', visible: hasEvidence || Boolean(answer.citations?.length) },
  ];
  const tabs = tabItems.filter((item) => item.visible);
  const activeTab = tabs.some((item) => item.id === tab) ? tab : 'answer';
  const detailTabs = tabs.filter((item) => item.id !== 'answer');
  const activeDetailTab = detailTabs.some((item) => item.id === tab) ? tab : detailTabs[0]?.id;
  const renderTabPanel = (targetTab: AnswerTab) => {
    if (targetTab === 'answer') {
      return (
        <AnswerPanel
          summary={summary}
          evidence={answer.evidence}
          analysisPlan={analysisPlan}
          result={result}
          sourceTier={answer.sourceTier}
          compact={compact}
          t={t}
        />
      );
    }
    if (targetTab === 'visual' && result && hasChart) {
      return (
        <div style={{ padding: compact ? '8px 10px' : '10px 12px', minHeight: compact ? 180 : 220 }}>
          <ChartOutput result={result} themeMode={themeMode} chartConfig={chartConfig} />
        </div>
      );
    }
    if (targetTab === 'data' && result) {
      return (
        <div style={{ maxHeight: compact ? 320 : 420, overflow: 'auto' }}>
          <TableOutput result={result} themeMode={themeMode} />
        </div>
      );
    }
    if (targetTab === 'lineage') return <LineagePanel evidence={answer.evidence} t={t} />;
    if (targetTab === 'context') return <BusinessContextPanel evidence={answer.evidence} t={t} />;
    if (targetTab === 'sql' && showSql && hasSqlPanel) return <SqlPanel sql={sql} blockPath={blockPath} t={t} />;
    if (targetTab === 'review') return <ReviewPanel answer={answer} t={t} />;
    return null;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 8 : 10, whiteSpace: 'normal' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{
          fontSize: 10,
          fontFamily: t.fontMono,
          fontWeight: 700,
          letterSpacing: '0.08em',
          color: badgeColor,
          textTransform: 'uppercase',
          padding: '2px 6px',
          borderRadius: 3,
          background: `${badgeColor}18`,
          border: `1px solid ${badgeColor}40`,
        }}>
          {badge}
        </span>
        {!compact && blockName && (
          <span style={{ fontSize: 12, fontFamily: t.fontMono, color: t.textSecondary }}>
            block: {blockName}
          </span>
        )}
        {result && (
          <span style={{ fontSize: 12, color: t.textMuted }}>
            {(result.rowCount ?? result.rows.length).toLocaleString()} rows
            {result.executionTime !== undefined && <> - {Math.round(result.executionTime)}ms</>}
          </span>
        )}
        {canAddToApp && (
          <AddToAppControl
            t={t}
            adding={adding}
            hasResult={Boolean(result)}
            hasChart={hasChart}
            fallbackLabel={answer.certification === 'certified' && blockName ? (compact ? 'Add' : 'Add block') : 'Pin answer'}
            open={addMenuOpen}
            onToggle={() => setAddMenuOpen((value) => !value)}
            onAdd={(mode) => void addToApp(mode)}
          />
        )}
      </div>
      {addMessage && <div style={{ fontSize: 11, color: addMessage.toLowerCase().includes('added') || addMessage.toLowerCase().includes('pinned') ? '#3fb950' : '#ff7b72' }}>{addMessage}</div>}

      <div style={{ border: `1px solid ${t.cellBorder}`, borderRadius: compact ? 10 : 6, overflow: 'hidden', background: t.cellBg }}>
        {!compact && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '4px 10px', borderBottom: `1px solid ${t.cellBorder}`, background: `${t.tableHeaderBg}70`, flexWrap: 'wrap' }}>
            {tabs.map((item) => (
              <SegmentButton key={item.id} active={activeTab === item.id} label={item.label} onClick={() => setTab(item.id)} t={t} />
            ))}
            {!showSql && blockPath && (
              <span style={{ marginLeft: 'auto', minWidth: 0, fontSize: 11, fontFamily: t.fontMono, color: t.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {blockPath}
              </span>
            )}
          </div>
        )}
        {compact ? renderTabPanel('answer') : renderTabPanel(activeTab)}
        {compact && detailTabs.length > 0 && (
          <div style={{ borderTop: `1px solid ${t.cellBorder}`, background: `${t.tableHeaderBg}45` }}>
            <button
              type="button"
              onClick={() => setDetailsOpen((value) => !value)}
              style={{
                width: '100%',
                border: 0,
                background: 'transparent',
                color: t.textSecondary,
                padding: '8px 12px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                cursor: 'pointer',
                fontSize: 11,
                fontWeight: 800,
              }}
            >
              <span>Details</span>
              <span style={{ color: t.textMuted, fontFamily: t.fontMono }}>{detailsOpen ? 'hide' : 'show evidence'}</span>
            </button>
            {detailsOpen && (
              <div style={{ borderTop: `1px solid ${t.cellBorder}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '4px 12px', flexWrap: 'wrap' }}>
                  {detailTabs.map((item) => (
                    <SegmentButton key={item.id} active={activeDetailTab === item.id} label={item.label} onClick={() => setTab(item.id)} t={t} />
                  ))}
                </div>
                {activeDetailTab ? renderTabPanel(activeDetailTab) : null}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AnswerPanel({
  summary,
  evidence,
  analysisPlan,
  result,
  sourceTier,
  compact,
  t,
}: {
  summary: string;
  evidence?: AgentEvidence;
  analysisPlan?: AgentAnalysisPlan;
  result: QueryResult | null;
  sourceTier?: string;
  compact?: boolean;
  t: Theme;
}) {
  const nextAction = analysisPlan?.followUps?.[0];
  return (
    <div style={{ padding: compact ? 14 : 12, display: 'flex', flexDirection: 'column', gap: compact ? 10 : 12 }}>
      {summary ? (
        <div style={{ fontSize: compact ? 13.5 : 13, lineHeight: 1.55, color: t.textPrimary, whiteSpace: 'pre-wrap' }}>
          {summary}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: t.textMuted }}>No summary text was returned.</div>
      )}
      {compact ? (
        <div style={{ fontSize: 11.5, color: t.textMuted, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {[
            sourceTier ? formatBusinessTier(sourceTier) : null,
            result ? `${(result.rowCount ?? result.rows.length).toLocaleString()} rows` : null,
            evidence?.validation?.status === 'failed' ? 'needs review' : null,
            evidence?.execution?.status === 'failed' ? 'data check failed' : null,
          ]
            .filter(Boolean)
            .map((label, idx) => (
              <React.Fragment key={`${label}-${idx}`}>
                {idx > 0 && <span style={{ color: t.cellBorder }}>·</span>}
                <span>{label}</span>
              </React.Fragment>
            ))}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {sourceTier && <Pill label={formatLabel(sourceTier)} t={t} />}
          {result && <Pill label={`${(result.rowCount ?? result.rows.length).toLocaleString()} rows`} t={t} />}
          {evidence?.validation?.status && <Pill label={`validation: ${evidence.validation.status}`} t={t} />}
          {evidence?.execution?.status && <Pill label={`execution: ${evidence.execution.status}`} t={t} />}
        </div>
      )}
      {result && <ResultPreview result={result} t={t} compact={compact} />}
      {analysisPlan && (
        <div style={{
          display: 'grid',
          gap: 7,
          padding: compact ? '9px 10px' : 10,
          border: `1px solid ${t.cellBorder}`,
          borderRadius: 8,
          background: `${t.tableHeaderBg}45`,
        }}>
          {analysisPlan.routeReason && (
            <div style={{ fontSize: compact ? 12.5 : 12, lineHeight: 1.45, color: t.textSecondary }}>
              {analysisPlan.routeReason}
            </div>
          )}
          {(analysisPlan.grain || analysisPlan.measures?.length || analysisPlan.dimensions?.length) && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {analysisPlan.grain && <Pill label={`grain: ${analysisPlan.grain}`} t={t} />}
              {analysisPlan.measures?.slice(0, 2).map((measure) => <Pill key={`measure-${measure}`} label={measure} t={t} />)}
              {analysisPlan.dimensions?.slice(0, 2).map((dimension) => <Pill key={`dimension-${dimension}`} label={dimension} t={t} />)}
            </div>
          )}
          {nextAction && (
            <div style={{ fontSize: 12, color: t.textMuted }}>
              Next: <span style={{ color: t.textSecondary }}>{nextAction}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ResultPreview({ result, t, compact }: { result: QueryResult; t: Theme; compact?: boolean }) {
  const columns = (result.columns.length > 0 ? result.columns : Object.keys(result.rows[0] ?? {})).slice(0, compact ? 3 : 4);
  const rows = result.rows.slice(0, compact ? 4 : 5);
  if (columns.length === 0 || rows.length === 0) return null;
  return (
    <div style={{
      border: `1px solid ${t.cellBorder}`,
      borderRadius: 8,
      overflow: 'hidden',
      background: t.editorBg,
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 10,
        padding: '7px 9px',
        borderBottom: `1px solid ${t.cellBorder}`,
        color: t.textMuted,
        fontSize: 11,
        fontFamily: t.fontMono,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
      }}>
        <span>Preview</span>
        <span>{rows.length} of {(result.rowCount ?? result.rows.length).toLocaleString()} rows</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column} style={{
                  textAlign: 'left',
                  padding: '7px 9px',
                  color: t.textMuted,
                  fontSize: 11,
                  fontFamily: t.fontMono,
                  borderBottom: `1px solid ${t.cellBorder}`,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}>
                  {formatLabel(column)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {columns.map((column) => (
                  <td key={`${rowIndex}-${column}`} style={{
                    padding: '7px 9px',
                    color: t.textPrimary,
                    fontSize: compact ? 12 : 12.5,
                    borderBottom: rowIndex < rows.length - 1 ? `1px solid ${t.cellBorder}` : 0,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}>
                    {formatPreviewValue(row[column])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LineagePanel({ evidence, t }: { evidence?: AgentEvidence; t: Theme }) {
  const lineage = evidence?.lineage ?? [];
  if (lineage.length === 0) {
    return <EmptyPanel t={t}>No lineage evidence was returned for this answer.</EmptyPanel>;
  }
  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {lineage.map((asset, idx) => (
        <div key={`${asset.nodeId ?? asset.name}-${idx}`} style={{ display: 'grid', gridTemplateColumns: '20px 1fr', gap: 8 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div style={{ width: 8, height: 8, borderRadius: 8, marginTop: 5, background: asset.role === 'question' ? t.accent : t.textMuted }} />
            {idx < lineage.length - 1 && <div style={{ width: 1, flex: 1, minHeight: 18, background: t.cellBorder }} />}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: t.textPrimary }}>{asset.name ?? asset.nodeId}</span>
              {asset.role && <Pill label={formatLabel(asset.role)} t={t} />}
              {asset.kind && <Pill label={formatLabel(asset.kind)} t={t} />}
            </div>
            {asset.description && <div style={{ fontSize: 12, color: t.textSecondary, marginTop: 3 }}>{asset.description}</div>}
            {(asset.sourcePath || asset.provenance) && (
              <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontMono, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {asset.provenance ?? asset.sourcePath}
                {asset.sourcePath && asset.provenance ? ` - ${asset.sourcePath}` : ''}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function BusinessContextPanel({ evidence, t }: { evidence?: AgentEvidence; t: Theme }) {
  const context = evidence?.businessContext ?? [];
  const outcome = evidence?.outcome;
  if (!outcome && context.length === 0) {
    return <EmptyPanel t={t}>No business context was returned for this answer.</EmptyPanel>;
  }
  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {outcome && (
        <div style={{ display: 'grid', gap: 6 }}>
          <SectionTitle t={t}>Outcome</SectionTitle>
          {outcome.name && <KeyValue label="Outcome" value={outcome.name} t={t} />}
          {outcome.owner && <KeyValue label="Owner" value={outcome.owner} t={t} />}
          {outcome.decisionUse && <KeyValue label="Decision Use" value={outcome.decisionUse} t={t} />}
          {outcome.reviewCadence && <KeyValue label="Review Cadence" value={outcome.reviewCadence} t={t} />}
          {outcome.caveats?.map((caveat, idx) => <KeyValue key={`caveat-${idx}`} label="Caveat" value={caveat} t={t} />)}
        </div>
      )}
      {context.length > 0 && (
        <div style={{ display: 'grid', gap: 6 }}>
          <SectionTitle t={t}>Context</SectionTitle>
          {context.map((item, idx) => (
            <KeyValue
              key={`${item.label}-${idx}`}
              label={item.label ?? 'Context'}
              value={item.value ?? ''}
              source={item.source}
              t={t}
            />
          ))}
        </div>
      )}
      {evidence?.semanticObjects && evidence.semanticObjects.length > 0 && (
        <AssetList title="Semantic Objects" assets={evidence.semanticObjects} t={t} />
      )}
      {evidence?.sourceTables && evidence.sourceTables.length > 0 && (
        <AssetList title="Source Tables" assets={evidence.sourceTables} t={t} />
      )}
    </div>
  );
}

function ReviewPanel({ answer, t }: { answer: AgentAnswerEnvelope; t: Theme }) {
  const evidence = answer.evidence;
  const analysisPlan = answer.analysisPlan ?? evidence?.analysisPlan;
  const citations = evidence?.citations ?? answer.citations ?? [];
  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'grid', gap: 6 }}>
        <KeyValue label="Certification" value={formatLabel(answer.certification ?? answer.kind)} t={t} />
        {answer.reviewStatus && <KeyValue label="Review Status" value={formatLabel(answer.reviewStatus)} t={t} />}
        {typeof answer.confidence === 'number' && <KeyValue label="Confidence" value={`${Math.round(answer.confidence * 100)}%`} t={t} />}
        {evidence?.validation?.message && (
          <KeyValue label={`Validation ${evidence.validation.status ?? ''}`.trim()} value={evidence.validation.message} t={t} />
        )}
        {evidence?.execution?.message && (
          <KeyValue label={`Execution ${evidence.execution.status ?? ''}`.trim()} value={evidence.execution.message} t={t} />
        )}
        {answer.kind !== 'certified' && (
          <KeyValue label="Promotion Path" value="Create draft block, edit SQL, attach tests, then certify after analyst approval." t={t} />
        )}
      </div>
      {analysisPlan && (
        <div style={{ display: 'grid', gap: 6 }}>
          <SectionTitle t={t}>Analysis Plan</SectionTitle>
          {analysisPlan.question && <KeyValue label="Question" value={analysisPlan.question} t={t} />}
          {analysisPlan.intent && <KeyValue label="Intent" value={formatLabel(analysisPlan.intent)} t={t} />}
          {analysisPlan.grain && <KeyValue label="Grain" value={analysisPlan.grain} t={t} />}
          {analysisPlan.candidateTables && analysisPlan.candidateTables.length > 0 && (
            <KeyValue
              label="Tables"
              value={analysisPlan.candidateTables.slice(0, 5).map((table) => table.relation).filter(Boolean).join(', ')}
              t={t}
            />
          )}
          {analysisPlan.assumptions && analysisPlan.assumptions.length > 0 && (
            <KeyValue label="Assumptions" value={analysisPlan.assumptions.join(' ')} t={t} />
          )}
          {typeof analysisPlan.repairAttempts === 'number' && analysisPlan.repairAttempts > 0 && (
            <KeyValue label="SQL Repair" value={`${analysisPlan.repairAttempts} retry`} t={t} />
          )}
        </div>
      )}
      {citations.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <SectionTitle t={t}>Citations</SectionTitle>
          {citations.slice(0, 8).map((citation, idx) => (
            <div key={`${citation.kind}-${citation.name}-${idx}`} style={{ fontSize: 12, color: t.textSecondary, fontFamily: t.fontMono }}>
              {citation.kind ?? 'source'}: {citation.name ?? 'unknown'}
              {citation.provenance && <span style={{ color: t.textMuted }}> ({citation.provenance})</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AssetList({ title, assets, t }: { title: string; assets: EvidenceAsset[]; t: Theme }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <SectionTitle t={t}>{title}</SectionTitle>
      {assets.map((asset, idx) => (
        <div key={`${asset.nodeId ?? asset.name}-${idx}`} style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingBottom: 4 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: t.textPrimary }}>{asset.name ?? asset.nodeId}</span>
            {asset.kind && <Pill label={formatLabel(asset.kind)} t={t} />}
            {asset.certification && <Pill label={formatLabel(asset.certification)} t={t} />}
          </div>
          {asset.description && <div style={{ fontSize: 12, color: t.textSecondary }}>{asset.description}</div>}
          {(asset.sourcePath || asset.owner || asset.domain) && (
            <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontMono }}>
              {[asset.domain, asset.owner, asset.sourcePath].filter(Boolean).join(' - ')}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function SqlPanel({ sql, blockPath, t }: { sql?: string; blockPath?: string; t: Theme }) {
  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {blockPath && (
        <div style={{ fontSize: 12, color: t.textSecondary }}>
          Source block: <span style={{ fontFamily: t.fontMono, color: t.textPrimary }}>{blockPath}</span>
        </div>
      )}
      {sql ? (
        <pre style={{
          margin: 0,
          padding: 10,
          overflow: 'auto',
          maxHeight: 260,
          borderRadius: 4,
          background: t.editorBg,
          color: t.textPrimary,
          border: `1px solid ${t.cellBorder}`,
          fontSize: 12,
          fontFamily: t.fontMono,
          whiteSpace: 'pre',
        }}>
          {sql}
        </pre>
      ) : (
        <div style={{ fontSize: 12, color: t.textMuted }}>No SQL text was returned for this answer.</div>
      )}
    </div>
  );
}

function KeyValue({ label, value, source, t }: { label: string; value: string; source?: string; t: Theme }) {
  if (!value) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr', gap: 10, fontSize: 12, alignItems: 'baseline' }}>
      <span style={{ color: t.textMuted }}>{label}</span>
      <span style={{ color: t.textSecondary }}>
        {value}
        {source && <span style={{ color: t.textMuted }}> ({source})</span>}
      </span>
    </div>
  );
}

function SectionTitle({ children, t }: { children: React.ReactNode; t: Theme }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, fontFamily: t.fontMono, color: t.textMuted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
      {children}
    </div>
  );
}

function EmptyPanel({ children, t }: { children: React.ReactNode; t: Theme }) {
  return <div style={{ padding: 12, fontSize: 12, color: t.textMuted }}>{children}</div>;
}

function Pill({ label, t }: { label: string; t: Theme }) {
  return (
    <span style={{
      fontSize: 11,
      fontFamily: t.fontMono,
      color: t.textSecondary,
      padding: '2px 6px',
      borderRadius: 4,
      background: t.editorBg,
      border: `1px solid ${t.cellBorder}`,
    }}>
      {label}
    </span>
  );
}

function SegmentButton({ active, label, onClick, t }: { active: boolean; label: string; onClick: () => void; t: Theme }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '4px 2px',
        fontSize: 11.5,
        border: 0,
        borderBottom: `2px solid ${active ? t.accent : 'transparent'}`,
        borderRadius: 0,
        background: 'transparent',
        color: active ? t.accent : t.textSecondary,
        fontWeight: active ? 700 : 500,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

function AddToAppControl({
  t,
  adding,
  hasResult,
  hasChart,
  fallbackLabel,
  open,
  onToggle,
  onAdd,
}: {
  t: Theme;
  adding: boolean;
  hasResult: boolean;
  hasChart: boolean;
  fallbackLabel: string;
  open: boolean;
  onToggle: () => void;
  onAdd: (mode: AddToAppMode) => void;
}) {
  if (!hasResult) {
    return (
      <button
        type="button"
        onClick={() => onAdd('auto')}
        disabled={adding}
        style={{ ...addButtonStyle(t, adding), marginLeft: 'auto' }}
      >
        {adding ? 'Adding...' : fallbackLabel}
      </button>
    );
  }

  const options: Array<{ mode: AddToAppMode; label: string; description: string }> = hasChart
    ? [
        { mode: 'both', label: 'Chart + data', description: 'Add chart and table tiles' },
        { mode: 'chart', label: 'Chart only', description: 'Add the visualization tile' },
        { mode: 'data', label: 'Data table', description: 'Add the rows as a table tile' },
      ]
    : [
        { mode: 'data', label: 'Data table', description: 'Add the rows as a table tile' },
      ];

  return (
    <div style={{ marginLeft: 'auto', position: 'relative' }}>
      <button
        type="button"
        onClick={onToggle}
        disabled={adding}
        style={addButtonStyle(t, adding)}
      >
        {adding ? 'Adding...' : 'Add to App'}
        {!adding && <span style={{ marginLeft: 6, fontSize: 10 }}>v</span>}
      </button>
      {open && !adding && (
        <div
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 6px)',
            zIndex: 30,
            width: 190,
            border: `1px solid ${t.cellBorder}`,
            borderRadius: 8,
            background: t.cellBg,
            boxShadow: '0 14px 34px rgba(0, 0, 0, 0.18)',
            padding: 6,
          }}
        >
          {options.map((option) => (
            <button
              key={option.mode}
              type="button"
              onClick={() => onAdd(option.mode)}
              style={{
                width: '100%',
                border: 0,
                borderRadius: 6,
                background: 'transparent',
                color: t.textPrimary,
                textAlign: 'left',
                padding: '8px 9px',
                cursor: 'pointer',
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 700 }}>{option.label}</div>
              <div style={{ fontSize: 11, color: t.textMuted, marginTop: 2 }}>{option.description}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function addButtonStyle(t: Theme, adding: boolean): React.CSSProperties {
  return {
    border: `1px solid ${t.btnBorder}`,
    borderRadius: 5,
    background: adding ? t.editorBg : `${t.accent}18`,
    color: adding ? t.textMuted : t.accent,
    padding: '4px 8px',
    fontSize: 11,
    cursor: adding ? 'default' : 'pointer',
  };
}

function formatLabel(value: string): string {
  return value.replace(/_/g, ' ');
}

function formatPreviewValue(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    return Math.abs(value) >= 1000 || !Number.isInteger(value)
      ? value.toLocaleString(undefined, { maximumFractionDigits: 2 })
      : value.toLocaleString();
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function formatBusinessTier(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized.includes('certified')) return 'trusted business context';
  if (normalized.includes('ai') || normalized.includes('generated')) return 'AI draft';
  if (normalized.includes('no_answer')) return 'needs more context';
  return formatLabel(value);
}

function statusColor(status?: string): string {
  if (status === 'selected' || status === 'passed' || status === 'executed') return '#3fb950';
  if (status === 'failed') return '#ff7b72';
  if (status === 'warning' || status === 'checked') return '#f0883e';
  return '#8b949e';
}

function nextTilePosition(dashboard: { layout: { items: Array<{ y: number; h: number }> } }): { x: number; y: number; w: number; h: number } {
  const y = dashboard.layout.items.reduce((max, item) => Math.max(max, item.y + item.h), 0);
  return { x: 0, y, w: 6, h: 3 };
}

function nextTileId(dashboard: { layout: { items: Array<{ i: string }> } }, raw: string): string {
  const base = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'tile';
  const used = new Set(dashboard.layout.items.map((item) => item.i));
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function normalizeVizTypeForDashboard(value: unknown): string {
  const chart = String(value ?? 'table').toLowerCase().replace(/-/g, '_');
  if (chart === 'single_value' || chart === 'kpi' || chart === 'line' || chart === 'bar' || chart === 'area'
    || chart === 'pie' || chart === 'pivot' || chart === 'map' || chart === 'funnel') {
    return chart;
  }
  return 'table';
}
