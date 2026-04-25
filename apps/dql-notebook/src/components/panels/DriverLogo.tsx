import React, { useState } from 'react';

// Each driver lists candidate logo URLs in priority order. We try the
// first; on error fall through to the next. Final fallback is a colored
// swatch using the driver's brand color. Sources:
//   - cdn.simpleicons.org (Simple Icons, CC0) — clean monochrome marks
//   - cdn.jsdelivr.net/gh/devicons/devicon — fills SI's brand-policy gaps
const SI = (slug: string, color: string) =>
  `https://cdn.simpleicons.org/${slug}/${color}`;
const DEV = (folder: string, variant: string) =>
  `https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/${folder}/${folder}-${variant}.svg`;

const SOURCES: Record<string, string[]> = {
  duckdb: [SI('duckdb', 'FFF000')],
  file: [SI('duckdb', 'FFF000')],
  postgres: [SI('postgresql', '4169E1')],
  mysql: [SI('mysql', '4479A1'), DEV('mysql', 'original')],
  sqlite: [SI('sqlite', '003B57'), DEV('sqlite', 'original')],
  mssql: [DEV('microsoftsqlserver', 'original')],
  redshift: [], // SI removed; devicon has no entry — colored swatch
  snowflake: [SI('snowflake', '29B5E8')],
  bigquery: [SI('googlebigquery', '4285F4'), DEV('googlecloud', 'plain')],
  databricks: [SI('databricks', 'FF3621')],
  clickhouse: [SI('clickhouse', 'FFCC01')],
  trino: [SI('trino', 'DD00A1')],
  athena: [DEV('amazonwebservices', 'plain-wordmark')],
  fabric: [DEV('azure', 'original')],
};

const FALLBACK_COLORS: Record<string, string> = {
  duckdb: '#f4bc00',
  file: '#f4bc00',
  postgres: '#336791',
  bigquery: '#4285f4',
  snowflake: '#29b5e8',
  sqlite: '#003b57',
  mysql: '#00758f',
  mssql: '#cc2927',
  redshift: '#8c4fff',
  databricks: '#ff3621',
  clickhouse: '#ffcc00',
  athena: '#ff9900',
  trino: '#dd00a1',
  fabric: '#0078d4',
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
