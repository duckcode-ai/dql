# E-commerce Analytics

Realistic commerce analytics using DQL — 50 orders across 4 regions, 3 segments, and 5 channels with full semantic layer.

## Run it

```bash
cd dql/examples/ecommerce-analytics
dql doctor
dql notebook
```

## What you'll learn

- Segment and channel revenue analysis with bar charts
- Month-over-month trend tracking
- Gross margin and repeat purchase rate KPIs
- Semantic layer metrics and dimensions for ad-hoc queries

## Blocks

- `blocks/revenue_by_segment.dql` — GMV by acquisition channel
- `blocks/repeat_rate.dql` — Repeat vs first-order revenue mix
- `blocks/revenue_by_region.dql` — Revenue by geographic region
- `blocks/monthly_trend.dql` — Monthly revenue trend with order counts
- `blocks/segment_mix.dql` — Segment revenue with margin analysis

## Semantic Layer

- **Metrics:** gmv, order_count, avg_order_value, gross_margin_pct, repeat_rate
- **Dimensions:** channel, segment, region, order_date

## Data

- `data/orders.csv` — 50 realistic e-commerce orders (Jan–Jun 2025)
