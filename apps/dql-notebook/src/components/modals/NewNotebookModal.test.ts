import { describe, expect, it } from 'vitest';

import { buildTemplateCells } from './notebook-templates';

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
});
