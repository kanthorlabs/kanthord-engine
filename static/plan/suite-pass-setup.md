---
intent: implement
commit_type: chore
verifications:
  - "test -f .kanthord/suite-pass.json"
  - "! git check-ignore -q .kanthord/suite-pass.json"
  - "test ! -f .kanthord/affected-tests.json || grep -qF .kanthord/suite-pass.json .kanthord/affected-tests.json"
---

# Add the suite pass record

## Requirement

Add the suite pass record to the repository. CI uses the record to skip each test file that passed before on the same inputs. The record works without KanthorD.

1. Write `.kanthord/suite-pass.json` at the root of the repository. It holds `version: 1` and `always_run`. `always_run` lists each test file that CI runs with no record lookup: a test file that bundles code, reaches `bin/` or reads a path that it builds at run time.
2. Add the exception `!/.kanthord/suite-pass.json` to `.gitignore`, so that git tracks the file.
3. Add the record steps of the repository. The key of a test file is a SHA-256 of the toolchain, the blob ids of the global inputs and of the `gate_files`, and the blob ids of the import closure of the test file. A repository with no selector, or with a selector that gives no import graph, uses one record for the whole tree. Its key is the tree id and the toolchain.
4. Only a run in a clean clone with a frozen install writes a record. A dirty or untracked work tree reads no record and writes no record.
5. Change the CI workflow. Restore and save the records with `actions/cache`. Run each test file with no matching record and each test file of `always_run`. Print the floor of the affected report and the saved share in the job summary. Add a nightly full run on the base branch that runs every test file.
6. When `.kanthord/affected-tests.json` exists, add `.kanthord/suite-pass.json`, the record steps and the CI workflow file to its `gate_files`. Add no other key of the record to that file.

The engine repository `kanthorlabs/kanthord-engine` is the example of a repository with an import graph. Its record steps are `scripts/suite-pass.mjs`, and CI runs `node scripts/suite-pass.mjs run --job check --write`. The apps repository `kanthorlabs/kanthord-apps` is the example of a repository with no import graph. It uses one record for the whole tree, and CI runs `pnpm run test:suite-pass --job check --write`.

## Criterion

The repository tracks `.kanthord/suite-pass.json` with `version: 1` and `always_run`. CI restores and saves the suite pass records, skips each test file whose key matches a record and prints the saved share in the job summary. A nightly run on the base branch runs every test file. With an affected test declaration, `gate_files` lists `.kanthord/suite-pass.json`, the record steps and the CI workflow file.
