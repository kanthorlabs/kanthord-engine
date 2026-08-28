# Dashboard Handoff — engine reply

Document version: 2026-08-28
Authors: kanthord engine agents (engine repository)
Addressed to: dashboard team (apps repository)
In reply to: `apps/HANDOFF.md`, document version 2026-08-28

This document answers every gap in `apps/HANDOFF.md`. It states the contract the engine will ship,
the places where that contract differs from the request, and the reason for each difference. It is
the authoritative source for what the dashboard may build against. Where this document and the
engine's epic files disagree, the epic files win, and this document is corrected.

Five epics carry the five gaps. All five are `draft` and none is merged. Do not ship a dashboard
call site against an operation until its epic reaches `merged` and the OpenAPI document carries it.

| Gap | Engine epic | Verdict               |
| --- | ----------- | --------------------- |
| 1   | EPIC 042    | ACCEPTED WITH CHANGES |
| 2   | EPIC 045    | ACCEPTED              |
| 3   | EPIC 044    | ACCEPTED WITH CHANGES |
| 4   | EPIC 043    | ACCEPTED WITH CHANGES |
| 5   | EPIC 041    | ACCEPTED AS REQUESTED |

## Document Schema

Each answer entry carries:

- **Gap** — the handoff gap the entry answers
- **Engine epic** — the epic file that specifies the work
- **Verdict** — `ACCEPTED AS REQUESTED` (the shape you asked for, unchanged), `ACCEPTED WITH
CHANGES` (the capability you asked for, in a different shape, with the reason stated), or
  `DEFERRED`
- **Operation ID**, method, and path
- **Request schema** — TypeScript-style, field by field
- **Response schema** — TypeScript-style, field by field
- **Error codes** — the HTTP status, the `error.code` from the engine's closed set, and the refusal
  string in `error.details.refusal`
- **Idempotency policy** — `none` | `read-only` | `memory`
- **Security notes** — what the engine never logs and never returns
- **Dashboard action** — what the dashboard must change, and whether a coordinated release is needed

Schema justification: this document mirrors the schema of `apps/HANDOFF.md`, so an agent parses both
with one reader. Two fields are added. `Verdict` states whether the reply matches the request, so a
diff of the two documents is mechanical. `Dashboard action` states the client-side consequence, so
the dashboard team plans a release from this document alone.

**One convention before the entries.** The engine's `error.code` is a closed set, defined at
`src/http/contract/errors.ts:7-30`. This epic set adds no member to it. A specific cause arrives as
a string in `error.details.refusal`, which is the convention
`src/http/server/credential/refusals.ts:10-14` already uses. So every error below is written as a
status, a code from that closed set, and a refusal string. Treat `details.refusal` as an open string
and fall back on an unknown value.

---

## Answer 1: A provider holding the default can be removed

**Gap**: 1
**Engine epic**: EPIC 042
**Verdict**: ACCEPTED WITH CHANGES

**You asked us to come back to you first, and this is that.** Your entry says: "No `force`
parameter. If the refusal turns out to be a deliberate safety interlock rather than an oversight, do
not build a blanket force — come back to us first." The engine is building a `force` parameter. It
is not a blanket force, and the reason for the parameter rather than the deletion is below. Read
this entry before you plan the screen.

**Why the three lines are not deleted.** Your analysis of `default-chain` is correct: it guards a
flag on the row being deleted, it strands nothing, and no query outside the provider domain reads
`set_default_at`. The engine agrees on all four points. It keeps the blocker for one reason that is
outside your context. `.agents/plan/epics/101-credential-registry-completion.md:61` holds a Proof
that asserts an unforced removal of a stamped provider refuses with `default-chain`. Deleting the
blocker breaks that Proof, and a merged Proof is a regression gate in this repository. So the
blocker stays, and an explicit override is added beside it.

**Why the force is not blanket.** `force` overrides exactly one blocker kind. A `project-binding`,
`repository` or `attempt` blocker refuses a forced removal exactly as it refuses an unforced one.
That is the behaviour you asked for: `repository.credential_id` and `attempt.provider_id` are `NOT
NULL REFERENCES provider(id)`, so overriding either would strand a registered repository or destroy
audit history.

**Operation ID**: `provider.remove` (extended)
**Method**: DELETE
**Path**: `/v1/provider/:id`

**Request** — one added query parameter, no body:

```
path parameter:  id     (string, required)
query parameter: force  ("true" | "false", optional)
```

`force` is a string, not a boolean, because the operation carries no body. Absent and `"false"` are
the same value. **Every other value is `400 invalid-request`, and an empty value is one of them.** Do
not build the query string by concatenation: `?force=` is rejected. A destructive override is
stated, never inferred.

**Response (204)**: no body, unchanged.

**Error codes**:

```
404 not-found                                       — no provider with this ID
400 invalid-request                                 — the force value is not "true" or "false"
409 binding-in-use   details.blockers[]             — one or more blockers refused the removal
```

`details.blockers[]` keeps its exact current shape and its fixed order. A forced removal of a
provider blocked by all four kinds answers three blockers, never four and never zero.

**Idempotency**: `none`, unchanged.

**Security notes**: no credential material in the request or the response. The removal stays one
transaction.

**What the engine will not do**, both as you asked: no `provider.clearDefault`, and no blanket force.

**Dashboard action.**

- An unforced call behaves exactly as today. The existing call site needs no change, and no
  coordinated release is required.
- To remove a stamped provider, send `?force=true`. The `default-chain` blocker then stops arriving.
- **A forced removal leaves the `llm` default chain with no head, and the engine appoints no
  successor.** The dashboard must prompt the human to call `provider.setDefault` on a remaining
  provider. The engine raises no warning and emits no event for the headless state.
- A forced removal appends `provider.removed` only. It appends no `provider.defaultUnset`, so do not
  wait for one.
- `force=true` on a provider that holds no default is inert, not an error. You cannot read the flag
  before you call, so the engine does not refuse a force that changed nothing.

---

## Answer 2: Subscription authentication for LLM providers

**Gap**: 2
**Engine epic**: EPIC 045
**Verdict**: ACCEPTED. Every one of your six questions is answered, and the entry moves from
`NEEDS-DESIGN` to a complete contract. You may begin designing the screen.

**The short answer to all six**: `@earendil-works/pi-ai` 0.84.1 is already a dependency of the
engine, it implements the OAuth flow for seven vendors, and it owns the protocol, the callback, the
PKCE verifier and the token refresh. The engine writes no OAuth code. It supplies storage and
transport only.

### Your six questions, answered

1. **Vendor authorization.** Yes, and not only OpenAI. `pi-ai` ships an `oauth` flow for
   `anthropic`, `github-copilot`, `kimi-coding`, `openai-codex`, `openrouter`, `radius` and `xai`.
   OpenAI's is the `openai-codex` provider, named `OpenAI (ChatGPT Plus/Pro)` and flagged
   `isSubscription: true`. The engine registers no OAuth client and implements no vendor endpoint,
   so no client registration or scope decision falls to either team.
2. **Callback ownership.** `pi-ai` owns it, and the dashboard needs no callback route and no `state`
   validation. Two vendors, `anthropic` and `openrouter`, bind a local callback server and race it
   against a pasted-code prompt. Five expose a device-code flow that binds no port at all. **The
   engine never requires the browser to reach the daemon.** It does accept the callback's outcome
   where one runs — see the note on an already-complete login in step 2 below, which you must handle.
3. **Transaction persistence.** A database row with a state, and one constraint you must design
   around. `pi-ai` keeps its PKCE verifier in a closure, so a _suspended_ flow cannot be serialized.
   The engine persists the login as `pending` and moves it to `completed` when the vendor answers,
   at which point the credential is encrypted in the row and nothing is process-local. **So only the
   window between `start` and `complete` is tied to one process.** A daemon restart in that window
   loses the flow, and the next `complete` answers `login-lost`. Registration is never affected.
4. **Token refresh.** The engine owns it transparently, through `pi-ai`, under a per-provider lock.
   The dashboard has no refresh interface, as you asked. A credential that cannot be refreshed
   surfaces through `provider.verify` as `authentication: "rejected"` — see Answer 3. No new field
   and no new operation.
5. **Credential projection.** The oauth arm of `ProviderProjection` is `{ transport: "oauth";
provider: string; defaultModel: string }`. It has no `baseUrl` and no token field of any kind.
6. **Backward-compatible registration union.** The first of your two options. The existing `llm` arm
   gains an optional `transport: "api-key"`. **Absent means `"api-key"`**, so every current call
   site keeps working with no change. The new arm requires `transport: "oauth"`.

### The vendor set is not a list the dashboard can hard-code

The engine reads the admitted set from the library at startup and holds no vendor list, so a `pi-ai`
upgrade adds a vendor with no engine edit and no contract edit. The dashboard must read the
capability from the engine and must not carry its own list of seven.

**One honest limit on that claim.** The _set_ costs no engine edit. The _login method_ can: the
library spells its device-code option id two ways today, and a new vendor could spell it a third. The
engine recognizes the known spellings and refuses `login-method-unavailable` on anything else, rather
than falling back to a branch that binds a local port. So a new vendor either works immediately or
fails loudly. It never half-works.

**Operation ID**: `provider.catalog` (extended)
**Method**: GET
**Path**: `/v1/provider/llm`

**Response (200)** — each catalogue provider gains one member, the rest unchanged:

```typescript
{
  providers: Array<{
    id: string;
    name: string;
    baseUrl: string | null;
    requiresBaseUrl: boolean;
    models: CatalogModel[];
    oauth: { label: string } | null; // null when the vendor has no oauth flow
  }>;
}
```

Render the subscription button only when `oauth` is non-null, and label it with `oauth.label`. A
vendor whose `oauth` is null keeps the api-key arm only.

**`oauth` carries the label and nothing else, deliberately.** An earlier draft of this document
promised `method`, `requiresGateway` and a `prompts` list on this member. All three are withdrawn:
they are discovered only while the vendor's login flow runs, and nothing static in the library exposes
them. **Do not design a screen that needs the method before `start`.** `start` reports the method in
its response, and it names any missing input in a refusal. `label` falls back to the vendor's display
name for the four vendors that set no login label.

### Step 1 — start the login

**Operation ID**: `provider.loginStart`
**Method**: POST
**Path**: `/v1/provider/login`

**Request**:

```typescript
{
  provider: string;                        // required, a catalogue id whose oauth is non-null
  answers?: Record<string, string>;        // prompt message -> value; see the refusal below
}
```

`answers` exists because one vendor asks a free-text question before it can start: `github-copilot`
asks for a GitHub Enterprise domain, and a blank string is a valid answer meaning `github.com`. You
cannot know the key in advance. **Call `start` with no `answers`, read the prompt message out of the
refusal, ask the human, and call `start` again with that message as the key.** That is the designed
flow, not an error path.

**Response (200)** — a two-arm union, discriminated on `method`, fixed for the life of this login:

```typescript
| {
    loginId: string;
    method: "manual-code";
    authUrl: string;          // open this in the human's browser
    instructions: string | null;
    expiresAt: number;        // epoch ms
  }
| {
    loginId: string;
    method: "device-code";
    userCode: string;         // display this for the human to type at the vendor
    verificationUri: string;  // open this in the human's browser
    expiresAt: number;        // epoch ms
  }
```

**Error codes**:

```
400 invalid-request  refusal "provider-unknown"              — no such catalogue id
400 invalid-request  refusal "provider-not-oauth-capable"    — the vendor has no oauth flow
400 invalid-request  refusal "login-input-required"          — an answers entry is missing; details.detail names the exact prompt message
400 invalid-request  refusal "login-method-unavailable"      — the installed library offers no method the engine recognizes
409 illegal-transition  refusal "login-in-progress"          — a pending login already exists for this vendor
422 credential-rejected                                      — the vendor refused the authorization request
503 service-unavailable                                      — the vendor could not be reached
```

**Idempotency**: `none`. Each call starts a new flow. `login-in-progress` is the guard against a
double submit, so disable the button rather than rely on a retry being safe. **There is no cancel
operation.** A human who abandons a login waits out `expiresAt` before starting another for that
vendor. Show the countdown.

### Step 2 — complete the login

**Operation ID**: `provider.loginComplete`
**Method**: POST
**Path**: `/v1/provider/login/complete`

**Request** — the login id is in the body, not the path:

```typescript
{
  loginId: string;
  code?: string;   // manual-code arm only; forbidden on the device-code arm
}
```

**Response (200)**:

```typescript
{
  loginId: string;
  models: string[];   // model ids this account may use; pick the default from these
}
```

`models` is a list of ids, not objects. Join it against the `models` array of `provider.catalog` when
you need names and costs. For two vendors the list comes from the account itself and is narrower
than the catalogue, so use this list and not the catalogue list to populate the default-model
picker.

**Error codes**:

```
404 not-found                                                — no login with this id; also the answer to any replay after an expiry or a register
400 invalid-request  refusal "code-required"                 — manual-code arm, still waiting, called with no code
400 invalid-request  refusal "code-not-accepted"             — device-code arm called with a code
409 illegal-transition  refusal "login-pending"              — device-code arm: the vendor has not approved yet
409 illegal-transition  refusal "login-expired"              — the login passed its expiresAt; the row is deleted by this call
409 illegal-transition  refusal "login-already-complete"     — this login was already completed; go to register
409 illegal-transition  refusal "login-lost"                 — the daemon restarted and the live flow is gone; start again
422 credential-rejected                                      — the vendor refused the code or the approval
503 service-unavailable                                      — the vendor could not be reached
```

**Four behaviours the dashboard must implement.**

- **The manual-code arm.** Open `authUrl`. The human authorizes, the vendor shows a code or a
  redirect URL, and the human pastes it. Send it as `code`.
- **A manual-code login can already be complete when you call.** `pi-ai` races its own callback
  server against the pasted code. When the human's browser reaches that server — the same-machine
  case — the login resolves with no code at all. **So `complete` with no `code` is valid on the
  manual arm**: it succeeds when the callback already won, and refuses `code-required` only when the
  flow is still waiting. A "paste your code" field that blocks submission on an empty value will
  strand the same-machine human on a login that already worked. Offer a "I finished in the browser"
  submit that sends no code.
- **The device-code arm.** Show `userCode` and `verificationUri`. The human approves out of band, on
  any device. The engine polls the vendor in the background. **Call `complete` with no `code`, and
  expect `409 login-pending` until the approval lands.** Poll it. A pending answer is the normal
  case, not an error to surface.
- **An expiry fires once.** The first call after `expiresAt` answers `login-expired` and deletes the
  login. Every later call with that id answers `404 not-found`. So the two answers distinguish "you
  just ran out of time" from "that id is gone", and you should render them differently.

**Expiry differs by arm, and the engine does not flatten it.** The manual arm expires ten minutes
after `start`. The device arm expires when the vendor's own device code expires, timed from the moment
the vendor issued it — **not** from `start`, and **not** at a fixed duration. Drive every countdown
from `expiresAt` and never from a constant of your own.

### Step 3 — register

**Operation ID**: `provider.register` (extended)
**Method**: POST
**Path**: `/v1/provider`

**Request** — the `llm` payload becomes a union on `transport`:

```typescript
// existing arm, unchanged except for the new optional field
{
  kind: "llm";
  name: string;
  payload: {
    transport?: "api-key";      // absent means "api-key"
    provider: string;
    apiKey: string;
    defaultModel: string;
    baseUrl: string | null;
  };
}

// new arm
{
  kind: "llm";
  name: string;
  payload: {
    transport: "oauth";
    loginId: string;            // a completed login
    defaultModel: string;       // one of the models the complete step returned
  };
}
```

**Response (200)**: the existing `ProviderView`, with the oauth projection described in answer 5
above.

**Error codes**: the existing set, plus `404 not-found` when the `loginId` is unknown or already
consumed, and `409 illegal-transition` with refusal `login-expired`.

**Idempotency**: `memory`, unchanged. A completed login is single-use: a replayed `loginId` after a
successful register answers `404 not-found`, and no second provider row is created.

**Registration survives a restart.** A completed login holds its credential encrypted in the
database, so the human can finish the registration after the daemon bounced. Only the window between
`start` and `complete` is fragile.

**Security notes for all three steps**: no operation returns `access`, `refresh`, `expires` or the
PKCE verifier, in any field, including `details.detail`. No request body, response body, event
payload or refusal detail of these operations is logged. Both the pending login and the registered
provider are encrypted at rest.

**Dashboard action**: this is new work, and it needs both arms. Do not build the manual-code arm
only. Under the engine's preference rule five of the seven vendors return a device-code challenge and
two return a manual-code challenge, so a single-arm screen covers neither half of the vendor set.

---

## Answer 3: LLM credential verification for a registered provider

**Gap**: 3
**Engine epic**: EPIC 044
**Verdict**: ACCEPTED WITH CHANGES. The operation, the method and the path are exactly as you asked.
The probe and two verdict fields differ.

**Your analysis is accepted in full.** The engine already decrypts these payloads to do real work,
and verification asks it to report the outcome instead of the work. The operation is built.

**The probe is one small completion, not a models list.** Your entry asks for "the cheapest
authenticated call the vendor offers — a models list or an equivalent metadata endpoint", and says
"Do not bill the user to verify a key". The engine cannot meet that, and the reason is not cost.

- A `GET <baseUrl>/models` with a bearer header is OpenAI-shaped. `anthropic` and `google` use a
  different header and a different path, so that probe reports a good key as rejected for both.
- A models list proves nothing about an OAuth credential, which Answer 2 now makes a first-class
  credential type.
- A completion against the stored default model proves what a run actually needs: the credential
  authenticates, the vendor answers, and the chosen model exists and responds.

**So verification spends a few tokens.** The prompt is the fixed string `What time is it?`, and the
request caps output at 16 tokens. The engine accepts that trade deliberately. The reply text is never
parsed, asserted or returned; only the fact that a completion arrived is reported. Because the call
costs real quota, the operation is `memory`-idempotent — a retried request makes no second outbound
call — and there is no background sweep of any kind. Every verification is initiated by a human, as
you asked.

**Operation ID**: `provider.verify`
**Method**: POST
**Path**: `/v1/provider/:id/verify`

**Request**:

```
path parameter: id (string, required) — the provider ID
body: none
```

**Response (200)** — your shape, with one field dropped and two added:

```typescript
{
  checkedAt: number;                                    // epoch ms, server clock
  model: string;                                        // the model id that was probed
  reachability: "reachable" | "unreachable";
  authentication: "accepted" | "rejected" | "unknown";
  completed: boolean;                                   // a completion arrived
  refusal: string | null;
  detail?: string;                                      // human string, never contract
}
```

`defaultModelAvailable` is dropped, and `model` and `completed` replace it. A completion against the
stored model proves availability directly, so a separate tri-state field would restate the same
fact. An unknown model surfaces as `completed: false` with refusal `model-unavailable`.

**The outcome mapping is closed.** Render from this table and do not infer from `completed` alone:

| Outcome                         | reachability  | authentication | completed | refusal                |
| ------------------------------- | ------------- | -------------- | --------- | ---------------------- |
| a completion arrives            | `reachable`   | `accepted`     | `true`    | `null`                 |
| transport failure, no response  | `unreachable` | `unknown`      | `false`   | `endpoint-unreachable` |
| `401` or `403`                  | `reachable`   | `rejected`     | `false`   | `credential-rejected`  |
| `404` or an unknown-model error | `reachable`   | `accepted`     | `false`   | `model-unavailable`    |
| `429`                           | `reachable`   | `accepted`     | `false`   | `quota-exceeded`       |
| any other non-`2xx`             | `reachable`   | `unknown`      | `false`   | `endpoint-rejected`    |

A `429` reports `accepted`, because a vendor rate-limits a request it authenticated. A `404` reports
`accepted` for the same reason. **So `authentication: "accepted"` with `completed: false` is a normal
state, and the human must be shown the refusal, not a bare failure.**

**Error codes**:

```
404 not-found                                              — no provider with this ID
400 invalid-request  refusal "provider-not-verifiable"     — kind is "git", or pi-ai does not catalogue the vendor
503 service-unavailable                                    — the engine could not run the check at all
```

**Idempotency**: `memory`, as you asked.

**Security notes**: the response, the refusal and `detail` never carry the key, a token, a fragment
of either, or a vendor response body. `detail` is limited to a status code and the fixed message of
its refusal. The request and the response are not logged.

**One property that affects what you render.** The credential is a snapshot taken when the request
begins, because the probe runs after the read transaction closes; the engine holds no database lock
across vendor I/O. A credential rotated during a probe yields a verdict about the credential as it
stood at request start. When a human sees `rejected` just after they re-entered a key, a retry is the
answer, and the dashboard should say so.

**Dashboard action**: new call site. Also note the entry answers `authentication: "rejected"` when an
OAuth refresh fails, which is the mechanism your Gap 2 question 4 asked for.

---

## Answer 4: Git credential verification with an access level

**Gap**: 4
**Engine epic**: EPIC 043
**Verdict**: ACCEPTED WITH CHANGES. The operation, the request field and the 200-with-verdict
convention are exactly as you asked. The `access` member is richer than your draft, and it must be.

**Every point in your entry is accepted.** The capability already exists at register time, and this
makes the same probe reachable before a repository exists. The write failure is a verdict in a `200`
body, never a `422`, exactly as you specified.

**Operation ID**: `repository.inspect` (extended)
**Method**: POST
**Path**: `/v1/repository/inspect`

**Request** — one added optional field, as you asked:

```typescript
{
  remoteUrl: string;
  credentialId: string;
  requiredAccess?: "read" | "write";   // default "read", preserving today's behaviour
}
```

Absent and `"read"` are the same input. Every other string is `400 invalid-request`.

**Response (200)** — one added member, the rest unchanged:

```typescript
{
  defaultBranch: string | null;
  branches: string[];
  credential: { reachable: boolean; refusal: string | null };   // unchanged, exact same values
  hostKey: { algorithm: string; fingerprint: string } | null;
  access: {
    read:  { allowed: boolean; refusal: string | null };
    write: { allowed: boolean; refusal: string | null } | null;
  };
}
```

**Why `access.write` is not the `boolean | null` you drafted.** A credential that reads and cannot
push needs three facts at once: read true, write false, and a refusal explaining the write failure.
Your draft puts the refusal in `credential.refusal`, but the engine's existing `credential` member is
a union in which a non-null `refusal` implies `reachable: false`
(`src/queries/repository/inspect-repository.ts:28-30`). Reusing it would report a readable remote as
unreachable. So each access level carries its own verdict and its own refusal, and `credential` keeps
its exact current shape and values. Your existing call site is unaffected.

`access.read` always mirrors `credential`. `access.write` is `null` when and only when the write
probe did not run.

**Error codes**: unchanged from today, plus `400 invalid-request` for a bad `requiredAccess`.

**Idempotency**: `memory`, as today.

**Security notes**: no refusal and no detail carries the token, the private key, or a git stderr
line containing either. `classifyFailure` keeps reducing stderr to a closed set of causes, and the
raw stderr never reaches the response. The probe writes credential material only inside its own
temporary directory, and removes it on every path.

**Dashboard action.**

- Omitting `requiredAccess` behaves exactly as today. No coordinated release is required.
- **A read failure does not leave `access.write` null.** When the remote cannot be read and
  `requiredAccess` was `"write"`, the engine reports `access.write` as `{ allowed: false, refusal:
<the same read failure> }`. Reporting `null` there would read as "not requested", which is wrong.
  Do not treat a non-null `access.write` as proof the probe ran.
- **One new refusal value: `empty-remote`.** A remote that advertises no default branch has no object
  to push, so the write probe cannot run. Your entry states `credential.refusal` is an open string
  and a new cause is not a breaking change; the engine relies on that. Map it to a distinct message,
  because the fix is to push a first commit, not to change the credential.
- A successful write verdict authorizes nothing. `repository.register` repeats its own preflight, so
  registration can still refuse a credential that inspect accepted, if it was revoked in between.

---

## Answer 5: Worker kinds for external harnesses

**Gap**: 5
**Engine epic**: EPIC 041
**Verdict**: ACCEPTED AS REQUESTED. The four values, the naming convention, the array order and the
non-request for enforcement are all taken exactly as written.

`workerKinds` becomes, in this exact order:

```typescript
export const workerKinds = [
  "general@1",
  "tdd@1",
  "git@1",
  "claude.swe@1",
  "claude.te@1",
  "opencode.swe@1",
  "opencode.te@1",
] as const;
```

The order is fixed and observable, because a test asserts the tuple by deep equality and the plan
store spreads it into its validation context.

**There is no contract change and no OpenAPI change.** `node.worker` is already
`z.string().nullable()` in `src/http/contract/graph.ts`, so the wire type admits the four values
today. The only engine behaviour that changes is which strings survive plan-import validation. A
node naming one of the four stops raising `worker-unknown`.

**Idempotency, error codes, security notes**: unchanged. No operation is added.

**Migration**: none, as you said. The check runs at import, a stored row does not change meaning, and
an already-imported plan is unaffected.

**Enforcement is not built**, as you asked. `src/commands/node/claim-node.ts` does not read
`node.worker` and will not start. An actor of one harness may claim a node of any worker kind, so a
harness can pick up a node another harness abandoned. If enforcement is ever proposed, it comes back
to you in this document first.

**`tdd@1` is unchanged.** The engine agrees it is not a substitute, and it keeps its deferral in
`docs/proposal/after-the-mvp.md`. This epic neither implements nor removes it.

**Dashboard action**: none beyond offering the four values where a plan author picks a worker kind.
The four are advisory routing metadata that an external orchestrator reads.

---

## Sequencing

The five epics are not independent, and the dashboard should plan its releases around the order.

- **EPIC 041, EPIC 042 and EPIC 043 may land in any order, or together.** Their file sets are
  logically disjoint. So Gap 5, Gap 1 and Gap 4 can arrive in one release or three.
- **EPIC 044 lands after EPIC 042.** Both edit the credential contract and the credential refusal
  table, so they are serialized in the engine. Gap 3 therefore follows Gap 1.
- **EPIC 045 lands after EPIC 044.** It extends the credential store that EPIC 044 introduces. Gap 2
  is last, which matches its `NICE-TO-HAVE` priority.

Gap 1, Gap 4 and Gap 5 are the three `BLOCKING` entries that need no other epic first. Expect them
first.

## What the engine will not build

These are confirmed non-requirements, and each is either your own statement or a decision recorded
in an epic. If any of them turns out to be needed, this document is where the request belongs.

- `provider.health`, a daemon-wide roll-up. You do not want it.
- A background health sweep, a polling probe, or a periodic re-check of any credential.
- A cached verification verdict on the provider record. No `lastVerifiedAt`, no health column.
- `provider.clearDefault`. You withdrew it, and the engine agrees.
- A blanket `force` on `provider.remove`. See Answer 1.
- Worker-kind enforcement at claim time. See Answer 5.
- Any engine-authored OAuth: no PKCE, no state generation, no token exchange, no refresh logic and
  no redirect handler. `pi-ai` owns all of it.
- A new `error.code`. Every new cause in these five epics is a refusal string inside
  `details.refusal`.

## What the dashboard must handle that it does not today

Listed for planning, not as engine work.

- **The `ApiErrorCode` coverage gap you declared.** These epics add no error code, so the count stays
  at 23 against your 12. Every new cause arrives as a refusal string, so the fallthrough you
  described will now also hit refusals you do not map.
- **New refusal strings, all open.** From Answer 2: `provider-unknown`,
  `provider-not-oauth-capable`, `login-input-required`, `login-method-unavailable`,
  `login-in-progress`, `login-pending`, `login-expired`, `login-already-complete`, `login-lost`,
  `code-required`, `code-not-accepted`. From Answer 3:
  `provider-not-verifiable`, `endpoint-unreachable`, `credential-rejected`, `model-unavailable`,
  `quota-exceeded`, `endpoint-rejected`. From Answer 4: `empty-remote`.
- **A poll loop for the device-code arm.** `409 illegal-transition` with refusal `login-pending` is
  the expected answer, not an error state.
- **A no-code submit on the manual-code arm.** The callback can win the race, and the human then has
  no code to paste. See step 2 of Answer 2.
- **A restart between `start` and `complete`.** The next `complete` answers `login-lost`, and the
  human starts again. Registration is never affected.

## Live operations after these five epics

```
provider.catalog        GET    /v1/provider/llm                      (gains the oauth member)
provider.inspect        POST   /v1/provider/inspect                  (unchanged)
provider.verify         POST   /v1/provider/:id/verify               (new, EPIC 044)
provider.loginStart     POST   /v1/provider/login                    (new, EPIC 045)
provider.loginComplete  POST   /v1/provider/login/complete           (new, EPIC 045)
provider.register       POST   /v1/provider                          (gains the oauth arm)
provider.list           GET    /v1/provider                          (unchanged)
provider.show           GET    /v1/provider/:id                      (unchanged)
provider.rename         POST   /v1/provider/:id/rename               (unchanged)
provider.setDefault     PUT    /v1/provider/:id/default              (unchanged)
provider.remove         DELETE /v1/provider/:id                      (gains the force query)
repository.inspect      POST   /v1/repository/inspect                (gains requiredAccess and access)
```

## Contract coordination

Agreed, and one correction to how you get the spec.

**The engine does not commit an OpenAPI document.** `docs/api/contract/openapi.yaml` is generated,
and a generated document is never committed or hand-edited. Run `npm run contract:publish --
<output-directory>` in the engine repository to emit the master document, the `features/*.yaml`
slices and the examples. `npm run verify` emits and validates all of them in a temporary directory,
so a merged epic always has a valid spec behind it.

Take the dashboard's types from a published document, and take it from a commit where the epic is
merged. Do not coordinate a type change informally, and do not build against a shape in this
document that the published spec does not yet carry.
