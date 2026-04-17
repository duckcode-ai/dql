# create-dql-app

The fastest way to start a DQL project.

```bash
npx create-dql-app my-analytics
cd my-analytics
npx @duckcodeailabs/dql-cli notebook
```

Opens a running notebook at <http://localhost:5173> in under 5 minutes on a
clean machine. No global install required.

## Templates

| Template | What you get |
| --- | --- |
| `jaffle-shop` *(default)* | DuckDB + the Jaffle Shop dataset + a sample notebook, certified block, and dashboard |
| `empty` | Just a `cdql.yaml` and project layout — bring your own warehouse |

```bash
npx create-dql-app finance-reports --template empty
```

## Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--template <name>` | `jaffle-shop` | Starter template |
| `--no-install` | off | Skip downloading the Jaffle Shop seed data |

## Docs

- [Quickstart](https://github.com/duckcode-ai/dql/blob/main/docs/01-quickstart.md)
- [Concepts](https://github.com/duckcode-ai/dql/blob/main/docs/02-concepts.md)
- [Connect your own warehouse](https://github.com/duckcode-ai/dql/blob/main/docs/guides/connect-warehouse.md)

## License

MIT
