#!/usr/bin/env node

import { parseArgs } from './args.js';
import { runParse } from './commands/parse.js';
import { runTest } from './commands/test.js';
import { runCertify } from './commands/certify.js';
import { runInfo } from './commands/info.js';
import { runMigrate } from './commands/migrate.js';
import { runFmt } from './commands/fmt.js';

const HELP = `
  dql — DQL CLI

  Usage:
    dql parse <file.dql>            Parse and analyze a DQL file
    dql test <file.dql>             Inspect block tests
    dql certify <file.dql>          Evaluate certification rules
    dql info <file.dql>             Show block metadata
    dql migrate <source>            Scaffold migration from looker/tableau/dbt/metabase/raw-sql
    dql fmt <file.dql>              Format DQL file in place
    dql --help                      Show this help

  Options:
    --format json|text              Output format (default: text)
    --verbose                       Show detailed output
    --check                         For "fmt": check-only and exit 1 if changes needed
    --input <path>                  Source path for scaffold-style migration commands
`;

async function main() {
  const { command, file, flags } = parseArgs(process.argv.slice(2));

  if (flags.help || !command) {
    console.log(HELP.trim());
    process.exit(0);
  }

  if (!file) {
    console.error('Error: No file/argument specified. Run "dql --help" for usage.');
    process.exit(1);
  }

  try {
    switch (command) {
      case 'parse':
        await runParse(file, flags);
        break;
      case 'test':
        await runTest(file, flags);
        break;
      case 'certify':
        await runCertify(file, flags);
        break;
      case 'info':
        await runInfo(file, flags);
        break;
      case 'migrate':
        await runMigrate(file, flags);
        break;
      case 'fmt':
        await runFmt(file, flags);
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
