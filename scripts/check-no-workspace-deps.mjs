#!/usr/bin/env node
/**
 * Safety guard: blocks npm/pnpm publish if package.json still contains
 * "workspace:*" dependencies. This prevents broken releases.
 *
 * The release script (release-packages.mjs) resolves workspace:* to real
 * versions before publishing, so this check passes during scripted releases.
 * But if someone runs `npm publish` directly, it will catch the mistake.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkgPath = join(process.cwd(), 'package.json');
const raw = readFileSync(pkgPath, 'utf-8');

if (raw.includes('"workspace:')) {
  console.error('\n  ERROR: package.json contains "workspace:*" dependencies.');
  console.error('  These are not valid on the npm registry and will break installs.\n');
  console.error('  Use the release script instead:');
  console.error('    pnpm release:publish\n');
  process.exit(1);
}
