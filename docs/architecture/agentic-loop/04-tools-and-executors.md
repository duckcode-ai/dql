# 4 · Tools & Executors — what it uses to act

> `apps/cli/src/local-runtime.ts` (route executors) · `packages/dql-agent/src/answer-loop.ts` ·
> `research-loop.ts` · `app-planner.ts` · `kg/sqlite-fts.ts` (traversal)

DQL acts through two layers: **route executors** (one per route, injected into the engine) and a set
of **read-only grounding tools** the executors compose. Everything the agent *acts* with is
governed, read-only, and preview-bounded.

## Route executors

Each route in the plan maps to an `AgentRouteExecutor` — a function that receives the question,
intent, prior evaluations, a repair hint, and the step goal, and returns a result + artifacts.

```mermaid
flowchart TD
    ENG["AgentRunEngine"] -->|route| REG{{"AgentRunExecutors map"}}
    REG --> A1["certified_answer / generated_answer<br/>→ answerRunExecutor"]
    REG --> A2["research<br/>→ research executor"]
    REG --> A3["app_build<br/>→ app planner"]
    REG --> A4["sql_cell<br/>→ SQL cell generator"]
    REG --> A5["dql_block_draft<br/>→ draft + certifier"]
    REG --> A6["clarify<br/>→ single question"]

    A1 --> ANS["answer-loop: ground → query-plan → SQL → preview → repair"]
    A2 --> RES["research-loop: plan investigate steps → dossier + preview"]
```

| Executor | Backed by | Output artifact |
|---|---|---|
| `answerRunExecutor` (certified + generated) | `answer-loop.ts` | `answer` (result + SQL + trust) |
| research | `research-loop.ts` + notebook research storage | `research_run` (dossier + result preview) |
| app | `app-planner.ts` | `app_draft` |
| sql cell | grounded SQL gen | `sql_cell` |
| block draft | draft + certifier verdict | `dql_block_draft` |

## The read-only tool registry (the grounding toolbox)

The executors compose a small set of **read-only** tools — each a thin wrapper over code that already
exists. Tools **observe**; they never mutate governed state, never certify, and never write SQL to the
warehouse beyond a bounded preview.

```mermaid
flowchart LR
    subgraph Tools["Read-only tool set"]
        T1["search_catalog(query, kinds, domain)<br/>→ KGStore.search"]
        T2["lookup_metric(question)<br/>→ matchSemanticMetric + governed SQL"]
        T3["inspect_schema / sample(relation)<br/>→ schema context + bounded LIMIT preview"]
        T4["traverse_domain_graph(nodeId, edgeKinds)<br/>→ KGStore.neighbors / findJoinPath"]
        T5["plan_query(question, context)<br/>→ CoT grain/measures/dims/joins"]
        T6["run_sql_preview(sql)<br/>→ executeGeneratedSql (bounded)"]
        T7["recall_experience(question, scope)<br/>→ memory + approved hints"]
    end
    EXEC["Executor"] --> Tools
    Tools --> OBS["Observations → reason → propose SQL → gate"]
```

| Tool | Wraps | Purpose |
|---|---|---|
| `search_catalog` | `KGStore.search` (FTS5) | find relevant blocks / metrics / models |
| `lookup_metric` | `matchSemanticMetric` | resolve a governed metric to executable SQL |
| `inspect_schema` / `sample` | schema context + `executeGeneratedSql` (LIMIT) | see real columns + sample values |
| `traverse_domain_graph` | `KGStore.neighbors` / `findJoinPath` | relate entities/models **across domains** |
| `plan_query` | prompt stage | CoT grain + join path **before** SQL |
| `run_sql_preview` | `executeGeneratedSql` | execution-guided check (bounded rows) |
| `recall_experience` | `MemoryStore` + `retrieveScopedHints` | reuse prior corrections/lessons |

## The safety envelope

```mermaid
flowchart TD
    T["Any tool call"] --> RO{"read-only?"}
    RO -->|yes| OK["✅ allowed"]
    RO -->|no| NO["🚫 not in the toolbox"]
    OK --> G1["never bypasses certification (human-gated)"]
    OK --> G2["generated SQL stays review-required"]
    OK --> G3["warehouse access is a bounded preview (LIMIT)"]
    OK --> G4["audience constraints: stakeholders never author SQL/blocks"]
```

## Model provider

The LLM itself is a pluggable provider (`pickProvider`): Anthropic, OpenAI, Gemini, **Ollama**
(local), or custom-OpenAI-compatible — each with optional base-URL for enterprise gateways. When no
provider is available, the deterministic paths still work (templated SQL + deterministic planner), so
the loop degrades gracefully offline.

## Current vs roadmap

- ✅ **Route executors** — fully wired; the engine calls them per step.
- ✅ **Grounding tools' building blocks** — all exist (`KGStore.search`/`neighbors`/`findJoinPath`,
  `matchSemanticMetric`, `executeGeneratedSql`, memory/hints).
- ⚙️ **Iterative ReAct tool-loop** — the executor currently proposes SQL largely one-shot then
  repairs; converting `generated_answer`/`research` into a bounded 2–3 iteration
  `plan → search → inspect → preview → reflect` loop is the documented next increment (kept out of the
  one-shot path to avoid regressing what works).

→ Next: [Evaluation & trust](./05-evaluation-and-trust.md)
