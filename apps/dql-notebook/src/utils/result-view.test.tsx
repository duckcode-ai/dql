import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ResultView } from '../components/output/ResultView';
import { themes } from '../themes/notebook-theme';

describe('ResultView', () => {
  it('opens chartable Ask results as a table while keeping visualization available', () => {
    const markup = renderToStaticMarkup(
      <ResultView
        result={{
          columns: ['customer_name', 'revenue'],
          rows: [
            { customer_name: 'Melissa Lopez', revenue: 425467 },
            { customer_name: 'Keith Cook', revenue: 211977 },
          ],
          rowCount: 2,
        }}
        themeMode="paper"
        t={themes.paper}
        embedded
        tabLabels={{ table: 'Results', chart: 'Visualization' }}
      />,
    );

    expect(markup).toContain('Filter rows...');
    expect(markup).toContain('Results');
    expect(markup).toContain('Visualization');
    expect(markup.indexOf('Results')).toBeLessThan(markup.indexOf('Visualization'));
    expect(markup).not.toContain('Smart chart');
  });
});
