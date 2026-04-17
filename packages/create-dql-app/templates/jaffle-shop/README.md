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
2. **Connect your warehouse** — [docs/guides/connect-warehouse.md](https://github.com/duckcode-ai/dql/blob/main/docs/guides/connect-warehouse.md)
3. **Import your dbt project** — [docs/guides/import-dbt.md](https://github.com/duckcode-ai/dql/blob/main/docs/guides/import-dbt.md)
4. **Author a certified block** — [docs/guides/authoring-blocks.md](https://github.com/duckcode-ai/dql/blob/main/docs/guides/authoring-blocks.md)

## Learn

- [Quickstart](https://github.com/duckcode-ai/dql/blob/main/docs/01-quickstart.md)
- [Concepts](https://github.com/duckcode-ai/dql/blob/main/docs/02-concepts.md)
- [CLI reference](https://github.com/duckcode-ai/dql/blob/main/docs/reference/cli.md)
