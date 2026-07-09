# Agentic analytics answer flow

This is the operating contract for a fast, governed answer in a large DQL
project. It is deliberately a routing system, not a "generate SQL for every
question" system.

## Answer lanes

1. **Certified block** — execute a suitable certified block first. A block is
   selected only when its measure, grain, filters, and requested shape fit the
   question.
2. **Governed semantic answer** — when no block fits, resolve one or more
   semantic metrics and compile them deterministically. This is a completed,
   governed answer, but it does not certify a newly saved DQL block.
3. **Review-required generated answer** — generate SQL only when the semantic
   layer cannot express the request. Validate it against the selected project
   context, execute only within the normal runtime guardrails, and retain it as
   a draft until reviewed.
4. **Clarify** — ask a concise question only when none of the first three lanes
   can establish a safe measure, entity, or grain.

The UI and API must keep these lanes distinct. In particular, a compiler-owned
semantic query must never be shown as generated SQL merely because the compact
retrieval pack happened to contain dbt objects.

## Fast path

On each question, the provider runner first reuses a warmed project state. Its
source version covers compiled DQL/dbt/semantic inputs and the small governed
skills and hints trees. A concurrent or unchanged request shares the same
index; a relevant source change invalidates it.

The runner builds one compact metadata context pack, performs certified and
semantic resolution, and loads runtime schema only when that compact context is
insufficient. Embedding providers are retained across questions so their cache
is useful. This prevents the previous pattern of rebuilding the project index,
context pack, and embedding cache for every request.

## Retrieval and composition

Metadata retrieval remains the first discovery mechanism. If that compact
index is thin or lacks a relation needed for an answer, the agent can use a
bounded, read-only project-file search over authored DQL, SQL, YAML, JSON, and
Markdown. This provides the same practical source discovery users expect from
an interactive repository assistant without letting a broad recursive tool loop
replace governed retrieval.

Metric matching considers names, governed tags/families, strong descriptions,
and real embedding confidence. It rejects weak one-word or ambiguous matches.
Relevant skills are selected with explicit domain affinity, and only those
selected skills can contribute preferred-block hints.

For multiple metrics, the semantic compiler may use aggregate islands: each
metric is aggregated at the requested grain in its own CTE and the results are
joined only at that grain (or cross-joined for scalar results). This avoids a
raw fact-to-fact join and the fanout errors it creates.

## Generation guardrails

Generated SQL gets a small, explicit tool surface: contextual metadata search,
schema inspection, bounded source search, and SQL validation. It cannot re-run
the whole answer system recursively. Lookup, multi-entity, and deep questions
also use bounded tool-call budgets; deep investigation remains an intentional,
separate cost choice rather than the default route.

Approved hints are advisory and scoped. They can assist retrieval and
generation, but cannot override a certified block or promote generated SQL.

## Observable quality gates

Every provider-run answer records timings for project preparation, context
retrieval, optional source search, optional schema loading, answer resolution,
and total time. Product evaluation should track at least:

- warm and cold latency by lane;
- percentage of eligible questions answered by certified or semantic lanes;
- semantic compilation success for multi-metric and cross-domain questions;
- generated SQL validation/execution success;
- incorrect-certification rate and review promotion rate.

Before release, run the agent, semantic compiler, CLI runtime, and notebook
tests together. Include fixtures for exact certified answers, description-only
metric matches, multi-metric aggregate-island queries, dbt-only retrieval packs
that still resolve semantic metrics, bounded source search, and generated
fallback/refusal behavior.
