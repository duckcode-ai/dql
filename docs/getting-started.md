# Getting Started

## Prerequisites

- Node.js 18 or newer
- pnpm 9 or newer (for monorepo / source builds)

---

## Installation

Choose the path that fits your workflow.

### Path A — CLI only (standalone authoring)

If you are using a published CLI package, install the `dql` binary globally:

```bash
npm install -g @duckcodeailabs/dql-cli
dql --help
```

Until then, build from source:

```bash
git clone https://github.com/duckcode-ai/dql.git
cd dql
pnpm install
pnpm build
# Run via pnpm exec inside the repo:
pnpm exec dql --help
# Or invoke the compiled entry point directly:
node apps/cli/dist/index.js --help
```

### Path B — Library (embed in your application)

```bash
npm install @duckcodeailabs/dql-core @duckcodeailabs/dql-compiler
```

This gives you the parser, AST, semantic analyser, formatter, and full compilation pipeline as importable ESM modules. No CLI required.

### Path C — VS Code extension

1. Open VS Code, go to the **Extensions** panel (`Cmd+Shift+X` / `Ctrl+Shift+X`).
2. Search for **DQL Language Support**.
3. Click **Install**.

Or install from the command line:

```bash
code --install-extension dql.dql-language-support
```

The extension provides syntax highlighting, snippet expansion, format-on-save, hover documentation, and live diagnostics via the Language Server (`@duckcodeailabs/dql-lsp`). It does not require any separate server process — the language server is bundled into the extension.

---

## Quickstart Project

Scaffold a local-first DQL project with sample data:

```bash
dql init my-dql-project
cd my-dql-project
```

This creates:

- `blocks/` — starter charted and query-only blocks
- `data/` — local sample CSV for previewing with DuckDB/file connectors
- `dql.config.json` — starter project configuration
- `semantic-layer/` — example semantic definitions and companion metadata

See also:

- [Quickstart](./quickstart.md)
- [Project Config](./project-config.md)
- [Data Sources](./data-sources.md)
- [Examples](./examples.md)
- [FAQ](./faq.md)
- [Compatibility](./compatibility.md)
- [Migration Guides](./migration-guides/README.md)
- [Why DQL](./why-dql.md)

Preview the starter block locally:

```bash
dql new block "Pipeline Health"
dql doctor
dql parse blocks/pipeline_health.dql
dql preview blocks/pipeline_health.dql --open
dql build blocks/pipeline_health.dql
dql serve dist/pipeline_health
```

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

---

## What Is Not Included

- Notebook coworker UI
- Natural-language block generation
- MCP runtime
- Approvals or run history

Those remain part of the closed DuckCode product.
