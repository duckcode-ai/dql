#!/usr/bin/env node
// Simple internal-link checker. Scans every .mdx under pages/ for markdown
// links like [text](/path/) and verifies each target resolves to an mdx
// file or directory with an index.mdx. Run in CI to catch rot.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PAGES = resolve(__dirname, '..', 'pages');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (entry.endsWith('.mdx') || entry.endsWith('.md')) out.push(p);
  }
  return out;
}

function resolveTarget(target) {
  // strip trailing slash + #anchor
  const clean = target.replace(/#.*$/, '').replace(/\/$/, '');
  if (!clean) return true; // pure anchor
  const base = join(PAGES, clean);
  if (existsSync(`${base}.mdx`)) return true;
  if (existsSync(`${base}.md`)) return true;
  if (existsSync(`${base}/index.mdx`)) return true;
  if (existsSync(`${base}/index.md`)) return true;
  return false;
}

const files = walk(PAGES);
const errors = [];
const linkRe = /\[[^\]]+\]\((\/[^)]+)\)/g;

for (const f of files) {
  const content = readFileSync(f, 'utf-8');
  for (const match of content.matchAll(linkRe)) {
    const href = match[1];
    if (href.startsWith('http')) continue;
    if (!resolveTarget(href)) {
      errors.push(`${f.replace(PAGES, 'pages')}: broken link ${href}`);
    }
  }
}

if (errors.length) {
  console.error(`\n${errors.length} broken internal link(s):\n`);
  for (const e of errors) console.error('  ' + e);
  process.exit(1);
}
console.log(`✓ ${files.length} pages checked, 0 broken internal links`);
