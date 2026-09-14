/**
 * The trace page's view of a Research run: the investigation as a branching
 * flow beside the selected step — its outcome, why, and each query it ran,
 * which opens into how that query ran.
 */
import { useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { Background, Controls, MarkerType, ReactFlow, useEdgesState, useNodesState, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { Theme } from '../../themes/notebook-theme';
import { OUTCOME_WORDS, formatRunMs } from './ask-run-explanation';
import { layoutDecisionFlow } from './ask-run-graph';
import { decisionNodeTypes, type DecisionNodeData } from './AskRunDecisionView';
import { AskRunFlow } from './AskRunFlow';
import { investigationDecisionFlow, PROGRAM_VERDICT_WORDS } from './investigation-graph';
import type { InvestigationExplanation } from './investigation-view';

const detailLabel = (t: Theme): React.CSSProperties => ({ fontSize: 10.5, fontWeight: 700, color: t.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '14px 0 6px' });

export function InvestigationDecisionView({ explanation, t, isNarrow }: { explanation: InvestigationExplanation; t: Theme; isNarrow: boolean }): JSX.Element {
  const flow = useMemo(() => investigationDecisionFlow(explanation), [explanation]);
  const positions = useMemo(() => layoutDecisionFlow(flow), [flow]);
  const [selectedId, setSelectedId] = useState<string | undefined>(() => (
    explanation.programs.find((program) => program.outcome === 'failed')
    ?? explanation.programs.find((program) => program.kind === 'contribution')
    ?? explanation.programs[explanation.programs.length - 1]
  )?.id);
  const [openQuery, setOpenQuery] = useState<string>();
  // ReactFlow shows a node only once it has measured it, through onNodesChange.
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  useEffect(() => {
    setNodes(flow.nodes.map((node) => ({
      id: node.id,
      type: 'decision',
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      data: { node, t } satisfies DecisionNodeData,
      selected: node.id === selectedId,
      draggable: false,
    })));
    setEdges(flow.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(edge.label ? { label: edge.label } : {}),
      style: { stroke: t.textMuted, strokeWidth: 1.3 },
      labelStyle: { fontSize: 10, fill: t.textMuted },
      labelBgStyle: { fill: t.cellBg },
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: t.textMuted },
    })));
    // The selection is ReactFlow's to track after the first render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow, positions, t, setNodes, setEdges]);

  const program = explanation.programs.find((entry) => entry.id === selectedId);
  const { budget } = explanation;
  const summary = [
    explanation.totalMs !== undefined ? `Worked for ${formatRunMs(explanation.totalMs) || 'under a second'}` : '',
    `${explanation.programs.length} step${explanation.programs.length === 1 ? '' : 's'}`,
    budget.statementsCap ? `${budget.statementsUsed} of ${budget.statementsCap} queries` : '',
    `${budget.aiCalls} AI call${budget.aiCalls === 1 ? '' : 's'}`,
  ].filter(Boolean).join(' · ');

  return (
    <section aria-label="How it was researched" style={{ margin: '0 0 14px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', margin: '0 0 8px' }}>
        <h2 style={{ margin: 0, fontSize: 14, color: t.textPrimary }}>How it was researched</h2>
        <span style={{ fontSize: 11.5, color: t.textMuted }}>{summary}</span>
      </div>
      {explanation.reading ? <div style={{ fontSize: 12, color: t.textSecondary, margin: '0 0 10px' }}>Read as: {explanation.reading}</div> : null}
      <div style={{ display: 'grid', gridTemplateColumns: isNarrow ? 'minmax(0, 1fr)' : 'minmax(0, 1.35fr) minmax(300px, 0.65fr)', gap: 14, alignItems: 'start' }}>
        <div aria-label="Investigation flow" style={{ height: isNarrow ? 320 : 460, border: `1px solid ${t.cellBorder}`, borderRadius: 11, overflow: 'hidden', background: t.appBg }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={decisionNodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={(_event, node) => setSelectedId(node.id)}
            fitView
            fitViewOptions={{ padding: 0.12 }}
            minZoom={0.2}
            nodesDraggable={false}
            nodesConnectable={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background color={t.cellBorder} gap={20} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        <section aria-label="Step details" style={{ padding: '16px 18px', minWidth: 0, border: `1px solid ${t.cellBorder}`, borderRadius: 11, background: t.cellBg }}>
          {program ? (
            <>
              <div style={{ fontSize: 11, color: t.textMuted }}>Step {program.n}</div>
              <h3 style={{ margin: '2px 0 0', fontSize: 15, color: t.textPrimary }}>{program.title}</h3>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, fontSize: 11.5, color: t.textMuted, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 700, color: program.outcome === 'failed' ? t.error : program.outcome === 'done' ? t.success : t.textMuted }}>{OUTCOME_WORDS[program.outcome]}</span>
                {program.verdict && PROGRAM_VERDICT_WORDS[program.verdict] ? <span>{PROGRAM_VERDICT_WORDS[program.verdict]}</span> : null}
                {formatRunMs(program.ms) ? <span>{formatRunMs(program.ms)}</span> : null}
              </div>
              {program.reason ? <p style={{ margin: '10px 0 0', fontSize: 12.5, lineHeight: 1.5, color: t.textSecondary }}>{program.reason}</p> : null}
              {program.queries.length ? (
                <>
                  <div style={detailLabel(t)}>{program.queries.length === 1 ? 'Query' : 'Queries'}</div>
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
                    {program.queries.map((query) => (
                      <li key={query.id} style={{ display: 'grid', gap: 6 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 12, color: t.textSecondary }}>{query.label}</span>
                          <span style={{ fontSize: 10.5, color: t.textMuted }}>{[query.tier, query.outcome === 'answered' ? 'ran' : query.outcome].filter(Boolean).join(' · ')}</span>
                          {query.explanation ? (
                            <button
                              type="button"
                              className="dql-hover"
                              aria-expanded={openQuery === query.id}
                              onClick={() => setOpenQuery((current) => (current === query.id ? undefined : query.id))}
                              style={{ fontSize: 11, color: t.accent, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: t.font }}
                            >
                              {openQuery === query.id ? 'Hide how this query ran' : 'How this query ran'}
                            </button>
                          ) : null}
                        </div>
                        {openQuery === query.id && query.explanation ? (
                          <div style={{ borderLeft: `2px solid ${t.cellBorder}`, paddingLeft: 10 }}>
                            <AskRunFlow explanation={query.explanation} t={t} />
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </>
          ) : (
            <div style={{ color: t.textMuted, fontSize: 12 }}>Select a step in the flow to see what happened there.</div>
          )}
        </section>
      </div>
    </section>
  );
}
