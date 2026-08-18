# Story 15 — `P1B-E2`, the two-client exit journey

Epic: `.agent/plan/epics/020-wiring-and-scenarios.md`
Depends on: Story 14.

**This is the block's exit criterion.** It executes the complete journey of `013-external-drive-overview.md:13`, and it combines no fact from `P1B-E1`.

## Change

### A new `scripts/e2e/lib/scenario/p1b-e2.ts`

Driver `podman`, profile `fixture`, plan `three-objective`, mode `deterministic`. It builds the two-client topology of Story 9, runs `runJourney` from the first client, and registers **two** harness actors through the configured token, one per client container, each token captured inside its own container by `--token-file`.

```ts
const first = await registerHarness(driver, "client", "p1b-e2-first");
const second = await registerHarness(driver, "client2", "p1b-e2-second");
```

The daemon runs with the `DaemonConfig` of Story 10, `leaseTtlMs` at its default.

The ten phases run in this order.

1. **Two independent authentications.** Both clients run `node list --state ready --kind task`, each with its own `--api-token-file`, and each answers `200`. The two responses are equal by an exact identity-and-state comparison. Names `client1-list-status`, `client2-list-status`, `both-lists-equal`.
2. **The one race.** Both clients issue `node.claim` on alpha's first task through `issueAs`, **both promises in flight, awaited together** with `Promise.all`. Exactly one answer is `200` and the other is `409 lease-held`. **The answer order is not asserted.** The winner becomes `alphaActor` and the loser becomes `betaActor`, and every later phase names a role rather than a container. Names `race-one-success`, `race-one-lease-held`.
3. `betaActor` claims alpha's second task and answers `409 lease-held`, and its claim on **alpha itself** answers `409 lease-held`. That is the one-harness-per-objective rule of `018-claim-and-lease.md:26`. Names `sibling-claim-refused`, `objective-claim-refused`.
4. `betaActor` claims beta's first task and answers `200`, while `alphaActor` still holds its alpha lease. Two leases are live in one daemon at one time, asserted from **both claim responses**. Names `beta-claim-status`, `two-leases-live`.
5. Each actor works every sibling task of its own objective through `runHarnessTask`, in dependency order, and every report answers `200`. Labels `alpha-1`, `alpha-2`, `beta-1`, `beta-2`.
6. Each actor attests its own objective through `attestObjective`. Both objectives read `awaiting_approval`, and each `node show` returns the `attestedObjectId` its **own** harness attested, asserted different from the other. Names `alpha-state-attested`, `beta-state-attested`, `attested-object-ids-differ`.
7. `node close` by a harness token is `403 actor-forbidden`. The configured human token closes alpha; **`gamma` still reads `pending`**. The same token closes beta; **`gamma` then reads `ready`**. **Gamma's first task reads `ready` throughout and proves no transition**, because readiness gates on `depends_on` edges alone and that task declares none; `gamma-first-task-ready` therefore asserts a standing state rather than a move. Names `close-harness-forbidden`, `alpha-closed`, `gamma-pending-after-first-close`, `beta-closed`, `gamma-ready-after-second-close`, `gamma-first-task-ready`.
8. `kanthord event list`, run with the configured human token, shows each `lease.claimed` and each `outcome.reported` event with its own actor id and the actor kind `harness`. **The scenario reads the printed records and never raw HTTP**, because Story 3 ships the command. The two actor ids are asserted different. Names `event-list-claims`, `event-list-reports`, `event-actor-ids-differ`.
9. **The idempotency oracle.** Both actors send one identical `Idempotency-Key` on `node.claim` for **gamma's first task** — one node id, two actors — through `issueAs`. The first answers `200`. The second answers `409 lease-held`, and its body is asserted **different from the first captured body**, so it replayed nothing. That is the actor-scoped record key of `015-actor-identity.md:74`. Names `idempotency-first-status`, `idempotency-second-status`, `idempotency-bodies-differ`.
10. `runTransportCases` of `scripts/e2e/lib/scenario/transport.ts:70` runs **from the second client**, and `assertNoDisclosure` runs over both client containers.

### The declaration and the manifest land here

In the same change as the scenario module:

- Add the `P1B-E2` entry to `scenarios` at `scripts/e2e/lib/scenario/index.ts:21`: mode `deterministic`, driver `podman`, profile `fixture`, plan `three-objective`.
- Add the `P1B-E2` entry to `expectedAssertions`, composed as `[...fixtureProfileAssertionNames, ...journeyAssertionNames, ...<the phase names above>, ...transportAssertionNames]`, with each `runHarnessTask` label's names spread through `harnessTaskAssertionNames(label)` in its emission position.

### A new `scripts/e2e/lib/scenario/p1b-e2.test.ts`

Cases over a fake driver and a recording context:

- `it("registers one harness per client container", ...)` — assert the two `registerActor` roles are `client` and `client2`.
- `it("issues both claims of phase 2 before it awaits either", ...)` — assert both requests were issued before the first resolved.
- `it("asserts one success and one lease-held without asserting which client won", ...)` — run the fake twice with the two outcomes swapped and assert the scenario passes both times.
- `it("records its assertion names in the declared order", ...)`.
- `it("sends one idempotency key on one node id from two actors", ...)` — assert the two recorded requests carry the same key, the same path and two different token files.
- `it("runs the transport cases from the second client", ...)` — assert the role.

## Constraints

- **What this scenario does not prove.** Every request except phase 2 is sequential, so it proves two identities, two namespaces and server-side arbitration, and **it does not prove concurrent traffic**. `src/services/storage/connection.ts:90-101` and the synchronous `node:sqlite` driver make two transactions non-interleaving in one process. Phase 2 is the only assertion that needs two requests in flight. State that in a comment-free way: the scenario file asserts nothing about interleaving.
- `http.allowedHosts` is exactly `kanthord-daemon:7421`. Both container clients resolve the alias, so a client that reached a container IP answers `403 host-forbidden` at `src/http/server/host.ts:20`. `runTransportCases` proves that refusal; the inline block of `p1-e4.ts` is not exported and is not reused.
- `kanthord db migrate` runs inside the daemon container only, because `src/cli/options.ts:118-128` refuses a non-loopback base url.
- No phase drives a merge. The harness reports an object id and the daemon records it.
- The scenario opens no database and imports no `src/` service.

## Verify

- `node --test scripts/e2e/lib/scenario/p1b-e2.test.ts` exits 0.
- `node scripts/e2e/run.mjs P1B-E2` exits 0.
- After a passing run and after a deliberately failing run, no container, pod, network, secret or volume carrying the run id remains.
- Podman absent, stopped, or below the pinned version fails loudly and names the remedy. It does not skip.
- `npm run verify` exits 0.
- Proof: `scripts/e2e/lib/scenario/p1b-e2.test.ts`, and `node scripts/e2e/run.mjs P1B-E2`. Hermetic coverage: `020-wiring-and-scenarios.md:169`, `:170`, `:171`.
