# EPIC 011 — End-to-end scenarios — stories

Epic: `.agents/plan/epics/011-end-to-end-scenarios.md`
Prereq: EPIC 010.6 (sequence order).

`scripts/e2e/run.mjs <id>` runs P1-E1, P1-E2, P1-E4 and P1-E3 against the installed binary
and writes one evidence bundle per run.

## Dispatch order

```
00 → 01 → 02 → 03 → 06 → 04 → 05 → 07 → 09 → 10 → 08 → 11
```

- `00` is a product change and touches no runner code, so it may run in parallel with the
  `01 → 02 → 03` spine. It must land before `10`.
- `01 → 02 → 03` is the runner spine. Nothing else compiles without it.
- `06` moves ahead of `04` and `05`: both scenarios consume the driver and profile
  interfaces.
- `04` and `05` are independent of each other and may run in parallel.
- `07 → 09 → 10` build the container substrate. `08` is the coupled consumer of all three
  and must follow them.
- `11` is last. It is the only story with no line in the EPIC 011 Proof block.

## Stories

- 00 — the `http.tokenFile` configuration key, mirroring `masterKeyFile` → `00-the-token-file-key.md`
- 01 — the runner entry, the argument grammar, the tag and the printed command → `01-the-runner.md`
- 02 — the central resource ledger and the signal-safe teardown → `02-cleanup-is-central.md`
- 03 — the evidence bundle, schema version 1, canonical key order → `03-the-evidence-bundle.md`
- 04 — P1-E1, fifteen invocations, seventeen assertions, and the authored plan fixture → `04-p1-e1-the-onboarding-journey.md`
- 05 — P1-E2, the six-case transport oracle and the startup refusal → `05-p1-e2-the-hostile-client.md`
- 06 — the `ExecutionDriver` and `ScenarioProfile` axes, and the scenario table → `06-the-driver-and-the-profile.md`
- 07 — the three-container two-namespace Podman topology, on two images → `07-the-p1-e4-topology.md`
- 08 — P1-E4, the journey and the whole transport oracle across the boundary → `08-p1-e4-the-two-namespace-run.md`
- 09 — the five hermeticity rules: preflight, offline provisioning, reclaim, labels, polled readiness → `09-p1-e4-hermeticity.md`
- 10 — secrets as mounted files, and the seven-surface disclosure assertion → `10-secret-handling.md`
- 11 — P1-E3, the ssh driver, the real profile and the unavailable path → `11-p1-e3-the-vpn-run.md`

## Proof coverage

| EPIC Proof line                  | delivered by       |
| -------------------------------- | ------------------ |
| `node scripts/e2e/run.mjs P1-E1` | 04, on 01+02+03+06 |
| `node scripts/e2e/run.mjs P1-E2` | 05, on 01+02+03+06 |
| `node scripts/e2e/run.mjs P1-E4` | 08, on 07+09+10    |

| EPIC coverage line                                      | delivered by                       |
| ------------------------------------------------------- | ---------------------------------- |
| nothing survives a failing run; a stale id is reclaimed | 02, 09                             |
| non-loopback bind with no token refuses to start        | 05 locally, 08 across the boundary |
| an allow list omitting the alias returns `403`          | 08                                 |
| one driver interface, asserted by construction          | 06                                 |
| the token appears on no surface, failing run included   | 10                                 |
| Podman absent or stale fails loudly, never skips        | 09                                 |
| the phase exits by pointing at a P1-E3 bundle           | 11                                 |

## Decisions Ulrich ratified on 2026-08-06

- `minimumPodmanVersion = "5.0.0"`, the same standing `minimumGitVersion = "2.34.0"` holds.
  The development machine runs client `6.0.0`.
- the base image, pinned by its OCI image index digest, resolved from the registry on
  2026-08-06, so one reference is correct on `arm64` and `amd64`:

  ```ts
  export const baseImageReference =
    "docker.io/library/node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584";
  ```

- `http.tokenFile` ships. Story 00 delivers it, and every disclosure surface in Story 10 is
  an absence assertion as a result.

## Facts (needed for implementation)

- **`scripts/e2e/run.mjs` holds no logic.** `tsconfig.json:15` includes `scripts/**/*.ts`
  only, so a `.mjs` file is not typechecked. Every line of logic lives in
  `scripts/e2e/lib/*.ts`. `docs/proposal/README.md:56-58` fixes the `.mjs` entry name.
- **`scripts/` is outside the import matrix.** `eslint.config.js:25` scopes the boundaries
  rules to `src/**/*.ts` and `test/**/*.ts`. `eslint.config.js:338-346` gives
  `scripts/**/*.ts` a parser and no rules. `scripts/e2e/007/run.ts:12-18` already imports
  from `src/`, so the runner may import `src/domain/**` and `test/helpers/**`.
- **`test/e2e/` holds Markdown only.** `boundaries/no-unknown-files` covers `test/**/*.ts`
  and `test/e2e/` is not a declared element. Any `.ts` that would live there goes under
  `scripts/e2e/lib/` instead.
- **Export byte identity baselines on the accepted documents**, never on the authored
  fixture. `docs/proposal/phase-1/plan-format.md:52` and `docs/proposal/api/graph.md:90`:
  an authored document may lack identities, reference by path and use noncanonical YAML, so
  no renderer reproduces it. `plan.import` returns the accepted set in its response
  (`api/graph.md:56`) and the client replaces its plan directory with it.
- **An empty plan's revision is `null`**, not a sentinel string —
  `src/http/contract/graph.ts:13,60` types it `z.string().nullable()`. The first import
  names `null` in `fromRevision`. A `409 stale-revision` carries the current revision in
  `details` (`api/graph.md:64`).
- **`KANTHORD_TOKEN` is already the CLI's token fallback**, `src/cli/options.ts:39`. That is
  how a wrapper hands a mounted token to the CLI with no `--token` in argv.
- **The installed `kanthord` shebang is `#!/usr/bin/env node`**
  (`src/domain/version.test.ts:16-36`), so any driver that sets `PATH` must include the Node
  directory as well as the npm prefix.
- **`node --test` picks up `scripts/e2e/lib/**/*.test.ts`**, so every unit test in this EPIC
  runs inside `npm run verify`. None may spawn Podman, ssh, or reach a non-loopback address.
- **The packaged binary is the `bin` link**, not a compiled artifact. `package.json:11-13`
  is `{ "kanthord": "./src/main.ts" }`; there is no build step, no bundler, no SEA config.
  `.agents/plan/epics/001-runtime-foundation.md:33-35` defines P1-E1's packaging as
  `npm pack`, an install, and an invocation of the linked name.
- **Config search order**, `src/services/config/search-order.ts:10-27`, exactly four
  candidates: `$KANTHORD_CONFIG` resolved against cwd, `<cwd>/kanthord.config.json`,
  `${XDG_CONFIG_HOME ?? ~/.config}/kanthord/config.json`, `/etc/kanthord/config.json`.
  Candidate 2 is "the first discovered location" P1-E1 uses.
- **The exact refusal strings.**
  `src/services/config/convict.ts:133-138` — `no config file found; searched: <joined>`.
  `src/services/config/refusals.ts:47-52` — `a non-loopback bind address requires http.token`.
  Both print as `kanthord: <code>: <message>\n` with exit `1` — `src/main.ts:317-318`.
- **Readiness is `kanthord: ready\n` on stdout**, `src/main.ts:302`.
- **Config keys**, `src/services/config/convict.ts:43-90`: `home`, `actor`, `masterKey`,
  `masterKeyFile`, `http.bind`, `http.port`, `http.token`, `http.allowedHosts`, `tools.git`,
  `tools.ssh`, `tools.sshKeyscan`, `attemptLimit`. JSON only, `{ allowed: "strict" }`.
  Story 00 adds `http.tokenFile`, so a config names a path and never holds a secret.
- **A secret file must be mode `0600` exactly.** `src/services/config/refusals.ts:33-45`
  refuses any other mode on `masterKeyFile`, and Story 00 gives `http.tokenFile` the same
  rule. A Podman secret mounted at `mode=0400` makes the daemon refuse to start.
- **`podman version` succeeds while the machine is stopped.** Measured on 2026-08-06: the
  client prints `6.0.0` and exits zero, and `podman info` fails with
  `unable to connect to Podman socket`. Only `podman info` separates absent from stopped.
- **Version parity** compares `kanthord --version` (commander, `src/main.ts:96`, sourced
  from `src/domain/version.ts:1`) against `system.status`'s `version` field, which EPIC 009
  Story 04 delivers.
- **Middleware order**, `src/http/server/app.ts:50-60`: envelope → origin → host → auth →
  route → bodyparser → dispatch. Error codes at `src/http/contract/errors.ts:3-25`; envelope
  shape `{ error: { code, message } }` at `errors.ts:77-84`.
- **`system.health` is authenticated** and passes the Host and Origin checks like every
  route — `src/http/server/app.test.ts:21,35`, `docs/proposal/api/README.md:210`. The
  readiness poll must carry the bearer token and the allowed `Host`.
- **Rendered paths**: `GET /v1/health`, `GET /v1/status`, `POST /v1/provider`,
  `POST /v1/repository`, `GET /v1/repository/:id`, `POST /v1/project`,
  `PUT /v1/project/:id/repository`, `POST /v1/project/:id/plan/import`,
  `GET /v1/project/:id/plan/export`, `GET /v1/project/:id/plan/revision`,
  `POST /v1/project/:id/run`. There is **no `credential.*` operation id** — the CLI's
  `credential register` calls `provider.register`.
- **CLI exit codes**, `src/cli/exit-code.ts:8-30`: `stale-revision` 150,
  `not-implemented` 220, `unauthenticated` 120, `host-forbidden` 131, `origin-forbidden` 130.
- **CLI output convention**: one line per fact, `kanthord: registered <name> <id>`,
  `kanthord: landing <ref> <oid>`, `kanthord: tracking <ref> <oid>` —
  `src/cli/repository/show.ts:37-47`.
- **The fixture remote** is `test/helpers/remote/http.ts:478` `startHttpRemote(tools, seed)`,
  bound at `http.ts:502` to `127.0.0.1:0`. Story 07 adds an optional third argument so the
  fixture can bind a fixed port inside a container. Credentials are
  `httpCredentials` at `http.ts:50`; the seed default branch is `main`
  (`seed.ts:95-116`); fixture object ids are `seed.ts:22`.
- **The pinned `git` minimum is `2.34.0`**, `test/helpers/remote/tools.ts:43`. The
  version-compare shape there is the model for the Podman check.
- **`.gitignore:146-148`** already ignores `.data/acceptance-*/`, `.agents/acceptance/` and
  `.agents/e2e/`. No bundle is ever committed.
- **EPIC 012 runs four scenario ids under one `--tag`** (`012:59-66`), so the reuse refusal
  is per scenario id, never per tag.
- **Do not touch `scripts/e2e/007/**`.** That harness is EPIC 007's gate and stays as it is,
  including its `e2e:007` package script.
