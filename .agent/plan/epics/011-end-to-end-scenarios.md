# EPIC 011 — End-to-end scenarios

Status: **draft**.

## Goal

The packaged binary, the configuration discovery, the daemon lifecycle and the CLI-to-HTTP wiring are proven connected. P1-E1, P1-E2, P1-E4 and P1-E3 run through `scripts/e2e/run.mjs` and write evidence bundles.

## Non-goals

- No assertion that restates a `node:test` case at the same level. A scenario asserts a rule against the packaged binary and the running daemon, which is a different subject from the middleware or the handler that `node:test` covers. A scenario that re-tests a pure function is deleted, because it is a second specification that drifts.
- No live mode and no provider account. Phase 1 scenarios are `deterministic`, except P1-E3, which is `deployment`.
- No VPN simulation. Podman proves the two-host **logic**. `docs/proposal/README.md` says `deployment` mode proves the environment rather than the logic, so a container pair never substitutes for P1-E3.

## Stories

- **The `http.tokenFile` key** — the daemon takes its bearer token from a file, exactly as it
  already takes its master key from `masterKeyFile`. `http.token` is the only way to
  configure a token today, so every deployment writes the secret into its configuration
  file, and a container run has nowhere to put it that a config dump does not disclose. The
  key mirrors `masterKeyFile` in every respect: the two are mutually exclusive, the file
  must be mode `0600`, and the resolved token is what reaches `Settings`, so no consumer of
  the configuration changes. This is what lets the secret-handling story assert the token is
  absent from the config file rather than merely redacted in it.
- **The runner** — `scripts/e2e/run.mjs <id>`, with setup, invocation, assertion, cleanup, and every underlying command printed so a human reproduces any step by hand. One runner, not one script per scenario. It takes `--tag <tag>`, which names the run directory and every bundle path, so several invocations of one acceptance run write into one place. A reused tag is refused. With no `--tag` the runner mints one.
- **Cleanup is central** — the runner releases every resource it took, in a `finally` and on `SIGINT` and `SIGTERM`. A temporary home, a daemon process, a held home lock and a labelled container are each released by the runner, never by prose in a scenario. A scenario declares what it took; it never carries its own teardown path, because a teardown restated per scenario is a teardown that one scenario forgets.
- **The evidence bundle** — the scenario id and schema version, the commit under test, the timestamp and host identity, the daemon and CLI versions, the fixture hashes, the pinned `git` version, the object ids involved, every assertion result, and sanitized logs.
- **P1-E1 — the onboarding journey** — start from a bare machine: prove the daemon binary with no config file at any discovered location exits non-zero and names the search order, prove a config file at the first discovered location starts it, and prove the daemon binary and the CLI binary report one version. EPIC 001 declares the search order and no unit test proves it through the packaged artifact. Then register a credential, register the fixture remote with `--upstream`, create a project, bind the repository to it, import the two-objective fixture into that project, export byte-identical, re-import at the same revision and at the previous one, read status, and confirm `kanthord run` exits non-zero with `not-implemented` and leaves status unchanged. The project and the binding are steps rather than setup: every plan route is `/v1/project/:id/plan/...`, and import rejects an objective whose repository is not bound to its project.
- **P1-E2 — the hostile client** — direct HTTP against the running daemon. No token is `401`, a wrong token is `401`, an `Origin` header is `403`, a `Host` outside the allow list is `403`, an allowed `Host` is `200`, and the daemon refuses to start on a non-loopback address with no token. The token is redacted in the evidence. P1-E2 runs locally and stays the mandatory baseline, because Podman may not exist on every environment that must gate. P1-E4 re-runs the cases that a separate network namespace makes more representative, from this one oracle. Two independent oracle specifications for one policy is the thing being avoided.
- **Two axes: the execution driver and the scenario profile** — the runner separates _where a step runs_ from _what the step is given_. The **execution driver** covers command execution on each host, binary and configuration delivery, token delivery, daemon start and stop, log collection, and the merge of two hosts into one bundle; `podman` and `ssh` implement it. The **scenario profile** covers the origin, the credential, the expected default branch and the evidence requirements; P1-E4 takes the fixture profile and P1-E3 takes the real-repository profile. The journey code and the public-surface assertions are shared. P1-E3 is not P1-E4 with a flag flipped: it onboards a real repository with a real credential, so fixture object ids, fixture hashes and the fixture default branch do not transfer.
- **The P1-E4 topology** — three containers, two network namespaces:
  - a **pod** holding the fixture-remote container and the daemon container, which share one network namespace. The fixture listens on `127.0.0.1:<fixture-port>`, so the daemon reaches it over loopback and `docs/proposal/phase-1/git-foundation.md` accepts the plain-HTTP url. That rule is "a product rule with a public reason, not a test exception", so it is satisfied rather than relaxed, and the daemon image stays single-purpose with one process.
  - a **client container** holding the CLI only, with no daemon volume and no access to the daemon file system.
  - the daemon binds `0.0.0.0:<port>` and answers to the stable network alias `kanthord-daemon`, never a discovered container IP. The `Host` allow list is exactly `kanthord-daemon:<port>`, because the CLI resolves by that alias and an allow list left at `127.0.0.1` returns `403 host-forbidden` on every call.
  - the daemon home is a **named Podman volume** mounted only into the daemon container. A macOS bind mount reaches the Linux VM over virtiofs and reports a FUSE filesystem, which the EPIC 001 network-filesystem refusal is entitled to reject. The product's own filesystem check stays the authority; the scenario does not assume a volume is local, it lets the daemon decide.
- **P1-E4 — the two-namespace run** — mode `deterministic`. `scripts/e2e/run.mjs P1-E4` runs the P1-E1 journey with the client and the daemon in separate network namespaces. The daemon binds a non-loopback address, so a token is mandatory and the EPIC 001 startup refusal is exercised across a real network boundary. The client cannot read the daemon file system, so the ref layout is asserted through `repository show`. It also carries the transport cases of P1-E2 that only a separate namespace makes representative, and it restates none of P1-E2's oracle: one specification, exercised from a second place.
- **P1-E4 hermeticity** — five rules, because a container run is ambient state unless each is closed:
  - **No outbound network.** An internal Podman network with no external route, and `--pull=never`. A user-defined network is not by itself offline, and a "deterministic" gate that reaches a registry, a DNS server or a package mirror is not deterministic.
  - **Images are provisioned, never pulled.** A preceding gate step builds the product artifact and the image once from the commit under test; the scenario consumes the local content-addressed id. The bundle records the product artifact digest, the base image digest and the architecture, separately. An `arm64` pass is not evidence for another architecture.
  - **Podman is a provisioned prerequisite, exactly like the `git` binary of EPIC 005.** The runner checks reachability and version, records rootless or rootful mode and the architecture, and fails loudly with an actionable message. It never runs `podman machine start`: starting a global VM inside a phase gate is slow, stateful and hostile to a developer working beside it.
  - **Every resource carries a run id label**, and cleanup is by label rather than by name, so two runs never collide. Cleanup runs on the failure path as well as the success path. A killed VM leaves its labelled resources behind, and **an explicit `--reclaim <tag>` invocation removes them**. Recovery is manual and deliberate: a scenario run reclaims its own tag only, because it cannot tell a stale run from a live concurrent one, and reclaiming by label prefix would kill a run in progress. "Nothing remains after a crash" is not achievable and is not claimed; "an operator has one command that cleans up after one" is.
  - **A reclaim reports what it did, per resource kind, and a pre-run reclaim fails closed.** Cleanup on a dying run is best effort, because the run is already lost. A reclaim _before_ a run is different: a targeted resource that survives removal contaminates the run that follows it, so the runner refuses to continue. A removal command that exits zero is not proof, so absence is verified by re-listing the label.
  - **Readiness is polled, never slept.** The runner polls `system.health` to a bounded deadline and keeps diagnostics on timeout. Health needs no token and still answers to the `Host` and `Origin` checks, so the poll carries the right `Host`.
- **Secret handling in a container run** — the token reaches a container as a mounted file with restrictive permissions, never an environment variable and never an argument. `podman inspect`, a process listing and the runner's own promise to print every command would each disclose it otherwise. Redaction is asserted over the bearer header, the fixture Basic-auth header, the config file, the printed commands, the daemon logs, the Podman inspect output and the failure diagnostics.
- **P1-E3 — the VPN run** — mode `deployment`, `ssh` driver, real-repository profile. The CLI on one real host and the daemon on another, across the VPN, with a real credential. It proves the environment: routing, binding and token distribution. `docs/proposal/README.md` says of this mode that "a coding agent runs it when it has access to both hosts; that is a prerequisite, not a reason to call the scenario human-only", so it carries no `NEEDS-HUMAN:` marker. "Human action: none" means none once the prerequisites exist: the runner never enrolls a host in the VPN, never mints or rotates a real credential, and never edits host security configuration. A missing prerequisite makes P1-E3 fail as unavailable. It must never skip and write a passing bundle, because the phase exits by pointing at this bundle.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node scripts/e2e/run.mjs P1-E1 && node scripts/e2e/run.mjs P1-E2 \
  && node scripts/e2e/run.mjs P1-E4 \
  && echo "PASS EPIC-011"
```

Hermetic coverage required beyond the Proof:

- P1-E4 leaves no container, no pod, no Podman network and no volume carrying its run id, after a failing run as well as a passing one.
- `node scripts/e2e/run.mjs --reclaim <tag>` removes every resource labelled with that tag, reports the outcome per kind, and a subsequent P1-E4 run under a fresh tag passes. The reclaim invocation writes no evidence bundle and claims no bundle directory, because it runs no scenario and asserts nothing about the product.
- A pre-run reclaim that cannot remove a targeted resource fails the run before the run starts, and names the kind and the id it could not remove.
- The daemon refuses to start when it binds a non-loopback address with no token configured, which is the EPIC 001 rule proved across a real network boundary.
- An allow list that does not name the daemon alias produces `403 host-forbidden`, so the allow list is proved to be load-bearing rather than incidental.
- The `podman` and `ssh` drivers expose one interface, asserted by construction. The scenario profile is the other axis, so a driver swap never silently changes what a scenario claims.
- The token appears in no `podman inspect` output, no printed command, no config dump and no log, asserted over a deliberately failing run as well as a passing one. Every one of those is an **absence** assertion, so each one carries a non-empty secret registry as a precondition and refuses when the registry is empty. An absence asserted over an empty set is a vacuous pass, and this EPIC produced one for a full cycle.
- A configured token **file** is not a configured token. Every startup refusal that asks whether a token exists reads the resolved value, so a mode-`0600` empty token file refuses a non-loopback bind exactly as an absent token does. The EPIC 001 rule is about the secret, never about the path.
- Podman absent, stopped, or below the pinned version fails the gate loudly and names the remedy. It never skips.

P1-E3 needs two reachable hosts, a real repository and a real credential. Podman proves the two-host logic and the deployment mechanism, never the environment, so a P1-E4 pass is not evidence for P1-E3. The phase exits by pointing at a P1-E3 bundle.
