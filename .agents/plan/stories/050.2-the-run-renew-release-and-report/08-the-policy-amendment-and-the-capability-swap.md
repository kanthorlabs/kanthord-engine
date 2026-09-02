# Story 8 — The policy amendment and the capability swap

Epic: `.agents/plan/epics/050.2-the-run-renew-release-and-report.md`
Depends on: Story 7 (`node.renew` is in the registry and `node.heartbeat` is gone).
Kind: story-foundation

## Change

### 1 — the policy amendment

`docs/proposal/api/README.md` holds the `## Versioning` section at line 89. The forbidden list opens at line 100 and its items are lines 102-106; `add a required request field;` is line **105**. Line 108 reads:

> The list is closed. A change outside it is a `/v2`, and this product has no `/v2`.

Replace that sentence with the amendment. Use the wording recorded in `.agents/plan/epics/046-worker-model-overview.md:74`:

> The list is closed by default. A change outside it is legal only when a human records the ruling in the epic that makes it, and the capability name covering the affected operations is retired and replaced. A client reads `system.health.capabilities`, so it cannot call a changed shape unknowingly. The daemon still serves one wire version, and there is no `/v2`.

### 2 — the superseded decision

`.agents/plan/epics/023-version-compatibility-policy.md:35-60` is decision D1. The file's convention is `### D<n> — <the ruling as a clause>` under a `## Decisions` heading at `:33`. Add one line directly under the D1 heading at `:36`, before the body:

> **Superseded in part by EPIC 050.2.** The closed list at `:48-54` is closed by default, not absolutely. `docs/proposal/api/README.md` carries the exception sentence. Nothing else in D1 changes.

Do not delete D1 and do not renumber the decisions.

### 3 — the capability swap

`src/http/contract/capability.ts:5-15` binds `external-drive` to `node.claim`, `node.heartbeat`, `node.release` and `node.report` — precisely the four operations this epic changes. Retire it and declare `worker-model` in its place:

```ts
export const capabilityOperations = {
  "event-wait": ["event.list"],
  "per-node-write": ["node.create", "node.update", "node.delete"],
  "project-graph": ["project.nodes", "project.graph"],
  "worker-model": ["node.claim", "node.renew", "node.release", "node.report"],
} as const satisfies Readonly<Record<string, readonly string[]>>;
```

The keys are bytewise sorted, and `src/http/contract/capability.test.ts:34-40` asserts `capabilityName.options` equals `Object.keys(capabilityOperations)` and is bytewise sorted, so `worker-model` moves to last. `declaredCapabilities` at `:23-41` needs no change: it filters on every listed operation being `routed` and sorts bytewise.

A client reading `system.health.capabilities` sees `external-drive` gone and cannot call the old shape unknowingly. That is the handshake EPIC 023 built, and it is the announcement of this breaking change.

### 4 — the version bump

`src/domain/version.ts:1` reads `export const KANTHORD_VERSION = "27.8.1";`. Change it to `"28.0.0"`. `src/domain/version.test.ts:12-14` asserts `KANTHORD_VERSION === pkg.version`, so `package.json`'s `version` field must move to `28.0.0` in the same edit. The policy states the package version describes a build; the bump records this block, and the capability list is what describes the wire.

### 5 — the `system.health` example

`src/http/contract/system.ts:84` holds a hand-written literal:

```ts
capabilities: ["external-drive", "per-node-write", "project-graph"],
```

It is already stale — it names three capabilities while the live registry declares four (`src/http/contract/capability.test.ts:42-49`). Replace it with the correct four in bytewise order:

```ts
capabilities: ["event-wait", "per-node-write", "project-graph", "worker-model"],
```

### 6 — the compatibility record

`docs/proposal/api/README.md` has no compatibility record section. Create one, as the last `##` section of the file, after `## Identity` at `:297`:

```markdown
## Compatibility record

Each row records one change outside the closed list of `## Versioning`, the epic whose human ruling made it legal, and the capability swap that announced it.

| epic       | change outside the closed list                                                                                                                                       | capability retired | capability declared |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------- |
| EPIC 050.1 | `available` becomes a required field of the `node.claim` request                                                                                                     | `external-drive`   | `worker-model`      |
| EPIC 050.1 | `heartbeatIntervalMs` leaves the `node.claim` response                                                                                                               | `external-drive`   | `worker-model`      |
| EPIC 050.2 | `node.heartbeat` is removed and replaced by `node.renew`                                                                                                             | `external-drive`   | `worker-model`      |
| EPIC 050.2 | `runId` and `runFence` become required fields of the `node.renew`, `node.release` and `node.report` requests; `heartbeatIntervalMs` leaves the `node.renew` response | `external-drive`   | `worker-model`      |
```

Four rows, one per change of this wire generation that the closed list forbids. `runId` and `fence`
arriving on the `node.claim` response is **not** a row: `docs/proposal/api/README.md:92` already
permits adding a response field, and a record of legal changes would hide the illegal ones.

The table shape is four columns and is fixed here, because EPIC 050.4 Story 8, EPIC 050.5 Story 8 and
EPIC 057 each append a row in exactly this shape, with the epic cell written `EPIC <nnn>`.

## Constraints

- Retire `external-drive` completely. Do not keep it beside `worker-model`.
- `worker-model` names exactly four operations: `node.claim`, `node.renew`, `node.release`, `node.report`.
- `KANTHORD_VERSION` and `package.json` `version` move together.
- Do not add a `/v2` anywhere, and do not add a version negotiation field.
- The compatibility record is a table with four columns, and the epic cell reads `EPIC <nnn>`. EPIC 050.4, EPIC 050.5 and EPIC 057 each append to it.

## Verify

```
node --test src/http/contract/capability.test.ts src/http/contract/runtime-matrix.test.ts src/http/contract/system.test.ts src/domain/version.test.ts src/http/contract/example.test.ts test/helpers/proposal.test.ts
```

Update `src/http/contract/capability.test.ts`:

1. `"declaredCapabilities omits external-drive and includes worker-model"` — replace the assertion at `:42-49` with `assert.deepEqual(declaredCapabilities(registry), ["event-wait", "per-node-write", "project-graph", "worker-model"])`. The assertion reads the function's real output over the real registry, which is the client-visible announcement of the breaking change.

2. `"external-drive is not a capability name"` — assert `Object.hasOwn(capabilityOperations, "external-drive") === false` and `capabilityName.safeParse("external-drive").success === false`.

3. `"worker-model names the four worker operations"` — `assert.deepEqual(capabilityOperations["worker-model"], ["node.claim", "node.renew", "node.release", "node.report"])`.

4. Update the stub-drop case at `:59-70`: stubbing `node.report` must now remove `worker-model`, leaving `["event-wait", "per-node-write", "project-graph"]`.

5. `"worker-model is the last key"` — assert `Object.keys(capabilityOperations).at(-1) === "worker-model"`, and the shipped bytewise-sorted case at `:34-40` covers the rest.

Add:

6. `"KANTHORD_VERSION is 28.0.0"` — in `src/domain/version.test.ts`, assert the literal by value. The shipped case at `:12-14` then pins `package.json` to the same string.

7. `"the system.health example lists the four declared capabilities"` — in `src/http/contract/system.test.ts`, assert the example literal at `src/http/contract/system.ts:84` deep-equals `declaredCapabilities(registry)`. Asserting against the function rather than a second literal is what stops the two drifting again.

Add cases 8 and 9 to `test/helpers/proposal.test.ts`, which is the suite that already reads documents under `docs/proposal/` and asserts their content.

8. `"the compatibility record names every change of this wire generation"` — read `docs/proposal/api/README.md`, take the `## Compatibility record` section, parse its table rows, and assert exactly four rows: two whose epic cell is `EPIC 050.1` and two whose epic cell is `EPIC 050.2`, every one naming `external-drive` retired and `worker-model` declared. This makes the record a checked artifact rather than prose.

9. `"the versioning section carries the exception sentence"` — read the same file and assert the `## Versioning` section contains the string `"closed by default"` and does not contain `"The list is closed. A change outside it is a "`. Both halves are asserted, so the replacement is complete rather than additive.

`pnpm run verify` exits 0.

Proof: PASS lines delivered — `src/http/contract/parity.test.ts` in `PASS EPIC-050.2`, plus the `capability` and `runtime-matrix` coverage the EPIC names beyond the Proof.
