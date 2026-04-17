#!/usr/bin/env node
// Publish a new Homebrew formula by filling in dql.rb.tmpl with the
// version + tarball sha256, then pushing to github.com/duckcode-ai/homebrew-dql.
// Invoked from .github/workflows/release.yml after the CLI is published to npm.
//
// Usage: node packaging/homebrew/publish.mjs 0.11.0
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = process.argv[2];
if (!VERSION) { console.error('usage: publish.mjs <version>'); process.exit(2); }

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMPL = resolve(__dirname, 'dql.rb.tmpl');

async function fetchTarballSha(version) {
  const url = `https://registry.npmjs.org/@duckcodeailabs/dql-cli/-/dql-cli-${version}.tgz`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`tarball fetch failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return createHash('sha256').update(buf).digest('hex');
}

const sha = await fetchTarballSha(VERSION);
const rendered = readFileSync(TMPL, 'utf-8')
  .replace(/\{\{VERSION\}\}/g, VERSION)
  .replace(/\{\{SHA\}\}/g, sha);

const out = resolve(__dirname, 'dql.rb');
writeFileSync(out, rendered);
console.log(`✓ wrote ${out} (sha ${sha.slice(0, 12)}…)`);
console.log('\nnext: CI pushes this file to duckcode-ai/homebrew-dql@main');
