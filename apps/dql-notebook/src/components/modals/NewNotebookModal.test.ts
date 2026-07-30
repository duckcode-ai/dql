import { describe, expect, it } from 'vitest';

import {
  buildTemplateCells,
  NOTEBOOK_TEMPLATE_CELL_SUMMARIES,
  NOTEBOOK_TEMPLATE_DESCRIPTIONS,
  NOTEBOOK_TEMPLATE_LABELS,
} from './notebook-templates';

describe('focused notebook templates', () => {
  it('starts a blank notebook without placeholder cells', () => {
    expect(buildTemplateCells('blank')).toEqual([]);
  });

  it('uses DQL as the default executable cell in research templates', () => {
    const cells = buildTemplateCells('analysis');
    const executable = cells.filter((cell) => cell.type === 'dql' || cell.type === 'sql');

    expect(executable).toHaveLength(1);
    expect(executable[0]).toMatchObject({ type: 'dql', name: 'analysis_data', content: '' });
  });

  it('explains choices by user goal and exact starter-cell shape', () => {
    expect(NOTEBOOK_TEMPLATE_LABELS).toEqual({
      blank: 'Start empty',
      analysis: 'Explore a question',
      metric_diagnostic: 'Investigate a metric',
      data_quality: 'Check data quality',
      experiment: 'Review an experiment',
    });
    expect(NOTEBOOK_TEMPLATE_CELL_SUMMARIES).toEqual({
      blank: 'Empty canvas · 0 starter cells',
      analysis: '1 DQL query · 4 note sections',
      metric_diagnostic: '2 DQL queries · 2 note sections',
      data_quality: '2 DQL queries · 2 note sections',
      experiment: '1 DQL query · 3 note sections',
    });
    expect(Object.values(NOTEBOOK_TEMPLATE_DESCRIPTIONS).every((description) => description.length > 30)).toBe(true);
  });
});
