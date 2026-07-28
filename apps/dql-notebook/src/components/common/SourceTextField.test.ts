import { describe, expect, it } from 'vitest';
import { setDqlSectionBody } from '../../utils/block-studio';

/**
 * Why the Tests box could not take a space or a new line.
 *
 * The field binds value={parsed-from-source} and writes back on every
 * keystroke. The writer normalises as it goes, so the text is re-parsed and
 * handed back minus what was just typed.
 */
describe('source-backed fields normalise on write', () => {
  const source = 'block "x" {\n  domain = "d"\n  tests {\n    assert row_count >= 1\n  }\n}\n';

  it('drops a trailing space, so it can never be typed', () => {
    const typed = 'assert row_count >= 1 ';
    const written = setDqlSectionBody(source, 'tests', typed);
    // The space the user just pressed is gone from the stored source...
    expect(written).not.toContain('assert row_count >= 1 \n');
    // ...so a field re-reading the source would show the value without it,
    // which is exactly the "space does nothing" report.
    expect(written).toContain('assert row_count >= 1');
  });

  it('drops a trailing blank line, so Enter appears to do nothing', () => {
    const written = setDqlSectionBody(source, 'tests', 'assert row_count >= 1\n');
    const body = written.split('tests {')[1] ?? '';
    expect(body).not.toContain('\n\n  }');
  });

  it('still stores interior spaces and multiple assertions', () => {
    // The writer is not wrong to normalise on SAVE — only to feed the
    // normalised value back mid-typing. SourceTextField keeps the typed text
    // local while focused; the source keeps this canonical form.
    const written = setDqlSectionBody(source, 'tests', 'assert row_count >= 1\nassert total revenue >= 0');
    expect(written).toContain('assert row_count >= 1');
    expect(written).toContain('assert total revenue >= 0');
  });
});
