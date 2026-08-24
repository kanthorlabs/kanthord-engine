# Story 6 — The capability names the wait

Epic: `.agents/plan/epics/028-event-long-poll.md`

Independent of every other story in the epic.

## Change

### `src/http/contract/capability.ts`

In `capabilityOperations` (lines 5-14), add one entry as the **first** key, before `"external-drive"` at line 6:

```ts
  "event-wait": ["event.list"],
```

The position is load-bearing. `src/http/contract/capability.test.ts:34-40` asserts that `capabilityName.options` equals `Object.keys(capabilityOperations)` **and** that those options are already bytewise sorted. `event-wait` sorts before `external-drive`, because `eve` is less than `ext` at the third byte — `v` is `0x76` and `x` is `0x78`. An entry appended at the end fails that test.

Change nothing else in the file. `declaredCapabilities` at lines 22-40 needs no change: it already filters on every listed operation being `routed` and sorts the result bytewise.

`event.list` is `routed` at `src/http/contract/event.ts:69`, so `event-wait` is declared.

## Constraints

- The capability maps to `event.list` and to nothing else. Do not name `event.stream`, which is `post-mvp` and `deferred` and would suppress the capability.
- Add no second capability, and do not touch `external-drive`, `per-node-write` or `project-graph`.
- Do not change `allowedActors` on `event.list`. It stays `["human"]`.
- Add no description, status or wrapper object to the entry. A capability is a name mapped to an operation-id list.

## Verify

### `src/http/contract/capability.test.ts`

Amend the expected list at lines 43-48. It reads today:

```ts
assert.deepEqual(declaredCapabilities(registry), [
  "external-drive",
  "per-node-write",
  "project-graph",
]);
```

It becomes:

```ts
assert.deepEqual(declaredCapabilities(registry), [
  "event-wait",
  "external-drive",
  "per-node-write",
  "project-graph",
]);
```

Add these tests:

- **`event-wait` maps to exactly one operation.** `capabilityOperations["event-wait"]` deep-equals `["event.list"]`.
- **`event-wait` is the first key.** `Object.keys(capabilityOperations)[0]` equals `"event-wait"`.
- **A stubbed `event.list` suppresses the name.** Mirror the test at lines 50-59: pass a registry whose `event.list` entry carries `status: "stubbed"` and assert the result deep-equals `["external-drive", "per-node-write", "project-graph"]`.
- **An absent `event.list` suppresses the name.** Mirror the test at lines 62-69 with `event.list` filtered out, asserting the same three-name list.

The tests at lines 18-24 (every capability operation id resolves in the real registry), 26-32 (every one is `routed`), 34-40 (map keys equal the enum options, bytewise sorted) and 72-76 (the result is bytewise sorted) need no edit and must keep passing.

### `src/main.capability.test.ts`

Amend the expected list in `the capability list is the expected list` at lines 124-128 to the same four names, in the same order:

```ts
assert.deepEqual(body.capabilities, [
  "event-wait",
  "external-drive",
  "per-node-write",
  "project-graph",
]);
```

The test at lines 106-116 compares the served list against `declaredCapabilities(registry)` and needs no edit.

Change nothing else in the file.

### Commands

```bash
node --test src/http/contract/capability.test.ts src/main.capability.test.ts
```

`npm run verify` exits 0.

Proof: `PASS EPIC-028` for `src/http/contract/capability.test.ts`. Delivers the Hermetic coverage bullet "The capability appears".
