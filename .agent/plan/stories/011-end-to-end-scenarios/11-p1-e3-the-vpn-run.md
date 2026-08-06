# Story 11 — P1-E3, the VPN run

Epic: `.agent/plan/epics/011-end-to-end-scenarios.md`
Depends on: Story 00, Story 04, Story 06, Story 10.

Oracle: `docs/proposal/phase-1/README.md:100-110`. Mode `deployment`, driver `ssh`, profile
`real`.

## Change

### New — `scripts/e2e/lib/driver/ssh.ts`

```ts
export type SshTarget = Readonly<{ role: HostRole; host: string }>;

export async function createSshDriver(
  context: ScenarioContext,
  input: Readonly<{
    daemonHost: string;
    clientHost: string;
    execute: (
      target: SshTarget,
      argv: readonly string[],
    ) => Promise<CommandRecord>;
  }>,
): Promise<ExecutionDriver>;
```

It implements the ten `driverMethodNames` of Story 06 and nothing more.

- `execute` defaults to `runCommand` with argv
  `["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", host, "--", ...argv]`.
  `BatchMode=yes` means the run never prompts; a missing key fails rather than waits.
- `deliverBinary(role)` runs `npm pack` locally once, copies the tarball with
  `scp -o BatchMode=yes`, then `npm install --global --prefix ~/.kanthord-e2e-<tag>` on the
  target host, and returns `~/.kanthord-e2e-<tag>/bin/kanthord`.
- `deliverConfig` writes the config on the daemon host with mode `0600`. It sets
  `http.tokenFile` and `masterKeyFile` to the delivered paths, and sets neither `http.token`
  nor `masterKey`, so the configuration on a real host holds no secret either. Story 00
  delivers the key.
- `deliverToken` writes the token file on both hosts with mode `0600` through
  `writeSecretFile` semantics: `install -m 600 /dev/null <path>` first, then write. Mode
  `0600` exactly, because `src/services/config/refusals.ts` refuses anything else.
- `cli(argv)` runs on the **client** host with `--base-url http://<daemonHost>:<port>`, and
  the token reaches it as `KANTHORD_TOKEN` exported by a `kanthordc` wrapper written on the
  client host, reading the mode-`0600` token file. `src/cli/options.ts:39` already reads
  that variable. No `--token` reaches argv, and the runner's printed commands hold none.
- `deliverDirectory(role, source, name)` runs
  `scp -o BatchMode=yes -r <source> <host>:~/.kanthord-e2e-<tag>/<name>` and returns that
  path. The operator's plan directory reaches the client host through this method, so
  `KANTHORD_E2E_REAL_PLAN` is a **local** path and the client never needs it mounted.
- `assertBareMachine()` runs `test -e /etc/kanthord/config.json` on the daemon host and
  requires a non-zero exit.
- `issue` runs `node -e` on the client host reading the request JSON from **stdin**, the
  same contract as the podman issuer, so no header reaches argv.
- `startDaemon` starts `kanthord serve` on the daemon host under `nohup`, and polls
  `system.health` from the client host through `pollHealth` of Story 09.
- `identity("daemon")` and `identity("client")` run `node -e` on each host, giving two
  distinct identities that merge into one bundle.
- `collectLogs` reads the daemon stdout and stderr files from the daemon host.
- Every resource — the installed prefix on each host, the config, the token files, the
  daemon process — is taken into the ledger at creation, so `withLedger` removes the
  artifact and the configuration from both hosts on every path.

### New — `scripts/e2e/lib/scenario/p1-e3.ts`

```ts
export const p1e3: ScenarioDeclaration;
```

`{ id: "P1-E3", mode: "deployment", driver: "ssh", profile: "real", run }`.

`run(context)`:

1. **Prerequisites.** Read, in this order, and fail as `unavailable` on the first missing
   one, with the exact message given:

   | source                             | missing message                             |
   | ---------------------------------- | ------------------------------------------- |
   | `context.daemonHost`               | `P1-E3 needs --daemon-host`                 |
   | `context.clientHost`               | `P1-E3 needs --client-host`                 |
   | env `KANTHORD_E2E_REAL_ORIGIN`     | `P1-E3 needs KANTHORD_E2E_REAL_ORIGIN`      |
   | env `KANTHORD_E2E_REAL_BRANCH`     | `P1-E3 needs KANTHORD_E2E_REAL_BRANCH`      |
   | env `KANTHORD_E2E_REAL_TOKEN_FILE` | `P1-E3 needs KANTHORD_E2E_REAL_TOKEN_FILE`  |
   | env `KANTHORD_E2E_REAL_PLAN`       | `P1-E3 needs KANTHORD_E2E_REAL_PLAN`        |
   | env `KANTHORD_E2E_REAL_OBJECTIVES` | `P1-E3 needs KANTHORD_E2E_REAL_OBJECTIVES`  |
   | env `KANTHORD_E2E_REAL_TASKS`      | `P1-E3 needs KANTHORD_E2E_REAL_TASKS`       |
   | `ssh <daemonHost> true`            | `P1-E3 cannot reach the daemon host <host>` |
   | `ssh <clientHost> true`            | `P1-E3 cannot reach the client host <host>` |

   Each throws `RunnerError("unavailable", message)`. `main` writes a bundle with
   `outcome: "unavailable"` and exits `3`. **It never writes a passing bundle and it never
   skips**, because the phase exits by pointing at this bundle.

2. `createSshDriver`, then `createRealProfile(context, driver, input)` from the environment
   values above. `expectedObjectiveCount` and `expectedTaskCount` come from
   `KANTHORD_E2E_REAL_OBJECTIVES` and `KANTHORD_E2E_REAL_TASKS`, parsed as positive
   integers, because `runJourney` step 15 asserts counts and the operator's plan is not the
   two-objective fixture. `localPlanPath` is `KANTHORD_E2E_REAL_PLAN`, which
   `deliverDirectory` copies to the client host. The token file is read and
   `secrets.hold`-ed by `createRealProfile`.
   `driver.assertBareMachine()` runs before step 3.

3. `runJourney(context, driver, profile)` — the same seventeen steps as P1-E1, unchanged.

4. `noteHost("daemon", ...)`, `noteHost("client", ...)`, and the bind address into the
   bundle. `docs/proposal/phase-1/README.md:108` fixes that evidence list.

5. `assertNoDisclosure` restricted to the four non-Podman surfaces of Story 10:
   `bearer-header`, `config`, `printed-commands` and `daemon-logs`, each an absence
   assertion, plus the mode-`0600` check on the config and the token file.

The run carries no `NEEDS-HUMAN:` marker anywhere. It never enrolls a host in the VPN, never
mints or rotates a credential, and never edits host security configuration.

### Changed — `scripts/e2e/lib/main.ts`

`--daemon-host` and `--client-host` reach `ScenarioContext` as `daemonHost` and
`clientHost`. A scenario whose declaration is not `P1-E3` and that receives either flag is
refused with `RunnerError("invalid-argument", "<option> applies to P1-E3 only")`.

## Constraints

- The real profile asserts no fixture object id, no fixture hash and no fixture default
  branch. `expectedObjectIds` and `fixtureRoot` are `null`, and `runJourney` reads the
  branch and both counts from the profile.
- The seed plan is the operator's own, at `KANTHORD_E2E_REAL_PLAN`. The two-objective
  fixture of Story 04 is never used here.
- `runJourney` step 11 compares export against the **accepted** documents this import
  returned, so the real profile needs no expected bytes of its own.
- The ledger removes the artifact and the configuration from both hosts. It deletes **no**
  remote branch. Branches the run created are named in the bundle under `objectIds`, and a
  human decides — `.claude/commands/e2e.md:119-120`.
- P1-E3 is not in the EPIC 011 Proof block. It is in the EPIC 012 Proof block, line
  `node scripts/e2e/run.mjs P1-E3 --tag "$TAG" --daemon-host … --client-host …`.

## Verify

`node --test scripts/e2e/lib/driver/ssh.test.ts`

Asserts, with a fake `execute`:

- the constructed driver's key set deep-equals `driverMethodNames` (this row is part of the
  by-construction test of Story 06).
- every issued ssh argv carries `-o BatchMode=yes` and `-o StrictHostKeyChecking=yes`.
- `cli(argv)` targets `role: "client"`; `startDaemon` targets `role: "daemon"`.
- `deliverToken` issues `install -m 600 /dev/null <path>` before writing.
- after a run that failed mid-journey, `context.taken()` holds both installed prefixes, both
  token files, the config and the daemon process, so cleanup covers both hosts.
- no issued argv contains a held secret value.
- no issued argv matches `/git push .*:refs\//` or `/git push --delete/`, so the driver
  deletes no remote branch.

`node --test scripts/e2e/lib/scenario/p1-e3.test.ts`

Asserts:

- each of the ten prerequisite rows, driven one at a time, rejects with `RunnerError` code
  `unavailable` and the exact message.
- `KANTHORD_E2E_REAL_OBJECTIVES=0` and a non-numeric value each reject as `unavailable`.
- on a prerequisite failure `main` returns `3`, and the written bundle holds
  `outcome: "unavailable"` and an empty `assertions` array. It holds no `passed`.
- with every prerequisite present, `run` calls `runJourney` exactly once, and the seventeen
  journey assertion names appear in order.
- the profile handed to `runJourney` has `fixtureRoot: null` and `expectedObjectIds: null`,
  and its two counts equal the parsed environment values.
- `deliverDirectory("client", KANTHORD_E2E_REAL_PLAN, "plan")` is called exactly once, and
  `planDirectory` is what it returned.
- `main(["P1-E1", "--daemon-host", "a"])` returns `2` with the message
  `--daemon-host applies to P1-E3 only`.
- no file under `scripts/e2e/lib/` contains the text `NEEDS-HUMAN`.

`npm run verify` exits 0.

Proof: this story delivers no line of the EPIC 011 Proof block. It delivers the EPIC 012
Proof line `node scripts/e2e/run.mjs P1-E3 --tag "$TAG" --daemon-host … --client-host …`,
and the EPIC 011 closing statement "The phase exits by pointing at a P1-E3 bundle."
