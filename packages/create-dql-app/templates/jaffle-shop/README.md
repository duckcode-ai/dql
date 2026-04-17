# {{PROJECT_NAME}}

A DQL analytics project, scaffolded by `create-dql-app`.

## Run

```bash
npx @duckcodeailabs/dql-cli notebook
```

Opens the notebook at <http://localhost:5173>.

## Layout

```
cdql.yaml              project config (connections, dbt, governance)
notebooks/             analytics notebooks (.dql)
blocks/                certified reusable blocks, grouped by domain
semantic-layer/        metrics + dimensions authored locally
dashboards/            compiled static HTML dashboards (git-ignored)
```

## Next steps

1. **Run the welcome notebook** — `notebooks/welcome.dql`
2. **Connect your warehouse** — [docs.duckcode.ai/guides/connect-warehouse](https://docs.duckcode.ai/guides/connect-warehouse/)
3. **Import your dbt project** — [docs.duckcode.ai/guides/import-dbt](https://docs.duckcode.ai/guides/import-dbt/)
4. **Author a certified block** — [docs.duckcode.ai/guides/authoring-blocks](https://docs.duckcode.ai/guides/authoring-blocks/)

## Learn

- [Quickstart](https://docs.duckcode.ai/get-started/quickstart/)
- [Concepts](https://docs.duckcode.ai/get-started/concepts/)
- [CLI reference](https://docs.duckcode.ai/reference/cli/)
