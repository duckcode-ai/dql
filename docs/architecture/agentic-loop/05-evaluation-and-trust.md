# 5 · Evaluation & Trust — how it checks its own work

> `packages/dql-agent/src/agent-run-gates.ts` · `agent-run-engine.ts` (`trustStateFromEvaluations`)

Every step is graded by an **executable gate** — a pure function that inspects the executor's result
and returns evaluations with a severity and, when actionable, a machine repair action. The gates are
what turn "the LLM said something" into "we verified it, and here's how much to trust it."

## Gate anatomy

```mermaid
flowchart LR
    R["Executor result<br/>(answer, SQL, result rows, artifacts)"] --> GATE["gate(context)"]
    GATE --> E["AgentRunEvaluation[]"]
    E --> F1["passed: boolean"]
    E --> F2["severity: info | warning | blocking"]
    E --> F3["suggestedRepair?: human text"]
    E --> F4["repairAction?: { kind: retry | escalate, route?, hint? }"]
    F2 & F4 -.->|"read by the loop"| DECIDE["repair · escalate · accept"]
```

## Two kinds of checks: liveness + correctness

```mermaid
flowchart TD
    subgraph Live["Liveness (did it run?)"]
        L1["execution-error → repair the SQL (retry)"]
        L2["no answer → escalate to research (blocking)"]
        L3["grounding present?"]
    end
    subgraph Sem["Semantic correctness (is it right?)"]
        S1["cardinality: scalar question → many rows?<br/>= fan-out / missing aggregation → retry"]
        S2["grain / join correctness  (roadmap)"]
    end
    ANSGATE["generatedAnswerGate"] --> Live
    ANSGATE --> Sem
```

Liveness-only gates let *wrong-but-runnable* SQL pass. The **semantic-correctness gate** closes that
gap for the most common error: a **scalar** question ("what is total revenue?") that returns **many
rows** is almost always a fan-out join or a missing `GROUP BY` — it's flagged and repaired.

```mermaid
flowchart TD
    Q["Question + result rows"] --> SC{"scalar-phrased?<br/>(not breakdown, not time-series)"}
    SC -->|no| PASS["no semantic flag"]
    SC -->|yes| RC{"rowCount over 1 ?"}
    RC -->|no| PASS
    RC -->|yes| CERTQ{"result already certified?"}
    CERTQ -->|yes| PASS
    CERTQ -->|no| FLAG["semantic-cardinality FAIL<br/>repairAction: retry<br/>'return a single aggregated value'"]
```

**Guards against false positives** (so it never wastes a repair on a correct answer):
- **Breakdown** questions ("top customers", "by region", "who…") → excluded.
- **Time-series / window** phrasings ("monthly total revenue", "running total", "month over month")
  → excluded (they are legitimately multi-row).
- **Certified** results → never second-guessed.
- Runs on `generated_answer` only — **not** on research (whose result is a bounded preview, not a
  true row count).

## Gate → trust map

```mermaid
flowchart TD
    subgraph Gates
        AG["answerGate<br/>(certified_answer)"]
        GAG["generatedAnswerGate<br/>(generated_answer)<br/>= answerGate + semantic"]
        RG["researchGate"]
        SG["sqlCellGate"]
        BG["blockDraftGate"]
        APG["appBuildGate"]
    end
    AG & GAG & RG & SG & BG & APG --> TSE["trustStateFromEvaluations(route, evals, fallback)"]
    TSE --> OUT["run.trustState"]
```

`trustStateFromEvaluations`:
- any **blocking** failed eval → `blocked`
- route `certified_answer` → `certified`
- route `clarify` → `not_applicable`
- route `research` / `generated_answer` **AND** `catalog-grounding` passed **AND** `result-executed`
  passed → **`grounded`**
- else → the route's fallback (usually `review_required`).

## The trust ladder

```mermaid
stateDiagram-v2
    [*] --> blocked: can't ground / execute
    [*] --> review_required: generated, unverified
    [*] --> not_applicable: clarify / no-data question
    blocked --> review_required: repaired
    review_required --> grounded: executed cleanly on real data
    grounded --> certified: 👤 human certifies (never automatic)
    certified --> [*]

    note right of grounded
        "verified" — shown as a calm chip.
        Grounded ≠ certified. AI never
        self-promotes to certified.
    end note
```

| State | Meaning | UI |
|---|---|---|
| `certified` | Answered from a governed metric you can trust | green shield "certified" |
| `grounded` | Verified against real data, pending certification | accent shield **"verified"** |
| `review_required` | Generated from governed data, not a metric yet | amber "review required" |
| `blocked` | Couldn't ground/execute it | red "blocked" |
| `not_applicable` | Clarify / not a data question | muted |

> This is the **graduated-trust** contract: the loop can *verify* (grounded) but only a human can
> *certify*. See also `docs/architecture/graduated-trust.md`.

→ Next: [Self-correction](./06-self-correction.md)
