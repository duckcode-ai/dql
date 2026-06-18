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

The scaffolded project is a clean starter: `dql.config.json` (DuckDB
in-memory by default — bring your own warehouse), a welcome notebook, and npm
scripts for `notebook`, `compile`, `lineage`, `doctor`, and `validate`. If a
sibling dbt project is detected, it is wired into `dql.config.json`
automatically so `dql sync dbt` works out of the box.

Want a ready-made dbt project to try DQL on? Clone the example repo and add
DQL to it — the same steps you'd use on your own dbt repo:
[github.com/duckcode-ai/jaffle-shop-duckdb](https://github.com/duckcode-ai/jaffle-shop-duckdb).

Already installed `@duckcodeailabs/dql-cli` globally? That only installs the
command. From an existing dbt repo, run `dql init ./dql` before `cd dql`.

## Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--template <name>` | `starter` | Starter template |

## Docs

- [Quickstart](https://github.com/duckcode-ai/dql/blob/main/docs/01-quickstart.md)
- [Concepts](https://github.com/duckcode-ai/dql/blob/main/docs/02-concepts.md)
- [Connect your own warehouse](https://github.com/duckcode-ai/dql/blob/main/docs/guides/connect-warehouse.md)

## License

MIT
