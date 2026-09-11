select * from (
  values
    (1, 'Capital One', cast('2025-09-01' as date), 80, 0, 0.0),
    (1, 'Capital One', cast('2026-08-01' as date), 100, 0, 0.0),
    (1, 'Capital One', cast('2026-09-01' as date), 120, 20, 0.2),
    (2, 'Adobe Systems', cast('2026-09-01' as date), 90, 0, 0.0),
    (3, 'Genesys Telecommunications', cast('2026-09-01' as date), 110, 0, 0.0),
    (4, 'Mercadolibre', cast('2026-09-01' as date), 200, 0, 0.0)
) as source(customer_id, customer_name, report_as_of_dt, total_bcm, dod_ccu_bcm_change_qty, dod_ccu_bcm_change_pct)
