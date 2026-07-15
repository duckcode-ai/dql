import { makeCell } from '../../store/NotebookStore';
import type { Cell } from '../../store/types';

export type NotebookTemplate =
  | 'blank'
  | 'analysis'
  | 'metric_diagnostic'
  | 'data_quality'
  | 'experiment';

export const NOTEBOOK_TEMPLATE_LABELS: Record<NotebookTemplate, string> = {
  blank: 'Blank',
  analysis: 'Analysis',
  metric_diagnostic: 'Metric diagnostic',
  data_quality: 'Data-quality investigation',
  experiment: 'Experiment log',
};

export const NOTEBOOK_TEMPLATE_DESCRIPTIONS: Record<NotebookTemplate, string> = {
  blank: 'Start from a research question and choose the right source.',
  analysis: 'A decision-ready research narrative from context through takeaways.',
  metric_diagnostic: 'Trace a metric change through segments, time, and validation checks.',
  data_quality: 'Profile a source, document issues, and record validation evidence.',
  experiment: 'Capture a hypothesis, method, results, and decision.',
};

export function buildTemplateCells(template: NotebookTemplate): Cell[] {
  switch (template) {
    case 'analysis':
      return [
        makeCell('markdown', '# TL;DR\n\nSummarize the answer and decision here.'),
        makeCell('markdown', '## Context and methods\n\nState the business question, scope, definitions, and assumptions.'),
        { ...makeCell('dql'), name: 'analysis_data' },
        makeCell('markdown', '## Results\n\nExplain the material findings and uncertainty.'),
        makeCell('markdown', '## Takeaways\n\nRecord the decision, risks, and next action.'),
      ];
    case 'metric_diagnostic':
      return [
        makeCell('markdown', '# Metric diagnostic\n\n**Question:** What changed, when, and for whom?\n\n**Metric definition:** Add the certified definition and expected behavior.'),
        { ...makeCell('dql'), name: 'metric_trend' },
        { ...makeCell('dql'), name: 'driver_breakdown', dependencies: [] },
        makeCell('markdown', '## Diagnosis\n\nSeparate validated drivers from hypotheses and data limitations.'),
      ];
    case 'data_quality':
      return [
        makeCell('markdown', '# Data-quality investigation\n\nDocument the source, owner, freshness expectation, and affected decisions.'),
        { ...makeCell('dql'), name: 'quality_profile' },
        { ...makeCell('dql'), name: 'quality_checks' },
        makeCell('markdown', '## Findings and disposition\n\nRecord severity, impacted metrics, owner, and remediation.'),
      ];
    case 'experiment':
      return [
        makeCell('markdown', '# Experiment log\n\n**Hypothesis:**\n\n**Primary metric:**\n\n**Guardrails:**\n\n**Population and dates:**'),
        { ...makeCell('dql'), name: 'experiment_results' },
        makeCell('markdown', '## Results\n\nReport effect size, uncertainty, guardrails, and data-quality checks.'),
        makeCell('markdown', '## Decision\n\nShip, iterate, or stop — with rationale.'),
      ];
    default:
      return [];
  }
}
