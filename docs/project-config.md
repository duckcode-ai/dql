# Project Config

`dql.config.json` is the lightweight project-level configuration file used by
the OSS CLI for local preview and bundle serving.

## Location

Place `dql.config.json` at the root of your DQL project.

Example layout:

```text
my-dql-project/
  blocks/
  data/
  semantic-layer/
  dql.config.json
```

The CLI walks upward from the current file or directory until it finds this
config file.

---

## Example

```json
{
  "project": "my-dql-project",
  "defaultConnection": {
    "driver": "file",
    "filepath": ":memory:"
  },
  "dataDir": "./data",
  "preview": {
    "port": 3474,
    "open": true,
    "theme": "light"
  }
}
```

---

## Fields

### `project`

Human-readable project name used in starter scaffolds and future tooling.

### `defaultConnection`

Connection settings used by `dql preview` and `dql serve`.

Supported Phase 1 local-first choices:

- `file` — recommended for local experimentation with `read_csv_auto(...)`, `read_parquet(...)`, and other DuckDB file readers
- `duckdb` — use a DuckDB database file or `:memory:`
- `sqlite`, `postgresql`, `mysql`, `snowflake`, `bigquery`, `mssql` — available through connectors, but not required for first-run adoption

Example local file connection:

```json
{
  "defaultConnection": {
    "driver": "file",
    "filepath": ":memory:"
  }
}
```

Example DuckDB database file:

```json
{
  "defaultConnection": {
    "driver": "duckdb",
    "filepath": "./local/dev.duckdb"
  }
}
```

### `dataDir`

Convenience convention for local project data. The CLI does not rewrite queries
to use this path; it is there so teams have one obvious place for sample data.

### `preview`

Controls local browser workflows.

- `port` — preferred port for `preview` and `serve`
- `open` — whether to open a browser automatically
- `theme` — compiler theme passed to local preview/build flows

---

## Commands That Use It

- `dql doctor`
- `dql preview`
- `dql build`
- `dql serve`

---

## Recommended Phase 1 Setup

For easiest adoption, start with:

```json
{
  "defaultConnection": {
    "driver": "file",
    "filepath": ":memory:"
  },
  "preview": {
    "open": true,
    "port": 3474,
    "theme": "light"
  }
}
```

This works well with starter queries that read CSV or Parquet directly.
