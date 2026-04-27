# create-dql-app

The fastest way to start a DQL project.

```bash
npx create-dql-app@latest my-analytics
cd my-analytics
npm install
npm run notebook
```

Opens a running notebook at <http://127.0.0.1:3474> in under 5 minutes on a
clean machine. No global install required; the template installs
`@duckcodeailabs/dql-cli` locally and exposes it through npm scripts.

## Templates

| Template | What you get |
| --- | --- |
| `jaffle-shop` *(default)* | DuckDB + the Jaffle Shop dataset + a sample notebook, certified block, and dashboard |
| `acme-bank` | Banking OSS release walkthrough with sample data, certified blocks, sample notebooks, Apps, dashboards, governance, schedules, and agent Skills |
| `empty` | Just `dql.config.json` and project layout - bring your own warehouse |

```bash
npx create-dql-app@latest acme-bank --template acme-bank
npx create-dql-app@latest finance-reports --template empty
```

## Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--template <name>` | `jaffle-shop` | Starter template: `jaffle-shop`, `acme-bank`, or `empty` |
| `--no-install` | off | Skip downloading the Jaffle Shop seed data |

## Docs

- [Quickstart](https://github.com/duckcode-ai/dql/blob/main/docs/01-quickstart.md)
- [Concepts](https://github.com/duckcode-ai/dql/blob/main/docs/02-concepts.md)
- [Connect your own warehouse](https://github.com/duckcode-ai/dql/blob/main/docs/guides/connect-warehouse.md)

## License

MIT
