# CLI reference

> **Note:** This page mirrors `dql --help`. The source of truth is
>   [`apps/cli/src/index.ts`](https://github.com/duckcode-ai/dql/blob/main/apps/cli/src/index.ts);
>   a CI job fails the build if this page drifts.

```bash
dql --help
dql --version
```

## Commands

### Project

| Command | What it does |
| --- | --- |
| `dql init [dir]` | Initialize DQL in a project (auto-detects dbt) |
| `dql doctor [path]` | Run local setup checks |
| `dql doctor scale` | Report enterprise-scale manifest/cache/index health |
| `dql doctor git-hygiene` | Flag tracked local/generated files before commit |
| `dql validate [path]` | Validate all `.dql` files and semantic references |
| `dql compile [path]` | Generate project manifest (`dql-manifest.json`) |

`dql doctor scale --format json` includes counts, cache freshness,
metadata/KG index state, context-pack timing, source fingerprints, domain
shards, and top rejected evidence candidates that were relevant but excluded by
retrieval caps.

`dql doctor git-hygiene --format json` checks tracked files against the OSS Git
policy and flags `.dql/cache`, `.dql/local`, `*.run.json`, `dql-manifest.json`,
local databases, data files, AI pins, saved views, and layout overrides.

### Authoring

| Command | What it does |
| --- | --- |
| `dql new <type> <name>` | Create a domain, block, semantic block, term, business view, dashboard, workbook, or notebook |
| `dql new domain <name>` | Create `domains/<domain>/domain.dql` plus domain-local `terms/`, `blocks/`, `views/`, and `apps/` folders |
| `dql new block --domain <domain> --pattern <pattern> <name>` | Create a draft block scaffold with enterprise contract metadata |
| `dql new view --domain <domain> <name>` | Create a domain-local business view scaffold |
| `dql import sql <path>` | Generate AI-first DQL draft blocks from SQL files or folders |
| `dql import sql <path> --save` | Compatibility alias; generated drafts autosave before certification |
| `dql parse <file.dql>` | Parse and analyze a DQL file |
| `dql info <file.dql>` | Show block metadata |
| `dql certify <file.dql>` | Evaluate certification rules |
| `dql certify <file.dql> --enterprise` | Enforce grain, outputs, source-system lineage, pattern-specific reusable contracts, review cadence, and test assertions |
| `dql fmt <file.dql>` | Format a file in place (canonical form) |
| `dql fmt --check <path>` | CI check; exits 1 if anything needs formatting |

### Diff & versioning

| Command | What it does |
| --- | --- |
| `dql diff <path>` | Semantic diff of a `.dql` or `.dqlnb` against git HEAD |
| `dql diff <before> <after>` | Semantic diff between two files on disk |
| `dql diff <path> --impact --write-recertification` | Mark impacted semantic metric/dimension YAML as `pending_recertification` |

Exits **1** on changes — scriptable like `git diff`.

### Build & preview

| Command | What it does |
| --- | --- |
| `dql build <file.dql>` | Compile to a static HTML bundle |
| `dql preview <file.dql>` | Local browser preview |
| `dql serve [dir]` | Serve a built bundle |
| `dql notebook [path]` | Launch the browser-first notebook |

### Data & semantic

| Command | What it does |
| --- | --- |
| `dql semantic list\|validate\|query\|pull` | Semantic layer operations |
| `dql sync dbt [path]` | Verify configured dbt artifacts and update local cache status |
| `dql lineage [block] [path]` | Answer-layer lineage analysis |

Useful lineage flags:

```bash
dql lineage --term "Customer"          # business term to blocks/views/consumption
dql lineage --business-360 "Customer"  # business definition, reusable block contracts, sources, consumers, and gaps
dql lineage cross-domain --domain customer
                                      # domain boundary flows touching customer
dql lineage --business                 # business lineage summary
dql lineage --business "Customer 360"  # focused business composition and backing sources
dql lineage --table fct_orders         # technical source lineage
dql lineage --dashboard daily_ops      # consumption lineage
```

### Apps, agent, and MCP

| Command | What it does |
| --- | --- |
| `dql app new <name>` | Create a local App package |
| `dql app generate "<prompt>"` | Generate a governed App draft from certified blocks plus review placeholders |
| `dql app generate "<prompt>" --ai-layout` | Store richer GenUI layout metadata for dynamic visualization/layout decisions |
| `dql app ls\|show\|build\|reindex` | List, inspect, compile, or reindex local Apps |
| `dql promote notebook <path> --to shared` | Strip local run/UI state and mark a notebook as shared source |
| `dql promote app <app-id> --to shared` | Mark an App manifest as shared/reviewed source |
| `dql promote dashboard <app-id>/<dashboard-id> --to shared` | Strip AI pins/local state and mark a dashboard as shared source |
| `dql agent ask "<question>"` | Ask through the certified-first local agent loop |
| `dql agent reindex` | Rebuild `.dql/cache/agent-kg.sqlite` and metadata cache |
| `dql agent feedback up\|down` | Record answer feedback |
| `dql agent eval <file.yml>` | Run answer-loop eval checks with metrics and JSON traces; cases can assert `expected.minToolCalls` for tool-observed deep/research flows |
| `dql mcp [path]` | Run the DQL MCP server over stdio |
| `dql mcp --http [path]` | Run loopback HTTP MCP with a bearer token |
| `dql mcp test [path]` | Verify manifest, metadata catalog, agent index, and MCP tool readiness |
| `dql connect codex [path]` | Write project `.codex/config.toml` plus `AGENTS.md` |
| `dql connect claude-code [path]` | Write project `.mcp.json` plus `CLAUDE.md` |
| `dql connect claude-desktop [path]` | Update Claude Desktop MCP config |
| `dql connect cursor [path]` | Write project `.cursor/mcp.json` |
| `dql connect all [path]` | Configure all supported local MCP clients |

### Migration

| Command | What it does |
| --- | --- |
| `dql import sql <path>` | Generate autosaved AI import drafts from SQL files/folders |
| `dql migrate <source>` | Scaffold from looker, tableau, dbt, metabase, or raw-sql |
| `dql migrate layout --to domain-first --dry-run` | Preview moves from legacy folders into `domains/<domain>/...` |
| `dql migrate layout --to domain-first --force` | Apply the previewed domain-first file moves |
| `dql migrate format` | Rewrite every `.dql` and `.dqlnb` in the project in canonical form |
| `dql migrate format --check` | Dry run; exits 1 if anything would change |

## Global flags

| Flag | Meaning |
| --- | --- |
| `--format json\|text` | Output format (default: text) |
| `--verbose` | Detailed output |
| `--open` / `--no-open` | Auto-open the browser on `preview`/`serve` |
| `--check` | For `fmt`: non-zero exit if changes needed |
| `--input <path>` | Source for scaffold-style migrations |
| `--out-dir <path>` | Output directory for `build` |
| `--to domain-first` | Target for `dql migrate layout` |
| `--dry-run` | Preview layout moves without writing |
| `--to shared` | Target for `dql promote` |
| `--port <n>` | Preferred local port for `preview`/`serve` |
| `--chart <type>` | Primary chart type for `new` scaffolds |
| `--domain <name>` | Domain for new block scaffolds |
| `--owner <name>` | Owner for new block scaffolds |
| `--pattern <name>` | Block scaffold pattern, such as `metric_wrapper`, `entity_profile`, `entity_rollup`, `ranking`, `trend`, `bridge`, `drilldown`, or `replacement` |
| `--enterprise` | For `certify`: require enterprise-ready reusable block metadata plus pattern-specific parameter/filter contracts |
| `--query-only` | Create a query-only block (no visualization) |
| `--connection <driver\|path>` | Connection for `certify`/`test` (e.g. `duckdb`, `./db.duckdb`) |
| `--ai` | Include AI provider, MCP, and metadata checks in `dql doctor` |
| `--ai-layout` | Store dynamic GenUI layout metadata for `dql app generate` |
| `--provider <name>` | Select agent provider where supported |
| `--execute` | Execute bounded generated SQL previews during agent eval and score expected rows |
| `--min-answer-rate <0..1>` | For `dql eval`: fail when answerable cases route to missing context below this non-refusal rate |
| `--min-tool-requirement <0..1>` | For `dql agent eval`: fail when cases with `expected.minToolCalls` fall below this pass rate |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Generic failure *or* `dql diff`/`dql fmt --check` found differences |
| `2` | Usage / argument error |
