# Story 12 — The project binding invariant

Epic: `.agent/plan/epics/017-per-node-graph-write.md`
Depends on: EPIC 016 (sequence order). Independent of every other story of this epic.

## Change

`src/commands/project/replace-project-repositories.ts:75-82` deletes every `git` binding and re-inserts the supplied set, with no plan revision. A removed binding can make a stored objective `repository-unbound`, which breaks "a stored graph is always structurally valid" and makes an unrelated prose update fail later.

### `src/commands/project/replace-project-repositories.ts`

- Add `plan: PlanStore` to `ReplaceProjectRepositoriesDependencies`.
- Add `"binding-in-use"` to `ReplaceProjectRepositoriesRefusal`.
- Insert one check between the per-repository existence loop and the `DELETE FROM project_binding` statement at `:75`:

  1. `const { nodes } = dependencies.plan.readGraph(transaction, input.id)`.
  2. `const kept = new Set(input.repositories)`.
  3. `const blockers = nodes.filter((node) => node.repositoryId !== null && !kept.has(node.repositoryId)).map((node) => ({ nodeId: node.id, blocker: "repository-bound" }))`, sorted by `nodeId` bytewise through `Buffer.compare`.
  4. When `blockers.length > 0`, throw `new ReplaceProjectRepositoriesError("binding-in-use", "a stored objective names a repository the new set drops", { blockers })`.

- `ReplaceProjectRepositoriesError` carries no `details` field today. Add `readonly details: unknown` and a third constructor parameter, in the shape of `ImportPlanError` at `src/commands/plan/import-plan.ts:76`.

`readGraph` returns nodes for the project only, so an objective in another project never blocks.

### The handler refusal mapping

The handler that serves `project.repositories` maps the new refusal to `httpError("binding-in-use", error.message, { blockers })`, following the pattern of `src/http/server/plan/refusals.ts:5-40`. `binding-in-use` already carries `409` at `src/http/contract/errors.ts:15`.

### `src/http/contract/project.ts`

The `project.repositories` operation gains `"binding-in-use"` in its `errors` map, with the details schema Story 13 declares for the blocker list.

### `src/main.ts`

Pass `plan` into the `replaceProjectRepositories` binding.

## Constraints

- The check runs before the first write of the command, so a refusal leaves `project_binding` byte-identical.
- A drop of a repository no node names still succeeds. Do not widen the refusal to every removal.
- Only a `git` binding is touched. Do not read or write another `kind`.
- Do not change the `duplicate-repository`, `repository-not-found`, `too-many-repositories` or `project-not-found` refusals.
- `README.md:178` already widens to carry this refusal. Story 1 owns that edit.

## Verify

Extend `src/commands/project/replace-project-repositories.test.ts`.

- `refuses a drop of a repository a stored objective names` — assert `ReplaceProjectRepositoriesError` with refusal `binding-in-use`, that `details.blockers` deep-equals `[{ nodeId, blocker: "repository-bound" }]`, and that the `project_binding` rows are byte-identical before and after.
- `lists every blocked objective, sorted bytewise` — two objectives naming the dropped repository yield two entries in bytewise `nodeId` order.
- `allows a drop of a repository no node names` — assert success and the new binding set.
- `allows a replacement that keeps every named repository` — reorder the same set and assert success.
- `an objective in another project never blocks` — seed a second project whose objective names the dropped repository and assert the first project's replacement succeeds.
- `refuses before it writes` — assert the `project_binding` row count and every row are unchanged on the refusal path.
- Extend the `project.repositories` handler test: the refusal answers `409` with the code `binding-in-use` and `details.blockers`.
- `node --test src/commands/project/replace-project-repositories.test.ts src/http/server/project/replace-project-repositories.test.ts src/http/contract/project.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-017`, through `src/commands/project/replace-project-repositories.test.ts` and `src/http/contract/*.test.ts`. Hermetic coverage bullet `.agent/plan/epics/017-per-node-graph-write.md:167`.
