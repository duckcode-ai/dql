/**
 * Kbd — renders keyboard shortcut chips in the DQL palette and tooltips.
 * Accepts a shortcut string ("⌘K", "Ctrl+Shift+L") or children for custom content.
 */
import * as React from 'react';
import { cssVar, radius, space, fontSize, fontWeight } from '../tokens/index.js';

export interface KbdProps extends React.HTMLAttributes<HTMLElement> {
  /** Optional shortcut text. If present, rendered as the chip's label. */
  shortcut?: string;
  children?: React.ReactNode;
}

export function Kbd({ shortcut, children, style, ...rest }: KbdProps): React.ReactElement {
  return (
    <kbd
      {...rest}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 18,
        height: 18,
        padding: `0 ${space[1]}px`,
        borderRadius: radius.sm,
        border: `1px solid ${cssVar('borderSubtle')}`,
        background: cssVar('surfaceRaised'),
        color: cssVar('textSecondary'),
        fontFamily: 'var(--dql-font-mono, monospace)',
        fontSize: fontSize.xs,
        fontWeight: fontWeight.medium,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {shortcut ?? children}
    </kbd>
  );
}
