import nextra from 'nextra';

const withNextra = nextra({
  theme: 'nextra-theme-docs',
  themeConfig: './theme.config.tsx',
  defaultShowCopyCode: true,
});

export default withNextra({
  reactStrictMode: true,
  // Docs ship as a static export; Vercel picks up the `out/` directory.
  output: 'export',
  images: { unoptimized: true },
  trailingSlash: true,
});
