import { makeCell } from '../../store/NotebookStore';
import type { Cell } from '../../store/types';

export type NotebookTemplate =
  | 'blank'
  | 'analysis'
  | 'metric_diagnostic'
  | 'data_quality'
  | 'experiment';

export const NOTEBOOK_TEMPLATE_LABELS: Record<NotebookTemplate, string> = {
  blank: 'Start empty',
  analysis: 'Explore a question',
  metric_diagnostic: 'Investigate a metric',
  data_quality: 'Check data quality',
  experiment: 'Review an experiment',
};

export const NOTEBOOK_TEMPLATE_DESCRIPTIONS: Record<NotebookTemplate, string> = {
  blank: 'Add Ask, DQL, SQL, or notes only when you need them.',
  analysis: 'Move from a business question to evidence, findings, and a decision.',
  metric_diagnostic: 'Trend a metric, break down its drivers, and record the diagnosis.',
  data_quality: 'Profile a source, run checks, and document ownership and remediation.',
  experiment: 'Capture the hypothesis, metrics, results, guardrails, and decision.',
};

export const NOTEBOOK_TEMPLATE_CELL_SUMMARIES: Record<NotebookTemplate, string> = {
  blank: 'Empty canvas · 0 starter cells',
  analysis: '1 DQL query · 4 note sections',
  metric_diagnostic: '2 DQL queries · 2 note sections',
  data_quality: '2 DQL queries · 2 note sections',
  experiment: '1 DQL query · 3 note sections',
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
