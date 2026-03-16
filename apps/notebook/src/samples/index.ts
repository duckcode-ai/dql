export interface Sample {
  id: string;
  label: string;
  description: string;
  dql: string;
  csvName: string; // which sample dataset to use
}

export const SAMPLES: Sample[] = [
  {
    id: 'revenue-by-region',
    label: 'Revenue by Region',
    description: 'Bar chart showing total revenue broken down by region',
    csvName: 'sales',
    dql: `block "Revenue by Region" {
  domain = "sales"
  type = "custom"
  description = "Total revenue by sales region"

  query = """
    SELECT region, SUM(revenue) AS total_revenue
    FROM data
    GROUP BY region
    ORDER BY total_revenue DESC
  """

  visualization {
    chart = "bar"
    x = region
    y = total_revenue
    color = "#6366f1"
  }
}`,
  },
  {
    id: 'monthly-trend',
    label: 'Monthly Revenue Trend',
    description: 'Line chart showing revenue over time',
    csvName: 'sales',
    dql: `block "Monthly Revenue Trend" {
  domain = "sales"
  type = "custom"
  description = "Revenue trend by month"

  query = """
    SELECT
      strftime(CAST(date AS DATE), '%Y-%m') AS month,
      SUM(revenue) AS revenue
    FROM data
    GROUP BY month
    ORDER BY month
  """

  visualization {
    chart = "line"
    x = month
    y = revenue
    color = "#10b981"
  }
}`,
  },
  {
    id: 'product-mix',
    label: 'Product Mix',
    description: 'Donut chart showing revenue share by product',
    csvName: 'sales',
    dql: `block "Revenue by Product" {
  domain = "sales"
  type = "custom"
  description = "Revenue share by product category"

  query = """
    SELECT product, SUM(revenue) AS revenue
    FROM data
    GROUP BY product
    ORDER BY revenue DESC
  """

  visualization {
    chart = "donut"
    label = product
    value = revenue
  }
}`,
  },
  {
    id: 'scatter',
    label: 'Revenue vs Units',
    description: 'Scatter plot of revenue vs units sold per region',
    csvName: 'sales',
    dql: `block "Revenue vs Units" {
  domain = "sales"
  type = "custom"
  description = "Scatter of revenue vs units per region-product"

  query = """
    SELECT
      region,
      product,
      SUM(revenue) AS revenue,
      SUM(units) AS units
    FROM data
    GROUP BY region, product
  """

  visualization {
    chart = "scatter"
    x = units
    y = revenue
    color = region
  }
}`,
  },
  {
    id: 'area-trend',
    label: 'Cumulative Revenue',
    description: 'Area chart of cumulative monthly revenue',
    csvName: 'sales',
    dql: `block "Cumulative Revenue" {
  domain = "sales"
  type = "custom"

  query = """
    SELECT
      strftime(CAST(date AS DATE), '%Y-%m') AS month,
      SUM(SUM(revenue)) OVER (ORDER BY strftime(CAST(date AS DATE), '%Y-%m')) AS cumulative_revenue
    FROM data
    GROUP BY month
    ORDER BY month
  """

  visualization {
    chart = "area"
    x = month
    y = cumulative_revenue
    color = "#f59e0b"
  }
}`,
  },
];

// Sample CSV data — realistic sales dataset
export const SAMPLE_CSV: Record<string, string> = {
  sales: `date,region,product,category,revenue,units,cost,rep
2024-01-05,North,Product A,Electronics,12500,25,8000,Alice
2024-01-08,South,Product B,Software,8200,41,3200,Bob
2024-01-12,East,Product C,Services,15600,78,6200,Carol
2024-01-15,West,Product A,Electronics,9800,19,6300,Dave
2024-01-18,North,Product B,Software,6400,32,2500,Alice
2024-01-22,South,Product C,Services,11200,56,4500,Bob
2024-01-25,East,Product A,Electronics,14300,28,9200,Carol
2024-01-28,West,Product B,Software,7600,38,2900,Dave
2024-02-03,North,Product C,Services,13800,69,5500,Alice
2024-02-07,South,Product A,Electronics,10500,21,6800,Bob
2024-02-11,East,Product B,Software,9100,46,3600,Carol
2024-02-14,West,Product C,Services,16200,81,6500,Dave
2024-02-18,North,Product A,Electronics,11800,23,7600,Alice
2024-02-22,South,Product B,Software,7200,36,2800,Bob
2024-02-25,East,Product C,Services,12900,65,5200,Carol
2024-02-28,West,Product A,Electronics,8900,18,5700,Dave
2024-03-04,North,Product B,Software,5800,29,2200,Alice
2024-03-08,South,Product C,Services,14700,74,5900,Bob
2024-03-12,East,Product A,Electronics,16100,32,10300,Carol
2024-03-15,West,Product B,Software,8800,44,3400,Dave
2024-03-19,North,Product C,Services,12100,61,4800,Alice
2024-03-22,South,Product A,Electronics,13400,27,8600,Bob
2024-03-26,East,Product B,Software,6700,34,2600,Carol
2024-03-29,West,Product C,Services,15300,77,6100,Dave
2024-04-02,North,Product A,Electronics,10200,20,6600,Alice
2024-04-06,South,Product B,Software,8500,43,3300,Bob
2024-04-10,East,Product C,Services,13600,68,5400,Carol
2024-04-14,West,Product A,Electronics,11400,22,7300,Dave
2024-04-18,North,Product B,Software,7100,36,2800,Alice
2024-04-22,South,Product C,Services,16800,84,6700,Bob
2024-04-26,East,Product A,Electronics,12700,25,8200,Carol
2024-04-30,West,Product B,Software,9300,47,3600,Dave
2024-05-04,North,Product C,Services,14100,71,5600,Alice
2024-05-08,South,Product A,Electronics,10900,22,7000,Bob
2024-05-12,East,Product B,Software,7800,39,3000,Carol
2024-05-16,West,Product C,Services,15900,80,6400,Dave
2024-05-20,North,Product A,Electronics,13100,26,8400,Alice
2024-05-24,South,Product B,Software,6200,31,2400,Bob
2024-05-28,East,Product C,Services,17200,86,6900,Carol
2024-06-01,West,Product A,Electronics,11700,23,7500,Dave
2024-06-05,North,Product B,Software,8100,41,3100,Alice
2024-06-09,South,Product C,Services,14400,72,5800,Bob
2024-06-13,East,Product A,Electronics,15800,31,10100,Carol
2024-06-17,West,Product B,Software,7400,37,2900,Dave
2024-06-21,North,Product C,Services,12600,63,5000,Alice
2024-06-25,South,Product A,Electronics,10100,20,6500,Bob
2024-06-29,East,Product B,Software,9600,48,3700,Carol
2024-07-03,West,Product C,Services,16500,83,6600,Dave
2024-07-07,North,Product A,Electronics,13800,27,8900,Alice
2024-07-11,South,Product B,Software,7900,40,3100,Bob
2024-07-15,East,Product C,Services,18100,91,7200,Carol
2024-07-19,West,Product A,Electronics,12200,24,7800,Dave
2024-07-23,North,Product B,Software,6900,35,2700,Alice
2024-07-27,South,Product C,Services,15100,76,6000,Bob
2024-08-01,East,Product A,Electronics,14600,29,9400,Carol
2024-08-05,West,Product B,Software,8400,42,3300,Dave
2024-08-09,North,Product C,Services,13200,66,5300,Alice
2024-08-13,South,Product A,Electronics,11100,22,7100,Bob
2024-08-17,East,Product B,Software,7500,38,2900,Carol
2024-08-21,West,Product C,Services,16900,85,6800,Dave
2024-08-25,North,Product A,Electronics,12400,24,8000,Alice
2024-08-29,South,Product B,Software,8700,44,3400,Bob
2024-09-02,East,Product C,Services,17600,88,7000,Carol
2024-09-06,West,Product A,Electronics,10700,21,6900,Dave
2024-09-10,North,Product B,Software,6500,33,2500,Alice
2024-09-14,South,Product C,Services,14800,74,5900,Bob
2024-09-18,East,Product A,Electronics,15200,30,9700,Carol
2024-09-22,West,Product B,Software,9000,45,3500,Dave
2024-09-26,North,Product C,Services,12800,64,5100,Alice
2024-09-30,South,Product A,Electronics,11600,23,7400,Bob
2024-10-04,East,Product B,Software,7200,36,2800,Carol
2024-10-08,West,Product C,Services,17400,87,6900,Dave
2024-10-12,North,Product A,Electronics,14000,28,9000,Alice
2024-10-16,South,Product B,Software,8200,41,3200,Bob
2024-10-20,East,Product C,Services,16000,80,6400,Carol
2024-10-24,West,Product A,Electronics,12900,25,8300,Dave
2024-10-28,North,Product B,Software,7700,39,3000,Alice
2024-11-01,South,Product C,Services,15600,78,6200,Bob
2024-11-05,East,Product A,Electronics,13500,27,8700,Carol
2024-11-09,West,Product B,Software,9200,46,3600,Dave
2024-11-13,North,Product C,Services,14500,73,5800,Alice
2024-11-17,South,Product A,Electronics,11300,22,7300,Bob
2024-11-21,East,Product B,Software,7000,35,2700,Carol
2024-11-25,West,Product C,Services,18500,93,7400,Dave
2024-12-01,North,Product A,Electronics,16400,33,10500,Alice
2024-12-05,South,Product B,Software,8900,45,3500,Bob
2024-12-09,East,Product C,Services,17000,85,6800,Carol
2024-12-13,West,Product A,Electronics,13200,26,8500,Dave
2024-12-17,North,Product B,Software,7300,37,2800,Alice
2024-12-21,South,Product C,Services,15900,80,6400,Bob
2024-12-25,East,Product A,Electronics,14800,29,9500,Carol
2024-12-29,West,Product B,Software,9500,48,3700,Dave`,
};
