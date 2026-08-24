# Story 06b — Registry parity with the proposal

Epic: `.agents/plan/epics/004-transport-skeleton.md`
Depends on: Story 06a (`src/http/contract/registry.ts`), EPIC 003 Story 04 (`test/helpers/proposal.ts`).

`docs/proposal/api/` and the registry are two artifacts that must not drift. `docs/proposal/api/README.md:11` fixes what the comparison covers: "`npm run verify` asserts that the set of `operationId`, method and path in the registry equals the set declared here." Identity only — a schema is never compared, which is what lets 51 entries carry none.

Parity covers the `routed` and `stubbed` rows and those two only. The four `deferred` rows belong to `.agents/plan/epics/010-contract-completion.md:19`, and the two sources must not be swapped.

## Change

### 1. `test/helpers/proposal.ts` — add the route-matrix reader

EPIC 003 Story 04 created this file for the DDL blocks. Append:

```ts
export type ProposalRoute = Readonly<{
  operationId: string;
  method: string;
  path: string;
  introducedIn: string;
  status: string;
  source: string;
}>;

export function readRouteMatrix(): readonly ProposalRoute[];
```

`readRouteMatrix` reads every `*.md` in `docs/proposal/api/` except `README.md` and `new-decisions.md`, in bytewise filename order. For each line, keep it only when it starts with `|`, splitting on `|` yields seven parts that drop to **five** cells once the leading and trailing empties are removed, and cell 3 trimmed is a member of `introducedInValues`. Both halves of that condition are load-bearing: the five-cell count excludes any prose table whose third column happens to hold a phase value, and the `introducedInValues` membership excludes the header row and the `---` separator row.

Per kept line: trim each cell; strip a leading and trailing backtick from cells 1, 3 and 4; split cell 2 on its first space into `method` and `path`, and strip backticks from the whole cell first. Return the rows in file order, then row order.

### 2. `src/http/contract/parity.ts` (new)

```ts
import type { Operation } from "./operation.ts";

export type ParityRow = Readonly<{
  operationId: string;
  method: string;
  path: string;
  introducedIn: string;
  status: string;
}>;

export type ParityReport = Readonly<{
  missingFromRegistry: readonly string[];
  missingFromProposal: readonly string[];
  mismatched: readonly string[];
}>;

export function registryRows(
  entries: readonly Operation[],
): readonly ParityRow[];

export function compareRouteSets(
  registryRows: readonly ParityRow[],
  proposalRows: readonly ParityRow[],
): ParityReport;
```

`registryRows` maps each entry to its `operationId`, `method`, `renderPath(entry.path)`, `introducedIn` and `status`.

`compareRouteSets` takes the proposal rows **already filtered** to `status` of `routed` or `stubbed` — the filter is the caller's, because `docs/proposal/api/README.md:11` scopes parity to those two and EPIC 010 owns the `deferred` rows. It returns:

- `missingFromRegistry` — every proposal `operationId` with no registry row, sorted bytewise.
- `missingFromProposal` — every registry `operationId` with no proposal row, sorted bytewise.
- `mismatched` — for an id present in both, one string per differing field, formatted `<operationId> <field>: registry <a>, proposal <b>`, sorted bytewise.

A clean registry gives three empty arrays. `compareRouteSets` is a pure function so the failure cases are asserted from synthetic inputs, without editing a proposal file.

`node --test src/http/contract/parity.test.ts` — new file, suite `"src/http/contract/parity.test"`:

- The live assertion: `readRouteMatrix()` filtered to `status` in `["routed", "stubbed"]` has `53` rows, and `compareRouteSets(registryRows(registry), thoseRows)` deep-equals `{ missingFromRegistry: [], missingFromProposal: [], mismatched: [] }`.
- The unfiltered matrix has `57` rows, and the four rows whose `status` is `deferred` have `operationId` values deep-equal to the bytewise-sorted `["binding.e2e.project", "binding.provider.agents", "binding.provider.project", "event.stream"]`. Every one of those four also has `introducedIn === "post-mvp"`.
- Registering a `post-mvp` row fails parity: pass the real registry rows plus one synthetic `{ operationId: "event.stream", method: "GET", path: "/v1/event/stream", introducedIn: "post-mvp", status: "routed" }`, and assert `missingFromProposal` deep-equals `["event.stream"]`. The row is absent from the filtered proposal set, so registering it is a fault by construction.
- A route added to the registry and not to the proposal fails: registry rows plus `{ operationId: "zzz.invented", ... }` gives `missingFromProposal` deep-equal `["zzz.invented"]`.
- A route declared and not registered fails: proposal rows plus `{ operationId: "aaa.declared", ... }` gives `missingFromRegistry` deep-equal `["aaa.declared"]`.
- Each of the four comparable fields drifts independently. For `method`, `path`, `introducedIn` and `status` in turn, take a one-row registry set and a one-row proposal set that differ in that field alone, and assert `mismatched` deep-equals the single expected string with its exact formatting.
- `readRouteMatrix` parses rather than guesses: assert the row for `system.health` deep-equals `{ operationId: "system.health", method: "GET", path: "/v1/health", introducedIn: "phase-1", status: "routed", source: "new decision, public and unauthenticated" }`, and the row for `provider.remove` has `method === "DELETE"` and `path === "/v1/provider/:id"`.

## Constraints

- `src/http/contract/parity.ts` reads no file. It compares two arrays a caller supplies, so every failure case is a synthetic input rather than an edited proposal file.
- The proposal filter is the **caller's**. `compareRouteSets` never filters by `status`, because EPIC 010 needs the unfiltered matrix for its `404` sweep.
- `test/helpers/proposal.ts` keeps its EPIC 003 exports unchanged. This story appends `readRouteMatrix` and touches nothing else in the file.

## Verify

Every assertion listed in section 2 above, in `src/http/contract/parity.test.ts` — one suite named `"src/http/contract/parity.test"`.

`npm run verify` exits 0.

Proof: contributes `src/http/contract/parity.test.ts` to `node --test src/http/**/*.test.ts`.
