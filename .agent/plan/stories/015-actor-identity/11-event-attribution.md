# Story 11 — Event attribution through the authenticated actor

Epic: `.agent/plan/epics/015-actor-identity.md`
Depends on: Story 1, Story 5, Story 12.

Story 12 is a **product** dependency, not test scaffolding. Hermetic coverage line 149 asserts that the same `provider.register` call through a **harness token** answers `403`, and the only way to hold a harness token is to register one through the bound `actor.register` route. Seeding an actor row directly would prove a different thing: that a fabricated row is refused, not that a registered harness is.

## Change

- `src/services/event/index.ts:3`: replace `export type ActorKind = "human" | "daemon";` with an import of the domain enum and an alias:

  ```ts
  import type { EventActorKind } from "../../domain/event.ts";

  export type ActorKind = EventActorKind;
  ```

  The service interface then declares **no second union**, and `AppendEventInput.actorKind` at `:9` accepts `harness` by construction. `src/queries/event/list-event.ts:1` imports `ActorKind` from here and needs no edit.

- **Every write handler stops taking `actor: string` from configuration and reads the resolved actor from its handler context.** The eight bindings at `src/main.ts:234`, `:239`, `:244`, `:248`, `:276`, `:288`, `:302` and `:335` are removed. For each of the eight handlers, delete the `actor: string` field from its `...HandlerDependencies` type and read `context.actor` inside the handler body instead. The eight handlers are:

  | main.ts line | handler file                                              |
  | ------------ | --------------------------------------------------------- |
  | 234          | `src/http/server/credential/register-provider.ts`         |
  | 239          | `src/http/server/credential/rename-provider.ts`           |
  | 244          | `src/http/server/credential/set-default-provider.ts`      |
  | 248          | `src/http/server/credential/remove-provider.ts`           |
  | 276          | `src/http/server/repository/register-repository.ts`       |
  | 288          | `src/http/server/project/create-project.ts`               |
  | 302          | `src/http/server/project/replace-project-repositories.ts` |
  | 335          | `src/http/server/plan/import-plan.ts`                     |

- Each of those handlers passes `actor: context.actor.id` to its command, in place of the configured string. The command signatures are unchanged: they still take `actor: string`, and they now receive an actor id rather than a configured name.
- Each of those handlers also passes the actor **kind** where the command appends an event. Where a command hard-codes `actorKind: "human"`, leave it: every one of the eight operations declares `allowedActors: ["human"]` after Story 7, so a non-human caller is refused before the handler runs. Do not thread a kind parameter through eight commands for a value the registry already fixes.
- `settings.actor` keeps exactly one job: the bootstrap row's `name`, written by `ensureBootstrapActor` of Story 6. After this story `src/main.ts` reads `settings.actor` exactly once. Do not remove the setting itself from `src/services/config/`.
- The `{ actor: "daemon" }` bindings at `src/main.ts:179`, `:184`, `:189` and `:194` are **unchanged**. The EPIC calls them "the eight `{ actor: "daemon" }` bindings at `src/main.ts:179-194`"; the range holds **four**, one per startup step. The EPIC's intent is unaffected — the eight bindings this story removes are the eight `actor: settings.actor` bindings listed above, and the daemon bindings stay whatever their count. Only the EPIC's arithmetic is wrong, not its instruction.

## Constraints

- Do not widen `allowedActors` on any of the eight operations. This epic admits no harness write.
- Do not rewrite any existing `event.actor_id` value. After this story `event.actor_id` holds an actor id for a `human` decision taken after the epic, the legacy configured name for a row written before it, and `daemon` for a daemon row. All three shapes are legal under the rebuilt `CHECK` of Story 3, which constrains `harness` rows only.
- Add no assertion that a harness-caused event names its actor. EPIC 017 owns it, because this epic admits no harness write.
- `src/services/event/index.ts` is a service interface: it may import `domain/` and other service interfaces only, and it must contain no occurrence of `implements `.

## Verify

- `src/services/event/index.test.ts` — create it if absent. Assert `AppendEventInput.actorKind` accepts `harness` **by a type-level use**: declare a `const input: AppendEventInput = { ..., actorKind: "harness", ... }` at module scope, so `npm run typecheck` fails if the widening did not land, and add one runtime assertion that `input.actorKind === "harness"` so the file is a real test. Assert by source read that `src/services/event/index.ts` contains no `"human" | "daemon"` literal union.
- For each of the eight handler test files, update the fixtures: drop the `actor` dependency and supply `actor` on the `HandlerContext` instead. Assert in at least one of them — `src/http/server/credential/register-provider.test.ts` — that the command received `actor` equal to `context.actor.id` and **not** equal to any configured string.
- Add a case to `src/main.test.ts`: **a `provider.register` call through the configured token appends an event whose `actor_id` is `bootstrapActorId` and whose `actor_kind` is `"human"`.** Drive it through `launchDaemon`, then read the `event` row from the daemon's database. Assert `actor_id` is not the configured `settings.actor` string.
- Add a case asserting **the same call through a harness token answers `403`, so no event exists to attribute**: register a harness through the configured token, call `provider.register` with the harness token, assert `403 actor-forbidden`, and assert the `event` count is unchanged from before that call.
- Assert by source read in `src/main.test.ts` that `src/main.ts` contains **zero** occurrences of `actor: settings.actor` and exactly **four** occurrences of `actor: "daemon"`.
- Run `node --test --test-timeout=60000 src/services/event/index.test.ts src/http/server/credential/*.test.ts src/http/server/repository/*.test.ts src/http/server/project/*.test.ts src/http/server/plan/*.test.ts src/main.test.ts`; each exits 0.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-015`, and Hermetic coverage lines 149 and 150.
