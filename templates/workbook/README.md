# Workbook

Multi-page workbook that compiles into a tabbed HTML report.

## Scaffold

```bash
dql init my-project --template workbook
cd my-project
```

## What it demonstrates

- Workbook syntax
- Multiple pages in one file
- Local-first reporting flow with CSV data

## Run it

```bash
dql doctor
dql preview workbooks/quarterly_business_review.dql --open
```

## Build it

```bash
dql build workbooks/quarterly_business_review.dql
dql serve dist/quarterly_business_review --open
```
