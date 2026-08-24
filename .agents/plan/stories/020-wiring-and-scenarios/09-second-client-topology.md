# Story 9 — The second client, as the infrastructure it is

Epic: `.agents/plan/epics/020-wiring-and-scenarios.md`
Depends on: Story 1.

Nine named places assume one client, and each one is work.

## Change

### `scripts/e2e/lib/podman/topology.ts`

1. `Topology` at `:4-17` gains `secondClientContainer: string`. Declare it immediately after `clientContainer`, so the twelve-field pin becomes thirteen.
2. `planTopology` at `:27-42` names it:

   ```ts
   secondClientContainer: `kanthord-e2e-client2-${runId}`,
   ```

   The function stays pure and derives every name from `runId` alone.

3. `createTopology` gains a fourth `podman run`, appended immediately after the existing client run at `:200-215`. Same image `images.product`, same `--network topology.network`, same `--label label`, same `--pull=never`, the same `...secretArguments`, and the same `sleep infinity`. Only `--name` differs. It joins the network, never the pod.
4. Take the new container into the ledger immediately after its run, in the same `context.take({ kind: "container", ... })` shape, releasing with `podman rm -f`.

The second client mounts **no daemon volume**, exactly as the first client does not.

### `scripts/e2e/lib/podman/topology.test.ts`

- The twelve-field pin at `:36-53` becomes thirteen. Add `secondClientContainer: "kanthord-e2e-client2-R1"` in the field position `Topology` declares.
- The eight-command pin at `:55-183` becomes nine. `assert.equal(argvCalls.length, 8)` becomes `9`, and a new `assert.deepEqual(argvCalls[8], [...])` pins the second client run verbatim, in the same form as `argvCalls[7]`.
- The resource-ledger sequence pin at `:368-392` gains one entry in exact position, at the tail:

  ```ts
  { kind: "container", id: topology.secondClientContainer },
  ```

- The three-run failure pin at `:394-415` is unchanged: the failure is on command 4, which precedes the new run.
- Add one case: `it("the second client container carries no daemon volume mount", ...)`, asserting the recorded argv of `argvCalls[8]` holds no `--volume` and no `-v`.

### `scripts/e2e/lib/disclosure.ts`

`assertNoDisclosure` at `:46` takes the whole `Topology` already. Add `topology.secondClientContainer` to the `podman inspect` argv at `:117-124`, immediately after `topology.clientContainer`. The surface list and the eight assertion names are unchanged, because one `podman inspect` call covers both clients.

### `scripts/e2e/lib/disclosure.test.ts`

Update the `cleanFixtures` output table so the widened `podman inspect` argv resolves. Add one case: a leak present only in the second client's inspect output rejects naming `no-disclosure-podman-inspect`. Keep the existing eight-name happy-path case at `:207` unchanged in its expected names.

### `scripts/e2e/lib/driver/index.ts`

`HostRole` at `:7` gains a third member:

```ts
export type HostRole = "daemon" | "client" | "client2";
```

### `scripts/e2e/lib/driver/podman.ts`

`containerFor` at `:102-106` becomes a total three-way map rather than a binary ternary:

```text
daemon  -> topology.daemonContainer
client  -> topology.clientContainer
client2 -> topology.secondClientContainer
```

`startDaemon` at `:249-250` delivers the configured token to the daemon and to **both** clients — a third `deliverToken` call, in that order. `collectLogs` at `:324-339` collects both clients and returns three keys, `daemon`, `client` and `client2`.

### `scripts/e2e/lib/driver/ssh.ts` and `local.ts`

Both ignore the role or map it binarily today. `ssh.ts` `targetFor` at `:59-61` maps `client2` to the same client target, because phase 3 owns a second SSH host and this epic adds none. `local.ts` continues to ignore the role. Neither driver gains a container.

### Every topology fixture

`scripts/e2e/lib/driver/interface.test.ts:79-112` and every other inline `topology` literal in the driver and podman tests construct the widened record. Search for the twelve-field literal and add the field to each.

## Constraints

- **Add one container and nothing else.** No second pod, no second network, no second volume, no second daemon.
- The second client carries the same two secret mounts as the first, at mode `0600`.
- Change no existing container name, no port and no alias.
- `P1B-E2` must leave no container, no pod, no network, no secret and no volume carrying its run id, after a failing run as well as a passing one. The ledger entry is what guarantees it.

## Verify

- `node --test scripts/e2e/lib/podman/topology.test.ts scripts/e2e/lib/disclosure.test.ts scripts/e2e/lib/driver/interface.test.ts` exits 0.
- `planTopology` names six containers-and-networks resources with the run id, the second client container included, and `createTopology` takes each into the ledger in the pinned order.
- `npm run verify` exits 0.
- Proof: `scripts/e2e/lib/podman/topology.test.ts`, `scripts/e2e/lib/disclosure.test.ts`, `scripts/e2e/lib/driver/interface.test.ts`. Hermetic coverage: `020-wiring-and-scenarios.md:164`, `:165`, `:166`.
