# Story 01 — Fixture remote

Epic: `.agent/plan/epics/005-test-infrastructure.md`
Depends on: EPIC 004 (sequence order). No file from EPIC 004 is edited.

Three new modules under `test/helpers/remote/`, and their three co-located tests. Story 02 composes them into the acceptance gate and owns every assertion that names an acceptance-list row.

## Change

### 1. `test/helpers/remote/git-binary.ts` (new)

```ts
export type GitBinary = Readonly<{
  path: string;
  version: string;
  httpBackend: string;
}>;

export class MissingGitBinaryError extends Error {
  readonly binary: string;
}

export function resolveGitBinary(binary?: string): GitBinary;
```

`binary` defaults to `"git"`.

1. Run `execFileSync(binary, ["--version"], { encoding: "utf8" })`. Trim the result into `version`.
2. Run `execFileSync(binary, ["--exec-path"], { encoding: "utf8" })`. Trim the result. Join `"git-http-backend"` onto it into `httpBackend`.
3. Return `{ path: binary, version, httpBackend }`.

Throw `MissingGitBinaryError` in two cases, and in no other:

- `execFileSync` throws with `code === "ENOENT"`. Message: `` `the git binary ${binary} is not on PATH; the test suite requires it` ``.
- `existsSync(httpBackend)` is false. Message: `` `${binary} has no git-http-backend at ${httpBackend}` ``.

Set `binary` on the error instance. Re-throw any other error unchanged.

`MissingGitBinaryError` is a throw and never a skip. `.agent/plan/epics/005-test-infrastructure.md:32` requires the absent binary to fail loudly, so no code path in this directory calls `test.skip`, reads `SKIP`, or returns a sentinel.

Discover `httpBackend` through `--exec-path`. Never hard-code a directory. Measured on this machine: `git --exec-path` is `/Applications/Xcode.app/Contents/Developer/usr/libexec/git-core`, which no fixed path predicts.

### 2. `test/helpers/remote/seed.ts` (new)

```ts
export type FixtureCommit = Readonly<{
  message: string;
  files: Readonly<Record<string, string>>;
}>;

export type SeedRepositoryInput = Readonly<{
  root: string;
  name: string;
  branch: string;
  commits: readonly FixtureCommit[];
}>;

export type SeededRepository = Readonly<{
  gitdir: string;
  name: string;
  branch: string;
  oids: readonly string[];
}>;

export function seedRepository(
  input: SeedRepositoryInput,
): Promise<SeededRepository>;

export type WriteFixtureCommitInput = Readonly<{
  gitdir: string;
  commit: FixtureCommit;
  parents: readonly string[];
  index: number;
}>;

export function writeFixtureCommit(
  input: WriteFixtureCommitInput,
): Promise<string>;
```

Both build objects with `isomorphic-git` only. The `git` binary serves the repository; it never creates one. A work tree is never created, and `git commit` is never run.

`writeFixtureCommit`:

1. Sort `Object.keys(commit.files)` with `Buffer.compare` over the UTF-8 bytes of each name. Bytewise, per `AGENTS.md`.
2. For each name in that order, `writeBlob` the file content as a UTF-8 `Buffer`, and collect `{ mode: "100644", path, oid, type: "blob" }`.
3. `writeTree` that array.
4. Build `who` as `{ name: "fixture", email: "fixture@kanthord.test", timestamp: 1577836800 + index * 86400, timezoneOffset: 0 }`.
5. `writeCommit` with that tree, `parent: [...parents]`, `author: who`, `committer: who`, and the message. Append `"\n"` to the message when it does not already end in one.
6. Return the commit oid.

`1577836800` is `2020-01-01T00:00:00Z`. The author, the committer, the timestamp base, the daily step and the zero timezone offset are all fixed, so a commit oid is a function of its content and its index alone. `AGENTS.md` requires a test to assert a value and never "some value", and these constants are what make the oids below exact.

`seedRepository`:

1. `gitdir = join(root, name)`.
2. `init({ fs, bare: true, gitdir, defaultBranch: branch })`.
3. Fold `commits` in order. Call `writeFixtureCommit` with `index` as the array index and `parents` as the previous oid, or `[]` for the first. Collect every oid.
4. `writeRef` `refs/heads/<branch>` to the last oid, with `force: true`.
5. `writeRef` `HEAD` to `refs/heads/<branch>`, with `force: true` and `symbolic: true`.
6. Return `{ gitdir, name, branch, oids }`.

Pass `gitdir`, never `dir`. `isomorphic-git` resolves `dir` to `<dir>/.git`, so a bare repository addressed by `dir` fails with `NotFoundError: Could not find HEAD.` The seeding block at `docs/proposal/phase-1/git-foundation.md:30-38` writes `dir`, and that block is prose rather than a working call. Every call in this directory passes `gitdir`.

### 3. `test/helpers/remote/server.ts` (new)

```ts
export type FixtureRequest = Readonly<{
  method: string;
  path: string;
  authenticated: boolean;
  status: number;
}>;

export type FixtureRemote = Readonly<{
  url: string;
  port: number;
  username: string;
  token: string;
  root: string;
  gitVersion: string;
  requests(): readonly FixtureRequest[];
  close(): Promise<void>;
}>;

export type StartFixtureRemoteInput = Readonly<{
  root: string;
  token?: string;
  username?: string;
  port?: number;
  gitBinary?: string;
}>;

export function startFixtureRemote(
  input: StartFixtureRemoteInput,
): Promise<FixtureRemote>;
```

Defaults: `token` is `"fixture-token"`, `username` is `"kanthord-bot"`, `port` is `0`, `gitBinary` is `"git"`.

1. Call `resolveGitBinary(input.gitBinary)` first, before `createServer`. An absent binary therefore rejects `startFixtureRemote` and never produces a listening server that fails one request at a time.
2. `http.createServer` with the handler below.
3. `server.listen(port, "127.0.0.1")`. Read the real port from `server.address()`. `0` binds an ephemeral port, which is what lets tests run in parallel.
4. `url` is `` `http://127.0.0.1:${port}` ``. A repository url is `` `${url}/${name}` ``.
5. `close()` calls `server.closeAllConnections()`, then resolves when `server.close()` calls back. Both are needed: `close()` alone waits for a keep-alive socket and hangs the suite.

Handler, in this order:

1. `const url = new URL(request.url, "http://127.0.0.1")`.
2. `authenticated` is `request.headers.authorization !== undefined`.
3. A request is a **receive-pack** request when `url.pathname` ends with `/git-receive-pack`, or when `url.searchParams.get("service") === "git-receive-pack"`. A request is a **receive-pack POST** when `request.method === "POST"` and `url.pathname` ends with `/git-receive-pack`.
4. On a receive-pack request only, compare `request.headers.authorization` against `` `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}` ``. On a miss, record the request with status `401`, and answer `401` with header `WWW-Authenticate: Basic realm="kanthord fixture"`, `Content-Type: text/plain`, and body `"unauthorized\n"`. Return without spawning the backend.
5. On a receive-pack POST that passed step 4, answer `403` with `Content-Type: text/plain` and body `"push is phase 2\n"`. Return without spawning the backend. **The credential check comes first**, so a POST with no credential still reports `401` and a push is never the reason a caller learns the token is wrong.
6. Every other request reaches the backend with no credential check.
7. Spawn `httpBackend` with `stdio: ["pipe", "pipe", "pipe"]` and exactly this environment:

```ts
{
  PATH: process.env.PATH,
  GIT_PROJECT_ROOT: root,
  GIT_HTTP_EXPORT_ALL: "1",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  REQUEST_METHOD: request.method,
  PATH_INFO: url.pathname,
  QUERY_STRING: url.search.replace(/^\?/, ""),
  CONTENT_TYPE: request.headers["content-type"] ?? "",
  REMOTE_USER: username,
  REMOTE_ADDR: "127.0.0.1",
}
```

Add `CONTENT_LENGTH` from the `content-length` header only when that header is present. Add nothing else.

The four `GIT_CONFIG_*` and `GIT_TERMINAL_PROMPT` entries are required by the `AGENTS.md` hermeticity rule — "no ambient `git` configuration". Replacing `process.env` with a small map does not disable system or global configuration; `git` reads `/etc/gitconfig` and `~/.gitconfig` from its own defaults. These variables disable both, and stop the backend blocking on a credential prompt.

8. `request.pipe(child.stdin)`.
9. Buffer `child.stdout` until the first `\r\n\r\n`. Parse the bytes before it as CGI headers, one per `\r\n`, split on the first `:`. A `Status` header supplies the status code as `parseInt(value.slice(0, 3), 10)`; the default is `200`. Every other header passes through unchanged. Write the head, then the bytes after the separator, then stream the rest of `child.stdout` unbuffered.
10. On `close` with no head emitted, answer `500` with `Content-Type: text/plain` and body `` `backend exit ${code}\n${stderr}` ``. Otherwise call `response.end()`.
11. Record one `FixtureRequest` per request: the method, `url.pathname + url.search`, `authenticated`, and the status written.

`close()` is idempotent. Track a `closed` flag; a second call resolves immediately and never calls `server.close()` twice. A test registers `after(() => remote.close())` and may also close inside the test body.

`requests()` returns the recorded array. It records **whether** a credential arrived and never the header value. `.agent/plan/epics/011-end-to-end-scenarios.md:35` asserts redaction over the fixture Basic-auth header, so the fixture never holds it in a readable log.

`GIT_HTTP_EXPORT_ALL: "1"` is required. Measured: without it, and with no `git-daemon-export-ok` file in the bare repository, `git http-backend` answers `404` with an empty body for every path.

The token compare is plain equality, not `timingSafeEqual`. The `AGENTS.md` constant-time rule covers the daemon's own bearer token, fixed by `docs/proposal/phase-1/transport.md:17`. This fixture models a forge, and it is not a product surface.

## Constraints

- Authenticate **receive-pack only**. `git-upload-pack` is served to every caller, with a token, with a wrong token and with none. `docs/proposal/open-items.md:15` records the measured behaviour of the public `kanthord-verify` repository, and the whole registration preflight design at `docs/proposal/database/repository.md:52` exists because a read proves nothing. A fixture that refused a bad token on the read side would not reproduce the condition the design answers.
- **Never forward a receive-pack POST to the backend.** Measured, and this is the reason the `403` exists: with `REMOTE_USER` set, `git http-backend` enables `receive-pack` for the authenticated caller even though `http.receivepack` is unset. An authenticated `git.push` therefore **succeeded and moved `refs/heads/trunk` on the fixture**. `.agent/plan/epics/005-test-infrastructure.md:11` makes accepting a push a phase-2 non-goal, so the POST is refused in the `node:http` layer, before the CGI. Phase 2 removes the `403` branch, and that removal is the whole edit.
- Do not set `http.receivepack` on the bare repository. Measured: the advertisement is served without it, and setting it would not close the push path anyway — step 5 is what closes it.
- Create no work tree, and run no `git` subcommand other than `--version` and `--exec-path`. `isomorphic-git` builds every object.
- Bind `127.0.0.1` only. `docs/proposal/phase-1/git-foundation.md:48` accepts plain HTTP on a loopback host, and nowhere else.
- Add no dependency. `isomorphic-git@1.40.0` is already a dependency, and `node:http` and `node:child_process` are builtins.
- Edit no file outside `test/helpers/remote/`. Measured: `test/helpers/remote/*.ts` already classifies as the `test-helper` element, `boundaries/no-unknown-files` stays silent, and importing `isomorphic-git` there is clean. `eslint.config.js` needs no change.

## Verify

`node --test test/helpers/remote/git-binary.test.ts` — new file, suite `"test/helpers/remote/git-binary.test"`:

- `resolveGitBinary()` returns a `version` that starts with `"git version "`, an `httpBackend` that `existsSync` reports true, and a `path` equal to `"git"`.
- `resolveGitBinary("git-does-not-exist-xyz")` throws `MissingGitBinaryError`, with `binary` equal to `"git-does-not-exist-xyz"` and a message containing `"is not on PATH"`. Measured: `execFileSync` throws with `code === "ENOENT"` on an absent binary.
- The absent binary throws rather than skips: assert `assert.throws(...)`, and assert the thrown value is an `instanceof MissingGitBinaryError`.

`node --test test/helpers/remote/seed.test.ts` — new file, suite `"test/helpers/remote/seed.test"`. Each test makes its own `fs.mkdtempSync(join(tmpdir(), "kanthord-remote-"))` and registers `after(() => fs.rmSync(root, { recursive: true, force: true }))` immediately, per the convention at `src/services/storage/sqlite.test.ts:36-45`.

- A one-commit seed — `branch: "trunk"`, `commits: [{ message: "seed", files: { "README.md": "hello\n" } }]` — returns `oids` deep-equal to `["cc9bdf8ea409b56b929085dcbe3d9f3469829565"]`. That exact oid is measured, and it is the determinism assertion of this story.
- The same input seeded into three different temporary roots returns the same oid all three times.
- A two-commit seed — the first as above, the second `{ message: "second", files: { "README.md": "hello\n", "NOTES.md": "notes\n" } }` — returns `oids` deep-equal to `["cc9bdf8ea409b56b929085dcbe3d9f3469829565", "df90ef8876916e6130e9bb0c57f3c940cdd75749"]`, and `resolveRef` on `refs/heads/trunk` equals the second oid.
- `readFileSync(join(gitdir, "HEAD"), "utf8").trim()` equals `"ref: refs/heads/trunk"`, so `HEAD` is a symbolic ref and not a detached oid.
- A seed with `branch: "main"` writes `HEAD` as `"ref: refs/heads/main"`, and `refs/heads/trunk` does not resolve.
- `writeFixtureCommit` with `parents: []`, `index: 2`, and `{ message: "rewritten", files: { "README.md": "rewritten\n" } }` returns exactly `"3144e4c2055e98d73a7b8e6d590b45fa3b46c9a7"`. It shares no ancestor with the seed commit, which is what makes an out-of-band non-fast-forward move available to EPIC 006.
- File order does not depend on key order: seeding `{ "NOTES.md": "notes\n", "README.md": "hello\n" }` and `{ "README.md": "hello\n", "NOTES.md": "notes\n" }` produce the identical oid.

`node --test test/helpers/remote/server.test.ts` — new file, suite `"test/helpers/remote/server.test"`. Each test seeds its own root and registers `after(async () => { await remote.close(); fs.rmSync(root, ...); })`, closing the server before removing the directory.

- `startFixtureRemote({ root })` resolves with `port` greater than `0` and `url` equal to `` `http://127.0.0.1:${port}` ``. Two concurrent fixtures on one root get two different ports.
- `gitVersion` equals the trimmed output of `git --version`.
- `startFixtureRemote({ root, gitBinary: "git-does-not-exist-xyz" })` rejects with `MissingGitBinaryError`. Prove no socket survives by construction rather than by probing an ephemeral port that was never allocated: pass an explicit `port` from a throwaway listener that the test closes first, assert the rejection, then bind a fresh `http.createServer` to that same port and assert it listens. A fixture that created the server before resolving the binary fails this.
- `GET /origin.git/info/refs?service=git-upload-pack` with no credential answers `200`, with `Content-Type: application/x-git-upload-pack-advertisement`, and a body whose first bytes are `"001e# service=git-upload-pack\n"` and which contains `"symref=HEAD:refs/heads/trunk"`.
- The same request with `Authorization: Basic <garbage>` also answers `200`, and its body equals the body of the unauthenticated request byte for byte. This is the public-repository property the preflight design depends on.
- `GET /origin.git/info/refs?service=git-receive-pack` with no credential answers `401`, with `WWW-Authenticate` exactly `` `Basic realm="kanthord fixture"` ``, and body `"unauthorized\n"`.
- The same request with the wrong password answers `401` with the identical body, and with the right password answers `200` and `Content-Type: application/x-git-receive-pack-advertisement`.
- `POST /origin.git/git-receive-pack` with no credential answers `401`, with body `"unauthorized\n"`. The credential check precedes the push refusal.
- `POST /origin.git/git-receive-pack` **with the right credential** answers `403`, with body `"push is phase 2\n"`, and `Content-Type: text/plain`.
- A push does not mutate the fixture, and this is the story's non-goal assertion. Seed `origin.git` at `cc9bdf8ea409b56b929085dcbe3d9f3469829565`. Build a second bare repository holding that commit plus a child commit. Call `git.push({ fs, http, gitdir: local, url, ref: "trunk", remoteRef: "trunk", onAuth })` with the correct credential and assert it rejects with `HttpError` and `data.statusCode === 403`. Then assert `resolveRef` on the fixture `refs/heads/trunk` still equals `cc9bdf8ea409b56b929085dcbe3d9f3469829565`. Measured: without the `403` branch this push returns `{ ok: true }` and moves the ref.
- A wrong **username** with the right token answers `401`. The comparison covers both halves of the Basic pair.
- `GET /nope.git/info/refs?service=git-upload-pack` answers `404`. Measured: `git http-backend` emits a `Status` CGI header, and the translation of that header is what this asserts.
- After one unauthenticated upload-pack advertisement and one unauthenticated receive-pack advertisement, `requests()` deep-equals a two-element array: `{ method: "GET", path: "/origin.git/info/refs?service=git-upload-pack", authenticated: false, status: 200 }` then `{ method: "GET", path: "/origin.git/info/refs?service=git-receive-pack", authenticated: false, status: 401 }`.
- No recorded request holds the credential. After a request carrying `Authorization: Basic <encoded>`, assert `JSON.stringify(remote.requests())` contains none of: the raw token `"fixture-token"`, the literal `"Basic "`, and the **base64 form** `Buffer.from("kanthord-bot:fixture-token").toString("base64")`. The encoded form is the one a naive redaction misses.
- Two repositories under one root are both served: seed `alpha.git` on `trunk` and `beta.git` on `main`, and assert each advertisement carries its own `symref=HEAD:refs/heads/<branch>`.
- `close()` releases the port. Capture `remote.port`, call `close()`, then bind a fresh `http.createServer` to that exact port on `127.0.0.1` and assert it listens. A `fetch` that rejects would prove only that the server stopped answering, not that the port was freed.
- `close()` is idempotent: calling it twice resolves both times and throws neither.

`npm run verify` exits 0.

Proof: contributes `git-binary.test.ts`, `seed.test.ts` and `server.test.ts` to `node --test test/helpers/remote/*.test.ts`. Story 02 completes the `PASS EPIC-005` line.
