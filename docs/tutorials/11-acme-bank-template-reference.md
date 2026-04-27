# 11 - Acme Bank template reference

Use this as the map for the runnable `acme-bank` template.

## Scaffold

```bash
npx create-dql-app acme-bank --template acme-bank
cd acme-bank
dql compile
dql app build
dql notebook
```

## Data

| File | Purpose |
| --- | --- |
| `data/customers.csv` | Customer segment, region, branch, and risk tier |
| `data/transactions.csv` | Card transactions with approval/decline status |
| `data/fraud_alerts.csv` | Fraud alerts tied to transactions, merchants, regions, and branches |
| `data/merchants.csv` | Merchant category and risk band |
| `data/deposits.csv` | Deposit balances and net-new deposits by snapshot date |
| `data/loans.csv` | Lending exposure, days past due, probability of default, risk grade |

## Certified Blocks

| Domain | Blocks |
| --- | --- |
| `cards` | `daily_transaction_volume`, `card_approval_rate`, `fraud_alerts_by_region`, `fraud_by_merchant_recent` |
| `deposits` | `deposit_trend`, `deposits_by_segment`, `branch_deposit_leaders` |
| `lending` | `loan_delinquency_by_region`, `high_risk_loan_exposure` |
| `executive` | `bank_health_scorecard` |

Each block includes `domain`, `status = "certified"`, `owner`, `description`,
`tags`, `llmContext`, examples, tests, and a default visualization.

## Apps

| App | Domain | Homepage | Business use case |
| --- | --- | --- | --- |
| `cards-ops` | `cards` | `daily-ops` plus `fraud-watch` | Cards operations and fraud monitoring |
| `retail-deposits` | `deposits` | `deposit-growth` | Deposit growth review by segment and branch |
| `risk-office` | `lending` | `credit-risk` | Credit-risk and fraud watchlist review |
| `executive-cockpit` | `executive` | `bank-overview` | CFO/COO cross-domain weekly scorecard |

Apps are stored as:

```text
apps/<app-id>/
  dql.app.json
  README.md
  dashboards/
    <dashboard>.dqld
  notebooks/
  drafts/
```

## Governance

OSS identity is single-user. The template uses local persona preview to test
real PolicyEngine and RLS paths.

`cards-ops` includes a branch persona:

```json
{
  "userId": "li.park@acme-bank.com",
  "roles": ["branch_viewer"],
  "attributes": { "region": "NA-NE", "branch": "NYC-042" }
}
```

The App binds those attributes into block decorators:

```json
[
  { "role": "branch_viewer", "variable": "user.region", "from": "region" },
  { "role": "branch_viewer", "variable": "user.branch", "from": "branch" }
]
```

## Agent Skills

| Skill | User | Purpose |
| --- | --- | --- |
| `.dql/skills/mei.chen@acme-bank.com/cards-fraud.skill.md` | Mei Chen | Cards fraud and daily operations vocabulary |
| `.dql/skills/sara.fitch@acme-bank.com/cfo-weekly.skill.md` | Sara Fitch | CFO weekly scorecard vocabulary |

Run:

```bash
dql agent reindex
```

Then ask questions such as:

```text
Which merchants are driving card fraud?
Are deposits growing?
Where is credit risk concentrated?
Give me the bank health scorecard.
```

Expected behavior: certified blocks are retrieved first, cited in the answer,
and generated SQL is marked uncertified if no block matches.
