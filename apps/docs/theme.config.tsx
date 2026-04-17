import React from 'react';
import type { DocsThemeConfig } from 'nextra-theme-docs';

const config: DocsThemeConfig = {
  logo: (
    <span style={{ fontWeight: 700, letterSpacing: '-0.01em' }}>
      DQL <span style={{ opacity: 0.55, fontWeight: 500 }}>docs</span>
    </span>
  ),
  project: {
    link: 'https://github.com/duckcode-ai/dql',
  },
  docsRepositoryBase: 'https://github.com/duckcode-ai/dql/tree/main/apps/docs',
  footer: {
    text: (
      <span>
        MIT © {new Date().getFullYear()} DuckCode AI Labs — analytics notebooks on your dbt models.
      </span>
    ),
  },
  sidebar: {
    defaultMenuCollapseLevel: 1,
    toggleButton: true,
  },
  toc: {
    backToTop: true,
  },
  darkMode: true,
  nextThemes: {
    defaultTheme: 'dark',
  },
  head: (
    <>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta property="og:title" content="DQL Docs" />
      <meta
        property="og:description"
        content="Analytics notebooks on your dbt models. Git-native. Local-first."
      />
    </>
  ),
  useNextSeoProps() {
    return { titleTemplate: '%s – DQL' };
  },
};

export default config;
