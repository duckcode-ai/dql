# RFC 0010: Host hooks — who is asking, what they may see, and where state lives

| Field | Value |
|---|---|
| **Author(s)** | @KKranthi6881 (with Claude) |
| **Status** | Draft |
| **Created** | 2026-09-25 |
| **Targets** | DQL 1.18 → 1.20 (in slices) |
| **Discussion** | — |
| **Implementation** | — |
| **Supersedes** | — |

## Summary

`startLocalServer` gains one optional object, `hostHooks`. A program that
embeds DQL can use it to tell DQL:

- who is making each request;
- whether that person may do what they asked;
- which rows their queries may return;
- whose warehouse credentials to use;
- which model to call;
- where runs, memory, traces and audit events are kept;
- how tool calls are checked.

Each hook is bound once per request through `AsyncLocalStorage`, so none of
the more than 250 routes has to pass anything new along. With no hooks,
`dql notebook` behaves exactly as it does today: one local owner, one
connection, SQLite state in the project folder.

This RFC defines the interfaces and their local defaults. It does not add
sign-in, roles, multi-tenancy, central audit or managed secrets to the open
source. Those belong to whoever supplies the hooks.

## Motivation

DQL is a strong governed engine for one person on one machine. Teams run it
on a shared server, and commercial hosts run it inside a customer's cloud
account. Both need the same engine to answer as the person asking. Today it
can't, because the single-user assumption is spread through the code:

| Assumption | Where |
|---|---|
| One shared bearer token; no idea who is asking | `local-runtime.ts` request handler (`DQL_SERVER_TOKEN` check) |
| Actors taken from the request body (`reviewer`, `author`, `owner`) or from `git config` | `metadata/identity.ts` `resolveLocalOwner`; certify, review and owner routes |
| One active persona per process, which any caller can switch | `dql-project/src/persona.ts` `defaultPersonaRegistry`; `POST /api/persona` |
| Row rules only for blocks marked `@rls`; many query sites call `executeQuery` directly, and AI-written SQL is never narrowed | `dql-compiler` `applyRLSDecorators`; direct `executor.executeQuery` calls |
| One connection per process, with credentials from project config | `startLocalServer` `let connection`; `connection-pool.ts` |
| A closed list of model providers; the "values only to a local model" rule is hard-coded to Ollama on loopback | `providers/types.ts`; `selectAssistProvider`; story and canvas draft routes |
| Runs, threads, memory and traces created with `new` against SQLite files, with no person recorded | `SqliteAgentRunStore`, `MemoryStore`, `ConversationStore`, `AskTraceSqliteStoreV1` |
| Tool calls (MCP and native) with no single place to check them | `dql-mcp` `mcpToolHandlers`; `llm/tools.ts` `buildAgentTools` |

The fix is the same for all of them. Give each assumption one named seam with
a local default, then let a host replace the default.

## Detailed design

### The request context

```ts
export interface DqlPrincipal {
  /** Stable id; for the local default, the resolved local owner. */
  id: string;
  kind: 'person' | 'service';
  displayName?: string;
  email?: string;
  groups?: string[];
  /** Values row rules can read, e.g. region, cost_center. */
  attributes?: Record<string, string | number | boolean | string[]>;
  /** 'local' when DQL resolved it itself; 'host' when a hook supplied it. */
  source: 'local' | 'host';
}

export interface DqlRequestContext {
  principal: DqlPrincipal;
  requestId: string;
}
```

The request handler resolves the principal before dispatching a route. It
then runs the route inside `requestContext.run(ctx, …)`, using the same
`AsyncLocalStorage` pattern already used for provider evidence and Ask
traces.

Code reads the principal with `currentPrincipal()`. Background work (agent
runs, schedules) captures the context when it starts and restores it for
every step.

### The hooks

```ts
export interface DqlHostHooks {
  /** Who is asking. null → 401. Replaces the shared-token check when present. */
  resolvePrincipal?(req: IncomingMessage): Promise<DqlPrincipal | null>;

  /** Certify with every enterprise gate required; with a host, the host decides, not the request. */
  enterpriseCertification?: boolean;

  /** May this principal do this? Called at route dispatch and before tool calls. */
  authorize?(principal: DqlPrincipal, action: DqlAction, resource: DqlResource): Promise<DqlDecision>;

  /** Narrow a query to what the principal may see. Called for every query. */
  rowPolicy?(query: DqlQueryContext): Promise<{ sql: string; params: unknown[] } | DqlRefusal>;

  /** Credentials for a connection, as this principal. */
  credentials?(input: { principal: DqlPrincipal; connection: string; driver: string }): Promise<DqlConnectionSecret | DqlRefusal>;

  /** A model provider for a task; undefined → DQL's own choice. */
  modelProvider?(input: { route: DqlModelRoute; principal: DqlPrincipal }): AgentProvider | undefined;

  /** Whether result values may reach this provider (the privacy boundary). */
  isInBoundary?(provider: DqlProviderDescriptor): boolean;

  /** Where state lives. Each store has a local SQLite/file default. */
  stores?: {
    runs?: AgentRunStore;
    memory?: MemoryStoreFactory;
    conversations?: ConversationStoreFactory;
    traces?: TraceSink;
    audit?: AuditSink;
  };

  /** Wraps every tool call, MCP and native: check, log, or refuse. */
  tools?: ToolGateway;

  schedules?: ScheduleTrigger;
  delivery?: DeliverySink;
  signing?: SigningKeyProvider;
  git?: GitHost;
}
```

`LocalServerOptions` gains `hostHooks?: DqlHostHooks`. The CLI package adds
an `exports` entry for `startLocalServer` and the hook types, so an embedding
program imports a supported API rather than a file path.

### Local defaults (no hooks)

| Hook | Default |
|---|---|
| `resolvePrincipal` | The local owner from `resolveLocalOwner`. The shared-token check keeps working for non-loopback binds |
| `authorize` | Today's persona and App-policy checks, unchanged |
| `rowPolicy` | Today's `@rls` lowering for blocks. Every other query passes through unchanged |
| `credentials` | Project config plus the local credential vault (`.dql/local/private`) |
| `modelProvider` | Today's provider selection |
| `isInBoundary` | Ollama on a loopback URL (today's rule) |
| `stores.*` | Today's SQLite files. `traces` also writes OTLP when the standard `OTEL_EXPORTER_OTLP_ENDPOINT` is set |
| `tools` | Pass-through |
| `schedules`, `delivery`, `signing`, `git` | Today's in-process cron, notifiers, local signing key and `gh` |

### Rules every hook follows

1. **Fail closed:**
   - a hook that throws is treated as a refusal;
   - `resolvePrincipal` returning null gives a 401;
   - a `DqlRefusal` from `rowPolicy` or `credentials` is shown to the person, never retried with broader rights.
2. **Never fall back to a service credential.** If `credentials` refuses (for example, the person's warehouse token has expired), the answer is "reconnect", not a quiet retry as the service account.
3. **With a host, the request body no longer names actors.** Reviews, correction authors and the default owner of new content are stamped from the host's principal, and request fields such as `reviewer` and `author` are ignored. A content `owner` the author types (for example a team) stays content metadata; only its default comes from the person. The rule set a certification uses (`enterprise`) comes from the host, not the request. With no hooks, today's behaviour is kept exactly: the local owner, and names from the body. Recording who certified what is part of the audit sink (HH-6).
4. **One query path.** Every warehouse query goes through `ExecutionService.execute` or `executePreparedAgenticSqlBoundary`, including AI-written SQL. That path calls `rowPolicy` exactly once. A test enumerates direct `executeQuery` call sites and fails when a new one appears outside the allowlist.
5. **Caches are keyed by access.** The Dataset result cache already includes the persona policy fingerprint. It adds the principal's policy fingerprint, the hash of what `rowPolicy` returned, and the credential id.
6. **Records carry the person.** Runs, threads, memory items and trace spans record `principal.id`. With no hooks this is the local owner, so existing SQLite files gain a column with a default.

### Action vocabulary (for `authorize`)

`project.read`, `project.write`, `connection.manage`, `dataset.author`,
`dataset.certify`, `hint.review`, `app.author`, `app.publish`, `app.view`,
`ask`, `research`, `export`, `schedule.manage`, `git.review`,
`settings.manage`, `tool.<name>`.

Each route is tagged with one action and one resource
(`project`, `domain:<id>`, `dataset:<id>`, `app:<id>`, `block:<id>`). The
route table in `local-runtime.ts` grows a small `routeAction(method, path)`
map. It starts with the routes that change state and the routes that read
data.

### Privacy boundary

The OSS rule stays: result values reach a model only when the model runs on
this machine. `isInBoundary` generalises the check, which today is
hard-coded to Ollama on loopback, so a host can declare its own boundary.
The commercial host's wording, approved on 2026-09-25, is:

> Result values reach a model only when the model runs in the customer's own
> cloud account, in a region their admin approved, with data retention off —
> or on the person's own machine.

`resolveProviderResultRowEgressPolicy` consults `isInBoundary`. Ask still
sends zero result rows by default, whatever the boundary.

### Slices

Each slice ships on its own, with tests, and keeps the no-hooks behaviour
identical.

| Slice | Contents | Check |
|---|---|---|
| HH-1 | Request context, `resolvePrincipal`, `currentPrincipal()`; actors stamped from the principal; certification mode from the host; `startLocalServer` exported as `@duckcodeailabs/dql-cli/host` | A test server with a fake `resolvePrincipal` refuses unplaced requests (401, health open), answers overlapping requests as their own people, and records the principal as correction author and hint reviewer despite other names in the body; with no hooks, `/api/identity` and body-supplied names are unchanged |
| HH-2 | `authorize` at route dispatch; the persona registry reads the request context | Two concurrent requests with different principals see different App access; switching the persona in one request does not affect the other |
| HH-3 | One query path plus `rowPolicy`; cache keys by access | Call-site allowlist test; two principals, same question, different rows, from both a certified Dataset and AI-written SQL; a `rowPolicy` refusal stops the query |
| HH-4 | `credentials` and a connector factory registry (the documented plugin seam) | Pool keyed by credential id; a refusal gives "reconnect", never a service-account retry |
| HH-5 | `modelProvider`, `isInBoundary`; Bedrock and Vertex providers (OSS features in their own right) | Values egress follows `isInBoundary`; a Bedrock provider passes the provider contract tests |
| HH-6 | Store interfaces and injection (runs, memory, conversations, traces, audit); OTLP trace export | Stores swapped for in-memory fakes in tests; a principal id on every record |
| HH-7 | `tools` gateway around MCP and native tool calls; MCP HTTP transport with a host authenticator | A gateway that refuses `tool.run_sql` blocks it in both paths |
| HH-8 | `schedules`, `delivery`, `signing`, `git` | A schedule runs as its owner's principal; a delivery sink receives the digest |

## Progress

| Slice | Status |
|---|---|
| HH-1 | Implemented 2026-09-25 on `claude/oss-security-fixes` (`apps/cli/src/host/`, tests in `host-hooks.test.ts`); awaiting independent verification |

## Backward compatibility

Nothing changes for projects or for `dql notebook` with no hooks.

- The new principal columns are added with a default of the local owner.
- `dql.config.json`, `.dql` files and the manifest are unchanged.
- The one visible change is that the certify and review routes stop trusting
  actor fields in the request body when a principal exists. With no hooks, the
  principal is the local owner, which is what the UI already sends.

## Security considerations

- **Why the request body stops naming actors.** Today, anyone who can reach the server can certify in someone else's name. After HH-1, only the server can say who acted.
- **The one query path protects against more than row rules.** It is also where read-only checking, deadlines and cost guards are enforced for every query, not only those that remember to call it.
- **Hooks run in-process with full trust.** A host that loads untrusted hooks has already lost. The contract gives no sandbox.

## Alternatives considered

- **Fork DQL for commercial hosting.** Every OSS release would become merge work. The existing governed-analytics-cloud embed drifted three months behind for this reason.
- **Put a proxy in front of the server.** It can check who is asking, but it can't narrow AI-written SQL, stamp certification actors or key caches by access. Those decisions live inside the engine.
- **Pass the principal as a parameter through every call.** That touches hundreds of call sites. `AsyncLocalStorage` is already used for the same purpose in this file.
- **Build sign-in and roles into OSS.** Out of scope by the OSS boundary (AGENTS.md, `delivery-orchestration.md`).

## Unresolved questions

1. **Scope of `routeAction` for HH-2.** Should the first cut cover only routes that change state and routes that read data, with everything else treated as `project.read`?
2. **Store migration.** When a host supplies Postgres stores, do we provide a one-time import from existing SQLite files, or start empty?
3. **Viewer links.** The App share-link menu currently puts the server token in network links. Should a read-only viewer link come from HH-2's action map (only `app.view` and page runs allowed), or be removed until a host supplies sign-in?

## Adoption signal

- A commercial host runs DQL unchanged with its own sign-in, row rules and
  stores.
- Teams on a shared server can see who certified what.
- The `executeQuery` allowlist test stays green release after release.

## Process

Implement slice by slice on short branches. Each slice goes through
independent verification before it lands on main. OSS releases follow the
normal quiet-release path. Nothing in this RFC is pushed or published
without the owner's go-ahead.
