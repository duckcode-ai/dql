import React from 'react';
import { postDqlCloudEvent } from '../../cloud/cloud-mode';
import { themes } from '../../themes/notebook-theme';
import type { ThemeMode } from '../../themes/notebook-theme';

interface CloudFocusHeaderProps {
  title: string;
  subtitle?: string;
  themeMode: ThemeMode;
  right?: React.ReactNode;
}

export function CloudFocusHeader({
  title,
  subtitle,
  themeMode,
  right,
}: CloudFocusHeaderProps) {
  const t = themes[themeMode];
  const goBack = () => {
    window.location.hash = '/notebooks';
    postDqlCloudEvent('dql.cloud.back', { target: 'build' });
  };
  return (
    <div
      style={{
        height: 58,
        flexShrink: 0,
        borderBottom: `1px solid ${t.headerBorder}`,
        background: '#ffffff',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '0 16px',
      }}
    >
      <button
        onClick={goBack}
        style={{
          height: 34,
          borderRadius: 7,
          border: `1px solid ${t.btnBorder}`,
          background: '#ffffff',
          color: t.textSecondary,
          cursor: 'pointer',
          fontFamily: t.font,
          fontSize: 13,
          fontWeight: 700,
          padding: '0 10px',
        }}
      >
        ← Back to DQL
      </button>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 18, fontWeight: 800, color: t.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {title}
        </div>
        {subtitle && (
          <div style={{ marginTop: 2, fontSize: 12, color: t.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {subtitle}
          </div>
        )}
      </div>
      {right}
    </div>
  );
}
