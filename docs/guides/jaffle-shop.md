# Jaffle Shop DQL

Jaffle Shop now lives in its own demo repository:

[github.com/duckcode-ai/jaffle-shop-dql](https://github.com/duckcode-ai/jaffle-shop-dql)

Use that repo for the dbt enterprise-style proof path:

1. dbt builds `target/manifest.json` and `target/semantic_manifest.json`.
2. DQL imports dbt models, sources, semantic models, metrics, dimensions, and saved queries.
3. Certified DQL blocks and Apps sit on top of the dbt semantic layer.
4. The agent routes questions through certified assets first, semantic metrics second, and dbt manifest SQL fallback last.
5. Lineage shows the full path from domain to App, dashboard, block, semantic object, dbt model, and source.

The bundled Acme Bank template remains the governed workflow demo for Apps,
personas, business outcomes, schedules, and analyst review. Jaffle Shop DQL is
the dbt metadata and semantic-layer demo.
