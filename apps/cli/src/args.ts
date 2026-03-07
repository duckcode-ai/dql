export interface CLIFlags {
  format: 'text' | 'json';
  verbose: boolean;
  help: boolean;
  check: boolean;
  input: string;
}

export interface ParsedArgs {
  command: string | null;
  file: string | null;
  flags: CLIFlags;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: CLIFlags = {
    format: 'text',
    verbose: false,
    help: false,
    check: false,
    input: '',
  };

  let command: string | null = null;
  let file: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else if (arg === '--verbose' || arg === '-v') {
      flags.verbose = true;
    } else if (arg === '--check') {
      flags.check = true;
    } else if (arg === '--format' && i + 1 < argv.length) {
      const fmt = argv[++i];
      if (fmt === 'json' || fmt === 'text') flags.format = fmt;
    } else if (arg === '--input' && i + 1 < argv.length) {
      flags.input = argv[++i];
    } else if (!command) {
      command = arg;
    } else if (!file) {
      file = arg;
    }
  }

  return { command, file, flags };
}
