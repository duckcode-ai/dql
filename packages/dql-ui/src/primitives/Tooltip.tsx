/**
 * Tooltip — Radix wrapper with DQL token styling.
 *
 * Replaces native `title=` usage: faster show delay, proper positioning, and
 * keyboard/screen-reader behavior via Radix. Default delay matches hex.tech
 * (200 ms) — fast enough to feel reactive, slow enough not to spam.
 *
 *   <Tooltip content="Files">
 *     <button>...</button>
 *   </Tooltip>
 *
 * Wrap your app (once) in `<TooltipProvider>` — or rely on the default
 * provider this exports for single-use.
 */
import * as React from 'react';
import * as RTooltip from '@radix-ui/react-tooltip';
import { cssVar, fontSize, radius, space, z } from '../tokens/index.js';

export interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  /** Hover delay in ms. Default 200. */
  delayMs?: number;
  /** Render into a specific container (defaults to document.body). */
  container?: HTMLElement;
}

export function Tooltip({
  content,
  children,
  side = 'right',
  align = 'center',
  sideOffset = 6,
  delayMs = 200,
  container,
}: TooltipProps): React.ReactElement {
  return (
    <RTooltip.Root delayDuration={delayMs}>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal container={container}>
        <RTooltip.Content
          side={side}
          align={align}
          sideOffset={sideOffset}
          style={{
            background: cssVar('surfaceElevated'),
            color: cssVar('textPrimary'),
            border: `1px solid ${cssVar('borderDefault')}`,
            borderRadius: radius.sm,
            padding: `${space[1]} ${space[2]}`,
            fontSize: fontSize.sm,
            boxShadow: cssVar('shadowMd'),
            zIndex: z.tooltip,
            userSelect: 'none',
          }}
        >
          {content}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

/** App-level tooltip provider. Wrap the app root once. */
export const TooltipProvider = RTooltip.Provider;
