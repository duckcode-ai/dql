# 7 · Memory & Learning — how it remembers and improves

> `packages/dql-agent/src/memory/sqlite-memory.ts` · `hints/*` · `skills/loader.ts` ·
> `skills/defaults.ts` · `metadata/catalog.ts`

DQL learns like an analyst, not like a chatbot. It **never learns from raw chat** — a question is not
a correctness signal. It learns only from **governed deltas**: the actions a human already takes
(certify, correct, reject) plus execution/gate outcomes. Those carry an unambiguous label *with
context*.

## The learning signal — governed actions, not chat sentiment

```mermaid
flowchart LR
    subgraph Signals["What counts as a lesson"]
        A["✅ Certify a draft/block<br/>= 'good' (canonical Q→SQL)"]
        B["✏️ Correct/edit before accept<br/>= wrong→right diff"]
        C["🚫 Reject = 'bad'"]
        D["⚙️ Execution error / gate fail<br/>= automatic 'wrong'"]
    end
    E["💬 Raw chat / thumbs-up"] -.->|"❌ never"| L
    Signals --> CAP["Capture (silent, from the action)<br/>+ question, before/after SQL, scope, domain"]
    CAP --> CAND["Candidate lesson (advisory)"]
    CAND -->|"human approves"| L["Applied → retrieved next time"]
```

- **Capture is silent, from strong actions** — no separate "rate this" step; the *act* of correcting
  or certifying *is* the label. An optional one-line reason becomes the lesson's rationale.
- **Application is human-gated** — a captured lesson stays a **candidate** until approved
  (**self-approve** in OSS single-user; **team review** in Cloud). That gate stops a bad auto-lesson
  from silently changing behavior.

## Three learning altitudes (promotion, not duplication)

```mermaid
flowchart TD
    subgraph Tiers["The learning hierarchy"]
        M["① Memory<br/>advisory facts, per scope<br/>(SQLite FTS · scope/confidence/supersedes)"]
        H["② Hints<br/>MICRO scope-gated corrections<br/>('revenue excludes refunds')<br/>Git-authoritative · approved-only"]
        S["③ Domain skills<br/>MACRO conventions per domain<br/>('active customer = order in 90d')<br/>.dql/skills/&lt;domain&gt;.skill.md"]
    end
    COR["Corrections + certified blocks"] --> H
    H -->|"≥N in a domain / recurring pattern"| CONS["Consolidation (evidence-gated)"]
    CONS -->|"draft → human certifies"| S
    S -.->|"absorbed hints marked superseded"| H
```

| Tier | Grain | Fires on | Storage |
|---|---|---|---|
| **Memory** | a fact | scope match | `.dql/cache/agent-memory.sqlite` + `.dql/memory/*.md` |
| **Hints** | one correction | exact scope (metric/model/domain/dialect/term/block) | `.dql/hints/*.yaml` (Git) + FTS index |
| **Domain skills** | a convention | whole domain | `.dql/skills/*.skill.md` (Git, editable) |

## The closed loop

```mermaid
sequenceDiagram
    participant U as User / Analyst
    participant L as Agent loop
    participant R as Retrieval (memory + hints + few-shot)
    participant G as Git + SQLite index

    U->>L: ask a question
    L->>R: recall_experience(question, scope)
    R-->>L: prior lessons + certified-block exemplars
    L-->>U: grounded answer (shaped by lessons)
    U->>L: correct / certify the draft
    L->>G: capture governed delta → candidate hint / memory
    U->>G: approve (self-approve OSS / team Cloud)
    Note over G,R: next similar question retrieves the lesson → mistake not repeated
```

## Few-shot from certified blocks (DAIL-SQL)

Your certified blocks already **are** a curated question→SQL bank. For an uncovered question, the
closest certified blocks are retrieved and passed as **few-shot exemplars** — the model is told to
*learn their patterns and adapt, not copy*. Every block you certify makes the next uncovered answer
better.

```mermaid
flowchart LR
    Q["Uncovered question"] --> RANK["rank closest certified blocks<br/>(question + SQL-skeleton similarity)"]
    RANK --> FEW["few-shot exemplars:<br/>question + certified SQL + grain + joins"]
    FEW --> GEN["generate grounded SQL that adapts them"]
```

## Domain-skill creation — seeded from structure, not guessed

```mermaid
flowchart TD
    subgraph Create["How a domain skill comes to exist"]
        SEED["① Seed (default)<br/>on dql init/compile, distil a starter<br/>&lt;domain&gt;.skill.md from that domain's<br/>blocks/metrics/terms (like metrics-glossary)"]
        EDIT["② Manual<br/>it's a Git .skill.md — edit/add rules anytime"]
        AUTO["③ Auto-update (evidence-gated)<br/>consolidation drafts refinements →<br/>'Promote to domain skill?' → human certifies"]
    end
    SEED --> EDIT --> AUTO
    AUTO -.->|"supersedes absorbed hints"| EDIT
```

- **Seeded from your declared DQL domains** (which map to your dbt folders/groups + the semantic
  layer) — deterministic, not a guess.
- **Always human-editable** (Git `.skill.md`, PR-able).
- **Auto-*proposed*** updates as learning accumulates — but **AI drafts, humans certify** (the DQL
  invariant), never a silent write.

Skills already ship as editable starters (`metrics-glossary`, `sql-conventions`, `domain-rules`,
`block-authoring`) via `seedDefaultSkills`; they are selected per question by lexical relevance and
folded into the generation prompt.

## Open-core boundary

```mermaid
flowchart LR
    subgraph OSS["OSS (local, single-user)"]
        O1["experience memory + approved hints"]
        O2["skills + domain seeding"]
        O3["few-shot from certified blocks"]
        O4["self-approve loop · FTS retrieval (offline)"]
    end
    subgraph Cloud["Cloud (governed, multi-tenant)"]
        C1["team review / RBAC / audit"]
        C2["automated LLM hint distillation at scale"]
        C3["reuse + accuracy measurement harness"]
        C4["cross-project skill libraries · embedding retrieval"]
    end
```

The moat was never "having hints" — it is the **governed system around them** (team review,
measurement, cross-project learning). The local self-approved loop drives OSS adoption; the governed,
measured loop is the commercial product.

## Why this beats generic agent memory

- **Scope-gated** by `HintScope` (domain/metric/grain/dbtModel/dialect/term) — "revenue excludes
  refunds" fires only on revenue questions and never leaks into a headcount query.
- **Execution-grounded** — lessons come from what the warehouse + gates verified, not chat vibes.
- **Confidence + decay + `supersedes`** — stale lessons fade; the newest correction wins.

← Back to the [master overview](./README.md)
