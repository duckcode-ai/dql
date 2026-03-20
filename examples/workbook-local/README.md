# Workbook Local Example

This example shows a multi-page workbook that compiles into a tabbed HTML report.

## What it demonstrates

- workbook syntax
- multiple pages in one file
- a local-first reporting flow with CSV data

## Run it

```bash
cd dql/examples/workbook-local
dql doctor
dql preview workbooks/quarterly_business_review.dql --open
```

## Build it

```bash
dql build workbooks/quarterly_business_review.dql
dql serve dist/quarterly_business_review --open
```
