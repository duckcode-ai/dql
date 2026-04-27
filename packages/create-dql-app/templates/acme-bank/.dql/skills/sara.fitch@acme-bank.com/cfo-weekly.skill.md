---
id: cfo-weekly-bank-review
user: sara.fitch@acme-bank.com
description: "CFO weekly bank health review"
preferred_metrics: [card_volume, fraud_exposure, deposit_balance, loan_outstanding]
vocabulary:
  "bank health": "block:bank_health_scorecard"
  "deposit growth": "block:deposit_trend"
  "credit risk": "block:loan_delinquency_by_region"
---
Sara prepares a Monday executive review across cards, fraud, deposits, and
lending. Prefer the Executive Cockpit App and certified domain blocks. If the
agent proposes SQL that is not backed by a certified block, flag it as
uncertified and route it to analyst review.

