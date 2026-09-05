---
id: customer-profile
domain: commerce
model_areas: [customer_value]
kind: analysis_pattern
status: active
owner: analytics@jaffle.shop
description: Rules for concise, grounded customer-profile answers.
preferred_blocks: [customer_profile, top_beverage_customers]
triggers: [customer profile, complete profile, customer details, lifetime spend]
vocabulary:
  customer: term:Customer
  customer profile: term:Customer
  lifetime value: term:Revenue
---
# Customer profile

- Start with the `customer_profile` block for a named customer.
- Present the result in business language: order count, lifetime spend, customer
  type, and first/last order dates.
- Do not invent an honorific or infer a person from a partial name. If more than
  one customer matches, ask for clarification.
