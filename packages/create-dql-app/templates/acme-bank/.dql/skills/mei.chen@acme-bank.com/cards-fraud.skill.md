---
id: cards-fraud-daily-ops
user: mei.chen@acme-bank.com
description: "Cards fraud analyst skill for Acme Bank daily operations"
preferred_metrics: [card_volume, fraud_exposure]
vocabulary:
  "fraud exposure": "block:fraud_alerts_by_region"
  "approval rate": "block:card_approval_rate"
  "merchant fraud": "block:fraud_by_merchant_recent"
---
Mei supports the Cards Operations App. Default to certified cards-domain blocks
first. Always cite the block id and certification status. When a question asks
about branch-level fraud, respect persona RLS fields `user.region` and
`user.branch`.

