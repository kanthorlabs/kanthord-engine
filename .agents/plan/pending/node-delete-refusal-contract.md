# `node delete` — two refusals that do not satisfy their own contract

No epic owns this. It is recorded from the EPIC 052 blocker triage as blocker B12, verdict
`action:NO` for EPIC 052: EPIC 052 gives the structural patch its own aggregate refusal
`patch-delete-ineligible` over its own `structuralDeleteBindings` tuple, and it does not widen
`executionBlockers`, so no EPIC 052 story reaches `src/commands/node/delete-node.ts`.

**Promote this record to a repair before the next phase acceptance, or before the next published
contract release that carries `node.delete`, whichever comes first.** Do not attach it to whichever
epic next edits the file: this is a contract redesign, and a trivial edit must not inherit it.

**No gate catches either defect. A green `pnpm run verify` proves nothing here.** The details objects
are built in a command and parsed nowhere in production. `src/http/contract/error-details.ts` builds
the published OpenAPI document, and `src/http/server/node/report-node.test.ts:324` —
`reportErrorEnvelope` parses a real refusal response against the operation's `errors` record for
`node.report` only. There is no equivalent for `node.delete`.

## Defect 1 — `illegal-transition` details satisfy no member of their own union

`src/commands/node/delete-node.ts:98` — `NodeWriteError` throws:

```ts
throw new NodeWriteError(
  "illegal-transition",
  "a node in the subtree is not deletable",
  { nodes: offending },
);
```

`offending` is `Readonly<{ id: string; state: NodeState }>[]`.

`src/http/contract/error-details.ts:48` — `illegalTransitionDetails` is
`z.discriminatedUnion("refusal", [...])` over exactly eight members, whose `refusal` literals are
`node-state`, `ancestor-not-startable`, `drive-mode-pinned`, `run-driver`, `no-active-run`,
`children-not-terminal`, `projection-discarded` and `object-not-attested`. No member declares a
`nodes` field, and every member requires a `refusal` key. `{ nodes: [...] }` carries none, so it
satisfies no member.

The daemon returns the payload, because nothing validates it on the way out. The published contract
says the response is impossible. A runtime-validating client rejects it, and a generated client
receives a value its own type forbids. That is an interoperability defect, not inaccurate prose.

**The repair is a declared aggregate variant, not a missing key.** `deleteNode` refuses over a
recursive subtree — `src/commands/node/delete-node.ts:77` — `readSubtree` — so it refuses about many
nodes, while every current member describes one. Adding only a `refusal` literal to the existing
payload would legitimise `{ id, state }[]`, which tells a client what failed and never what would
pass. Add a ninth member instead:

```ts
  z.strictObject({
    refusal: z.literal("subtree-node-state"),
    nodes: z
      .array(
        z.strictObject({
          nodeId: nodeIdentity,
          state: z.enum(nodeStates),
          admitted: z.array(z.enum(nodeStates)).min(1),
        }),
      )
      .min(1),
  }),
```

and have the command emit `{ refusal: "subtree-node-state", nodes }` with `admitted` set from
`src/commands/node/delete-node.ts:44` — `deletableStates`. The command already sorts bytewise by id
at `:97`; keep that ordering and state it, so the response is deterministic.

An aggregate member beside eight scalar members is legitimate: a discriminated union may describe one
subject or many. The question the repair must answer in prose is whether a shared code should carry
an operation-specific variant, or whether `node.delete` deserves its own code. Preserve the existing
public code unless the compatibility policy permits changing it.

## Defect 2 — a `binding-in-use` blocker outside its domain tuple

`src/commands/node/delete-node.ts:117-119` builds its own inline type:

```ts
const waivedBlockers: Readonly<{
  nodeId: string;
  blocker: "waived-edge";
}>[] = [];
```

and `:134` — `NodeWriteError` throws `binding-in-use` with it. That value is not a
`SubtreeExecutionFact`: `src/domain/plan-graph.ts:38` — `executionBlockers` is
`["lease", "workspace", "run", "attempt", "commit", "check-result", "git-operation"]` and holds no
`waived-edge`. It type-checks over the wire only because
`src/http/contract/error-details.ts:42` — `blocker` is `z.string()`.

**Closing the schema does not require adding `waived-edge` to `executionBlockers`.** A waived edge is
a graph fact, readable from `StoredEdge.waivedAt`, which
`src/services/plan/sqlite.ts:158` already selects. EPIC 052 rules it a structural deletion binding
and keeps it out of the execution tuple. The wire schema closes over both domains:

```ts
        blocker: z.union([
          z.enum(executionBlockers),
          z.enum(structuralDeleteBindings),
        ]),
```

`structuralDeleteBindings` is EPIC 052's tuple; this repair lands after it exists.

**Audit every `binding-in-use` producer before tightening.** A closed enum turns any unlisted value
into a parse failure at the boundary, and this record has verified only the two producers in
`delete-node.ts`.

## Verification

```bash
pnpm run typecheck && pnpm run lint \
  && node --test src/http/contract/error-details.test.ts \
       src/commands/node/delete-node.test.ts \
       src/http/server/node/delete-node.test.ts \
  && pnpm run verify
```

The repair is not done until a `node.delete` test parses a real refusal response against
`buildErrorEnvelope(operation.errors)`, the way
`src/http/server/node/report-node.test.ts:324` — `reportErrorEnvelope` does for `node.report`. Three
cases carry it: several non-deletable subtree nodes, an execution blocker, and a waived-edge blocker.
Without that test the defect can return silently.
