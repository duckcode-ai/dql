# {{PROJECT_NAME}}

A DQL analytics project, scaffolded by `create-dql-app`.

## Run

```bash
npm install
npm run notebook
```

Opens the notebook at <http://localhost:5173>. (`pnpm install && pnpm notebook`
works too.)

## Layout

```
dql.config.json        project config (connections, dbt, semantic layer)
package.json           npm scripts — `notebook`, `compile`, `sync`, `doctor`
notebooks/             .dqlnb notebooks (JSON format)
blocks/                certified reusable .dql blocks
semantic-layer/        metrics + dimensions authored locally
dashboards/            compiled static HTML dashboards (git-ignored)
```

## Using with dbt

If your dbt project is a sibling (e.g. `../dbt`), it was auto-wired into
`dql.config.json` under the `dbt:` key. Then:

```bash
(cd ../dbt && dbt parse)   # produces target/manifest.json
npm run sync               # refreshes the DQL cache from dbt
npm run compile            # builds dql-manifest.json with lineage
```

## Next steps

1. **Run the welcome notebook** — `notebooks/welcome.dqlnb`
2. **Connect your warehouse** — [docs.duckcode.ai/guides/connect-warehouse](https://docs.duckcode.ai/guides/connect-warehouse/)
3. **Import your dbt project** — [docs.duckcode.ai/guides/import-dbt](https://docs.duckcode.ai/guides/import-dbt/)
4. **Author a certified block** — [docs.duckcode.ai/guides/authoring-blocks](https://docs.duckcode.ai/guides/authoring-blocks/)

## Learn

- [Quickstart](https://docs.duckcode.ai/get-started/quickstart/)
- [Concepts](https://docs.duckcode.ai/get-started/concepts/)
- [CLI reference](https://docs.duckcode.ai/reference/cli/)
