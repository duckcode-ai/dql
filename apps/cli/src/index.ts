#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './args.js';
import { runInit } from './commands/init.js';
import { runNew } from './commands/new.js';
import { runBuild } from './commands/build.js';
import { runDoctor } from './commands/doctor.js';
import { runPreview } from './commands/preview.js';
import { runServe } from './commands/serve.js';
import { runParse } from './commands/parse.js';
import { runTest } from './commands/test.js';
import { runCertify } from './commands/certify.js';
import { runInfo } from './commands/info.js';
import { runMigrate } from './commands/migrate.js';
import { runFmt } from './commands/fmt.js';
import { runNotebook } from './commands/notebook.js';
import { runValidate } from './commands/validate.js';
import { runSemantic } from './commands/semantic.js';
import { runLineage } from './commands/lineage.js';
import { runCompile } from './commands/compile.js';
import { runSync } from './commands/sync.js';
import { runDiff } from './commands/diff.js';
import { runMcp } from './commands/mcp.js';
import { runApp } from './commands/app.js';

const HELP = `
  dql — DQL CLI

  Usage:
    dql init [directory]             Initialize DQL in a project (auto-detects dbt)
    dql new <type> <name>           Create a new block, semantic block, dashboard, or workbook
    dql build <file.dql>            Compile a DQL file to a static HTML bundle
    dql doctor [path]               Run local setup checks for a DQL project
    dql preview <file.dql>          Render a local browser preview for a DQL file
    dql serve [directory]           Serve a built DQL bundle locally
    dql parse <file.dql>            Parse and analyze a DQL file
    dql test <file.dql>             [deprecated] Use dql certify --connection instead
    dql validate [path]             Validate all DQL files and semantic references
    dql certify <file.dql>          Evaluate certification rules
    dql info <file.dql>             Show block metadata
    dql migrate <source>            Scaffold migration from looker/tableau/dbt/metabase/raw-sql
    dql migrate format [--check]    Upgrade all .dql/.dqlnb files to canonical format
    dql fmt <file.dql|.dqlnb>       Format DQL/notebook file in place
    dql diff <path>                 Diff a .dql/.dqlnb file vs HEAD
    dql diff <before> <after>       Semantic diff between two files
    dql notebook [path]             Launch the browser-first notebook for a project
    dql semantic <sub> [path]       Semantic layer: list, validate, query, pull
    dql compile [path]              Generate project manifest (dql-manifest.json)
    dql sync dbt [path]             Detect dbt manifest changes; report DQL cache status
    dql lineage [block] [path]      Answer-layer lineage analysis
    dql mcp [--http]                Run the DQL MCP server (stdio by default; --http = loopback)
    dql app new|ls|show <name>      Manage App artifacts (domain-scoped notebook + dashboard bundles)
    dql --version                    Show version
    dql --help                      Show this help

  Options:
    --format json|text              Output format (default: text)
    --verbose                       Show detailed output
    --open                          Open the preview or served bundle in a browser
    --no-open                       Do not open the browser automatically
    --check                         For "fmt": check-only and exit 1 if changes needed
    --input <path>                  Source path for scaffold-style migration commands
    --out-dir <path>                Output directory for "build"
    --port <number>                 Preferred local port for "preview" or "serve"
    --chart <type>                  Primary chart type for "new" scaffolds (default: bar)
    --domain <name>                 Domain for new block scaffolds (default: general)
    --owner <name>                  Owner for new block scaffolds (default: current user)
    --query-only                    Create a query-only block without visualization
    --connection <driver|path>      Database connection for certify/test (e.g. duckdb, path/to/db)
`;

function getVersion(): string {
  try {
    const cliDir = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(cliDir, '../package.json'), 'utf-8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function main() {
  const { command, file, rest, flags } = parseArgs(process.argv.slice(2));

  if (flags.version) {
    console.log(`dql ${getVersion()}`);
    process.exit(0);
  }

  if (flags.help || !command) {
    console.log(HELP.trim());
    process.exit(0);
  }

  if (!file && command !== 'init' && command !== 'serve' && command !== 'doctor' && command !== 'notebook' && command !== 'validate' && command !== 'semantic' && command !== 'lineage' && command !== 'compile' && command !== 'sync' && command !== 'mcp' && command !== 'app') {
    console.error('Error: No file/argument specified. Run "dql --help" for usage.');
    process.exit(1);
  }

  try {
    switch (command) {
      case 'init':
        await runInit(file, flags);
        break;
      case 'new':
        await runNew(file, rest, flags);
        break;
      case 'build':
        await runBuild(file!, flags);
        break;
      case 'doctor':
        await runDoctor(file, flags);
        break;
      case 'parse':
        await runParse(file!, flags);
        break;
      case 'preview':
        await runPreview(file!, flags);
        break;
      case 'serve':
        await runServe(file, flags);
        break;
      case 'test':
        await runTest(file!, flags);
        break;
      case 'certify':
        await runCertify(file!, flags);
        break;
      case 'info':
        await runInfo(file!, flags);
        break;
      case 'migrate':
        await runMigrate(file!, flags);
        break;
      case 'fmt':
        await runFmt(file!, flags);
        break;
      case 'notebook':
        await runNotebook(file, flags);
        break;
      case 'validate':
        await runValidate(file, flags);
        break;
      case 'semantic':
        await runSemantic(file, rest, flags);
        break;
      case 'compile':
        await runCompile(file, rest, flags);
        break;
      case 'sync':
        await runSync(file, rest, flags);
        break;
      case 'lineage':
        await runLineage(file, rest, flags);
        break;
      case 'diff':
        await runDiff(file, rest, flags);
        break;
      case 'mcp':
        await runMcp(file, flags);
        break;
      case 'app':
        await runApp(file, rest, flags);
        break;
      default:
        console.error(`Unknown command: ${command}. Run "dql --help" for usage.`);
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();
