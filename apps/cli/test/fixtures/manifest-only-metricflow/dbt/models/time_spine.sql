{{ config(materialized='table') }}

-- Small, deterministic MetricFlow time spine covering every fixture period.
select cast(date_day as date) as date_day
from generate_series(cast('2025-01-01' as date), cast('2026-12-31' as date), interval 1 day) as dates(date_day)
