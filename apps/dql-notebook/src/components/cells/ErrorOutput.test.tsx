import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ErrorOutput } from '../output/ErrorOutput';

describe('ErrorOutput', () => {
  it('offers explicit AI repair for DQL while preserving review-first replacement', () => {
    const markup = renderToStaticMarkup(
      <ErrorOutput
        message="DQL query contains internal DQL graph relation identifier source::dev.orders."
        themeMode="paper"
        editableArtifactLabel="DQL"
        onFixWithAi={() => undefined}
      />,
    );

    expect(markup).toContain('Ask AI to fix');
    expect(markup).toContain('Review the proposed fix before replacing the cell');
    expect(markup).toContain('edit the DQL directly');
  });
});
