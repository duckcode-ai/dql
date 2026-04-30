# {{PROJECT_NAME}}

Acme Bank is a runnable end-to-end DQL OSS sample for a single local owner. It
models how a bank packages certified analytics into domain-specific Apps while
keeping all source artifacts in git.

## Run

```bash
npm install
npm run compile
npm run app:build
npm run notebook
```

The notebook opens the local desktop UI. Click **Apps** to see packaged
dashboard pages, attached notebooks, and AI-ready certified blocks.

## What is included

```
data/                    small DuckDB-readable CSV warehouse
blocks/                  certified reusable DQL blocks by domain
apps/                    OSS Apps with dql.app.json + .dqld dashboard pages
notebooks/               analyst notebook walkthrough
semantic-layer/          starter metric and dimension metadata
.dql/skills/             agent skills for banking personas
```

## Domains

| Domain | Business question | Certified blocks |
| --- | --- | --- |
| `cards` | Are card operations healthy and where is fraud concentrated? | `daily_transaction_volume`, `card_approval_rate`, `fraud_alerts_by_region`, `fraud_by_merchant_recent` |
| `deposits` | Are deposits growing by segment and branch? | `deposit_trend`, `deposits_by_segment`, `branch_deposit_leaders` |
| `lending` | Where is credit risk concentrated? | `loan_delinquency_by_region`, `high_risk_loan_exposure` |
| `executive` | What should CXO leaders review this week? | `bank_health_scorecard` plus cited domain blocks |

## Apps

| App | Audience | Homepage dashboard |
| --- | --- | --- |
| `cards-ops` | Head of Cards, fraud analyst, branch manager | `daily-ops` |
| `retail-deposits` | Retail banking leaders | `deposit-growth` |
| `risk-office` | Credit and fraud risk committee | `credit-risk` |
| `executive-cockpit` | CFO/COO weekly review | `bank-overview` |

Certified business logic stays in root `blocks/`. App folders contain metadata,
schedules, dashboard pages, optional notebooks, and `drafts/` for future
AI-generated work waiting for review.

## Sample notebooks

| Notebook | Use case |
| --- | --- |
| `notebooks/welcome.dqlnb` | Guided first run across raw SQL and certified blocks |
| `notebooks/cards_fraud_ops.dqlnb` | Cards volume, approval rate, fraud exposure, merchant watchlist |
| `notebooks/retail_deposits_review.dqlnb` | Deposit trend, segment balance, branch leaders |
| `notebooks/credit_risk_review.dqlnb` | Delinquency, probability of default, high-risk exposure |
| `notebooks/executive_weekly_review.dqlnb` | CXO weekly review across cards, deposits, and lending |

## Useful commands

```bash
npm run compile          # writes dql-manifest.json
npm run app:build        # validates Apps and dashboard references
npm run agent:reindex    # builds the local SQLite/FTS agent knowledge graph
npm run verify           # proves manifest output is reproducible
```

## Local persona preview

Apps are single-user OSS artifacts. There is no login, SSO, or hosted
multi-tenant behavior. Use the UI persona switcher to preview the real
PolicyEngine and RLS paths declared in `dql.app.json`.
