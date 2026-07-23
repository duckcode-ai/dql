# RFC 0005: Analytical composition and transparent repair

| Field              | Value                                      |
| ------------------ | ------------------------------------------ |
| **Author(s)**      | @KKranthi6881                              |
| **Status**         | Accepted for implementation                |
| **Created**        | 2026-07-22                                 |
| **Targets**        | DQL `>= 2.0`                               |
| **Implementation** | DQL 2.0 workstreams W04, W05, W07, and W08 |
| **Amends**         | RFC 0004                                   |

## Summary

The plan-first engine reliably identifies and binds governed analytical
objects. The next phase makes those objects answer complete analytical
questions by resolving their roles and relationships as one compatible tuple:

```text
metric × entity grain × dimension roles × member filters × time semantics
       × periods × comparison × ranking × output contract
```

For example, `revenue today` is not only a revenue-metric match. It requires an
authoritative revenue time dimension, a business timezone, a completeness
policy, a period, and a scalar result contract. `current and last-year revenue
for the top five customers` additionally requires customer grain, two aligned
periods, an explicit ranking basis, safe aggregation, and comparison outputs.

The phase also makes failed answers inspectable and repairable. **How it
answered** presents the resolved plan, DQL artifact, compiled SQL, lineage,
trust, execution steps, and a redacted stable failure. A user may derive an
editable DQL or SQL copy and rerun it, but edits create a new receipt and follow
explicit trust transitions. Permission failures never trigger access-control
bypass or a lower-trust data source.

The normative contract and delivery phases are defined in
[`docs/specs/dql-2-domain-context/10-analytical-composition-and-repair.md`](../specs/dql-2-domain-context/10-analytical-composition-and-repair.md).

## Decisions

1. **The planner builds an analytical sentence.** Meaning resolution expresses
   metrics, dimension roles, member bindings, entity grain, time role, periods,
   comparisons, ranking, and expected outputs. A bag of metric/dimension words
   is not an executable request.
2. **Compatibility is tuple-wide.** Deterministic code proves the complete
   analytical tuple against metric capability, relationship, policy, compiler,
   and output contracts. Individually compatible members do not prove that
   their combination is safe.
3. **Time is governed meaning.** `today`, `current`, `last year`, and similar
   phrases resolve through explicit metric/domain policy for time role,
   calendar, timezone, grain, alignment, and latest-complete behavior. DQL does
   not guess a time column from its name.
4. **Dimension roles are explicit.** A dimension is separately bound as a
   grouping, filter, display field, ranking entity, or time axis. A named member
   such as `Zoom` normally produces a typed customer filter; it does not
   implicitly add customer grouping.
5. **Comparison and ranking are first-class.** Current/prior periods, delta,
   percentage delta, rank entity, rank basis, direction, limit, and tie policy
   are plan fields. Ranking occurs after safe period aggregation at the declared
   entity grain.
6. **Certified assets declare capabilities.** A certified block terminates only
   when its parameter, metric, dimension, time, comparison, ranking, grain, and
   output contracts cover the request. Keyword similarity is context, not fit.
7. **Semantic truth precedes relational fallback.** A compatible semantic
   adapter is preferred. Governed dbt composition is allowed only with exact
   relations, columns, grain, measure behavior, time role, and relationship
   proof. Lexical or repository search may discover candidates but cannot
   authorize SQL.
8. **Stories are computed before they are narrated.** Values, comparisons,
   deltas, contributors, freshness, and caveats are deterministic result facts
   bound to execution receipts. An LLM may verbalize those facts but cannot add
   unsupported numbers or causal claims.
9. **The failed artifact remains inspectable.** Compilation and execution
   failures retain the immutable resolved plan, DQL source, parameter set,
   compiled SQL when available, fingerprints, and redacted phase diagnostics.
10. **Repair creates derivation, not mutation.** Editing DQL or SQL creates a
    derived artifact linked to the failed run. Parameter-only changes within a
    certified contract can retain asset trust; source or SQL edits require new
    validation and cannot retain certification automatically.
11. **Permission is terminal for the selected route.** DQL explains the denied
    governed object and safe next actions. It does not evade the denial through
    alternate relations, connections, generated SQL, or exploratory routing.
12. **One contract across surfaces.** Ask, Notebook, CLI, MCP, and Chat return
    the same analytical plan, executable identity, receipt, failure code, and
    trust transition for equivalent requests and repairs.

## Canonical route and repair boundaries

The route order from RFC 0004 remains unchanged:

1. fully compatible certified block;
2. fully compatible semantic adapter;
3. governed relational composition;
4. bounded review-required exploration;
5. identifier-bound clarification or actionable refusal.

After an executable route is selected, a compiler, schema, permission, timeout,
or result-contract failure does not reopen routing. Repair may recompile the same
plan, refresh the project snapshot explicitly, change authorized connection
context explicitly, or create a user-edited derived artifact. It never silently
substitutes another business meaning or data source.

## Rollout

Delivery is acceptance-first: freeze the versioned contracts and golden
questions, extract metric capability, implement the deterministic tuple solver,
add comparison/ranking execution graphs, add receipt-backed insight facts,
standardize failure/repair APIs, complete the CLI-backed inspector UI, then run
cross-surface and negative-path release gates. Each phase remains
`implemented` until a different verifier or the integration owner marks its
acceptance IDs `verified`.
