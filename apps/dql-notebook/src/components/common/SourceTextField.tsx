import React, { useEffect, useRef, useState } from 'react';

/**
 * A field whose value lives in the DQL source text.
 *
 * These bind `value={parseFromSource(source)}` and write back with
 * `onChange={(e) => setSource(writeIntoSource(source, e.target.value))}`. The
 * writers normalise as they go — `setDqlSectionBody` runs `.trim()` on the body
 * and `.trimEnd()` on every line — so the text is re-parsed and handed straight
 * back minus whatever was just typed. A trailing space or a new blank line can
 * never survive: press space at the end of an assertion in the Tests box and
 * nothing happens.
 *
 * The typed text is local state and is never overwritten while the field has
 * focus. The source is still updated on every keystroke, so validation,
 * preview and save stay live; only the round-tripped value is held back.
 */
export function SourceTextField({
  value,
  onChange,
  multiline,
  placeholder,
  style,
  ariaLabel,
  rows,
}: {
  /** Current value as parsed from the source. */
  value: string;
  /** Receives the raw typed text; the caller writes it into the source. */
  onChange: (next: string) => void;
  multiline?: boolean;
  placeholder?: string;
  style?: React.CSSProperties;
  ariaLabel?: string;
  rows?: number;
}) {
  const [text, setText] = useState(value);
  const focused = useRef(false);

  // Accept outside edits (a different block opened, an AI draft applied) but
  // never mid-typing — that is exactly what used to eat the keystrokes.
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);

  const shared = {
    value: text,
    placeholder,
    style,
    'aria-label': ariaLabel,
    onFocus: () => { focused.current = true; },
    onBlur: () => {
      focused.current = false;
      // Settle to whatever the source actually stored.
      setText(value);
    },
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setText(event.target.value);
      onChange(event.target.value);
    },
  };

  return multiline
    ? <textarea {...shared} rows={rows} />
    : <input type="text" {...shared} />;
}
