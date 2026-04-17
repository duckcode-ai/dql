#!/usr/bin/env node
// create-dql-app — self-contained scaffolder.
//
// Contract (from the v1.0 "demo gate"): on a clean machine, `npx
// create-dql-app` followed by `cd … && npx @duckcodeailabs/dql-cli notebook`
// produces a running notebook in under 5 minutes.
//
// Design: this package writes template files *itself* rather than
// delegating to `dql init`, so it stays self-contained and installable
// with zero-peer-dep friction. Templates live under ../templates/ and are
// copied verbatim.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '0.11.0';
const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(__dirname, '..', 'templates');

// Tiny ANSI helpers — no dep on chalk/kleur so the bin runs before
// `npm install` finishes on slow machines.
const c = {
  cyan:   (s) => `\x1b[36m${s}\x1b[0m`,
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
};

function usage() {
  console.log(`create-dql-app ${VERSION}

Usage:
  npx create-dql-app <project-dir> [options]

Options:
  --template <name>   Starter template: jaffle-shop (default), empty
  --help, -h          Show this help
  --version, -v       Show version

Examples:
  npx create-dql-app my-analytics
  npx create-dql-app finance-reports --template empty
`);
}

function parseArgs(argv) {
  const args = { dir: null, template: 'jaffle-shop' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    if (a === '--version' || a === '-v') { console.log(VERSION); process.exit(0); }
    if (a === '--template') { args.template = argv[++i]; continue; }
    if (a.startsWith('--')) { console.error(`Unknown flag: ${a}`); process.exit(2); }
    if (!args.dir) args.dir = a;
  }
  return args;
}

function isEmptyDir(dir) {
  try { return readdirSync(dir).length === 0; } catch { return true; }
}

function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dst, entry);
    if (statSync(s).isDirectory()) copyDir(s, d);
    else writeFileSync(d, readFileSync(s));
  }
}

function substitute(file, vars) {
  const raw = readFileSync(file, 'utf-8');
  const out = raw.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
  if (out !== raw) writeFileSync(file, out, 'utf-8');
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function detectDbtSibling(target) {
  // Walk up 2 levels looking for a dbt_project.yml — common layout is
  // myproject/dql + myproject/dbt, or myproject with dbt + dql as siblings.
  for (const rel of ['..', '../..', '../dbt', '../../dbt']) {
    const probe = resolve(target, rel, 'dbt_project.yml');
    if (existsSync(probe)) return resolve(target, rel);
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir) {
    console.error('Error: project directory is required.\n');
    usage();
    process.exit(2);
  }

  const target = resolve(process.cwd(), args.dir);
  const projectName = basename(target);

  if (existsSync(target) && !isEmptyDir(target)) {
    console.error(c.red(`✗ Target directory "${args.dir}" exists and is not empty.`));
    process.exit(1);
  }

  const tplDir = join(TEMPLATES_DIR, args.template);
  if (!existsSync(tplDir)) {
    console.error(c.red(`✗ Unknown template: ${args.template}`));
    console.error(`   Available: ${readdirSync(TEMPLATES_DIR).join(', ')}`);
    process.exit(1);
  }

  console.log(c.cyan(`\n⌁ create-dql-app ${VERSION}`));
  console.log(`  scaffolding ${c.bold(projectName)} (template: ${c.bold(args.template)})\n`);

  copyDir(tplDir, target);

  const dbtSibling = detectDbtSibling(target);
  const vars = {
    PROJECT_NAME: projectName,
    YEAR: String(new Date().getFullYear()),
    DBT_PROJECT_DIR: dbtSibling ? resolve(dbtSibling) : '../my-dbt-project',
    DBT_DETECTED: dbtSibling ? 'true' : 'false',
  };
  for (const f of walk(target)) substitute(f, vars);

  if (dbtSibling) {
    console.log(c.dim(`  detected sibling dbt project at ${dbtSibling}`));
    console.log(c.dim(`  wired into cdql.yaml — run 'dql sync dbt' to import\n`));
  }

  // Best-effort: try to run `git init` so users get a clean first commit.
  const gitResult = spawnSync('git', ['init', '-q'], { cwd: target });
  if (gitResult.status === 0) console.log(c.dim('  initialized git repo'));

  console.log(`
${c.green('✓ Ready.')} Next steps:

  ${c.bold(`cd ${args.dir}`)}
  ${c.bold('npx @duckcodeailabs/dql-cli notebook')}

Your notebook will open at ${c.cyan('http://localhost:5173')}.

Docs:   ${c.cyan('https://docs.duckcode.ai')}
Issues: ${c.cyan('https://github.com/duckcode-ai/dql/issues')}
`);
}

main().catch((e) => {
  console.error(c.red(`\n✗ ${e.message}`));
  process.exit(1);
});
