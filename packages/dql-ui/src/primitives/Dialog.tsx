/**
 * Dialog — modal dialog primitive.
 *
 * Opinionated defaults: centered, max 560 px wide, token-styled overlay and
 * chrome, escape + click-outside to close (Radix defaults). For wider
 * layouts, pass `maxWidth`; for fullscreen takeovers use a distinct shell.
 *
 *   <Dialog open={open} onOpenChange={setOpen} title="New block">
 *     <p>...form body...</p>
 *   </Dialog>
 */
import * as React from 'react';
import * as RDialog from '@radix-ui/react-dialog';
import { cssVar, fontSize, fontWeight, radius, space, z } from '../tokens/index.js';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  /** Footer actions (buttons). Rendered right-aligned. */
  footer?: React.ReactNode;
  maxWidth?: number | string;
  container?: HTMLElement;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  maxWidth = 560,
  container,
}: DialogProps): React.ReactElement {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal container={container}>
        <RDialog.Overlay
          style={{
            position: 'fixed',
            inset: 0,
            background: cssVar('surfaceOverlay'),
            zIndex: z.overlay,
          }}
        />
        <RDialog.Content
          style={{
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            background: cssVar('surfaceRaised'),
            color: cssVar('textPrimary'),
            border: `1px solid ${cssVar('borderDefault')}`,
            borderRadius: radius.lg,
            boxShadow: cssVar('shadowLg'),
            padding: space[6],
            width: '92vw',
            maxWidth,
            maxHeight: '85vh',
            overflow: 'auto',
            zIndex: z.modal,
            display: 'flex',
            flexDirection: 'column',
            gap: space[4],
          }}
        >
          {title && (
            <RDialog.Title
              style={{
                margin: 0,
                fontSize: fontSize.lg,
                fontWeight: fontWeight.semibold,
              }}
            >
              {title}
            </RDialog.Title>
          )}
          {description && (
            <RDialog.Description
              style={{
                margin: 0,
                fontSize: fontSize.sm,
                color: cssVar('textSecondary'),
              }}
            >
              {description}
            </RDialog.Description>
          )}
          <div>{children}</div>
          {footer && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: space[2],
                marginTop: space[2],
              }}
            >
              {footer}
            </div>
          )}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export const DialogClose = RDialog.Close;
