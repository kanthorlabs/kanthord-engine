# JWT acceptance checks

[Internal documentation home](README.md)

From the engine repository root, run:

```sh
pnpm run test:e2e:jwt
```

The runner requires Python 3 with POSIX PTY support. It builds the engine, starts a disposable loopback server, generates default and custom-username JWTs using the compiled CLI, and exercises API and CLI verification. Missing, tampered, expired, wrong-key, and malformed tokens must fail.

It also verifies an environment-supplied token without login, checks the published verification and worker-registration contracts, proves that redirected server startup prints no token, stops the server, and removes disposable state.

Sanitized proof is written under the workspace's `.dev/e2e/<YYMMdd>-jwt-verification/`, with a suffix for repeat runs. The proof includes decoded claims, status codes, exit codes, process provenance, and cleanup checks. The proof excludes raw JWTs, client secrets and master keys. The runner reads
the machine `token:` and `client_secret:` lines from a PTY. It checks that the
client secret has the canonical 32-byte base64 form. The sentinel sweep checks
every evidence file for both values.

Source: [acceptance runner](../scripts/e2e-jwt.py). Validation commands are in [AGENTS.md](../AGENTS.md).

## The suite pass record

CI skips each test file that passed before on the same inputs. The record steps are in [suite-pass.mjs](../scripts/suite-pass.mjs).

```sh
node scripts/suite-pass.mjs run --job <name> [--write] [--full] --concurrency <n> <test file>...
```

- The key of a test file is the SHA-256 of the Node.js version, the pnpm version, the blob ids of the global inputs and of `gate_files`, and the blob ids of the import closure of the test file.
- The global inputs are `GLOBAL_INPUTS` of [affected-tests.mjs](../scripts/affected-tests.mjs) and `static/pi-tools.json`. `gate_files` comes from `.kanthord/affected-tests.json`. The blob ids come from `git ls-tree -r HEAD`.
- The import closure comes from the graph of the affected test selector.
- The record store is `node_modules/.cache/suite-pass/records.json`. It maps each key to the file, its test time and the write time. A write keeps the 20000 newest records.
- A test file passes when the run ran it, records no failed test, records no skipped or todo test and records a test time. A skip depends on the environment, and the key holds no environment.
- The script runs each argument file with no matching record and each argument file of `always_run`. It exits 0 when every run file passes, 1 when a run file fails and 2 on an error.
- `always_run` in `.kanthord/suite-pass.json` lists each test file that bundles code, reaches the untracked build output `dist/`, or reads a path that it builds at run time. A tracked file in the import closure, for example `bin/kanthord.mjs`, is part of the key, so its test file needs no entry.
- With `--write`, the script writes one record for each passed file. It refuses the run with exit 2 when `git status --porcelain --untracked-files=all` prints a line before or after the tests.
- Without `--write`, a dirty or untracked work tree reads no record. The script runs every argument file and writes no record.
- `--full` runs every argument file and still writes records.

CI runs the `check` job and the `e2e` job through the script with `--write`. `actions/cache/restore` restores the newest record store of the job after `pnpm install --frozen-lockfile`. `actions/cache/save` saves the store after the tests, also when the tests fail. Each job keeps its own store. Each job uploads the store as the artifact `suite-pass-records-<job>-<attempt>`, also when the tests fail. `<attempt>` is the run attempt number. GitHub keeps the artifact for 7 days.

The job summary prints these lines:

- `Floor: <n> test files, <s> s`: the floor files among the argument files, and the test time of the floor files that ran.
- `Ran: <n> test files` and `Skipped: <n> test files`.
- `Saved share: <p>%`: the record time of the files that did not run, divided by the sum of that time and the test time of the files that ran.

The schedule trigger runs the workflow on `main` at 03:00 UTC each night with `--full`. That run catches a test that the import graph misses.

The record has two accepted limits:

- The test files that load the composed server reach every production file. They run for every production change.
- A push to `main` runs each test file again that has no record in the cache of `main`. The cache of a pull request never reaches `main`.
