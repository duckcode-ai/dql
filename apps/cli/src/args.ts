export interface CLIFlags {
  format: 'text' | 'json';
  verbose: boolean;
  help: boolean;
  version: boolean;
  check: boolean;
  open: boolean | null;
  input: string;
  outDir: string;
  to?: string;
  dryRun?: boolean;
  port: number | null;
  /** HTTP bind host. Defaults to 127.0.0.1; set to 0.0.0.0 inside containers. */
  host?: string | null;
  chart: string;
  domain: string;
  owner: string;
  queryOnly: boolean;
  template: string;
  connection: string;
  skipTests: boolean;
  save?: boolean;
  force?: boolean;
  http?: boolean;
  /** `dql certify --from-draft <path>` — promote a Tier-2 draft to certified. */
  fromDraft?: string;
  /** `--contract <id@version>` — DataLex contract id to bind during certify. */
  contract?: string;
  /** Optional path to datalex-manifest.json for datalex_contract validation. */
  datalexManifestPath?: string;
  /** `--open-pr` — push a branch + open a GitHub PR with the promotion diff. */
  openPr?: boolean;
  /** Agent/provider selection, e.g. ollama/openai/claude/gemini. */
  provider?: string;
  /** Optional agent user id for memory/feedback attribution. */
  user?: string;
  /** Local runtime URL for agent block execution. */
  runtimeUrl?: string;
  runtime?: string;
  /** Execute generated SQL previews during eval. Default false for route-only eval. */
  execute?: boolean;
  /** Include AI provider, MCP, and metadata checks in `dql doctor`. */
  ai?: boolean;
  /** Enforce enterprise-ready certification requirements. */
  enterprise?: boolean;
  /** Ask app generation to use the richer GenUI planning mode when available. */
  aiLayout?: boolean;
  /** Agent feedback helpers. */
  block?: string;
  question?: string;
  comment?: string;
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
    host: null,
    chart: '',
    domain: '',
    owner: '',
    queryOnly: false,
    template: '',
    connection: '',
    skipTests: false,
    save: false,
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
    } else if (arg === '--to' && i + 1 < argv.length) {
      flags.to = argv[++i];
    } else if (arg === '--dry-run') {
      flags.dryRun = true;
    } else if (arg === '--port' && i + 1 < argv.length) {
      const value = Number(argv[++i]);
      if (Number.isFinite(value) && value > 0) {
        flags.port = value;
      }
    } else if (arg === '--host' && i + 1 < argv.length) {
      flags.host = argv[++i];
    } else if (arg === '--chart' && i + 1 < argv.length) {
      flags.chart = argv[++i];
    } else if (arg === '--domain' && i + 1 < argv.length) {
      flags.domain = argv[++i];
    } else if (arg === '--owner' && i + 1 < argv.length) {
      flags.owner = argv[++i];
    } else if ((arg === '--template' || arg === '--pattern') && i + 1 < argv.length) {
      flags.template = argv[++i];
    } else if (arg === '--connection' && i + 1 < argv.length) {
      flags.connection = argv[++i];
    } else if (arg === '--query-only') {
      flags.queryOnly = true;
    } else if (arg === '--skip-tests') {
      flags.skipTests = true;
    } else if (arg === '--save') {
      flags.save = true;
    } else if (arg === '--force' || arg === '-f') {
      flags.force = true;
    } else if (arg === '--http') {
      flags.http = true;
    } else if (arg === '--from-draft' && i + 1 < argv.length) {
      flags.fromDraft = argv[++i];
    } else if (arg === '--contract' && i + 1 < argv.length) {
      flags.contract = argv[++i];
    } else if (arg === '--datalex-manifest' && i + 1 < argv.length) {
      flags.datalexManifestPath = argv[++i];
    } else if (arg === '--open-pr') {
      flags.openPr = true;
    } else if (arg === '--provider' && i + 1 < argv.length) {
      flags.provider = argv[++i];
    } else if (arg === '--user' && i + 1 < argv.length) {
      flags.user = argv[++i];
    } else if (arg === '--runtime-url' && i + 1 < argv.length) {
      flags.runtimeUrl = argv[++i];
    } else if (arg === '--runtime' && i + 1 < argv.length) {
      flags.runtime = argv[++i];
    } else if (arg === '--execute') {
      flags.execute = true;
    } else if (arg === '--ai') {
      flags.ai = true;
    } else if (arg === '--enterprise') {
      flags.enterprise = true;
    } else if (arg === '--ai-layout') {
      flags.aiLayout = true;
    } else if (arg === '--block' && i + 1 < argv.length) {
      flags.block = argv[++i];
    } else if (arg === '--question' && i + 1 < argv.length) {
      flags.question = argv[++i];
    } else if (arg === '--comment' && i + 1 < argv.length) {
      flags.comment = argv[++i];
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
