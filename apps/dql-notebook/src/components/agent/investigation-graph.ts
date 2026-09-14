/**
 * AN INVESTIGATION AS A BRANCHING FLOW. The frame, the freshness check, the
 * headline and the coverage check in a line; the breakdowns side by side after
 * them; a drill after the breakdown it went into; the year-earlier check after
 * the breakdown of the member it checked; and the report where every branch
 * ends. Laid out like an Ask decision flow.
 */
import type { DecisionEdge, DecisionFlow, DecisionNode } from './ask-run-graph';
import type { InvestigationExplanation } from './investigation-view';

/** Programs that run one after another before the breakdowns. */
const SPINE = new Set(['frame', 'freshness', 'headline', 'coverage', 'context']);

export const PROGRAM_VERDICT_WORDS: Record<string, string> = {
  supported: 'Drivers found',
  partial: 'Partial drivers',
  ruled_out: 'Ruled out',
  inconclusive: 'Inconclusive',
};

export function investigationDecisionFlow(explanation: InvestigationExplanation): DecisionFlow {
  const { programs } = explanation;
  const nodes: DecisionNode[] = programs.map((program) => {
    const subtitle = program.verdict ? PROGRAM_VERDICT_WORDS[program.verdict] : program.kind === 'report' ? 'Report' : undefined;
    return {
      id: program.id,
      kind: program.kind === 'report' ? 'end' : 'step',
      stepId: program.id,
      title: program.title,
      ...(subtitle ? { subtitle } : {}),
      outcome: program.outcome,
      ...(program.ms !== undefined ? { ms: program.ms } : {}),
    };
  });
  const edges: DecisionEdge[] = [];
  const connect = (source: string, target: string, label?: string) => {
    if (source === target || edges.some((edge) => edge.source === source && edge.target === target)) return;
    edges.push({ id: `edge-${source}-${target}`, source, target, ...(label ? { label } : {}) });
  };

  const spine = programs.filter((program) => SPINE.has(program.kind));
  spine.slice(1).forEach((program, index) => connect(spine[index]!.id, program.id));
  const root = spine[spine.length - 1]?.id;
  const ids = new Set(programs.map((program) => program.id));
  const breakdownOf = new Map(programs.filter((program) => program.kind === 'contribution' && program.dimension).map((program) => [program.dimension!, program.id]));
  for (const program of programs) {
    if (SPINE.has(program.kind) || program.kind === 'report') continue;
    if (program.kind === 'drill' && program.parentId && ids.has(program.parentId)) connect(program.parentId, program.id, 'drill');
    else if (program.kind === 'seasonality' && program.dimension && breakdownOf.has(program.dimension)) connect(breakdownOf.get(program.dimension)!, program.id, 'a year earlier');
    else if (root) connect(root, program.id);
  }

  const report = programs.find((program) => program.kind === 'report');
  if (report) {
    const sources = new Set(edges.map((edge) => edge.source));
    for (const program of programs) {
      if (program.id !== report.id && !sources.has(program.id)) connect(program.id, report.id);
    }
  }
  return { nodes, edges };
}
