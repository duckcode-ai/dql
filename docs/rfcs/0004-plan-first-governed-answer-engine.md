# RFC 0004: Plan-first governed answer engine

| Field              | Value                                  |
| ------------------ | -------------------------------------- |
| **Author(s)**      | @KKranthi6881                          |
| **Status**         | Implemented; independent verification and scale optimization pending |
| **Created**        | 2026-07-22                             |
| **Targets**        | DQL `>= 2.0`                           |
| **Implementation** | Dependency-ordered DQL 2.0 workstreams |
| **Amends**         | RFC 0001, RFC 0002, and RFC 0003       |

## Summary

DQL will replace the answer cascade's repeated interpretation and repair stages
with one immutable, identifier-bound analytical plan. After meaning resolution,
no component may reinterpret the selected metric, dimensions, entity grain,
time contract, filters, member bindings, domain, or relationship path. A
component may only validate, compile, execute, or reject that same plan.

The change is incremental. Authoritative plan-first routing is now the default;
existing routing remains available through the explicit route-level shadow-mode
rollback switch until independent built-CLI verification and the enterprise
performance budgets pass.

## Decisions

1. **One immutable plan.** One `ResolvedAnalyticalPlan` binds the request,
   snapshot, Domain context, KnowledgeLens, qualified members, time, filters,
   relationship proof, execution capability, output contract, and budgets.
2. **Qualified identity.** Bare names and labels are aliases only. Semantic
   registries retain every qualified object and represent ambiguous aliases as
   candidate sets rather than overwriting by load order.
3. **Independent retrieval lanes.** Exact/alias, BM25/FTS, semantic-vector, and
   typed-graph retrieval generate candidates independently after domain,
   import, lifecycle, and policy eligibility. Vectors are not limited to
   reranking a lexical shortlist.
4. **Local snapshot vector index first.** OSS stores embeddings with the
   immutable project-search snapshot. A hosted vector service is not required.
   Metrics, blocks, Domain Capsules, terms, semantic models, and compact Skill
   descriptors are eligible; warehouse columns are searched hierarchically
   inside retrieved model/entity neighborhoods.
5. **Domains before ranking.** Every governed request receives a server-resolved
   `DomainContextEnvelope`, including an explicit low-confidence/no-domain
   envelope. Domain hierarchy and Area affinity organize retrieval but grant no
   join or access authority.
6. **Skills once, as guidance.** Skills are selected once from the same snapshot
   after domain/Area/lifecycle/exclusion gates. Their exact qualified IDs and
   hashes are recorded. Skills may nominate evidence and planning guidance but
   cannot authorize joins, alter metric definitions, or override compatibility,
   policy, runtime, or the user's explicit meaning.
7. **Meaning before trust.** At most one bounded AI meaning call selects only
   server-provided qualified IDs. Deterministic code binds the plan and decides
   compatibility, authorization, route, compiler, and execution.
8. **One adapter per plan.** A compatible certified asset or semantic adapter is
   selected before compilation. An adapter failure is terminal for that plan;
   it cannot trigger metric substitution, adapter semantic downgrade, or
   free-form SQL fallback.
9. **Constrained governed SQL.** Top-N, HAVING, windows, comparisons, and safe
   arithmetic use deterministic relational operators over governed inputs. For
   uncovered raw-model analysis, AI may propose a constrained relational shape
   over allowlisted IDs; DQL owns relations, joins, keys, aliases, qualification,
   parameters, and dialect rendering.
10. **Research reuses the root plan.** Deep Research applies typed deltas to the
    same snapshot, envelope, KnowledgeLens, and plan. Every numerical claim must
    trace to an execution receipt. Research remains review-required and does not
    claim causality from observational association.
11. **One execution receipt.** Every route produces a result contract and
    receipt binding plan, executable query, parameters, snapshot, projected
    fields, result grain, and result fingerprint. Missing any requested output
    is a failed result contract, not partial success.
12. **Typed conversation deltas.** Follow-ups update the prior plan through
    typed add/replace/remove operations. Prior prose, SQL aliases, source paths,
    and provider metadata never become analytical members.

## Canonical route order

After business meaning is fixed, routing is:

1. completely compatible certified block;
2. compatible semantic adapter (`native`, `metricflow-cli`, or `dbt-cloud`);
3. governed relational composition over resolved members and authorized paths;
4. bounded, single-domain, review-required exploratory relational plan;
5. identifier-bound clarification or actionable refusal.

A route may be rejected before an executable plan is selected. Once selected,
compiler, provider, authentication, deadline, guard, or execution failure does
not broaden the route.

## Rollout

Implementation proceeded through specification/evaluation, qualified snapshot
identity, retrieval/Domain/Skill authority, shadow planning, certified/semantic
cutover, governed relational compilation, typed conversation/Research, and
surface parity/legacy-cascade retirement. The authoritative route now bypasses
the legacy cascade; shadow mode preserves a bounded rollback switch. Independent
built-CLI verification and the documented scale budgets remain release gates.
