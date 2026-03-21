# Notebook Guide

The DQL Notebook is a browser-first SQL notebook that runs entirely on your local machine. It uses DuckDB as the query engine, so queries execute against local files, CSVs, and Parquet datasets without any external database. Think of it as a Jupyter notebook purpose-built for analytics — SQL-native, chart-aware, and file-system integrated.

---

## Launch

Start the notebook server from inside your project directory:

```bash
dql notebook
```

Pass a path to a project outside the current directory:

```bash
dql notebook ./my-dql-project
```

**Flags:**

| Flag | Description |
|---|---|
| `--port <number>` | Run on a specific port instead of the default `3474` |
| `--no-open` | Start the server without opening the browser automatically |

**Examples:**

```bash
dql notebook --port 4488
dql notebook ./my-dql-project --port 4488 --no-open
```

**Terminal output:**

```text
  ✓ Notebook ready: http://127.0.0.1:3474
    Press Ctrl+C to stop.
```

---

## The Interface

The notebook UI has four main areas:

- **Header bar** — project name, Save button, Export menu, and connection status
- **Left sidebar** — three panels toggled by icons:
  - **Files** — lists all files in the active project; click any file to open a source view in a new tab
  - **Schema** — auto-discovered tables from `data/`; expand a table to see column names and types
  - **Outline** — lists every named cell in the open notebook for quick navigation
- **Cell area** — the main editing surface; cells stack vertically and can be reordered by dragging
- **Dev panel** — collapsible bottom panel showing the last query sent to DuckDB and its raw response; useful for debugging

---

## Cell Types

### SQL Cell

The primary cell type. Backed by a CodeMirror editor with SQL syntax highlighting and DQL-aware autocomplete.

**Running a query:**
- `Shift+Enter` or `Cmd+Enter` — run the cell
- The results panel appears directly below the editor

**Output modes:**
- **Table** — paginated result grid (default)
- **Chart** — auto-detected when the result shape is chartable (e.g. two columns where one is a category and one is numeric); toggle between table and chart using the icon in the cell toolbar

**Naming a cell:**

Click the label field at the top-left of the cell (shows `Unnamed` by default) and type a name. Named cells can be referenced by downstream cells using `{{cell_name}}` syntax.

**Example:**

```sql
SELECT
    segment_tier,
    SUM(amount) AS total_revenue,
    COUNT(*)    AS deal_count
FROM read_csv_auto('data/revenue.csv')
GROUP BY segment_tier
ORDER BY total_revenue DESC
```

Name this cell `revenue_by_segment` to reference it later.

---

### Markdown Cell

Add narrative, headings, and formatted text between query cells. Supports standard Markdown: headings, bold, italic, lists, links, and inline code.

Click **+ Markdown** in the cell toolbar to add one. Double-click a rendered Markdown cell to edit it. Click outside or press `Escape` to return to the rendered view.

**Example:**

```markdown
## Revenue by Segment

The following table shows total revenue and deal count grouped by
customer segment tier for the current data snapshot.
```

---

### DQL Cell

Runs DQL block syntax directly, without needing a separate `.dql` file. Useful for authoring and iterating on blocks inside the notebook before extracting them to `blocks/`.

```dql
block "Pipeline Health" {
    domain = "revenue"
    type   = "custom"
    query  = """
        SELECT stage, COUNT(*) AS deals
        FROM read_csv_auto('data/revenue.csv')
        GROUP BY stage
    """
    visualization {
        chart = "bar"
        x     = stage
        y     = deals
    }
}
```

---

### Param Cell

Renders a live interactive widget that injects a value into downstream SQL cells. This turns any notebook into a filterable dashboard.

**Configuration fields:**

| Field | Description |
|---|---|
| **Name** | The variable name used in `{{name}}` references |
| **Type** | `text`, `number`, `date`, or `select` |
| **Default** | The initial value |
| **Options** | Comma-separated list of choices (for `select` type only) |

**Adding a param cell:** click **+ Param** in the cell toolbar.

**Example configuration:**

- Name: `segment`
- Type: `select`
- Options: `All, Enterprise, Mid-Market, SMB`
- Default: `All`

A dropdown widget renders immediately. When the user picks a value, any downstream cell that references `{{segment}}` will use the new value on its next run.

> **Note:** Param cells do not have a "run" step — the widget is always live. Only the downstream SQL cells that reference the param need to be re-run after changing the value.

---

## Variable Substitution

`{{cell_name}}` references let cells compose on top of each other. There are two substitution modes:

- **Param cell reference** — the value is injected as a SQL string literal. `{{segment}}` becomes `'Enterprise'` in the compiled query.
- **Named SQL cell reference** — the result of the referenced cell is injected as a CTE (Common Table Expression). `{{revenue_by_segment}}` becomes `WITH revenue_by_segment AS (SELECT ...)`.

### Full working example

Given `data/revenue.csv` from the starter project:

**Step 1 — Add a Param cell**

- Name: `segment`
- Type: `select`
- Options: `All, Enterprise, Mid-Market, SMB`
- Default: `All`

**Step 2 — Add a SQL cell named `revenue_by_segment`**

```sql
SELECT segment_tier, SUM(amount) AS total
FROM read_csv_auto('data/revenue.csv')
GROUP BY segment_tier
```

Run it. Name the cell `revenue_by_segment`.

**Step 3 — Add a downstream SQL cell**

```sql
SELECT * FROM {{revenue_by_segment}}
WHERE {{segment}} = 'All' OR segment_tier = {{segment}}
```

Run it. The `{{revenue_by_segment}}` reference becomes a CTE; `{{segment}}` is replaced with the current dropdown value as a literal string.

Change the dropdown to `Enterprise` and re-run. Only Enterprise rows appear.

> **Note:** Cell references are resolved at run time. If a referenced cell has not been run yet, the notebook will prompt you to run it first.

---

## Schema Panel

The Schema panel (left sidebar, second icon) auto-discovers tables by scanning the project's `data/` directory for CSV and Parquet files. Each discovered file appears as a table entry.

- Click a table name to expand it and see column names and inferred types.
- Click a column name to insert it at the cursor position in the active SQL cell.

> **Note:** The schema panel reflects what DuckDB can read via `read_csv_auto()` and `read_parquet()`. It does not require a traditional database connection.

---

## Hot Reload

The notebook server watches the project directory for file changes. When a `.dqlnb` file is modified on disk (e.g. by another editor or a CLI command like `dql new notebook`), the UI reloads it automatically. CSS and UI assets also hot-reload during development.

---

## Save & Load

Notebooks are stored as `.dqlnb` files — JSON documents that contain the ordered list of cells, their source, names, and last result metadata.

**Saving:**
- Press `Cmd+S` (macOS) or `Ctrl+S` (Windows/Linux)
- Click the **Save** button in the header bar

The header bar shows a dot indicator when there are unsaved changes.

**Loading:**
- Click any `.dqlnb` file in the **Files** sidebar panel
- The notebook opens in a new tab in the cell area

**File format (simplified):**

```json
{
  "version": 1,
  "cells": [
    {
      "id": "cell_01",
      "type": "sql",
      "name": "revenue_by_segment",
      "source": "SELECT segment_tier, SUM(amount) AS total\nFROM read_csv_auto('data/revenue.csv')\nGROUP BY segment_tier"
    },
    {
      "id": "cell_02",
      "type": "param",
      "name": "segment",
      "paramType": "select",
      "default": "All",
      "options": ["All", "Enterprise", "Mid-Market", "SMB"]
    }
  ]
}
```

---

## Export

Two export formats are available from the **Export** menu in the header bar:

### Export HTML

Generates a fully self-contained HTML file that renders the notebook as a static dashboard. Charts and tables are embedded. The file can be shared via email or hosted on any static file server — no DQL runtime required.

```bash
# Equivalent CLI export (from outside the UI):
dql build notebooks/revenue_analysis.dqlnb --out-dir dist/revenue_analysis
```

### Export .dql

Exports the notebook as a DQL workbook file (`.dql` format). Each SQL cell becomes a `block` declaration. This is the recommended path for promoting notebook-authored queries into version-controlled `.dql` files.

---

## Creating Notebooks

### From the UI

Click the **New Notebook** button in the Files sidebar panel. A modal prompts for a name. The file is created in `notebooks/` and opens immediately.

### From the CLI

```bash
dql new notebook "Revenue Analysis"
dql new notebook "Q4 Review" --out-dir reports/
```

This creates `notebooks/revenue_analysis.dqlnb` with a starter SQL cell. If the notebook server is running, the new file appears in the sidebar automatically via hot reload.

See [`dql new notebook`](./cli-reference.md#dql-new-notebook-name) in the CLI reference for full flag documentation.

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Shift+Enter` | Run the current cell |
| `Cmd+Enter` | Run the current cell (alias) |
| `Cmd+S` | Save the notebook |
| `Escape` | Exit cell edit mode (Markdown cells) |
| `Cmd+/` | Toggle comment in SQL/DQL cells |
| `Tab` | Trigger autocomplete in SQL/DQL cells |
| `Cmd+Z` | Undo within the current cell editor |

---

## Tips & Tricks

- **Name every SQL cell.** Even if you don't plan to reference it immediately, a named cell is easier to find in the Outline panel and trivial to compose later.
- **Chain cells with `{{}}`** to build multi-step analysis pipelines. Each stage is independently runnable and debuggable.
- **Use param cells for dashboards.** A notebook with one or more param cells can be exported to HTML and used as a lightweight, self-contained filtered dashboard.
- **Use the Schema panel during exploration.** Click column names to insert them rather than typing — reduces typos against CSV column headers.
- **Keep data transformations in named SQL cells** and use a final display cell that selects from them. This way, you can swap the display query without re-running expensive transformations.
- **Export to .dql early.** When a query reaches production quality, export it to `.dql` and run `dql certify` to ensure it meets governance standards before sharing.
