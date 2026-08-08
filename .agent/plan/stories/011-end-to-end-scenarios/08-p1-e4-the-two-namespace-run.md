# Story 08 — P1-E4, the two-namespace run

Epic: `.agent/plan/epics/011-end-to-end-scenarios.md`
Depends on: Story 00, Story 04, Story 05, Story 07, Story 09, Story 10.

Oracle: `docs/proposal/phase-1/README.md:89-98`. This story restates none of it.

## Change

### New — `scripts/e2e/lib/driver/podman-issuer.ts`

```ts
export function podmanIssuer(
  execute: PodmanExecutor,
  clientContainer: string,
  baseUrl: string,
): HttpIssuer;
```

It runs `podman exec --interactive <clientContainer> node /opt/e2e/bin/e2e-request.mjs`
and writes the request as JSON **on stdin**, then reads `<status>\n<body>` from stdout.

**The request never reaches argv.** A bearer header in `process.argv` would be visible in a
process listing and would contradict Story 10. The request also never reaches an environment
variable, and `curl` is never used, because a shell-quoted header is a redaction hazard and
the image ships no `curl`.

`e2e-request.mjs` is a fixed file in the product image. It reads stdin, calls
`node:http.request`, honours `omitHost` through `request.removeHeader("host")` — the same
mechanism `localIssuer` uses — and prints the status and the body.

### New — `scripts/e2e/lib/scenario/p1-e4.ts`

```ts
export const p1e4: ScenarioDeclaration;
```

`{ id: "P1-E4", mode: "deterministic", driver: "podman", profile: "fixture", run }`.

`run(context)` executes exactly these phases, in order:

1. **Preflight** — `assertPodman(execute)` from Story 09. A failure throws
   `RunnerError("unavailable", ...)` and `main` exits `3`.
2. **Reclaim** — `reclaimByLabel(execute, context.tag)` from Story 09, before anything is
   created.
3. **Provision** — `provisionImages(execute, context.tag)` from Story 09, returning the two
   content-addressed image ids and the digests.
4. **Topology** — `planTopology(context.tag)` then `createTopology(...)` from Story 07.
5. **Identity and versions** — `driver.identity("daemon")` and `driver.identity("client")`
   into `noteHost`; the Podman version into `versions.podman`; `productDigest`,
   `baseDigest`, `imageId`, `architecture` and `podmanRootless` into `notes`.
   `docs/proposal/phase-1/README.md:98` fixes that list.
6. **The startup refusal, across the boundary** — start the daemon process with
   `http.bind: "0.0.0.0"` and `http.token: ""`, and assert exit `1` with the exact line
   `kanthord: config-refused: a non-loopback bind address requires http.token`. Assertion
   names `startup-refusal-exit` and `startup-refusal-message`, the same names Story 05 uses,
   because it is the same rule.
7. **The load-bearing allow list** — start the daemon process with a token and
   `http.allowedHosts: ["127.0.0.1:7421"]`, omitting the alias. Issue one `GET /v1/status`
   through `driver.issue` with a valid token and `Host: kanthord-daemon:7421`. Assert status
   `403` and code `host-forbidden`. Assertion names `alias-omitted-status` and
   `alias-omitted-code`. Stop the daemon process.
8. **The journey** — start the daemon process with
   `http.allowedHosts: ["kanthord-daemon:7421"]` and call
   `runJourney(context, driver, profile)` from Story 04. Every step runs from the client
   container.
9. **The transport oracle** — call
   `runTransportCases(context, target, driver.issue)` from Story 05, against the running
   daemon. All six rows run, from the client namespace. No row is filtered.
10. **Logs** — `driver.collectLogs()` into the bundle, redacted.
11. **Disclosure** — `assertNoDisclosure(...)` from Story 10, invoked from a `finally`
    around phases 5 to 10, so a run that failed mid-journey still proves no disclosure.

Phases 6, 7 and 8 start and stop the daemon **process** inside the one daemon container
created in phase 4, per the `sleep infinity` entrypoint rule of Story 07.

### Changed — `scripts/e2e/lib/scenario/p1-e2.ts`

Pass `driver.issue`, which for the `local` driver is `localIssuer`. No other change.

## Constraints

- Phase 9 imports `transportCases` from `scripts/e2e/lib/scenario/transport.ts` and runs it
  whole. It defines no case, and it filters none. A literal status code in `p1-e4.ts` is a
  defect.
- Phase 8 calls `runJourney` unchanged. P1-E4 adds no journey step and removes none. The ref
  layout is asserted through `repository show`, which `runJourney` step 7 already does,
  because the client cannot read the daemon file system.
- The run id is `context.tag`. One label value identifies every resource of one run, and
  Story 09 reclaims by that label.
- No argv issued by this story contains a token, a request body, or a request header.

## Verify

`node --test scripts/e2e/lib/scenario/p1-e4.test.ts`

Asserts, against a fake `PodmanExecutor` and a fake `HttpIssuer`:

- `run` executes the eleven phases in order, asserted over an ordered recorder array.
- preflight runs before reclaim, and reclaim runs before the first `podman network create`.
- phase 7 sends `http.allowedHosts: ["127.0.0.1:7421"]` and phase 8 sends
  `["kanthord-daemon:7421"]` — read off the configs handed to the driver.
- phase 9 issues exactly six requests, in `transportCases` order.
- the assertion names recorded across the whole run deep-equal this exact array: the two
  refusal names, the two alias names, the seventeen journey names of Story 04, the
  eleven transport names of Story 05, then the eight `no-disclosure-*` names of Story 10 in
  `disclosure.ts` declaration order — **forty** in total. Phase 11 runs in a `finally`, so
  its eight names are part of every run, failing or passing.
- a fake issuer answering `200` in phase 7 makes `run` reject with `assertion-failed`
  naming `alias-omitted-status`.
- a preflight failure makes `run` reject with `RunnerError` code `unavailable`, and no
  `podman network create`, `podman build` or `podman run` command was issued.
- a fake run that fails in phase 8 still executes phase 11 — asserted over the phase
  recorder. This is the EPIC's "asserted over a deliberately failing run as well as a
  passing one".
- no recorded argv contains any value held by the secret registry.

`node --test scripts/e2e/lib/driver/podman-issuer.test.ts`

- `podmanIssuer` issues `podman exec --interactive <client> node /opt/e2e/bin/e2e-request.mjs`
  and nothing else; the request JSON is written to the child's stdin, and the recorded argv
  contains no `{`, no header name and no token.
- driving `localIssuer` and `podmanIssuer` against a recording target with the same
  `TransportCase` produces the same header set and the same `omitHost` behaviour. This is
  what makes phase 9 the same oracle rather than a second one.

`npm run verify` exits 0.

Proof: `node scripts/e2e/run.mjs P1-E4`, the third line of the EPIC Proof block. It also
delivers two EPIC coverage lines: "The daemon refuses to start when it binds a non-loopback
address with no token configured, which is the EPIC 001 rule proved across a real network
boundary", and "An allow list that does not name the daemon alias produces
`403 host-forbidden`".
