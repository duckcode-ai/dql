select * from (
  values
    (1, 'lost', 1000, 1, cast('2026-09-15' as date), 'FY26', 'Splunk'),
    (2, 'lost', 500, 1, cast('2026-10-16' as date), 'FY26', 'Splunk'),
    (3, 'won', 0, 0, cast('2026-09-16' as date), 'FY26', 'Datadog'),
    (4, 'lost', 300, 1, cast('2025-09-16' as date), 'FY25', 'Splunk')
) as source(opportunity_id, opportunity_outcome, lost_amount, lost_opportunity_count, close_date, fiscal_year, competitor)
