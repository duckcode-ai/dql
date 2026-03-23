# NYC Taxi

This example demonstrates trip volume, fare trends, and airport mix analysis using local taxi sample data.

NYC taxi trip analytics using DQL — 40 trips across 5 boroughs with fare, tip, and distance analysis plus full semantic layer.

## Run it

```bash
cd dql/examples/nyc-taxi
dql doctor
dql notebook
```

## What you'll learn

- Borough-level trip volume and fare analysis
- Hourly demand patterns
- Airport vs city trip comparison
- Payment type and tipping behavior
- Semantic layer metrics for ad-hoc queries

## Blocks

- `blocks/revenue_by_segment.dql` — Trips and fare by pickup borough
- `blocks/hourly_demand.dql` — Trip volume by hour of day
- `blocks/airport_analysis.dql` — Airport vs city fare/distance comparison

## Semantic Layer

- **Metrics:** total_fare, trip_count, avg_fare, total_tips
- **Dimensions:** pickup_borough, dropoff_borough, payment_type, airport_flag

## Data

- `data/trips.csv` — 40 realistic NYC taxi trips (Jan 2025)
