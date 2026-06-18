import React, { useState } from 'react';

// Each driver lists candidate logo URLs in priority order. We try the
// first; on error fall through to the next. Final fallback is a colored
// swatch using the driver's brand color. Sources:
//   - cdn.simpleicons.org (Simple Icons, CC0) — clean monochrome marks
const SI = (slug: string, color: string) =>
  `https://cdn.simpleicons.org/${slug}/${color}`;

const SOURCES: Record<string, string[]> = {
  duckdb: [SI('duckdb', 'FFF000')],
  file: [SI('duckdb', 'FFF000')],
  snowflake: [SI('snowflake', '29B5E8')],
  databricks: [SI('databricks', 'FF3621')],
};

const FALLBACK_COLORS: Record<string, string> = {
  duckdb: '#f4bc00',
  file: '#f4bc00',
  snowflake: '#29b5e8',
  databricks: '#ff3621',
};

interface DriverLogoProps {
  driver: string;
  size?: number;
  fallbackColor?: string;
}

function Swatch({ size, color }: { size: number; color: string }) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: 3,
        background: color,
        flexShrink: 0,
        display: 'inline-block',
      }}
    />
  );
}

export function DriverLogo({ driver, size = 16, fallbackColor }: DriverLogoProps) {
  const sources = SOURCES[driver] ?? [];
  const swatch = fallbackColor ?? FALLBACK_COLORS[driver] ?? '#888';
  const [idx, setIdx] = useState(0);

  if (sources.length === 0 || idx >= sources.length) {
    return <Swatch size={size} color={swatch} />;
  }

  return (
    <img
      src={sources[idx]}
      alt={`${driver} logo`}
      width={size}
      height={size}
      loading="lazy"
      onError={() => setIdx(idx + 1)}
      style={{ flexShrink: 0, display: 'block', objectFit: 'contain' }}
    />
  );
}
