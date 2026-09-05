---
id: beverage-analysis
domain: commerce
model_areas: [revenue_performance, customer_value]
kind: analysis_pattern
status: active
owner: analytics@jaffle.shop
description: Guided retrieval and SQL rules for beverage product and customer questions.
preferred_blocks: [beverage_revenue_by_product, top_beverage_customers]
triggers: [beverage, drink, drinks, coffee, tea, soda, product variety]
vocabulary:
  beverage: term:Beverage
  drink: term:Beverage
  drinks: term:Beverage
  customer: term:Customer
  revenue: term:Revenue
---
# Beverage analysis

- Use the certified beverage blocks before drafting SQL.
- A beverage product is `products.is_drink_item = true`; always qualify this
  field with the `products` alias when joining `order_items` and `products`.
- For a customer ranking, return both beverage revenue and the number of
  distinct beverage products so "different types" has a clear meaning.
- Use `SUM(order_items.product_price)` for product-level beverage revenue and
  describe it as excluding tax.
