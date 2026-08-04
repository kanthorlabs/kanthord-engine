# Story 03 — HTTP fixture remote

Epic: `.agent/plan/epics/005-test-infrastructure.md`
Depends on: Story 01 (`resolveTools`), Story 02 (`seedRepositories`).

## Change

Create `test/helpers/remote/http.ts`. It runs `node:http` in front of
`git http-backend` on a loopback port, checks Basic authentication **in front of**
the CGI, and exposes the credential matrix.

Exports, exactly:

```ts
export type FixtureCredential = Readonly<{
  username: string;
  token: string;
  write: boolean;
}>;

export type HttpRemote = Readonly<{
  transport: "http-basic";
  port: number;
  origin: string;
  url(repository: string): string;
  authenticatedUrl(repository: string, credential: FixtureCredential): string;
  seed: SeedRoot;
  credentials: Readonly<Record<"reader" | "writer", FixtureCredential>>;
  wrongCredential: FixtureCredential;
  requestLog(): readonly HttpRequestRecord[];
  cgiSpawnCount(): number;
  dispose(): Promise<void>;
}>;

export type HttpRequestRecord = Readonly<{
  method: string;
  path: string;
  status: number;
  username: string | null;
  headers: Readonly<Record<string, string>>;
  spawnedCgi: boolean;
}>;

export const httpCredentials: Readonly<
  Record<"reader" | "writer", FixtureCredential>
>;
export const httpWrongCredential: FixtureCredential;
export const httpAcceptanceChecks: readonly {
  name: string;
  run(subject: HttpRemote): Promise<void> | void;
}[];

export function startHttpRemote(
  tools: Tools,
  seed: SeedRoot,
): Promise<HttpRemote>;
```

`httpAcceptanceChecks` is typed **structurally** and this file imports nothing
from `acceptance.ts`. TypeScript is structurally typed, so the array is assignable
to `readonly AcceptanceCheck<HttpRemote>[]` in Story 05 with no import and no
declaration merging. This is what keeps the dispatch order `03 → 05` honest: a
nominal import of `AcceptanceCheck` would make Story 03 uncompilable until Story
05 landed, inverting the order.

Fixed credentials:

```ts
export const httpCredentials = {
  reader: { username: "reader", token: "r-tok", write: false },
  writer: { username: "writer", token: "w-tok", write: true },
} as const;

export const httpWrongCredential = {
  username: "writer",
  token: "bad-tok",
  write: false,
} as const;
```

### The authorization rule

Decide on the request before spawning the CGI. A request is a **write** request
when `pathname` ends with `/git-receive-pack`, or `searchParams.get("service")`
is `"git-receive-pack"`.

- A **read** request is always served, with any credential or none.
  `docs/proposal/open-items.md:15` records that a public repository serves the
  `git-upload-pack` advertisement to a garbage token, to a good token and to no
  credential alike. The fixture reproduces that, because it is the case the
  write-advertisement preflight exists to catch.
- A **write** request is served only when the `Authorization` header carries a
  Basic credential whose username is known and whose token matches **and** whose
  `write` is true. Every other case — no header, an unknown username, a wrong
  token, or a read-only credential — answers `401` with
  `WWW-Authenticate: Basic realm="kanthord-fixture"` and the body
  `"unauthorized\n"`, and **never spawns the CGI**.

The token compare is a plain string compare. This is a fixture, not the daemon.

### The CGI bridge

Spawn `tools.httpBackend` with `stdio: ["pipe", "pipe", "pipe"]` and this
environment, which is the whole environment — nothing is inherited:

```
PATH                 tools.execPath
LC_ALL               C
GIT_PROJECT_ROOT     seed.path
GIT_HTTP_EXPORT_ALL  1
GIT_CONFIG_GLOBAL    /dev/null
GIT_CONFIG_SYSTEM    /dev/null
GIT_CONFIG_NOSYSTEM  1
GIT_TERMINAL_PROMPT  0
REQUEST_METHOD       req.method
PATH_INFO            url.pathname
QUERY_STRING         url.search without the leading "?"
CONTENT_TYPE         req.headers["content-type"] ?? ""
CONTENT_LENGTH       req.headers["content-length"] ?? ""
REMOTE_USER          the authenticated username, or ""
REMOTE_ADDR          127.0.0.1
SERVER_PROTOCOL      HTTP/1.1
GATEWAY_INTERFACE    CGI/1.1
```

Pipe `req` into `child.stdin`. Parse the CGI response by buffering
`child.stdout` until the first `\r\n\r\n`; split the head on `\r\n`, and for each
line split on the first `": "`. A `Status` header supplies the numeric status
(default `200`) and is **not** forwarded; every other header is forwarded
verbatim. Write the remainder of the buffer, stream the rest, and `res.end()` on
`child.stdout` `"end"`. Forward `child.stderr` nowhere — collect it into a
per-request string and, on a non-zero exit, append it to the request log.

`requestLog()` returns one `HttpRequestRecord` per request in arrival order.
`headers` is the request's own headers, lower-cased, so the hostile-`HOME`
assertion reads them directly. `spawnedCgi` is false on every refused write.
`cgiSpawnCount()` is a counter incremented at the `spawn` call site and nowhere
else — a refused request must never increment it. The record is a structured
object rather than a formatted string, because the header assertion and the
spawn-count assertion both need fields, and a string would force one of them to be
parsed back out.

`listen(0, "127.0.0.1")` and read `server.address().port`. `origin` is
`` `http://127.0.0.1:${port}` ``. `url(repository)` is `` `${origin}/${repository}` ``.
`authenticatedUrl(repository, credential)` is
`` `http://${credential.username}:${credential.token}@127.0.0.1:${port}/${repository}` ``.

`dispose()` closes the server, awaits `"close"`, and kills any live CGI child with
`SIGKILL`.

### The acceptance check list

`httpAcceptanceChecks` is exactly these four rows, in this order. Each is an
`AcceptanceCheck<HttpRemote>` from Story 05 — `{ name, run }`, where `run` throws
to fail.

1. `"http: HEAD symref discovery"` — `git ls-remote --symref <url> HEAD` reports
   `ref: refs/heads/main\tHEAD` and the object id
   `251c92d5a215053aea80432f179653f99072835d`.
2. `"http: fetch writes the tracking ref"` — in a throwaway `git init --template=`
   repository, fetch `+refs/heads/*:refs/remotes/origin/*` with `--no-tags
--prune`; `refs/remotes/origin/main` is `251c92…835d`, there is no
   `refs/heads/*`, and there is no `refs/tags/*`.
3. `"http: receive-pack refuses a missing and a wrong credential"` — a plain
   `fetch` of `info/refs?service=git-receive-pack` with no `Authorization` is
   `401`, with `httpWrongCredential` is `401`, and with `credentials.reader` is
   `401`.
4. `"http: receive-pack admits a write credential"` — the same request with
   `credentials.writer` is `200` and the body begins
   `"001f# service=git-receive-pack\n"`.

## Constraints

- Authentication is checked before the CGI is spawned. A refused write request
  must leave no child process and no change on the fixture.
- The fixture serves the seeded root as `GIT_PROJECT_ROOT`; it never takes a path
  from the request beyond `PATH_INFO`, and it never joins a caller-supplied
  absolute path.
- No dependency is added. `node:http`, `node:child_process` and `node:buffer`
  only. `supertest` is not used — the client under test is the real `git` binary.
- `startHttpRemote` returns an **unchecked** handle. The gate that withholds it
  belongs to Story 05, and this file must not call `runAcceptance` itself.

## Verify

`node --test test/helpers/remote/http.test.ts`, asserting exactly:

- `port` is a number above 1024 and `origin` is `` `http://127.0.0.1:${port}` ``.
- **The credential matrix**, as four exact status codes against
  `info/refs?service=git-receive-pack` using `fetch`: no header `401`,
  `httpWrongCredential` `401`, `credentials.reader` `401`, `credentials.writer`
  `200`.
- **Read is public**: `info/refs?service=git-upload-pack` is `200` with no header,
  `200` with `httpWrongCredential`, and `200` with `credentials.reader`. This is
  the assertion that pins the read-only-credential case of EPIC 007.
- **A refused write request spawns no CGI**: `cgiSpawnCount()` is `0` after the
  three refused matrix requests, and every `requestLog()` record for them has
  `spawnedCgi === false`.
- **A refused write request changes nothing on the fixture**: snapshot the full ref
  state with `seed.git("fixture.git", ["for-each-ref", "--format=%(refname) %(objectname)"])`
  **and** the object count with `["count-objects", "-v"]` before the matrix and
  again after, and `assert.equal` both strings. A single `refs/heads/main` check
  proves only that one ref held still. Scope the claim to refs and object storage;
  the fixture's own `config` is written once at seed time and is out of scope.
- **A real fetch**: `git fetch --no-tags --prune` from a throwaway repository
  against `authenticatedUrl("fixture.git", credentials.reader)` exits 0;
  `for-each-ref` then lists `refs/remotes/origin/HEAD` and
  `refs/remotes/origin/main`, both `251c92…835d`, and lists **no** ref matching
  `/^refs\/heads\//` and **no** ref matching `/^refs\/tags\//`.
- `git ls-remote --symref` reports `ref: refs/heads/main` for `HEAD`.
- **The hostile-`HOME` assertion**: run the fetch with `HOME` set to a `mkdtemp`
  directory holding a `.gitconfig` that sets
  `[http]\n\textraHeader = X-Hostile: yes\n` and
  `[credential]\n\thelper = /nonexistent/helper\n`. The fetch still exits 0, and no
  record in `requestLog()` has an `x-hostile` key in `headers`. Assert the control
  too: with the same `HOME` and **without** `GIT_CONFIG_GLOBAL=/dev/null`, a
  request does carry `x-hostile`, so the pin is proved load-bearing rather than
  vacuous.
- `httpAcceptanceChecks` has length 4, and its `name` values are the four exact
  strings above in that order.
- Every check in `httpAcceptanceChecks` passes when run against a live handle,
  asserted by awaiting each `run` and expecting no throw.
- `dispose()` resolves, and a `fetch` to `origin` afterwards rejects.

`npm run verify` exits 0.

Proof: contributes to `PASS EPIC-005`. Delivers the coverage lines "The
receive-pack advertisement answers `401` with no credential and with a wrong one,
and it changes nothing on the fixture" and "A fetch over the HTTP fixture writes
`refs/remotes/origin/*` and no `refs/heads/*`, and `--no-tags` leaves
`refs/tags/*` empty against a tagged fixture repository".

## Measured facts

- `git-http-backend` is at `` `${git --exec-path}/git-http-backend` ``, not on
  `PATH`. Story 01 resolves it.
- The seeded repository needs `http.receivepack=true` for the receive-pack
  advertisement. Story 02 sets it.
- A fetch writes `refs/remotes/origin/HEAD` **as well as**
  `refs/remotes/origin/main`. Both are under `refs/remotes/origin/*`, so the
  epic's coverage line holds, but an assertion that expects exactly one tracking
  ref fails.
- The receive-pack advertisement body begins with the literal
  `001f# service=git-receive-pack\n`, measured against this fixture.
- The CGI writes `Status:` only on an error; a success carries no `Status` header,
  which is why the default is `200`.
