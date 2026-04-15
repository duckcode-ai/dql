# Install And First Project

This is the cleanest path for a brand-new user who knows nothing about DQL.

## What You Will Do

1. Install the CLI
2. Create your first DQL project
3. Verify the setup
4. Open the notebook

## Prerequisites

- Node.js 18, 20, or 22
- npm

## Step 1: Install The CLI

```bash
npm install -g @duckcodeailabs/dql-cli
```

Check that it works:

```bash
dql --help
```

## Step 2: Create A Project

```bash
dql init my-dql-project
cd my-dql-project
```

This creates the basic DQL project structure for blocks, notebooks, and configuration.

## Step 3: Verify The Project

```bash
dql doctor
```

You should see that the project configuration and local runtime are valid.

## Step 4: Open The Notebook

```bash
dql notebook
```

This opens the DQL notebook locally in your browser.

## What To Learn Next

- [Notebook Workflow](../02-core-workflows/notebook-workflow.md)
- [Block Authoring Workflow](../02-core-workflows/block-authoring-workflow.md)
- [Semantic Layer Workflow](../02-core-workflows/semantic-layer-workflow.md)

## If You Want A dbt Example

Use the full [dbt + Jaffle Shop Walkthrough](./dbt-jaffle-shop.md).
