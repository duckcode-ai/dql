// v1.3 Track 3 — DQL-specific glyph factory.
//
// Generic icons (Play, Search, Database, etc.) come from lucide-react;
// domain-specific DQL concepts (block, certified, lineage node, cell
// types that don't map 1:1 onto Lucide glyphs) live here so they share
// a consistent stroke-width + size contract with Lucide and re-theme via
// `currentColor`.
//
// All DQL glyphs use stroke="currentColor" fill="none" so their color
// tracks the parent text color — toggling data-theme recolors them
// without component edits.

import React from 'react';

export type IconProps = React.SVGProps<SVGSVGElement> & {
  size?: number | string;
};

type IconRenderer = (p: IconProps) => React.ReactElement;

function createIcon(paths: React.ReactNode, viewBox = '0 0 24 24'): IconRenderer {
  return function Icon({ size = 16, strokeWidth = 1.75, ...rest }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox={viewBox}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth as number}
        strokeLinecap="round"
        strokeLinejoin="round"
        {...rest}
      >
        {paths}
      </svg>
    );
  };
}

// Block — stylized stacked rectangles (certified block artifact)
export const BlockIcon = createIcon(
  <>
    <rect x="3" y="3" width="8" height="8" rx="1.5" />
    <rect x="13" y="3" width="8" height="8" rx="1.5" />
    <rect x="3" y="13" width="8" height="8" rx="1.5" />
    <rect x="13" y="13" width="8" height="8" rx="1.5" />
  </>
);

// Certified shield
export const CertifiedShieldIcon = createIcon(
  <>
    <path d="M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5l8-3z" />
    <path d="M9 12l2 2 4-4" />
  </>
);

// Lineage node — three nodes connected
export const LineageNodeIcon = createIcon(
  <>
    <circle cx="5" cy="12" r="2" />
    <circle cx="19" cy="5" r="2" />
    <circle cx="19" cy="19" r="2" />
    <path d="M7 12l10-6M7 12l10 6" />
  </>
);

// Cell-type icons
export const SQLCellIcon = createIcon(
  <>
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
    <path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
  </>
);

export const DQLCellIcon = createIcon(
  <>
    <path d="M4 4h8a8 8 0 010 16H4z" />
    <path d="M16 20l4 4" />
  </>
);

export const ChartCellIcon = createIcon(
  <>
    <path d="M3 3v18h18" />
    <path d="M7 15l4-4 4 4 5-7" />
  </>
);

export const PivotCellIcon = createIcon(
  <>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18M9 3v18" />
  </>
);

export const SingleValueCellIcon = createIcon(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M8 12h8M12 8v8" />
  </>
);

export const ParamCellIcon = createIcon(
  <>
    <path d="M4 7h16M4 12h16M4 17h10" />
    <circle cx="18" cy="17" r="2" />
  </>
);

export const FilterCellIcon = createIcon(
  <>
    <path d="M3 5h18l-7 9v5l-4-2v-3L3 5z" />
  </>
);

export const WritebackCellIcon = createIcon(
  <>
    <path d="M4 4h10l6 6v10H4z" />
    <path d="M14 4v6h6" />
    <path d="M8 14l3 3 5-5" />
  </>
);

export const ChatCellIcon = createIcon(
  <>
    <path d="M21 12a8 8 0 01-11.5 7.2L4 21l1.8-5.5A8 8 0 1121 12z" />
  </>
);
