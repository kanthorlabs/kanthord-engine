---
description: Drive the whole kanthord program end to end as the end user — a user-supplied OpenAI-compatible provider (URL + key + model) and the kanthord-verify GitHub repo, through register/probe/logout/reactivate, project + graph setup, a resilient daemon run that records issues instead of aborting, a harness-owned program proof, and a blockers/suggestions report. Everything runs through scripts/e2e/*, never ad-hoc one-liners. Use to validate that all components work together on a real feature, or to hunt integration bugs.
agent: build
subtask: false
---

# /e2e — end-to-end program test, as the end user

Arguments: `$ARGUMENTS` — a run tag such as `009`. It names the isolated run dir
`.data/e2e-<tag>/` and the fixture branch, and nothing else. Reuse of a tag is
refused, so a rerun means a new tag.

Your job is to **drive** the phases and **judge** what goes wrong. The scripts do
the setup and the asserting; you do the diagnosis, the retry decisions after the
first round, and the final grouped assessment. Never re-derive state with ad-hoc
`list … --json | node -e …` — every phase already prints and stores it.

## The workload

A mid-level engineering job, not a CRUD exercise: `kanthord-verify` is seeded
with a **fixture** — conventions (`AGENTS.md`), stub modules, and **immutable
contract tests that are red at the base commit**. The agent implements _to_ a
contract it did not write and may not edit.

- **objective A `todo-core`** — A1 store + server seam · A2 `POST/GET /tasks`
  with validation, both filters and pagination · A3 `GET/PUT/DELETE /tasks/:id`
  with 404/400/405 + an exact `Allow` header
- **objective B `todo-persistence`** (`after: [todo-core]`) — B1 move the store
  onto `node:sqlite` with the contract unchanged and persistence across a restart

`after:` means B's tasks stay pending until A is **integrated**, so a full run
passes the human gate twice before the initiative reaches `landed`.

## Inputs — one global `.data/e2e.env`, `chmod 600`

Set it up once; every run reads it. It ships with placeholders — the four
`REPLACE_ME` values are the whole setup:

```sh
E2E_AI_BASE_URL=https://…/v1      # OpenAI-compatible endpoint, no credentials in the URL
E2E_AI_API_KEY=…
E2E_AI_MODEL=…                    # exact model id as the endpoint names it
E2E_GH_TOKEN=…                    # fine-grained PAT: Contents=RW, Metadata=RO
```

Everything else has a default, and the file lists them commented out:
`E2E_AI_EFFORT=high` · `E2E_AI_API=openai-completions` ·
`E2E_AI_CONTEXT_WINDOW=131072` and `E2E_AI_MAX_TOKENS=8192` (custom providers
default to 32768/4096 and kanthord does **no** compaction) ·
`E2E_AI_ALLOW_INSECURE=0` (set to 1 for a locally served model on `http://`) ·
`E2E_GH_REPO=kanthorlabs/kanthord-verify` · `E2E_GH_BASE_BRANCH=main`
(read-only, never written) · `E2E_MODE=local` · `E2E_MAX_ROUNDS=6` ·
`E2E_ROUND_TIMEOUT=1800` · `E2E_MAX_ATTEMPTS=2` · `KANTHORD_MAX_TURNS=90`.

Rules that the loader enforces:

- `E2E_TAG` must **not** be in the file — it names one run, so export it in the
  shell (`export E2E_TAG=009`). A file that pins it is refused.
- A left-over `REPLACE_ME` counts as a missing input, not as a value.
- Mode other than `600`/`400` gets a warning.
- A per-run `.data/e2e-<tag>/e2e.env` is optional and **layers on top** of the
  global file for a one-off experiment. `E2E_ENV_FILE=<path>` replaces both.

Never pass a secret as a command argument — argv is visible in `ps`. The scripts
write both secrets to `chmod 600` files and pass paths.

A user-supplied URL + key + model is **not** `login provider` (that command is
OAuth-only). The lifecycle is **register → probe → logout → reactivate**.

## Phases

Each script is idempotent-ish, refuses to run out of order, and stores its result
in `.data/e2e-<tag>/state.json`. Run them in order; P0–P2 fail fast, P3 onward is
resilient.

The whole chain, always a fresh run — the tag is `date +%Y%m%d-%H%M%S`:

```sh
make e2e
```

It always writes the report, and exits non-zero on the first phase failure so a
blocked run never reads as a success. Run it from a terminal — P0 asks before it
writes to the remote (`E2E_CONFIRM_PUSH=1` skips the prompt, and
`E2E_CONFIRM_PUBLISH=1` in delivery mode).

Phase by phase, when you want to stop and look between steps — or to continue a
run that `make e2e` left `blocked` (export the tag it printed; `drive-run.sh`
resumes):

```sh
export E2E_TAG=<tag>
scripts/e2e/preflight.sh        # P0  inputs, token, fixture push   (asks to confirm the push)
scripts/e2e/provider-cycle.sh   # P1  register → probe → logout → reactivate
scripts/e2e/setup-graph.sh      # P2  credential, repo, graph import + topology assertions
scripts/e2e/drive-run.sh        # P3  daemon rounds, findings, approve gates   (resumable)
scripts/e2e/contract-proof.sh   # P4  harness-owned program proof (+ publish in delivery mode)
scripts/e2e/e2e-report.sh       # P5  the evidence report — always run this
```

- **P0** proves the inputs, then **pushes the fixture** to a new orphan branch
  `kanthord-e2e/<tag>-base`. That push is the real proof the token can write
  (GitHub's `permissions.push` is only metadata) and needs consent: answer the
  prompt, or pass `E2E_CONFIRM_PUSH=1` when running non-interactively. `main` is
  never touched. An existing fixture branch is refused unless
  `E2E_FORCE_FIXTURE=1`.
- **P1** asserts the whole credential lifecycle, including that a bare
  `logout ai-provider` on the sole default is **refused**, and that
  re-registering returns the **same id** with the default restored. The pass/fail
  probe asks for a fixed literal; the "what date is it" answer is recorded as
  evidence only — asserting on model prose is flaky, and a wrong date is a model
  observation, not a kanthord defect.
- **P2** asserts 2 objectives, 4 tasks, the A1←A2←A3 chain, the objective `after:`
  edge, the repository's branch/auth, and that the chain still resolves the
  provider.
- **P3** runs the daemon in bounded rounds. It parses the **daemon's own stderr
  summary** (`task failed: <id> — …`, `N objective(s) awaiting confirmation`,
  `N initiative(s) landed`) — not `e2e-status.sh`, which is a human dashboard.
  It approves an objective that is `awaiting_confirmation`, retries a failed task
  **only in round 1** (bounded by `E2E_MAX_ATTEMPTS`), and otherwise stops as
  `blocked` and hands you the diagnosis.
- **P4** extracts the whole landed tree, **throws away its `test/` and drops the
  harness's own contract copy in place**, runs that, then boots
  `src/main.mjs` twice on one database file to prove persistence through the real
  boot path. This is the only gate the agent cannot influence. A failure here is
  `outcome=failed`, not a finding.
- **P5** always runs, even after a fail-fast exit.

## Your part in P3

When `drive-run.sh` stops as `blocked`, it has already written the evidence. For
each `needs-agent-decision` or `task-escalated` finding:

1. read `logs/p3-round-<n>.log` and the task's evidence for the real reason;
2. decide: retry with diagnosis, or stop and report a kanthord defect;
3. `node src/main.ts retry task --id <id> --note "<what to do differently>"`;
4. re-run `scripts/e2e/drive-run.sh` — it resumes with the same DB, graph and
   attempt counters.

Each retry is a real model call against the user's own key. Do not retry a
deterministic failure without changing something.

## Verdicts

`state.json` carries `outcome`:

- **passed** — the provider lifecycle, the graph execution, the local landing and
  the harness-owned proof were all demonstrated (plus the remote publish in
  delivery mode).
- **blocked** — the run stopped without a usable verdict.
- **failed** — something was demonstrably wrong.

Never call a run successful on a `blocked` outcome.

## Gotchas (verified — check before filing a bug)

- **`node --test test/` does not work on Node 24** — it resolves `test` as a
  module and dies with `MODULE_NOT_FOUND`. Pass explicit files, or a **quoted**
  glob so Node expands it: `node --test "test/**/*.contract.test.mjs"`.
- A task's `# Verification` lines each run in **their own `sh -c`** with a 300 s
  timeout and no injected env, so state never carries between lines.
- An ordinary task failure (verification failed, budget exceeded) is **never**
  auto-retried by the daemon; only `transient` results are. It sits in `failed`
  until someone runs `retry task`.
- Turns default to 50 per task (`KANTHORD_MAX_TURNS`, the harness sets 90) and
  there is **no compaction** — a long task dies on a provider context error that
  surfaces as a plain `failed`.
- The landed code is on the objective branch `kanthord/init/<initiative-id>`, not
  on home `HEAD`/`main`; `main` moves only on publish.
- Conflict messages print to **stderr** — capture `2>&1` when asserting on them.
- `list event` needs `--after <cursor>` and pages **10** rows without `--limit`;
  pass `--limit 1000` or follow the `nextCursor` sentinel.
- `get repository --id` works, and so does `get resource --id`.

## Finishing

`scripts/e2e/e2e-report.sh` writes `.agent/e2e/<tag>/report.md` with the phase
outcomes, the tally, the chronological evidence, the repro commands and the
branch cleanup lines. Then **you** replace the marked section with the grouped
assessment: group by root cause and write one bullet per item as
`<B1/S1> - action:<YES/NO> - <name> - <description>`. `/debate` the fix approach,
then author the fix EPIC with a program-level `Proof:` — the report is evidence,
not an EPIC, which is why it does not live under `.agent/plan/epics/`.

The fixture branch and the initiative branch stay on the remote until someone
runs the cleanup lines. Never delete them without asking.
