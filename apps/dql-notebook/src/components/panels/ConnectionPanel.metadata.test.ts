import { describe, expect, it } from 'vitest';
import {
  formatMetadataScopeEditor,
  parseMetadataScopeEditor,
} from './connection-metadata-scope';

describe('ConnectionPanel metadata scope editor', () => {
  it('round-trips multiple databases and schemas in the compact editor format', () => {
    const scopes = [
      { catalogOrDatabase: 'ANALYTICS_PROD', schemas: ['SALES', 'FINANCE'] },
      { catalogOrDatabase: 'REFERENCE_DATA', schemas: ['SHARED'] },
    ];
    const text = formatMetadataScopeEditor(scopes);

    expect(text).toBe('ANALYTICS_PROD: SALES, FINANCE\nREFERENCE_DATA: SHARED');
    expect(parseMetadataScopeEditor(text)).toEqual(scopes);
  });

  it('drops incomplete lines instead of broadening metadata access', () => {
    expect(parseMetadataScopeEditor([
      'ANALYTICS_PROD:',
      ': SALES',
      'REFERENCE_DATA: SHARED',
    ].join('\n'))).toEqual([
      { catalogOrDatabase: 'REFERENCE_DATA', schemas: ['SHARED'] },
    ]);
  });
});
