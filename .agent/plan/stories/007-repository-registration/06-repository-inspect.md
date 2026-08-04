# Story 06 — `repository.inspect`

Epic: `.agent/plan/epics/007-repository-registration.md`
Depends on: Story 03 (`deserializePayload`), Story 04 (the `provider` row a registration writes), Story 05 (`scanHostKeys`).

One read: the default branch from the `HEAD` symref, the credential verdict, and the host key for an ssh url. It writes nothing and it holds no wizard state.

## Change

### 1. `src/services/git/remote-info.ts` (new)

```ts
import type { GitCredential, GitPaths, RemoteInfo } from "./index.ts";
import type { GitRunner } from "./run.ts";

export const SYMREF_PATTERN = /^ref: (refs\/heads\/[^\t\n]+)\tHEAD$/;

export function parseSymref(stdout: string): string | null;
export function parseBranches(stdout: string): readonly string[];

export function remoteInfo(
  runner: GitRunner,
  paths: GitPaths,
  input: Readonly<{ remoteUrl: string; credential: GitCredential }>,
): Promise<RemoteInfo>;
```

`remoteInfo` runs two authenticated commands through `runAuthenticated` from `./authenticated.ts`, in this order:

1. `["ls-remote", "--symref", "--", remoteUrl, "HEAD"]`
2. `["ls-remote", "--heads", "--", remoteUrl]`

A non-zero exit on either throws `GitError(classifyFailure({ code, stderr, eraseObserved }), `git ls-remote failed with code ${code}`, stripUserinfo(stderr))`.

`parseSymref` returns the short branch name, so `ref: refs/heads/main\tHEAD` yields `"main"`. It returns `null` when no line matches. Measured against a repository whose `HEAD` is unborn: `ls-remote --symref <url> HEAD` prints nothing and exits `0`. `RemoteInfo.defaultBranch` is therefore `null` in that case, and it is not an error — EPIC 006 index:77.

`parseBranches` keeps every line matching `/^[0-9a-f]{40}\trefs\/heads\/(.+)$/`, maps to the captured short name, and sorts with `Buffer.compare`. The sort is the determinism rule; `ls-remote` orders by ref name under the server's own collation and the daemon does not depend on it.

`remoteInfo` returns `{ defaultBranch, branches }`. It runs `remoteUrlVerdict(input.remoteUrl)` first and throws `GitError("url-refused", verdict.reason, "")` on a refusal, before any process starts.

**The url and the credential must agree.** `remoteInfo` throws `GitError("url-refused", "the url transport and the credential transport disagree", "")` when `verdict.transport !== input.credential.transport`. `docs/proposal/api/repository.md:78` makes the disagreement a `400 invalid-request`, and this is the one place both values are in hand.

### 2. `src/queries/repository/inspect-repository.ts` (new)

`inspect` writes nothing, so it is a read path and it lives under `queries/`. `AGENTS.md` splits the two by write, not by HTTP method, and `docs/proposal/api/README.md:86` explains the `POST` as a command that acts on a resource carrying a body.

```ts
import type { Crypto } from "../../services/crypto/index.ts";
import type { Storage } from "../../services/storage/index.ts";
import type { Git, GitCredential, HostKey } from "../../services/git/index.ts";

export type InspectRepositoryDependencies = Readonly<{
  storage: Storage;
  crypto: Crypto;
  git: Git;
}>;

export type InspectRepositoryInput = Readonly<{
  remoteUrl: string;
  credentialId: string;
}>;

export type CredentialVerdict =
  | Readonly<{ reachable: true; refusal: null }>
  | Readonly<{ reachable: false; refusal: GitFailure }>;

export type InspectRepositoryResult = Readonly<{
  defaultBranch: string | null;
  branches: readonly string[];
  credential: CredentialVerdict;
  hostKey: HostKey | null;
}>;

export type InspectRefusal =
  | "credential-not-found"
  | "credential-wrong-kind"
  | "credential-unreadable"
  | "host-key-unavailable";

export class InspectRepositoryError extends Error {
  readonly refusal: InspectRefusal;
  readonly detail: string;
  constructor(refusal: InspectRefusal, message: string, detail?: string);
}

export function inspectRepository(
  dependencies: InspectRepositoryDependencies,
  input: InspectRepositoryInput,
): Promise<InspectRepositoryResult>;
```

Sequence, in this order:

1. `dependencies.git.remoteUrlVerdict(input.remoteUrl)`. A refusal throws `GitError("url-refused", verdict.reason, "")`.
2. **Read the sealed credential row directly through `Storage`.** `showProvider` cannot serve: its `ProviderView` carries the public projection and no ciphertext, so there would be nothing to decrypt, and importing its type would be a query importing another query, which `eslint.config.js:121-129` refuses. The read is therefore a named-column select in this file, and Story 10's command holds an identical one — see S5.

   ```ts
   export const CREDENTIAL_SQL =
     "SELECT kind, payload_ciphertext, payload_iv, payload_tag, key_version FROM provider WHERE id = ?";

   type SealedCredentialRow = Readonly<{
     kind: string;
     payload_ciphertext: Uint8Array;
     payload_iv: Uint8Array;
     payload_tag: Uint8Array;
     key_version: number;
   }>;

   export function resolveGitCredential(
     dependencies: Readonly<{ storage: Storage; crypto: Crypto }>,
     credentialId: string,
   ): GitCredential;
   ```

   `resolveGitCredential` runs `CREDENTIAL_SQL` inside one `storage.transact` and narrows the `unknown` result with a runtime shape check — `transaction.get` returns `unknown` and a cast would hide a schema drift. Then:

   - `undefined` throws `InspectRepositoryError("credential-not-found", `no provider ${credentialId}`)`.
   - `row.kind !== "git"` throws `InspectRepositoryError("credential-wrong-kind", `provider ${credentialId} is of kind ${row.kind}; repository.inspect needs kind git`)`.
   - `crypto.open({ ciphertext, iv, tag, keyVersion })` throwing a `CryptoError`, or `deserializePayload("git", …)` throwing a `PayloadError`, throws `InspectRepositoryError("credential-unreadable", `the payload of provider ${credentialId} cannot be decrypted`)`. The caught error's message is discarded, because a crypto diagnostic is not contract.

   The returned `GitPayload` **is** the `GitCredential`: `gitHttpBasicPayload` and `gitSshPayload` (Story 03) declare exactly the members `src/services/git/index.ts:1-8` declares, so the mapping is the identity and no field is renamed. Assert that by construction — a test assigns a parsed `GitPayload` to a `const credential: GitCredential`, and `tsc --noEmit` is the mechanism.

3. The decrypted credential exists only as a local value. It is never returned, logged, or attached to an error.
4. For an ssh url only, `git.scanHostKeys(input.remoteUrl)`. A `scanned: false` outcome throws `InspectRepositoryError("host-key-unavailable", `the host key of ${host} could not be read`, outcome.detail)`. On success `hostKey` is `hostKeys[0]`, the first of the bytewise-sorted list. For an `http-basic` url `hostKey` is `null` — `docs/proposal/api/repository.md:44` makes it absent from the response for that transport, and `repositoryInspectResponse` below declares the member nullable.
5. `git.remoteInfo({ remoteUrl, credential })`. Success yields `credential: { reachable: true, refusal: null }`. A thrown `GitError` yields `credential: { reachable: false, refusal: error.failure }` and `defaultBranch: null` with `branches: []` — the verdict is the answer, not a thrown error, because a human inspecting a remote with a dead token needs the verdict rather than a `500`.
6. Return the result.

**`hostKeys[0]` is one key, and the ordering is what makes it a decision.** Story 05 sorts bytewise, so the returned key is the same one on every run. `docs/proposal/api/repository.md:32` returns a single `hostKey`, and the confirmed fingerprint of Story 08 names exactly one key.

**The credential verdict is a read verdict, and it is labelled `reachable` for that reason.** A write advertisement needs a local repository and a local object, and at inspect time there is neither — the epic states this at `:20`. `docs/proposal/api/repository.md:50` places the `git push --dry-run` preflight on this route, and that placement is unimplementable; the preflight is Story 07, run from the staging home. `reachable: true` therefore says the credential authenticated for a read and no more, and the member is not named `allowed` or `canPush`. See the epic open items.

### 3. `src/http/contract/repository.ts` — schemas on `repository.inspect`

```ts
export const repositoryInspectRequest = z.object({
  remoteUrl: z.string().min(1),
  credentialId: z.string().min(1),
});

export const hostKeyView = z.object({
  algorithm: z.string(),
  fingerprint: z.string(),
});

export const repositoryInspectResponse = z.object({
  defaultBranch: z.string().nullable(),
  branches: z.array(z.string()),
  credential: z.object({
    reachable: z.boolean(),
    refusal: z.string().nullable(),
  }),
  hostKey: hostKeyView.nullable(),
});
```

`hostKeyView` omits `publicKey`. The blob is the daemon's own material for `known_hosts`, and `docs/proposal/api/repository.md:38` returns an algorithm and a fingerprint.

### 4. `src/http/server/repository/inspect-repository.ts` (new) and `refusals.ts` (new)

The handler parses, calls `inspectRepository` once, and formats. `src/http/server/repository/refusals.ts` maps a thrown value:

| thrown                                            | `httpError` call                                                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `GitError` with `failure === "url-refused"`       | `httpError("invalid-request", error.message, { refusal: "url-refused" })`                                |
| `InspectRepositoryError("credential-not-found")`  | `httpError("not-found", error.message)`                                                                  |
| `InspectRepositoryError("credential-wrong-kind")` | `httpError("invalid-request", error.message, { refusal: "credential-wrong-kind" })`                      |
| `InspectRepositoryError("credential-unreadable")` | `httpError("invalid-request", error.message, { refusal: "credential-unreadable" })`                      |
| `InspectRepositoryError("host-key-unavailable")`  | `httpError("invalid-request", error.message, { refusal: "host-key-unavailable", detail: error.detail })` |
| anything else                                     | rethrown unchanged                                                                                       |

`error.detail` never carries a daemon path. `docs/proposal/api/README.md:188` forbids a server path in a response, and `detail` here is the first line of `ssh-keyscan` stderr, which names a host and a port.

### 5. `src/main.ts` — bind one handler

Add `"repository.inspect"` to the `handlers` record.

### 6. Contract test counts

- `src/http/contract/registry.test.ts`: the `request` list becomes `["provider.register","repository.inspect"]`, the `response` list becomes `["provider.list","provider.register","provider.show","repository.inspect"]`, both bytewise sorted.
- `src/http/contract/openapi.test.ts`: `components.schemas` keys gain `"repository.inspect.request"` and `"repository.inspect.response"`.

## Constraints

- `inspectRepository` writes nothing. No `INSERT`, no `UPDATE`, no event, no file. It holds no wizard state, because `docs/proposal/api/repository.md:22` makes a half-finished registration on the server a thing a second client can find.
- `src/queries/**` reaches storage and git through their interfaces only, enforced by `eslint.config.js:210-234`.
- The decrypted payload never reaches the result, the error message or the `detail`. `InspectRepositoryResult` has no member that can carry it.
- `remoteInfo` never runs `git ls-remote` without a credential. The credential is mandatory in the request.
- Never derive `defaultBranch` from `branches`. The symref is the source; a repository whose `HEAD` is unborn has branches and no default.
- `hostKey` is `null` for an `http-basic` url, and `scanHostKeys` is not called for one.

## Verify

`node --test src/services/git/remote-info.test.ts src/queries/repository/inspect-repository.test.ts src/http/server/repository/inspect-repository.test.ts`

### `src/services/git/remote-info.test.ts`

- `parseSymref("ref: refs/heads/main\tHEAD\n7d38…\tHEAD\n")` equals `"main"`. With `refs/heads/feature/a` it equals `"feature/a"`.
- `parseSymref("")` is `null`. `parseSymref("7d38…\tHEAD\n")` is `null` — an object-id line alone carries no symref.
- `parseBranches` on a three-line text returns the short names bytewise sorted. Feed the lines in an order whose bytewise sort differs from their input order and assert the sorted result.
- `parseBranches` drops a `refs/tags/` line and a malformed line.

Against the HTTP fixture, `await createHttpRemote()`, disposed in `after`:

- `remoteInfo` with `remote.credentials.writer` mapped to a `GitCredential` of transport `http-basic` and `forge: "github"` resolves `{ defaultBranch: "main", branches: ["main"] }`. EPIC 005 Story 02 seeds `refs/heads/main` and `refs/tags/v1`, so this also proves the tag is not reported as a branch.
- **An unborn `HEAD` yields `null`, not an error.** Create a second bare repository under `remote.seed.path` with `remote.seed.git(...)` naming `init --bare --template=`, serve it at its own path, and assert `defaultBranch === null` with `branches` `[]` and no throw.
- `remoteInfo` with `remote.wrongCredential` rejects with a `GitError` whose `failure` is `"auth-failed"`.
- `remoteInfo` with an `https` url and a credential of transport `ssh` rejects with `failure === "url-refused"` and the message `"the url transport and the credential transport disagree"`, and the test asserts no process ran by pointing `paths.git` at a path that does not exist. The refusal precedes the invocation.
- **The token appears in no error.** Force a failure with `remote.wrongCredential` and assert neither `error.message` nor `error.detail` includes the token.

### `src/queries/repository/inspect-repository.test.ts`

The `git` dependency is a hand-written Mock implementing the members this query calls — `remoteUrlVerdict`, `scanHostKeys`, `remoteInfo` — and throwing from every other member so an unexpected call is a failure rather than a silent pass. It returns the values these cases name, which makes it a Mock and not a Fake. `storage` is a real `createMigratedStorage()`, and the `provider` row is written by Story 04's `registerProvider` so the sealed columns are real ciphertext rather than a fixture blob.

- An `https` url with a `git` / `http-basic` credential returns `{ defaultBranch: "main", branches: ["main"], credential: { reachable: true, refusal: null }, hostKey: null }`, asserted with `deepEqual`.
- **`scanHostKeys` is not called for an `http-basic` url.** The Mock records its calls; assert the recorded list is empty.
- An `ssh` url with a `git` / `ssh` credential returns `hostKey` deep-equal to the first entry of the Mock's sorted list, and `Object.keys(result.hostKey)` deep-equals `["algorithm","fingerprint","publicKey"]`.
- A `remoteInfo` that throws `GitError("auth-failed", …)` returns `{ credential: { reachable: false, refusal: "auth-failed" }, defaultBranch: null, branches: [] }`. The query resolves; it does not reject.
- A `remoteInfo` that throws `GitError("transport-failed", …)` returns `refusal: "transport-failed"`. The verdict carries the classification through unchanged.
- An unknown `credentialId` rejects with `InspectRepositoryError`, `refusal === "credential-not-found"`.
- A credential of `kind === "llm"` rejects with `refusal === "credential-wrong-kind"`, and the message names both the id and `llm`.
- **A tampered payload rejects as `credential-unreadable`.** Overwrite `payload_tag` with sixteen zero bytes through a direct `transact` write, then assert `refusal === "credential-unreadable"` and that `error.message` contains neither the string `authentication` nor any `CryptoError` wording — the crypto diagnostic is discarded.
- `resolveGitCredential` on a valid `http-basic` row returns a value whose `Object.keys` bytewise sorted deep-equals `["forge","token","transport","username"]`, and on an `ssh` row `["privateKey","transport"]`. The identity mapping is asserted by shape, not assumed.
- A `scanHostKeys` returning `{ scanned: false, failure: "host-key-unavailable", detail: "…" }` rejects with `refusal === "host-key-unavailable"` and `error.detail` equal to that detail.
- A refused url rejects with `GitError`, `failure === "url-refused"`, and the Mock records no `remoteInfo` call.
- **Nothing is written.** Every case runs against a `createMigratedStorage()` and asserts `SELECT COUNT(*)` on `repository`, `git_operation` and `event` is `0` before and after. This is the `AGENTS.md` mechanism for "writes nothing", compared as state.
- **No credential field reaches the result.** For each successful case, `JSON.stringify(result)` does not include the token or the private key of the seeded payload.

### `src/http/server/repository/inspect-repository.test.ts`

Uses `createTestApp` with a stub query.

- `POST /v1/repository/inspect` with a valid body answers `200` and the response schema parses the body.
- A body missing `credentialId` answers `400` with `error.code === "invalid-request"`.
- Each of the five refusals answers its declared status and code, asserted from the table above, one case per row.
- A stub throwing a plain `Error` answers `500` with `error.code === "internal-error"` and `error.message === "internal error"`, and `app.internalErrors()` has length one.
- The response for an `http-basic` inspect carries `hostKey: null`, and the test asserts the key is present with a `null` value rather than absent, so a client can tell "no host key" from "field forgotten".

### E2E — scenario `E7-06`, real `github.com`

File `scripts/e2e/007/06-repository-inspect.e2e.ts`. Drives the real daemon over HTTP with the credential Story 04's scenario registers.

- Register the credential, then `POST /v1/repository/inspect` with `{ remoteUrl: httpsUrl(env), credentialId }`.
- The response answers `200` with `defaultBranch` equal to `env.ghBaseBranch`. Measured: `ls-remote --symref` against `kanthorlabs/kanthord-verify` reports `ref: refs/heads/main\tHEAD`, and `E2E_GH_BASE_BRANCH` is `main`. The scenario compares against the environment value, not the literal.
- `branches` includes `env.ghBaseBranch`, is bytewise sorted, and holds no entry beginning with `refs/`.
- `credential` deep-equals `{ reachable: true, refusal: null }`.
- `hostKey` is `null` — the url is `https`.
- **A wrong token yields a verdict, not a `500`.** Register a second credential holding `wrongCredential(env).token`, inspect with it, and assert `200` with `credential` deep-equal to `{ reachable: false, refusal: "auth-failed" }` and `defaultBranch: null`. Measured: `git push`/`ls-remote` with a bad `github_pat_` prints `remote: Invalid username or token` and `fatal: Authentication failed for …`, which `classifyFailure` rule 3 maps to `auth-failed`.
- **An empty token cannot be registered, so no inspect case covers one.** Story 03 declares `token: z.string().min(1)`, so `provider.register` refuses it with `400 invalid-request` and it never reaches a credential id. Story 04's scenario holds that assertion. The git-level behaviour was measured — GitHub answers `Invalid username or token` for `x-access-token:` — and the product schema makes it unreachable, which is the safer of the two.
- **The ssh url of the same repository returns a host key.** `POST /v1/repository/inspect` with `{ remoteUrl: "ssh://git@github.com/" + env.ghRepo + ".git", credentialId: <a credential of transport ssh, its key generated by the scenario> }` answers `200` with `hostKey.algorithm` a member of `ACCEPTED_HOST_KEY_ALGORITHMS` and `hostKey.fingerprint` matching `/^SHA256:[A-Za-z0-9+/]{43}$/`. `credential` is `{ reachable: false, refusal: "auth-failed" }`, because the generated key is not registered with GitHub — and that is the assertion: the host key is read even when the credential is refused, which is what makes `inspect` usable for the confirmation Story 08 needs.
- A url whose transport disagrees with the credential answers `400` with `error.details.refusal === "url-refused"`.
- No repository row exists after every case: the scenario reads `<home>/kanthord.db` after the daemon exits and asserts `SELECT COUNT(*) FROM repository` is `0`.
- The scenario creates no remote ref.

`npm run verify` exits 0. `npm run e2e:007` exits 0.

Proof: contributes `src/queries/repository/inspect-repository.test.ts` to the epic Proof glob `src/queries/repository/**/*.test.ts`, plus `src/services/git/remote-info.test.ts` and the handler test, which Story 13 adds to the Proof.
