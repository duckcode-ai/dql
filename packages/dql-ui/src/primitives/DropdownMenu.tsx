/**
 * DropdownMenu — action menu triggered by a button/icon.
 *
 * Thin wrapper over Radix with token styling. Exposes the composition pieces
 * so call sites can build arbitrary menu structures:
 *
 *   <DropdownMenu>
 *     <DropdownMenuTrigger asChild><button>Actions</button></DropdownMenuTrigger>
 *     <DropdownMenuContent>
 *       <DropdownMenuItem onSelect={...}>Run</DropdownMenuItem>
 *       <DropdownMenuSeparator />
 *       <DropdownMenuItem>Duplicate</DropdownMenuItem>
 *     </DropdownMenuContent>
 *   </DropdownMenu>
 */
import * as React from 'react';
import * as RMenu from '@radix-ui/react-dropdown-menu';
import { cssVar, fontSize, radius, space, z } from '../tokens/index.js';

export const DropdownMenu = RMenu.Root;
export const DropdownMenuTrigger = RMenu.Trigger;
export const DropdownMenuGroup = RMenu.Group;

export interface DropdownMenuContentProps
  extends React.ComponentPropsWithoutRef<typeof RMenu.Content> {
  container?: HTMLElement;
}

export const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof RMenu.Content>,
  DropdownMenuContentProps
>(({ container, style, sideOffset = 4, ...rest }, ref) => (
  <RMenu.Portal container={container}>
    <RMenu.Content
      ref={ref}
      sideOffset={sideOffset}
      style={{
        minWidth: 180,
        background: cssVar('surfaceElevated'),
        color: cssVar('textPrimary'),
        border: `1px solid ${cssVar('borderDefault')}`,
        borderRadius: radius.md,
        boxShadow: cssVar('shadowMd'),
        padding: space[1],
        zIndex: z.popover,
        ...style,
      }}
      {...rest}
    />
  </RMenu.Portal>
));
DropdownMenuContent.displayName = 'DropdownMenuContent';

export const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof RMenu.Item>,
  React.ComponentPropsWithoutRef<typeof RMenu.Item>
>(({ style, ...rest }, ref) => (
  <RMenu.Item
    ref={ref}
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: space[2],
      padding: `${space[1]} ${space[2]}`,
      fontSize: fontSize.sm,
      borderRadius: radius.sm,
      cursor: 'default',
      outline: 'none',
      userSelect: 'none',
      ...style,
    }}
    {...rest}
  />
));
DropdownMenuItem.displayName = 'DropdownMenuItem';

export const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof RMenu.Separator>,
  React.ComponentPropsWithoutRef<typeof RMenu.Separator>
>(({ style, ...rest }, ref) => (
  <RMenu.Separator
    ref={ref}
    style={{
      height: 1,
      background: cssVar('borderSubtle'),
      margin: `${space[1]} 0`,
      ...style,
    }}
    {...rest}
  />
));
DropdownMenuSeparator.displayName = 'DropdownMenuSeparator';

export const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof RMenu.Label>,
  React.ComponentPropsWithoutRef<typeof RMenu.Label>
>(({ style, ...rest }, ref) => (
  <RMenu.Label
    ref={ref}
    style={{
      padding: `${space[1]} ${space[2]}`,
      fontSize: fontSize.xs,
      color: cssVar('textMuted'),
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
      ...style,
    }}
    {...rest}
  />
));
DropdownMenuLabel.displayName = 'DropdownMenuLabel';
