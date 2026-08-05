# Context authoring, YAML import, and authoring AI

This specification governs `UI-019`, `API-011`, `MIG-003`, `MIG-004`,
`REL-004`, `SKILL-005`, `CTX-008`, `AGT-024`, `API-012`, `SKILL-006`,
`UI-020`, `UI-021`, `E2E-018`, and `E2E-019`.

## Canonical vocabulary and compatibility

Modeling lifecycle is `draft | evaluated | reviewed | certified | deprecated`.
Fanout is `safe | dedupe_required | attribution_required | forbidden | unknown`.
Readers accept legacy `review` and `unsafe` as aliases for `reviewed` and
`forbidden`. Unedited legacy source retains its spelling; every newly authored
or edited object emits the canonical spelling. Skills retain
`draft | active | deprecated`, because activation governs retrieval and is not
relationship certification.

`unknown`, `dedupe_required`, and `attribution_required` are not automatic-join
proof. dbt tests, lineage, and matching names are suggestions only. Existing
certified, fresh, exported, fingerprint-matching planner proof remains the sole
automatic-join authority.

## One write-free authoring contract

Manual work, dbt discovery, DQL/dbt YAML import, Modeling AI, Skills AI, and
corrections produce an immutable `ContextAuthoringProposalV1` with:

- origin, proposal/run ID, base snapshot, dependency fingerprints, proposal
  hash, and `review_required` trust;
- ordered partial operations over qualified IDs and server-resolved paths;
- evidence, ambiguity, warnings, blockers, expected validation, exact patches,
  impact, dependency closure, and explicit ownership moves.

Creation and repreview never write project source. `commit` accepts only the
expected proposal hash and an idempotency key. It stages the complete candidate,
compiles before accepting it, writes all selected changes or restores all prior
bytes, and refreshes the snapshot, knowledge graph, catalog, and warm agent
state. Snapshot, source, ownership, collision, dependency, proposal, and compile
drift return stable `409` responses with no partial write. An ordinary update
cannot move or replace another source path. The singular Modeling preview/apply
API remains a compatibility adapter through DQL 3.x.

The HTTP contract is:

- `POST /api/context-proposals`
- `GET /api/context-proposals/:id`
- `POST /api/context-proposals/:id/repreview`
- `POST /api/context-proposals/:id/commit`

## YAML import and batch model binding

`POST /api/modeling/dbt-first/imports` discovers a current project, confined
loopback local path, upload, or paste. `GET .../:id` returns classification and
`POST .../:id/preview` creates the shared proposal. Local paths are resolved
through symlinks, restricted to approved project roots, and bounded by file
count and bytes. Upload and paste remain available without local path access.

Import classifies DQL modeling, dbt resource, dbt semantic, and unsupported
YAML. In-project DQL opens in place. External DQL becomes a reviewed copy with
certification/proof stripped. dbt YAML resolves to sparse overlays bound to the
active manifest; DQL never duplicates dbt-owned SQL, columns, tests,
descriptions, or lineage. Generic YAML, ambiguous identifiers, unresolved
references, and simple-import cross-domain relationships block commit.
Selection changes always repreview and produce a new hash.

CLI parity is `dql model import <file-or-directory> --domain <id> [--area <id>]
--dry-run|--apply --format json`.

Every created/imported model belongs to exactly one Domain and Area. Batch add
selects dbt manifest models, assigns one Domain/Area, resolves deterministic DQL
ID collisions, and reviews bindings before proposal creation.

## Modeling workspace

The contextual label is Modeling while the `models` deep link and legacy routes
remain valid. Empty projects offer Use connected dbt, Import modeling YAML, and
Start manually. Configured projects open the canvas. The primary toolbar is
Domain/Area, Business/Data view, search, Add models, Connect, and View; New Area
lives in the Area selector and layout/density controls live in View.

Relationships use a progressive review: source/target, keys/cardinality with
reasoned suggestions, business meaning/evidence and warehouse validation, then
the exact source patch. Advanced fields are collapsed. Business view exposes
Connect; Data view may expose column handles. Suggestions never certify.

## Modeling AI, Skills AI, and revisions

The durable AgentRun system owns `modeling` and `skill` modes,
`modeling_draft`/`skill_draft` routes, and write-free change-proposal artifacts.
Stable surface/object threads survive remount. A completed artifact only offers
a typed review action. A same-thread correction creates an immutable
`authoring_revision` linked to its source run/artifact and revision number.

Modeling AI receives selected Domain/Area, manifest identifiers, columns,
lineage, tests, current modeling, validation receipts, and source locations—no
query rows. It may propose domains, Areas, bindings, business context, draft
relationships, updates, and explicit moves. It cannot invent identifiers,
delete, certify, create proof, authorize cross-domain use, or overwrite
dbt-owned facts. Corrections to certified relationships downgrade to draft and
remove stale proof.

Skills AI receives qualified modeling/metric/vocabulary references, current
skill configuration/hash, Ask evidence, and Domain/Area scope. It may propose
purpose/body, triggers/exclusions, preferred analytical objects, required
filters, clarification, examples, vocabulary, analytical policy, canonical
references, and explicit moves. It cannot activate, deprecate, delete, grant
tools, authorize joins/access, invent governed references, or create executable
scripts. Any correction to an active skill is saved as `draft`; only a separate
human activation of the exact hash followed by reindex makes it eligible.

## Retrieval and correction routing

Validated skill references persist canonical qualified KG IDs; legacy free-form
references remain non-governed text. `guided_by` edges link skills to referenced
models/relationships. Persistent Domain scope is distinct from one-shot focus.
A parent scope includes allowed descendants but excludes siblings and unrelated
domains. Exact object focus boosts matching active skills; drafts are always
ineligible. Scope and skill selection grant no joins, tools, imports, or data
access.

Relationship validation failures and Ask modeling gaps may open Modeling AI
with exact qualified candidates and receipts. Applied-skill evidence may open
Skills AI with the exact skill ID/hash and failure context. Raw feedback never
changes shared context. Modeling gaps route to Modeling AI, instructional or
vocabulary gaps to Skills AI, and validated SQL patterns to the Hint Graph.
Stale proposals write nothing; rebase creates a new derived revision against the
current snapshot and exposes conflicts.

## Verification gates

Tests cover supported/mixed/malformed/ambiguous/conflicting/unsupported YAML,
zero writes during discovery/generation, dependency closure, atomic rollback,
stale conflicts, immutable revisions, prohibited AI operations, skill draft and
activation eligibility, sibling Skills refresh, remount restoration, and
provider-unavailable manual fallbacks. `E2E-018` and `E2E-019` require the built
`dql notebook` CLI against the designated fixture in both themes while
preserving the Cloud selector/token/storage contract. Implementer evidence is
`implemented`; only an independent verifier may mark `verified`.
