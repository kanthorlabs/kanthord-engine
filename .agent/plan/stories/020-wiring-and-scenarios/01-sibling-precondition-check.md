# Story 1 — The sibling preconditions, verified and not re-landed

Epic: `.agent/plan/epics/020-wiring-and-scenarios.md`
Depends on: EPIC 019 (sequence order).

This story writes no production code. It confirms that the five sibling epics landed what this epic asserts. A hole found here is a defect returned to the epic that owed it, and never a fix made here.

## Change

Run each check below. Every check must pass before Story 2 starts. Record the result of each check in the discussion file.

### Check 1 — the journey oracle is repaired

EPIC 016 owns the repair of the readiness oracle. Run:

```bash
grep -rn "tasksAllPending" scripts/
```

The command must return nothing. `parseStatusCounts` in `scripts/e2e/lib/scenario/journey.ts` must export no such member, and the `status-counts` assertion must expect the ready frontier rather than `tasksAllPending: true`.

If the grep returns a hit, stop. The defect belongs to EPIC 016, story `12-journey-oracle-repaired.md`. Do not repair it here.

### Check 2 — the thirteen routed operations exist

```bash
node --input-type=module -e "
import { registry } from './src/http/contract/registry.ts';
const want = ['actor.list','actor.register','actor.revoke','actor.rotate','actor.show','node.claim','node.create','node.delete','node.heartbeat','node.release','node.report','node.unblock','node.update'];
const have = new Set(registry.filter(e => e.status === 'routed').map(e => e.operationId));
const missing = want.filter(id => !have.has(id));
console.log(missing.length === 0 ? 'ok' : 'missing: ' + missing.join(','));
"
```

The output must be `ok`. Twelve of the thirteen are new registry entries: `015-actor-identity.md:66` declares five actor rows, `actor.rotate` included, and `015-actor-identity.md:39` instructs this epic to carry twelve rather than eleven. The thirteenth is a lifecycle flip: `node.unblock` already exists as a `stubbed` entry, and `019-outcome-report.md:41` sets it `routed` for the reason `attempt-limit`. The registry row count therefore rises by twelve while thirteen operations answer a command.

### Check 3 — the eighteen CLI commands exist

```bash
node --input-type=module -e "
import { declaredCommands } from './src/cli/inventory.ts';
const want = ['actor register','actor rotate','actor list','actor show','actor revoke','node create','node update','node delete','node list','node show','node claim','node heartbeat','node release','node report','node attest','node close','node unblock'];
const have = new Set(declaredCommands.map(c => c.path.join(' ')));
const missing = want.filter(p => !have.has(p));
console.log(missing.length === 0 ? 'ok' : 'missing: ' + missing.join(' | '));
"
```

The output must be `ok`. Seventeen are checked here; `event list` is the eighteenth and Story 3 adds it. `node unblock` is EPIC 019's, beside `node report`, `node attest` and `node close`.

### Check 4 — `allowedActors` is a required field

`src/http/contract/operation.ts` must declare, after `status`:

```ts
allowedActors: readonly RegisteredActorKind[];
```

Required, never optional.

### Check 5 — the harness-set assertion has one home

**The source location is pinned, not discovered.** `015-actor-identity.md` story `07-authorization-registry.md:36` places `harnessOperations` and the harness-set assertion in `src/http/contract/registry.test.ts`, and forbids creating `src/http/contract/authorization.test.ts` before this epic. That is the authority, and `019-outcome-report.md` story `18-contract-row-handler-actor.md:115` now names the same file.

Story 2 therefore moves `harnessOperations` and its assertion **out of `src/http/contract/registry.test.ts`** and into the new `src/http/contract/authorization.test.ts`.

Confirm the pin:

```bash
grep -rn "harnessOperations" src/http/contract/
```

The only hit must be `src/http/contract/registry.test.ts`. A hit in any other file, or no hit at all, means EPIC 015 or EPIC 019 landed against a different plan: **stop and report to the human.** Do not adapt Story 2 to what the grep finds.

### Check 6 — `eventView.payload` is still `z.unknown()`

```bash
grep -n "payload" src/http/contract/event.ts
```

`019-outcome-report.md:80` and its story `14-event-payload-contract.md` keep `payload: z.unknown()` at `src/http/contract/event.ts:26`. `020-wiring-and-scenarios.md:62` states the opposite; that sentence is stale and Story 3 follows the amended EPIC 019 text.

Confirm `src/http/contract/event-payload.ts` exists and exports `eventPayloads` and `eventPayload`. Story 3 uses neither on the wire; it prints the `unknown` payload canonically.

### Check 7 — the token capture path

`015-actor-identity.md:39` states that `kanthord actor register --token-file <path>` and `kanthord actor rotate --token-file <path>` replace the `captureToken` mode this epic once planned for `scripts/e2e/podman/bin/e2e-request.mjs`.

Confirm both CLI commands accept a required `--token-file`, and confirm the CLI prints no token on stdout. Story 10 builds `registerActor` on that option and adds no capture mode.

## Constraints

- Write no production code, no test and no fixture in this story.
- Repair no hole found here. Report it to the owning epic.

## Verify

- Every check above returns its stated result.
- `npm run verify` exits 0 on the tree as inherited, with no edit from this story.
- Proof: none. This story is the precondition of every later story of this epic.
