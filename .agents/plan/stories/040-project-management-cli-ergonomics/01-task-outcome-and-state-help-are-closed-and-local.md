# Story 1 — Task outcome and state help are closed and local

Epic: `.agents/plan/epics/040-project-management-cli-ergonomics.md`
Depends on: EPIC 039 (sequence order).

## Change

### `src/cli/node/report.ts:17-71`

- Import `taskReportOutcomes` from `src/domain/outcome-report.ts` and `objectId` from `src/domain/column.ts`; do not duplicate either closed set.
- Change the `--outcome` description at `:34` to `task outcome: accepted, rejected, failed, or cancelled`.
- Change the `--object-id` description at `:36` to `40- or 64-hex object id; required for accepted`.
- Change the `--reason` description at `:37` to `required for rejected/failed; optional for cancelled`.
- Keep the `--id` check first and the positive-integer fence check second. Insert outcome/body validation after the fence check and before the body at `:55`.
- Apply these branches in order; every refusal writes the exact line, calls `input.fail()` once, records no client call and returns:
  1. absent outcome → `kanthord: invalid-request: --outcome is required\n`;
  2. outcome outside `taskReportOutcomes` → `kanthord: invalid-request: --outcome must be accepted, rejected, failed or cancelled\n`;
  3. `accepted` with no object id → `kanthord: invalid-request: --object-id is required for --outcome accepted\n`;
  4. `accepted` with an object id that fails `objectId` → `kanthord: invalid-request: --object-id must be 40 or 64 lowercase hexadecimal characters\n`;
  5. `accepted` with a reason → `kanthord: invalid-request: --reason is not valid for --outcome accepted\n`;
  6. `rejected` or `failed` with an absent or empty reason → `kanthord: invalid-request: --reason is required for --outcome <value>\n`;
  7. `rejected`, `failed` or `cancelled` with an object id → `kanthord: invalid-request: --object-id is not valid for --outcome <value>\n`.
- Build one branch-exact body after validation: accepted carries `report`, `fence`, `objectId`; rejected/failed carry `report`, `fence`, `reason`; cancelled carries `report`, `fence` and carries `reason` only when supplied.
- Do not admit `attested`, `closed`, `done` or `timed-out`; `node attest` and `node close` remain unchanged.

### `src/cli/node/list.ts:30-38`

- Import `nodeKinds`, `nodeStates` and `blockReasons` from `src/domain/state.ts` only for help text; change no query construction at `:39-58`.
- Add a module-local `renderValues(values)` that returns the only member for length 1 and, for length greater than 1, returns `values.slice(0, -1).join(", ") + ", or " + values.at(-1)`. Call it for each tuple below; hard-code no copy of a tuple.
- Render each option description from its ordered tuple:
  - `--kind`: `node kind: initiative, objective, or task`;
  - `--state`: `node state: pending, ready, running, blocked, awaiting_approval, done, partial, or discarded`;
  - `--block-reason`: `block reason: attempt-limit, dependency-discarded, stale-base, dirty-recovery, e2e-failed, or abandoned`.
- Add command help text after the options with the exact sentence `ready task = claimable; running = active node or ancestor`.
- Add no `work` alias and no local filter transformation.

### Proposal

- In `docs/proposal/api/outcome.md`, append one paragraph after the task-report bullet at `:21`. State the `node report` four-value CLI vocabulary and the accepted/rejected/failed/cancelled field rules verbatim from the EPIC Decision.
- In `docs/proposal/api/graph.md`, append one paragraph after the `node.list` filter paragraph at `:125`. State that CLI help lists the closed state vocabulary, that `ready` task means claimable and that `running` can describe an active ancestor after task recovery. State that `work` is not a state.
- Run Prettier on both proposal files; change no route row or lifecycle status.

## Constraints

- The HTTP request schema at `src/http/contract/outcome.ts:23-53` stays unchanged.
- Existing exit-code routing at `src/cli/node/report.ts:66-69` stays unchanged.
- Every valid body must satisfy `nodeReportRequest`; the CLI authors no second value spelling.
- `node list` filtering remains server-side and exact-state only.

## Verify

- Extend `src/cli/node/report.test.ts`:
  - parse `helpInformation()` and assert the four outcomes and the three conditional descriptions exactly;
  - table-drive every refusal branch above, asserting exact stderr, one `fail`, no exit-code call and zero client calls;
  - cover accepted with 40 hex, accepted with 64 hex, rejected, failed, cancelled without reason and cancelled with reason; parse each recorded body with `nodeReportRequest` and assert success;
  - assert `done`, `timed-out`, `attested` and `closed` each take the unknown-outcome refusal.
- Extend `src/cli/node/list.test.ts`:
  - assert help contains all values in tuple order and the exact clarification sentence;
  - assert help does not match `\bwork\b`;
  - keep the existing `--state ready --kind task` request assertion unchanged.
- `node --test src/cli/node/report.test.ts src/cli/node/list.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: the `src/cli/node/report.test.ts` and `src/cli/node/list.test.ts` lines of the EPIC Proof; the final sentinel is delivered collectively.
