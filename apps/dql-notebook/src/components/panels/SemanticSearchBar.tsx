import React, { useState } from 'react';
import type { Theme } from '../../themes/notebook-theme';

interface SemanticSearchBarProps {
  query: string;
  provider: string;
  cube: string;
  owner: string;
  domain: string;
  tag: string;
  type: string;
  providers: string[];
  cubes: string[];
  owners: string[];
  domains: string[];
  tags: string[];
  onQueryChange: (value: string) => void;
  onProviderChange: (value: string) => void;
  onCubeChange: (value: string) => void;
  onOwnerChange: (value: string) => void;
  onDomainChange: (value: string) => void;
  onTagChange: (value: string) => void;
  onTypeChange: (value: string) => void;
  t: Theme;
}

export function SemanticSearchBar({
  query,
  provider,
  cube,
  owner,
  domain,
  tag,
  type,
  providers,
  cubes,
  owners,
  domains,
  tags,
  onQueryChange,
  onProviderChange,
  onCubeChange,
  onOwnerChange,
  onDomainChange,
  onTagChange,
  onTypeChange,
  t,
}: SemanticSearchBarProps) {
  const activeCount =
    (provider ? 1 : 0) +
    (domain ? 1 : 0) +
    (cube ? 1 : 0) +
    (owner ? 1 : 0) +
    (tag ? 1 : 0) +
    (type ? 1 : 0);
  const [open, setOpen] = useState(activeCount > 0);

  const inputStyle: React.CSSProperties = {
    width: '100%',
    background: t.inputBg,
    border: `1px solid ${t.inputBorder}`,
    borderRadius: 6,
    color: t.textPrimary,
    fontSize: 12,
    fontFamily: t.font,
    padding: '7px 10px',
    outline: 'none',
    boxSizing: 'border-box',
  };

  const clearAll = () => {
    onProviderChange('');
    onDomainChange('');
    onCubeChange('');
    onOwnerChange('');
    onTagChange('');
    onTypeChange('');
  };

  return (
    <div style={{ padding: '10px', display: 'flex', flexDirection: 'column', gap: 8, borderBottom: `1px solid ${t.headerBorder}` }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search labels, cubes, owners, tags..."
          style={{ ...inputStyle, flex: 1 }}
        />
        <button
          onClick={() => setOpen((v) => !v)}
          style={{
            background: activeCount > 0 ? `${t.accent}18` : 'transparent',
            border: `1px solid ${activeCount > 0 ? t.accent : t.inputBorder}`,
            borderRadius: 6,
            color: activeCount > 0 ? t.accent : t.textMuted,
            cursor: 'pointer',
            fontSize: 11,
            fontFamily: t.font,
            padding: '6px 10px',
            whiteSpace: 'nowrap',
          }}
          title={open ? 'Hide filters' : 'Show filters'}
        >
          Filters{activeCount > 0 ? ` · ${activeCount}` : ''}
        </button>
      </div>
      {open && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
            <select value={provider} onChange={(event) => onProviderChange(event.target.value)} style={inputStyle}>
              <option value="">All providers</option>
              {providers.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <select value={domain} onChange={(event) => onDomainChange(event.target.value)} style={inputStyle}>
              <option value="">All domains</option>
              {domains.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <select value={cube} onChange={(event) => onCubeChange(event.target.value)} style={inputStyle}>
              <option value="">All cubes</option>
              {cubes.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <select value={owner} onChange={(event) => onOwnerChange(event.target.value)} style={inputStyle}>
              <option value="">All owners</option>
              {owners.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <select value={tag} onChange={(event) => onTagChange(event.target.value)} style={inputStyle}>
              <option value="">All tags</option>
              {tags.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <select value={type} onChange={(event) => onTypeChange(event.target.value)} style={inputStyle}>
              <option value="">All types</option>
              <option value="cube">Cubes</option>
              <option value="metric">Metrics</option>
              <option value="dimension">Dimensions</option>
              <option value="hierarchy">Hierarchies</option>
              <option value="segment">Segments</option>
              <option value="pre_aggregation">Pre-aggregations</option>
            </select>
          </div>
          {activeCount > 0 && (
            <button
              onClick={clearAll}
              style={{
                alignSelf: 'flex-start',
                background: 'transparent',
                border: 'none',
                color: t.textMuted,
                cursor: 'pointer',
                fontSize: 11,
                fontFamily: t.font,
                padding: 0,
                textDecoration: 'underline',
              }}
            >
              Clear filters
            </button>
          )}
        </>
      )}
    </div>
  );
}
