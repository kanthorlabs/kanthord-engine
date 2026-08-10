# EPIC 115 — Phase-2 end-to-end scenarios

Status: **ready**.

## Goal

P2-E1, P2-E2, P2-E3 and P2-E4 run through `scripts/e2e/run.mjs` and write evidence bundles. This epic
extends the runner of `.agent/plan/epics/011-end-to-end-scenarios.md` and never forks it: the tag, the
central cleanup, the two axes, the secret registry and the bundle writer stay one implementation.
`scripts/e2e/lib/scenario/p2-e1.ts`, `p2-e2.ts`, `p2-e3.ts` and `p2-e4.ts` declare the four scenarios,
`scripts/e2e/lib/scenario/p2-journey.ts` holds the setup every one of them shares, and
`scripts/e2e/lib/tag.ts` gains the four ids. `live` joins the mode vocabulary of
`scripts/e2e/lib/bundle.ts` and `scripts/e2e/lib/scenario/index.ts`. The bundle grows to schema
version `2` and carries the object id chain, the approval evidence document, the attempt record, the
ancestry classification per step, and for P2-E4 the provider, the model, the usage, the prompt hashes
and the run and attempt ids. Every bundle redacts every credential. The fake agent and the fake
reviewer arrive as a loopback model endpoint the harness owns, reached through the `baseUrl` of an
ordinary `llm` registration that `kanthord credential register` writes, so the daemon reads no test
flag and holds no test branch. That endpoint carries every provider call of every phase-2 scenario,
so it is also the one component that counts the calls and refuses the call over the live bound.

## Non-goals

- No product capability. EPIC 101 to EPIC 114 own every route, every CLI command and every record
  these scenarios drive. A scenario that fails because a capability is absent is a defect of that
  epic, and this epic adds no production code under `src/`.
- No oracle of its own, and no fifth scenario. `docs/proposal/phase-2/README.md` declares the four
  ids, their modes, their oracles, their evidence and the bounds of P2-E4. This epic implements them
  and restates none.
- No acceptance run and no verdict. EPIC 116 invokes the four ids in order, records the product
  acceptance a machine cannot check, and writes the one verdict that closes the phase.
- No VPN and no second host. `docs/proposal/phase-2/README.md` gives a real run driven from a second
  machine to P3-E7. No phase-2 scenario takes the `podman` driver or the `ssh` driver.
- No `integration` mode. Phase 1 already proves the real forge through P1-E5, and
  `docs/proposal/phase-2/README.md` declares three `deterministic` scenarios and one `live` scenario.
- No failpoint. `docs/proposal/README.md` gives a named durable boundary to phase 3, and no phase-2
  oracle needs one.
- No new production configuration key. Every value a scenario needs already reaches the daemon through
  `src/services/config/convict.ts`: `tools`, `attemptLimit` and the `agent` group of EPIC 106.

## Stories

- **The four ids join the runner, and `live` joins the mode vocabulary** — `ScenarioId` in
  `scripts/e2e/lib/tag.ts` gains `"P2-E1" | "P2-E2" | "P2-E3" | "P2-E4"`. That file also gains
  `scenarioPhases`, the frozen tuple `[1, 2]`, and `scenarioIdsByPhase`, a frozen record whose key `1`
  holds `["P1-E1", "P1-E2", "P1-E4", "P1-E5"]` and whose key `2` holds
  `["P2-E1", "P2-E2", "P2-E3", "P2-E4"]`, each in declaration order, plus `knownScenarioIds`, the
  flattened table in phase order. `knownScenarioIds` is a private copy in three files today,
  `scripts/e2e/lib/main.ts` line 44, `scripts/e2e/lib/record/verdict.ts` line 20 and
  `scripts/e2e/lib/record/acceptance.ts` line 63, so all three delete their copy and import the one in
  `tag.ts`, and no fourth copy appears. `ScenarioDeclaration` in
  `scripts/e2e/lib/scenario/index.ts` gains `phase: 1 | 2`, so the phase of a scenario is declared once
  beside its mode, driver and profile. `tag.ts` derives nothing from `scenarios`, because
  `scenario/index.ts` imports `tag.ts` for `ScenarioId` and a derivation would close that cycle;
  instead `scripts/e2e/lib/scenario/index.test.ts` asserts exact equality across all three
  inventories: for each phase of `scenarioPhases`, the ids of `scenarios` filtered by `phase` in
  declaration order deep-equal `scenarioIdsByPhase[phase]`, and the ids of `scenarios` in declaration
  order deep-equal `knownScenarioIds`. A `ScenarioId` that no `scenarios` row declares therefore fails
  a test. `verdict` takes one more input, `phase: 1 | 2`, and it requires one bundle per id of that
  phase only, because a phase-2 verdict must not demand a phase-1 bundle. `recordAcceptance` takes the
  same input and requires at least one bundle of that phase, for the same reason. `parseArguments`
  accepts `--phase <1|2>` beside `--verdict` and beside `--record-acceptance`, refuses it anywhere
  else, and defaults to `1`, so every phase-1 invocation keeps its meaning. EPIC 116 runs
  `--verdict <tag> --phase 2` and `--verdict <tag> --phase 2 --scenarios-only`, and this story owns
  both the option and the phase-scoped id set they read. `Bundle["mode"]` in
  `scripts/e2e/lib/bundle.ts` and `ScenarioDeclaration["mode"]` in
  `scripts/e2e/lib/scenario/index.ts` each gain `"live"`. The `scenarios` array gains the four
  declarations: P2-E1, P2-E2 and P2-E3 are `phase: 2`, `mode: "deterministic"`, `driver: "local"`,
  `profile: "fixture"`, and P2-E4 is `phase: 2`, `mode: "live"`, `driver: "local"`,
  `profile: "real"`. The four existing rows gain `phase: 1`.
- **The bundle carries what phase 2 adds** — `bundleSchemaVersion` becomes `2`, and `Bundle` gains
  three fields, each serialized in `serializeBundle` after `objectIds` and before `assertions`.
  `steps` is `readonly StepRecord[]`, where `StepRecord` is
  `Readonly<{ name: StepName; relation: AncestryRelation | null; landingOid: string | null; upstreamOid: string | null }>`.
  `StepName` is the frozen tuple `stepNames` of `scripts/e2e/lib/scenario/p2-e3.ts`, and
  `AncestryRelation` is the four values of `ancestryRelations` of EPIC 108,
  `"synchronized" | "upstream-advanced" | "local-ahead" | "diverged"`, so the ancestry classification of
  every step of P2-E3 is one row each in run order. **`relation` is nullable, because one step
  classifies nothing:** a publish refused on a stale `landingOid` answers `publishStaleDetails` of
  EPIC 113 with `refusal` of `stale-oid`, which carries no relation, so a recorded relation there would
  be invented. `documents` is `readonly DocumentRecord[]`, where `DocumentRecord` is
  `Readonly<{ name: string; sha256: string; bytes: number }>`, ordered by `name`
  with `Buffer.compare`. `live` is `LiveRecord | null`, where `LiveRecord` is
  `Readonly<{ provider: string; model: string; runId: string; attemptIds: readonly string[]; usage: Readonly<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number }>; promptHashes: readonly string[]; bounds: LiveBounds; boundExceeded: BoundName | null; oracle: "passed" | "failed" | "not-run" }>`,
  and it is null on every `deterministic` bundle. **Every member answers a named source, in one
  clause each.** `provider`, `model` and `usage` are the provider, the model and the usage of the
  P2-E4 evidence line of `docs/proposal/phase-2/README.md`; `promptHashes` is the prompt hashes of
  that line; `runId` and `attemptIds` are the run and attempt ids of that line; `oracle` is the
  hidden test verdict of that line, and its output is the attached document; `bounds` is the "limits
  for a live run" of `docs/proposal/README.md`; `boundExceeded` names which of those limits stopped
  the run, which is what makes "a failure is evidence about that run" readable.
  `BoundName` is the frozen tuple `boundNames`,
  `["attempt-limit", "provider-calls", "wall-clock"]`, so no free-form string enters a bundle, and a
  run that hit no bound records `null`. **There is no `modelCalls` field**, because `promptHashes`
  holds exactly one hash per invocation in invocation order, so its length is the call count and a
  second field could disagree with it. `BundleWriter` gains `noteStep(record)`,
  `attachDocument(name, text)` and `noteLive(record)`. **A document is a file, and the bundle holds
  its index.** `attachDocument` writes `documents/<name>.json` beside `logs/`, through `redact` and
  the existing `writeBundle` path, and it records the name, the `sha256` of the redacted bytes and
  their length. The approval evidence document of P2-E1 and the attempt record of P2-E2 are large and
  variable, so a bundle that inlined them would be an unreadable index; a bundle that names a file and
  its digest stays a fixed-size index and loses no evidence. `objectIds` already holds the object id
  chain, and it already orders its keys bytewise, so no new field carries an object id.
- **The phase-2 fixture bare repository** — `test/helpers/remote/seed.ts` seeds a second bare
  repository, `phase2.git`, beside `fixture.git`, through the same `gitRun` under
  `pinnedGitEnvironment` and `pinnedGitConfigArguments`, so every object id is a constant. **The
  second repository is not a convenience.** `fixture.git` holds one path, `README.md`, and its
  `commit1`, `commit2` and `tagV1` are pinned in `fixtureObjectIds` and asserted by the phase-1
  scenarios and by `test/helpers/remote/seed.test.ts`; reseeding it to carry a runnable check would
  change all three ids and break every phase-1 pin. A second repository adds ids and changes none.
  Its initial commit holds exactly four paths: `README.md`, `package.json` whose `scripts.test` is
  `node --test test/`, `src/sum.mjs` exporting one function `sum`, and `test/sum.test.mjs` asserting
  `sum(2, 2) === 4` on `node:test` and `node:assert/strict`. **The repository satisfies the template
  check unchanged.** The `nodejs` template of EPIC 103 declares `checks.unit.run` of `["npm", "test"]`
  and `timeout` of `10m`, so `npm test` runs `scripts.test`, which needs no `node_modules` and reaches
  no network, and no scenario overrides a template check. `refs/heads/main` names that commit, `HEAD`
  is a symref to it, and
  `http.receivepack` and `http.uploadpack` are both true, exactly as `fixture.git` already sets them.
  `fixtureObjectIds` gains one key per new object, named `phase2Blob*`, `phase2Tree*` and
  `phase2Commit1`, and `test/helpers/remote/seed.test.ts` asserts each pinned value, so a seed change
  fails a test rather than a scenario. `HttpRemote.seed` already exposes `SeedRoot.git`, so the harness
  writes to that bare repository directly with the `git` binary, which is the mechanism
  `docs/proposal/README.md` names for moving the fixture remote.
- **The phase-2 fixture plan** — `test/e2e/fixtures/phase-2/plan/` holds one initiative, one objective
  and two tasks, because `docs/proposal/phase-2/README.md` states the exit criterion as one objective
  with two tasks. The layout copies `test/e2e/fixtures/two-objective/plan/`:
  `plan/journey/initiative.md`, `plan/journey/alpha/objective.md`, `plan/journey/alpha/01-first.md` and
  `plan/journey/alpha/02-second.md`. Task `01-first` asks for a `product` function in `src/product.mjs`
  and names one acceptance criterion. Task `02-second` asks for a test of that function in
  `test/product.test.mjs` and names one acceptance criterion, and it depends on `01-first`, so the
  topological walk is fixed. `test/e2e/fixtures/phase-2-blocked/plan/` holds one objective with **two**
  tasks for P2-E2, in the same layout, named `01-accepted` and `02-rejected`, where `02-rejected`
  depends on `01-accepted`. **Two tasks, because the P2-E2 oracle asserts that the earlier task
  commits survive an abandon**, and a one-task objective makes that assertion vacuous: there is no
  earlier commit to survive. `01-accepted` asks for a `quotient` function in `src/quotient.mjs` and
  names one acceptance criterion, which the scripted reviewer accepts on the first attempt.
  `02-rejected` asks for a `remainder` function in `src/remainder.mjs` and names one acceptance
  criterion, which the scripted reviewer rejects on every attempt. Both directories are hashed into
  `fixtureHashes` by the existing `hashFixtures`.
- **The scripted model is a loopback provider endpoint, never a daemon branch** — a production code
  path that reads a test flag is a defect, so the substitution happens where the product already takes
  an address from configuration. `src/domain/provider-payload.ts` gives an `llm` payload a nullable
  `baseUrl`, and EPIC 102 makes a non-null `baseUrl` the base url of the request model. The harness
  therefore starts one `node:http` server on a loopback port and registers an ordinary `llm`
  credential naming it, through `kanthord credential register`, which already declares
  `--base-url <url>` at line 59 of `src/cli/credential/register.ts` and already reaches
  `llmPayload.baseUrl` at line 157. No epic adds a flag for this, and `kanthord onboard` of EPIC 114
  gains none: its `--base-url` is the program client option `registerClientOptions` declares, and it
  points the CLI at the daemon. `scripts/e2e/model-stub/main.ts` holds that server, beside
  `scripts/e2e/fixture-remote/main.ts`, and it speaks the `openai-completions` wire protocol, which is
  the `api` of the `groq` provider of `@earendil-works/pi-ai`. The registration is pinned:
  `--name model`, `--kind llm`, `--provider groq`, `--model llama-3.1-8b-instant`,
  `--base-url http://127.0.0.1:<port>/script`, and an `--api-key-file` holding `fixture-llm-key`.
  `openAICompletionsApi` passes `baseUrl` to the OpenAI client as `baseURL`, so the request path is
  `POST /script/chat/completions` and the stub serves exactly that path and refuses every other with
  `404`. That provider is chosen because its api is plain
  chat completions rather than a responses api, and because `llama-3.1-8b-instant` declares
  `reasoning: false`, so the stub scripts no thinking channel. **The daemon sees an ordinary
  registration.** It reads no environment variable of the harness, and `createPiAiModels` of EPIC 102
  already denies an ambient credential, so no operator key can reach the run. The parallel is exact:
  the fixture git remote is a loopback origin the product treats as ordinary, and this is a loopback
  provider the product treats as ordinary. `scripts/e2e/lib/model-stub/index.ts` holds the harness
  half: `startModelStub({ script, forwardTo, maxCalls, reviewerProseMarker })` returns
  `{ origin, port, calls(), dispose() }`, and the scenario takes
  it through `context.take` with `kind: "process"`, so the central cleanup of EPIC 011 releases it on
  the failure path as well as the success path. **One server, two mount points, one counter.** A null
  `forwardTo` serves `/script` from the script, and a non-null `forwardTo` serves `/upstream/<rest>` by
  forwarding the method, the `authorization` header, the `content-type` header and the body to
  `<forwardTo>/<rest>` and streaming the answer back unchanged, which is what P2-E4 registers. The
  counter increments **before** the answer and before any forward, and a call whose count exceeds
  `maxCalls` answers `429` with the body `{"error":{"type":"kanthord_e2e_bound","message":"provider-calls"}}`
  and forwards nothing, so the call after the maximum never reaches a provider. `maxCalls` is
  `Number.MAX_SAFE_INTEGER` for a `deterministic` run and `liveBounds.maxProviderCalls` for P2-E4.
- **The scripted agent and the scripted reviewer are scripts of that endpoint** —
  `scripts/e2e/lib/model-stub/script.ts` exports `ModelScript`, which is
  `Readonly<{ implementer: readonly ModelTurn[]; reviewer: readonly ModelTurn[] }>`, and `ModelTurn`
  is `Readonly<{ toolCalls: readonly Readonly<{ name: string; argumentsJson: string }>[]; text: string; usage: Readonly<{ promptTokens: number; completionTokens: number }> }>`.
  **The stub selects a script by role, and the role comes from the prompt bytes.** The scenario passes
  the pinned literal `Never propose an implementation.` into `startModelStub` as
  `reviewerProseMarker`. That sentence is the last sentence of the `re@1` role-contract prose of
  `roleContracts` in `src/domain/instruction-contract.ts`, and EPIC 104 renders that prose into the
  `## role-contract` block of every `re@1` prompt, so the sentence reaches the stub inside the first
  user message. The stub answers the reviewer script when that message holds that string, and the
  implementer script otherwise. **The selector never reads the `roleContract` id.** EPIC 104 uses that
  id as a provenance label alone, so it never appears in the prompt bytes and a selector on it would
  match no request. The literal is written in the harness and imported from nowhere, so
  `scripts/e2e/lib/scenario/discipline.test.ts` stays true and no harness file imports `src/`. A drift
  in that prose fails the scenario loudly rather than silently: the implementer script then answers a
  `re@1` request, its turn emits one `write` tool call, and the run ends with
  `AgentError("reviewer-wrote")`. Each role holds its own call counter, and
  turn `n` answers call `n`; the last turn repeats when the calls outnumber the turns, so a script
  never runs out. **The implementer writes through the real tools.** Its turn emits one `write` tool
  call whose arguments name the path and the exact content, which drives the real `write` tool of
  EPIC 106 inside the objective workspace, and the diff of that attempt is therefore a real git diff.
  **The reviewer emits text only.** Its turn emits no tool call and one text body of one verdict line
  per criterion, in the grammar `parseReview` of EPIC 106 fixes: `accept — <reason>` accepts, and
  `reject: <reason>` rejects. A reviewer turn that emitted a tool call would raise
  `AgentError("reviewer-wrote")`, so the script proves the read-only allow list rather than working
  around it. Every response reports `usage` from the turn, so the recorded token counts are values the
  script wrote and no assertion reads a number the stub invented. **A per-role counter is what lets one
  script accept one task and reject the next.** The topological walk of the P2-E2 fixture is fixed,
  because `02-rejected` depends on `01-accepted`, and `attemptLimit` is `3`, so the reviewer call order
  is exactly task `01-accepted` attempt one, then task `02-rejected` attempts one, two and three. The
  P2-E2 reviewer script therefore holds four turns: turn one accepts, and turns two, three and four
  reject. The implementer script holds four turns in the same order: turn one writes
  `src/quotient.mjs`, and turns two, three and four write `src/remainder.mjs`. No new selection
  mechanism appears, and no script reads a task id.
- **The phase-2 fixture acceptance rows are proved before the journey** —
  `docs/proposal/README.md` requires each phase to prove its fixture subset before its scenarios run,
  and it gives phase 2 one more row than phase 1: accept a non-force push, and reject a
  non-fast-forward. `OriginProbeInput` gains `phase: 1 | 2`, and `originProbeRowNames` gains
  `fixture-accepts-non-force-push` and `fixture-rejects-non-fast-forward`, which
  `originProbeScripts` appends only when `phase` is `2`. The accept row pushes one commit to
  `refs/heads/kanthord-e2e-probe` with the right credential and asserts exit zero. The reject row then
  pushes an unrelated commit to that same ref with no force and asserts a non-zero exit. **The probe
  never touches `refs/heads/main`**, and it removes `refs/heads/kanthord-e2e-probe` afterwards by
  writing to the bare repository directly through `SeedRoot.git`, so the origin the journey reads is
  the seeded origin. A failed row raises `RunnerError("unavailable")`, exactly as
  `createFixtureProfile` already does, so a scenario never proves less than it claims against a broken
  fixture. The bundle records five rows for a phase-2 run.
- **One phase-2 journey, shared by the three deterministic scenarios** —
  `scripts/e2e/lib/scenario/p2-journey.ts` exports `runPhase2Journey(context, driver, profile, input)`.
  It reuses `driver.startDaemonExpectingRefusal`, `driver.startDaemon`, `driver.cli` and
  `driver.issue` of `scripts/e2e/lib/driver/index.ts` unchanged, so the phase-2 journey adds no driver
  method. `DaemonConfig` gains one member, `agent: Readonly<{ timeoutMs: number; path: string }>`,
  which every driver writes into the config file, because EPIC 106 adds those two settings. A
  `deterministic` run sets `timeoutMs` of `60_000`, because the stub answers at once, and `path` of
  `resolveAgentPath()`, which `scripts/e2e/lib/scenario/tools.ts` gains beside `resolveTools`: it
  returns the directory of `node` and the directory of `npm`, resolved by the existing
  `resolveOnPath`, joined by `delimiter`. Those two binaries are what the `nodejs` template check
  needs, and it needs nothing else. `attemptLimit` stays `3`, the default
  of `src/services/config/convict.ts` and the limit the P2-E2 oracle names. **The journey drives two
  commands, and invents no flag.** First `kanthord credential register`, with `--name model`,
  `--kind llm`, `--provider groq`, `--model llama-3.1-8b-instant`, `--base-url <the stub origin>/script`
  and `--api-key-file <the delivered key>`, because that command is the one that owns the provider base
  url. It asserts one line matching `/^kanthord: registered model provider_[0-9A-HJKMNP-TV-Z]{26}$/`,
  the line `src/cli/credential/register.ts` prints at line 172, and it keeps that provider id. Then
  `kanthord onboard`, with `--git-credential fixture`,
  `--git-transport http-basic`, `--git-token-file <the delivered token>`, `--repository phase2`,
  `--url <the fixture origin>`, `--upstream main`, `--project journey`,
  `--provider-credential model` and `--template nodejs`. Onboard therefore finds the named `llm` row
  in its `provider.list` read, skips the `llm-credential` step and stamps it as the default, which is
  the skip rule of EPIC 114, and it needs no `--provider`, no `--model` and no `--api-key-file`. **No
  check override reaches the command line.** EPIC 114 declares no `--unit-run` and no
  `--unit-timeout`, and its Non-goals give the `checks` field set to EPIC 103; the seeded repository
  satisfies the template command `["npm", "test"]` instead. It asserts the final line
  `kanthord: onboarded journey phase2`, which is the
  one line EPIC 114 prints last and only after the profile step. It then imports the plan with
  `kanthord plan import`, asserts the objective and task counts of the profile, and returns the
  credential, repository, project, objective and task ids it read from the printed lines.
- **Waiting is polled, never slept** — `run.start` returns before the worker loop finishes, so
  `scripts/e2e/lib/scenario/p2-wait.ts` exports `awaitRunEnded(context, driver, input)`. It polls
  `run.show` at a fixed interval to a fixed deadline and returns the run view when `state` is `ended`.
  A `deterministic` run polls every `500` ms to `180_000` ms; a `live` run polls every `5_000` ms to
  the wall-clock bound of the live story. A deadline reached with the run still `active` collects the
  daemon logs, attaches them to the bundle and raises `RunnerError("assertion-failed")` naming the
  run. The rule is the readiness rule of EPIC 011: a bounded poll with diagnostics on timeout, never a
  sleep. **The poll counts nothing and enforces nothing about provider calls.** A poll observes a count
  that the run has already passed, so a call bound checked here always allows the calls between two
  polls; the loopback endpoint of the story above refuses the over-bound call instead. `awaitRunEnded`
  cancels through `run.cancel` for one reason only, the wall-clock deadline of a `live` run.
- **P2-E1 — an objective from import to remote origin** — mode `deterministic`, driver `local`,
  profile `fixture`, and `Human action: none`, so the runner calls the approval route itself. The
  script accepts each task on its first attempt. The scenario runs the journey, then
  `kanthord run --project <id>`, then `awaitRunEnded`. It asserts the four conditions
  `docs/proposal/phase-2/README.md` states, each through the CLI or HTTP and never through SQLite. Two
  task commits exist on the objective workspace, each attributed to a run and an attempt, read from
  `kanthord node attempts --node <taskId>` for each task and from the `baseOid` and `headOid` of each
  task run of `run.list`. The unit check result is recorded against the frozen candidate object id, and
  the approval evidence names that same object id, read from `kanthord node approval --id
<objectiveId>`, whose `kanthord: candidate-oid` line and `kanthord: check` lines carry both. The
  landing branch moved from the recorded base to the recorded head, read from `repository show` before
  and after `kanthord node approve --id <objectiveId> --candidate-revision <revision> --yes`. The
  fixture remote contains the landed commit, read with `runRemoteRefs` of
  `scripts/e2e/lib/remote-refs.ts`, and the `publish` journal row is complete, read from the
  `kanthord: git-operation` line of the approve output through `repository publish` chaining of
  EPIC 113. The evidence is the object id chain from task commit to remote ref, written into
  `objectIds` under the keys `task1Commit`, `task2Commit`, `candidateOid`, `landingBaseOid`,
  `landingHeadOid` and `remoteHeadOid`, plus `documents/approval-evidence.json` holding the parsed
  answer of `node.approvalEvidence`.
- **P2-E2 — a task that cannot pass parks, and stays diagnosable** — mode `deterministic`, driver
  `local`, profile `fixture`, `Human action: none`. It uses the two-task fixture plan, whose reviewer
  script accepts `01-accepted` once and rejects `02-rejected` on every attempt. It asserts
  `01-accepted` reaches `done` after exactly one attempt, and it **pins that task's commit object id**
  into `objectIds` under `abandonSurvivorOid`, read as the `headOid` of its task run of `run.list`
  before the abandon runs. It asserts `02-rejected` reaches `blocked` with reason
  `attempt-limit` after exactly three attempts, read from `kanthord status` and from
  `kanthord node attempts --node <taskId>`, whose `kanthord: attempt` line count is exactly `3`. It
  asserts each of the three entries holds the rendered prompt with per-block provenance, the tool
  trace, the verification output and the reviewer reason per criterion, and **every assertion names an
  exact value, because a scripted endpoint fixes the content**: the `sha256:` hash of each invocation
  line resolves through `kanthord blob show --hash <hash>`, and the sha256 of each fetched payload
  equals the hash the line named, so the resolution is content-addressed and not a length check. The
  `general@1` prompt payload of attempt one is byte-identical to
  `test/e2e/fixtures/phase-2-blocked/expected/attempt-1-general.prompt.md`, compared with
  `Buffer.compare`, and the `re@1` prompt payload of attempt one is byte-identical to
  `attempt-1-re.prompt.md` beside it; every source of both prompts is a fixture this epic or EPIC 103
  and EPIC 104 pin, so the bytes are constants. Its provenance channel list is exact and not "one label
  per channel": the `general@1` attempt-one provenance channels are
  `["daemon-invariants", "role-contract", "repository-profile", "task-contract"]`, with the labels
  `convention:coding/v1`, `code:role-contract/general@1`, `profile:<the profile content blob>` and
  `node:<taskId>@<revision>`; attempts two and three append `runtime-evidence` with
  `attempt:<the previous attemptId>`; and every `re@1` provenance list is
  `["daemon-invariants", "role-contract", "task-contract", "runtime-evidence"]`. `project-policy`
  renders no block because EPIC 104 contributes nothing to it, `ambient-context` renders none because
  the seeded tree holds no discovered ambient name and `ambient.hostFiles` defaults `false`, and
  `runtime-evidence` is empty on attempt one, which EPIC 110 states. The tool trace is asserted as
  exact parsed records: the trace of each attempt holds exactly one record, whose tool name is `write`,
  whose path is `src/remainder.mjs` and whose outcome is not an error, which are the values the script
  wrote. The verification output is asserted as exact parsed fields, never as its own oracle: the
  recorded command deep-equals `["npm", "test"]`, the recorded exit status is `0`, and the captured
  output holds the exact line `# fail 0`, which `node:test` writes and kanthord does not. The reviewer
  reason list holds exactly one entry per criterion of the task, in criterion order, each with verdict
  `reject` and the exact reason string of the script turn. It then runs
  `kanthord node abandon --node <taskId>` for `02-rejected` and asserts the printed line
  `kanthord: node <taskId> blocked abandoned`, and that the accepted task's commit survives: the same
  `run.list` read after the abandon reports the identical `abandonSurvivorOid`, and the pinned `git`
  binary run against the objective workspace inside the temporary home the driver owns answers
  `cat-file -e <that oid>^{commit}` with exit zero, so the object is still reachable and not only still
  named. The evidence is the attempt record, written into
  `documents/attempt-record.json` with every blob resolved inline, and every credential redacted.
- **P2-E3 — freshness, divergence and publish safety** — mode `deterministic`, driver `local`, profile
  `fixture`, `Human action: none`. **The fixture remote advances by a direct write to the bare
  repository.** The scenario calls `SeedRoot.git("phase2.git", ["commit-tree", …])` and then
  `SeedRoot.git("phase2.git", ["update-ref", "refs/heads/main", <the new oid>])`, under the
  `pinnedGitEnvironment` of `test/helpers/remote/seed.ts` whose author and committer dates are
  `1700000000 +0000`, so every advanced object id is a constant a test names. `docs/proposal/README.md`
  states that this needs no push route, and the harness owns the server process, so the origin holds
  still between steps. `scripts/e2e/lib/scenario/p2-e3.ts` exports `stepNames`, the frozen tuple
  `["upstream-advance", "divergence-refusal", "reconcile", "stale-oid-refusal", "non-fast-forward-refusal"]`,
  and `stepRelations`, the frozen tuple
  `["upstream-advanced", "diverged", "synchronized", null, "diverged"]`. The scenario walks those five
  steps in that order and calls `noteStep`
  once per step, so the bundle records the ancestry classification and both object ids at each one, and
  `steps[n].name` equals `stepNames[n]` and `steps[n].relation` equals `stepRelations[n]`.
  One, `upstream-advance`: upstream advances, the next clone starts from the new tip, and the landing
  branch fast-forwarded; the relation is `upstream-advanced`. Two, `divergence-refusal`: the landing
  branch then holds an
  unpublished commit and upstream advances again; the next clone is refused, `repository show` reports
  `needs-reconcile` with both object ids, `kanthord status` names the repository, and the objective
  stays `ready`; the relation is `diverged`. Three, `reconcile`: `kanthord repository reconcile --id <id>
--landing-oid <oid> --upstream-oid <oid>` prints `kanthord: merge`, `kanthord: check` and
  `kanthord: state ready`, the clone then succeeds, and the landing tip now contains the upstream tip,
  so the relation is `synchronized`. Four, `stale-oid-refusal`: `kanthord repository publish --id <id>
--landing-oid <a stale oid> --expected-remote-oid <oid>` is refused, and `runRemoteRefs` reports the
  remote ref unchanged; **the relation is `null`**, because EPIC 113 answers a stale `landingOid` with
  `publishStaleDetails` and `refusal` of `stale-oid`, which classifies no ancestry, and a recorded
  relation would be invented. Its `landingOid` is the stale object id it sent and its `upstreamOid` is
  `null`. Five, `non-fast-forward-refusal`: upstream advances once more, so the landing tip holds the
  merge commit and the remote holds a commit the landing tip does not contain; the publish is rejected,
  its `publishRejectedDetails` carries `relation` of `diverged`, which `classifyPushRejection` of
  EPIC 113 maps to the `non-fast-forward` class, and `runRemoteRefs` reports the remote ref unchanged.
  The evidence is `steps`, one row per step, with object ids.
- **The live bounds, and what enforces each one** — `docs/proposal/README.md` bounds a `live` run by a
  fixed maximum of attempts and calls, a per-call token cap, a wall-clock timeout, and no automatic
  rerun. `scripts/e2e/lib/scenario/p2-e4.ts` exports `liveBounds`, the frozen record
  `{ maxAttempts: 3, maxProviderCalls: 60, perCallOutputTokens: 32_000, wallClockMs: 3_600_000 }`, and
  the bundle records it as `LiveBounds`. Each bound has one mechanism, and no bound rests on prose.
  **The attempt maximum is the product's.** The runner writes `attemptLimit: 3` into the daemon
  config, and EPIC 110 blocks the task with reason `attempt-limit` at that count. **The per-call token
  cap is the product's.** `AGENT_MAX_OUTPUT_TOKENS` of EPIC 106 is `32_000` and it reaches
  `ModelRequest.maxOutputTokens`, so the runner sets nothing and asserts instead that no recorded
  `outputTokens` of any single invocation exceeds `32_000`. **The call maximum is the harness's,
  enforced at the boundary that counts the calls.** No product key limits the call count, and every
  provider call of P2-E4 travels through the loopback endpoint of
  `scripts/e2e/model-stub/main.ts`, because the registration's `baseUrl` names it. That endpoint
  increments its counter before it forwards, and it refuses call number `61` with `429` and the body
  `{"error":{"type":"kanthord_e2e_bound","message":"provider-calls"}}`, forwarding nothing. So call
  `61` never reaches the provider, and no call happens between two polls unobserved. The refused call
  fails the attempt through the ordinary provider-error path of EPIC 110, and the runner records
  `boundExceeded` of `provider-calls` when `calls()` of the endpoint reports more than
  `maxProviderCalls` requests. **The wall clock is the
  harness's, through a public route.** The runner arms one deadline of `wallClockMs` over the whole
  scenario and cancels on expiry. `3_600_000` is chosen from the product's own arithmetic: three
  attempts at the `settings.agent.timeoutMs` of `900_000` that EPIC 106 defaults to, plus the
  freshness pass, the diagnostic, the gate check and the publish. A cancel kills the process tree, per
  EPIC 110, so no descendant survives a bound. **No automatic rerun.** The scenario calls `run.start`
  exactly once and never retries, and a reused tag is already refused by `claimBundleDirectory`.
  Absent `KANTHORD_E2E_LIVE=1` the scenario raises `RunnerError("unavailable")` before it takes any
  resource, and it writes an `unavailable` bundle rather than a passing one. The real credentials come
  from `.env.e2e` through `loadE2eEnv` of `scripts/e2e/env.ts`, which gains four keys,
  `E2E_LLM_PROVIDER`, `E2E_LLM_MODEL`, `E2E_LLM_BASE_URL` and `E2E_LLM_API_KEY`, beside the three
  `E2E_GH_*` keys the real
  profile already reads. `E2E_LLM_BASE_URL` is the real provider base url the counting endpoint
  forwards to, and it is declared rather than derived, so the harness names no vendor catalogue. An
  absent or incomplete file raises `unavailable` and names each missing key.
  The api key reaches the daemon host as a mode `0600` file the runner writes and removes, never as an
  argument and never as an environment variable, exactly as EPIC 011.1 requires of the git token.
- **The hidden oracle of P2-E4, and where it lives** — the disposable repository holds a black-box
  test the agent never sees, and the task asks for the behaviour that test checks. The source of the
  test lives in the kanthord repository at `test/e2e/fixtures/p2-e4/oracle/hidden.test.mjs`, so it is
  reviewable and version-controlled. **It reaches no path the run creates.** The runner never pushes
  it to the disposable origin, never delivers it into the daemon home, and never writes it into the
  objective workspace; the plan text of the task names the required behaviour and no file name of the
  oracle. At judge time the runner creates one `mkdtemp` directory mode `0700`, clones the landed
  object id into it with the `git` binary, copies the oracle into that clone, runs
  `node --test hidden.test.mjs` there, and takes the directory through `context.take` so the central
  cleanup removes it. **The claim is stated exactly, because an overclaim is worse than a bound.**
  EPIC 106 makes the capability control the tool set and claims no filesystem confinement, so the
  `bash` tool of `general@1` can read a path outside its workspace. The oracle is therefore absent
  from the origin, from the bare home, from the objective workspace and from every prompt **the run
  recorded**, and it is
  present in the kanthord checkout the daemon runs from. That is the guarantee, and it is the same
  guarantee the fixture token registry of EPIC 011 makes: an absence over a named set of surfaces,
  never a claim about every reachable byte. **The absence is proved over bytes, not over plan text.**
  A grep of the plan fixture for one substring proves only what the author typed, so the runner reads
  every recorded invocation of the run through `kanthord node attempts`, resolves every prompt blob and
  every provenance source blob through `kanthord blob show --hash <hash>`, and asserts that no resolved
  payload holds the file name `hidden.test.mjs` and no resolved payload holds any non-blank line of
  `test/e2e/fixtures/p2-e4/oracle/hidden.test.mjs`, compared with `Buffer.includes`. The recorded claim
  is scoped to exactly that: the oracle text reached no prompt and no prompt source of this run. It is
  not a claim that no tool call could have read the file, and the epic states no such claim. The oracle
  output is attached as
  `documents/hidden-test-output.json`, and `LiveRecord.oracle` records `passed`, `failed` or
  `not-run`.
- **P2-E4 — real work, judged by that oracle** — mode `live`, driver `local`, profile `real`. It
  onboards the disposable repository with the real git credential and the real llm registration, which
  `kanthord credential register` writes with `--provider <E2E_LLM_PROVIDER>`,
  `--model <E2E_LLM_MODEL>`, `--api-key-file <the delivered real key>` and
  `--base-url http://127.0.0.1:<port>/upstream`, so every call reaches the real provider **through the
  counting endpoint** that enforces the call bound, imports a one-objective one-task plan from
  `test/e2e/fixtures/p2-e4/plan/`, runs it, and awaits the run under the bounds. It then asserts the
  oracle of `docs/proposal/phase-2/README.md`: at the landed object id the hidden test passes; the
  expected ref moved; the approval evidence and the `re@1` verdict name that same object id, read from
  `kanthord node approval` and from the reviewer invocation of `kanthord node attempts`; and the
  fixture remote holds the commit, read with `runRemoteRefs`. **A failure records what happened and
  claims nothing more.** `noteLive` writes the provider, the model, the usage totals,
  the run id, every attempt id in `attempt_no` order, and one `sha256:` prompt hash per invocation in
  invocation order, and it writes `boundExceeded`, one member of `boundNames` or null. The
  bundle `outcome` is `failed`, the mode field reads `live`, and no rerun happens.
  `docs/proposal/README.md` states that a live failure is evidence about that run and not
  automatically a regression, so this epic records the classification and EPIC 116 owns the judgment
  of whether it is a product defect.
- **Every credential is redacted in every bundle** — the secret registry of
  `scripts/e2e/lib/redact.ts` is the one mechanism, and `secrets.hold` is called on each secret before
  it can reach any recorded byte: the daemon bearer token, the fixture git token, the fixture llm api
  key `fixture-llm-key`, and for P2-E4 the real git token and the real api key. Every value is at
  least eight characters, which `hold` requires. `assertNoDisclosure` of
  `scripts/e2e/lib/disclosure.ts` runs over the printed commands, the recorded commands, the daemon
  logs, the config dump, every attached log and **every attached document**, so the attempt record and
  the approval evidence are covered by the same absence assertion as the rest of the bundle. Each
  absence assertion refuses when the registry is empty, which is the rule EPIC 011 states after
  producing one vacuous pass. The product side of redaction belongs to EPIC 110, which redacts before
  it stores, and EPIC 111, which asserts no inline field and no referenced blob carries credential
  material; this epic asserts the bundle, and it asserts it over a deliberately failing run as well as
  a passing one.
- **Every new resource is released by the central cleanup** — a scenario declares what it took and
  carries no teardown path of its own, which is the rule of EPIC 011. The model stub is taken as
  `kind: "process"`, the judge clone directory of P2-E4 as `kind: "directory"`, and the delivered api
  key file as `kind: "file"`. `scripts/e2e/lib/scenario/discipline.test.ts` gains the four new scenario
  files to its list, so each one is asserted to import nothing from `src/` and to declare no `finally`
  of its own. The daemon process, the temporary home, the home lock and the fixture remote are already
  taken by the drivers and the fixture profile, and this epic adds none of them a second time.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
TAG=$(node scripts/e2e/run.mjs --mint-tag) \
  && node scripts/e2e/run.mjs P2-E1 --tag "$TAG" \
  && node scripts/e2e/run.mjs P2-E2 --tag "$TAG" \
  && node scripts/e2e/run.mjs P2-E3 --tag "$TAG" \
  && node --test \
    scripts/e2e/lib/tag.test.ts \
    scripts/e2e/lib/main.test.ts \
    scripts/e2e/lib/bundle.test.ts \
    scripts/e2e/lib/redact.test.ts \
    scripts/e2e/lib/disclosure.test.ts \
    scripts/e2e/lib/record/verdict.test.ts \
    scripts/e2e/lib/record/acceptance.test.ts \
    scripts/e2e/lib/driver/origin-probe.test.ts \
    scripts/e2e/lib/driver/interface.test.ts \
    scripts/e2e/lib/model-stub/script.test.ts \
    scripts/e2e/lib/model-stub/index.test.ts \
    scripts/e2e/lib/scenario/index.test.ts \
    scripts/e2e/lib/scenario/discipline.test.ts \
    scripts/e2e/lib/scenario/tools.test.ts \
    scripts/e2e/lib/scenario/p2-wait.test.ts \
    scripts/e2e/lib/scenario/p2-e3.test.ts \
    scripts/e2e/lib/scenario/p2-e4.test.ts \
    test/helpers/remote/seed.test.ts \
  && echo "PASS EPIC-115"
```

P2-E4 is not in the Proof. `docs/proposal/README.md` makes `live` opt-in through
`KANTHORD_E2E_LIVE=1`, and a gate that spends a provider account on every run is not a gate.
EPIC 116 invokes it once, and `KANTHORD_E2E_LIVE=1 node scripts/e2e/run.mjs P2-E4 --tag "$TAG"` is
its command.

Hermetic coverage required beyond the Proof:

- `scenarioIdsByPhase[2]` deep-equals `["P2-E1", "P2-E2", "P2-E3", "P2-E4"]`, and `knownScenarioIds`
  deep-equals `["P1-E1", "P1-E2", "P1-E4", "P1-E5", "P2-E1", "P2-E2", "P2-E3", "P2-E4"]`, and the
  module text of `main.ts`, `record/verdict.ts` and `record/acceptance.ts` declares no
  `knownScenarioIds` of its own, asserted by reading each source and matching
  `/const knownScenarioIds/` zero times.
- The three inventories agree exactly: `scenarios.map((scenario) => scenario.id)` deep-equals
  `knownScenarioIds`, and for each of `1` and `2` the ids of the `scenarios` rows whose `phase` equals
  it deep-equal `scenarioIdsByPhase[phase]`. Adding a fifth `ScenarioId` with no `scenarios` row fails
  the first of those two, so no id can live in the type alone.
- `--verdict <tag> --phase 2` over a tag holding the three deterministic bundles and no P2-E4 bundle
  exits `3` and names `P2-E4` as the absent bundle. The same invocation with `--phase 1` names the
  four phase-1 ids instead, so the phase selector is load-bearing.
- `--verdict <tag> --phase 2 --scenarios-only` over that same tag checks the scenario axis only and
  ignores the absent acceptance record, which is the command EPIC 116 runs before the human gate.
- `--phase` beside a scenario id, `--tag`, `--reclaim`, `--mint-tag` or `--record-verify` is an
  argument fault; `--phase` beside `--record-acceptance` is accepted; and `--verdict <tag>` with no
  `--phase` behaves exactly as it does today.
- `--record-acceptance --tag <tag> --phase 2` over a tag holding only phase-1 bundles raises
  `unavailable`, and the same invocation with `--phase 1` succeeds, so the phase reaches the
  acceptance record and not only the verdict.
- `bundleSchemaVersion` equals `2`, and `serializeBundle` over a bundle carrying one `steps` row, two
  `documents` rows and a null `live` field equals the exact expected JSON bytes, asserted with
  `Buffer.compare`. The `documents` rows are ordered by `name` with `Buffer.compare`, proved by
  attaching `b` before `a`.
- `attachDocument("attempt-record", <text>)` writes `documents/attempt-record.json` whose bytes are the
  redacted text, and the recorded `sha256` equals the digest of those written bytes, and `bytes` equals
  their length.
- A `live` bundle serializes `mode` as `"live"` and a `LiveRecord` whose `usage` holds the five token
  fields, whose `attemptIds` are in `attempt_no` order, and whose `promptHashes` each match
  `/^sha256:[0-9a-f]{64}$/`. `Object.keys` of that record deep-equals
  `["provider", "model", "runId", "attemptIds", "usage", "promptHashes", "bounds", "boundExceeded", "oracle"]`,
  so no field the sources do not ask for is serialized, and `modelCalls` is absent.
- `boundNames` deep-equals `["attempt-limit", "provider-calls", "wall-clock"]`, and a `LiveRecord`
  whose `boundExceeded` is any other string fails to serialize, so the field is a closed set and not
  free-form text.
- The seed produces `phase2.git` whose `refs/heads/main` equals the pinned `phase2Commit1` of
  `fixtureObjectIds`, whose tree holds exactly `README.md`, `package.json`, `src/sum.mjs` and
  `test/sum.test.mjs`, and whose `HEAD` is a symref to `refs/heads/main`. Two seeds in a row produce
  the identical object ids.
- `npm test` inside a checkout of `phase2Commit1` exits zero with no `node_modules` present, so the
  `["npm", "test"]` command the `nodejs` template declares is runnable offline and no scenario
  overrides a template check.
- `fixtureObjectIds.commit1`, `commit2` and `tagV1` are unchanged by this epic, asserted against the
  three literals `test/helpers/remote/seed.test.ts` already pins, so the second repository cost the
  phase-1 pins nothing.
- `resolveAgentPath()` returns exactly the directory of `node` and the directory of `npm`, joined by
  `delimiter`, and it throws when either binary is absent from `PATH`.
- `originProbeScripts` with `phase: 1` returns exactly the three phase-1 rows, and with `phase: 2`
  returns those three followed by `fixture-accepts-non-force-push` and
  `fixture-rejects-non-fast-forward`, in that order.
- The phase-2 probe against the seeded origin reports all five rows passed, and after it runs
  `refs/heads/kanthord-e2e-probe` is absent and `refs/heads/main` is byte-identical to its seeded
  value.
- The probe raises `unavailable` when the origin refuses a non-force push, and when it accepts a
  non-fast-forward push.
- `startModelStub` selects the reviewer script when the first user message holds the
  `reviewerProseMarker` it was given, and the implementer script otherwise, asserted by two requests
  against one stub whose two scripts return two distinguishable texts.
- The marker is present in a real prompt: the `re@1` prompt of P2-E2 attempt one holds the exact
  sentence `Never propose an implementation.`, and it holds the string `role-contract/re@1` nowhere,
  so the selector reads a byte the compiler renders and never a provenance label.
- The stub repeats its last turn when the calls outnumber the turns, asserted by three calls against a
  two-turn script, and `calls()` returns three records in call order.
- Four reviewer calls against the P2-E2 script answer accept, reject, reject, reject in that order, so
  one script accepts `01-accepted` and rejects `02-rejected` three times with no task-aware selection.
- A reviewer turn holding one tool call makes the run fail with `AgentError("reviewer-wrote")`, proved
  by driving one `re@1` attempt through P2-E2's own stub with that turn substituted. The scenario
  bundle then reports `failed`, and no bundle reports `passed`.
- `awaitRunEnded` returns the run view on the first poll that reports `state` of `"ended"`, and it
  performs no sleep: the test injects a clock and a poll function and asserts the exact call count.
- `awaitRunEnded` at its deadline with the run still `active` attaches the daemon logs to the bundle
  and raises `assertion-failed` naming the run id.
- `awaitRunEnded` cancels through `run.cancel` when the injected clock passes `wallClockMs`, and it
  reads no call count and cancels for no other reason, asserted over an injected poll function that
  never reports a bound.
- The loopback endpoint refuses the call after its maximum and forwards nothing: with `maxCalls` of
  `60` and a `forwardTo` pointing at a counting loopback upstream, calls one to sixty answer `200` and
  reach the upstream, call sixty-one answers `429` with the exact body
  `{"error":{"type":"kanthord_e2e_bound","message":"provider-calls"}}`, and the upstream recorded
  exactly sixty requests.
- The endpoint serves `POST /script/chat/completions` from the script, forwards
  `POST /upstream/chat/completions` to `<forwardTo>/chat/completions` with the `authorization` header
  intact, and answers `404` on every other path.
- `liveBounds` deep-equals
  `{ maxAttempts: 3, maxProviderCalls: 60, perCallOutputTokens: 32_000, wallClockMs: 3_600_000 }`, and
  `perCallOutputTokens` equals `AGENT_MAX_OUTPUT_TOKENS` of EPIC 106, asserted against the value the
  bundle records rather than against a second literal.
- P2-E4 with `KANTHORD_E2E_LIVE` unset writes an `unavailable` bundle, takes no resource, starts no
  daemon and contacts no provider, asserted by an empty recorded command list.
- P2-E4 with `KANTHORD_E2E_LIVE=1` and an absent or incomplete `.env.e2e` raises `unavailable` and
  names each of `E2E_GH_TOKEN`, `E2E_GH_REPO`, `E2E_GH_BASE_BRANCH`, `E2E_LLM_PROVIDER`,
  `E2E_LLM_MODEL`, `E2E_LLM_BASE_URL` and `E2E_LLM_API_KEY` that is missing.
- P2-E4 calls `run.start` exactly once, asserted over the recorded command list, so no automatic rerun
  can occur.
- The oracle file `test/e2e/fixtures/p2-e4/oracle/hidden.test.mjs` exists, and no file under
  `test/e2e/fixtures/p2-e4/plan/` holds the substring `hidden`.
- The absence is asserted over bytes, not over the plan text alone: for every recorded invocation of
  the run, the resolved prompt payload and every resolved provenance source payload hold neither the
  string `hidden.test.mjs` nor any non-blank line of the oracle file, asserted with `Buffer.includes`
  over each payload. The bundle records that claim with that exact scope, and it records no claim about
  a path a tool call could reach.
- The judge clone of P2-E4 is created under a `mkdtemp` directory mode `0700`, is taken as a ledger
  resource, and no longer exists after the run, on the failing path as well as the passing one.
- P2-E1 writes `objectIds` holding exactly the keys `candidateOid`, `landingBaseOid`,
  `landingHeadOid`, `remoteHeadOid`, `task1Commit` and `task2Commit`, in that bytewise order, and
  `documents` holding `approval-evidence`.
- P2-E2 records exactly one `kanthord: attempt` line for `01-accepted` and exactly three for
  `02-rejected`, and its `documents` entry `attempt-record` holds three attempt objects for
  `02-rejected`. Nothing is asserted as non-empty. Each attempt object carries: a prompt payload whose
  sha256 equals the hash its invocation line named; a tool trace deep-equal to one record naming the
  tool `write`, the path `src/remainder.mjs` and no error; a verification record whose command
  deep-equals `["npm", "test"]`, whose exit status is `0` and whose output holds the exact line
  `# fail 0`; and a reviewer reason list deep-equal to one entry per task criterion, in criterion
  order, each with verdict `reject` and the exact reason string of the script turn.
- The attempt-one prompts of P2-E2 are byte-identical to
  `test/e2e/fixtures/phase-2-blocked/expected/attempt-1-general.prompt.md` and
  `attempt-1-re.prompt.md`, asserted with `Buffer.compare`, so the product output is compared against a
  committed expectation and never against itself.
- The provenance channel list of the attempt-one `general@1` invocation deep-equals
  `["daemon-invariants", "role-contract", "repository-profile", "task-contract"]`, of attempts two and
  three deep-equals that list plus `"runtime-evidence"`, and of every `re@1` invocation deep-equals
  `["daemon-invariants", "role-contract", "task-contract", "runtime-evidence"]`. The `from` labels are
  `convention:coding/v1`, `code:role-contract/<role>@1`, `profile:<the profile content blob>`,
  `node:<taskId>@<revision>` and `attempt:<the previous attemptId>`, in that channel order.
- P2-E2 pins `objectIds.abandonSurvivorOid` before the abandon, the same value after it, and
  `cat-file -e <that oid>^{commit}` against the objective workspace exits zero after the abandon.
- P2-E3 records exactly five `steps` rows whose `name` values deep-equal `stepNames` and whose
  `relation` values deep-equal `stepRelations`, that is
  `["upstream-advanced", "diverged", "synchronized", null, "diverged"]`. Every row except
  `stale-oid-refusal` carries both object ids, and that row carries `landingOid` and a null
  `upstreamOid`, because a `stale-oid` refusal classifies nothing.
- The P2-E3 upstream advance is deterministic: two runs of the advance sequence produce the identical
  advanced object id, because `pinnedGitEnvironment` fixes both dates at `1700000000 +0000`.
- No token, no api key and no bearer value appears in any printed command, any recorded command, any
  attached log, any attached document, any config dump or any bundle field, asserted over a
  deliberately failing run of each of P2-E1, P2-E2 and P2-E3, and each absence assertion refuses when
  the secret registry is empty.
- The recorded command list of the journey holds `credential register` before `onboard`, and the
  `onboard` argument vector holds none of `--unit-run`, `--unit-timeout`, `--provider`, `--model` and
  `--api-key-file`, asserted as one exact argument vector, so this epic invents no product flag and
  EPIC 114 ships every flag the journey uses.
- The journey's `onboard` run prints `kanthord: skipped llm-credential`, because the named `llm` row
  already exists, and its `kanthord: llm default model` line still appears, which is the EPIC 114 skip
  rule.
- The loopback endpoint writes no `authorization` header value and no api key to its own log or to any
  recorded command, asserted over a forwarded call whose header holds a conspicuous fixture key.
- No file under `scripts/e2e/lib/scenario/` imports from `src/`, and the four new scenario files are
  named in `discipline.test.ts` alongside the phase-1 ones.
- `driverMethodNames` is unchanged, so the phase-2 journey added no driver method, and every driver
  writes the new `agent` member of `DaemonConfig`, asserted by `interface.test.ts` over both the
  `local` and the `podman` driver.
- A failing P2-E1, P2-E2 or P2-E3 run leaves no model stub process, no temporary home, no held home
  lock and no daemon process behind, asserted by the ledger report and by a second run under a fresh
  tag passing.
