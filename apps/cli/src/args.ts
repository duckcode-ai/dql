export interface CLIFlags {
  format: 'text' | 'json';
  verbose: boolean;
  help: boolean;
  version: boolean;
  check: boolean;
  open: boolean | null;
  input: string;
  outDir: string;
  port: number | null;
  chart: string;
  domain: string;
  owner: string;
  queryOnly: boolean;
  template: string;
  connection: string;
  skipTests: boolean;
  force?: boolean;
  http?: boolean;
}

export interface ParsedArgs {
  command: string | null;
  file: string | null;
  rest: string[];
  flags: CLIFlags;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: CLIFlags = {
    format: 'text',
    verbose: false,
    help: false,
    version: false,
    check: false,
    open: null,
    input: '',
    outDir: '',
    port: null,
    chart: '',
    domain: '',
    owner: '',
    queryOnly: false,
    template: '',
    connection: '',
    skipTests: false,
    force: false,
    http: false,
  };

  let command: string | null = null;
  let file: string | null = null;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else if (arg === '--version' || arg === '-V') {
      flags.version = true;
    } else if (arg === '--verbose' || arg === '-v') {
      flags.verbose = true;
    } else if (arg === '--open') {
      flags.open = true;
    } else if (arg === '--no-open') {
      flags.open = false;
    } else if (arg === '--check') {
      flags.check = true;
    } else if (arg === '--format' && i + 1 < argv.length) {
      const fmt = argv[++i];
      if (fmt === 'json' || fmt === 'text') flags.format = fmt;
    } else if (arg === '--input' && i + 1 < argv.length) {
      flags.input = argv[++i];
    } else if (arg === '--out-dir' && i + 1 < argv.length) {
      flags.outDir = argv[++i];
    } else if (arg === '--port' && i + 1 < argv.length) {
      const value = Number(argv[++i]);
      if (Number.isFinite(value) && value > 0) {
        flags.port = value;
      }
    } else if (arg === '--chart' && i + 1 < argv.length) {
      flags.chart = argv[++i];
    } else if (arg === '--domain' && i + 1 < argv.length) {
      flags.domain = argv[++i];
    } else if (arg === '--owner' && i + 1 < argv.length) {
      flags.owner = argv[++i];
    } else if (arg === '--template' && i + 1 < argv.length) {
      flags.template = argv[++i];
    } else if (arg === '--connection' && i + 1 < argv.length) {
      flags.connection = argv[++i];
    } else if (arg === '--query-only') {
      flags.queryOnly = true;
    } else if (arg === '--skip-tests') {
      flags.skipTests = true;
    } else if (arg === '--force' || arg === '-f') {
      flags.force = true;
    } else if (arg === '--http') {
      flags.http = true;
    } else if (!command) {
      command = arg;
    } else if (!file) {
      file = arg;
    } else {
      rest.push(arg);
    }
  }

  return { command, file, rest, flags };
}
