/**
 * Popover — inline panel anchored to a trigger. Unlike Dialog, does not
 * block the page and does not own focus aggressively. Used for hover cards,
 * contextual inspectors, and quick-edit panels.
 *
 *   <Popover>
 *     <PopoverTrigger asChild><button>Details</button></PopoverTrigger>
 *     <PopoverContent>...</PopoverContent>
 *   </Popover>
 */
import * as React from 'react';
import * as RPopover from '@radix-ui/react-popover';
import { cssVar, radius, space, z } from '../tokens/index.js';

export const Popover = RPopover.Root;
export const PopoverTrigger = RPopover.Trigger;
export const PopoverAnchor = RPopover.Anchor;
export const PopoverClose = RPopover.Close;

export interface PopoverContentProps
  extends React.ComponentPropsWithoutRef<typeof RPopover.Content> {
  container?: HTMLElement;
}

export const PopoverContent = React.forwardRef<
  React.ElementRef<typeof RPopover.Content>,
  PopoverContentProps
>(({ container, style, sideOffset = 6, ...rest }, ref) => (
  <RPopover.Portal container={container}>
    <RPopover.Content
      ref={ref}
      sideOffset={sideOffset}
      style={{
        background: cssVar('surfaceElevated'),
        color: cssVar('textPrimary'),
        border: `1px solid ${cssVar('borderDefault')}`,
        borderRadius: radius.md,
        boxShadow: cssVar('shadowMd'),
        padding: space[3],
        zIndex: z.popover,
        minWidth: 220,
        ...style,
      }}
      {...rest}
    />
  </RPopover.Portal>
));
PopoverContent.displayName = 'PopoverContent';
