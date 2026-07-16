import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { themes } from '../../themes/notebook-theme';
import { AiSidePanel } from './AiSidePanel';

describe('AiSidePanel', () => {
  it('provides the same expand and close controls to every right-side AI surface', () => {
    const markup = renderToStaticMarkup(
      <AiSidePanel
        t={themes.paper}
        title="Notebook AI"
        subtitle="Whole notebook"
        expanded={false}
        onToggleExpanded={vi.fn()}
        onClose={vi.fn()}
      >
        <div>Conversation</div>
      </AiSidePanel>,
    );

    expect(markup).toContain('data-ai-side-panel="true"');
    expect(markup).toContain('data-expanded="false"');
    expect(markup).toContain('aria-label="Expand AI panel"');
    expect(markup).toContain('aria-label="Close Notebook AI"');
    expect(markup).toContain('Whole notebook');
  });

  it('uses an explicit restore action in expanded mode', () => {
    const markup = renderToStaticMarkup(
      <AiSidePanel
        t={themes.paper}
        title="Block AI"
        subtitle="Current block"
        expanded
        onToggleExpanded={vi.fn()}
        onClose={vi.fn()}
      >
        <div>Conversation</div>
      </AiSidePanel>,
    );

    expect(markup).toContain('data-expanded="true"');
    expect(markup).toContain('aria-label="Return AI panel to standard width"');
    expect(markup).toContain('aria-label="Close Block AI"');
  });
});
