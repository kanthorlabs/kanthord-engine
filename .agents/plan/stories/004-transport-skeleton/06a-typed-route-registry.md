# Story 06a — The typed route registry

Epic: `.agents/plan/epics/004-transport-skeleton.md`
Depends on: Story 05 (`src/http/contract/errors.ts`).

EPIC 004's registry bullet is delivered by three stories. This one authors the registry itself; `06b` proves it against the proposal; `06c` generates `openapi.yaml` from it.

This story declares **identity** for every `routed` and `stubbed` row of `docs/proposal/api/` — fifty-three operations. It attaches a zod schema pair to none of them. A schema arrives with its use case, and Story 08 attaches the first two.

**"One zod schema pair per `operationId`" is a uniqueness rule, not a completeness rule.** Ulrich ratified this reading. It means a schema pair belongs to exactly one operation, an operation never carries two, and no second copy of a schema exists anywhere outside `src/http/contract/`. It does **not** mean every operation must carry one. An entry with no schema is therefore correct, not an omission, and the schema fields are optional on `Operation` for that reason.

The schedule, so a reader knows nothing is being dropped:

| Epic | Operations gaining a schema pair                                                                                           | Count |
| ---- | -------------------------------------------------------------------------------------------------------------------------- | ----- |
| 004  | `system.health`, `system.db`                                                                                               | 2     |
| 007  | the three `provider.*` reads and writes, `repository.inspect`, `repository.register`, `repository.list`, `repository.show` | 7     |
| 008  | the four `project.*`, the four `plan.*`, `node.list`, `node.show`, `edge.list`                                             | 11    |
| 010  | `system.status`, `blob.show`, `event.list`                                                                                 | 3     |

That completes all 23 `routed` operations by the end of phase 1. The 30 `stubbed` operations stay identity-only: a stub never reads a body, because `dispatchMiddleware` throws `501` before the body parser runs, and `docs/proposal/api/README.md:11` specifies no fields for them.

## Change

### 1. `src/http/contract/path.ts` (new)

```ts
import type { IdentityKind } from "../../domain/identity.ts";

export const resourceSegments = [
  "agent",
  "attempt",
  "blob",
  "event",
  "git-operation",
  "instruction",
  "node",
  "project",
  "provider",
  "repository",
  "run",
  "template",
  "worker",
] as const;

export const subresourceSegments = [
  "approval",
  "attempt",
  "binding",
  "check",
  "default",
  "edge",
  "landing-branch",
  "plan",
  "profile",
  "repository",
  "revision",
  "run",
  "worker",
] as const;

export const actionSegments = [
  "abandon",
  "approve",
  "cancel",
  "discard",
  "export",
  "import",
  "inspect",
  "publish",
  "reconcile",
  "rename",
  "resolve",
  "unblock",
  "validate",
  "verify",
  "waive",
] as const;

export const systemNamespaceSegments = ["db"] as const;
export const systemLeafSegments = ["health", "status"] as const;
export const systemSegments = ["db", "health", "status"] as const;

export type ResourceSegment = (typeof resourceSegments)[number];
export type SubresourceSegment = (typeof subresourceSegments)[number];
export type ActionSegment = (typeof actionSegments)[number];
export type SystemSegment = (typeof systemSegments)[number];

export type ParameterIdentity = IdentityKind | "node" | "deferred";

export type Segment =
  | Readonly<{ kind: "resource"; value: ResourceSegment }>
  | Readonly<{ kind: "subresource"; value: SubresourceSegment }>
  | Readonly<{ kind: "action"; value: ActionSegment }>
  | Readonly<{ kind: "system"; value: SystemSegment }>
  | Readonly<{ kind: "parameter"; value: "id"; identity: ParameterIdentity }>
  | Readonly<{ kind: "parameter"; value: "hash" }>;

export function resource(value: ResourceSegment): Segment;
export function sub(value: SubresourceSegment): Segment;
export function action(value: ActionSegment): Segment;
export function system(value: SystemSegment): Segment;
export function parameter(identity: ParameterIdentity): Segment;
export function hash(): Segment;

export function renderPath(segments: readonly Segment[]): string;
export function renderOpenApiPath(segments: readonly Segment[]): string;
export function parameterNames(segments: readonly Segment[]): readonly string[];
```

The five kinds are `docs/proposal/api/README.md:66-72`. The doc heads that column `Examples`; `docs/proposal/api/new-decisions.md:10` puts the closed sets in the registry, and these five arrays **are** the closed sets. Each array is sorted bytewise, so a new segment lands in one obvious place.

`renderPath` prefixes `/v1`, then joins each segment with `/`. A `parameter` renders as `:` plus its `value` — `:id` or `:hash`. `renderOpenApiPath` is identical except a parameter renders as `{id}` or `{hash}`, because OpenAPI templates a path parameter in braces and koa does not.

`parameterNames` returns the `value` of each parameter segment in order — `[]`, `["id"]` or `["hash"]`. No declared operation carries two parameters.

`parameter(identity)` builds `{ kind: "parameter", value: "id", identity }`; `hash()` builds `{ kind: "parameter", value: "hash" }`. The two constructors are separate because only one operation family uses a non-minted locator, and `docs/proposal/api/README.md:74` says so: "`blob/:hash` is the one content-addressed exception, and it is the only one."

`"deferred"` is a legal `ParameterIdentity` for exactly one operation, `template.show`. `docs/proposal/database/` holds no `template` table and `src/domain/identity.ts:3-21` holds no `template` kind, so the proposal fixes no prefix for it. `template.show` is `stubbed` and never parses its parameter, so the registry records the gap rather than inventing a prefix.

### 2. `src/http/contract/operation.ts` (new)

```ts
import type { ZodType } from "zod";

import type { Segment } from "./path.ts";

export const methods = ["DELETE", "GET", "POST", "PUT"] as const;
export type Method = (typeof methods)[number];

export const introducedInValues = [
  "phase-1",
  "phase-2",
  "phase-3",
  "post-mvp",
] as const;
export type IntroducedIn = (typeof introducedInValues)[number];

export const statusValues = ["routed", "stubbed", "deferred"] as const;
export type OperationStatus = (typeof statusValues)[number];

export type Operation = Readonly<{
  operationId: string;
  method: Method;
  path: readonly Segment[];
  introducedIn: IntroducedIn;
  status: "routed" | "stubbed";
  successStatus?: number;
  request?: ZodType;
  response?: ZodType;
}>;

export function operations(entries: readonly Operation[]): readonly Operation[];
```

`IntroducedIn` and `OperationStatus` carry all four and all three spellings of `docs/proposal/api/README.md:49-53`, because the parity test must name `post-mvp` and `deferred` to assert they are **absent** from the registry. An `Operation` admits only `routed` and `stubbed`, so a `deferred` row cannot be registered at all — that is the type-level half of the exclusion the epic requires.

`successStatus` is the status a `routed` operation answers on success, and it defaults to `200` when absent. It exists so a create operation is not documented as `200` by omission: `provider.register`, `repository.register` and `project.create` will each declare `201` when their use case lands in EPIC 007 or EPIC 008. No entry declares it in this story, because no entry has a handler yet and a status with no handler is a claim rather than a fact. A `stubbed` entry ignores the field; its only status is `501`.

`operations` is the identity function with the array typed. It exists so each domain module reads as one call and a stray object cannot enter the array untyped.

### 3. Ten domain modules under `src/http/contract/` (new)

One module per file of `docs/proposal/api/`, named for it. Each exports one `const` named for the domain, built with `operations([...])`. The fifty-three rows, verbatim from the tables cited:

`system.ts` — `docs/proposal/api/system.md:11-14`

| operationId     | method | path segments                    | introducedIn | status |
| --------------- | ------ | -------------------------------- | ------------ | ------ |
| `system.health` | GET    | `system("health")`               | phase-1      | routed |
| `system.db`     | GET    | `system("db"), system("status")` | phase-1      | routed |
| `system.status` | GET    | `system("status")`               | phase-1      | routed |
| `blob.show`     | GET    | `resource("blob"), hash()`       | phase-1      | routed |

`credential.ts` — `docs/proposal/api/credential.md:17-22`

| operationId           | method | path segments                                                   | introducedIn | status  |
| --------------------- | ------ | --------------------------------------------------------------- | ------------ | ------- |
| `provider.register`   | POST   | `resource("provider")`                                          | phase-1      | routed  |
| `provider.list`       | GET    | `resource("provider")`                                          | phase-1      | routed  |
| `provider.show`       | GET    | `resource("provider"), parameter("provider")`                   | phase-1      | routed  |
| `provider.rename`     | POST   | `resource("provider"), parameter("provider"), action("rename")` | phase-2      | stubbed |
| `provider.remove`     | DELETE | `resource("provider"), parameter("provider")`                   | phase-2      | stubbed |
| `provider.setDefault` | PUT    | `resource("provider"), parameter("provider"), sub("default")`   | phase-2      | stubbed |

`repository.ts` — `docs/proposal/api/repository.md:11-16`

| operationId                | method | path segments                                                            | introducedIn | status  |
| -------------------------- | ------ | ------------------------------------------------------------------------ | ------------ | ------- |
| `repository.inspect`       | POST   | `resource("repository"), action("inspect")`                              | phase-1      | routed  |
| `repository.register`      | POST   | `resource("repository")`                                                 | phase-1      | routed  |
| `repository.list`          | GET    | `resource("repository")`                                                 | phase-1      | routed  |
| `repository.show`          | GET    | `resource("repository"), parameter("repository")`                        | phase-1      | routed  |
| `repository.landingBranch` | POST   | `resource("repository"), parameter("repository"), sub("landing-branch")` | phase-2      | stubbed |
| `repository.reconcile`     | POST   | `resource("repository"), parameter("repository"), action("reconcile")`   | phase-2      | stubbed |

`project.ts` — `docs/proposal/api/project.md:11-15`. Rows `:16` and `:17` are `post-mvp` / `deferred` and get no entry.

| operationId              | method | path segments                                                              | introducedIn | status  |
| ------------------------ | ------ | -------------------------------------------------------------------------- | ------------ | ------- |
| `project.create`         | POST   | `resource("project")`                                                      | phase-1      | routed  |
| `project.list`           | GET    | `resource("project")`                                                      | phase-1      | routed  |
| `project.show`           | GET    | `resource("project"), parameter("project")`                                | phase-1      | routed  |
| `project.repositories`   | PUT    | `resource("project"), parameter("project"), sub("repository")`             | phase-1      | routed  |
| `binding.worker.project` | PUT    | `resource("project"), parameter("project"), sub("binding"), sub("worker")` | phase-2      | stubbed |

`graph.ts` — `docs/proposal/api/graph.md:15-21`

| operationId      | method | path segments                                                                | introducedIn | status |
| ---------------- | ------ | ---------------------------------------------------------------------------- | ------------ | ------ |
| `plan.validate`  | POST   | `resource("project"), parameter("project"), sub("plan"), action("validate")` | phase-1      | routed |
| `plan.import`    | POST   | `resource("project"), parameter("project"), sub("plan"), action("import")`   | phase-1      | routed |
| `plan.export`    | GET    | `resource("project"), parameter("project"), sub("plan"), action("export")`   | phase-1      | routed |
| `plan.revisions` | GET    | `resource("project"), parameter("project"), sub("plan"), sub("revision")`    | phase-1      | routed |
| `node.list`      | GET    | `resource("node")`                                                           | phase-1      | routed |
| `node.show`      | GET    | `resource("node"), parameter("node")`                                        | phase-1      | routed |
| `edge.list`      | GET    | `resource("project"), parameter("project"), sub("edge")`                     | phase-1      | routed |

`outcome.ts` — `docs/proposal/api/outcome.md:11-14`

| operationId    | method | path segments                                            | introducedIn | status  |
| -------------- | ------ | -------------------------------------------------------- | ------------ | ------- |
| `node.unblock` | POST   | `resource("node"), parameter("node"), action("unblock")` | phase-2      | stubbed |
| `node.abandon` | POST   | `resource("node"), parameter("node"), action("abandon")` | phase-2      | stubbed |
| `node.discard` | POST   | `resource("node"), parameter("node"), action("discard")` | phase-3      | stubbed |
| `node.waive`   | POST   | `resource("node"), parameter("node"), action("waive")`   | phase-3      | stubbed |

`execution.ts` — `docs/proposal/api/execution.md:11-18`

| operationId     | method | path segments                                           | introducedIn | status  |
| --------------- | ------ | ------------------------------------------------------- | ------------ | ------- |
| `run.start`     | POST   | `resource("project"), parameter("project"), sub("run")` | phase-2      | stubbed |
| `run.cancel`    | POST   | `resource("run"), parameter("run"), action("cancel")`   | phase-2      | stubbed |
| `run.list`      | GET    | `resource("run")`                                       | phase-2      | stubbed |
| `run.show`      | GET    | `resource("run"), parameter("run")`                     | phase-2      | stubbed |
| `node.attempts` | GET    | `resource("node"), parameter("node"), sub("attempt")`   | phase-2      | stubbed |
| `attempt.show`  | GET    | `resource("attempt"), parameter("attempt")`             | phase-2      | stubbed |
| `node.checks`   | GET    | `resource("node"), parameter("node"), sub("check")`     | phase-2      | stubbed |
| `worker.list`   | GET    | `resource("worker")`                                    | phase-2      | stubbed |

`instruction.ts` — `docs/proposal/api/instruction.md:11-18`. Row `:19` is `post-mvp` / `deferred` and gets no entry, which is also why no `:role` parameter exists.

| operationId            | method | path segments                                                                       | introducedIn | status  |
| ---------------------- | ------ | ----------------------------------------------------------------------------------- | ------------ | ------- |
| `agent.list`           | GET    | `resource("agent")`                                                                 | phase-2      | stubbed |
| `template.list`        | GET    | `resource("template")`                                                              | phase-2      | stubbed |
| `template.show`        | GET    | `resource("template"), parameter("deferred")`                                       | phase-2      | stubbed |
| `profile.instantiate`  | POST   | `resource("repository"), parameter("repository"), sub("profile")`                   | phase-2      | stubbed |
| `profile.export`       | GET    | `resource("repository"), parameter("repository"), sub("profile")`                   | phase-2      | stubbed |
| `profile.import`       | PUT    | `resource("repository"), parameter("repository"), sub("profile")`                   | phase-2      | stubbed |
| `profile.verify`       | POST   | `resource("repository"), parameter("repository"), sub("profile"), action("verify")` | phase-2      | stubbed |
| `instructions.resolve` | GET    | `resource("instruction"), action("resolve")`                                        | phase-2      | stubbed |

`integration.ts` — `docs/proposal/api/integration.md:11-14`

| operationId             | method | path segments                                                        | introducedIn | status  |
| ----------------------- | ------ | -------------------------------------------------------------------- | ------------ | ------- |
| `node.approvalEvidence` | GET    | `resource("node"), parameter("node"), sub("approval")`               | phase-2      | stubbed |
| `node.approve`          | POST   | `resource("node"), parameter("node"), action("approve")`             | phase-2      | stubbed |
| `repository.publish`    | POST   | `resource("repository"), parameter("repository"), action("publish")` | phase-2      | stubbed |
| `gitOperation.list`     | GET    | `resource("git-operation")`                                          | phase-3      | stubbed |

`event.ts` — `docs/proposal/api/event.md:11`. Row `:12` is `post-mvp` / `deferred` and gets no entry.

| operationId  | method | path segments       | introducedIn | status |
| ------------ | ------ | ------------------- | ------------ | ------ |
| `event.list` | GET    | `resource("event")` | phase-1      | routed |

### 4. `src/http/contract/registry.ts` (new)

```ts
import type { Method, Operation } from "./operation.ts";

export const registry: readonly Operation[];

export function findOperation(operationId: string): Operation | undefined;

export type RouteMatch = Readonly<{
  operation: Operation;
  parameters: Readonly<Record<string, string>>;
}>;

export function matchRoute(method: string, pathname: string): RouteMatch | null;

export type RegistryFault = Readonly<{ operationId: string; reason: string }>;

export function registryFaults(
  entries: readonly Operation[],
): readonly RegistryFault[];
```

`registry` concatenates the ten domain arrays in the module order `system, credential, repository, project, graph, outcome, execution, instruction, integration, event`, then sorts the result bytewise by `operationId` through `Buffer.compare`. The sort is what makes every derived artifact ordered without a second sort site.

`matchRoute(method, pathname)`:

1. Return `null` unless `method` is a member of `methods`.
2. Split `pathname` on `/`, drop the leading empty string, and return `null` unless the first element is `v1`. A trailing empty element from a trailing slash is dropped, so `/v1/node/` matches `/v1/node`.
3. Keep the operations whose `method` equals `method` and whose `path.length` equals the remaining segment count.
4. For each candidate, walk the segments pairwise. A non-parameter segment must equal the concrete segment exactly, bytewise. A parameter segment matches any concrete segment that is not the empty string, and binds `parameters[segment.value]` to it.
5. Order the surviving candidates so a candidate with fewer parameter segments comes first, and return the first. Return `null` when none survive.

Step 5 is the literal-over-parameter rule. It is stated even though `registryFaults` proves no concrete path reaches two candidates today, so a later row cannot make the match order depend on array order.

**A parameter value is not decoded.** `matchRoute` binds the raw segment. `decodeURIComponent` is not called, for two reasons. `docs/proposal/api/system.md:65` fixes the one parameter that could need it — "A colon is legal in a path segment, so nothing is percent-encoded" — so the daemon must see `sha256:9f2a` exactly as the client sent it. And `decodeURIComponent` throws a `URIError` on a malformed escape (measured: `decodeURIComponent("%ZZ")` throws), which inside a middleware would surface as `500 internal-error` — a client fault reported as a daemon fault. A caller that needs a decoded value decodes it in its own handler, where the failure is a `400 invalid-request` it raises deliberately.

`registryFaults` returns every violation of the assertion list of `docs/proposal/api/README.md:76`, one entry per fault, with `reason` one of the literal strings below. An empty array is a valid registry.

- `"duplicate operationId"` — two entries share an `operationId`.
- `"method and path collide"` — two entries share a `method` and a rendered `renderPath` value.
- `"path is ambiguous"` — two entries share a `method` and a segment count, and for every position either the segments are equal or at least one is a parameter. This is the condition under which one concrete path reaches two candidates.
- `"segment is invalid in its declared kind"` — a segment `value` is absent from the closed array of its `kind`.
- `"resource segment is plural"` — a `resource` or `subresource` segment `value` ends in `"s"`. The closed arrays already refuse an unknown spelling; this catches a plural added to an array.
- `"non-minted locator outside blob"` — an entry carries a `hash` parameter and its first segment is not `resource("blob")`.
- `"deferred identity outside template.show"` — an entry carries `identity: "deferred"` and its `operationId` is not `template.show`.
- `"segment sequence is not a legal path"` — the kind sequence is not accepted by the grammar below.

**The grammar, as a state machine over segment kinds.** A closed vocabulary alone is not the rule. `docs/proposal/api/README.md:78` is explicit: "A closed vocabulary alone would prove spelling and nothing else — it would accept `/v1/project/:id/project` and `/v1/status/status`. The grammar is what makes the rule mean something." So `registryFaults` walks the kinds and rejects a sequence no declared path uses.

A path is a **system path** or a **resource path**, and never a mix.

- A system path is one `systemLeafSegments` member, or one `systemNamespaceSegments` member followed by one `systemLeafSegments` member. Nothing else. That is why `systemSegments` splits in two: `/v1/health` and `/v1/status` are leaves, `/v1/db/status` is namespace-then-leaf, and `/v1/status/status` is rejected because `status` is not a namespace.
- A resource path starts with one `resource` segment, then follows these transitions to the end:
  - after `resource`: `parameter`, `subresource`, `action`, or end.
  - after `parameter`: `subresource`, `action`, or end.
  - after `subresource`: `subresource`, `action`, or end.
  - after `action`: end only. An action is terminal.
  - A second `resource` segment is legal nowhere, and a second `parameter` is legal nowhere.

Every one of the fifty-three declared paths is accepted by this machine, and both counterexamples of `README.md:78` are rejected: `[resource("project"), parameter, resource("project")]` fails because `resource` follows `parameter`, and `[system("status"), system("status")]` fails because `status` is not a namespace. `[resource("repository"), action("inspect")]` is accepted, which is why `resource → action` is a transition — `repository.inspect` and `instructions.resolve` are actions on a collection rather than on an instance.

## Constraints

- No file in this story imports koa, `@koa/*`, `node:http` or `node:sqlite`. `eslint.config.js:215-233` fails the build otherwise.
- No file in this story imports `node:fs`. `src/http/contract/` builds values; a test writes files.
- Attach no `request` or `response` schema to any entry. The two schemas of Story 08 are the first, and `docs/proposal/api/README.md:11` keeps every field schema out of the proposal and inside a use case.
- Do not register a `deferred` row. The four excluded `operationId` values are `binding.provider.project`, `binding.e2e.project`, `binding.provider.agents` and `event.stream`.
- `registry` is sorted once, in `registry.ts`. No other module sorts it.

## Verify

`node --test src/http/contract/path.test.ts` — new file, suite `"src/http/contract/path.test"`:

- Each of the five closed arrays is sorted bytewise: for each array, `[...array].sort()` deep-equals the array, and `new Set(array).size` equals `array.length`.
- `resourceSegments` has 13 members, `subresourceSegments` 13, `actionSegments` 15, `systemSegments` 3. Assert the counts, so an added segment is a deliberate diff.
- No member of `resourceSegments` or `subresourceSegments` ends in `"s"`.
- `renderPath([system("health")])` is `"/v1/health"`.
- `renderPath([system("db"), system("status")])` is `"/v1/db/status"`.
- `renderPath([resource("node"), parameter("node"), action("unblock")])` is `"/v1/node/:id/unblock"`.
- `renderPath([resource("blob"), hash()])` is `"/v1/blob/:hash"`.
- `renderOpenApiPath` of those same four tuples is `"/v1/health"`, `"/v1/db/status"`, `"/v1/node/{id}/unblock"`, `"/v1/blob/{hash}"`.
- `renderPath([])` is `"/v1"`.
- `parameterNames` of the four tuples above is `[]`, `[]`, `["id"]`, `["hash"]`.

`node --test src/http/contract/registry.test.ts` — new file, suite `"src/http/contract/registry.test"`:

- `registry.length` is `53`.
- `registry.map((entry) => entry.operationId)` is bytewise sorted, asserted through `Buffer.compare` over adjacent pairs, and holds 53 distinct values.
- `registry.filter((entry) => entry.status === "routed").length` is `23`, and `"stubbed"` is `30`.
- Counting `introducedIn`: `phase-1` is `23`, `phase-2` is `27`, `phase-3` is `3`. No entry is `post-mvp`.
- No entry has `status === "deferred"`; assert it at runtime as well as by type, because the parity test needs the runtime fact.
- For each of `binding.provider.project`, `binding.e2e.project`, `binding.provider.agents`, `event.stream`: `findOperation(id)` is `undefined`.
- No entry carries a `request` or a `response` key: `registry.every((entry) => entry.request === undefined && entry.response === undefined)`.
- `registryFaults(registry)` deep-equals `[]`.
- Exactly one entry carries a `hash` parameter, and its `operationId` is `blob.show`.
- Exactly one entry carries `identity: "deferred"`, and its `operationId` is `template.show`.
- `matchRoute("GET", "/v1/health")` returns `system.health` with `parameters` deep-equal `{}`.
- `matchRoute("GET", "/v1/db/status")` returns `system.db`, and `matchRoute("GET", "/v1/status")` returns `system.status` — the two-segment system path does not shadow the one-segment one.
- `matchRoute("POST", "/v1/node/task_01JQ8ZAN9P/unblock")` returns `node.unblock` with `parameters` deep-equal `{ id: "task_01JQ8ZAN9P" }`.
- `matchRoute("GET", "/v1/blob/sha256:9f2a")` returns `blob.show` with `parameters` deep-equal `{ hash: "sha256:9f2a" }`. A colon inside a segment is legal and is not percent-decoded away — `docs/proposal/api/system.md:65`.
- `matchRoute("POST", "/v1/repository/inspect")` returns `repository.inspect`, not a parameter match. This is the literal-over-parameter case.
- `matchRoute("GET", "/v1/node/")` returns `node.list` — a trailing slash is dropped.
- Each of these returns `null`: `matchRoute("GET", "/v1/nope")`, `matchRoute("PATCH", "/v1/health")`, `matchRoute("GET", "/health")`, `matchRoute("GET", "/v2/health")`, `matchRoute("GET", "/v1/health/extra")`, `matchRoute("GET", "/v1/node//unblock")`, `matchRoute("PUT", "/v1/agent/re@1/binding/provider")`.
- `matchRoute` is proved over the whole registry: for every entry, replace each parameter segment with the literal `"x_01"`, render the concrete path, and assert `matchRoute(entry.method, concretePath)?.operation.operationId === entry.operationId`. Fifty-three assertions from one loop.
- `registryFaults` is proved to fire, using synthetic arrays rather than the real registry. One case per reason, each asserting the returned `reason` strings deep-equal the expected list:
  - two entries with the same `operationId` → `["duplicate operationId"]`.
  - two entries with the same method and rendered path under different ids → contains `"method and path collide"`.
  - `GET [resource("node"), parameter("node")]` beside `GET [resource("node"), sub("run")]` → contains `"path is ambiguous"`.
  - an entry whose segment object is hand-built with `{ kind: "resource", value: "repositories" }` cast through `as unknown as Segment` → contains both `"segment is invalid in its declared kind"` and `"resource segment is plural"`.
  - `GET [resource("event"), hash()]` → contains `"non-minted locator outside blob"`.
  - an entry with `operationId: "node.show"` and `parameter("deferred")` → contains `"deferred identity outside template.show"`.
- The grammar rejects both counterexamples of `docs/proposal/api/README.md:78`, each asserted by name:
  - `GET [resource("project"), parameter("project"), resource("project")]` → contains `"segment sequence is not a legal path"`. This is `/v1/project/:id/project`.
  - `GET [system("status"), system("status")]` → contains `"segment sequence is not a legal path"`. This is `/v1/status/status`.
- The grammar rejects each of these too, one case per sequence: `[action("import")]` (an action first); `[parameter("node")]` (a parameter first); `[resource("node"), action("unblock"), action("abandon")]` (an action is terminal); `[resource("node"), parameter("node"), parameter("node")]` (two parameters); `[system("health"), resource("node")]` (a mixed path); `[system("db")]` (a namespace with no leaf); `[resource("node"), sub("run"), parameter("run")]` (a parameter after a subresource); `[]` (an empty tuple).
- The grammar accepts the collection-action form: `registryFaults` on a one-entry array holding `POST [resource("repository"), action("inspect")]` deep-equals `[]`.
- The grammar is proved over the whole registry, which is the assertion that keeps it honest: every one of the 53 entries is accepted. `registryFaults(registry)` deep-equalling `[]` already covers it, so assert additionally that the 53 kind sequences reduce to a set of distinct shapes and that each is accepted on its own — a one-entry `registryFaults` call per entry returns `[]`.

`npm run verify` exits 0.

Proof: contributes `src/http/contract/path.test.ts` and `src/http/contract/registry.test.ts` to `node --test src/http/**/*.test.ts`. Stories 06b and 06c contribute `parity.test.ts` and `openapi.test.ts`.
