# Story 8 — The policy amendment and the capability swap

Epic: `.agents/plan/epics/050.2-the-run-renew-release-and-report.md`
Depends on: Story 7 (`07-the-worker-contract`), for `node.renew` in the registry and `node.heartbeat` gone from it.
Kind: story-foundation

## Change

### 1 — the policy amendment

`docs/proposal/api/README.md:89` — `## Versioning` opens the section. The forbidden list opens at
`docs/proposal/api/README.md:101` — `never` and its items are `:103` through `:106`.

**`add a required request field` is no longer among them.** A human moved it to the permitted list on
2026-09-03, and `docs/proposal/api/README.md:98` — `required` now carries it, with the ruling and its
condition recorded at `docs/proposal/api/README.md:110` — `moved`. So `runId` and `runFence` arriving
as required fields is a legal change, and this story's amendment covers the epic's **other** two
breaks: `heartbeatIntervalMs` leaving the `node.renew` response, which
`docs/proposal/api/README.md:103` — `remove` forbids, and `node.heartbeat` being removed, which the
closed list permits nowhere.

`docs/proposal/api/README.md:108` — `closed` reads:

> The list is closed. A change outside it is a `/v2`, and this product has no `/v2`.

Replace that sentence with the amendment. Use the wording recorded at
`.agents/plan/epics/046-worker-model-overview.md:74` — `closed by default`:

> The list is closed by default. A change outside it is legal only when a human records the ruling in the epic that makes it, and the capability name covering the affected operations is retired and replaced. A client reads `system.health.capabilities`, so it cannot call a changed shape unknowingly. The daemon still serves one wire version, and there is no `/v2`.

### 2 — the superseded decision is a human edit, not this story's

`.agents/plan/epics/023-version-compatibility-policy.md:35` — `D1` restates the closed list at `:48`
through `:56` and needs a supersession note. **No role may write it.**
`scripts/lane-check.sh` denies `.agents/plan/*` to `test-engineer`, `software-engineer` and
`groundwork-engineer` alike, and `.agents/plan/authoring.md:118` states the plan tree is never a
`Paths:` entry. The note is therefore an item for the human, tracked in the report of this epic's
authoring, and this story writes nothing under `.agents/plan/`.

What this story does own is the consequence in the shipped document: section 1's sentence is the
record a reader reaches, and case 9 asserts it.

### 3 — the capability swap

`src/http/contract/capability.ts:5` — `capabilityOperations` binds
`src/http/contract/capability.ts:7` — `external-drive` to `node.claim`,
`src/http/contract/capability.ts:9` — `node.heartbeat`, `node.release` and `node.report` — precisely
the four operations this epic changes. Retire it and declare `worker-model` in its place:

```ts
export const capabilityOperations = {
  "event-wait": ["event.list"],
  "per-node-write": ["node.create", "node.update", "node.delete"],
  "project-graph": ["project.nodes", "project.graph"],
  "worker-model": ["node.claim", "node.renew", "node.release", "node.report"],
} as const satisfies Readonly<Record<string, readonly string[]>>;
```

The keys are bytewise sorted, and `src/http/contract/capability.test.ts:34` — `it` asserts
`capabilityName.options` equals `Object.keys(capabilityOperations)` and is bytewise sorted, so
`worker-model` moves to last. `src/http/contract/capability.ts:23` — `declaredCapabilities` needs no
change: it filters on every listed operation being `routed` and sorts bytewise.

A client reading `system.health.capabilities` sees `external-drive` gone and cannot call the old shape
unknowingly. That is the handshake EPIC 023 built, and it is the announcement of this breaking change.

### 4 — every consumer of the retired name

Retiring a name is a deletion, so the consumer set is enumerated rather than swept. Beyond
`src/http/contract/capability.ts` and its own test, `external-drive` appears at:

| site                                         | what it holds                                          |
| -------------------------------------------- | ------------------------------------------------------ |
| `src/http/contract/capability.test.ts:45`    | the expected four-name list                            |
| `src/http/contract/capability.test.ts:79`    | a second expected list                                 |
| `src/http/contract/capability.test.ts:91`    | a third expected list                                  |
| `src/http/contract/capability.test.ts:101`   | a fourth expected list                                 |
| `src/http/contract/system.ts:84`             | the hand-written `system.health` example literal       |
| `src/http/contract/system.test.ts:97`        | a two-name expected list, different from `:84`'s three |
| `src/main.capability.test.ts:126`            | the composition-root capability assertion              |
| `src/queries/system/read-health.test.ts:12`  | the query's expected list                              |
| `src/queries/system/read-health.test.ts:174` | a second occurrence                                    |
| `src/queries/system/read-health.test.ts:199` | a third occurrence                                     |
| `src/queries/system/read-health.test.ts:209` | a fourth occurrence                                    |
| `src/queries/system/read-health.test.ts:211` | a fifth occurrence                                     |
| `src/http/server/system/health.test.ts:17`   | the handler's expected list                            |
| `src/http/server/system/health.test.ts:39`   | a second occurrence                                    |
| `src/services/home-lock/startup.test.ts:129` | the startup log assertion                              |
| `docs/proposal/api/system.md:24`             | the documented capability list                         |

Every one of these fails on the swap unless it is changed, and each appears in the `node --test`
command below or in `pnpm run verify`.

### 5 — the `system.health` example

`src/http/contract/system.ts:84` — `capabilities` holds a hand-written literal:

```ts
capabilities: ["external-drive", "per-node-write", "project-graph"],
```

It is already stale — it names three capabilities while the live registry declares four, which
`src/http/contract/capability.test.ts:42` — `it` asserts. Replace it with the correct four in bytewise
order:

```ts
capabilities: ["event-wait", "per-node-write", "project-graph", "worker-model"],
```

### 6 — the compatibility record

`docs/proposal/api/README.md` has no compatibility record section. Create one as the last `##` section
of the file, after `docs/proposal/api/README.md:299` — `## Identity`:

```markdown
## Compatibility record

Each row records one change outside the closed list of `## Versioning`, the epic whose human ruling made it legal, and the capability swap that announced it.

| epic       | change outside the closed list                           | capability retired | capability declared |
| ---------- | -------------------------------------------------------- | ------------------ | ------------------- |
| EPIC 050.1 | `heartbeatIntervalMs` leaves the `node.claim` response   | `external-drive`   | `worker-model`      |
| EPIC 050.2 | `node.heartbeat` is removed and replaced by `node.renew` | `external-drive`   | `worker-model`      |
| EPIC 050.2 | `heartbeatIntervalMs` leaves the `node.renew` response   | `external-drive`   | `worker-model`      |
```

Three rows, one per change of this wire generation that the closed list forbids. Two candidates are
**not** rows, and each is excluded by a different permission. `runId` and `fence` arriving on the
`node.claim` response is permitted by `docs/proposal/api/README.md:95` — `add a response field`.
`available`, `runId` and `runFence` becoming required request fields is permitted by
`docs/proposal/api/README.md:98` — `required`, since the 2026-09-03 ruling. A record of legal changes
would hide the illegal ones.

The table shape is four columns and is fixed here, because EPIC 050.4 Story 8
(`08-lease-held-is-retired`), EPIC 050.5 Story 8 (`08-the-proposal-records-the-removal`) and EPIC 057
each append a row in exactly this shape, with the epic cell written `EPIC <nnn>`.

### 7 — the version is not bumped

`src/domain/version.ts:1` — `KANTHORD_VERSION` stays at `"27.8.1"`, and `package.json:3` —
`"version"` stays with it. A human ruled this epic records no version bump: the capability list is
what describes the wire, `src/domain/version.test.ts:13` — `assert.equal` binds the constant to the
manifest, and the two halves live in different lanes so moving them costs a story slot for no wire
signal. EPIC 050.4 Story 0 (`00-groundwork`) moves the pair to `29.0.0` for the whole block.

Consequently this epic edits `package.json` nowhere, needs no path that
`scripts/lane-check.sh` denies to both engineers, and holds no `00-groundwork.md`.

## Constraints

- Retire `external-drive` completely. Do not keep it beside `worker-model`.
- `worker-model` names exactly four operations: `node.claim`, `node.renew`, `node.release`,
  `node.report`.
- Do not touch `src/domain/version.ts` or `package.json`.
- Do not write anything under `.agents/plan/`. Section 2 is the human's.
- Do not add a `/v2` anywhere, and do not add a version negotiation field.
- The compatibility record is a table with four columns, and the epic cell reads `EPIC <nnn>`. EPIC
  050.4, EPIC 050.5 and EPIC 057 each append to it.

## Verify

```
node --test src/http/contract/capability.test.ts src/http/contract/runtime-matrix.test.ts src/http/contract/system.test.ts src/http/contract/example.test.ts src/main.capability.test.ts src/queries/system/read-health.test.ts src/http/server/system/health.test.ts src/services/home-lock/startup.test.ts src/domain/version.test.ts test/helpers/proposal.test.ts
```

Every file section 4 enumerates appears in that command, except
`docs/proposal/api/system.md`, which `pnpm run verify` reaches through the parity comparison.

Update `src/http/contract/capability.test.ts`:

1. `"declaredCapabilities omits external-drive and includes worker-model"` — replace the expected
   list at `src/http/contract/capability.test.ts:44` — `event-wait` through `:47` with
   `assert.deepEqual(declaredCapabilities(registry), ["event-wait", "per-node-write", "project-graph", "worker-model"])`.
   The assertion reads the function's real output over the real registry, which is the client-visible
   announcement of the breaking change.

2. `"external-drive is not a capability name"` — assert
   `Object.hasOwn(capabilityOperations, "external-drive") === false` and
   `capabilityName.safeParse("external-drive").success === false`. This is the control for case 1: it
   proves the name is gone, not merely unlisted.

3. `"worker-model names the four worker operations"` —
   `assert.deepEqual(capabilityOperations["worker-model"], ["node.claim", "node.renew", "node.release", "node.report"])`.

4. `"stubbing node.report removes worker-model"` — update the shipped case at
   `src/http/contract/capability.test.ts:59` — `it`, whose expected list at `:65` through `:69` must
   now read `["event-wait", "per-node-write", "project-graph"]`.

5. `"worker-model is the last key"` — assert
   `Object.keys(capabilityOperations).at(-1) === "worker-model"`. The shipped bytewise case at
   `src/http/contract/capability.test.ts:34` — `it` covers the rest of the order.

6. `"the system.health example lists the four declared capabilities"` — in
   `src/http/contract/system.test.ts`, assert the example literal at
   `src/http/contract/system.ts:84` — `capabilities` deep-equals `declaredCapabilities(registry)`.
   Asserting against the function rather than a second literal is what stops the two drifting again,
   and it repairs the shipped three-name staleness in the same case.

7. `"every remaining external-drive site names worker-model"` — for each file of section 4 outside
   `src/http/contract/`, assert its expected list holds `worker-model` and does not hold
   `external-drive`. One case, one assertion per file, so a missed site is a named failure rather
   than a mystery.

Add cases 8 and 9 to `test/helpers/proposal.test.ts`, the suite that already reads documents under
`docs/proposal/` and asserts their content.

8. `"the compatibility record names every change of this wire generation"` — read
   `docs/proposal/api/README.md`, take the `## Compatibility record` section, parse its table rows,
   and assert exactly four rows: two whose epic cell is `EPIC 050.1` and two whose epic cell is
   `EPIC 050.2`, every one naming `external-drive` retired and `worker-model` declared. This makes
   the record a checked artifact rather than prose.

9. `"the versioning section carries the exception sentence"` — read the same file and assert the
   `## Versioning` section contains the string `"closed by default"` and does **not** contain
   `"The list is closed. A change outside it is a "`. Both halves are asserted, so the replacement is
   complete rather than additive.

10. `"KANTHORD_VERSION is unchanged"` — assert `KANTHORD_VERSION === "27.8.1"` and that it equals
    `package.json`'s `version`. The shipped case at `src/domain/version.test.ts:12` — `KANTHORD_VERSION`
    already pins the pair; this case pins the value, so a stray bump inside this epic is a named
    failure.

`pnpm run verify` exits 0.

Proof: PASS lines delivered — `src/http/contract/capability.test.ts`,
`src/http/contract/runtime-matrix.test.ts` and `test/helpers/proposal.test.ts` in `PASS EPIC-050.2`.
