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

- [Quickstart](https://docs.duckcode.ai/get-started/quickstart/)
- [Concepts](https://docs.duckcode.ai/get-started/concepts/)
- [Connect your own warehouse](https://docs.duckcode.ai/guides/connect-warehouse/)

## License

MIT
