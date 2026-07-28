import React, { useEffect, useRef, useState } from 'react';

/**
 * Text input for a comma-separated list.
 *
 * Fields like tags, exclusions, and preferred dimensions used to bind
 * `value={list.join(', ')}` and re-parse on every keystroke:
 *
 *   value={tags.join(', ')}
 *   onChange={(e) => setTags(e.target.value.split(',').map((t) => t.trim()).filter(Boolean))}
 *
 * That makes the field impossible to type a second item into. Typing the comma
 * produces a trailing empty segment which `.filter(Boolean)` drops, so the comma
 * is erased as soon as it is typed; and the space after a comma is removed by
 * `.trim()`, so it never appears either. The user sees characters vanish and
 * concludes the box is broken — which it was.
 *
 * The text being typed is local state and is never overwritten while the field
 * has focus. The parsed list is still published on every change, so callers stay
 * live and nothing needs a blur or a save to register.
 */
export function CommaListInput({
  values,
  onChange,
  placeholder,
  style,
  ariaLabel,
  title,
  disabled,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  style?: React.CSSProperties;
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
}) {
  const joined = values.join(', ');
  const [text, setText] = useState(joined);
  const focused = useRef(false);

  // Accept outside edits (a different block loaded, an AI draft applied), but
  // never while typing — that is exactly what used to eat the keystrokes.
  useEffect(() => {
    if (!focused.current) setText(joined);
  }, [joined]);

  return (
    <input
      type="text"
      value={text}
      disabled={disabled}
      aria-label={ariaLabel}
      title={title}
      placeholder={placeholder}
      style={style}
      onFocus={() => { focused.current = true; }}
      onBlur={() => {
        focused.current = false;
        // Settle to the canonical rendering once the user is done.
        setText(parseCommaList(text).join(', '));
      }}
      onChange={(event) => {
        setText(event.target.value);
        onChange(parseCommaList(event.target.value));
      }}
    />
  );
}

/** The list a piece of comma-separated text denotes. */
export function parseCommaList(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}
