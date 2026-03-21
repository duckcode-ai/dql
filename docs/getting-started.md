# Getting Started

## Prerequisites

- Node.js 18 or newer
- For local preview with the default file/DuckDB runtime, use Node 18, 20, or 22 LTS when possible
- pnpm 9 or newer (for monorepo / source builds)

---

## Installation

Choose the path that fits your workflow.

### Path A — CLI only (standalone authoring)

If you are in a new project folder or external repo, install the `dql` binary globally:

```bash
npm install -g @duckcodeailabs/dql-cli
dql --help
```

Or install it locally and run it with `npx`:

```bash
npm init -y
npm install -D @duckcodeailabs/dql-cli
npx dql --help
```

Use this path if you are **not** inside the DQL monorepo.

### Path B — Source repo / contributor workflow

If you cloned the DQL repo itself, use the monorepo workflow instead:

```bash
git clone https://github.com/duckcode-ai/dql.git
cd dql
pnpm install
pnpm build
# Run via pnpm exec inside the repo:
pnpm exec dql --help
# Or invoke the compiled entry point directly:
node apps/cli/dist/index.js --help
# Or, inside a generated project without a global install:
../node_modules/.bin/dql --help
```

Commands such as `pnpm --filter @duckcodeailabs/dql-cli exec dql ...` work only in this cloned repo.

If you switch Node versions after the initial install, rerun `pnpm install` before using local preview so native DuckDB bindings are rebuilt for the active runtime.

### Path C — Library (embed in your application)

```bash
npm install @duckcodeailabs/dql-core @duckcodeailabs/dql-compiler
```

This gives you the parser, AST, semantic analyser, formatter, and full compilation pipeline as importable ESM modules. It does **not** install the `dql` CLI.

### Path D — VS Code extension

1. Open VS Code, go to the **Extensions** panel (`Cmd+Shift+X` / `Ctrl+Shift+X`).
2. Search for **DQL Language Support**.
3. Click **Install**.

Or install from the command line:

```bash
code --install-extension dql.dql-language-support
```

The extension provides syntax highlighting, snippet expansion, format-on-save, hover documentation, and live diagnostics via the Language Server (`@duckcodeailabs/dql-lsp`). It does not require any separate server process — the language server is bundled into the extension.

---

## Common installation mistakes

- `zsh: command not found: dql` means the CLI is not installed globally and you are not using `npx dql`.
- `No projects matched the filters` means you ran `pnpm --filter ...` outside the DQL source repo.
- Installing `@duckcodeailabs/dql-core` and `@duckcodeailabs/dql-compiler` gives you libraries only, not the CLI binary.

---

## Quickstart Project

Scaffold a local-first DQL project with sample data:

These commands assume `dql` is on your shell `PATH`. If you are running from a source checkout, use `pnpm exec dql` from the repo root or `../node_modules/.bin/dql` from inside the generated project.

```bash
dql init my-dql-project --template starter
cd my-dql-project
```

Run notebook commands from inside `my-dql-project`, or pass the project path explicitly such as `dql notebook ./my-dql-project`.

This creates:

- `blocks/` — starter charted and query-only blocks
- `data/` — local sample CSV for previewing with DuckDB/file connectors
- `dql.config.json` — starter project configuration
- `notebooks/` — welcome notebook for browser-first exploration
- `semantic-layer/` — example semantic definitions and companion metadata

To evaluate the strongest OSS path, use a themed template instead:

```bash
dql init my-dql-project --template ecommerce
```

See also:

- [Use Cases](./use-cases.md)
- [Project Config](./project-config.md)
- [Data Sources](./data-sources.md)
- [Examples](./examples.md)
- [Repo Testing](./repo-testing.md)
- [FAQ](./faq.md)
- [Compatibility](./compatibility.md)
- [Migration Guides](./migration-guides/README.md)
- [Why DQL](./why-dql.md)

Preview the starter block locally:

```bash
dql notebook
dql new block "Pipeline Health"
dql doctor
dql parse blocks/pipeline_health.dql
dql preview blocks/pipeline_health.dql --open
dql build blocks/pipeline_health.dql
dql serve dist/pipeline_health
```

Inside the notebook, the left sidebar now shows only files from the active project, and each file opens as a raw source view in a new tab for quick reference while editing cells.

If the default preview port is already in use, pass `--port 4474` or another open port to `preview` or `serve`.

---

## Real Repo Setup

If you are contributing to DQL itself, validate the repo from the source checkout:

```bash
git clone https://github.com/duckcode-ai/dql.git
cd dql
pnpm install
pnpm build
pnpm test
pnpm --filter @duckcodeailabs/dql-cli exec dql --help
```

Then follow [Repo Testing](./repo-testing.md) for starter-template smoke tests, example checks, and notebook validation.

---

## Your First Block

### 1. Create a `.dql` file

Create `blocks/revenue_by_segment.dql`:

```dql
block "Revenue by Segment" {
    domain      = "revenue"
    type        = "custom"
    description = "Quarterly revenue grouped by customer segment"
    owner       = "data-team"
    tags        = ["revenue", "segment", "quarterly"]

    params {
        period = "current_quarter"
    }

    query = """
        SELECT
            segment_tier AS segment,
            SUM(amount)  AS revenue
        FROM fct_revenue
        WHERE fiscal_period = ${period}
        GROUP BY segment_tier
        ORDER BY revenue DESC
    """

    visualization {
        chart = "bar"
        x     = segment
        y     = revenue
    }

    tests {
        assert row_count > 0
    }
}
```

### 2. Parse the block

Parse validates syntax and runs semantic analysis (checks required fields, unknown chart types, etc.):

```bash
pnpm exec dql parse blocks/revenue_by_segment.dql
```

Expected output (no errors):

```
  ✓ Parsed: blocks/revenue_by_segment.dql
    Statements: 1
    Diagnostics: ✓ No errors, no warnings
```

If there are problems, parse reports them:

```
  ✗ Errors (1):
    → Block "Revenue by Segment" is missing required field: domain
```

Add `--verbose` to see the full AST, or `--format json` to get machine-readable output:

```bash
pnpm exec dql parse blocks/revenue_by_segment.dql --verbose
pnpm exec dql parse blocks/revenue_by_segment.dql --format json
```

### 3. Inspect block metadata

`dql info` prints a structured summary of every block in the file, including a query cost estimate:

```bash
pnpm exec dql info blocks/revenue_by_segment.dql
```

Expected output:

```
  Block: "Revenue by Segment"
    Domain:      revenue
    Type:        custom
    Owner:       data-team
    Description: Quarterly revenue grouped by customer segment
    Tags:        revenue, segment, quarterly
    Params:      1
    Tests:       1 assertion(s)

    Cost Estimate: 15/100
```

### 4. Inspect tests (dry run)

`dql test` shows which assertions are declared in each block. Full execution requires a database connection:

```bash
pnpm exec dql test blocks/revenue_by_segment.dql
```

Expected output:

```
  ✓ Found 1 block(s) in blocks/revenue_by_segment.dql

  Block: "Revenue by Segment"
    Tests: 1 assertion(s)
    → assert row_count > 0
    Status: ⚠ Dry run (no database connection)
    Hint: Connect a database to execute assertions
```

### 5. Certify the block

Certification evaluates governance rules: required fields (`domain`, `type`, `description`, `owner`), tag presence, and structural completeness.

```bash
pnpm exec dql certify blocks/revenue_by_segment.dql
```

Expected output when the block is complete:

```
  Block: "Revenue by Segment"
  Status: ✓ CERTIFIABLE
```

If required fields are missing:

```
  Block: "Revenue by Segment"
  Status: ✗ NOT CERTIFIABLE

  Errors (1):
    ✗ requires-owner: Block must have an owner field
```

### 6. Format the file

```bash
# Format in place:
pnpm exec dql fmt blocks/revenue_by_segment.dql

# Check-only (exits 1 if formatting is needed — useful in CI):
pnpm exec dql fmt blocks/revenue_by_segment.dql --check
```

---

## Your First Notebook

The DQL Notebook is a browser-first SQL environment backed by DuckDB. It runs locally — no server setup, no cloud account.

### 1. Launch the notebook

From inside your project directory:

```bash
dql notebook
```

Or pass the project path explicitly:

```bash
dql notebook ./my-dql-project
```

The terminal prints:

```
  ✓ Notebook ready: http://127.0.0.1:3474
    Press Ctrl+C to stop.
```

The browser opens automatically. If you want to suppress that, use `--no-open`.

### 2. Open a notebook file

The left sidebar shows the `notebooks/` folder. Click `welcome.dqlnb` to open the starter notebook, or click **New Notebook** to start fresh.

### 3. Run your first SQL cell

Click **+ SQL** to add a SQL cell. Type a query against the starter data:

```sql
SELECT segment_tier, SUM(amount) AS total_revenue
FROM read_csv_auto('data/revenue.csv')
GROUP BY segment_tier
ORDER BY total_revenue DESC
```

Press `Shift+Enter` (or `Cmd+Enter`) to run. Results appear as a table below the cell. If DQL detects a chartable shape, a chart toggle appears alongside the table view.

Give the cell a name — click the cell label area and type `revenue_by_segment`. Named cells can be referenced by downstream cells.

### 4. Add a Param cell

Click **+ Param** to add a parameter cell. Configure it:

- **Name:** `segment`
- **Type:** `select`
- **Options:** `All`, `Enterprise`, `Mid-Market`, `SMB`
- **Default:** `All`

A live dropdown widget renders immediately below the cell configuration.

### 5. Use `{{variable}}` in a downstream SQL cell

Add another SQL cell and reference both the param and the named result cell:

```sql
SELECT * FROM {{revenue_by_segment}}
WHERE {{segment}} = 'All' OR segment_tier = {{segment}}
```

Run it. When you change the dropdown in the param cell, re-running this cell filters to the selected segment. Param values are injected as SQL literals; named SQL cells are injected as CTEs.

For a full reference on variable substitution, see [Notebook Guide — Variable Substitution](./notebook.md#variable-substitution).

### 6. Save and export

- Press `Cmd+S` to save the notebook as a `.dqlnb` file.
- Click **Export HTML** to generate a standalone dashboard you can share without running the CLI.
- Click **Export .dql** to save the notebook as a workbook in DQL block syntax.

---

## Using @duckcodeailabs/dql-core in Node.js

After `npm install @duckcodeailabs/dql-core`:

```typescript
import { Parser, SemanticAnalyzer, formatDQL } from '@duckcodeailabs/dql-core';
import { readFileSync } from 'node:fs';

const source = readFileSync('blocks/revenue_by_segment.dql', 'utf-8');

// Parse
const parser = new Parser(source, 'revenue_by_segment.dql');
const ast = parser.parse();

// Semantic analysis
const analyzer = new SemanticAnalyzer();
const diagnostics = analyzer.analyze(ast);

if (diagnostics.length === 0) {
  console.log('No errors');
} else {
  for (const d of diagnostics) {
    console.log(`[${d.severity}] ${d.message}`);
  }
}

// Format
const formatted = formatDQL(source);
console.log(formatted);
```

The `@duckcodeailabs/dql-core` package exports:
- `Parser` — tokenises and parses `.dql` source into a typed AST
- `SemanticAnalyzer` — validates block structure, required fields, chart types
- `formatDQL` / `formatProgram` — canonical formatter
- All AST node types and error types

---

## Using @duckcodeailabs/dql-compiler to Compile to HTML

```typescript
import { compile } from '@duckcodeailabs/dql-compiler';
import { readFileSync } from 'node:fs';

const source = readFileSync('blocks/revenue_by_segment.dql', 'utf-8');

const result = compile(source, { file: 'blocks/revenue_by_segment.dql' });

if (result.errors.length > 0) {
  console.error(result.errors);
} else {
  console.log(result.dashboards[0].html);
}
```

---

## Starter Template

Copy `templates/starter` into a new Git repository:

```bash
cp -r templates/starter my-analytics-repo
cd my-analytics-repo
git init && git add . && git commit -m "init"
```

Then:
1. Add charted or query-only blocks under `blocks/`
2. Add metrics, dimensions, and hierarchies under `semantic-layer/`
3. Add optional block companion YAML under `semantic-layer/blocks/` for business metadata
