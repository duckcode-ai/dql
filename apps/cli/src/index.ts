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
import { runSchedule } from './commands/schedule.js';
import { runAgent } from './commands/agent.js';
import { runSlack } from './commands/slack.js';
import { runVerify } from './commands/verify.js';
import { runImport } from './commands/import.js';

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
    dql certify --from-draft <path> Promote a Tier-2 draft block to certified
                                    (auto-flips status, sets datalex_contract,
                                     surfaces datalex-manifest.json patch)
    dql info <file.dql>             Show block metadata
    dql migrate <source>            Scaffold migration from looker/tableau/dbt/metabase/raw-sql
    dql migrate format [--check]    Upgrade all .dql/.dqlnb files to canonical format
    dql import sql <path>           Preview SQL files/folders as draft Block Studio import candidates
    dql fmt <file.dql|.dqlnb>       Format DQL/notebook file in place
    dql diff <path>                 Diff a .dql/.dqlnb file vs HEAD
    dql diff <before> <after>       Semantic diff between two files
    dql notebook [path]             Launch the browser-first notebook for a project
    dql semantic <sub> [path]       Semantic layer: list, validate, query, pull
    dql compile [path]              Generate project manifest (dql-manifest.json)
    dql sync dbt [path]             Detect dbt manifest changes; report DQL cache status
    dql lineage [block] [path]      Answer-layer lineage analysis
    dql mcp [--http]                Run the DQL MCP server (stdio by default; --http = loopback)
    dql app new|ls|show|build|reindex <name>
                                    Manage App artifacts (metadata, policies, dashboards, schedules)
    dql schedule list|run|start|status  Local scheduler for @schedule'd blocks (alerts + notifications)
    dql agent ask "<question>"      Block-first agent loop (certified blocks → fallback LLM SQL)
    dql agent reindex               Rebuild .dql/cache/agent-kg.sqlite
    dql agent feedback up|down      Record thumbs-up/down feedback for self-learning
    dql slack serve                 Slack slash-command bot (forwards to the answer loop)
    dql verify                      Verify dql-manifest.json is reproducible from source
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
    --from-draft <path>             For "certify": promote a Tier-2 draft block to certified
    --contract <id@version>         For "certify --from-draft": DataLex contract id (e.g. commerce.Customer.foo@1)
    --open-pr                       For "certify --from-draft": push branch + open GitHub PR with the diff
    --force                         For "certify --from-draft": overwrite an existing certified block
`;

const COMMAND_HELP: Record<string, string> = {
  certify: `
  dql certify — Evaluate local certification rules

  Usage:
    dql certify <file.dql> [--connection <driver|path>] [--skip-tests]
    dql certify --from-draft <path> [--contract <id@version>] [--force]

  Notes:
    Certification is a local OSS trust label. Use status = "certified" for
    blocks that pass metadata, lineage, and test checks.
  `,
  app: `
  dql app — Manage local App artifacts

  Usage:
    dql app new <name>
    dql app ls
    dql app show <name>
    dql app build <name>
    dql app reindex
  `,
  compile: `
  dql compile — Generate dql-manifest.json

  Usage:
    dql compile [path] [--dbt-manifest <path>] [--dbt-hops <n>] [--no-cache]

  dql-manifest.json is the dbt-like compiled artifact for blocks, notebooks,
  Apps, dashboards, semantic objects, sources, dbt imports, and lineage.
  `,
  doctor: `
  dql doctor — Check a local DQL project

  Usage:
    dql doctor [path] [--format json]

  Prints setup checks and the next local-first commands to run.
  `,
  semantic: `
  dql semantic — Work with the local semantic layer

  Usage:
    dql semantic list [path]
    dql semantic validate [path]
    dql semantic query <metrics> [dimensions]
  `,
  verify: `
  dql verify — Verify dql-manifest.json is reproducible

  Usage:
    dql verify [path] [--dbt-manifest <path>] [--dbt-hops <n>] [--format json]

  Run after dql compile in CI or before release commits.
  `,
};

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
    console.log((command && COMMAND_HELP[command] ? COMMAND_HELP[command] : HELP).trim());
    process.exit(0);
  }

  const commandAllowsNoFile = command === 'init' || command === 'serve' || command === 'doctor'
    || command === 'notebook' || command === 'validate' || command === 'semantic'
    || command === 'lineage' || command === 'compile' || command === 'sync'
    || command === 'mcp' || command === 'app' || command === 'schedule'
    || command === 'verify' || (command === 'certify' && Boolean(flags.fromDraft));
  if (!file && !commandAllowsNoFile) {
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
        await runCertify(file ?? '', flags);
        break;
      case 'info':
        await runInfo(file!, flags);
        break;
      case 'migrate':
        await runMigrate(file!, flags);
        break;
      case 'import':
        await runImport(file!, rest, flags);
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
      case 'schedule':
        await runSchedule(file, rest, flags);
        break;
      case 'agent':
        await runAgent(file, rest, flags);
        break;
      case 'slack':
        await runSlack(file, rest, flags);
        break;
      case 'verify':
        await runVerify(file, rest, flags);
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
